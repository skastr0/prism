/**
 * Sync apply — THE single harness-root writer. Nothing else in Prism mutates
 * harness roots (CI gate enforces exactly one importer of these primitives).
 *
 * Discipline:
 *  - every write is atomic temp-sibling + rename (fs.ts),
 *  - one backup per target per run, taken before the first mutation,
 *  - per-op failures are collected, never thrown — one bad target cannot
 *    abort the batch (the legacy lowering executor's failure mode),
 *  - the snapshot manifest commits LAST, once, after all ops; a crash at any
 *    point converges on re-run (skip-before-blocked reclassifies pre-crash
 *    writes as skips).
 */

import { readdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chmodFile, removeFile, writeFile } from "../fs.js";
import { backupOnceForRun } from "../state/run-backups.js";
import { commitSnapshot } from "../state/store.js";
import type { SnapshotManifest } from "../state/snapshot.js";
import type { SyncPlan, SyncOp } from "./plan.js";

export interface SyncOpFailure {
  readonly op: SyncOp;
  readonly message: string;
}

export interface SyncReport {
  readonly harness: string;
  readonly root: string;
  readonly ops: ReadonlyArray<SyncOp>;
  readonly failures: ReadonlyArray<SyncOpFailure>;
  readonly backups: ReadonlyArray<string>;
  readonly blocked: ReadonlyArray<Extract<SyncOp, { kind: "blocked" }>>;
  /** True when the run wrote nothing: every op was a skip (or no ops). */
  readonly converged: boolean;
}

/**
 * After pruning a file, sweep now-empty parent directories up to (never
 * including) the harness root, so uninstalling a plugin leaves no skeleton
 * directory trees behind.
 */
const removeEmptyParentDirs = async (targetPath: string, root: string): Promise<void> => {
  const boundary = resolve(root);
  let current = dirname(resolve(targetPath));
  while (current !== boundary && current.startsWith(`${boundary}/`)) {
    try {
      if ((await readdir(current)).length > 0) return;
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
};

export const mintRunId = (now: Date = new Date()): string =>
  `${now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const executeOp = async (
  op: SyncOp,
  context: { readonly prismHome: string; readonly runId: string; readonly root: string },
  backups: string[],
): Promise<void> => {
  const backup = async (wanted: boolean, targetPath: string): Promise<void> => {
    if (!wanted) return;
    const path = await backupOnceForRun({
      prismHome: context.prismHome,
      runId: context.runId,
      root: context.root,
      targetPath,
    });
    if (path) backups.push(path);
  };

  switch (op.kind) {
    case "create":
      await writeFile(op.targetPath, op.content, op.mode === undefined ? {} : { mode: op.mode });
      return;
    case "repair":
      await backup(op.backup, op.targetPath);
      await writeFile(op.targetPath, op.content, op.mode === undefined ? {} : { mode: op.mode });
      return;
    case "patch-regions":
      await backup(op.backup, op.targetPath);
      await writeFile(op.targetPath, op.content);
      return;
    case "prune":
      await backup(op.backup, op.targetPath);
      await removeFile(op.targetPath);
      await removeEmptyParentDirs(op.targetPath, context.root);
      return;
    case "chmod":
      await chmodFile(op.targetPath, op.mode);
      return;
    case "skip":
    case "skip-regions":
    case "blocked":
      return;
  }
};

export const applySync = async (options: {
  readonly prismHome: string;
  readonly plan: SyncPlan;
  readonly dryRun?: boolean;
  readonly runId?: string;
}): Promise<SyncReport> => {
  const { plan } = options;
  const blocked = plan.ops.filter(
    (op): op is Extract<SyncOp, { kind: "blocked" }> => op.kind === "blocked",
  );
  const baseReport = {
    harness: plan.harness,
    root: plan.root,
    ops: plan.ops,
    blocked,
    converged: plan.ops.every((op) => op.kind === "skip" || op.kind === "skip-regions"),
  };

  if (options.dryRun) return { ...baseReport, failures: [], backups: [] };

  const runId = options.runId ?? mintRunId();
  const failures: SyncOpFailure[] = [];
  const backups: string[] = [];
  const context = { prismHome: options.prismHome, runId, root: plan.root };

  const succeededPaths = new Set<string>();
  for (const op of [...plan.ops].sort((a, b) => a.targetPath.localeCompare(b.targetPath))) {
    try {
      await executeOp(op, context, backups);
      succeededPaths.add(op.targetPath);
    } catch (error) {
      failures.push({ op, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // Commit-last. Entries for failed or blocked targets are withheld so the
  // next plan re-examines them from disk truth rather than trusting hashes
  // that never landed.
  const failedPaths = new Set([
    ...failures.map((failure) => failure.op.targetPath),
    ...blocked.map((op) => op.targetPath),
  ]);
  const manifest: SnapshotManifest = {
    version: 1,
    harness: plan.harness,
    root: plan.root,
    entries: [
      ...plan.carriedEntries,
      ...plan.nextEntries.filter((entry) => !failedPaths.has(entry.targetPath)),
    ],
  };
  await commitSnapshot({ prismHome: options.prismHome, manifest });

  return { ...baseReport, failures, backups };
};
