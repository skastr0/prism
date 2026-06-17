import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MCP_RUNTIME_METADATA_SCHEMA,
  computeFileSha256,
  detectMcpRuntimeStaleReasons,
  parseMcpRuntimeHealth,
  parseMcpRuntimeMetadata,
  readMcpRuntimeMetadata,
  writeMcpRuntimeMetadata,
} from "./runtime-metadata.js";

test("MCP runtime metadata parses a versioned schema", () => {
  const metadata = parseMcpRuntimeMetadata({
    schema: MCP_RUNTIME_METADATA_SCHEMA,
    serverName: "prism-generated-tower",
    transport: "streamable-http",
    host: "127.0.0.1",
    port: 38463,
    pid: 12345,
    serverSha256: "a".repeat(64),
    startedAt: "2026-05-17T00:00:00.000Z",
    healthUrl: "http://127.0.0.1:38463/healthz",
    mcpUrl: "http://127.0.0.1:38463/mcp",
  });

  expect(metadata).toEqual({
    schema: MCP_RUNTIME_METADATA_SCHEMA,
    serverName: "prism-generated-tower",
    transport: "streamable-http",
    host: "127.0.0.1",
    port: 38463,
    pid: 12345,
    serverSha256: "a".repeat(64),
    startedAt: "2026-05-17T00:00:00.000Z",
    healthUrl: "http://127.0.0.1:38463/healthz",
    mcpUrl: "http://127.0.0.1:38463/mcp",
  });

  expect(() =>
    parseMcpRuntimeMetadata({
      schema: "prism.mcp-runtime.v0",
      serverName: "prism-generated-tower",
      transport: "streamable-http",
    }),
  ).toThrow(/unsupported schema 'prism\.mcp-runtime\.v0'/);

  expect(() =>
    parseMcpRuntimeMetadata({
      schema: MCP_RUNTIME_METADATA_SCHEMA,
      serverName: "prism-generated-tower",
      transport: "streamable-http",
      mcpUrl: "http://127.0.0.1:38463/mcp?session=demo",
    }),
  ).toThrow(/'mcpUrl' must not contain credentials, query parameters, or fragments/);
});

test("MCP runtime metadata read/write stores endpoint and server hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-runtime-metadata-test-"));
  const path = join(root, "mcp", "prism-generated-tower", "runtime.json");

  await writeMcpRuntimeMetadata(path, {
    schema: MCP_RUNTIME_METADATA_SCHEMA,
    serverName: "prism-generated-tower",
    transport: "streamable-http",
    host: "127.0.0.1",
    port: 38463,
    pid: 12345,
    serverSha256: "b".repeat(64),
    startedAt: "2026-05-17T00:00:00.000Z",
    healthUrl: "http://127.0.0.1:38463/healthz",
    mcpUrl: "http://127.0.0.1:38463/mcp",
  });

  const raw = await readFile(path, "utf8");
  expect(raw).toContain("b".repeat(64));

  await expect(readMcpRuntimeMetadata(path)).resolves.toMatchObject({
    serverName: "prism-generated-tower",
    serverSha256: "b".repeat(64),
  });
});

test("MCP runtime metadata detects stale pid and hash drift", () => {
  const metadata = parseMcpRuntimeMetadata({
    schema: MCP_RUNTIME_METADATA_SCHEMA,
    serverName: "prism-generated-tower",
    transport: "streamable-http",
    pid: 12345,
    serverSha256: "d".repeat(64),
  });

  expect(
    detectMcpRuntimeStaleReasons(metadata, {
      requireLivePid: true,
      expectedServerSha256: "f".repeat(64),
      pidExists: () => false,
    }),
  ).toEqual([
    "pid-not-running",
    "missing-health",
    "server-sha256-mismatch",
  ]);

  expect(
    detectMcpRuntimeStaleReasons(
      { schema: MCP_RUNTIME_METADATA_SCHEMA, serverName: "missing", transport: "streamable-http" },
      {
        requireLivePid: true,
        expectedServerSha256: "f".repeat(64),
        pidExists: () => true,
      },
    ),
  ).toEqual([
    "missing-pid",
    "missing-health",
    "missing-server-sha256",
  ]);
});

test("MCP runtime metadata binds HTTP freshness to health data", () => {
  const metadata = parseMcpRuntimeMetadata({
    schema: MCP_RUNTIME_METADATA_SCHEMA,
    serverName: "prism-generated-tower",
    transport: "streamable-http",
    pid: 12345,
    serverSha256: "d".repeat(64),
    startedAt: "2026-05-17T00:00:00.000Z",
  });
  const health = parseMcpRuntimeHealth({
    schema: "prism.mcp-health.v1",
    serverName: "prism-generated-tower",
    transport: "streamable-http",
    startedAt: "2026-05-17T00:00:00.000Z",
    uptimeMs: 250,
    pid: 12345,
    toolCount: 4,
    serverSha256: "d".repeat(64),
  });

  expect(
    detectMcpRuntimeStaleReasons(metadata, {
      requireLivePid: true,
      expectedServerSha256: "d".repeat(64),
      pidExists: () => true,
      health,
    }),
  ).toEqual([]);

  expect(
    detectMcpRuntimeStaleReasons(metadata, {
      requireLivePid: true,
      expectedServerSha256: "d".repeat(64),
      pidExists: () => true,
      health: parseMcpRuntimeHealth({
        schema: "prism.mcp-health.v1",
        serverName: "prism-generated-tower",
        transport: "streamable-http",
        startedAt: "2026-05-17T00:00:01.000Z",
        uptimeMs: 250,
        pid: 54321,
        toolCount: 4,
        serverSha256: "e".repeat(64),
      }),
    }),
  ).toEqual([
    "health-pid-mismatch",
    "health-started-at-mismatch",
    "health-server-sha256-mismatch",
  ]);
});

test("MCP runtime metadata computes stable file sha256", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-runtime-hash-test-"));
  const path = join(root, "server.mjs");
  await writeFile(path, "console.log('prism');\n");

  await expect(computeFileSha256(path)).resolves.toBe(
    createHash("sha256").update("console.log('prism');\n").digest("hex"),
  );
});
