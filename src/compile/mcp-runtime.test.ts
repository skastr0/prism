import { expect, test } from "bun:test";
import type { PluginRegistry } from "./registry.js";
import {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
} from "./mcp-policy.js";
import {
  getMcpHttpTargetSupport,
  mcpServerBundleRuntimeOptions,
  renderMcpBearerAuthorizationTemplate,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  runtimeMcpServerDescriptor,
} from "./mcp-runtime.js";

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

test("MCP runtime defaults to stdio per target", () => {
  expect(resolveMcpRuntime(registry(), "codex-cli")).toEqual({
    targetId: "codex-cli",
    transport: "stdio",
    host: "127.0.0.1",
    tokenEnv: "PRISM_MCP_TOKEN",
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
          tokenEnv: "PRISM_MCP_CODEX_TOKEN",
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
    tokenEnv: "PRISM_MCP_CODEX_TOKEN",
    connectTimeoutMs: 15_000,
    toolTimeoutMs: 90_000,
  });
  expect(renderMcpHttpUrl(runtime)).toBe("http://localhost:38464/mcp");
  expect(renderMcpBearerAuthorizationTemplate(runtime.tokenEnv)).toBe(
    "Bearer ${PRISM_MCP_CODEX_TOKEN}",
  );
  expect(mcpServerBundleRuntimeOptions(runtime)).toEqual({
    transport: "streamable-http",
    toolTimeoutMs: 90_000,
    http: {
      host: "localhost",
      port: 38464,
      tokenEnv: "PRISM_MCP_CODEX_TOKEN",
    },
  });
});

test("MCP runtime supports Factory Droid Streamable HTTP config", () => {
  const runtime = resolveMcpRuntime(
    registry({
      mcp: {
        "factory-droid": {
          transport: "streamable-http",
          host: "127.0.0.1",
          port: 38466,
          tokenEnv: "PRISM_MCP_FACTORY_TOKEN",
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
          tokenEnv: "PRISM_MCP_KIMI_TOKEN",
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
          tokenEnv: "PRISM_MCP_CURSOR_TOKEN",
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

test("MCP runtime accepts a lifecycle-resolved Streamable HTTP port", () => {
  const runtime = resolveMcpRuntime(
    registry({
      mcp: {
        hermes: {
          transport: "streamable-http",
          host: "127.0.0.1",
          tokenEnv: "PRISM_MCP_HERMES_TOKEN",
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
            tokenEnv: "PRISM_MCP_HERMES_TOKEN",
          },
        },
      }),
      "hermes",
      { requirePort: true },
    ),
  ).toThrow(/requires plugin\.json runtime\.mcp\.hermes\.port/);
});

test("MCP runtime fails closed for unsupported HTTP targets", () => {
  expect(() =>
    resolveMcpRuntime(
      registry({
        mcp: {
          grok: {
            transport: "streamable-http",
            host: "127.0.0.1",
            port: 38465,
            tokenEnv: "PRISM_MCP_GROK_TOKEN",
          },
        },
      }),
      "grok",
      { requirePort: true },
    ),
  ).toThrow(/Streamable HTTP MCP is not supported for target 'grok'/);
  expect(getMcpHttpTargetSupport("grok").reason).toContain("not been verified");
});

test("MCP runtime rejects non-loopback HTTP hosts and invalid token env", () => {
  expect(() =>
    resolveMcpRuntime(
      registry({
        mcp: {
          hermes: {
            transport: "streamable-http",
            host: "0.0.0.0",
            port: 38463,
            tokenEnv: "PRISM_MCP_TOKEN",
          },
        },
      }),
      "hermes",
      { requirePort: true },
    ),
  ).toThrow(/loopback host/);

  expect(() =>
    resolveMcpRuntime(
      registry({
        mcp: {
          hermes: {
            transport: "streamable-http",
            host: "127.0.0.1",
            port: 38463,
            tokenEnv: "not-valid-env",
          },
        },
      }),
      "hermes",
      { requirePort: true },
    ),
  ).toThrow(/environment variable name/);
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

test("MCP runtime daemon path is shared across HTTP-capable targets", () => {
  expect(runtimeMcpServerDescriptor("/tmp/harness", "Demo Tools")).toEqual({
    serverName: "prism-generated-demo-tools",
    relativePath: "prism/mcp/prism_generated_demo_tools/server.mjs",
    absolutePath: "/tmp/harness/prism/mcp/prism_generated_demo_tools/server.mjs",
  });
});
