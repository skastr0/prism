/**
 * SnapshotStore — the Effect service wrapping src/state/store.ts's snapshot
 * manifest read/commit/gc behind a `PrismHome`-scoped Context.Tag (PQ-089).
 *
 * `SnapshotStoreLive` delegates 1:1 to the existing plain-async functions in
 * src/state/store.ts — no logic is duplicated, so every guarantee already
 * enforced there (atomic commit, quarantine-not-abort, the tempdir
 * test-pollution guard in `commitSnapshot`) survives byte-for-byte. This is
 * an additive service boundary: src/state/store.ts's plain-async exports are
 * unchanged and remain the facade existing callers keep using directly.
 *
 * `SnapshotStoreTest` is a genuine in-memory implementation — no disk I/O,
 * and no `prismHome` parameter anywhere on its surface — so code that
 * consumes `SnapshotStore` instead of the raw functions is structurally
 * unable to construct a real-home store, even by accident.
 *
 * Mirrors src/services/prism-env.ts's `PrismHome` Context.Tag + Live/Test
 * shape, the template PQ-089's shaping note names directly.
 */

import { resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import { emptySnapshotManifest, type SnapshotManifest } from "../state/snapshot.js";
import {
  commitSnapshot,
  gcSnapshots,
  readSnapshot,
  type SnapshotGcResult,
  type SnapshotReadResult,
} from "../state/store.js";
import { PrismHome } from "./prism-env.js";

export interface SnapshotStoreEnv {
  readonly read: (options: {
    readonly harness: string;
    readonly root: string;
  }) => Effect.Effect<SnapshotReadResult>;
  readonly commit: (options: {
    readonly manifest: SnapshotManifest;
  }) => Effect.Effect<void>;
  readonly gc: () => Effect.Effect<SnapshotGcResult>;
}

export class SnapshotStore extends Context.Tag("prism/SnapshotStore")<
  SnapshotStore,
  SnapshotStoreEnv
>() {}

/**
 * Live layer for real work. Requires `PrismHome`; every call is a thin
 * `Effect.promise` wrapper around the corresponding src/state/store.ts
 * function, so behavior (including `commitSnapshot`'s tempdir guard, which
 * still throws and surfaces as a defect through this layer exactly as it
 * does for direct callers today) is unchanged.
 */
export const SnapshotStoreLive: Layer.Layer<SnapshotStore, never, PrismHome> = Layer.effect(
  SnapshotStore,
  Effect.map(PrismHome, (env) => ({
    read: (options: { readonly harness: string; readonly root: string }) =>
      Effect.promise(() =>
        readSnapshot({ prismHome: env.home, harness: options.harness, root: options.root }),
      ),
    commit: (options: { readonly manifest: SnapshotManifest }) =>
      Effect.promise(() => commitSnapshot({ prismHome: env.home, manifest: options.manifest })),
    gc: () => Effect.promise(() => gcSnapshots(env.home)),
  })),
);

/**
 * In-memory layer for tests — no disk I/O, no `prismHome` field to smuggle a
 * real-home construction through. Manifests are keyed by resolved root path,
 * mirroring how src/state/store.ts keys one manifest file per root.
 */
export const SnapshotStoreTest = (
  seed: ReadonlyMap<string, SnapshotManifest> = new Map(),
): Layer.Layer<SnapshotStore> =>
  Layer.sync(SnapshotStore, () => {
    const manifests = new Map(seed);
    return {
      read: ({ harness, root }) =>
        Effect.sync(() => {
          const key = resolve(root);
          const manifest = manifests.get(key) ?? emptySnapshotManifest({ harness, root: key });
          return { manifest };
        }),
      commit: ({ manifest }) =>
        Effect.sync(() => {
          manifests.set(resolve(manifest.root), manifest);
        }),
      gc: () => Effect.succeed({ dropped: [], droppedEntries: [] }),
    };
  });
