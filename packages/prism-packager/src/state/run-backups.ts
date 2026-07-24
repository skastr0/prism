/**
 * Per-run backups — `<PRISM_HOME>/backups/<runId>/<rootKey>/<relative-path>`.
 *
 * One backup per target per run, enforced by path identity: the backup path
 * is a pure function of (runId, root, targetPath), so repeated repairs of the
 * same target within a run keep the first (pre-run) bytes. This replaces the
 * per-event backup dirs that burned retention on shared configs (three
 * backups of one file in 535ms).
 *
 * Retention is by run: callers prune whole run directories, oldest first.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { copyFile, ensureDir, exists, listDir, listDirRecursive, removeDir } from "../fs.js";

export const runBackupsDir = (prismHome: string): string => join(prismHome, "backups");

/**
 * PQ-159: how many run-backup directories `pruneRunBackups` keeps by
 * default when wired into the production apply path. `<PRISM_HOME>/backups`
 * is write-only storage (one dir per real refresh run) with no restore API
 * (a backup dir is copied from by hand); left unbounded it grows forever
 * (426 dirs / 14M observed on 2026-07-03). 20 keeps a generous recent
 * window for manual recovery without the tree growing without bound.
 */
export const DEFAULT_KEPT_RUN_BACKUPS = 20;

const rootKey = (root: string): string =>
  createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);

const backupRelativePath = (root: string, targetPath: string): string => {
  const rel = relative(resolve(root), resolve(targetPath));
  return rel.startsWith("..")
    ? createHash("sha256").update(resolve(targetPath)).digest("hex").slice(0, 16)
    : rel;
};

export const backupPathFor = (options: {
  readonly prismHome: string;
  readonly runId: string;
  readonly root: string;
  readonly targetPath: string;
}): string =>
  join(
    runBackupsDir(options.prismHome),
    options.runId,
    rootKey(options.root),
    backupRelativePath(options.root, options.targetPath),
  );

/**
 * Copy the target's current bytes into the run's backup tree. Returns the
 * backup path, or null when the target does not exist or this run already
 * backed it up (first bytes win).
 */
export const backupOnceForRun = async (options: {
  readonly prismHome: string;
  readonly runId: string;
  readonly root: string;
  readonly targetPath: string;
}): Promise<string | null> => {
  if (!(await exists(options.targetPath))) return null;
  const backupPath = backupPathFor(options);
  if (await exists(backupPath)) return null;
  await ensureDir(dirname(backupPath));
  await copyFile(options.targetPath, backupPath);
  return backupPath;
};

/** Keep the newest `keepRuns` run directories; remove the rest. */
export const pruneRunBackups = async (
  prismHome: string,
  keepRuns: number,
): Promise<ReadonlyArray<string>> => {
  const dir = runBackupsDir(prismHome);
  if (!(await exists(dir))) return [];
  const runs = (await listDir(dir)).sort();
  const excess = runs.slice(0, Math.max(0, runs.length - keepRuns));
  for (const run of excess) await removeDir(join(dir, run));
  return excess;
};

const RUN_ID_TIMESTAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-/;

/** Recover the wall-clock moment `mintRunId` embedded in a run id, if parseable. */
const parseRunTimestamp = (runId: string): Date | undefined => {
  const match = runId.match(RUN_ID_TIMESTAMP);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export interface RunBackupsSummary {
  readonly count: number;
  readonly totalBytes: number;
  readonly oldestRunId?: string;
  readonly oldestAgeMs?: number;
}

/**
 * PQ-159: read-only visibility into `<PRISM_HOME>/backups` for doctor --
 * never prunes. Age is derived from the run id's own embedded timestamp
 * (deterministic, filesystem-independent) rather than directory mtime.
 */
export const runBackupsSummary = async (
  prismHome: string,
  now: Date = new Date(),
): Promise<RunBackupsSummary> => {
  const dir = runBackupsDir(prismHome);
  if (!(await exists(dir))) return { count: 0, totalBytes: 0 };
  const runs = (await listDir(dir)).sort();
  if (runs.length === 0) return { count: 0, totalBytes: 0 };

  let totalBytes = 0;
  for (const run of runs) {
    const runDir = join(dir, run);
    for (const relativePath of await listDirRecursive(runDir)) {
      totalBytes += (await stat(join(runDir, relativePath))).size;
    }
  }

  const oldestRunId = runs[0]!;
  const oldestDate = parseRunTimestamp(oldestRunId);
  return {
    count: runs.length,
    totalBytes,
    oldestRunId,
    ...(oldestDate ? { oldestAgeMs: Math.max(0, now.getTime() - oldestDate.getTime()) } : {}),
  };
};
