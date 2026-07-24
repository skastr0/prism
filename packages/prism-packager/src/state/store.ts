/**
 * Snapshot store — read/commit/gc for snapshot manifests under
 * `<PRISM_HOME>/state/roots/<sha256(root)>.json` (one file per harness root).
 *
 * Guarantees enforced here, not at call sites:
 *  - Commit-last: `commitSnapshot` is the ONLY persistence call, and it
 *    writes atomically (temp-sibling + rename via fs.ts). The sync engine
 *    applies file operations first and commits the manifest as its final
 *    step; a crash anywhere converges on re-run.
 *  - Quarantine, never block: a corrupt manifest is renamed to
 *    `*.corrupt-<ts>.json` and treated as empty. Because manifests are
 *    disposable caches over a deterministic generator, degrading to empty
 *    plans repairs — it must never produce hard errors.
 *  - Tmp fence: a manifest for a root under the OS tempdir is refused when
 *    PRISM_HOME itself is not under the tempdir. That combination is the
 *    signature of test code leaking into real state (the 996-entry ledger
 *    pollution class); sandboxed runs put both under tmp and pass.
 */

import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ensureDir,
  exists,
  listDir,
  pathContains,
  readFile,
  removeFile,
  writeFile,
} from "../fs.js";
import {
  emptySnapshotManifest,
  encodeSnapshotManifest,
  migrateSnapshotManifest,
  type SnapshotEntry,
  type SnapshotManifest,
} from "./snapshot.js";
import { parseRegionRef } from "../sync/plan.js";

const SNAPSHOT_DIR_SEGMENTS = ["state", "roots"] as const;

const regexEscape = (value: string): string => value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");

const markerLine = (
  prefix: string,
  key: string,
  edge: "begin" | "end",
  suffix = "",
): string => `${prefix} --- prism:${key} ${edge} ---${suffix}`;

const markerRegionPresent = (content: string, parsed: { readonly commentPrefix: string; readonly regionKey: string; readonly commentSuffix?: string }): boolean => {
  const begin = markerLine(parsed.commentPrefix, parsed.regionKey, "begin", parsed.commentSuffix);
  const end = markerLine(parsed.commentPrefix, parsed.regionKey, "end", parsed.commentSuffix);
  return new RegExp(`${regexEscape(begin)}[\\s\\S]*?${regexEscape(end)}`).test(content);
};

const regionEntryPresent = (content: string, entry: SnapshotEntry): boolean => {
  if (entry.mode !== "region" || entry.regionKey === undefined) return false;
  const parsed = parseRegionRef(entry.regionKey);
  if (!parsed) return false;
  if (parsed.kind === "marker") {
    return markerRegionPresent(content, parsed);
  }
  // JSON regions are owned fragments inside a shared file; absence of the
  // file is already handled, and a missing JSON key is treated as stale so
  // doctor does not keep reporting it on every run.
  return true;
};

export const snapshotDir = (prismHome: string): string =>
  join(prismHome, ...SNAPSHOT_DIR_SEGMENTS);

export const snapshotPath = (prismHome: string, root: string): string =>
  join(
    snapshotDir(prismHome),
    `${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16)}.json`,
  );

export interface SnapshotReadResult {
  readonly manifest: SnapshotManifest;
  /** Set when a corrupt manifest was quarantined; callers surface a warning. */
  readonly quarantinedPath?: string;
}

export const readSnapshot = async (options: {
  readonly prismHome: string;
  readonly harness: string;
  readonly root: string;
}): Promise<SnapshotReadResult> => {
  const path = snapshotPath(options.prismHome, options.root);
  const empty = emptySnapshotManifest({ harness: options.harness, root: resolve(options.root) });
  if (!(await exists(path))) return { manifest: empty };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path));
  } catch {
    const quarantinedPath = `${path}.corrupt-${Date.now()}.json`;
    await rename(path, quarantinedPath);
    return { manifest: empty, quarantinedPath };
  }

  const decoded = migrateSnapshotManifest(parsed);
  if (decoded._tag === "Right") return { manifest: decoded.right };

  const quarantinedPath = `${path}.corrupt-${Date.now()}.json`;
  await rename(path, quarantinedPath);
  return { manifest: empty, quarantinedPath };
};

const underTmp = (path: string): boolean => {
  const tmp = resolve(tmpdir());
  const resolved = resolve(path);
  // macOS tempdirs live under /var/folders (symlinked via /private); cover
  // both the process tempdir and the conventional /tmp + /private prefixes.
  return (
    pathContains(tmp, resolved) ||
    resolved.startsWith("/tmp/") ||
    resolved.startsWith("/private/tmp/") ||
    resolved.startsWith("/private/var/folders/") ||
    resolved.startsWith("/var/folders/")
  );
};

export const commitSnapshot = async (options: {
  readonly prismHome: string;
  readonly manifest: SnapshotManifest;
}): Promise<void> => {
  if (underTmp(options.manifest.root) && !underTmp(options.prismHome)) {
    throw new Error(
      `Refusing to persist a snapshot for tempdir root '${options.manifest.root}' into ` +
        `non-tempdir PRISM_HOME '${options.prismHome}' — this is the test-pollution ` +
        `signature; sandbox PRISM_HOME for sandboxed roots.`,
    );
  }
  const path = snapshotPath(options.prismHome, options.manifest.root);
  await ensureDir(dirname(path));
  await writeFile(path, encodeSnapshotManifest(options.manifest));
};

export interface SnapshotGcResult {
  readonly dropped: ReadonlyArray<{ readonly path: string; readonly root: string }>;
  readonly droppedEntries: ReadonlyArray<{
    readonly path: string;
    readonly root: string;
    readonly harness: string;
    readonly targetPath: string;
    readonly plugin: string;
  }>;
}

/**
 * Drop manifests whose harness root no longer exists on disk, and drop entries
 * whose target file no longer exists from live-root manifests. Corrupt files
 * are quarantined (consistent with read).
 */
export const gcSnapshots = async (prismHome: string): Promise<SnapshotGcResult> => {
  const dir = snapshotDir(prismHome);
  if (!(await exists(dir))) return { dropped: [], droppedEntries: [] };

  const dropped: Array<{ path: string; root: string }> = [];
  const droppedEntries: Array<{
    readonly path: string;
    readonly root: string;
    readonly harness: string;
    readonly targetPath: string;
    readonly plugin: string;
  }> = [];
  for (const name of await listDir(dir)) {
    if (!name.endsWith(".json") || name.includes(".corrupt-")) continue;
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path));
    } catch {
      await rename(path, `${path}.corrupt-${Date.now()}.json`);
      continue;
    }
    const decoded = migrateSnapshotManifest(parsed);
    if (decoded._tag === "Left") {
      await rename(path, `${path}.corrupt-${Date.now()}.json`);
      continue;
    }
    const manifest = decoded.right;
    if (!(await exists(manifest.root))) {
      await removeFile(path);
      dropped.push({ path, root: manifest.root });
      continue;
    }

    const survivingEntries: SnapshotEntry[] = [];
    let manifestChanged = false;
    for (const entry of manifest.entries) {
      if (!(await exists(entry.targetPath))) {
        droppedEntries.push({
          path,
          root: manifest.root,
          harness: manifest.harness,
          targetPath: entry.targetPath,
          plugin: entry.plugin,
        });
        manifestChanged = true;
        continue;
      }

      if (entry.mode === "region" && entry.regionKey !== undefined) {
        const content = await readFile(entry.targetPath);
        if (!regionEntryPresent(content, entry)) {
          droppedEntries.push({
            path,
            root: manifest.root,
            harness: manifest.harness,
            targetPath: entry.targetPath,
            plugin: entry.plugin,
          });
          manifestChanged = true;
          continue;
        }
      }

      survivingEntries.push(entry);
    }

    if (manifestChanged) {
      await commitSnapshot({ prismHome, manifest: { ...manifest, entries: survivingEntries } });
    }
  }
  return { dropped, droppedEntries };
};
