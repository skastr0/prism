import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pluginWireNamespace,
  namespacedToolName,
  splitNamespacedToolName,
  ShimAggregator,
  ShimDaemonError,
  type GetDaemonFn,
} from "./shim";
import type { RegistryEntry, RegistryResult } from "./uds-registry";

describe("pluginWireNamespace / namespacedToolName", () => {
  it("produces the fixed p_<8-hex> shape", () => {
    expect(pluginWireNamespace("some-plugin")).toMatch(/^p_[0-9a-f]{8}$/);
  });

  it("is a pure deterministic function of the plugin name", () => {
    expect(pluginWireNamespace("forge")).toBe(pluginWireNamespace("forge"));
    expect(pluginWireNamespace("forge")).not.toBe(pluginWireNamespace("beacon"));
  });

  it("round-trips through splitNamespacedToolName", () => {
    const fq = namespacedToolName("forge", "create_glyph");
    const split = splitNamespacedToolName(fq);
    expect(split).toEqual({ namespace: pluginWireNamespace("forge"), toolName: "create_glyph" });
  });

  it("round-trips even when the tool name itself contains '__'", () => {
    const fq = namespacedToolName("forge", "weird__tool__name");
    const split = splitNamespacedToolName(fq);
    expect(split).toEqual({ namespace: pluginWireNamespace("forge"), toolName: "weird__tool__name" });
  });

  it("rejects a name with no separator", () => {
    expect(splitNamespacedToolName("not-namespaced")).toBeUndefined();
  });

  it("rejects a name whose prefix is not the namespace shape", () => {
    expect(splitNamespacedToolName("wrong_prefix_xx__tool")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ShimAggregator: fake daemons (plain Bun.serve over UDS speaking the same
// minimal JSON-RPC contract) stand in for real compiled bundles so these
// tests stay fast and exercise the aggregator's own merge/dispatch/isolation
// logic in isolation from bundle compilation.
// ---------------------------------------------------------------------------

interface FakeDaemon {
  readonly sock: string;
  readonly stop: () => void;
}

const startFakeDaemon = async (
  socketPath: string,
  options: {
    readonly tools: ReadonlyArray<{ name: string; inputSchema: unknown }>;
    readonly callResult: (name: string, args: unknown) => unknown;
  },
): Promise<FakeDaemon> => {
  const server = Bun.serve({
    unix: socketPath,
    fetch: async (req) => {
      const body = (await req.json()) as { id: number; method: string; params?: unknown };
      const respond = (result: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json", ...headers },
        });

      if (body.method === "initialize") {
        return respond(
          { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fake", version: "0.0.0" } },
          { "mcp-session-id": "fake-session" },
        );
      }
      if (body.method === "tools/list") {
        return respond({ tools: options.tools });
      }
      if (body.method === "tools/call") {
        const params = body.params as { name: string; arguments?: unknown };
        return respond(options.callResult(params.name, params.arguments));
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  return { sock: socketPath, stop: () => server.stop(true) };
};

const tempDirs: string[] = [];
const fakeDaemons: FakeDaemon[] = [];

afterEach(async () => {
  for (const daemon of fakeDaemons.splice(0)) daemon.stop();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

const makeRegistry = (entries: Record<string, string>): GetDaemonFn => {
  const getDaemon: GetDaemonFn = async (plugin: string): Promise<RegistryResult<RegistryEntry>> => {
    const sock = entries[plugin];
    if (!sock) return { kind: "absent" };
    return { kind: "ok", value: { pid: process.pid, sock, bundleHash: "test", startedAt: 0, lastUsed: 0 } };
  };
  return getDaemon;
};

describe("ShimAggregator", () => {
  it("merges tools/list across plugins in configured order and namespaces each name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shim-agg-test-"));
    tempDirs.push(dir);
    const sockA = join(dir, "a.sock");
    const sockB = join(dir, "b.sock");

    fakeDaemons.push(
      await startFakeDaemon(sockA, {
        tools: [{ name: "alpha", inputSchema: { type: "object" } }],
        callResult: (name) => ({ content: [{ type: "text", text: `a:${name}` }] }),
      }),
    );
    fakeDaemons.push(
      await startFakeDaemon(sockB, {
        tools: [{ name: "beta", inputSchema: { type: "object" } }],
        callResult: (name) => ({ content: [{ type: "text", text: `b:${name}` }] }),
      }),
    );

    const aggregator = new ShimAggregator({
      plugins: ["plugin-a", "plugin-b"],
      getDaemon: makeRegistry({ "plugin-a": sockA, "plugin-b": sockB }),
    });

    const tools = await aggregator.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      namespacedToolName("plugin-a", "alpha"),
      namespacedToolName("plugin-b", "beta"),
    ]);
  });

  it("dispatches tools/call to the owning plugin's daemon and forwards the result untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shim-agg-test-"));
    tempDirs.push(dir);
    const sock = join(dir, "a.sock");
    fakeDaemons.push(
      await startFakeDaemon(sock, {
        tools: [{ name: "alpha", inputSchema: { type: "object" } }],
        callResult: (name, args) => ({
          content: [{ type: "text", text: "ok" }],
          structuredContent: { name, args },
        }),
      }),
    );

    const aggregator = new ShimAggregator({
      plugins: ["plugin-a"],
      getDaemon: makeRegistry({ "plugin-a": sock }),
    });

    const result = (await aggregator.callTool(namespacedToolName("plugin-a", "alpha"), { x: 1 })) as {
      structuredContent: unknown;
    };
    expect(result.structuredContent).toEqual({ name: "alpha", args: { x: 1 } });
  });

  it("omits an absent plugin from tools/list without failing the merge", async () => {
    const aggregator = new ShimAggregator({
      plugins: ["plugin-missing"],
      getDaemon: makeRegistry({}),
    });
    expect(await aggregator.listTools()).toEqual([]);
  });

  it("one plugin being dead never blocks another plugin's tools/list or tools/call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shim-agg-test-"));
    tempDirs.push(dir);
    const sockAlive = join(dir, "alive.sock");
    const sockDead = join(dir, "dead.sock"); // never bound

    fakeDaemons.push(
      await startFakeDaemon(sockAlive, {
        tools: [{ name: "ping", inputSchema: { type: "object" } }],
        callResult: () => ({ content: [{ type: "text", text: "pong" }] }),
      }),
    );

    const aggregator = new ShimAggregator({
      plugins: ["plugin-dead", "plugin-alive"],
      daemonTimeoutMs: 500,
      getDaemon: makeRegistry({ "plugin-dead": sockDead, "plugin-alive": sockAlive }),
    });

    const tools = await aggregator.listTools();
    expect(tools.map((t) => t.name)).toEqual([namespacedToolName("plugin-alive", "ping")]);

    const result = (await aggregator.callTool(namespacedToolName("plugin-alive", "ping"), {})) as {
      content: ReadonlyArray<{ text: string }>;
    };
    expect(result.content[0]?.text).toBe("pong");
  });

  it("tools/call on an unresolvable or dead plugin throws a typed ShimDaemonError", async () => {
    const aggregator = new ShimAggregator({
      plugins: ["plugin-missing"],
      daemonTimeoutMs: 500,
      getDaemon: makeRegistry({}),
    });

    await expect(aggregator.callTool(namespacedToolName("plugin-missing", "anything"), {})).rejects.toBeInstanceOf(
      ShimDaemonError,
    );
    await expect(aggregator.callTool("not-namespaced", {})).rejects.toBeInstanceOf(ShimDaemonError);
  });
});
