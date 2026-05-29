import { createHash } from "node:crypto";
import { cp, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { exists } from "./fs.js";
import {
  prismBackupDir,
  readPrismConfig,
  resolvePrismHome,
  type PrismConfig,
} from "./prism-home.js";
import type { HarnessId, HarnessScope } from "./types.js";

export interface ManagedBackupOptions {
  readonly harness: HarnessId;
  readonly scope: HarnessScope;
  readonly targetPath: string;
  readonly operation: "write" | "prune" | "patch";
  readonly prismHome?: string;
  readonly config?: PrismConfig;
  readonly now?: Date;
}

const safeSegment = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
};

const targetKey = (targetPath: string): string => {
  const digest = createHash("sha256").update(targetPath).digest("hex").slice(0, 16);
  return `${digest}--${safeSegment(basename(targetPath), "target")}`;
};

const timestampSegment = (date: Date): string =>
  date.toISOString().replace(/[-:]/g, "").replace(".", "").replace("Z", "Z");

export const managedBackupTargetRoot = (options: {
  readonly harness: HarnessId;
  readonly scope: HarnessScope;
  readonly targetPath: string;
  readonly prismHome?: string;
}): string =>
  join(
    prismBackupDir(options.prismHome ?? resolvePrismHome()),
    options.harness,
    options.scope,
    targetKey(options.targetPath),
  );

const pruneOldBackups = async (
  root: string,
  retentionPerTarget: number,
): Promise<void> => {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }

  const stale = entries
    .filter((entry) => entry.length > 0)
    .sort((left, right) => right.localeCompare(left))
    .slice(retentionPerTarget);

  for (const entry of stale) {
    await rm(join(root, entry), { recursive: true, force: true });
  }
};

export const backupManagedTarget = async (
  options: ManagedBackupOptions,
): Promise<string | null> => {
  if (!(await exists(options.targetPath))) return null;

  const prismHome = options.prismHome ?? resolvePrismHome();
  const config = options.config ?? (await readPrismConfig(prismHome));
  if (config.backup.mode === "never") return null;

  const backupRoot = managedBackupTargetRoot({
    harness: options.harness,
    scope: options.scope,
    targetPath: options.targetPath,
    prismHome,
  });
  const eventDir = join(
    backupRoot,
    `${timestampSegment(options.now ?? new Date())}-${options.operation}`,
  );
  const targetName = safeSegment(basename(options.targetPath), "target");
  const backupPath = join(eventDir, targetName);

  const targetStat = await stat(options.targetPath);
  await cp(options.targetPath, backupPath, {
    recursive: targetStat.isDirectory(),
    force: true,
    preserveTimestamps: true,
  });
  await pruneOldBackups(backupRoot, config.backup.retentionPerTarget);
  return backupPath;
};
