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
import { dirname, join, relative, resolve } from "node:path";
import { copyFile, ensureDir, exists, listDir, removeDir } from "../fs.js";

export const runBackupsDir = (prismHome: string): string => join(prismHome, "backups");

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
