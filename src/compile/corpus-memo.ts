/**
 * Corpus-hash world memo (PQ-090).
 *
 * `prism refresh --plugins <dir> --all` recomputes the full desired world
 * (every discovered plugin x every requested harness) on every invocation,
 * even when the per-plugin compile cache (cache.ts) hits on every agent and
 * the sync engine skips every file. Measured on the real prism-plugins
 * corpus (82 plugins, all 13 harnesses, sandboxed PRISM_HOME + temp target
 * roots): a cold run took ~522s; the very next run, with zero plugin/agent
 * changes and every compile cache entry hitting, still took ~322s -- a
 * single-plugin warm re-refresh cost ~4-5s of fixed load/resolve/lower/diff
 * overhead regardless of cache hits, and that overhead is what dominates at
 * corpus scale. This memo removes the per-plugin loop entirely once the
 * corpus is proven unchanged.
 *
 * Design: once a `refresh --plugins` invocation over a given directory with
 * a given harness/scope/project/compile-root/mcp-lifecycle selection fully
 * succeeds (every discovered plugin refreshed with zero failures and zero
 * invalid manifests), the outcome is memoized under a hash of (a) every
 * discovered plugin's own file-tree content, (b) the running Prism version,
 * and (c) the lowerer capability contract (`lowerer-capabilities.ts`). The
 * next invocation with an identical corpus hash and identical CLI/harness-
 * root parameters skips the per-plugin loop and reports the memo hit
 * directly instead of re-deriving a result already known to hold.
 *
 * Explicit non-goal (leaf scope, PQ-090 non-goals): this does not detect
 * drift in *target* files caused by something other than Prism (a hand-
 * edited generated output). Re-verifying target state would require the
 * same per-file walk this memo exists to skip -- the same tradeoff every
 * content-addressed cache in this compiler makes (see cache.ts). `--clean`
 * (or touching any plugin source) forces a full re-check by construction:
 * either bypasses the memo directly or changes the corpus hash.
 */

import { join } from "node:path";
import type { HarnessId, HarnessScope } from "../types.js";
import { LOWERER_CAPABILITIES } from "../lowerer-capabilities.js";
import { computeContentHash, computeStableHash } from "./cache.js";
import { ensureDir, exists, listDirRecursive, readFile, readJson, writeFile } from "../fs.js";

/** Plugin-relative path prefixes/paths never treated as compile input. */
const EXCLUDED_PLUGIN_PATHS = new Set(["prism.lock"]);
const EXCLUDED_PLUGIN_PREFIXES = ["dist/", ".git/", "node_modules/"];

const isExcludedPluginPath = (relativePath: string): boolean => {
  if (EXCLUDED_PLUGIN_PATHS.has(relativePath)) return true;
  return EXCLUDED_PLUGIN_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
};

/**
 * Bounded-concurrency map: this module hashes every file in every discovered
 * plugin (and every plugin in the corpus) on the CLI's hot path, so an
 * unbounded `Promise.all` risks opening hundreds of file descriptors at once
 * on a large corpus. A small worker pool keeps I/O parallel without an
 * unbounded fan-out.
 */
const FILE_IO_CONCURRENCY = 8;

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index] as T);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
};

/**
 * Whole-plugin content hash: every non-generated file under the plugin
 * directory, hashed by relative path + content, combined in a stable
 * (sorted) order. Pure filesystem I/O -- no TypeScript module loading, no
 * dependency resolution -- so it stays cheap enough to run on every
 * invocation instead of the compile pipeline it gates.
 */
export const hashPluginContent = async (pluginPath: string): Promise<string> => {
  const relativePaths = (await listDirRecursive(pluginPath))
    .filter((relativePath) => !isExcludedPluginPath(relativePath))
    .sort((left, right) => left.localeCompare(right));

  const files = await mapWithConcurrency(relativePaths, FILE_IO_CONCURRENCY, async (relativePath) => ({
    path: relativePath,
    contentHash: computeContentHash(await readFile(join(pluginPath, relativePath))),
  }));

  return computeStableHash(files);
};

export interface CorpusHashInput {
  /** Absolute plugin directory paths, in any order. */
  readonly pluginPaths: readonly string[];
  readonly prismVersion: string;
}

/**
 * Corpus hash: sorted per-plugin content hashes + Prism version + the
 * lowerer capability contract, exactly as specified in PQ-090's Context.
 */
export const computeCorpusHash = async (input: CorpusHashInput): Promise<string> => {
  const sortedPaths = [...input.pluginPaths].sort((left, right) => left.localeCompare(right));
  const perPlugin = await mapWithConcurrency(sortedPaths, FILE_IO_CONCURRENCY, async (pluginPath) => ({
    pluginPath,
    contentHash: await hashPluginContent(pluginPath),
  }));

  return computeStableHash({
    plugins: perPlugin,
    prismVersion: input.prismVersion,
    capabilityContract: LOWERER_CAPABILITIES,
  });
};

export interface CorpusParamsInput {
  readonly harnesses: readonly HarnessId[];
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly compileRoot?: string;
  readonly mcpLifecycle: string;
  readonly overwrite: boolean;
  readonly compileOnly: boolean;
  /** Resolved absolute root directory per requested harness (global or project). */
  readonly resolvedRoots: Readonly<Record<string, string | null>>;
}

/**
 * Params hash: everything about *this invocation* (as opposed to the
 * corpus's own content) that changes what a converged run would produce.
 * Folding in each harness's resolved root means a HOME/--project change
 * invalidates the memo even though no plugin content changed.
 */
export const computeCorpusParamsHash = (input: CorpusParamsInput): string =>
  computeStableHash({
    harnesses: [...input.harnesses].sort((left, right) => left.localeCompare(right)),
    scope: input.scope,
    projectPath: input.projectPath ?? null,
    compileRoot: input.compileRoot ?? null,
    mcpLifecycle: input.mcpLifecycle,
    overwrite: input.overwrite,
    compileOnly: input.compileOnly,
    resolvedRoots: input.resolvedRoots,
  });

export interface CorpusMemo {
  readonly version: 1;
  readonly corpusHash: string;
  readonly paramsHash: string;
  readonly pluginCount: number;
  readonly generatedAt: string;
}

const CORPUS_MEMO_DIR = "corpus-memo";

const directoryMemoKey = (expandedDirectory: string): string =>
  computeContentHash(expandedDirectory);

export const corpusMemoPath = (prismHome: string, expandedDirectory: string): string =>
  join(prismHome, "state", CORPUS_MEMO_DIR, `${directoryMemoKey(expandedDirectory)}.json`);

export const readCorpusMemo = async (
  prismHome: string,
  expandedDirectory: string,
): Promise<CorpusMemo | null> => {
  const path = corpusMemoPath(prismHome, expandedDirectory);
  if (!(await exists(path))) return null;

  try {
    return await readJson<CorpusMemo>(path);
  } catch {
    return null;
  }
};

export const writeCorpusMemo = async (
  prismHome: string,
  expandedDirectory: string,
  memo: Omit<CorpusMemo, "version" | "generatedAt">,
): Promise<void> => {
  const path = corpusMemoPath(prismHome, expandedDirectory);
  await ensureDir(join(prismHome, "state", CORPUS_MEMO_DIR));
  await writeFile(
    path,
    JSON.stringify(
      { version: 1, ...memo, generatedAt: new Date().toISOString() } satisfies CorpusMemo,
      null,
      2,
    ),
  );
};

export const matchesCorpusMemo = (
  memo: CorpusMemo | null,
  corpusHash: string,
  paramsHash: string,
): boolean =>
  memo !== null && memo.corpusHash === corpusHash && memo.paramsHash === paramsHash;
