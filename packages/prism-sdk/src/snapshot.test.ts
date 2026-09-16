import { expect, test } from "bun:test";
import {
  decodeSnapshotManifest,
  emptySnapshotManifest,
  encodeSnapshotManifest,
  migrateSnapshotManifest,
} from "@skastr0/prism-sdk/snapshot";

const fixtureManifest = () =>
  emptySnapshotManifest({ harness: "codex-cli", root: "/Users/alice/.codex" });

test("migrateSnapshotManifest is identity for valid v1 payload", () => {
  const manifest = {
    ...fixtureManifest(),
    entries: [
      { targetPath: "/Users/alice/.codex/a.md", contentHash: "h1", mode: "owned", plugin: "p1" },
      {
        targetPath: "/Users/alice/.codex/shared.md",
        contentHash: "h2",
        mode: "region",
        regionKey: "marker # p1.rules",
        plugin: "p1",
      },
    ],
  };
  const migrated = migrateSnapshotManifest(manifest);

  expect(migrated._tag).toBe("Success");
  if (migrated._tag !== "Success") throw new Error("expected Right");
  expect(migrated.success).toEqual(manifest);
});

test("migrateSnapshotManifest rejects unsupported versions", () => {
  const migrated = migrateSnapshotManifest({
    ...fixtureManifest(),
    version: 2,
    entries: [],
  });

  expect(migrated._tag).toBe("Failure");
});

test("migrateSnapshotManifest rejects missing version", () => {
  const migrated = migrateSnapshotManifest({
    harness: "codex-cli",
    root: "/Users/alice/.codex",
    entries: [],
  });

  expect(migrated._tag).toBe("Failure");
});

test("encodeSnapshotManifest sorts entries deterministically by targetPath then regionKey", () => {
  const manifest = {
    ...fixtureManifest(),
    entries: [
      { targetPath: "/b.md", contentHash: "hb", mode: "owned", plugin: "p" },
      { targetPath: "/a.md", contentHash: "ha", mode: "owned", plugin: "p" },
      {
        targetPath: "/a.md",
        contentHash: "h2",
        mode: "region",
        regionKey: "marker # z",
        plugin: "p",
      },
      {
        targetPath: "/a.md",
        contentHash: "h1",
        mode: "region",
        regionKey: "marker # a",
        plugin: "p",
      },
    ],
  };
  const encoded = encodeSnapshotManifest(manifest);
  const decoded = decodeSnapshotManifest(encoded);

  expect(decoded._tag).toBe("Success");
  if (decoded._tag !== "Success") throw new Error("expected Right");
  expect(decoded.success.entries.map((entry) => entry.targetPath)).toEqual([
    "/a.md",
    "/a.md",
    "/a.md",
    "/b.md",
  ]);
  expect(decoded.success.entries.map((entry) => entry.regionKey)).toEqual([
    undefined,
    "marker # a",
    "marker # z",
    undefined,
  ]);
  expect(encodeSnapshotManifest(decoded.success)).toBe(encoded);
});

test("decodeSnapshotManifest rejects malformed JSON", () => {
  const decoded = decodeSnapshotManifest("{ not json");

  expect(decoded._tag).toBe("Failure");
});
