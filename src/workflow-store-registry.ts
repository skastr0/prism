import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Machine-global registry of workflow store locations, kept under
 * `<prismHome>/state/`. Default per-project stores and explicit `--store`
 * paths both register on open at the CLI edge, so cross-store surfaces
 * (`runs list --all`) can enumerate every store this machine has touched
 * without filesystem forensics.
 *
 * Registration is strictly best-effort: a registry failure must never break
 * a workflow run. Entries whose store file no longer exists are dropped on
 * read.
 */
export interface WorkflowStoreRegistryEntry {
  readonly path: string;
  readonly lastOpenedAt: string;
}

interface WorkflowStoreRegistryFile {
  readonly version: 1;
  readonly stores: ReadonlyArray<WorkflowStoreRegistryEntry>;
}

export const workflowStoreRegistryPath = (prismHome: string): string =>
  join(prismHome, "state", "workflow-store-registry.json");

const readRegistryFile = (file: string): ReadonlyArray<WorkflowStoreRegistryEntry> => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<WorkflowStoreRegistryFile>;
    if (!Array.isArray(parsed.stores)) return [];
    return parsed.stores.filter((entry): entry is WorkflowStoreRegistryEntry =>
      typeof entry === "object" && entry !== null &&
      typeof (entry as { path?: unknown }).path === "string" &&
      typeof (entry as { lastOpenedAt?: unknown }).lastOpenedAt === "string"
    );
  } catch {
    return [];
  }
};

const writeRegistryFile = (
  file: string,
  stores: ReadonlyArray<WorkflowStoreRegistryEntry>,
): void => {
  mkdirSync(dirname(file), { recursive: true });
  const next: WorkflowStoreRegistryFile = { version: 1, stores };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
};

export const registerWorkflowStore = (prismHome: string, storePath: string): void => {
  try {
    const file = workflowStoreRegistryPath(prismHome);
    const resolved = resolve(storePath);
    const entries = readRegistryFile(file).filter((entry) => entry.path !== resolved);
    writeRegistryFile(file, [...entries, { path: resolved, lastOpenedAt: new Date().toISOString() }]);
  } catch {
    // best-effort by contract
  }
};

export const listRegisteredWorkflowStores = (prismHome: string): WorkflowStoreRegistryEntry[] => {
  const file = workflowStoreRegistryPath(prismHome);
  const entries = readRegistryFile(file);
  const live = entries.filter((entry) => existsSync(entry.path));
  if (live.length !== entries.length) {
    try {
      writeRegistryFile(file, live);
    } catch {
      // best-effort by contract
    }
  }
  return live.sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
};
