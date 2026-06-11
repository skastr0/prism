import { BlockedTargetError } from "../errors.js";
import { readSnapshot } from "../state/store.js";
import { withSnapshotLock } from "../state/lock.js";
import type { DesiredRoot } from "./desired.js";
import { applySync, type SyncReport } from "./apply.js";
import { planSync } from "./plan.js";

export const syncDesiredRoot = (options: {
  readonly prismHome: string;
  readonly desired: DesiredRoot;
  readonly scopePlugins?: ReadonlySet<string>;
  readonly dryRun: boolean;
  readonly overwrite?: boolean;
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

  return withSnapshotLock(options.prismHome, async () =>
    applySync({ prismHome: options.prismHome, plan: await plan() }),
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
