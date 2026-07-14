import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { emptySnapshotManifest, type SnapshotManifest } from "../state/snapshot.js";
import { snapshotPath } from "../state/store.js";
import { PrismHomeTest } from "./prism-env.js";
import { SnapshotStore, SnapshotStoreLive, SnapshotStoreTest } from "./snapshot-store.js";

let home: string;
let root: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "prism-snapshot-store-home-"));
  root = await mkdtemp(join(tmpdir(), "prism-snapshot-store-root-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const manifestWith = (
  entries: SnapshotManifest["entries"],
  overrides: { readonly harness?: string; readonly root?: string } = {},
): SnapshotManifest => ({
  ...emptySnapshotManifest({ harness: overrides.harness ?? "codex-cli", root: overrides.root ?? root }),
  entries,
});

describe("SnapshotStoreLive", () => {
  test("read of a missing manifest returns empty, matching the plain readSnapshot facade", async () => {
    const layer = SnapshotStoreLive.pipe(Layer.provide(PrismHomeTest(home)));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SnapshotStore;
        return yield* store.read({ harness: "codex-cli", root });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.manifest.entries).toEqual([]);
    expect(result.quarantinedPath).toBeUndefined();
  });

  test("commit then read round-trips through the real store.ts persistence", async () => {
    const layer = SnapshotStoreLive.pipe(Layer.provide(PrismHomeTest(home)));
    const manifest = manifestWith([
      { targetPath: join(root, "a.md"), contentHash: "h1", mode: "owned", plugin: "p" },
    ]);

    const read = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SnapshotStore;
        yield* store.commit({ manifest });
        return yield* store.read({ harness: "codex-cli", root });
      }).pipe(Effect.provide(layer)),
    );

    expect(read.manifest.entries.map((entry) => entry.targetPath)).toEqual([join(root, "a.md")]);
    // The manifest actually landed on disk at the same path store.ts owns —
    // Live is a real delegation, not a parallel implementation.
    expect(await Bun.file(snapshotPath(home, root)).exists()).toBe(true);
  });

  test("delegated commitSnapshot still enforces the tempdir test-pollution guard", async () => {
    const fakeRealHome = "/Users/nobody/.prism-fence-test";
    const layer = SnapshotStoreLive.pipe(Layer.provide(PrismHomeTest(fakeRealHome)));

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* SnapshotStore;
          yield* store.commit({ manifest: manifestWith([]) });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow(/test-pollution signature/);
  });
});

describe("SnapshotStoreTest", () => {
  test("round-trips purely in memory with no disk I/O", async () => {
    const layer = SnapshotStoreTest();
    const manifest = manifestWith([
      { targetPath: join(root, "a.md"), contentHash: "h1", mode: "owned", plugin: "p" },
    ]);

    const read = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SnapshotStore;
        yield* store.commit({ manifest });
        return yield* store.read({ harness: "codex-cli", root });
      }).pipe(Effect.provide(layer)),
    );

    expect(read.manifest.entries.map((entry) => entry.targetPath)).toEqual([join(root, "a.md")]);
    // Nothing was written under `home` -- there is no `prismHome` on this
    // layer's surface for a real path to leak through.
    expect(await Bun.file(snapshotPath(home, root)).exists()).toBe(false);
  });

  test("can be seeded with pre-existing manifests", async () => {
    const seeded = manifestWith([
      { targetPath: join(root, "seed.md"), contentHash: "h1", mode: "owned", plugin: "p" },
    ]);
    const layer = SnapshotStoreTest(new Map([[root, seeded]]));

    const read = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SnapshotStore;
        return yield* store.read({ harness: "codex-cli", root });
      }).pipe(Effect.provide(layer)),
    );

    expect(read.manifest.entries.map((entry) => entry.targetPath)).toEqual([join(root, "seed.md")]);
  });

  test("gc is a no-op that never touches disk", async () => {
    const layer = SnapshotStoreTest();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SnapshotStore;
        return yield* store.gc();
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({ dropped: [], droppedEntries: [] });
  });
});
