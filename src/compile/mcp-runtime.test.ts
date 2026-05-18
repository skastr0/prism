import { expect, test } from "bun:test";
import type { PluginRegistry } from "./registry.js";
import {
  getMcpHttpTargetSupport,
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
  });
});

test("MCP runtime validates supported Streamable HTTP target config", () => {
  expect(
    resolveMcpRuntime(
      registry({
        mcp: {
          "codex-cli": {
            transport: "streamable-http",
            host: "localhost",
            port: 38464,
            tokenEnv: "PRISM_MCP_CODEX_TOKEN",
          },
        },
      }),
      "codex-cli",
      { requirePort: true },
    ),
  ).toEqual({
    targetId: "codex-cli",
    transport: "streamable-http",
    host: "localhost",
    port: 38464,
    tokenEnv: "PRISM_MCP_CODEX_TOKEN",
  });
});

test("MCP runtime fails closed for unsupported HTTP targets", () => {
  expect(() =>
    resolveMcpRuntime(
      registry({
        mcp: {
          "gemini-cli": {
            transport: "streamable-http",
            host: "127.0.0.1",
            port: 38465,
            tokenEnv: "PRISM_MCP_GEMINI_TOKEN",
          },
        },
      }),
      "gemini-cli",
      { requirePort: true },
    ),
  ).toThrow(/Streamable HTTP MCP is not supported for target 'gemini-cli'/);
  expect(getMcpHttpTargetSupport("gemini-cli").reason).toContain("bearer-token auth");
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

test("MCP runtime daemon path is shared across HTTP-capable targets", () => {
  expect(runtimeMcpServerDescriptor("/tmp/harness", "Demo Tools")).toEqual({
    serverName: "prism-generated-demo-tools",
    relativePath: "prism/mcp/prism_generated_demo_tools/server.mjs",
    absolutePath: "/tmp/harness/prism/mcp/prism_generated_demo_tools/server.mjs",
  });
});
