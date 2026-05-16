/**
 * Lockfile format for reproducible compiles.
 *
 * Records:
 * - Root plugin name and version
 * - Resolved dependency graph (cross-plugin refs)
 * - Content hashes of all resolved source files
 */

import { join } from "node:path";
import type { PluginRegistry } from "./registry.js";
import { computeContentHash, computeStableHash } from "./cache.js";
import { normalizeRelativePath } from "./paths.js";
import { exists, readFile, writeFile } from "../fs.js";

export interface LockfileSource {
  readonly path: string;
  readonly contentHash: string;
}

export interface LockfileEntry {
  readonly name: string;
  readonly version: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly dependencies: Record<string, string>;
  readonly sources: ReadonlyArray<LockfileSource>;
}

export interface PrismLock {
  readonly version: 1;
  readonly root: string;
  readonly rootVersion: string;
  readonly generatedAt: string;
  readonly entries: ReadonlyArray<LockfileEntry>;
}

const LOCKFILE_NAME = "prism.lock";

const comparableLockShape = (lock: PrismLock | Omit<PrismLock, "generatedAt">) => ({
  version: lock.version,
  root: lock.root,
  rootVersion: lock.rootVersion,
  entries: lock.entries,
});

const collectRegistries = (root: PluginRegistry): ReadonlyArray<PluginRegistry> => {
  const seen = new Set<string>();
  const ordered: PluginRegistry[] = [];

  const visit = (registry: PluginRegistry): void => {
    if (seen.has(registry.pluginPath)) return;
    seen.add(registry.pluginPath);
    ordered.push(registry);

    for (const dep of [...registry.deps.values()].sort((left, right) =>
      left.pluginPath.localeCompare(right.pluginPath),
    )) {
      visit(dep);
    }
  };

  visit(root);
  return ordered;
};

const collectSourcePaths = (registry: PluginRegistry): ReadonlyArray<string> => {
  const paths = [
    ...registry.identities.values(),
    ...registry.personalities.values(),
    ...registry.toolspaces.values(),
    ...registry.modelspaces.values(),
    ...registry.skillspaces.values(),
    ...registry.skills.values(),
    ...registry.traits.values(),
    ...registry.orbits.values(),
    ...registry.agents.values(),
  ].map((source) => source.sourcePath);

  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
};

export const getLockfilePath = (pluginPath: string): string =>
  join(pluginPath, LOCKFILE_NAME);

export const readLockfile = async (pluginPath: string): Promise<PrismLock | null> => {
  const path = getLockfilePath(pluginPath);
  if (!(await exists(path))) return null;

  try {
    const data = await readFile(path);
    return JSON.parse(data) as PrismLock;
  } catch {
    return null;
  }
};

export const writeLockfile = async (
  pluginPath: string,
  registry: PluginRegistry,
): Promise<string> => {
  const registries = collectRegistries(registry);
  const entries: LockfileEntry[] = [];

  for (const current of registries) {
    const sources = await Promise.all(
      collectSourcePaths(current).map(async (sourcePath) => {
        const content = await readFile(sourcePath);
        return {
          path: normalizeRelativePath(pluginPath, sourcePath),
          contentHash: computeContentHash(content),
        } satisfies LockfileSource;
      }),
    );

    const dependencies = Object.fromEntries(
      [...current.deps.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([depName, depRegistry]) => [
          depName,
          normalizeRelativePath(pluginPath, depRegistry.pluginPath),
        ]),
    );

    entries.push({
      name: current.pluginName,
      version: current.pluginVersion,
      sourcePath: normalizeRelativePath(pluginPath, current.pluginPath),
      contentHash: computeStableHash(sources),
      dependencies,
      sources,
    });
  }

  entries.sort((left, right) => {
    const pathOrder = left.sourcePath.localeCompare(right.sourcePath);
    if (pathOrder !== 0) return pathOrder;
    return left.name.localeCompare(right.name);
  });

  const path = getLockfilePath(pluginPath);
  const comparable = {
    version: 1 as const,
    root: registry.pluginName,
    rootVersion: registry.pluginVersion,
    entries,
  };
  const existing = await readLockfile(pluginPath);

  if (existing) {
    const existingComparable = comparableLockShape(existing);
    if (computeStableHash(existingComparable) === computeStableHash(comparable)) {
      return path;
    }
  }

  const lock: PrismLock = {
    ...comparable,
    generatedAt: new Date().toISOString(),
  };

  await writeFile(path, JSON.stringify(lock, null, 2));
  return path;
};
