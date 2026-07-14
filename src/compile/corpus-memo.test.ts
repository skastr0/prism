import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  computeCorpusHash,
  computeCorpusParamsHash,
  hashPluginContent,
  matchesCorpusMemo,
  readCorpusMemo,
  writeCorpusMemo,
} from "./corpus-memo.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-corpus-memo-test-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("hashPluginContent changes when a source file changes", async () => {
  const pluginPath = join(await createTempRoot(), "plugin-a");
  await writeText(join(pluginPath, "plugin.json"), JSON.stringify({ name: "plugin-a" }));
  await writeText(join(pluginPath, "identities", "builder.identity.md"), "You are a builder.");

  const before = await hashPluginContent(pluginPath);

  await writeText(join(pluginPath, "identities", "builder.identity.md"), "You are a reviewer.");
  const after = await hashPluginContent(pluginPath);

  expect(after).not.toBe(before);
});

test("hashPluginContent ignores dist/ and prism.lock -- compiler outputs, not compile inputs", async () => {
  const pluginPath = join(await createTempRoot(), "plugin-a");
  await writeText(join(pluginPath, "plugin.json"), JSON.stringify({ name: "plugin-a" }));
  await writeText(join(pluginPath, "identities", "builder.identity.md"), "You are a builder.");

  const before = await hashPluginContent(pluginPath);

  // Simulate what a real compile writes into the plugin's own directory.
  await writeText(join(pluginPath, "prism.lock"), JSON.stringify({ version: 1 }));
  await writeText(join(pluginPath, "dist", ".prism-cache", "deadbeef.json"), "{}");
  await writeText(join(pluginPath, "dist", "server.mjs"), "// generated bundle");

  const after = await hashPluginContent(pluginPath);

  expect(after).toBe(before);
});

test("computeCorpusHash is order-independent over the plugin list and changes when any single plugin's content changes", async () => {
  const root = await createTempRoot();
  const pluginA = join(root, "plugin-a");
  const pluginB = join(root, "plugin-b");
  await writeText(join(pluginA, "plugin.json"), JSON.stringify({ name: "plugin-a" }));
  await writeText(join(pluginB, "plugin.json"), JSON.stringify({ name: "plugin-b" }));

  const forward = await computeCorpusHash({
    pluginPaths: [pluginA, pluginB],
    prismVersion: "0.0.0-test",
  });
  const reversed = await computeCorpusHash({
    pluginPaths: [pluginB, pluginA],
    prismVersion: "0.0.0-test",
  });
  expect(reversed).toBe(forward);

  // Mutate only plugin-b; the corpus hash must move even though plugin-a
  // (and the rest of the corpus) never changed -- this is the PQ-090
  // invalidation guarantee ("mutate one plugin, assert full rebuild still
  // runs").
  await writeText(join(pluginB, "plugin.json"), JSON.stringify({ name: "plugin-b", version: "0.0.2" }));
  const afterMutation = await computeCorpusHash({
    pluginPaths: [pluginA, pluginB],
    prismVersion: "0.0.0-test",
  });
  expect(afterMutation).not.toBe(forward);
});

test("computeCorpusHash changes with prismVersion", async () => {
  const pluginPath = join(await createTempRoot(), "plugin-a");
  await writeText(join(pluginPath, "plugin.json"), JSON.stringify({ name: "plugin-a" }));

  const v1 = await computeCorpusHash({ pluginPaths: [pluginPath], prismVersion: "0.1.0" });
  const v2 = await computeCorpusHash({ pluginPaths: [pluginPath], prismVersion: "0.2.0" });
  expect(v2).not.toBe(v1);
});

test("computeCorpusParamsHash changes when the harness set, scope, project, or resolved roots change", () => {
  const base = {
    harnesses: ["opencode", "claude-code"] as const,
    scope: "global" as const,
    overwrite: false,
    compileOnly: false,
    resolvedRoots: { opencode: "/home/.config/opencode", "claude-code": "/home/.claude" },
  };

  const baseHash = computeCorpusParamsHash(base);

  // Harness set order must not matter.
  expect(
    computeCorpusParamsHash({ ...base, harnesses: ["claude-code", "opencode"] }),
  ).toBe(baseHash);

  expect(computeCorpusParamsHash({ ...base, scope: "project", projectPath: "/proj" }))
    .not.toBe(baseHash);
  expect(computeCorpusParamsHash({ ...base, overwrite: true })).not.toBe(baseHash);
  expect(computeCorpusParamsHash({ ...base, compileOnly: true })).not.toBe(baseHash);
  expect(
    computeCorpusParamsHash({
      ...base,
      resolvedRoots: { opencode: "/other-home/.config/opencode", "claude-code": "/home/.claude" },
    }),
  ).not.toBe(baseHash);
});

test("writeCorpusMemo + readCorpusMemo round-trip, and matchesCorpusMemo is exact on both hashes", async () => {
  const prismHome = join(await createTempRoot(), "prism-home");
  const expandedDir = "/plugins/corpus-a";

  expect(await readCorpusMemo(prismHome, expandedDir)).toBeNull();

  await writeCorpusMemo(prismHome, expandedDir, {
    corpusHash: "hash-a",
    paramsHash: "params-a",
    pluginCount: 3,
  });

  const memo = await readCorpusMemo(prismHome, expandedDir);
  expect(memo?.corpusHash).toBe("hash-a");
  expect(memo?.paramsHash).toBe("params-a");
  expect(memo?.pluginCount).toBe(3);

  expect(matchesCorpusMemo(memo, "hash-a", "params-a")).toBe(true);
  expect(matchesCorpusMemo(memo, "hash-b", "params-a")).toBe(false);
  expect(matchesCorpusMemo(memo, "hash-a", "params-b")).toBe(false);
  expect(matchesCorpusMemo(null, "hash-a", "params-a")).toBe(false);

  // A different directory never sees another directory's memo.
  expect(await readCorpusMemo(prismHome, "/plugins/corpus-b")).toBeNull();
});
