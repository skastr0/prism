import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile as nodeWriteFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readFile } from "../fs.js";
import { computeContentHash } from "../content-hash.js";
import {
  emptySnapshotManifest,
  encodeSnapshotManifest,
  type SnapshotManifest,
} from "./snapshot.js";
import { commitSnapshot, gcSnapshots, readSnapshot, snapshotPath } from "./store.js";
import { SnapshotLockHeldError, lockPath, withSnapshotLock } from "./lock.js";
import { backupOnceForRun, pruneRunBackups } from "./run-backups.js";

let home: string;
let root: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "prism-state-home-"));
  root = await mkdtemp(join(tmpdir(), "prism-state-root-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const manifestWith = (entries: SnapshotManifest["entries"]): SnapshotManifest => ({
  ...emptySnapshotManifest({ harness: "codex-cli", root }),
  entries,
});

describe("snapshot store", () => {
  test("read of a missing manifest returns empty", async () => {
    const result = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(result.manifest.entries).toEqual([]);
    expect(result.quarantinedPath).toBeUndefined();
  });

  test("commit then read round-trips and encoding is deterministic and sorted", async () => {
    const manifest = manifestWith([
      { targetPath: join(root, "b.md"), contentHash: "h2", mode: "owned", plugin: "p" },
      { targetPath: join(root, "a.md"), contentHash: "h1", mode: "owned", plugin: "p" },
    ]);
    await commitSnapshot({ prismHome: home, manifest });
    const read = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(read.manifest.entries.map((entry) => entry.targetPath)).toEqual(
      [join(root, "a.md"), join(root, "b.md")],
    );

    // Re-committing the read-back manifest leaves bytes identical (no
    // timestamps, no run ids, stable ordering) — the converged-run gate.
    const path = snapshotPath(home, root);
    const firstBytes = await readFile(path);
    await commitSnapshot({ prismHome: home, manifest: read.manifest });
    expect(await readFile(path)).toBe(firstBytes);
    expect(firstBytes).toBe(encodeSnapshotManifest(read.manifest));
  });

  test("corrupt manifest quarantines and degrades to empty", async () => {
    const path = snapshotPath(home, root);
    await mkdir(join(home, "state", "roots"), { recursive: true });
    await nodeWriteFile(path, "{ not json");
    const result = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(result.manifest.entries).toEqual([]);
    expect(result.quarantinedPath).toContain(".corrupt-");
    expect(await exists(result.quarantinedPath!)).toBe(true);
    expect(await exists(path)).toBe(false);
  });

  test("tmp fence: refuses tempdir roots into a non-tempdir PRISM_HOME", async () => {
    const fakeRealHome = "/Users/nobody/.prism-fence-test";
    await expect(
      commitSnapshot({ prismHome: fakeRealHome, manifest: manifestWith([]) }),
    ).rejects.toThrow(/test-pollution signature/);
  });

  test("gc drops manifests for dead roots and keeps live ones", async () => {
    await commitSnapshot({ prismHome: home, manifest: manifestWith([]) });
    const deadRoot = await mkdtemp(join(tmpdir(), "prism-state-dead-"));
    await commitSnapshot({
      prismHome: home,
      manifest: { ...emptySnapshotManifest({ harness: "hermes", root: deadRoot }), entries: [] },
    });
    await rm(deadRoot, { recursive: true, force: true });

    const result = await gcSnapshots(home);
    expect(result.dropped.map((d) => d.root)).toEqual([deadRoot]);
    expect(await exists(snapshotPath(home, root))).toBe(true);
    expect(await exists(snapshotPath(home, deadRoot))).toBe(false);
  });

  test("gc drops stale entries whose target files are missing from live roots", async () => {
    const staleFile = join(root, "stale.md");
    const liveFile = join(root, "live.md");
    await nodeWriteFile(liveFile, "live");
    await commitSnapshot({
      prismHome: home,
      manifest: manifestWith([
        { targetPath: staleFile, contentHash: "h1", mode: "owned", plugin: "removed-plugin" },
        { targetPath: liveFile, contentHash: "h2", mode: "owned", plugin: "live-plugin" },
      ]),
    });

    const result = await gcSnapshots(home);
    expect(result.droppedEntries).toEqual([
      {
        path: snapshotPath(home, root),
        root,
        harness: "codex-cli",
        targetPath: staleFile,
        plugin: "removed-plugin",
      },
    ]);

    const read = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(read.manifest.entries.map((e) => e.targetPath)).toEqual([liveFile]);
  });

  test("gc drops stale region entries whose marker fence is missing from a live file", async () => {
    const configPath = join(root, "config.toml");
    const marker =
      "# --- prism:removed.hooks begin ---\nmanaged\n# --- prism:removed.hooks end ---";
    await nodeWriteFile(configPath, "[features]\n");
    await commitSnapshot({
      prismHome: home,
      manifest: manifestWith([
        {
          targetPath: configPath,
          contentHash: computeContentHash(marker),
          mode: "region",
          regionKey: "marker # removed.hooks",
          plugin: "removed-plugin",
        },
      ]),
    });

    const result = await gcSnapshots(home);
    expect(result.droppedEntries).toEqual([
      {
        path: snapshotPath(home, root),
        root,
        harness: "codex-cli",
        targetPath: configPath,
        plugin: "removed-plugin",
      },
    ]);

    const read = await readSnapshot({ prismHome: home, harness: "codex-cli", root });
    expect(read.manifest.entries).toEqual([]);
  });
});

describe("snapshot lock", () => {
  test("serializes runs and releases on completion and on throw", async () => {
    const result = await withSnapshotLock(home, async () => "ok");
    expect(result).toBe("ok");
    expect(await exists(lockPath(home))).toBe(false);

    await expect(
      withSnapshotLock(home, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await exists(lockPath(home))).toBe(false);
  });

  test("a live holder blocks; a stale (dead-pid) holder is taken over", async () => {
    await withSnapshotLock(home, async () => {
      await expect(withSnapshotLock(home, async () => "nested")).rejects.toThrow(
        SnapshotLockHeldError,
      );
    });

    // Stale lock: a pid that cannot exist as a live process.
    await mkdir(join(home, "state"), { recursive: true });
    await nodeWriteFile(lockPath(home), `${JSON.stringify({ pid: 99999999 })}\n`);
    expect(await withSnapshotLock(home, async () => "took over")).toBe("took over");
  });
});

describe("run backups", () => {
  test("backs up a target once per run; missing targets are skipped", async () => {
    const target = join(root, "config.toml");
    await nodeWriteFile(target, "original");

    const first = await backupOnceForRun({
      prismHome: home,
      runId: "20260610T0001-aaaa",
      root,
      targetPath: target,
    });
    expect(first).not.toBeNull();
    expect(await readFile(first!)).toBe("original");

    await nodeWriteFile(target, "mutated");
    const second = await backupOnceForRun({
      prismHome: home,
      runId: "20260610T0001-aaaa",
      root,
      targetPath: target,
    });
    expect(second).toBeNull();
    expect(await readFile(first!)).toBe("original");

    expect(
      await backupOnceForRun({
        prismHome: home,
        runId: "20260610T0001-aaaa",
        root,
        targetPath: join(root, "absent.md"),
      }),
    ).toBeNull();
  });

  test("prune keeps the newest runs", async () => {
    const target = join(root, "f.md");
    await nodeWriteFile(target, "x");
    for (const runId of ["20260608T0000-a", "20260609T0000-b", "20260610T0000-c"]) {
      await backupOnceForRun({ prismHome: home, runId, root, targetPath: target });
    }
    const removed = await pruneRunBackups(home, 2);
    expect(removed).toEqual(["20260608T0000-a"]);
  });
});
