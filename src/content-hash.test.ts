import { expect, test } from "bun:test";
import {
  computeContentHash,
  computeMcpHttpConfigContentHash,
  normalizeMcpHttpConfigForHash,
} from "./content-hash.js";

const renderMcpConfig = (port: number): string =>
  JSON.stringify({
    mcpServers: {
      p_f3119df0: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { "X-Prism-Mcp-Exposure": "prism-generated-demo:grok" },
      },
    },
  }, null, 2) + "\n";

test("computeMcpHttpConfigContentHash is stable across a port-only change", () => {
  const a = renderMcpConfig(50953);
  const b = renderMcpConfig(61742);
  expect(a).not.toBe(b);
  expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  expect(computeMcpHttpConfigContentHash(a)).toBe(computeMcpHttpConfigContentHash(b));
});

test("computeMcpHttpConfigContentHash still differs on a real content change", () => {
  const base = renderMcpConfig(50953);
  const withExtraServer = JSON.stringify({
    mcpServers: {
      p_f3119df0: {
        type: "http",
        url: "http://127.0.0.1:50953/mcp",
        headers: { "X-Prism-Mcp-Exposure": "prism-generated-demo:grok" },
      },
      p_other: {
        type: "http",
        url: "http://127.0.0.1:9999/mcp",
      },
    },
  }, null, 2) + "\n";

  expect(computeMcpHttpConfigContentHash(base)).not.toBe(
    computeMcpHttpConfigContentHash(withExtraServer),
  );
});

test("normalizeMcpHttpConfigForHash falls back unchanged for non-MCP content", () => {
  const notMcp = "---\nname: qa-tester\n---\n\nbody\n";
  expect(normalizeMcpHttpConfigForHash(notMcp)).toBe(notMcp);

  const invalidJson = "{ not json";
  expect(normalizeMcpHttpConfigForHash(invalidJson)).toBe(invalidJson);

  const noMcpServersKey = JSON.stringify({ hooks: [] });
  expect(normalizeMcpHttpConfigForHash(noMcpServersKey)).toBe(noMcpServersKey);
});
