import { expect, test } from "bun:test";
import type { PluginRegistry } from "./registry.js";
import {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
} from "./mcp-policy.js";
import {
  getMcpHttpTargetSupport,
  renderMcpHttpUrl,
  resolveMcpRuntime,
} from "./mcp-runtime.js";
import { prismMcpServerPath } from "./mcp-runtime-path.js";

const registry = (runtime: PluginRegistry["runtime"] = {}): PluginRegistry => ({
  pluginName: "demo-tools",
  pluginVersion: "0.1.0",
  pluginPath: "/tmp/demo-tools",
  dependencyPaths: {},
  targets: { tools: ["hermes"] },
  runtime,
  identities: new Map(),
  personalities: new Map(),
  toolspaces: new Map(),
  modelspaces: new Map(),
  skillspaces: new Map(),
  traits: new Map(),
  tools: new Map(),
  agents: new Map(),
  orbits: new Map(),
  hooks: new Map(),
  skills: new Map(),
  deps: new Map(),
});

test("MCP runtime defaults to Streamable HTTP per target", () => {
  expect(resolveMcpRuntime(registry(), "codex-cli")).toEqual({
    targetId: "codex-cli",
    transport: "streamable-http",
    host: "127.0.0.1",
    connectTimeoutMs: DEFAULT_MCP_CONNECT_TIMEOUT_MS,
    toolTimeoutMs: DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  });
});

test("MCP runtime validates supported Streamable HTTP target config", () => {
  const runtime = resolveMcpRuntime(
    registry({
      mcp: {
        "codex-cli": {
          transport: "streamable-http",
          host: "localhost",
          port: 38464,
          connectTimeoutMs: 15_000,
          toolTimeoutMs: 90_000,
        },
      },
    }),
    "codex-cli",
    { requirePort: true },
  );

  expect(runtime).toEqual({
    targetId: "codex-cli",
    transport: "streamable-http",
    host: "localhost",
    port: 38464,
    connectTimeoutMs: 15_000,
    toolTimeoutMs: 90_000,
  });
  expect(renderMcpHttpUrl(runtime)).toBe("http://localhost:38464/mcp");
});

test("MCP runtime supports Factory Droid Streamable HTTP config", () => {
  const runtime = resolveMcpRuntime(
    registry({
      mcp: {
        "factory-droid": {
          transport: "streamable-http",
          host: "127.0.0.1",
          port: 38466,
        },
      },
    }),
    "factory-droid",
    { requirePort: true },
  );

  expect(runtime.targetId).toBe("factory-droid");
  expect(renderMcpHttpUrl(runtime)).toBe("http://127.0.0.1:38466/mcp");
  expect(getMcpHttpTargetSupport("factory-droid").config).toBe("supported");
});

test("MCP runtime supports Kimi Code Streamable HTTP config", () => {
  const runtime = resolveMcpRuntime(
    registry({
      mcp: {
        "kimi-code": {
          transport: "streamable-http",
          host: "127.0.0.1",
          port: 38467,
        },
      },
    }),
    "kimi-code",
    { requirePort: true },
  );

  expect(runtime.targetId).toBe("kimi-code");
  expect(renderMcpHttpUrl(runtime)).toBe("http://127.0.0.1:38467/mcp");
  expect(getMcpHttpTargetSupport("kimi-code").config).toBe("supported");
});

test("MCP runtime supports Cursor Streamable HTTP config", () => {
  const runtime = resolveMcpRuntime(
    registry({
      mcp: {
        cursor: {
          transport: "streamable-http",
          host: "127.0.0.1",
          port: 38468,
        },
      },
    }),
    "cursor",
    { requirePort: true },
  );

  expect(runtime.targetId).toBe("cursor");
  expect(renderMcpHttpUrl(runtime)).toBe("http://127.0.0.1:38468/mcp");
  expect(getMcpHttpTargetSupport("cursor").config).toBe("supported");
});

test("MCP runtime supports Grok Streamable HTTP config", () => {
  const runtime = resolveMcpRuntime(
    registry({
      mcp: {
        grok: {
          transport: "streamable-http",
          host: "127.0.0.1",
          port: 38469,
        },
      },
    }),
    "grok",
    { requirePort: true },
  );

  expect(runtime.targetId).toBe("grok");
  expect(renderMcpHttpUrl(runtime)).toBe("http://127.0.0.1:38469/mcp");
  expect(getMcpHttpTargetSupport("grok").config).toBe("supported");
});

test("MCP runtime accepts a lifecycle-resolved Streamable HTTP port", () => {
  const runtime = resolveMcpRuntime(
    registry({
      mcp: {
        hermes: {
          transport: "streamable-http",
          host: "127.0.0.1",
        },
      },
    }),
    "hermes",
    { requirePort: true, resolvedPort: 39123 },
  );

  expect(renderMcpHttpUrl(runtime)).toBe("http://127.0.0.1:39123/mcp");
});

test("MCP runtime still rejects missing Streamable HTTP ports when required", () => {
  expect(() =>
    resolveMcpRuntime(
      registry({
        mcp: {
          hermes: {
            transport: "streamable-http",
            host: "127.0.0.1",
          },
        },
      }),
      "hermes",
      { requirePort: true },
    ),
  ).toThrow(/requires plugin\.json runtime\.mcp\.hermes\.port/);
});

test("MCP runtime rejects non-loopback HTTP hosts", () => {
  expect(() =>
    resolveMcpRuntime(
      registry({
        mcp: {
          hermes: {
            transport: "streamable-http",
            host: "0.0.0.0",
            port: 38463,
          },
        },
      }),
      "hermes",
      { requirePort: true },
    ),
  ).toThrow(/loopback host/);
});

test("MCP runtime rejects invalid timeout config", () => {
  expect(() =>
    resolveMcpRuntime(
      registry({
        mcp: {
          hermes: {
            transport: "streamable-http",
            host: "127.0.0.1",
            port: 38463,
            toolTimeoutMs: 0,
          },
        },
      }),
      "hermes",
      { requirePort: true },
    ),
  ).toThrow(/toolTimeoutMs must be a positive integer/);

  expect(() =>
    resolveMcpRuntime(
      registry({
        mcp: {
          hermes: {
            transport: "streamable-http",
            host: "127.0.0.1",
            port: 38463,
            connectTimeoutMs: 1.5,
          },
        },
      }),
      "hermes",
      { requirePort: true },
    ),
  ).toThrow(/connectTimeoutMs must be a positive integer/);
});

test("canonical MCP server bundle path lives under PRISM_HOME/runtime/mcp", () => {
  expect(prismMcpServerPath("/tmp/prism-home", "Demo Tools")).toBe(
    "/tmp/prism-home/runtime/mcp/demo-tools/server.mjs",
  );
});
