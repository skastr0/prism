/**
 * `src/doctor/orphaned-mcp-entries.ts` (PQ-172) proof against bare config
 * fixtures -- one regression per shared-config harness format (TOML for
 * codex-cli/grok, JSON for cursor, hand-rolled YAML for hermes), plus the
 * structural removers in isolation. `doctor-contract.test.ts` covers the
 * same surface end-to-end through `runDoctor`/`--fix`.
 */

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectOrphanedMcpEntries,
  isSharedConfigHarnessId,
  pruneOrphanedMcpEntry,
  removeTomlServerTable,
  removeYamlMappingChild,
} from "./orphaned-mcp-entries.js";

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "prism-orphan-mcp-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("isSharedConfigHarnessId: the four single-file shim harnesses only", () => {
  expect(isSharedConfigHarnessId("codex-cli")).toBe(true);
  expect(isSharedConfigHarnessId("grok")).toBe(true);
  expect(isSharedConfigHarnessId("cursor")).toBe(true);
  expect(isSharedConfigHarnessId("hermes")).toBe(true);
  expect(isSharedConfigHarnessId("claude-code")).toBe(false);
  expect(isSharedConfigHarnessId("kimi-code")).toBe(false);
});

// ---------------------------------------------------------------------------
// cursor -- structural JSON (mcpServers.<key>)
// ---------------------------------------------------------------------------

test("cursor: an untracked legacy-named entry is an orphan; a tracked one is not", async () => {
  await withTempRoot(async (root) => {
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            "prism-generated-retired-tool": { command: "prism", args: ["mcp", "shim"] },
            "my-own-tool": { command: "node", args: ["server.js"] },
          },
        },
        null,
        2,
      ),
    );

    const orphans = await collectOrphanedMcpEntries("cursor", root, new Set());
    expect(orphans).toEqual([
      {
        harness: "cursor",
        configPath: join(root, "mcp.json"),
        serverKey: "prism-generated-retired-tool",
        regionKey: "mcpServers.prism-generated-retired-tool",
      },
    ]);

    // Tracked (regionKey present) -> no longer an orphan.
    const trackedOrphans = await collectOrphanedMcpEntries(
      "cursor",
      root,
      new Set(["mcpServers.prism-generated-retired-tool"]),
    );
    expect(trackedOrphans).toEqual([]);
  });
});

test("cursor: prune removes exactly the orphan and is idempotent", async () => {
  await withTempRoot(async (root) => {
    const configPath = join(root, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            "prism-generated-retired-tool": { command: "prism", args: ["mcp", "shim"] },
            "my-own-tool": { command: "node", args: ["server.js"] },
          },
        },
        null,
        2,
      ),
    );

    const [orphan] = await collectOrphanedMcpEntries("cursor", root, new Set());
    const result = await pruneOrphanedMcpEntry(orphan!);
    expect(result.pruned).toBe(true);

    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    expect(Object.keys(parsed.mcpServers)).toEqual(["my-own-tool"]);

    // Idempotent: nothing left to prune.
    const second = await pruneOrphanedMcpEntry(orphan!);
    expect(second.pruned).toBe(false);
    expect(await collectOrphanedMcpEntries("cursor", root, new Set())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// codex-cli / grok -- structural TOML (unfenced [mcp_servers.<key>] table)
// ---------------------------------------------------------------------------

const unfencedCodexToml = [
  "[profile]",
  'active = "default"',
  "",
  '["mcp_servers"."prism-generated-old-tool"]',
  'command = "prism"',
  'args = ["mcp", "shim"]',
  "enabled = true",
  '["mcp_servers"."prism-generated-old-tool"."env"]',
  'PRISM_SHIM_PLUGINS = "old-tool"',
  "",
  '["mcp_servers"."my-own-server"]',
  'command = "node"',
  'args = ["server.js"]',
  "",
].join("\n");

test("codex-cli: an unfenced legacy TOML entry is an orphan and prunes cleanly", async () => {
  await withTempRoot(async (root) => {
    const configPath = join(root, "config.toml");
    await writeFile(configPath, unfencedCodexToml);

    const orphans = await collectOrphanedMcpEntries("codex-cli", root, new Set());
    expect(orphans).toEqual([
      {
        harness: "codex-cli",
        configPath,
        serverKey: "prism-generated-old-tool",
        regionKey: "codex.mcp.prism-generated-old-tool",
      },
    ]);

    const result = await pruneOrphanedMcpEntry(orphans[0]!);
    expect(result.pruned).toBe(true);

    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain("prism-generated-old-tool");
    expect(after).toContain('["mcp_servers"."my-own-server"]');
    expect(after).toContain("[profile]");

    // Idempotent.
    const second = await pruneOrphanedMcpEntry(orphans[0]!);
    expect(second.pruned).toBe(false);
  });
});

test("grok: an unfenced legacy TOML entry (bare p_<hash8> key) is an orphan", async () => {
  await withTempRoot(async (root) => {
    const configPath = join(root, "config.toml");
    await writeFile(
      configPath,
      [
        '["mcp_servers"."p_deadbeef"]',
        'command = "prism"',
        'args = ["mcp", "shim"]',
        '["mcp_servers"."p_deadbeef"."env"]',
        'PRISM_SHIM_PLUGINS = "retired"',
        "",
      ].join("\n"),
    );

    const orphans = await collectOrphanedMcpEntries("grok", root, new Set());
    expect(orphans).toEqual([
      { harness: "grok", configPath, serverKey: "p_deadbeef", regionKey: "grok.mcp.p_deadbeef" },
    ]);

    const result = await pruneOrphanedMcpEntry(orphans[0]!);
    expect(result.pruned).toBe(true);
    const after = await readFile(configPath, "utf8");
    expect(after.trim()).toBe("");
  });
});

test("codex-cli: a currently-tracked entry (regionKey owned) is never flagged", async () => {
  await withTempRoot(async (root) => {
    const configPath = join(root, "config.toml");
    await writeFile(
      configPath,
      [
        '["mcp_servers"."myplugin"]',
        'command = "prism"',
        'args = ["mcp", "shim"]',
        '["mcp_servers"."myplugin"."env"]',
        'PRISM_SHIM_PLUGINS = "myplugin"',
        "",
      ].join("\n"),
    );

    const orphans = await collectOrphanedMcpEntries("codex-cli", root, new Set(["codex.mcp.myplugin"]));
    expect(orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hermes -- hand-rolled YAML (unfenced mcp_servers.<key> mapping child)
// ---------------------------------------------------------------------------

const unfencedHermesYaml = [
  "log_level: info",
  "mcp_servers:",
  "  prism-generated-old-tool:",
  '    command: "prism"',
  "    args:",
  "      - mcp",
  "      - shim",
  "    env:",
  '      PRISM_SHIM_PLUGINS: "old-tool"',
  "  my-own-server:",
  '    command: "node"',
  "",
].join("\n");

test("hermes: an unfenced legacy YAML entry is an orphan and prunes cleanly", async () => {
  await withTempRoot(async (root) => {
    const configPath = join(root, "config.yaml");
    await writeFile(configPath, unfencedHermesYaml);

    const orphans = await collectOrphanedMcpEntries("hermes", root, new Set());
    expect(orphans).toEqual([
      {
        harness: "hermes",
        configPath,
        serverKey: "prism-generated-old-tool",
        regionKey: "hermes.mcp.prism-generated-old-tool",
      },
    ]);

    const result = await pruneOrphanedMcpEntry(orphans[0]!);
    expect(result.pruned).toBe(true);

    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain("prism-generated-old-tool");
    expect(after).toContain("my-own-server");
    expect(after).toContain("log_level: info");

    const second = await pruneOrphanedMcpEntry(orphans[0]!);
    expect(second.pruned).toBe(false);
  });
});

test("hermes: a user's own unfenced server sharing no fingerprint is never flagged", async () => {
  await withTempRoot(async (root) => {
    await writeFile(
      join(root, "config.yaml"),
      ["mcp_servers:", "  my-own-server:", '    command: "node"', ""].join("\n"),
    );
    expect(await collectOrphanedMcpEntries("hermes", root, new Set())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structural removers in isolation
// ---------------------------------------------------------------------------

test("removeTomlServerTable: removes the table and its env sub-table only", () => {
  const content = [
    "[profile]",
    'active = "default"',
    "",
    '["mcp_servers"."target"]',
    'command = "prism"',
    '["mcp_servers"."target"."env"]',
    'X = "1"',
    "",
    '["mcp_servers"."keep"]',
    'command = "node"',
    "",
  ].join("\n");

  const outcome = removeTomlServerTable(content, "target");
  expect(outcome.changed).toBe(true);
  expect(outcome.content).not.toContain("target");
  expect(outcome.content).toContain('["mcp_servers"."keep"]');
  expect(outcome.content).toContain("[profile]");
});

test("removeTomlServerTable: no-op when the table is absent", () => {
  const content = '["mcp_servers"."keep"]\ncommand = "node"\n';
  const outcome = removeTomlServerTable(content, "missing");
  expect(outcome).toEqual({ content, changed: false });
});

test("removeYamlMappingChild: removes only the named child and its block", () => {
  const content = [
    "mcp_servers:",
    "  target:",
    '    command: "prism"',
    "    args:",
    "      - mcp",
    "  keep:",
    '    command: "node"',
    "other_key: 1",
    "",
  ].join("\n");

  const outcome = removeYamlMappingChild(content, "mcp_servers", "target");
  expect(outcome.changed).toBe(true);
  expect(outcome.content).not.toContain("target");
  expect(outcome.content).toContain("keep:");
  expect(outcome.content).toContain("other_key: 1");
});

test("removeYamlMappingChild: no-op when the child is absent", () => {
  const content = "mcp_servers:\n  keep:\n    command: node\n";
  const outcome = removeYamlMappingChild(content, "mcp_servers", "missing");
  expect(outcome).toEqual({ content, changed: false });
});

test("collectOrphanedMcpEntries: missing config file -> no entries, no throw", async () => {
  await withTempRoot(async (root) => {
    await mkdir(root, { recursive: true });
    expect(await collectOrphanedMcpEntries("cursor", root, new Set())).toEqual([]);
    expect(await collectOrphanedMcpEntries("hermes", root, new Set())).toEqual([]);
  });
});
