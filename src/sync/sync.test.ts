import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile as nodeWriteFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readFile } from "../fs.js";
import { readSnapshot, snapshotPath } from "../state/store.js";
import type { DesiredRoot } from "./desired.js";
import { planSync } from "./plan.js";
import { applySync } from "./apply.js";

let home: string;
let root: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "prism-sync-home-"));
  root = await mkdtemp(join(tmpdir(), "prism-sync-root-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const desiredWith = (overrides: Partial<DesiredRoot>): DesiredRoot => ({
  harness: "codex-cli",
  root,
  files: [],
  regions: [],
  ...overrides,
});

const refresh = async (desired: DesiredRoot, options: { degraded?: boolean } = {}) => {
  const snapshot = await readSnapshot({ prismHome: home, harness: desired.harness, root });
  const plan = await planSync({
    desired,
    snapshot: snapshot.manifest,
    degradedOwnership: options.degraded ?? snapshot.quarantinedPath !== undefined,
  });
  return applySync({ prismHome: home, plan });
};

const kinds = (report: Awaited<ReturnType<typeof refresh>>): string[] =>
  report.ops.map((op) => op.kind).sort();

describe("sync engine — owned files", () => {
  const skillPath = () => join(root, "skills", "demo", "SKILL.md");
  const desired = (content: string) =>
    desiredWith({ files: [{ targetPath: skillPath(), content, plugin: "demo" }] });

  test("create, then converged no-op with byte-identical manifest", async () => {
    const first = await refresh(desired("v1\n"));
    expect(kinds(first)).toEqual(["create"]);
    expect(first.failures).toEqual([]);
    expect(await readFile(skillPath())).toBe("v1\n");

    const manifestBytes = await readFile(snapshotPath(home, root));
    const second = await refresh(desired("v1\n"));
    expect(kinds(second)).toEqual(["skip"]);
    expect(second.converged).toBe(true);
    expect(second.backups).toEqual([]);
    expect(await readFile(snapshotPath(home, root))).toBe(manifestBytes);
  });

  test("source change repairs without backup; user drift repairs with backup", async () => {
    await refresh(desired("v1\n"));

    const sourceChanged = await refresh(desired("v2\n"));
    const repair = sourceChanged.ops.find((op) => op.kind === "repair");
    expect(repair).toMatchObject({ reason: "source-changed", backup: false });
    expect(sourceChanged.backups).toEqual([]);

    await nodeWriteFile(skillPath(), "user edit\n");
    const drifted = await refresh(desired("v2\n"));
    expect(drifted.ops.find((op) => op.kind === "repair")).toMatchObject({
      reason: "drifted",
      backup: true,
    });
    expect(drifted.backups).toHaveLength(1);
    expect(await readFile(drifted.backups[0]!)).toBe("user edit\n");
    expect(await readFile(skillPath())).toBe("v2\n");
  });

  test("skip-before-blocked: bytes equal but never managed converges silently", async () => {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await nodeWriteFile(skillPath(), "v1\n");
    const report = await refresh(desired("v1\n"));
    expect(kinds(report)).toEqual(["skip"]);
    expect(report.blocked).toEqual([]);
  });

  test("blocked: foreign differing file at first placement; withheld from manifest; rest proceeds", async () => {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await nodeWriteFile(skillPath(), "foreign content\n");
    const other = join(root, "skills", "other", "SKILL.md");
    const report = await refresh(
      desiredWith({
        files: [
          { targetPath: skillPath(), content: "v1\n", plugin: "demo" },
          { targetPath: other, content: "other\n", plugin: "other" },
        ],
      }),
    );
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0]!.hint).toContain("delete or move");
    expect(await readFile(skillPath())).toBe("foreign content\n");
    expect(await readFile(other)).toBe("other\n");

    const snapshot = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(snapshot.manifest.entries.map((entry) => entry.targetPath)).toEqual([other]);
  });

  test("degraded ownership (quarantined snapshot) converges foreign files with backup", async () => {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await nodeWriteFile(skillPath(), "foreign content\n");
    const report = await refresh(desired("v1\n"), { degraded: true });
    expect(report.blocked).toEqual([]);
    expect(report.ops.find((op) => op.kind === "repair")).toMatchObject({ reason: "drifted" });
    expect(await readFile(skillPath())).toBe("v1\n");
    expect(report.backups).toHaveLength(1);
  });

  test("prune on removal; drifted orphans get a backup", async () => {
    await refresh(desired("v1\n"));
    const pruned = await refresh(desiredWith({ files: [] }));
    expect(kinds(pruned)).toEqual(["prune"]);
    expect(await exists(skillPath())).toBe(false);

    await refresh(desired("v1\n"));
    await nodeWriteFile(skillPath(), "user touched\n");
    const prunedDrifted = await refresh(desiredWith({ files: [] }));
    expect(prunedDrifted.backups).toHaveLength(1);
    expect(await readFile(prunedDrifted.backups[0]!)).toBe("user touched\n");
  });

  test("crash convergence: deleting the manifest re-converges without errors", async () => {
    await refresh(desired("v1\n"));
    await rm(snapshotPath(home, root));
    const report = await refresh(desired("v1\n"));
    expect(kinds(report)).toEqual(["skip"]);
    expect(report.blocked).toEqual([]);
  });

  test("a directory at a file target classifies as blocked; other ops land", async () => {
    await mkdir(skillPath(), { recursive: true });
    const other = join(root, "ok.md");
    const report = await refresh(
      desiredWith({
        files: [
          { targetPath: skillPath(), content: "v1\n", plugin: "demo" },
          { targetPath: other, content: "ok\n", plugin: "demo" },
        ],
      }),
    );
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0]!.hint).toContain("not a readable file");
    expect(report.failures).toEqual([]);
    expect(await readFile(other)).toBe("ok\n");
    const snapshot = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(snapshot.manifest.entries.map((entry) => entry.targetPath)).toEqual([other]);
  });
});

describe("sync engine — prune scoping", () => {
  test("a single-plugin compile cannot prune another plugin's outputs", async () => {
    const a = join(root, "skills", "a", "SKILL.md");
    const b = join(root, "skills", "b", "SKILL.md");
    await refresh(desiredWith({
      files: [
        { targetPath: a, content: "a\n", plugin: "plugin-a" },
        { targetPath: b, content: "b\n", plugin: "plugin-b" },
      ],
    }));

    // Recompile ONLY plugin-a with plugin-b's file absent from desired state.
    const snapshot = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    const plan = await planSync({
      desired: desiredWith({ files: [{ targetPath: a, content: "a\n", plugin: "plugin-a" }] }),
      snapshot: snapshot.manifest,
      scopePlugins: new Set(["plugin-a"]),
    });
    const report = await applySync({ prismHome: home, plan });

    expect(report.ops.some((op) => op.kind === "prune")).toBe(false);
    expect(await exists(b)).toBe(true);
    const after = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(after.manifest.entries.map((entry) => entry.targetPath).sort()).toEqual([a, b].sort());

    // An unscoped (whole-world) plan with the same desired state DOES prune b.
    const worldPlan = await planSync({
      desired: desiredWith({ files: [{ targetPath: a, content: "a\n", plugin: "plugin-a" }] }),
      snapshot: after.manifest,
    });
    const worldReport = await applySync({ prismHome: home, plan: worldPlan });
    expect(worldReport.ops.some((op) => op.kind === "prune")).toBe(true);
    expect(await exists(b)).toBe(false);
  });
});

describe("sync engine — shared-file regions", () => {
  const configPath = () => join(root, "config.toml");
  const userContent = [
    "# my hand-written config",
    "",
    "[projects.x]",
    "last_updated = \"2026-01-01\"  # trailing comment",
    "",
  ].join("\n");

  const markerRegion = (content: string) =>
    desiredWith({
      regions: [{
        kind: "marker" as const,
        targetPath: configPath(),
        regionKey: "codex-cli:session-watch",
        commentPrefix: "#",
        content,
        plugin: "session-watch",
      }],
    });

  test("marker region appends once, preserves user bytes, converges, and removes on orphan", async () => {
    await nodeWriteFile(configPath(), userContent);

    const first = await refresh(markerRegion("[[hooks.Stop]]\ncommand = \"x\""));
    expect(kinds(first)).toEqual(["patch-regions"]);
    const after = await readFile(configPath());
    expect(after).toContain(userContent.trimEnd());
    expect(after).toContain("# --- prism:codex-cli:session-watch begin ---");

    const second = await refresh(markerRegion("[[hooks.Stop]]\ncommand = \"x\""));
    expect(kinds(second)).toEqual(["skip-regions"]);
    expect(second.converged).toBe(true);
    expect(await readFile(configPath())).toBe(after);

    const updated = await refresh(markerRegion("[[hooks.Stop]]\ncommand = \"y\""));
    expect(kinds(updated)).toEqual(["patch-regions"]);
    expect(await readFile(configPath())).toContain('command = "y"');

    const removed = await refresh(desiredWith({}));
    expect(kinds(removed)).toEqual(["patch-regions"]);
    const final = await readFile(configPath());
    expect(final).not.toContain("prism:codex-cli:session-watch");
    expect(final).toContain("# my hand-written config");
    expect(final).toContain("trailing comment");
  });

  test("json-key region preserves comments and foreign keys in JSONC", async () => {
    const mcpJson = join(root, "mcp.json");
    await nodeWriteFile(mcpJson, [
      "{",
      "  // user comment survives",
      "  \"mcpServers\": {",
      "    \"user-thing\": { \"command\": \"mine\" }",
      "  }",
      "}",
      "",
    ].join("\n"));

    const desired = desiredWith({
      regions: [{
        kind: "json-key" as const,
        targetPath: mcpJson,
        regionKey: "mcpServers.prism-generated-demo",
        jsonPath: ["mcpServers", "prism-generated-demo"],
        value: { command: "bun", args: ["/x/server.mjs"] },
        plugin: "demo",
      }],
    });

    const first = await refresh(desired);
    expect(kinds(first)).toEqual(["patch-regions"]);
    const after = await readFile(mcpJson);
    expect(after).toContain("// user comment survives");
    expect(after).toContain("user-thing");
    expect(after).toContain("prism-generated-demo");

    const second = await refresh(desired);
    expect(second.converged).toBe(true);

    const removed = await refresh(desiredWith({}));
    expect(kinds(removed)).toEqual(["patch-regions"]);
    const final = await readFile(mcpJson);
    expect(final).not.toContain("prism-generated-demo");
    expect(final).toContain("user-thing");
    expect(final).toContain("// user comment survives");
  });
});
