import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir } from "node:fs/promises";

/**
 * The generated MCP server bundle is UNIX-domain-socket-only (see
 * `src/compile/mcp-bundle.ts`'s `MCP_SDK_HTTP_RUNTIME`) -- there is no more
 * TCP transport to round-trip against. Every helper here still speaks the
 * same Streamable HTTP JSON-RPC protocol, just over `unix:` instead of
 * `http://host:port`.
 *
 * `getFreePort` is kept as the cheap, already-unique numeric token every
 * caller already threads through (`port: number`): it still allocates a
 * real, momentarily-free TCP port, but that number is now used only to
 * derive a short, collision-free UDS socket path
 * (`socketPathForPort`) -- never to bind a TCP listener. Keeping the
 * `port`-shaped public API unchanged means every existing call site across
 * the test suite keeps working without renaming a field it never actually
 * used for TCP binding in the first place.
 */

export interface HttpRpcOptions {
  readonly port: number;
  readonly sessionId?: string;
  readonly method: string;
  readonly params?: unknown;
  readonly origin?: string;
}

export interface HttpRpcResult {
  readonly response: Response;
  readonly body: any;
}

export const getFreePort = (host = "127.0.0.1"): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });

/**
 * A short, fixed base directory (never `os.tmpdir()`'s `/var/folders/...`,
 * which already eats most of the 100-byte `sockaddr_un.sun_path` budget
 * `uds-path.ts` enforces) -- every socket path built here is
 * `<UDS_ROUNDTRIP_SOCKET_DIR>/<port>.sock`, comfortably under the limit.
 */
const UDS_ROUNDTRIP_SOCKET_DIR = "/tmp/prism-mcp-roundtrip";

/** Bun's `fetch` accepts an extra `unix` option beyond the standard `RequestInit` shape. */
type UdsRequestInit = RequestInit & { readonly unix: string };

export const socketPathForPort = async (port: number): Promise<string> => {
  await mkdir(UDS_ROUNDTRIP_SOCKET_DIR, { recursive: true });
  return `${UDS_ROUNDTRIP_SOCKET_DIR}/${port}.sock`;
};

export const waitForHttpServer = async (port: number): Promise<void> => {
  const socketPath = await socketPathForPort(port);
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const init: UdsRequestInit = { method: "OPTIONS", unix: socketPath };
      const response = await fetch("http://localhost/mcp", init);
      if (response.status === 204) return;
    } catch {
      // Server is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`UDS MCP server did not start at ${socketPath}`);
};

export const httpRpc = async (options: HttpRpcOptions): Promise<HttpRpcResult> => {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
  };
  if (options.sessionId) headers["mcp-session-id"] = options.sessionId;
  if (options.origin) headers.origin = options.origin;

  const socketPath = await socketPathForPort(options.port);
  const init: UdsRequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: options.method,
      params: options.params,
    }),
    unix: socketPath,
  };
  const response = await fetch("http://localhost/mcp", init);
  const text = await response.text();
  return { response, body: text.length > 0 ? JSON.parse(text) : undefined };
};

export const waitForChildClose = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5_000,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for child process to exit"));
    }, timeoutMs);

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

export interface RoundTripCompiledBundleOptions {
  readonly serverPath: string;
  readonly port: number;
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

export interface RoundTripCompiledBundleResult {
  readonly toolNames: string[];
  readonly schemas: unknown[];
  readonly callResult: { readonly text: string; readonly structuredContent: unknown };
}

export const roundTripCompiledBundle = async (
  options: RoundTripCompiledBundleOptions,
): Promise<RoundTripCompiledBundleResult> => {
  const socketPath = await socketPathForPort(options.port);
  const child = spawn("bun", [options.serverPath], {
    cwd: options.cwd,
    env: {
      ...process.env,
      PRISM_MCP_UDS_PATH: socketPath,
      ...(options.env ?? {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForHttpServer(options.port);

    const init = await httpRpc({
      port: options.port,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "prism-roundtrip-test", version: "0.1.0" },
      },
    });
    if (init.response.status !== 200) {
      throw new Error(
        `MCP initialize failed with status ${init.response.status}: ${JSON.stringify(init.body)}`,
      );
    }
    const sessionId = init.response.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("MCP initialize did not return mcp-session-id");

    const listed = await httpRpc({
      port: options.port,
      sessionId,
      method: "tools/list",
    });
    if (listed.response.status !== 200) {
      throw new Error(`MCP tools/list failed: ${JSON.stringify(listed.body)}`);
    }
    const tools = (listed.body as { result?: { tools?: Array<{ name: string; inputSchema?: unknown }> } }).result
      ?.tools ?? [];
    const toolNames = tools.map((tool) => tool.name);
    const schemas = tools.map((tool) => tool.inputSchema);

    assertSchemaNoConst(schemas);

    if (!toolNames.includes(options.toolName)) {
      throw new Error(
        `Tool '${options.toolName}' not found in tools/list. Available: ${toolNames.join(", ")}`,
      );
    }

    const called = await httpRpc({
      port: options.port,
      sessionId,
      method: "tools/call",
      params: {
        name: options.toolName,
        arguments: options.toolArgs,
      },
    });
    if (called.response.status !== 200) {
      throw new Error(`MCP tools/call failed: ${JSON.stringify(called.body)}`);
    }
    const result = (called.body as {
      result?: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
    }).result;
    if (result?.content?.[0]?.type !== "text" || typeof result.content[0].text !== "string") {
      throw new Error(`Unexpected tools/call result shape: ${JSON.stringify(result)}`);
    }

    return {
      toolNames,
      schemas,
      callResult: {
        text: result.content[0].text,
        structuredContent: result.structuredContent,
      },
    };
  } finally {
    child.kill("SIGTERM");
    await waitForChildClose(child).catch(() => undefined);
  }
};

export const assertSchemaNoConst = (schemas: unknown[]): void => {
  const serialized = JSON.stringify(schemas);
  if (serialized.includes('"const":')) {
    throw new Error(
      `Emitted JSON Schema contains 'const' literals. Prism must emit 'enum' for MCP compatibility.`,
    );
  }
};

export const waitForUdsSocket = async (socketPath: string): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await access(socketPath);
      return;
    } catch {
      // Socket file does not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`UDS socket did not appear at ${socketPath}`);
};
