/**
 * Stateless CLI invoke path for Prism canonical tools.
 *
 * Reuses the compiled MCP daemon bundle (lazy resolve-or-spawn over UDS) so
 * business logic stays in one place. The agent-facing surface is shell JSON,
 * not a long-lived stdio MCP child of the harness.
 */

import { resolveOrSpawnDaemon, DaemonResolveError } from "@skastr0/prism-sdk/mcp/daemon-resolver";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { readToolCliCatalog, type ToolCliCatalog } from "./catalog.js";

export class ToolsCliInvokeError extends Error {
  readonly kind = "tools-cli-invoke-error" as const;

  constructor(
    message: string,
    readonly exitCode: number = 1,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ToolsCliInvokeError";
  }
}

type UdsRequestInit = RequestInit & { readonly unix: string };

interface JsonRpcEnvelope {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message: string; readonly data?: unknown };
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Minimal one-shot MCP Streamable-HTTP-over-UDS client (initialize + tools/call + DELETE). */
export const callDaemonTool = async (options: {
  readonly pluginName: string;
  readonly socketPath: string;
  readonly wireName: string;
  readonly args: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly exposureProfile?: string;
}): Promise<unknown> => {
  let requestId = 0;
  let sessionId: string | undefined;

  const request = async (method: string, params?: unknown): Promise<Response> => {
    const id = (requestId += 1);
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (options.exposureProfile) headers["x-prism-mcp-exposure"] = options.exposureProfile;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const init: UdsRequestInit = {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
        unix: options.socketPath,
      };
      const response = await fetch("http://localhost/mcp", init);
      if (!response.ok) {
        throw new ToolsCliInvokeError(
          `daemon '${method}' returned HTTP ${response.status}`,
          2,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof ToolsCliInvokeError) throw error;
      throw new ToolsCliInvokeError(
        `daemon '${method}' unreachable: ${errorMessage(error)}`,
        2,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  const parseBody = async (response: Response): Promise<JsonRpcEnvelope> => {
    const text = await response.text();
    if (text.length === 0) return {};
    try {
      return JSON.parse(text) as JsonRpcEnvelope;
    } catch (error) {
      throw new ToolsCliInvokeError(`daemon returned malformed JSON: ${errorMessage(error)}`, 2, error);
    }
  };

  const terminateSession = async (): Promise<void> => {
    if (!sessionId) return;
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      "mcp-session-id": sessionId,
    };
    if (options.exposureProfile) headers["x-prism-mcp-exposure"] = options.exposureProfile;

    // Cleanup is deliberately best-effort. Once tools/call returned, turning
    // a DELETE transport failure into a CLI failure would invite a retry of a
    // mutating tool whose effect already happened. The daemon's session TTL
    // remains the abnormal-path backstop; the normal path always sends DELETE.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(options.timeoutMs, 5_000));
      try {
        const init: UdsRequestInit = {
          method: "DELETE",
          headers,
          signal: controller.signal,
          unix: options.socketPath,
        };
        const response = await fetch("http://localhost/mcp", init);
        await response.body?.cancel().catch(() => undefined);
        if (response.ok || response.status === 404) return;
      } catch {
        // One bounded retry handles a transient connection teardown without
        // replaying the tool call itself.
      } finally {
        clearTimeout(timeout);
      }
    }
  };

  const initResponse = await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "prism-tools-cli", version: "0.1.0" },
  });
  const sid = initResponse.headers.get("mcp-session-id");
  if (!sid) {
    throw new ToolsCliInvokeError("daemon initialize did not return mcp-session-id", 2);
  }
  sessionId = sid;
  try {
    const initBody = await parseBody(initResponse);
    if (initBody.error) {
      throw new ToolsCliInvokeError(`daemon initialize failed: ${initBody.error.message}`, 2);
    }

    const callResponse = await request("tools/call", {
      name: options.wireName,
      arguments: options.args,
    });
    const callBody = await parseBody(callResponse);
    if (callBody.error) {
      throw new ToolsCliInvokeError(callBody.error.message, 1, callBody.error.data);
    }
    return callBody.result;
  } finally {
    await terminateSession();
  }
};

export const resolveWireName = (catalog: ToolCliCatalog, toolName: string): string => {
  const exact = catalog.tools.find((tool) => tool.name === toolName || tool.wireName === toolName);
  if (exact) return exact.wireName;
  const lowered = toolName.toLowerCase();
  const fuzzy = catalog.tools.find(
    (tool) => tool.name.toLowerCase() === lowered || tool.wireName.toLowerCase() === lowered,
  );
  if (fuzzy) return fuzzy.wireName;
  const available = catalog.tools.map((tool) => tool.name).join(", ");
  throw new ToolsCliInvokeError(
    `unknown tool '${toolName}' for plugin '${catalog.plugin}'` +
      (available.length > 0 ? `; available: ${available}` : " (catalog empty)"),
    1,
  );
};

export const parseToolsCliInput = async (raw: string | undefined): Promise<Record<string, unknown>> => {
  if (raw === undefined || raw.trim().length === 0) return {};
  const trimmed = raw.trim();
  let jsonText = trimmed;
  if (trimmed.startsWith("@")) {
    const path = trimmed.slice(1);
    jsonText = await readFile(path, "utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new ToolsCliInvokeError(`--input is not valid JSON: ${errorMessage(error)}`, 1, error);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolsCliInvokeError("--input must be a JSON object", 1);
  }
  return parsed as Record<string, unknown>;
};

export interface ToolsCliInvokeOptions {
  readonly prismHome: string;
  readonly pluginName: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly timeoutMs?: number;
  /** When set, skip catalog and call this wire name directly. */
  readonly wireName?: string;
}

export const invokeToolViaCli = async (options: ToolsCliInvokeOptions): Promise<unknown> => {
  const catalog = await readToolCliCatalog(options.prismHome, options.pluginName);
  const wireName =
    options.wireName ??
    (catalog
      ? resolveWireName(catalog, options.toolName)
      : options.toolName);

  let entry;
  try {
    entry = await resolveOrSpawnDaemon({
      plugin: options.pluginName,
      prismHome: options.prismHome,
      spawnTimeoutMs: options.timeoutMs ?? 15_000,
    });
  } catch (error) {
    if (error instanceof DaemonResolveError) {
      throw new ToolsCliInvokeError(error.message, 2, error);
    }
    throw new ToolsCliInvokeError(
      `failed to resolve daemon for '${options.pluginName}': ${errorMessage(error)}`,
      2,
      error,
    );
  }

  return callDaemonTool({
    pluginName: options.pluginName,
    socketPath: entry.sock,
    wireName,
    args: options.input,
    timeoutMs: options.timeoutMs ?? 60_000,
    // Use a real exposure profile from the compiled bundle. "cli" is not a
    // harness key; codex-cli's allowlist is the broadest common owner set.
    exposureProfile: `prism-generated-${options.pluginName}:codex-cli`,
  });
};
