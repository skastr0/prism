/**
 * Snapshot manifest — the ONLY persistent state the sync engine keeps per
 * harness root (docs/overhaul-one-writer-plan.md, WS4). It replaces all
 * per-harness managed ledgers.
 *
 * The manifest is a disposable cache, never the source of truth: it exists
 * solely to answer "may I skip this write?" and "what do I prune?". Deleting
 * it must always converge on the next refresh (state-is-disposable gate).
 *
 * Identity discipline: entries are keyed by `targetPath` alone within a
 * manifest (one manifest per harness root). Artifact kinds, source paths,
 * and scopes are never identity — that scheme is what produced 646 zombie
 * duplicate ledger entries. `plugin` is diagnostic attribution only.
 *
 * Determinism discipline: the manifest carries no timestamps and no run ids,
 * and entries are sorted by `targetPath` on commit — a converged run leaves
 * the manifest byte-identical.
 */

import { Schema } from "effect";

export const SNAPSHOT_MANIFEST_VERSION = 1 as const;

/**
 * How the sync engine owns the entry's target:
 *  - `owned`: a whole file Prism owns outright (rebuild/prune authority).
 *  - `region`: a prism-named fragment inside a shared user file; `regionKey`
 *    names the fragment and `contentHash` hashes the rendered fragment, not
 *    the whole file.
 */
export const SnapshotEntryMode = Schema.Literal("owned", "region");
export type SnapshotEntryMode = typeof SnapshotEntryMode.Type;

export const SnapshotEntrySchema = Schema.Struct({
  targetPath: Schema.String,
  contentHash: Schema.String,
  mode: SnapshotEntryMode,
  regionKey: Schema.optional(Schema.String),
  plugin: Schema.String,
});
export type SnapshotEntry = typeof SnapshotEntrySchema.Type;

const SnapshotManifestV1 = Schema.Struct({
  version: Schema.Literal(SNAPSHOT_MANIFEST_VERSION),
  harness: Schema.String,
  root: Schema.String,
  entries: Schema.Array(SnapshotEntrySchema),
});

/**
 * Versioned union. Future versions join this union; readers decode the union
 * and migrate forward in code. There is exactly one version today.
 */
export const SnapshotManifestSchema = SnapshotManifestV1;
export type SnapshotManifest = typeof SnapshotManifestSchema.Type;

export const decodeSnapshotManifest = Schema.decodeUnknownEither(
  Schema.parseJson(SnapshotManifestSchema),
);

export const encodeSnapshotManifest = (manifest: SnapshotManifest): string => {
  const sorted: SnapshotManifest = {
    ...manifest,
    entries: [...manifest.entries].sort((left, right) =>
      left.targetPath === right.targetPath
        ? (left.regionKey ?? "").localeCompare(right.regionKey ?? "")
        : left.targetPath.localeCompare(right.targetPath),
    ),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
};

export const emptySnapshotManifest = (options: {
  readonly harness: string;
  readonly root: string;
}): SnapshotManifest => ({
  version: SNAPSHOT_MANIFEST_VERSION,
  harness: options.harness,
  root: options.root,
  entries: [],
});
