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
import { computeContentHash, computeMcpHttpConfigContentHash } from "../content-hash.js";
import { exists, readFile } from "../fs.js";
import type { SnapshotEntry, SnapshotManifest } from "../state/snapshot.js";
import type { DesiredFile, DesiredRegion, DesiredRoot } from "./desired.js";
import { sweepLegacyPrismMcpEntries } from "./legacy-prism-entries.js";
import {
  applyRegion,
  removeJsonArrayMemberRegion,
  removeJsonKeyRegion,
  removeMarkerRegion,
  renderMarkerRegion,
} from "./regions.js";

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
const arrayMemberIdentity = (
  region: Extract<DesiredRegion, { kind: "json-array-member" }>,
): unknown => {
  if (region.memberKey === undefined) return region.value;
  let cursor: unknown = region.value;
  for (const segment of region.memberKey) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

export const serializeRegionRef = (region: DesiredRegion): string => {
  switch (region.kind) {
    case "marker":
      if (region.commentSuffix !== undefined) {
        return `marker-v2 ${JSON.stringify({
          prefix: region.commentPrefix,
          suffix: region.commentSuffix,
          key: region.regionKey,
        })}`;
      }
      return `marker ${region.commentPrefix} ${region.regionKey}`;
    case "json-key":
      return `json ${region.regionKey} ${JSON.stringify(region.jsonPath)}`;
    case "json-array-member":
      return `json-array ${region.regionKey} ${JSON.stringify({
        path: region.jsonPath,
        ...(region.memberKey === undefined ? {} : { memberKey: region.memberKey }),
        identity: arrayMemberIdentity(region),
      })}`;
  }
};

export const parseRegionRef = (
  ref: string,
):
  | {
      readonly kind: "marker";
      readonly commentPrefix: string;
      readonly commentSuffix?: string;
      readonly regionKey: string;
    }
  | { readonly kind: "json"; readonly regionKey: string; readonly jsonPath: ReadonlyArray<string | number> }
  | {
      readonly kind: "json-array";
      readonly regionKey: string;
      readonly jsonPath: ReadonlyArray<string | number>;
      readonly memberKey?: ReadonlyArray<string>;
      readonly identity: unknown;
    }
  | undefined => {
  const markerV2 = ref.match(/^marker-v2 (\{.*\})$/);
  if (markerV2) {
    try {
      const parsed = JSON.parse(markerV2[1]!) as {
        readonly prefix?: unknown;
        readonly suffix?: unknown;
        readonly key?: unknown;
      };
      if (typeof parsed.prefix === "string" && typeof parsed.key === "string") {
        return {
          kind: "marker",
          commentPrefix: parsed.prefix,
          ...(typeof parsed.suffix === "string" ? { commentSuffix: parsed.suffix } : {}),
          regionKey: parsed.key,
        };
      }
    } catch {
      return undefined;
    }
  }
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
  const jsonArray = ref.match(/^json-array (\S+) (\{.*\})$/);
  if (jsonArray) {
    try {
      const parsed = JSON.parse(jsonArray[2]!) as {
        readonly path: ReadonlyArray<string | number>;
        readonly memberKey?: ReadonlyArray<string>;
        readonly identity: unknown;
      };
      return {
        kind: "json-array",
        regionKey: jsonArray[1]!,
        jsonPath: parsed.path,
        ...(parsed.memberKey === undefined ? {} : { memberKey: parsed.memberKey }),
        identity: parsed.identity,
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

/**
 * Content hash for an owned file. Grok's owned .mcp.json bundles a dynamic
 * host:port the owner daemon can rebind on every restart; normalize it out of
 * the hash so a port change alone never reads as drift (PQ-167). Every other
 * harness (and every other grok owned file) hashes unchanged.
 */
const ownedFileContentHash = (harness: string, content: string): string =>
  harness === "grok" ? computeMcpHttpConfigContentHash(content) : computeContentHash(content);

const removeOrphanedRegion = (
  content: string,
  parsed: NonNullable<ReturnType<typeof parseRegionRef>>,
): ReturnType<typeof removeMarkerRegion> => {
  switch (parsed.kind) {
    case "marker":
      return removeMarkerRegion(content, parsed);
    case "json":
      return removeJsonKeyRegion(content, parsed.jsonPath);
    case "json-array":
      return removeJsonArrayMemberRegion(content, {
        jsonPath: parsed.jsonPath,
        identity: parsed.identity,
        ...(parsed.memberKey === undefined ? {} : { memberKey: parsed.memberKey }),
      });
  }
};

const planOwnedFile = async (options: {
  readonly harness: string;
  readonly desired: DesiredFile;
  readonly snapshotEntry: SnapshotEntry | undefined;
  readonly degradedOwnership: boolean;
}): Promise<SyncOp[]> => {
  const { harness, desired, snapshotEntry, degradedOwnership } = options;
  // Exact-byte comparison: whether a rewrite is needed at all must never be
  // fooled by normalization — a genuinely new port always has to land on disk.
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
    // Whether this repair is backed up as "drifted" (suspicious/external) vs
    // plain "source-changed" (Prism's own routine update) compares against
    // the snapshot in the same normalized domain the entry was stored in, so
    // a port-only difference (e.g. a crash between a write and its snapshot
    // commit) is never mistaken for external tampering (PQ-167). A snapshot
    // entry written before this normalization existed still holds a raw
    // (unnormalized) hash, so accept either domain — otherwise a port-only
    // change on a legacy grok snapshot spuriously reads as external drift and
    // takes a needless backup.
    const drifted =
      diskHash !== snapshotEntry.contentHash &&
      ownedFileContentHash(harness, diskContent) !== snapshotEntry.contentHash;
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
  readonly harness: string;
  readonly desired: ReadonlyArray<DesiredRegion>;
  readonly orphanedRefs: ReadonlyArray<string>;
  readonly snapshotByRegion: ReadonlyMap<string, SnapshotEntry>;
}): Promise<{
  readonly ops: ReadonlyArray<SyncOp>;
  readonly materializedRegionRefs: ReadonlyArray<string>;
}> => {
  const fileExists = await exists(options.targetPath);
  let original = "";
  if (fileExists) {
    try {
      original = await readFile(options.targetPath);
    } catch {
      const plugin =
        options.desired[0]?.plugin ??
        [...options.snapshotByRegion.values()][0]?.plugin ??
        "unknown";
      return {
        ops: [{
          kind: "blocked",
          targetPath: options.targetPath,
          plugin,
          hint: "the shared config target exists but is not a readable file (directory or permission problem) — delete or move it, then refresh",
        }],
        materializedRegionRefs: [],
      };
    }
  }

  let content = original;
  const changedRegions: string[] = [];
  const skippedRegions: string[] = [];
  // Tracked as (region, ref) pairs — not yet the returned ref list — so a
  // region a later same-pass sweep removes (see the reconciliation below)
  // can be dropped by its regionKey before this ever becomes a snapshot
  // entry. The snapshot must equal disk; it may never claim a region that
  // was written then swept away in the same pass.
  const materialized: Array<{ readonly regionKey: string; readonly ref: string }> = [];

  for (const region of options.desired) {
    let outcome: ReturnType<typeof applyRegion>;
    try {
      outcome = applyRegion(content, region);
    } catch (error) {
      // A structurally incompatible shared file (e.g. a non-array where the
      // region expects an array) classifies as blocked — collect, don't throw.
      return {
        ops: [{
          kind: "blocked",
          targetPath: options.targetPath,
          plugin: region.plugin,
          hint:
            `cannot patch region '${region.regionKey}': ` +
            `${error instanceof Error ? error.message : String(error)} — ` +
            "fix or move the file, then refresh",
        }],
        materializedRegionRefs: materialized.map((entry) => entry.ref),
      };
    }
    if (outcome.changed) changedRegions.push(region.regionKey);
    else skippedRegions.push(region.regionKey);
    if (outcome.materialized !== false) {
      materialized.push({ regionKey: region.regionKey, ref: serializeRegionRef(region) });
    }
    content = outcome.content;
  }

  const removedRegions: string[] = [];
  for (const ref of options.orphanedRefs) {
    const parsed = parseRegionRef(ref);
    if (!parsed) continue;
    const outcome = removeOrphanedRegion(content, parsed);
    if (outcome.changed) removedRegions.push(parsed.regionKey);
    content = outcome.content;
  }

  // Scope-independent sweep for retired Prism MCP identities (the
  // synthetic union-owner sentinel and pre-shim HTTP-era naming) that the
  // snapshot-driven orphan removal above can never reach — see
  // `legacy-prism-entries.ts` for why. Safe on every compile, scoped or
  // not: gated on positive content provenance AND exclusion of this pass's
  // own desired keys (threaded through below), so a live entry — however
  // its name happens to be shaped — is never swept.
  const legacySweep = sweepLegacyPrismMcpEntries(options.harness, content, options.desired);
  if (legacySweep.changed) {
    content = legacySweep.content;
    removedRegions.push(...legacySweep.removedKeys);
  }

  // Reconcile: a regionKey removed above (orphan or legacy sweep) is never
  // also reported as materialized, regardless of why it matched — the
  // desired-keys exclusion inside the legacy sweep already makes this a
  // no-op in practice, but the snapshot-truthfulness invariant holds
  // structurally here rather than depending on that sweep's internals.
  const removedRegionKeys = new Set(removedRegions);
  const materializedRegionRefs = materialized
    .filter((entry) => !removedRegionKeys.has(entry.regionKey))
    .map((entry) => entry.ref);

  if (content === original) {
    return {
      ops: skippedRegions.length > 0
        ? [{ kind: "skip-regions", targetPath: options.targetPath, regionKeys: skippedRegions }]
        : [],
      materializedRegionRefs,
    };
  }

  return {
    ops: [{
      kind: "patch-regions",
      targetPath: options.targetPath,
      content,
      changedRegions,
      removedRegions,
      backup: fileExists,
      create: !fileExists,
    }],
    materializedRegionRefs,
  };
};

const groupRegionsByFile = (
  regions: ReadonlyArray<DesiredRegion>,
): Map<string, DesiredRegion[]> => {
  const regionsByFile = new Map<string, DesiredRegion[]>();
  for (const region of regions) {
    const group = regionsByFile.get(region.targetPath) ?? [];
    group.push(region);
    regionsByFile.set(region.targetPath, group);
  }
  return regionsByFile;
};

const groupOrphanedRegionRefsByFile = (
  desiredRegions: ReadonlyArray<DesiredRegion>,
  snapshotRegions: ReadonlyMap<string, SnapshotEntry>,
  protectedRegionKeys: ReadonlySet<string>,
): Map<string, string[]> => {
  const desiredRegionRefs = new Set(
    desiredRegions.map((region) => `${region.targetPath} ${serializeRegionRef(region)}`),
  );
  const orphanedByFile = new Map<string, string[]>();
  for (const [key, entry] of snapshotRegions) {
    if (desiredRegionRefs.has(key)) continue;
    if (protectedRegionKeys.has(key)) continue;
    const refs = orphanedByFile.get(entry.targetPath) ?? [];
    refs.push(entry.regionKey ?? "");
    orphanedByFile.set(entry.targetPath, refs);
  }
  return orphanedByFile;
};

const planSharedRegions = async (options: {
  readonly harness: string;
  readonly desiredRegions: ReadonlyArray<DesiredRegion>;
  readonly snapshotRegions: ReadonlyMap<string, SnapshotEntry>;
  readonly protectedRegionKeys: ReadonlySet<string>;
}): Promise<{
  readonly ops: ReadonlyArray<SyncOp>;
  readonly materializedRegionKeys: ReadonlySet<string>;
}> => {
  const regionsByFile = groupRegionsByFile(options.desiredRegions);
  const orphanedByFile = groupOrphanedRegionRefsByFile(
    options.desiredRegions,
    options.snapshotRegions,
    options.protectedRegionKeys,
  );
  const sharedFiles = new Set([...regionsByFile.keys(), ...orphanedByFile.keys()]);
  const ops: SyncOp[] = [];
  const materializedRegionKeys = new Set<string>();

  for (const targetPath of [...sharedFiles].sort()) {
    const sharedPlan = await planSharedFileRegions({
      targetPath,
      harness: options.harness,
      desired: regionsByFile.get(targetPath) ?? [],
      orphanedRefs: orphanedByFile.get(targetPath) ?? [],
      snapshotByRegion: options.snapshotRegions,
    });
    ops.push(...sharedPlan.ops);
    for (const ref of sharedPlan.materializedRegionRefs) {
      materializedRegionKeys.add(`${targetPath} ${ref}`);
    }
  }

  return { ops, materializedRegionKeys };
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
  const carriedRegionKeys = new Set<string>();
  const snapshotOwned = new Map<string, SnapshotEntry>();
  const snapshotRegions = new Map<string, SnapshotEntry>();
  // A desired region claims EVERY snapshot entry with the same region
  // identity (targetPath + serialized ref), regardless of attributed plugin
  // or scope: one physical fence can only have one true entry, so a stale
  // same-identity entry recorded under another owner (e.g. the pre-union
  // per-plugin shim-region entries) is superseded rather than carried —
  // otherwise duplicates accumulate one per plugin and doctor reports
  // marker drift against every stale copy.
  const desiredRegionIdentities = new Set(
    options.desired.regions.map(
      (region) => `${region.targetPath} ${serializeRegionRef(region)}`,
    ),
  );
  for (const entry of options.snapshot.entries) {
    if (entry.mode === "owned") {
      if (inScope(entry.plugin)) snapshotOwned.set(entry.targetPath, entry);
      else carriedEntries.push(entry);
      continue;
    }
    const identity = `${entry.targetPath} ${entry.regionKey ?? ""}`;
    if (inScope(entry.plugin) || desiredRegionIdentities.has(identity)) {
      snapshotRegions.set(identity, entry);
    } else {
      carriedEntries.push(entry);
      carriedRegionKeys.add(identity);
    }
  }

  // Owned files.
  const desiredPaths = new Set<string>();
  for (const desired of options.desired.files) {
    desiredPaths.add(desired.targetPath);
    ops.push(...(await planOwnedFile({
      harness: options.desired.harness,
      desired,
      snapshotEntry: snapshotOwned.get(desired.targetPath),
      degradedOwnership,
    })));
    nextEntries.push({
      targetPath: desired.targetPath,
      // Normalized so a later standalone drift check (doctor.ts) and the
      // repair-reason classification above compare in the same domain a
      // dynamic port/url never counts as drift in (PQ-167).
      contentHash: ownedFileContentHash(options.desired.harness, desired.content),
      mode: "owned",
      plugin: desired.plugin,
    });
  }

  // Orphaned owned files: in snapshot, no longer desired.
  for (const [targetPath, entry] of snapshotOwned) {
    if (desiredPaths.has(targetPath)) continue;
    if (!(await exists(targetPath))) continue; // silently drop the entry
    const diskHash = ownedFileContentHash(options.desired.harness, await readFile(targetPath));
    ops.push({
      kind: "prune",
      targetPath,
      reason: "orphaned",
      backup: diskHash !== entry.contentHash,
    });
  }

  // Shared-file regions, coalesced one write per file.
  const sharedRegionPlan = await planSharedRegions({
    harness: options.desired.harness,
    desiredRegions: options.desired.regions,
    snapshotRegions,
    protectedRegionKeys: carriedRegionKeys,
  });
  ops.push(...sharedRegionPlan.ops);
  for (const region of options.desired.regions) {
    const regionKey = serializeRegionRef(region);
    if (!sharedRegionPlan.materializedRegionKeys.has(`${region.targetPath} ${regionKey}`)) {
      continue;
    }
    nextEntries.push({
      targetPath: region.targetPath,
      contentHash: regionContentHash(region),
      mode: "region",
      regionKey,
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
