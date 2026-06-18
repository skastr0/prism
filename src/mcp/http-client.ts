/**
 * Minimal stateful MCP HTTP client for Prism-generated Streamable HTTP servers.
 *
 * This wrapper intentionally sits below the official SDK so tests can observe
 * retry, timeout, and pipeline behavior without the SDK hiding failures or
 * adding its own retry semantics.
 */

export class McpHttpTimeoutError extends Error {
  readonly _tag = "McpHttpTimeoutError" as const;

  constructor(
    readonly method: string,
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`MCP HTTP '${method}' to ${url} timed out after ${timeoutMs}ms`);
  }
}

export class McpHttpError extends Error {
  readonly _tag = "McpHttpError" as const;

  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(`MCP HTTP '${method}' to ${url} failed with status ${status}`);
  }
}

export interface McpHttpClientOptions {
  readonly baseUrl: string;
  readonly clientName?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryDelayMs?: number;
}

export interface McpHttpRpcResult {
  readonly response: Response;
  readonly body: unknown;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly inputSchema?: unknown;
}

export interface McpToolCallResult {
  readonly text: string;
  readonly structuredContent?: unknown;
}

const isRetryableStatus = (status: number): boolean => status >= 500 && status < 600;

const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("fetch failed") ||
    message.includes("aborted") ||
    error.name === "AbortError" ||
    error.name === "TimeoutError"
  );
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class McpHttpClient {
  private sessionId: string | undefined;
  private requestId = 0;

  constructor(private readonly options: McpHttpClientOptions) {}

  get connected(): boolean {
    return this.sessionId !== undefined;
  }

  async connect(): Promise<void> {
    const result = await this.rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: this.options.clientName ?? "prism-mcp-http-client",
        version: "0.1.0",
      },
    });
    const sessionId = result.response.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new Error("MCP initialize did not return mcp-session-id");
    }
    this.sessionId = sessionId;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.rpc("tools/list");
    const tools = (result.body as { result?: { tools?: McpToolDefinition[] } } | undefined)
      ?.result?.tools;
    return tools ?? [];
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.rpc("tools/call", { name, arguments: arguments_ });
    const body = result.body as {
      result?: {
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: unknown;
      };
    };
    const text = body.result?.content?.find((c) => c.type === "text")?.text ?? "";
    return { text, structuredContent: body.result?.structuredContent };
  }

  private async rpc(method: string, params?: unknown): Promise<McpHttpRpcResult> {
    const url = this.options.baseUrl.replace(/\/$/, "");
    const id = (this.requestId += 1);
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    const timeoutMs = this.options.timeoutMs ?? 10_000;
    const retries = this.options.retries ?? 2;
    const retryDelayMs = this.options.retryDelayMs ?? 100;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(new McpHttpTimeoutError(method, url, timeoutMs));
      }, timeoutMs);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });

        if (response.ok) {
          const text = await response.text();
          return {
            response,
            body: text.length > 0 ? JSON.parse(text) : undefined,
          };
        }

        const responseText = await response.text();
        const parsedBody = responseText.length > 0 ? JSON.parse(responseText) : undefined;
        if (isRetryableStatus(response.status) && attempt < retries) {
          lastError = new McpHttpError(method, url, response.status, parsedBody);
          continue;
        }
        throw new McpHttpError(method, url, response.status, parsedBody);
      } catch (error) {
        if (error instanceof McpHttpTimeoutError) {
          throw error;
        }
        if (error instanceof McpHttpError) {
          throw error;
        }
        if (attempt < retries && isRetryableError(error)) {
          lastError = error;
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new Error(`MCP HTTP '${method}' failed after ${retries} retries`);
  }
}
