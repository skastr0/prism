import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../fs.js";
import { encodeSnapshotManifest } from "../state/snapshot.js";
import { commitSnapshot, snapshotPath } from "../state/store.js";
import { planDeleteOwnedFile, planUninstallPlugin } from "./mutations.js";

const tempRoot = async (prefix: string): Promise<string> => {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), prefix));
};

describe("configure mutations", () => {
  test("uninstall plugin prunes owned files for that plugin only", async () => {
    const root = await tempRoot("prism-configure-un-");
    const prismHome = join(root, "prism-home");
    const claudeRoot = join(root, "claude");
    const keepPath = join(claudeRoot, "skills", "keep", "SKILL.md");
    const dropPath = join(claudeRoot, "skills", "drop", "SKILL.md");
    await mkdir(join(claudeRoot, "skills", "keep"), { recursive: true });
    await mkdir(join(claudeRoot, "skills", "drop"), { recursive: true });
    await writeFile(keepPath, "keep\n");
    await writeFile(dropPath, "drop\n");

    await commitSnapshot({
      prismHome,
      manifest: {
        version: 1,
        harness: "claude-code",
        root: claudeRoot,
        entries: [
          {
            targetPath: keepPath,
            contentHash: "k",
            mode: "owned",
            plugin: "keeper",
          },
          {
            targetPath: dropPath,
            contentHash: "d",
            mode: "owned",
            plugin: "goner",
          },
        ],
      },
    });

    const dry = await planUninstallPlugin({
      pluginName: "goner",
      prismHome,
      dryRun: true,
    });
    expect(dry.plan.ops.some((op) => op.kind === "prune" && op.targetPath === dropPath)).toBe(
      true,
    );
    expect(dry.plan.ops.some((op) => op.targetPath === keepPath && op.kind === "prune")).toBe(
      false,
    );

    const applied = await planUninstallPlugin({
      pluginName: "goner",
      prismHome,
      dryRun: false,
    });
    expect(applied.failures).toEqual([]);
    expect(await exists(dropPath)).toBe(false);
    expect(await exists(keepPath)).toBe(true);
    expect(await readFile(keepPath, "utf8")).toBe("keep\n");
  });

  test("delete owned file keeps sibling owned files for same plugin", async () => {
    const root = await tempRoot("prism-configure-del-");
    const prismHome = join(root, "prism-home");
    const claudeRoot = join(root, "claude");
    const a = join(claudeRoot, "skills", "a", "SKILL.md");
    const b = join(claudeRoot, "skills", "b", "SKILL.md");
    await mkdir(join(claudeRoot, "skills", "a"), { recursive: true });
    await mkdir(join(claudeRoot, "skills", "b"), { recursive: true });
    await writeFile(a, "a\n");
    await writeFile(b, "b\n");

    await commitSnapshot({
      prismHome,
      manifest: {
        version: 1,
        harness: "claude-code",
        root: claudeRoot,
        entries: [
          { targetPath: a, contentHash: "a", mode: "owned", plugin: "pack" },
          { targetPath: b, contentHash: "b", mode: "owned", plugin: "pack" },
        ],
      },
    });

    const result = await planDeleteOwnedFile({
      targetPath: a,
      prismHome,
      dryRun: false,
    });
    expect(result.failures).toEqual([]);
    expect(result.plan.blocked).toEqual([]);
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(true);
  });

  test("delete refuses non-owned paths", async () => {
    const root = await tempRoot("prism-configure-refuse-");
    const prismHome = join(root, "prism-home");
    await mkdir(join(prismHome, "state", "roots"), { recursive: true });
    // empty world
    const result = await planDeleteOwnedFile({
      targetPath: join(root, "nope.md"),
      prismHome,
      dryRun: true,
    });
    expect(result.plan.blocked.length).toBeGreaterThan(0);
    expect(result.applied).toBe(false);
  });
});
