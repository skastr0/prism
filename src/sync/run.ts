import { BlockedTargetError } from "../errors.js";
import { readSnapshot } from "../state/store.js";
import { withSnapshotLock } from "../state/lock.js";
import { DEFAULT_KEPT_RUN_BACKUPS, pruneRunBackups } from "../state/run-backups.js";
import type { DesiredRoot } from "./desired.js";
import { applySync, type SyncOpListener, type SyncReport } from "./apply.js";
import { planSync } from "./plan.js";

export const syncDesiredRoot = (options: {
  readonly prismHome: string;
  readonly desired: DesiredRoot;
  readonly scopePlugins?: ReadonlySet<string>;
  readonly dryRun: boolean;
  readonly overwrite?: boolean;
  readonly onOp?: SyncOpListener;
}): Promise<SyncReport> => {
  const plan = async () => {
    const snapshot = await readSnapshot({
      prismHome: options.prismHome,
      harness: options.desired.harness,
      root: options.desired.root,
    });
    return planSync({
      desired: options.desired,
      snapshot: snapshot.manifest,
      degradedOwnership: options.overwrite === true || snapshot.quarantinedPath !== undefined,
      ...(options.scopePlugins ? { scopePlugins: options.scopePlugins } : {}),
    });
  };

  if (options.dryRun) {
    return plan().then((planned) =>
      applySync({ prismHome: options.prismHome, plan: planned, dryRun: true }),
    );
  }

  // PQ-159: GC run-backup retention here -- the single choke point every
  // real (non-dry-run) apply funnels through, whether reached via
  // refreshPlugin (file-router) or compile/pipeline.ts (compile-phase
  // writes) -- so `<PRISM_HOME>/backups` (otherwise write-only, growing
  // forever: 426 dirs / 14M observed) gets reaped on every real apply
  // regardless of caller. Runs before the per-root snapshot lock below so a
  // global sweep never holds an unrelated root's lock. `pruneRunBackups`
  // never removes the run this apply is about to write into (its dir does
  // not exist yet), so this ordering cannot delete data this call needs.
  return pruneRunBackups(options.prismHome, DEFAULT_KEPT_RUN_BACKUPS).then(() =>
    withSnapshotLock(options.prismHome, async () =>
      applySync({
        prismHome: options.prismHome,
        plan: await plan(),
        ...(options.onOp ? { onOp: options.onOp } : {}),
      }),
    ),
  );
};

export const blockedTargetErrors = (report: SyncReport): BlockedTargetError[] =>
  report.blocked.map(
    (op) =>
      new BlockedTargetError({
        targetPath: op.targetPath,
        plugin: op.plugin,
        hint: op.hint,
      }),
  );
