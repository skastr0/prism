/**
 * Aggregating MCP shim.
 *
 * A single stdio MCP server, spawned once by the harness, that fronts N
 * Prism-generated plugin daemons over Unix domain sockets. It replaces the
 * "one spawned process per plugin" shape with "one spawned process,
 * multiplexed over UDS to N already-running daemons":
 *
 *   harness <--stdio(JSON-RPC)--> shim <--HTTP-over-UDS--> daemon[plugin A]
 *                                      \-HTTP-over-UDS--> daemon[plugin B]
 *
 * Harness side (this module's `runShim`/`createShimServer`): a bare
 * JSON-RPC MCP server over stdin/stdout using the SDK's low-level `Server`
 * + `StdioServerTransport`. Stdio is a single duplex pipe with exactly one
 * peer, so there is no SSE and no HTTP session concept to manage here —
 * that machinery only exists on the daemon side.
 *
 * Daemon side (`DaemonConnection`): a minimal hand-rolled HTTP-over-UDS
 * JSON-RPC client, deliberately not the SDK's `Client` +
 * `StreamableHTTPClientTransport`. The SDK client runs every response
 * through `safeParse(resultSchema, ...)`, which is a plain (non-passthrough)
 * Zod object and silently drops any field the schema does not declare. This
 * shim's job is to forward a daemon's tool-call result value-preserving —
 * stripping no field (name mapping aside) — so the daemon's raw JSON-RPC
 * `result`/`error` is read and handed back untouched instead of being
 * round-tripped through schema validation on the way in.
 *
 * A plugin absent from the UDS registry, whose recorded daemon is dead, or
 * whose recorded bundle hash no longer matches the compiled bundle on disk,
 * is resolved via `daemon-resolver.ts`'s `resolveOrSpawnDaemon`: it spawns a
 * fresh daemon and waits (bounded by a spawn timeout) for it to register
 * and answer live. If that also fails, or a live daemon is unreachable
 * within `daemonTimeoutMs`, the failure is never fatal to the shim: the
 * plugin's tools are omitted from the merged `tools/list`, and a
 * `tools/call` naming it returns a typed `McpError` (SDK
 * `ErrorCode.ConnectionClosed`). Every other configured plugin keeps
 * serving normally — each plugin's request runs against its own timeout and
 * failure is caught per-plugin.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { getDaemon as getDaemonDefault, type RegistryResult, type RegistryEntry } from "./uds-registry.js";
import { resolveOrSpawnDaemon, DaemonResolveError, DEFAULT_SPAWN_TIMEOUT_MS } from "./daemon-resolver.js";

// ---------------------------------------------------------------------------
// Naming: the per-plugin namespace segment used to flatten N plugins' tools
// into the one flat name-space a single MCP `tools/list` response can hold.
// ---------------------------------------------------------------------------

/**
 * FNV-1a, 8 hex chars. Deliberately bit-for-bit identical to
 * `stableHash8` in the root package's `src/compile/stable-hash.ts`, which
 * backs `generatedMcpWireServerName` (`p_<hash8>`) — the segment every
 * harness lowerer (Claude Code, Codex CLI, Antigravity, Factory Droid,
 * Kimi Code, Cursor, Grok) already bakes into compiled permission strings
 * and tool FQNs (e.g. Claude Code's `mcp__p_<hash8>__<tool>`).
 *
 * `packages/prism-core` cannot import that root-package module (its
 * `tsconfig.json` `rootDir` is `./src`; a real `import` of anything under
 * the workspace root `src/` fails to compile), so the tiny pure function is
 * duplicated here rather than re-derived with a different algorithm. Using
 * the *same* namespace segment the harness side already computes means a
 * later wave that points a harness's MCP config at this shim only has to
 * add an outer wrapper layer around `p_<hash8>__<tool>` (the shim's own
 * server key in that harness's config), not rename every already-compiled
 * permission string from scratch.
 */
const stableHash8 = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.codePointAt(index)!;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** `p_<hash8>` — see `stableHash8` above for why this exact shape. */
export const pluginWireNamespace = (pluginName: string): string => `p_${stableHash8(pluginName)}`;

const NAMESPACE_SEPARATOR = "__";
/** Fixed width of `p_<hash8>`: literal `p_` (2) + 8 hex chars. */
const NAMESPACE_LENGTH = 2 + 8;

/** Harness-visible tool name: `<pluginWireNamespace>__<originalToolName>`. */
export const namespacedToolName = (pluginName: string, toolName: string): string =>
  `${pluginWireNamespace(pluginName)}${NAMESPACE_SEPARATOR}${toolName}`;

/**
 * Inverse of `namespacedToolName`. The namespace segment has a fixed
 * width, so this splits on position rather than searching for the `__`
 * separator — a tool name is free-form and may itself legally contain
 * `__`, but the namespace segment never does.
 */
export const splitNamespacedToolName = (
  fqName: string,
): { readonly namespace: string; readonly toolName: string } | undefined => {
  if (fqName.length <= NAMESPACE_LENGTH + NAMESPACE_SEPARATOR.length) return undefined;
  const namespace = fqName.slice(0, NAMESPACE_LENGTH);
  const separator = fqName.slice(NAMESPACE_LENGTH, NAMESPACE_LENGTH + NAMESPACE_SEPARATOR.length);
  if (separator !== NAMESPACE_SEPARATOR) return undefined;
  const toolName = fqName.slice(NAMESPACE_LENGTH + NAMESPACE_SEPARATOR.length);
  if (toolName.length === 0) return undefined;
  return { namespace, toolName };
};

// ---------------------------------------------------------------------------
// Daemon-facing HTTP-over-UDS client
// ---------------------------------------------------------------------------

export class ShimDaemonError extends Error {
  readonly kind = "shim-daemon-error" as const;

  constructor(
    readonly pluginName: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`[${pluginName}] ${message}`);
    this.name = "ShimDaemonError";
  }
}

interface DaemonRpcEnvelope {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** Bun's `fetch` accepts an extra `unix` option beyond the standard `RequestInit` shape. */
type UdsRequestInit = RequestInit & { readonly unix: string };

/**
 * One JSON-RPC-over-UDS connection to a single plugin daemon, matching the
 * contract `src/compile/mcp-bundle.ts`'s `MCP_SDK_HTTP_RUNTIME` template
 * implements: POST to `/mcp` with `mcp-protocol-version`, `initialize`
 * first to obtain `mcp-session-id`, then that header on every subsequent
 * call. Initializes once and reuses the session; a failed request drops
 * the cached session so the next call starts a fresh handshake (the
 * daemon may have restarted).
 */
class DaemonConnection {
  private sessionId: string | undefined;
  private requestId = 0;
  /**
   * In-flight handshake, memoized so concurrent first-callers share one
   * `initialize` round-trip instead of each racing their own. Cleared
   * (success or failure) once the handshake settles, so a later call that
   * finds `sessionId` unset — because the handshake failed, or because a
   * broken response later dropped the session — starts a fresh one rather
   * than piling onto a promise that has already resolved or rejected.
   */
  private initializing: Promise<void> | undefined;

  constructor(
    private readonly pluginName: string,
    private readonly socketPath: string,
    private readonly timeoutMs: number,
    private readonly exposureProfile?: string,
  ) {}

  async listTools(): Promise<ReadonlyArray<Tool>> {
    await this.ensureInitialized();
    const envelope = await this.rpc("tools/list");
    if (envelope.error) {
      throw new ShimDaemonError(this.pluginName, `daemon tools/list failed: ${envelope.error.message}`);
    }
    const tools = (envelope.result as { readonly tools?: ReadonlyArray<Tool> } | undefined)?.tools;
    return tools ?? [];
  }

  /** Returns the daemon's raw JSON-RPC `result` for `tools/call`, untouched. */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const envelope = await this.rpc("tools/call", { name: toolName, arguments: args });
    if (envelope.error) {
      throw new ShimDaemonError(this.pluginName, `daemon tools/call '${toolName}' failed: ${envelope.error.message}`);
    }
    return envelope.result;
  }

  /**
   * Single-flight: if a handshake is already in progress, every concurrent
   * caller awaits that same promise instead of firing its own `initialize`
   * request against the daemon.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.sessionId) return;
    if (!this.initializing) {
      this.initializing = this.handshake().finally(() => {
        this.initializing = undefined;
      });
    }
    return this.initializing;
  }

  private async handshake(): Promise<void> {
    const response = await this.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "prism-mcp-shim", version: "0.1.0" },
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new ShimDaemonError(this.pluginName, "daemon initialize did not return mcp-session-id");
    }
    const body = await this.parseBody(response);
    if (body.error) {
      throw new ShimDaemonError(this.pluginName, `daemon initialize failed: ${body.error.message}`);
    }
    this.sessionId = sessionId;
  }

  private async rpc(method: string, params?: unknown): Promise<DaemonRpcEnvelope> {
    const response = await this.request(method, params);
    return this.parseBody(response);
  }

  /**
   * Parses a daemon response body as the JSON-RPC envelope. A daemon that
   * answers HTTP 200 with a truncated or otherwise non-JSON body is just as
   * wedged as one that never answered: the malformed body is wrapped as a
   * `ShimDaemonError` (never a raw `SyntaxError` escaping uncaught and
   * mis-classified as `InternalError` by the caller) and the cached session
   * is dropped, so the next call re-handshakes instead of replaying against
   * a connection the daemon has already shown is broken.
   */
  private async parseBody(response: Response): Promise<DaemonRpcEnvelope> {
    const text = await response.text();
    if (text.length === 0) return {};
    try {
      return JSON.parse(text) as DaemonRpcEnvelope;
    } catch (error) {
      this.sessionId = undefined;
      throw new ShimDaemonError(
        this.pluginName,
        `daemon returned a malformed response body: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Fires one JSON-RPC request at the daemon's UDS socket. Any failure —
   * connection refused, socket file gone, timeout, malformed response — is
   * wrapped as `ShimDaemonError` and drops the cached session, so a dead
   * daemon never leaves this connection wedged on a session id that will
   * never work again.
   */
  private async request(method: string, params?: unknown): Promise<Response> {
    const id = (this.requestId += 1);
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.exposureProfile) headers["x-prism-mcp-exposure"] = this.exposureProfile;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: UdsRequestInit = {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
        unix: this.socketPath,
      };
      const response = await fetch("http://localhost/mcp", init);
      if (!response.ok) {
        this.sessionId = undefined;
        throw new ShimDaemonError(this.pluginName, `daemon '${method}' returned HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      this.sessionId = undefined;
      if (error instanceof ShimDaemonError) throw error;
      throw new ShimDaemonError(this.pluginName, `daemon '${method}' unreachable: ${errorMessage(error)}`, error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Aggregator: resolves each configured plugin's live socket via the UDS
// registry, fans requests out per-plugin, and never lets one plugin's
// failure affect another's.
// ---------------------------------------------------------------------------

export type GetDaemonFn = (plugin: string) => Promise<RegistryResult<RegistryEntry>>;
export type ResolveOrSpawnFn = (plugin: string) => Promise<RegistryEntry>;

export interface ShimAggregatorOptions {
  readonly plugins: ReadonlyArray<string>;
  /**
   * Prism home directory, threaded from the process entrypoint (see
   * `src/mcp/shim-main.ts`, which resolves `PRISM_HOME` once via
   * `resolvePrismHome()`). Forwarded to the default `resolveOrSpawn` so a
   * `PRISM_HOME` override locates the same bundle/socket path `prism
   * refresh` wrote, instead of always falling back to `~/.prism`. Ignored
   * when `resolveOrSpawn` is supplied directly.
   */
  readonly prismHome?: string;
  readonly daemonTimeoutMs?: number;
  readonly spawnTimeoutMs?: number;
  readonly getDaemon?: GetDaemonFn;
  /**
   * Full override of daemon resolution, bypassing `getDaemon` entirely.
   * Tests that only want to exercise merge/dispatch/isolation (not
   * resolve-or-spawn itself) inject a stub here instead of standing up a
   * real compiled bundle on disk.
   */
  readonly resolveOrSpawn?: ResolveOrSpawnFn;
  /** Optional set of tool names to enable; if present, only these tools are exposed. */
  readonly enabledTools?: ReadonlySet<string>;
  /** Optional exposure profile to pass to daemon as X-Prism-Mcp-Exposure header. */
  readonly exposureProfile?: string;
}

export const DEFAULT_SHIM_DAEMON_TIMEOUT_MS = 30_000;

interface NamedTool {
  readonly plugin: string;
  readonly tool: Tool;
}

export class ShimAggregator {
  private readonly plugins: ReadonlyArray<string>;
  private readonly daemonTimeoutMs: number;
  private readonly getDaemon: GetDaemonFn;
  private readonly spawnTimeoutMs: number;
  private readonly resolveOrSpawn: ResolveOrSpawnFn;
  private readonly enabledTools: ReadonlySet<string> | undefined;
  private readonly exposureProfile: string | undefined;
  private readonly connections = new Map<string, { readonly sock: string; readonly connection: DaemonConnection }>();

  constructor(options: ShimAggregatorOptions) {
    this.plugins = options.plugins;
    this.daemonTimeoutMs = options.daemonTimeoutMs ?? DEFAULT_SHIM_DAEMON_TIMEOUT_MS;
    this.getDaemon = options.getDaemon ?? getDaemonDefault;
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
    this.enabledTools = options.enabledTools;
    this.exposureProfile = options.exposureProfile;
    this.resolveOrSpawn =
      options.resolveOrSpawn ??
      ((plugin: string) =>
        resolveOrSpawnDaemon({
          plugin,
          prismHome: options.prismHome,
          getDaemon: this.getDaemon,
          spawnTimeoutMs: this.spawnTimeoutMs,
        }));
  }

  /**
   * Resolves (or reuses) the connection for `plugin`: registry record
   * present and live and fresh -> reuse; absent, dead, or stale (bundle
   * hash no longer matches the on-disk bundle) -> `resolveOrSpawn` spawns a
   * fresh daemon and waits for it to come up (see `daemon-resolver.ts`).
   *
   * Returns `undefined` if resolution ultimately fails (no bundle to spawn,
   * or the daemon never became live within the timeout) — that is
   * "unavailable", not fatal: the caller omits its tools / reports a typed
   * error, but the aggregator itself never throws for one bad plugin.
   */
  private async resolveConnection(plugin: string): Promise<DaemonConnection | undefined> {
    let entry: RegistryEntry;
    try {
      entry = await this.resolveOrSpawn(plugin);
    } catch (error) {
      this.connections.delete(plugin);
      const detail =
        error instanceof DaemonResolveError || error instanceof Error ? error.message : String(error);
      console.error(`[prism-mcp-shim] ${plugin}: ${detail}`);
      return undefined;
    }

    const cached = this.connections.get(plugin);
    if (cached && cached.sock === entry.sock) {
      return cached.connection;
    }

    const connection = new DaemonConnection(
      plugin,
      entry.sock,
      this.daemonTimeoutMs,
      this.exposureProfile,
    );
    this.connections.set(plugin, { sock: entry.sock, connection });
    return connection;
  }

  /**
   * Merged, namespaced `tools/list` across every configured plugin.
   * Per-plugin fetches run in parallel (one slow/dead plugin never blocks
   * another), but results are reassembled in the fixed configured-plugin
   * order afterward, so the merged list is deterministic regardless of
   * which daemon happened to answer first.
   *
   * Tools are filtered by `enabledTools` if set: only tools in that set are
   * returned. This is the shim-side filtering applied before any daemon
   * response is merged.
   */
  async listTools(): Promise<ReadonlyArray<Tool>> {
    const perPlugin = await Promise.all(
      this.plugins.map(async (plugin): Promise<ReadonlyArray<NamedTool>> => {
        try {
          const connection = await this.resolveConnection(plugin);
          if (!connection) return [];
          const tools = await connection.listTools();
          return tools.map((tool) => ({ plugin, tool }));
        } catch {
          // Unavailable for this pass; omitted, never fatal to the merge.
          return [];
        }
      }),
    );

    const merged: Tool[] = [];
    for (const named of perPlugin) {
      for (const { plugin, tool } of named) {
        const fqName = namespacedToolName(plugin, tool.name);
        // Filter by enabledTools if set
        if (this.enabledTools !== undefined && !this.enabledTools.has(fqName)) {
          continue;
        }
        merged.push({ ...tool, name: fqName });
      }
    }
    return merged;
  }

  /**
   * Dispatches a namespaced tool name to its owning plugin's daemon and
   * returns the daemon's raw `CallToolResult` untouched. Throws
   * `ShimDaemonError` (typed) when the name cannot be resolved to a
   * configured plugin, when that plugin's daemon is absent/unreachable
   * within the timeout, or when the tool is not in the enabled set —
   * either way, this never crashes the shim and never touches any other
   * plugin's connection.
   */
  async callTool(fqName: string, args: Record<string, unknown>): Promise<unknown> {
    // Filter by enabledTools if set
    if (this.enabledTools !== undefined && !this.enabledTools.has(fqName)) {
      throw new ShimDaemonError("shim", `tool name '${fqName}' is not enabled`);
    }

    const split = splitNamespacedToolName(fqName);
    if (!split) {
      throw new ShimDaemonError("shim", `tool name '${fqName}' is not a namespaced shim tool`);
    }
    const plugin = this.plugins.find((candidate) => pluginWireNamespace(candidate) === split.namespace);
    if (!plugin) {
      throw new ShimDaemonError("shim", `tool name '${fqName}' does not match any configured plugin`);
    }
    const connection = await this.resolveConnection(plugin);
    if (!connection) {
      throw new ShimDaemonError(plugin, `plugin has no live daemon registered`);
    }
    return connection.callTool(split.toolName, args);
  }
}

// ---------------------------------------------------------------------------
// Harness-facing stdio MCP server
// ---------------------------------------------------------------------------

const SERVER_NAME = "prism-mcp-shim";
const SERVER_VERSION = "0.1.0";

export const createShimServer = (aggregator: ShimAggregator): Server => {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await aggregator.listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    try {
      const result = await aggregator.callTool(name, args ?? {});
      return result as CallToolResult;
    } catch (error) {
      if (error instanceof ShimDaemonError) {
        throw new McpError(ErrorCode.ConnectionClosed, error.message);
      }
      throw new McpError(ErrorCode.InternalError, errorMessage(error));
    }
  });

  return server;
};

// ---------------------------------------------------------------------------
// Process entrypoint
// ---------------------------------------------------------------------------

export interface RunShimOptions {
  readonly plugins: ReadonlyArray<string>;
  /** Prism home directory, threaded from the process entrypoint. See `ShimAggregatorOptions.prismHome`. */
  readonly prismHome?: string;
  readonly daemonTimeoutMs?: number;
  readonly spawnTimeoutMs?: number;
  readonly getDaemon?: GetDaemonFn;
  /** Optional set of tool names to enable; if present, only these tools are exposed. */
  readonly enabledTools?: ReadonlySet<string>;
  /** Optional exposure profile to pass to daemon as X-Prism-Mcp-Exposure header. */
  readonly exposureProfile?: string;
}

/**
 * Wires the aggregator to a stdio transport and runs until stdin closes or
 * the process receives SIGINT/SIGTERM. Never throws for daemon-level
 * failures — those surface per-request as typed MCP errors instead.
 */
export const runShim = async (options: RunShimOptions): Promise<void> => {
  const aggregator = new ShimAggregator(options);
  const server = createShimServer(aggregator);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await server.connect(transport);
};
