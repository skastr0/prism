/**
 * Sync plan — pure classification of desired state against disk + snapshot.
 *
 * Plan verbs (each op carries a reason the CLI renders):
 *  - create        target absent on disk                          (new)
 *  - repair        bytes differ from desired                      (source-changed | drifted)
 *  - skip          bytes equal desired                            —
 *  - chmod         bytes equal, mode differs                      —
 *  - patch-regions one coalesced write per shared file            (region keys listed)
 *  - prune         in snapshot, no longer desired                 (orphaned)
 *  - blocked       foreign file at a first-time placement         (typed hint, no adopt)
 *
 * Named invariant — skip-before-blocked: byte-equality with desired content
 * classifies as `skip` BEFORE `blocked` is evaluated, so files written by a
 * crashed run (on disk, not yet in the snapshot) converge silently on the
 * next run. `blocked` fires only when bytes differ AND the path was never
 * managed. When the snapshot was quarantined as corrupt, ownership degrades
 * to desired-state membership and would-be `blocked` ops become `repair`
 * with backup — a corrupt manifest must degrade to repairs, never errors.
 */

import { stat } from "node:fs/promises";
import { computeContentHash } from "../content-hash.js";
import { exists, readFile } from "../fs.js";
import type { SnapshotEntry, SnapshotManifest } from "../state/snapshot.js";
import type { DesiredFile, DesiredRegion, DesiredRoot } from "./desired.js";
import { applyRegion, removeJsonKeyRegion, removeMarkerRegion, renderMarkerRegion } from "./regions.js";

export type SyncOp =
  | { readonly kind: "create"; readonly targetPath: string; readonly content: string; readonly mode?: number; readonly plugin: string; readonly reason: "new" }
  | { readonly kind: "repair"; readonly targetPath: string; readonly content: string; readonly mode?: number; readonly plugin: string; readonly reason: "source-changed" | "drifted"; readonly backup: boolean }
  | { readonly kind: "skip"; readonly targetPath: string; readonly plugin: string }
  | { readonly kind: "chmod"; readonly targetPath: string; readonly mode: number; readonly plugin: string }
  | { readonly kind: "patch-regions"; readonly targetPath: string; readonly content: string; readonly changedRegions: ReadonlyArray<string>; readonly removedRegions: ReadonlyArray<string>; readonly backup: boolean; readonly create: boolean }
  | { readonly kind: "skip-regions"; readonly targetPath: string; readonly regionKeys: ReadonlyArray<string> }
  | { readonly kind: "prune"; readonly targetPath: string; readonly reason: "orphaned"; readonly backup: boolean }
  | { readonly kind: "blocked"; readonly targetPath: string; readonly plugin: string; readonly hint: string };

export interface SyncPlan {
  readonly harness: string;
  readonly root: string;
  readonly ops: ReadonlyArray<SyncOp>;
  /** Snapshot entries describing the post-apply desired world (in scope). */
  readonly nextEntries: ReadonlyArray<SnapshotEntry>;
  /** Out-of-scope entries carried into the next manifest untouched. */
  readonly carriedEntries: ReadonlyArray<SnapshotEntry>;
  readonly degradedOwnership: boolean;
}

/**
 * Region refs are serialized into the snapshot's `regionKey` so orphaned
 * regions can be removed without re-deriving lowerer knowledge.
 */
export const serializeRegionRef = (region: DesiredRegion): string =>
  region.kind === "marker"
    ? `marker ${region.commentPrefix} ${region.regionKey}`
    : `json ${region.regionKey} ${JSON.stringify(region.jsonPath)}`;

export const parseRegionRef = (
  ref: string,
):
  | { readonly kind: "marker"; readonly commentPrefix: string; readonly regionKey: string }
  | { readonly kind: "json"; readonly regionKey: string; readonly jsonPath: ReadonlyArray<string | number> }
  | undefined => {
  const marker = ref.match(/^marker (\S+) (.+)$/);
  if (marker) return { kind: "marker", commentPrefix: marker[1]!, regionKey: marker[2]! };
  const json = ref.match(/^json (\S+) (\[.*\])$/);
  if (json) {
    try {
      return {
        kind: "json",
        regionKey: json[1]!,
        jsonPath: JSON.parse(json[2]!) as ReadonlyArray<string | number>,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const fileModeOf = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
};

const regionContentHash = (region: DesiredRegion): string =>
  computeContentHash(
    region.kind === "marker" ? renderMarkerRegion(region) : JSON.stringify(region.value),
  );

const planOwnedFile = async (options: {
  readonly desired: DesiredFile;
  readonly snapshotEntry: SnapshotEntry | undefined;
  readonly degradedOwnership: boolean;
}): Promise<SyncOp[]> => {
  const { desired, snapshotEntry, degradedOwnership } = options;
  const desiredHash = computeContentHash(desired.content);

  if (!(await exists(desired.targetPath))) {
    return [{ kind: "create", targetPath: desired.targetPath, content: desired.content, mode: desired.mode, plugin: desired.plugin, reason: "new" }];
  }

  let diskContent: string;
  try {
    diskContent = await readFile(desired.targetPath);
  } catch {
    // A directory (or unreadable object) where Prism wants a file is foreign
    // by definition — classify, don't throw; the rest of the plan proceeds.
    return [{
      kind: "blocked",
      targetPath: desired.targetPath,
      plugin: desired.plugin,
      hint: "the target exists but is not a readable file (directory or permission problem) — delete or move it, then refresh",
    }];
  }
  const diskHash = computeContentHash(diskContent);

  // Invariant: skip-before-blocked.
  if (diskHash === desiredHash) {
    const ops: SyncOp[] = [{ kind: "skip", targetPath: desired.targetPath, plugin: desired.plugin }];
    if (desired.mode !== undefined && (await fileModeOf(desired.targetPath)) !== desired.mode) {
      ops.push({ kind: "chmod", targetPath: desired.targetPath, mode: desired.mode, plugin: desired.plugin });
    }
    return ops;
  }

  if (snapshotEntry) {
    const drifted = snapshotEntry.contentHash !== diskHash;
    return [{
      kind: "repair",
      targetPath: desired.targetPath,
      content: desired.content,
      mode: desired.mode,
      plugin: desired.plugin,
      reason: drifted ? "drifted" : "source-changed",
      backup: drifted,
    }];
  }

  if (degradedOwnership) {
    return [{ kind: "repair", targetPath: desired.targetPath, content: desired.content, mode: desired.mode, plugin: desired.plugin, reason: "drifted", backup: true }];
  }

  return [{
    kind: "blocked",
    targetPath: desired.targetPath,
    plugin: desired.plugin,
    hint: "a file Prism has never managed already exists here with different content — delete or move it, then refresh",
  }];
};

const planSharedFileRegions = async (options: {
  readonly targetPath: string;
  readonly desired: ReadonlyArray<DesiredRegion>;
  readonly orphanedRefs: ReadonlyArray<string>;
  readonly snapshotByRegion: ReadonlyMap<string, SnapshotEntry>;
}): Promise<SyncOp[]> => {
  const fileExists = await exists(options.targetPath);
  const original = fileExists ? await readFile(options.targetPath) : "";

  let content = original;
  const changedRegions: string[] = [];
  const skippedRegions: string[] = [];

  for (const region of options.desired) {
    const outcome = applyRegion(content, region);
    if (outcome.changed) changedRegions.push(region.regionKey);
    else skippedRegions.push(region.regionKey);
    content = outcome.content;
  }

  const removedRegions: string[] = [];
  for (const ref of options.orphanedRefs) {
    const parsed = parseRegionRef(ref);
    if (!parsed) continue;
    const outcome =
      parsed.kind === "marker"
        ? removeMarkerRegion(content, parsed)
        : removeJsonKeyRegion(content, parsed.jsonPath);
    if (outcome.changed) removedRegions.push(parsed.regionKey);
    content = outcome.content;
  }

  if (content === original) {
    return skippedRegions.length > 0
      ? [{ kind: "skip-regions", targetPath: options.targetPath, regionKeys: skippedRegions }]
      : [];
  }

  return [{
    kind: "patch-regions",
    targetPath: options.targetPath,
    content,
    changedRegions,
    removedRegions,
    backup: fileExists,
    create: !fileExists,
  }];
};

export const planSync = async (options: {
  readonly desired: DesiredRoot;
  readonly snapshot: SnapshotManifest;
  readonly degradedOwnership?: boolean;
  /**
   * Prune scope: when set, only snapshot entries attributed to these plugins
   * are eligible for pruning/region-removal; entries owned by out-of-scope
   * plugins are carried into the next manifest untouched. A whole-corpus
   * refresh omits this (full-world prune semantics); a single-plugin compile
   * passes that plugin so it cannot prune its neighbors' outputs.
   */
  readonly scopePlugins?: ReadonlySet<string>;
}): Promise<SyncPlan> => {
  const degradedOwnership = options.degradedOwnership ?? false;
  const inScope = (plugin: string): boolean =>
    options.scopePlugins === undefined || options.scopePlugins.has(plugin);
  const ops: SyncOp[] = [];
  const nextEntries: SnapshotEntry[] = [];

  const carriedEntries: SnapshotEntry[] = [];
  const snapshotOwned = new Map<string, SnapshotEntry>();
  const snapshotRegions = new Map<string, SnapshotEntry>();
  for (const entry of options.snapshot.entries) {
    if (entry.mode === "owned") {
      if (inScope(entry.plugin)) snapshotOwned.set(entry.targetPath, entry);
      else carriedEntries.push(entry);
    } else if (inScope(entry.plugin)) {
      snapshotRegions.set(`${entry.targetPath} ${entry.regionKey ?? ""}`, entry);
    } else {
      carriedEntries.push(entry);
    }
  }

  // Owned files.
  const desiredPaths = new Set<string>();
  for (const desired of options.desired.files) {
    desiredPaths.add(desired.targetPath);
    ops.push(...(await planOwnedFile({
      desired,
      snapshotEntry: snapshotOwned.get(desired.targetPath),
      degradedOwnership,
    })));
    nextEntries.push({
      targetPath: desired.targetPath,
      contentHash: computeContentHash(desired.content),
      mode: "owned",
      plugin: desired.plugin,
    });
  }

  // Orphaned owned files: in snapshot, no longer desired.
  for (const [targetPath, entry] of snapshotOwned) {
    if (desiredPaths.has(targetPath)) continue;
    if (!(await exists(targetPath))) continue; // silently drop the entry
    const diskHash = computeContentHash(await readFile(targetPath));
    ops.push({ kind: "prune", targetPath, reason: "orphaned", backup: diskHash !== entry.contentHash });
  }

  // Shared-file regions, coalesced one write per file.
  const regionsByFile = new Map<string, DesiredRegion[]>();
  for (const region of options.desired.regions) {
    const group = regionsByFile.get(region.targetPath) ?? [];
    group.push(region);
    regionsByFile.set(region.targetPath, group);
  }
  const desiredRegionRefs = new Set(
    options.desired.regions.map((region) => `${region.targetPath} ${serializeRegionRef(region)}`),
  );
  const orphanedByFile = new Map<string, string[]>();
  for (const [key, entry] of snapshotRegions) {
    if (desiredRegionRefs.has(key)) continue;
    const refs = orphanedByFile.get(entry.targetPath) ?? [];
    refs.push(entry.regionKey ?? "");
    orphanedByFile.set(entry.targetPath, refs);
  }

  const sharedFiles = new Set([...regionsByFile.keys(), ...orphanedByFile.keys()]);
  for (const targetPath of [...sharedFiles].sort()) {
    ops.push(...(await planSharedFileRegions({
      targetPath,
      desired: regionsByFile.get(targetPath) ?? [],
      orphanedRefs: orphanedByFile.get(targetPath) ?? [],
      snapshotByRegion: snapshotRegions,
    })));
  }
  for (const region of options.desired.regions) {
    nextEntries.push({
      targetPath: region.targetPath,
      contentHash: regionContentHash(region),
      mode: "region",
      regionKey: serializeRegionRef(region),
      plugin: region.plugin,
    });
  }

  return {
    harness: options.desired.harness,
    root: options.desired.root,
    ops,
    nextEntries,
    carriedEntries,
    degradedOwnership,
  };
};
