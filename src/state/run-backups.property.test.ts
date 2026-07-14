/**
 * Property tests for run-backup retention GC (src/state/run-backups.ts, PQ-159).
 *
 * Covered properties:
 *  - pruneRunBackups keeps exactly the newest `keepRuns` run directories,
 *    oldest pruned first, and never prunes the current (newest) run.
 *  - pruneRunBackups only ever deletes under PRISM_HOME/backups -- a decoy
 *    dir elsewhere on disk (standing in for a harness root) always survives.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { exists } from "../fs.js";
import { backupOnceForRun, pruneRunBackups, runBackupsDir } from "./run-backups.js";

const config = {
  numRuns: 50,
  seed: process.env.FC_SEED ? Number.parseInt(process.env.FC_SEED, 10) : undefined,
};

/** Fixed-width, lexically-ordered id shaped like the real mintRunId format. */
const runIdAt = (index: number): string => {
  const day = String(1 + (index % 28)).padStart(2, "0");
  const month = String(1 + Math.floor(index / 28)).padStart(2, "0");
  return `2020${month}${day}T000000-${String(index).padStart(6, "0")}`;
};

describe("run-backup retention properties (PQ-159)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const freshDir = async (prefix: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  test("keeps exactly keepRuns dirs, oldest pruned first, current run survives", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 1, max: 20 }),
        async (extraRuns, keepRuns) => {
          const home = await freshDir("prism-run-backups-prop-home-");
          const root = await freshDir("prism-run-backups-prop-root-");
          const target = join(root, "f.md");
          await nodeWriteFile(target, "x");

          const totalRuns = keepRuns + extraRuns;
          const runIds = Array.from({ length: totalRuns }, (_, i) => runIdAt(i));
          for (const runId of runIds) {
            await backupOnceForRun({ prismHome: home, runId, root, targetPath: target });
          }

          const removed = await pruneRunBackups(home, keepRuns);
          const remaining = (await readdir(runBackupsDir(home))).sort();

          const sortedRunIds = [...runIds].sort();
          const expectedRemaining = sortedRunIds.slice(-keepRuns);
          const expectedRemoved = sortedRunIds.slice(0, Math.max(0, totalRuns - keepRuns));

          expect(remaining).toHaveLength(Math.min(totalRuns, keepRuns));
          expect(remaining).toEqual(expectedRemaining);
          // Oldest pruned first.
          expect([...removed].sort()).toEqual(expectedRemoved);
          // The current (newest) run is never pruned.
          expect(remaining).toContain(sortedRunIds[sortedRunIds.length - 1]!);
        },
      ),
      config,
    );
  });

  test("only ever deletes under PRISM_HOME/backups -- a decoy dir elsewhere always survives", async () => {
    const home = await freshDir("prism-run-backups-decoy-home-");
    const root = await freshDir("prism-run-backups-decoy-root-");
    const target = join(root, "f.md");
    await nodeWriteFile(target, "x");

    // Decoy standing in for an unrelated dir (e.g. a harness root) that
    // happens to be a sibling of PRISM_HOME/backups -- never itself a run
    // directory, so it must never be touched by pruning.
    const decoyPath = join(home, "not-a-backup", "important.md");
    await mkdir(join(home, "not-a-backup"), { recursive: true });
    await nodeWriteFile(decoyPath, "keep me");

    for (const runId of Array.from({ length: 10 }, (_, i) => runIdAt(i))) {
      await backupOnceForRun({ prismHome: home, runId, root, targetPath: target });
    }
    await pruneRunBackups(home, 2);

    expect(await exists(decoyPath)).toBe(true);
    expect(await readdir(join(home, "not-a-backup"))).toEqual(["important.md"]);
    expect((await readdir(runBackupsDir(home))).sort()).toHaveLength(2);
  });
});
