/**
 * Property tests for snapshot store GC (src/state/store.ts).
 *
 * Covered properties:
 *  - gcSnapshots drops manifests for roots that no longer exist.
 *  - gcSnapshots drops owned entries whose target files no longer exist.
 *  - gcSnapshots drops marker-region entries whose fence is absent from the file.
 *  - gcSnapshots keeps live entries and is idempotent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { exists } from "../fs.js";
import { emptySnapshotManifest, type SnapshotEntry } from "./snapshot.js";
import { commitSnapshot, gcSnapshots, snapshotPath } from "./store.js";

const manifestWith = (root: string, entries: SnapshotEntry[]): ReturnType<typeof emptySnapshotManifest> => ({
  ...emptySnapshotManifest({ harness: "codex-cli", root }),
  entries,
});

const markerFor = (key: string): string =>
  `# --- prism:${key} begin ---\nmanaged\n# --- prism:${key} end ---`;

interface EntrySpec {
  readonly fileName: string;
  readonly mode: "owned" | "region";
  readonly live: boolean;
}

const safeFileName = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "-");

const entrySpecArbitrary = (): fc.Arbitrary<EntrySpec> =>
  fc.record({
    fileName: fc.string({ minLength: 1, maxLength: 16 }).map(safeFileName),
    mode: fc.constantFrom("owned" as const, "region" as const),
    live: fc.boolean(),
  });

const uniqueEntrySpecsArbitrary = (): fc.Arbitrary<EntrySpec[]> =>
  fc.array(entrySpecArbitrary(), { minLength: 0, maxLength: 12 }).filter((specs) => {
    const seen = new Set<string>();
    for (const spec of specs) {
      if (seen.has(spec.fileName)) return false;
      seen.add(spec.fileName);
    }
    return true;
  });

const buildEntry = (root: string, spec: EntrySpec): SnapshotEntry => {
  const targetPath = join(root, `${spec.fileName}.md`);
  if (spec.mode === "owned") {
    return { targetPath, contentHash: "h1", mode: "owned", plugin: "p" };
  }
  return { targetPath, contentHash: "h1", mode: "region", regionKey: `marker # ${spec.fileName}`, plugin: "p" };
};

const config = {
  numRuns: 100,
  seed: process.env.FC_SEED ? Number.parseInt(process.env.FC_SEED, 10) : undefined,
};

describe("snapshot GC properties", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const freshRootContext = async (): Promise<{ home: string; root: string; temp: string }> => {
    const temp = await mkdtemp(join(tmpdir(), "prism-state-pbt-"));
    tempDirs.push(temp);
    const home = join(temp, "home");
    const root = join(temp, "root");
    await mkdir(home, { recursive: true });
    await mkdir(root, { recursive: true });
    return { home, root, temp };
  };

  test("gc drops stale owned and missing-marker entries while keeping live ones", async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueEntrySpecsArbitrary(),
        async (specs) => {
          const { home, root } = await freshRootContext();
          const fixtures = specs.map((spec) => ({ spec, entry: buildEntry(root, spec) }));

          for (const fixture of fixtures) {
            if (!fixture.spec.live) continue;
            if (fixture.entry.mode === "owned") {
              await nodeWriteFile(fixture.entry.targetPath, "live");
            } else {
              const parsed = fixture.entry.regionKey ?? "";
              const key = parsed.startsWith("marker # ") ? parsed.slice("marker # ".length) : parsed;
              await nodeWriteFile(fixture.entry.targetPath, markerFor(key));
            }
          }

          await commitSnapshot({ prismHome: home, manifest: manifestWith(root, fixtures.map((f) => f.entry)) });

          const first = await gcSnapshots(home);
          const stalePaths = new Set(first.droppedEntries.map((d) => d.targetPath));

          for (const fixture of fixtures) {
            if (fixture.spec.live) {
              expect(stalePaths.has(fixture.entry.targetPath)).toBe(false);
            } else {
              expect(stalePaths.has(fixture.entry.targetPath)).toBe(true);
            }
          }

          const second = await gcSnapshots(home);
          expect(second.dropped).toEqual([]);
          expect(second.droppedEntries).toEqual([]);

          await rm(root, { recursive: true, force: true });
          await mkdir(root, { recursive: true });
        },
      ),
      config,
    );
  });

  test("gc drops manifests for dead roots and keeps live-root manifests", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 16 }).map(safeFileName),
        fc.boolean(),
        async (runId, dead) => {
          const { home } = await freshRootContext();
          const liveRoot = await mkdtemp(join(tmpdir(), `prism-state-pbt-live-${runId}-`));
          const deadRoot = await mkdtemp(join(tmpdir(), `prism-state-pbt-dead-${runId}-`));
          tempDirs.push(liveRoot, deadRoot);

          await commitSnapshot({
            prismHome: home,
            manifest: manifestWith(liveRoot, []),
          });
          await commitSnapshot({
            prismHome: home,
            manifest: { ...emptySnapshotManifest({ harness: "hermes", root: deadRoot }), entries: [] },
          });

          if (dead) {
            await rm(deadRoot, { recursive: true, force: true });
          }

          const result = await gcSnapshots(home);

          if (dead) {
            expect(result.dropped.map((d) => d.root)).toContain(deadRoot);
            expect(await exists(snapshotPath(home, deadRoot))).toBe(false);
          } else {
            expect(result.dropped).toEqual([]);
            expect(await exists(snapshotPath(home, deadRoot))).toBe(true);
          }

          expect(await exists(snapshotPath(home, liveRoot))).toBe(true);
        },
      ),
      { ...config, numRuns: 20 },
    );
  });
});
