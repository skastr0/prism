/**
 * Shim-exposure registry — the per-harness-root union source for shared
 * stdio-shim config regions (codex `config.toml`, hermes `config.yaml`,
 * cursor `mcp.json`).
 *
 * Why it exists: those harnesses hold ONE shared shim region per root
 * (same region key for every plugin), but each compile only sees its own
 * compile unit. Without a cross-compile record, the last compiler's view
 * replaces the fence wholesale and silently narrows every other installed
 * plugin out of the shim (last-writer-wins). This registry records each
 * MCP-bearing plugin's contribution per `(harness, root)` so any single
 * compile can render the full union — byte-identical regardless of which
 * plugin triggered the write.
 *
 * Store discipline mirrors the snapshot store (`state/store.ts`): one file
 * per harness root keyed by `sha256(root)`, atomic temp+rename writes,
 * quarantine-on-corrupt (the registry is a rebuildable cache — a full
 * `prism refresh` over the installed set repopulates it), and the same tmp
 * fence against test-state pollution.
 */

import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import {
  ensureDir,
  exists,
  listDir,
  pathContains,
  readFile,
  removeFile,
  writeFile,
} from "../fs.js";

const SHIM_EXPOSURE_DIR_SEGMENTS = ["state", "shim-exposure"] as const;

export const SHIM_EXPOSURE_VERSION = 1 as const;

/**
 * One plugin's own shared-shim contribution: the owner plugins its compile
 * unit references (`PRISM_SHIM_PLUGINS` members) and its already-rendered
 * harness wire tool names (`enabled_tools` / `tools.include` members).
 */
export const ShimExposureContributionSchema = Schema.Struct({
  plugins: Schema.Array(Schema.String),
  enabledTools: Schema.Array(Schema.String),
});
export type ShimExposureContribution = typeof ShimExposureContributionSchema.Type;

const ShimExposureRegistryV1 = Schema.Struct({
  version: Schema.Literal(SHIM_EXPOSURE_VERSION),
  harness: Schema.String,
  root: Schema.String,
  entries: Schema.Record({
    key: Schema.String,
    value: ShimExposureContributionSchema,
  }),
});

export const ShimExposureRegistrySchema = ShimExposureRegistryV1;
export type ShimExposureRegistry = typeof ShimExposureRegistrySchema.Type;

const decodeShimExposureRegistry = Schema.decodeUnknownEither(ShimExposureRegistrySchema);

export const emptyShimExposureRegistry = (options: {
  readonly harness: string;
  readonly root: string;
}): ShimExposureRegistry => ({
  version: SHIM_EXPOSURE_VERSION,
  harness: options.harness,
  root: resolve(options.root),
  entries: {},
});

const uniqueSorted = (values: ReadonlyArray<string>): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

/** Deterministic union across contributions: sorted, deduped member-wise. */
export const unionShimExposure = (
  contributions: ReadonlyArray<ShimExposureContribution>,
): ShimExposureContribution => ({
  plugins: uniqueSorted(contributions.flatMap((entry) => entry.plugins)),
  enabledTools: uniqueSorted(contributions.flatMap((entry) => entry.enabledTools)),
});

/** Union of every recorded contribution EXCEPT `excludePlugin`'s own entry. */
export const priorShimExposureForPlugin = (
  registry: ShimExposureRegistry,
  excludePlugin: string,
): ShimExposureContribution =>
  unionShimExposure(
    Object.entries(registry.entries)
      .filter(([sourcePluginName]) => sourcePluginName !== excludePlugin)
      .map(([, contribution]) => contribution),
  );

export const shimExposureDir = (prismHome: string): string =>
  join(prismHome, ...SHIM_EXPOSURE_DIR_SEGMENTS);

export const shimExposurePath = (prismHome: string, root: string): string =>
  join(
    shimExposureDir(prismHome),
    `${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16)}.json`,
  );

export interface ShimExposureReadResult {
  readonly registry: ShimExposureRegistry;
  /** Set when a corrupt registry file was quarantined. */
  readonly quarantinedPath?: string;
}

export const readShimExposure = async (options: {
  readonly prismHome: string;
  readonly harness: string;
  readonly root: string;
}): Promise<ShimExposureReadResult> => {
  const path = shimExposurePath(options.prismHome, options.root);
  const empty = emptyShimExposureRegistry(options);
  if (!(await exists(path))) return { registry: empty };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path));
  } catch {
    const quarantinedPath = `${path}.corrupt-${Date.now()}.json`;
    await rename(path, quarantinedPath);
    return { registry: empty, quarantinedPath };
  }

  const decoded = decodeShimExposureRegistry(parsed);
  if (decoded._tag === "Right") return { registry: decoded.right };

  const quarantinedPath = `${path}.corrupt-${Date.now()}.json`;
  await rename(path, quarantinedPath);
  return { registry: empty, quarantinedPath };
};

const underTmp = (path: string): boolean => {
  const tmp = resolve(tmpdir());
  const resolved = resolve(path);
  return (
    pathContains(tmp, resolved) ||
    resolved.startsWith("/tmp/") ||
    resolved.startsWith("/private/tmp/") ||
    resolved.startsWith("/private/var/folders/") ||
    resolved.startsWith("/var/folders/")
  );
};

const encodeShimExposureRegistry = (registry: ShimExposureRegistry): string => {
  const sorted: ShimExposureRegistry = {
    ...registry,
    entries: Object.fromEntries(
      Object.entries(registry.entries)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([plugin, contribution]) => [
          plugin,
          {
            plugins: uniqueSorted(contribution.plugins),
            enabledTools: uniqueSorted(contribution.enabledTools),
          },
        ]),
    ),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
};

export const commitShimExposure = async (options: {
  readonly prismHome: string;
  readonly registry: ShimExposureRegistry;
}): Promise<void> => {
  if (underTmp(options.registry.root) && !underTmp(options.prismHome)) {
    throw new Error(
      `Refusing to persist a shim-exposure registry for tempdir root '${options.registry.root}' into ` +
        `non-tempdir PRISM_HOME '${options.prismHome}' — this is the test-pollution ` +
        `signature; sandbox PRISM_HOME for sandboxed roots.`,
    );
  }
  const path = shimExposurePath(options.prismHome, options.registry.root);
  await ensureDir(dirname(path));
  await writeFile(path, encodeShimExposureRegistry(options.registry));
};

/**
 * Read-modify-write of one plugin's entry: an empty contribution deletes it
 * (the plugin no longer participates in this root's shim), a non-empty one
 * upserts it. A registry left with zero entries is removed from disk.
 */
export const updateShimExposureEntry = async (options: {
  readonly prismHome: string;
  readonly harness: string;
  readonly root: string;
  readonly sourcePluginName: string;
  readonly contribution: ShimExposureContribution;
}): Promise<void> => {
  const { registry } = await readShimExposure(options);
  const entries = { ...registry.entries };
  const empty =
    options.contribution.plugins.length === 0 &&
    options.contribution.enabledTools.length === 0;
  if (empty) {
    if (!(options.sourcePluginName in entries)) return;
    delete entries[options.sourcePluginName];
  } else {
    entries[options.sourcePluginName] = options.contribution;
  }

  if (Object.keys(entries).length === 0) {
    const path = shimExposurePath(options.prismHome, options.root);
    if (await exists(path)) await removeFile(path);
    return;
  }

  await commitShimExposure({
    prismHome: options.prismHome,
    registry: { ...registry, harness: options.harness, entries },
  });
};

export interface ShimExposureGcResult {
  readonly dropped: ReadonlyArray<{ readonly path: string; readonly root: string }>;
}

/** Drop registries whose harness root no longer exists (mirrors `gcSnapshots`). */
export const gcShimExposure = async (prismHome: string): Promise<ShimExposureGcResult> => {
  const dir = shimExposureDir(prismHome);
  if (!(await exists(dir))) return { dropped: [] };

  const dropped: Array<{ path: string; root: string }> = [];
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
    const decoded = decodeShimExposureRegistry(parsed);
    if (decoded._tag === "Left") {
      await rename(path, `${path}.corrupt-${Date.now()}.json`);
      continue;
    }
    if (!(await exists(decoded.right.root))) {
      await removeFile(path);
      dropped.push({ path, root: decoded.right.root });
    }
  }
  return { dropped };
};
