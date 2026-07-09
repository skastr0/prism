/**
 * Load phase: discover source files in a plugin and parse them into typed
 * registry entries.
 *
 * Canonical structured artifacts are TypeScript-authored.
 */

import * as EffectModule from "effect";
import { Effect, Schema } from "effect";
import { createRequire } from "node:module";
import { basename, join, relative, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as TypeScript from "typescript";
import matter from "gray-matter";
import {
  Agent,
  AgentSchema,
  CanonicalTool,
  CanonicalToolSchema,
  Hook,
  HookDefinitionSchema,
  Identity,
  IdentityFrontmatter,
  Orbit,
  OrbitDefinitionSchema,
  Modelspace,
  ModelspaceSchema,
  Personality,
  PersonalityFrontmatter,
  Skill,
  Skillspace,
  SkillspaceSchema,
  Toolspace,
  ToolspaceSchema,
  Trait,
  TraitSchema,
  normalizeAgentRefInput,
  normalizeOrbitRefInput,
  normalizeModelProfileRefInput,
  normalizeSkillRefInput,
  normalizeToolGroupRefInput,
  normalizeToolRefInput,
  normalizeTraitRefInput,
  type Access,
  type HookToolMatcherInput,
  type OrbitDefinition,
  type OrbitToolPermissionTool,
  type NormalizedAccess,
  type NormalizedHookMatch,
  type NormalizedHookToolMatcher,
  type NormalizedOrbitOrchestrator,
  type NormalizedOrbitPhase,
  type NormalizedOrbitToolPermissionTool,
  type NormalizedTraitBinding,
  type NormalizedTraitBindingToolSlot,
  type SkillRefInput,
  type TraitBindingInput,
  type TraitRefInput,
} from "./sources.js";
import {
  AgentNameMismatchError,
  DependencyCycleError,
  DuplicateNameError,
  SourceParseError,
  type CompileError,
} from "./errors.js";
import { PluginManifestError } from "../errors.js";
import { resolvePrismHome } from "../prism-home.js";
import { deriveProjectKey, projectGeneratedAgentsPath, projectGeneratedRefsDir } from "../project-key.js";
import { packageNameFromSpecifier } from "./bundle-utils.js";
import { emptyRegistry, type PluginRegistry } from "./registry.js";
import { effectBundleImportPath, typescriptBundleImportPath } from "./runtime-deps.js";
import { AUTHORING_RUNTIME_JS, getAuthoringRuntimePath } from "./authoring-runtime.js";
import type { PluginManifestTargets, PluginRuntimeConfig } from "../types.js";
import {
  isPluginTargetId,
  SOURCE_NOUNS,
  validateSourceTargetSupport,
  type SourceNoun,
} from "../source-selection.js";

const ts = createRequire(import.meta.url)(typescriptBundleImportPath()) as typeof TypeScript;

const listDir = (path: string): Effect.Effect<string[]> =>
  Effect.tryPromise({
    try: async () => {
      const fs = await import("node:fs/promises");
      try {
        return await fs.readdir(path);
      } catch {
        return [];
      }
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => [] as string[]));

const fileExists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: () => Bun.file(path).exists(),
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false));

type SourceParseKind = SourceParseError["kind"];

const readText = (
  path: string,
  kind: SourceParseKind,
): Effect.Effect<string, SourceParseError> =>
  Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (cause) =>
      new SourceParseError({
        sourcePath: path,
        kind,
        message: `failed to read file: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const globalWithCompileRuntime = globalThis as typeof globalThis & {
  __prism_effect?: typeof EffectModule;
};
globalWithCompileRuntime.__prism_effect = EffectModule;

const importTsModule = <T>(
  sourcePath: string,
  kind: SourceParseKind,
): Effect.Effect<T, SourceParseError> =>
  Effect.tryPromise({
    try: async () => {
      const wrapper = await prepareImportWrapper(sourcePath);
      try {
        const mod = await import(wrapper.specifier);
        return mod.default as T;
      } finally {
        await wrapper.cleanup();
      }
    },
    catch: (cause) =>
      new SourceParseError({
        sourcePath,
        kind,
        message: formatImportError(cause),
      }),
  });

const makeEffectRuntimeJs = (): string => {
  const namedExports = Object.keys(EffectModule)
    .filter((key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && key !== "default")
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `export const ${key} = effect[${JSON.stringify(key)}];`)
    .join("\n");

  return `
const effect = globalThis.__prism_effect;
if (!effect) {
  throw new Error("prism Effect runtime bridge was not initialized");
}

${namedExports}

export default effect;
`;
};

/**
 * The workflow DSL runtime. Off-repo workflow files import { defineTask,
 * defineWorkflow } from "prism"; this module supplies those builders with
 * behavior identical to src/workflows.ts. Schema is read from the binary's
 * embedded Effect (globalThis.__prism_effect) so Schema.isSchema and
 * decodeTaskOutput operate on the binary's Effect instance.
 */
const WORKFLOW_DSL_RUNTIME_JS = `
const effect = globalThis.__prism_effect;
if (!effect) {
  throw new Error("prism Effect runtime bridge was not initialized");
}
const Schema = effect.Schema;

export const defineTask = (definition) => ({
  kind: "workflow-task",
  ...definition,
});

export function defineWorkflow(definition) {
  if ("run" in definition) {
    return {
      kind: "workflow",
      name: definition.name,
      tasks: [],
      run: definition.run,
    };
  }
  return {
    kind: "workflow",
    ...definition,
  };
}

export const decodeTaskOutput = (task, value) =>
  Schema.decodeUnknownEither(task.output)(value);
`;

let importRuntimePaths: Promise<{
  readonly authoring: string;
  readonly effect: string;
  readonly workflowDsl: string;
}> | undefined;

export const getImportRuntimePaths = async (): Promise<{
  readonly authoring: string;
  readonly effect: string;
  readonly workflowDsl: string;
}> => {
  importRuntimePaths ??= (async () => {
    const fs = await import("node:fs/promises");
    const authoringPath = await Effect.runPromise(getAuthoringRuntimePath());
    const dir = await fs.mkdtemp(join(tmpdir(), "prism-authoring-"));
    const effectPath = join(dir, "effect-runtime.mjs");
    const workflowDslPath = join(dir, "workflow-dsl-runtime.mjs");
    await fs.writeFile(effectPath, makeEffectRuntimeJs(), "utf8");
    await fs.writeFile(workflowDslPath, WORKFLOW_DSL_RUNTIME_JS, "utf8");
    return { authoring: authoringPath, effect: effectPath, workflowDsl: workflowDslPath };
  })();

  return importRuntimePaths;
};

const toFileSpecifier = (path: string): string => pathToFileURL(path).href;

const BARE_RUNTIME_IMPORT_PATTERN =
  /(\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?|\bimport\s*\(\s*)(["'])([^"'.][^"']*)\2/g;

const readPluginRuntimeDependencyNames = async (pluginRoot: string): Promise<ReadonlySet<string>> => {
  try {
    const raw = await Bun.file(join(pluginRoot, "package.json")).text();
    const parsed = JSON.parse(raw) as {
      readonly dependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
    };

    return new Set([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
};

const rewriteNodeSqliteImportForBun = (source: string): string =>
  source.replace(
    /^\s*import\s+\{([^}]+)\}\s+from\s+["']node:sqlite["'];?\s*$/gm,
    (_match, specifiers: string) =>
      specifiers
        .split(",")
        .map((specifier) => specifier.trim())
        .filter(Boolean)
        .map((specifier) => {
          const [imported, local] = specifier.split(/\s+as\s+/u).map((part) => part.trim());
          const localName = local || imported;
          if (imported === "DatabaseSync") {
            return `const ${localName} = class DatabaseSync { constructor() { throw new Error("node:sqlite DatabaseSync is unavailable during prism source parsing"); } };`;
          }
          return `const ${localName} = undefined;`;
        })
        .join("\n"),
  );

const rewritePluginRuntimeDependencyImports = async (
  source: string,
  pluginRoot: string,
): Promise<string> => {
  const runtimeDependencies = await readPluginRuntimeDependencyNames(pluginRoot);
  if (runtimeDependencies.size === 0) return source;

  const requireFromPlugin = createRequire(join(pluginRoot, "package.json"));
  const replacements = new Map<string, string>();

  for (const match of source.matchAll(BARE_RUNTIME_IMPORT_PATTERN)) {
    const specifier = match[3];
    if (!specifier || specifier === "prism" || specifier === "effect" || specifier.startsWith("node:")) {
      continue;
    }

    const packageName = packageNameFromSpecifier(specifier);
    if (!runtimeDependencies.has(packageName)) continue;

    try {
      replacements.set(specifier, requireFromPlugin.resolve(specifier).replace(/\\/g, "/"));
    } catch {
      // Leave unresolved specifiers untouched so the parse error points at the original import.
    }
  }

  if (replacements.size === 0) return source;

  return source.replace(BARE_RUNTIME_IMPORT_PATTERN, (match, prefix: string, quote: string, specifier: string) => {
    const replacement = replacements.get(specifier);
    return replacement ? `${prefix}${quote}${replacement}${quote}` : match;
  });
};

/**
 * Resolved targets for the three Prism-owned virtual specifiers. The
 * plugin-compile path maps `prism` to the identity-stub authoring runtime and
 * leaves `prism/refs` unmapped; the workflow path maps `prism` to the workflow
 * DSL runtime and `prism/refs` to the generated project refs file. The mode is
 * carried explicitly through this map, never via a global flag.
 */
interface LoadSpecifierOverrides {
  /** Target for bare `prism` imports. */
  readonly prism: string;
  /** Target for bare `effect` imports. */
  readonly effect: string;
  /** Target for bare `prism/refs` imports; absent when not applicable (plugin compile). */
  readonly prismRefs?: string;
  /** Targets for `prism/refs/<module>` imports; absent when not applicable. */
  readonly prismRefsModules?: Readonly<Record<string, string>>;
  /**
   * Optional absolute path to the local Prism source entry. When provided,
   * absolute imports pointing at this path are rewritten to bare `prism` so
   * they follow the same override as native bare imports. Used for hook bundle
   * preparation where test fixtures and local helpers may import the source
   * entry by absolute path.
   */
  readonly prismSourcePath?: string;
}

const escapeRegExpLiteral = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const replaceBareSpecifier = (
  source: string,
  specifier: string,
  target: string,
): string => {
  const escaped = escapeRegExpLiteral(specifier);
  return source
    .replace(
      new RegExp(`(\\bfrom\\s*)(["'])${escaped}\\2`, "g"),
      (_match, prefix) => `${prefix}${JSON.stringify(target)}`,
    )
    .replace(
      new RegExp(`(\\bimport\\s*\\(\\s*)(["'])${escaped}\\2(\\s*\\))`, "g"),
      (_match, prefix, _quote, suffix) => `${prefix}${JSON.stringify(target)}${suffix}`,
    );
};

const rewriteImportSpecifiers = async (
  source: string,
  overrides: LoadSpecifierOverrides,
  pluginRoot: string,
): Promise<string> => {
  const rewrittenBuiltins = rewriteNodeSqliteImportForBun(source);
  const rewrittenPluginDeps = await rewritePluginRuntimeDependencyImports(rewrittenBuiltins, pluginRoot);

  // `prism/refs` must be rewritten before bare `prism` so the longer specifier
  // wins (the bare-prism regex anchors on the closing quote and so cannot match
  // `prism/refs`, but order keeps the intent explicit).
  let rewritten = rewrittenPluginDeps;
  if (overrides.prismSourcePath !== undefined) {
    rewritten = replaceBareSpecifier(rewritten, overrides.prismSourcePath, "prism");
  }
  if (overrides.prismRefs !== undefined) {
    for (const [specifier, target] of Object.entries(overrides.prismRefsModules ?? {})) {
      rewritten = replaceBareSpecifier(rewritten, specifier, target);
    }
    rewritten = replaceBareSpecifier(rewritten, "prism/refs", overrides.prismRefs);
  }
  rewritten = replaceBareSpecifier(rewritten, "prism", overrides.prism);
  rewritten = replaceBareSpecifier(rewritten, "effect", overrides.effect);
  return rewritten;
};

const TRANSFORMED_PLUGIN_CACHE_TTL_MS = 30_000;
const MAX_TRANSFORMED_PLUGIN_CACHE_ENTRIES = 16;

interface TransformedPluginRoot {
  readonly cacheKey: string;
  readonly pluginRoot: string;
  readonly root: string;
  readonly outputParent: string;
  activeImports: number;
  lastUsed: number;
  cleanupTimer: ReturnType<typeof setTimeout> | undefined;
}

const transformedPluginRoots = new Map<string, Promise<TransformedPluginRoot>>();

const findPluginRoot = async (sourcePath: string): Promise<string> => {
  const fs = await import("node:fs/promises");
  let current = resolvePath(sourcePath, "..");

  while (true) {
    try {
      await fs.access(join(current, "plugin.json"));
      return current;
    } catch {
      const parent = resolvePath(current, "..");
      if (parent === current) {
        return resolvePath(sourcePath, "..");
      }
      current = parent;
    }
  }
};

const listTransformableTsFiles = async (
  root: string,
  base: string = root,
): Promise<string[]> => {
  const fs = await import("node:fs/promises");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const ignoredDirs = new Set([".agents", ".git", "dist", "node_modules"]);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      files.push(...await listTransformableTsFiles(entryPath, base));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relative(base, entryPath));
    }
  }

  return files;
};

const cleanupTransformedPluginRoot = async (
  entry: TransformedPluginRoot,
): Promise<void> => {
  if (entry.activeImports > 0) return;

  const current = await transformedPluginRoots.get(entry.cacheKey)?.catch(() => undefined);
  if (current !== entry) return;

  transformedPluginRoots.delete(entry.cacheKey);
  const fs = await import("node:fs/promises");
  await fs.rm(entry.outputParent, { recursive: true, force: true });
};

const scheduleTransformedPluginRootCleanup = (
  entry: TransformedPluginRoot,
): void => {
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  if (entry.activeImports > 0) return;

  entry.cleanupTimer = setTimeout(() => {
    entry.cleanupTimer = undefined;
    if (Date.now() - entry.lastUsed < TRANSFORMED_PLUGIN_CACHE_TTL_MS) {
      scheduleTransformedPluginRootCleanup(entry);
      return;
    }
    void cleanupTransformedPluginRoot(entry);
  }, TRANSFORMED_PLUGIN_CACHE_TTL_MS);
  entry.cleanupTimer.unref?.();
};

const pruneTransformedPluginRootCache = async (): Promise<void> => {
  if (transformedPluginRoots.size <= MAX_TRANSFORMED_PLUGIN_CACHE_ENTRIES) return;

  const entries = await Promise.all(
    [...transformedPluginRoots.values()].map((entry) =>
      entry.catch(() => undefined),
    ),
  );
  const inactive = entries
    .filter((entry): entry is TransformedPluginRoot =>
      entry !== undefined && entry.activeImports === 0,
    )
    .sort((left, right) => left.lastUsed - right.lastUsed);

  for (const entry of inactive) {
    if (transformedPluginRoots.size <= MAX_TRANSFORMED_PLUGIN_CACHE_ENTRIES) return;
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
      entry.cleanupTimer = undefined;
    }
    await cleanupTransformedPluginRoot(entry);
  }
};

const getTransformedPluginRoot = async (
  cacheKey: string,
  pluginRoot: string,
  overrides: LoadSpecifierOverrides,
): Promise<TransformedPluginRoot> => {
  const existing = transformedPluginRoots.get(cacheKey);
  if (existing) {
    const entry = await existing;
    entry.lastUsed = Date.now();
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
      entry.cleanupTimer = undefined;
    }
    return entry;
  }

  const pending = (async () => {
    const fs = await import("node:fs/promises");
    const outputParent = await fs.mkdtemp(join(tmpdir(), "prism-sources-"));
    await copyTransformedPluginTree({
      pluginRoot,
      outputParent,
      overrides,
      visited: new Set<string>(),
    });

    return {
      cacheKey,
      pluginRoot,
      root: join(outputParent, basename(pluginRoot)),
      outputParent,
      activeImports: 0,
      lastUsed: Date.now(),
      cleanupTimer: undefined,
    };
  })();

  transformedPluginRoots.set(cacheKey, pending);
  await pruneTransformedPluginRootCache();
  return pending;
};

const copyTransformedPluginTree = async (options: {
  readonly pluginRoot: string;
  readonly outputParent: string;
  readonly overrides: LoadSpecifierOverrides;
  readonly visited: Set<string>;
}): Promise<void> => {
  const fs = await import("node:fs/promises");
  const pluginRoot = resolvePath(options.pluginRoot);
  if (options.visited.has(pluginRoot)) return;
  options.visited.add(pluginRoot);

  const outputRoot = join(options.outputParent, basename(pluginRoot));
  const files = await listTransformableTsFiles(pluginRoot);

  await Promise.all(files.map(async (file) => {
    const sourcePath = join(pluginRoot, file);
    const targetPath = join(outputRoot, file);
    const source = await Bun.file(sourcePath).text();
    const rewritten = await rewriteImportSpecifiers(
      source,
      options.overrides,
      pluginRoot,
    );
    await fs.mkdir(resolvePath(targetPath, ".."), { recursive: true });
    await fs.writeFile(targetPath, rewritten, "utf8");
  }));

  const manifestPath = join(pluginRoot, "plugin.json");
  try {
    const manifest = await Bun.file(manifestPath).json() as {
      readonly deps?: Record<string, string>;
    };
    const depPaths = Object.values(manifest.deps ?? {});
    await Promise.all(depPaths.map((depPath) =>
      copyTransformedPluginTree({
        ...options,
        pluginRoot: resolvePath(pluginRoot, depPath),
      })
    ));
  } catch {
    // Source imports can still be standalone TS files in tests; no manifest is required.
  }
};

/**
 * The on-disk generated workflow refs file that `prism/refs` resolves to.
 * Machine-global, project-keyed: ~/.prism/state/projects/<key>/generated/
 * agents.ts, where the key is the project identity (toolchain & distribution
 * §4): git repository root of the process cwd, else realpath(cwd). An off-repo
 * workflow file run from inside a repo resolves to that repo's generated refs.
 */
const workflowRefsTargetPath = (): string => {
  const prismHome = resolvePrismHome();
  const { key } = deriveProjectKey();
  return projectGeneratedAgentsPath(prismHome, key);
};

const workflowRefsModuleTargets = (cacheBust: string): Record<string, string> => {
  const prismHome = resolvePrismHome();
  const { key } = deriveProjectKey();
  const refsDir = projectGeneratedRefsDir(prismHome, key);
  const modules = ["agents", "models", "skills", "traits", "orbits", "tools"] as const;
  return Object.fromEntries(
    modules.map((module) => [`prism/refs/${module}`, `${toFileSpecifier(join(refsDir, `${module}.ts`))}${cacheBust}`]),
  );
};

/**
 * Build the specifier overrides for a workflow load. `prism` resolves to the
 * workflow DSL runtime, `effect` to the embedded Effect bridge, and `prism/refs`
 * to the generated project refs file (cache-busted so refreshed refs are
 * re-read across runs in the same process).
 */
const workflowSpecifierOverrides = async (): Promise<LoadSpecifierOverrides> => {
  const runtimePaths = await getImportRuntimePaths();
  const cacheBust = `?t=${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    prism: toFileSpecifier(runtimePaths.workflowDsl),
    effect: toFileSpecifier(runtimePaths.effect),
    prismRefs: `${toFileSpecifier(workflowRefsTargetPath())}${cacheBust}`,
    prismRefsModules: workflowRefsModuleTargets(cacheBust),
  };
};

/** Build the specifier overrides for a plugin-compile load (`prism/refs` is not used). */
const pluginSpecifierOverrides = async (): Promise<LoadSpecifierOverrides> => {
  const runtimePaths = await getImportRuntimePaths();
  return {
    prism: toFileSpecifier(runtimePaths.authoring),
    effect: toFileSpecifier(runtimePaths.effect),
  };
};

export interface PrepareImportWrapperOptions {
  /** When true, resolve `prism`/`prism/refs` for workflow execution rather than plugin compilation. */
  readonly workflow?: boolean;
}

export const prepareImportWrapper = async (
  sourcePath: string,
  options: PrepareImportWrapperOptions = {},
): Promise<{
  readonly specifier: string;
  readonly transformedPath: string;
  readonly cleanup: () => Promise<void>;
}> => {
  const pluginRoot = await findPluginRoot(sourcePath);
  const mode = options.workflow ? "workflow" : "plugin";
  const overrides = options.workflow
    ? await workflowSpecifierOverrides()
    : await pluginSpecifierOverrides();
  const cacheKey = `${mode}:${pluginRoot}`;
  const transformed = await getTransformedPluginRoot(cacheKey, pluginRoot, overrides);
  transformed.activeImports += 1;
  transformed.lastUsed = Date.now();
  let cleaned = false;
  const transformedPath = join(transformed.root, relative(pluginRoot, sourcePath));

  return {
    specifier: `${toFileSpecifier(transformedPath)}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`,
    transformedPath,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      transformed.activeImports = Math.max(0, transformed.activeImports - 1);
      transformed.lastUsed = Date.now();
      scheduleTransformedPluginRootCleanup(transformed);
    },
  };
};

const normalizeImportPath = (path: string): string => path.replace(/\\/g, "/");

const pluginBundleSpecifierOverrides = async (): Promise<LoadSpecifierOverrides> => {
  const runtimePaths = await getImportRuntimePaths();
  return {
    prism: normalizeImportPath(runtimePaths.authoring),
    effect: normalizeImportPath(runtimePaths.effect),
  };
};

/**
 * Prepare a plugin source file for bundling by `bun build`.
 *
 * Unlike `prepareImportWrapper`, which produces `file:///` specifiers suitable
 * for runtime `import()`, this helper produces absolute POSIX paths so the
 * bundler can resolve `prism`/`effect` imports without relying on ambient
 * `node_modules`. The transformed plugin root is cached and cleaned up the
 * same way as `prepareImportWrapper`.
 */
export const prepareBundleSource = async (
  sourcePath: string,
): Promise<{ readonly transformedPath: string; readonly cleanup: () => Promise<void> }> => {
  const pluginRoot = await findPluginRoot(sourcePath);
  const overrides = await pluginBundleSpecifierOverrides();
  const cacheKey = `bundle:${pluginRoot}`;
  const transformed = await getTransformedPluginRoot(cacheKey, pluginRoot, overrides);
  transformed.activeImports += 1;
  transformed.lastUsed = Date.now();
  let cleaned = false;
  const transformedPath = join(transformed.root, relative(pluginRoot, sourcePath));

  return {
    transformedPath,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      transformed.activeImports = Math.max(0, transformed.activeImports - 1);
      transformed.lastUsed = Date.now();
      scheduleTransformedPluginRootCleanup(transformed);
    },
  };
};

const resolvePrismSourceEntry = async (): Promise<string> => {
  const url = await import.meta.resolve("../index.ts", import.meta.url);
  return normalizeImportPath(fileURLToPath(url));
};

const hookBundleSpecifierOverrides = async (): Promise<LoadSpecifierOverrides> => {
  const runtimePaths = await getImportRuntimePaths();
  return {
    // Hook bundles use the lightweight authoring runtime for `prism` rather
    // than the full source entry, because the bundled wrapper provides the
    // real execution environment and only needs the hook definition helpers.
    prism: normalizeImportPath(runtimePaths.authoring),
    effect: effectBundleImportPath(),
    // Normalize absolute imports that point back at the local Prism source
    // entry (common in test fixtures) to bare `prism` so they follow the same
    // override.
    prismSourcePath: await resolvePrismSourceEntry(),
    // `prism/refs` is not used in hook bundles.
  };
};

/**
 * Prepare a plugin source file for bundling into an executable hook wrapper.
 *
 * Unlike `prepareBundleSource`, which rewrites `prism` to the compile-time
 * authoring runtime stub, this helper rewrites `prism` to the real Prism source
 * entry so the bundled hook can execute. `effect` is rewritten to the same
 * runtime Effect module used by the wrapper, preventing duplicate Effect
 * instances. Absolute imports that point back at the local Prism source entry
 * (common in test fixtures and local helper files) are normalized to bare
 * `prism` first.
 */
export const prepareHookBundleSource = async (
  sourcePath: string,
): Promise<{ readonly transformedPath: string; readonly cleanup: () => Promise<void> }> => {
  const pluginRoot = await findPluginRoot(sourcePath);
  const overrides = await hookBundleSpecifierOverrides();
  // Hook bundles must reflect source edits made between compiles in the same
  // process (e.g. packaging a plugin, editing a hook, then packaging again).
  // The shared transformed-root cache keys only by pluginRoot, so a fresh copy
  // is built per bundle and removed immediately after.
  const fs = await import("node:fs/promises");
  const outputParent = await fs.mkdtemp(join(tmpdir(), "prism-hook-sources-"));
  await copyTransformedPluginTree({ pluginRoot, outputParent, overrides, visited: new Set<string>() });

  const transformedRoot = join(outputParent, basename(pluginRoot));
  const transformedPath = join(transformedRoot, relative(pluginRoot, sourcePath));
  let cleaned = false;

  return {
    transformedPath,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await fs.rm(outputParent, { recursive: true, force: true });
    },
  };
};

const formatImportError = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }

  if (typeof cause === "string" && cause.length > 0) {
    return cause;
  }

  try {
    const rendered = JSON.stringify(cause);
    if (rendered && rendered !== "{}") {
      return rendered;
    }
  } catch {
    // Fall through to the generic message.
  }

  return "failed to import TS module";
};

const IDENTITY_SUFFIX = ".identity.md";
const PERSONALITY_SUFFIX = ".personality.md";
const TRAIT_SUFFIX_TS = ".trait.ts";
const AGENT_SUFFIX_TS = ".agent.ts";
const TOOLSPACE_SUFFIX_TS = ".toolspace.ts";
const MODELSPACE_SUFFIX_TS = ".modelspace.ts";
const SKILLSPACE_SUFFIX_TS = ".skillspace.ts";
const ORBIT_SUFFIX_TS = ".orbit.ts";
const TOOL_SUFFIX_TS = ".tool.ts";
const HOOK_SUFFIX_TS = ".hook.ts";

const stripSuffix = (fileName: string, suffixes: string[]): string => {
  for (const suffix of suffixes) {
    if (fileName.endsWith(suffix)) {
      return fileName.slice(0, fileName.length - suffix.length);
    }
  }

  return fileName;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

const forbiddenFieldError = (
  sourcePath: string,
  kind: SourceParseKind,
  field: string,
  message: string,
): SourceParseError =>
  new SourceParseError({
    sourcePath,
    kind,
    message: `${field}: ${message}`,
  });

const normalizeAccess = (
  sourcePath: string,
  kind: SourceParseKind,
  field: string,
  access: Access | undefined,
): NormalizedAccess | SourceParseError => {
  const tools: string[] = [];
  for (const [index, tool] of (access?.tools ?? []).entries()) {
    const normalized = normalizeToolRefInput(`${field}.tools[${index}]`, tool);
    if (typeof normalized !== "string") {
      return new SourceParseError({
        sourcePath,
        kind,
        message: `${normalized.field}: ${normalized.message}`,
      });
    }
    tools.push(normalized);
  }

  const toolGroups: string[] = [];
  for (const [index, toolGroup] of (access?.toolGroups ?? []).entries()) {
    const normalized = normalizeToolGroupRefInput(
      `${field}.toolGroups[${index}]`,
      toolGroup,
    );
    if (typeof normalized !== "string") {
      return new SourceParseError({
        sourcePath,
        kind,
        message: `${normalized.field}: ${normalized.message}`,
      });
    }
    toolGroups.push(normalized);
  }

  const skills: string[] = [];
  for (const [index, skill] of (access?.skills ?? []).entries()) {
    const normalized = normalizeSkillRefInput(`${field}.skills[${index}]`, skill);
    if (typeof normalized !== "string") {
      return new SourceParseError({
        sourcePath,
        kind,
        message: `${normalized.field}: ${normalized.message}`,
      });
    }
    skills.push(normalized);
  }

  return { tools, toolGroups, skills };
};

const normalizeSkillRefs = (
  sourcePath: string,
  kind: SourceParseKind,
  field: string,
  skills: readonly SkillRefInput[] | undefined,
): string[] | SourceParseError => {
  const normalizedSkills: string[] = [];
  for (const [index, skill] of (skills ?? []).entries()) {
    const normalized = normalizeSkillRefInput(`${field}[${index}]`, skill);
    if (typeof normalized !== "string") {
      return new SourceParseError({
        sourcePath,
        kind,
        message: `${normalized.field}: ${normalized.message}`,
      });
    }
    normalizedSkills.push(normalized);
  }
  return normalizedSkills;
};

const normalizeHookToolMatcher = (
  sourcePath: string,
  field: string,
  matcher: HookToolMatcherInput,
): NormalizedHookToolMatcher | SourceParseError => {
  switch (matcher.kind) {
    case "hook-any-tool":
      return { kind: "any" };
    case "hook-toolspace-tool": {
      const normalized = normalizeToolRefInput(`${field}.tool`, matcher.tool);
      if (typeof normalized !== "string") {
        return new SourceParseError({
          sourcePath,
          kind: "hook",
          message: `${normalized.field}: ${normalized.message}`,
        });
      }
      return { kind: "toolspace-tool", ref: normalized };
    }
    case "hook-toolspace-group": {
      const normalized = normalizeToolGroupRefInput(`${field}.group`, matcher.group);
      if (typeof normalized !== "string") {
        return new SourceParseError({
          sourcePath,
          kind: "hook",
          message: `${normalized.field}: ${normalized.message}`,
        });
      }
      return { kind: "toolspace-group", ref: normalized };
    }
    case "hook-canonical-tool": {
      const ref = matcher.ref.trim();
      if (!ref) {
        return new SourceParseError({
          sourcePath,
          kind: "hook",
          message: `${field}.ref: must be a non-empty canonical tool reference`,
        });
      }
      return { kind: "canonical-tool", ref };
    }
  }
};

const normalizeHookMatch = (
  sourcePath: string,
  event: Hook["event"],
  match: { readonly tool?: HookToolMatcherInput } | undefined,
): NormalizedHookMatch | SourceParseError => {
  if (!match?.tool) return {};
  if (event !== "tool.before" && event !== "tool.after" && event !== "permission.request") {
    return new SourceParseError({
      sourcePath,
      kind: "hook",
      message: `match.tool is only supported for tool.before, tool.after, and permission.request hooks`,
    });
  }

  const tool = normalizeHookToolMatcher(sourcePath, "match.tool", match.tool);
  if (tool instanceof SourceParseError) return tool;
  return { tool };
};

const FORBIDDEN_HOOK_FIELDS = [
  "agent",
  "agents",
  "trait",
  "traits",
  "slot",
  "slots",
] as const;

const unsupportedHookFieldError = (
  sourcePath: string,
  raw: unknown,
): SourceParseError | undefined => {
  if (!isRecord(raw)) return undefined;
  for (const field of FORBIDDEN_HOOK_FIELDS) {
    if (!hasOwn(raw, field)) continue;
    return forbiddenFieldError(
      sourcePath,
      "hook",
      field,
      "is not supported in hook V1; hooks are plugin-level and are not agent-bound, trait-bound, or slot-specialized",
    );
  }
  return undefined;
};

const isEffectSchema = (value: unknown): value is Schema.Schema.AnyNoContext =>
  Schema.isSchema(value);

interface SchemaSymbolSource {
  readonly sourcePath: string;
  readonly exportName: string;
}

type BindingToolSlotSources = Map<number, Map<string, Map<string, SchemaSymbolSource>>>;

const propertyNameText = (name: TypeScript.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
};

const unwrapExpression = (
  value: TypeScript.Expression,
): TypeScript.Expression => {
  let expression = value;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
};

const objectProperty = (
  object: TypeScript.ObjectLiteralExpression | undefined,
  name: string,
): TypeScript.Expression | undefined => {
  if (!object) return undefined;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = propertyNameText(property.name);
    if (propertyName === name) return property.initializer;
  }
  return undefined;
};

const asObjectLiteral = (
  value: TypeScript.Expression | undefined,
): TypeScript.ObjectLiteralExpression | undefined => {
  if (!value) return undefined;
  const expression = unwrapExpression(value);
  return ts.isObjectLiteralExpression(expression) ? expression : undefined;
};

const asArrayLiteral = (
  value: TypeScript.Expression | undefined,
): TypeScript.ArrayLiteralExpression | undefined => {
  if (!value) return undefined;
  const expression = unwrapExpression(value);
  return ts.isArrayLiteralExpression(expression) ? expression : undefined;
};

const resolveImportedModuleSource = (
  sourcePath: string,
  moduleSpecifier: string,
): string => {
  if (moduleSpecifier.startsWith(".")) {
    const resolved = resolvePath(sourcePath, "..", moduleSpecifier);
    return resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
  }
  if (moduleSpecifier.startsWith("/")) {
    return moduleSpecifier.endsWith(".ts") ? moduleSpecifier : `${moduleSpecifier}.ts`;
  }
  return moduleSpecifier;
};

const collectImportedSchemaSymbols = (
  sourcePath: string,
  source: TypeScript.SourceFile,
): Map<string, SchemaSymbolSource> => {
  const imports = new Map<string, SchemaSymbolSource>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleSource = resolveImportedModuleSource(sourcePath, statement.moduleSpecifier.text);
    const clause = statement.importClause;
    if (!clause) continue;

    if (clause.name) {
      imports.set(clause.name.text, {
        sourcePath: moduleSource,
        exportName: "default",
      });
    }

    const namedBindings = clause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const element of namedBindings.elements) {
      imports.set(element.name.text, {
        sourcePath: moduleSource,
        exportName: element.propertyName?.text ?? element.name.text,
      });
    }
  }

  return imports;
};

const collectBindingToolSlotSources = (
  sourcePath: string,
  sourceText: string,
): BindingToolSlotSources => {
  const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const importedSymbols = collectImportedSchemaSymbols(sourcePath, source);
  const result: BindingToolSlotSources = new Map();
  const declaredExpressions = new Map<string, TypeScript.Expression>();

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.initializer) {
        declaredExpressions.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  const collectFromTraitOptions = (
    traitIndex: number,
    options: TypeScript.ObjectLiteralExpression | undefined,
  ): void => {
    const tools = asObjectLiteral(objectProperty(options, "tools"));
    if (!tools) return;

    const byTool = new Map<string, Map<string, SchemaSymbolSource>>();
    for (const toolProperty of tools.properties) {
      if (!ts.isPropertyAssignment(toolProperty)) continue;
      const logicalName = propertyNameText(toolProperty.name);
      const toolOptions = asObjectLiteral(toolProperty.initializer);
      const slots = asObjectLiteral(objectProperty(toolOptions, "slots"));
      if (!logicalName || !slots) continue;

      const bySlot = new Map<string, SchemaSymbolSource>();
      for (const slotProperty of slots.properties) {
        if (!ts.isPropertyAssignment(slotProperty)) continue;
        const slotName = propertyNameText(slotProperty.name);
        if (!slotName || !ts.isIdentifier(slotProperty.initializer)) continue;
        const imported = importedSymbols.get(slotProperty.initializer.text);
        if (imported) bySlot.set(slotName, imported);
      }
      byTool.set(logicalName, bySlot);
    }
    result.set(traitIndex, byTool);
  };

  const collectFromBindTrait = (
    traitIndex: number,
    call: TypeScript.CallExpression,
  ): void => {
    collectFromTraitOptions(traitIndex, asObjectLiteral(call.arguments[1]));
  };

  const collectFromTraitExpression = (
    traitIndex: number,
    value: TypeScript.Expression,
    seenIdentifiers: Set<string> = new Set(),
  ): void => {
    const expression = unwrapExpression(value);
    if (ts.isIdentifier(expression)) {
      if (seenIdentifiers.has(expression.text)) return;
      const declared = declaredExpressions.get(expression.text);
      if (!declared) return;
      collectFromTraitExpression(
        traitIndex,
        declared,
        new Set([...seenIdentifiers, expression.text]),
      );
      return;
    }

    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "bindTrait"
    ) {
      collectFromBindTrait(traitIndex, expression);
      return;
    }

    const object = asObjectLiteral(expression);
    if (object && objectProperty(object, "trait")) {
      collectFromTraitOptions(traitIndex, object);
    }
  };

  const collectFromTraitElement = (
    traitIndex: number,
    element: TypeScript.Expression | TypeScript.SpreadElement,
  ): void => {
    if (ts.isSpreadElement(element)) return;
    collectFromTraitExpression(traitIndex, element);
  };

  const collectFromAgentObject = (
    agent: TypeScript.ObjectLiteralExpression | undefined,
  ): void => {
    const traits = asArrayLiteral(objectProperty(agent, "traits"));
    if (!traits) return;

    for (const [traitIndex, element] of traits.elements.entries()) {
      collectFromTraitElement(traitIndex, element);
    }
  };

  const collectFromAgentExpression = (
    expression: TypeScript.Expression,
    seenIdentifiers: Set<string> = new Set(),
  ): boolean => {
    const unwrapped = unwrapExpression(expression);
    if (
      ts.isCallExpression(unwrapped) &&
      ts.isIdentifier(unwrapped.expression) &&
      unwrapped.expression.text === "defineAgent"
    ) {
      collectFromAgentObject(asObjectLiteral(unwrapped.arguments[0]));
      return true;
    }

    if (ts.isObjectLiteralExpression(unwrapped)) {
      collectFromAgentObject(unwrapped);
      return true;
    }

    if (ts.isIdentifier(unwrapped)) {
      if (seenIdentifiers.has(unwrapped.text)) return false;
      const declared = declaredExpressions.get(unwrapped.text);
      if (declared) {
        return collectFromAgentExpression(
          declared,
          new Set([...seenIdentifiers, unwrapped.text]),
        );
      }
    }

    return false;
  };

  const visit = (node: TypeScript.Node): void => {
    if (ts.isExportAssignment(node)) {
      if (collectFromAgentExpression(node.expression)) return;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineAgent"
    ) {
      collectFromAgentExpression(node);
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return result;
};

const normalizeTraitInstructions = (
  instructions: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  if (instructions === undefined) return [];
  const values = typeof instructions === "string" ? [instructions] : instructions;
  return values
    .map((instruction) => instruction.trim())
    .filter((instruction) => instruction.length > 0);
};

const parseIdentity = (sourcePath: string): Effect.Effect<Identity, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* readText(sourcePath, "identity");

    if (!raw.startsWith("---")) {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "identity",
          message: "missing YAML frontmatter (file must start with ---)",
        }),
      );
    }

    const { data, content } = matter(raw);
    const result = Schema.decodeUnknownEither(IdentityFrontmatter)(data);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "identity",
          message: `invalid frontmatter: ${result.left.message}`,
        }),
      );
    }

    const fileName = basename(sourcePath);
    const name = fileName.slice(0, fileName.length - IDENTITY_SUFFIX.length);

    return new Identity({
      name,
      sourcePath,
      description: result.right.description,
      body: content.trim(),
    });
  });

const loadIdentities = (
  pluginPath: string,
): Effect.Effect<Map<string, Identity>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "identities");
    const entries = yield* listDir(dir);
    const map = new Map<string, Identity>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(IDENTITY_SUFFIX)) continue;
      const identity = yield* parseIdentity(join(dir, entry));
      const existing = map.get(identity.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "identity",
            name: identity.name,
            firstPath: existing.sourcePath,
            secondPath: identity.sourcePath,
          }),
        );
      }
      map.set(identity.name, identity);
    }

    return map;
  });

const parsePersonality = (
  sourcePath: string,
): Effect.Effect<Personality, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* readText(sourcePath, "personality");

    if (!raw.startsWith("---")) {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "personality",
          message: "missing YAML frontmatter",
        }),
      );
    }

    const { data, content } = matter(raw);
    const result = Schema.decodeUnknownEither(PersonalityFrontmatter)(data);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "personality",
          message: `invalid frontmatter: ${result.left.message}`,
        }),
      );
    }

    const fm = result.right;
    return new Personality({
      name: fm.name,
      sourcePath,
      description: fm.description,
      temperament: fm.temperament,
      orientation: fm.orientation,
      virtues: fm.virtues,
      integration: fm.integration,
      communication: fm.communication,
      body: content.trim(),
    });
  });

const loadPersonalities = (
  pluginPath: string,
): Effect.Effect<Map<string, Personality>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "personalities");
    const entries = yield* listDir(dir);
    const map = new Map<string, Personality>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(PERSONALITY_SUFFIX)) continue;
      const personality = yield* parsePersonality(join(dir, entry));
      const existing = map.get(personality.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "personality",
            name: personality.name,
            firstPath: existing.sourcePath,
            secondPath: personality.sourcePath,
          }),
        );
      }
      map.set(personality.name, personality);
    }

    return map;
  });

type TraitDefinitionInput = typeof TraitSchema.Type;

const normalizeTraitTools = (
  sourcePath: string,
  toolsInput: TraitDefinitionInput["tools"],
): Record<string, Trait["tools"][string]> | SourceParseError => {
  const tools: Record<string, Trait["tools"][string]> = {};
  for (const [toolName, tool] of Object.entries(toolsInput ?? {})) {
    if (!tool.ref || typeof tool.ref !== "string" || tool.ref.trim().length === 0) {
      return new SourceParseError({
        sourcePath,
        kind: "trait",
        message: `tools.${toolName}.ref: must be a non-empty canonical tool reference`,
      });
    }

    const attachment: Record<string, unknown> = { ref: tool.ref };

    tools[toolName] = attachment as Trait["tools"][string];
  }
  return tools;
};

const buildTrait = (
  sourcePath: string,
  parsed: TraitDefinitionInput,
  access: NormalizedAccess,
  tools: Record<string, Trait["tools"][string]>,
  injectedSkills: string[],
  requiredSkills: string[],
): Trait =>
  new Trait({
    name: parsed.name,
    sourcePath,
    description: parsed.description,
    instructions: normalizeTraitInstructions(parsed.instructions),
    access,
    tools,
    inject: {
      skills: injectedSkills,
    },
    require: {
      tools: parsed.require?.tools ?? [],
      skills: requiredSkills,
    },
  });

const parseTraitDefinition = (
  sourcePath: string,
  raw: unknown,
): Effect.Effect<Trait, CompileError> =>
  Effect.gen(function* () {
    const result = Schema.decodeUnknownEither(TraitSchema, STRICT_PARSE_OPTIONS)(raw);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "trait",
          message: result.left.message,
        }),
      );
    }

    const parsed = result.right;

    const access = normalizeAccess(sourcePath, "trait", "access", parsed.access);
    if (access instanceof SourceParseError) {
      return yield* Effect.fail(access);
    }

    const tools = normalizeTraitTools(sourcePath, parsed.tools);
    if (tools instanceof SourceParseError) {
      return yield* Effect.fail(tools);
    }

    const injectedSkills = normalizeSkillRefs(
      sourcePath,
      "trait",
      "inject.skills",
      parsed.inject?.skills,
    );
    if (injectedSkills instanceof SourceParseError) {
      return yield* Effect.fail(injectedSkills);
    }

    const requiredSkills = normalizeSkillRefs(
      sourcePath,
      "trait",
      "require.skills",
      parsed.require?.skills,
    );
    if (requiredSkills instanceof SourceParseError) {
      return yield* Effect.fail(requiredSkills);
    }

    return buildTrait(sourcePath, parsed, access, tools, injectedSkills, requiredSkills);
  });

const parseTrait = (sourcePath: string): Effect.Effect<Trait, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "trait");

    return yield* parseTraitDefinition(sourcePath, raw);
  });

const loadTraits = (
  pluginPath: string,
): Effect.Effect<Map<string, Trait>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "traits");
    const entries = yield* listDir(dir);
    const map = new Map<string, Trait>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(TRAIT_SUFFIX_TS)) continue;
      const trait = yield* parseTrait(join(dir, entry));
      const existing = map.get(trait.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "trait",
            name: trait.name,
            firstPath: existing.sourcePath,
            secondPath: trait.sourcePath,
          }),
        );
      }
      map.set(trait.name, trait);
    }

    return map;
  });

type AgentDefinitionInput = typeof AgentSchema.Type;
type AgentTraitInput = TraitRefInput | TraitBindingInput;
type AgentTraitBindingInput = TraitBindingInput;
type AgentTraitBindingToolInput = {
  readonly slots?: Readonly<Record<string, unknown>>;
};
type NormalizedAgentTraitTools = Record<
  string,
  { slots: Record<string, NormalizedTraitBindingToolSlot> }
>;

const agentSourceParseError = (
  sourcePath: string,
  message: string,
): SourceParseError =>
  new SourceParseError({
    sourcePath,
    kind: "agent",
    message,
  });

const decodeAgentDefinition = (
  sourcePath: string,
  raw: unknown,
): AgentDefinitionInput | SourceParseError => {
  const result = Schema.decodeUnknownEither(AgentSchema, STRICT_PARSE_OPTIONS)(raw);
  if (result._tag === "Right") return result.right;

  return agentSourceParseError(sourcePath, result.left.message);
};

const validateAgentFileName = (
  sourcePath: string,
  parsed: AgentDefinitionInput,
): AgentNameMismatchError | undefined => {
  const fileName = basename(sourcePath);
  const fileStem = stripSuffix(fileName, [AGENT_SUFFIX_TS]);
  if (parsed.name === fileStem) return undefined;

  return new AgentNameMismatchError({
    sourcePath,
    fileStem,
    agentName: parsed.name,
  });
};

const isAgentTraitBinding = (
  trait: AgentTraitInput,
): trait is AgentTraitBindingInput =>
  typeof trait !== "string" && "trait" in trait;

const agentTraitRefInput = (
  trait: AgentTraitInput,
): Parameters<typeof normalizeTraitRefInput>[1] =>
  isAgentTraitBinding(trait) ? trait.trait : trait;

const normalizeAgentTraitRef = (
  sourcePath: string,
  index: number,
  trait: AgentTraitInput,
): string | SourceParseError => {
  const normalized = normalizeTraitRefInput(
    `traits[${index}]`,
    agentTraitRefInput(trait),
  );
  if (typeof normalized === "string") return normalized;

  return agentSourceParseError(
    sourcePath,
    `${normalized.field}: ${normalized.message}`,
  );
};

const normalizeAgentTraitToolSlots = (
  sourcePath: string,
  traitIndex: number,
  logicalName: string,
  toolBinding: AgentTraitBindingToolInput,
  sourceSlots: Map<string, SchemaSymbolSource>,
): Record<string, NormalizedTraitBindingToolSlot> | SourceParseError => {
  const normalizedSlots: Record<string, NormalizedTraitBindingToolSlot> = {};

  for (const [slotName, schema] of Object.entries(toolBinding.slots ?? {})) {
    const field = `traits[${traitIndex}].tools.${logicalName}.slots.${slotName}`;
    if (!isEffectSchema(schema)) {
      return agentSourceParseError(
        sourcePath,
        `${field}: must be an Effect Schema`,
      );
    }

    const source = sourceSlots.get(slotName);
    if (!source) {
      return agentSourceParseError(
        sourcePath,
        (
          `${field}: ` +
          "must be an imported schema identifier; inline Effect Schema expressions are not supported"
        ),
      );
    }
    normalizedSlots[slotName] = { schema, source };
  }

  return normalizedSlots;
};

const normalizeAgentTraitTools = (
  sourcePath: string,
  traitIndex: number,
  trait: AgentTraitBindingInput,
  sourceTools: Map<string, Map<string, SchemaSymbolSource>>,
): NormalizedAgentTraitTools | SourceParseError => {
  const tools: NormalizedAgentTraitTools = {};

  for (const [logicalName, toolBinding] of Object.entries(trait.tools ?? {})) {
    const normalizedSlots = normalizeAgentTraitToolSlots(
      sourcePath,
      traitIndex,
      logicalName,
      toolBinding,
      sourceTools.get(logicalName) ?? new Map(),
    );
    if (normalizedSlots instanceof SourceParseError) return normalizedSlots;

    tools[logicalName] = { slots: normalizedSlots };
  }

  return tools;
};

const normalizeAgentTraits = (
  sourcePath: string,
  traitsInput: AgentDefinitionInput["traits"],
  bindingToolSlotSources: BindingToolSlotSources,
): NormalizedTraitBinding[] | SourceParseError => {
  const traits: NormalizedTraitBinding[] = [];

  for (const [index, trait] of (traitsInput ?? []).entries()) {
    const normalized = normalizeAgentTraitRef(sourcePath, index, trait);
    if (normalized instanceof SourceParseError) return normalized;

    const tools = isAgentTraitBinding(trait)
      ? normalizeAgentTraitTools(
          sourcePath,
          index,
          trait,
          bindingToolSlotSources.get(index) ?? new Map(),
        )
      : {};
    if (tools instanceof SourceParseError) return tools;

    traits.push({ ref: normalized, tools });
  }

  return traits;
};

const normalizeAgentModel = (
  sourcePath: string,
  modelInput: AgentDefinitionInput["model"],
): string | undefined | SourceParseError => {
  const model = modelInput
    ? normalizeModelProfileRefInput("model", modelInput)
    : undefined;
  if (!model) return undefined;

  if (typeof model !== "string") {
    return agentSourceParseError(
      sourcePath,
      `${model.field}: ${model.message}`,
    );
  }

  if (!model.includes("/")) {
    return forbiddenFieldError(
      sourcePath,
      "agent",
      "model",
      "must reference a canonical model profile (<modelspace>/<name> or modelProfileRef(...))",
    );
  }

  return model;
};

const buildAgent = (
  sourcePath: string,
  parsed: AgentDefinitionInput,
  parts: {
    readonly traits: NormalizedTraitBinding[];
    readonly model?: string;
    readonly access: NormalizedAccess;
    readonly skills: string[];
  },
): Agent =>
  new Agent({
    name: parsed.name,
    sourcePath,
    description: parsed.description,
    identity: parsed.identity,
    personality: parsed.personality,
    ...(parts.model ? { model: parts.model } : {}),
    traits: parts.traits,
    access: parts.access,
    skills: parts.skills,
    color: parsed.color,
    targets: parsed.targets ?? {},
  });

const parseAgentModule = (
  sourcePath: string,
  raw: unknown,
): Effect.Effect<Agent, CompileError> =>
  Effect.gen(function* () {
    const sourceText = yield* readText(sourcePath, "agent");
    const bindingToolSlotSources = collectBindingToolSlotSources(sourcePath, sourceText);

    const parsed = decodeAgentDefinition(sourcePath, raw);
    if (parsed instanceof SourceParseError) return yield* Effect.fail(parsed);

    const nameMismatch = validateAgentFileName(sourcePath, parsed);
    if (nameMismatch) return yield* Effect.fail(nameMismatch);

    const traits = normalizeAgentTraits(
      sourcePath,
      parsed.traits,
      bindingToolSlotSources,
    );
    if (traits instanceof SourceParseError) return yield* Effect.fail(traits);

    const model = normalizeAgentModel(sourcePath, parsed.model);
    if (model instanceof SourceParseError) return yield* Effect.fail(model);

    const access = normalizeAccess(sourcePath, "agent", "access", parsed.access);
    if (access instanceof SourceParseError) return yield* Effect.fail(access);

    const skills = normalizeSkillRefs(sourcePath, "agent", "skills", parsed.skills);
    if (skills instanceof SourceParseError) return yield* Effect.fail(skills);

    return buildAgent(sourcePath, parsed, { traits, model, access, skills });
  });

const parseAgent = (sourcePath: string): Effect.Effect<Agent, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "agent");

    return yield* parseAgentModule(sourcePath, raw);
  });

const loadAgentsFromDir = (
  dir: string,
  entries: string[],
  suffixes: readonly string[],
  map: Map<string, Agent>,
): Effect.Effect<void, CompileError> =>
  Effect.gen(function* () {
    for (const entry of entries.sort()) {
      if (!suffixes.some((suffix) => entry.endsWith(suffix))) continue;
      const agent = yield* parseAgent(join(dir, entry));
      const existing = map.get(agent.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "agent",
            name: agent.name,
            firstPath: existing.sourcePath,
            secondPath: agent.sourcePath,
          }),
        );
      }
      map.set(agent.name, agent);
    }
  });

const loadAgents = (
  pluginPath: string,
): Effect.Effect<Map<string, Agent>, CompileError> =>
  Effect.gen(function* () {
    const map = new Map<string, Agent>();

    const agentsDir = join(pluginPath, "agents");
    yield* loadAgentsFromDir(
      agentsDir,
      yield* listDir(agentsDir),
      [AGENT_SUFFIX_TS],
      map,
    );

    return map;
  });

const parseToolspace = (
  sourcePath: string,
): Effect.Effect<Toolspace, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "toolspace");
    const result = Schema.decodeUnknownEither(ToolspaceSchema)(raw);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "toolspace",
          message: result.left.message,
        }),
      );
    }

    const tools = Object.fromEntries(
      Object.entries(result.right.tools).map(([name, definition]) => [
        name,
        {
          description: definition.description,
          targets: Object.fromEntries(
            Object.entries(definition.targets).map(([target, binding]) => [target, binding.name]),
          ),
        },
      ]),
    );

    const groups: Record<string, { description?: string; tools: string[] }> = {};
    for (const [groupName, group] of Object.entries(result.right.groups ?? {})) {
      const normalizedTools: string[] = [];
      for (const [index, tool] of group.tools.entries()) {
        const normalized = normalizeToolRefInput(`groups.${groupName}.tools[${index}]`, tool);
        if (typeof normalized !== "string") {
          return yield* Effect.fail(
            new SourceParseError({
              sourcePath,
              kind: "toolspace",
              message: `${normalized.field}: ${normalized.message}`,
            }),
          );
        }
        normalizedTools.push(normalized);
      }
      groups[groupName] = { description: group.description, tools: normalizedTools };
    }

    return new Toolspace({
      name: result.right.name,
      sourcePath,
      description: result.right.description,
      tools,
      groups,
    });
  });

const loadToolspaces = (
  pluginPath: string,
): Effect.Effect<Map<string, Toolspace>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "toolspaces");
    const entries = yield* listDir(dir);
    const map = new Map<string, Toolspace>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(TOOLSPACE_SUFFIX_TS)) continue;
      const toolspace = yield* parseToolspace(join(dir, entry));
      const existing = map.get(toolspace.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "toolspace",
            name: toolspace.name,
            firstPath: existing.sourcePath,
            secondPath: toolspace.sourcePath,
          }),
        );
      }
      map.set(toolspace.name, toolspace);
    }

    return map;
  });

const parseModelspace = (
  sourcePath: string,
): Effect.Effect<Modelspace, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "modelspace");
    const result = Schema.decodeUnknownEither(ModelspaceSchema)(raw);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "modelspace",
          message: result.left.message,
        }),
      );
    }

    return new Modelspace({
      name: result.right.name,
      sourcePath,
      description: result.right.description,
      profiles: result.right.profiles,
    });
  });

const loadModelspaces = (
  pluginPath: string,
): Effect.Effect<Map<string, Modelspace>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "modelspaces");
    const entries = yield* listDir(dir);
    const map = new Map<string, Modelspace>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(MODELSPACE_SUFFIX_TS)) continue;
      const modelspace = yield* parseModelspace(join(dir, entry));
      const existing = map.get(modelspace.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "modelspace",
            name: modelspace.name,
            firstPath: existing.sourcePath,
            secondPath: modelspace.sourcePath,
          }),
        );
      }
      map.set(modelspace.name, modelspace);
    }

    return map;
  });

const parseSkillspace = (
  sourcePath: string,
): Effect.Effect<Skillspace, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "skillspace");
    const result = Schema.decodeUnknownEither(SkillspaceSchema)(raw);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "skillspace",
          message: result.left.message,
        }),
      );
    }

    return new Skillspace({
      name: result.right.name,
      sourcePath,
      description: result.right.description,
      skills: result.right.skills,
    });
  });

const loadSkillspaces = (
  pluginPath: string,
): Effect.Effect<Map<string, Skillspace>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "skillspaces");
    const entries = yield* listDir(dir);
    const map = new Map<string, Skillspace>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(SKILLSPACE_SUFFIX_TS)) continue;
      const skillspace = yield* parseSkillspace(join(dir, entry));
      const existing = map.get(skillspace.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "skillspace",
            name: skillspace.name,
            firstPath: existing.sourcePath,
            secondPath: skillspace.sourcePath,
          }),
        );
      }
      map.set(skillspace.name, skillspace);
    }

    return map;
  });

const loadSkills = (
  pluginPath: string,
): Effect.Effect<Map<string, Skill>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "skills");
    const entries = yield* listDir(dir);
    const map = new Map<string, Skill>();

    for (const entry of entries.sort()) {
      const sourcePath = join(dir, entry, "SKILL.md");
      if (!(yield* fileExists(sourcePath))) continue;
      map.set(entry, new Skill({ name: entry, sourcePath }));
    }

    return map;
  });

type NormalizedPhaseOrbitBinding = {
  readonly orbit: string;
  readonly bindings?: Record<string, string>;
};

type NormalizedPhaseRequirement = {
  readonly all: string[];
  readonly min?: number;
};

type NormalizedPhaseAgents = {
  readonly agents: string[];
};

const orbitSourceParseError = (
  sourcePath: string,
  field: string,
  message: string,
): SourceParseError =>
  new SourceParseError({
    sourcePath,
    kind: "orbit",
    message: `${field}: ${message}`,
  });

const normalizePhaseNamedRef = <TRef>(
  sourcePath: string,
  field: string,
  value: TRef,
  normalize: (
    field: string,
    value: TRef,
  ) => string | { readonly field: string; readonly message: string },
): string | SourceParseError => {
  const normalized = normalize(field, value);
  if (typeof normalized === "string") return normalized;

  return orbitSourceParseError(sourcePath, normalized.field, normalized.message);
};

const normalizePhaseOrbitRef = (
  sourcePath: string,
  phase: OrbitDefinition["phases"][number],
  index: number,
): string | undefined | SourceParseError => {
  if (!phase.orbit) return undefined;

  return normalizePhaseNamedRef(
    sourcePath,
    `phases[${index}].orbit`,
    phase.orbit,
    normalizeOrbitRefInput,
  );
};

const normalizePhaseOrbitBinding = (
  sourcePath: string,
  phase: OrbitDefinition["phases"][number],
  index: number,
): NormalizedPhaseOrbitBinding | undefined | SourceParseError => {
  if (!phase.orbit_binding) return undefined;

  const normalized = normalizeOrbitRefInput(
    `phases[${index}].orbit_binding.orbit`,
    phase.orbit_binding.orbit,
  );
  if (typeof normalized !== "string") {
    return orbitSourceParseError(sourcePath, normalized.field, normalized.message);
  }

  return {
    orbit: normalized,
    ...(phase.orbit_binding.bindings
      ? { bindings: { ...phase.orbit_binding.bindings } }
      : {}),
  };
};

const phaseAgentAliasSources = (
  phase: OrbitDefinition["phases"][number],
): string[] =>
  [
    phase.agents && phase.agents.length > 0 ? "agents" : undefined,
    phase.agent ? "agent" : undefined,
  ].filter((value): value is string => value !== undefined);

const normalizePhaseRawAgents = (
  sourcePath: string,
  phase: OrbitDefinition["phases"][number],
  index: number,
): string[] | SourceParseError => {
  const rawAgents = phase.agents ?? (phase.agent ? [phase.agent] : undefined) ?? [];
  const agents: string[] = [];

  for (const [agentIndex, agent] of rawAgents.entries()) {
    const normalized = normalizeAgentRefInput(
      `phases[${index}].agents[${agentIndex}]`,
      agent,
    );
    if (typeof normalized !== "string") {
      return orbitSourceParseError(sourcePath, normalized.field, normalized.message);
    }
    agents.push(normalized);
  }

  return agents;
};

const normalizePhaseAgents = (
  sourcePath: string,
  phase: OrbitDefinition["phases"][number],
  index: number,
): NormalizedPhaseAgents | SourceParseError => {
  const uniqueAliases = [...new Set(phaseAgentAliasSources(phase))];
  if (uniqueAliases.length > 1) {
    return new SourceParseError({
      sourcePath,
      kind: "orbit",
      message: `phase ${index + 1} ('${phase.name}') declares multiple agent assignment aliases (${uniqueAliases.join(", ")}); use only one of agent or agents`,
    });
  }

  const agents = normalizePhaseRawAgents(sourcePath, phase, index);
  if (agents instanceof SourceParseError) return agents;

  return { agents };
};

const normalizePhaseRequirements = (
  sourcePath: string,
  phase: OrbitDefinition["phases"][number],
  index: number,
): NormalizedPhaseRequirement[] | SourceParseError => {
  const requires: NormalizedPhaseRequirement[] = [];

  for (const [requirementIndex, requirement] of (phase.requires ?? []).entries()) {
    const all: string[] = [];
    for (const [traitIndex, trait] of requirement.all.entries()) {
      const normalized = normalizeTraitRefInput(
        `phases[${index}].requires[${requirementIndex}].all[${traitIndex}]`,
        trait,
      );
      if (typeof normalized !== "string") {
        return orbitSourceParseError(sourcePath, normalized.field, normalized.message);
      }
      all.push(normalized);
    }

    requires.push({ all, ...(requirement.min !== undefined ? { min: requirement.min } : {}) });
  }

  return requires;
};

const normalizeOrbitPhase = (
  sourcePath: string,
  phase: OrbitDefinition["phases"][number],
  index: number,
): NormalizedOrbitPhase | SourceParseError => {
  const orbit = normalizePhaseOrbitRef(sourcePath, phase, index);
  if (orbit instanceof SourceParseError) return orbit;

  const orbitBinding = normalizePhaseOrbitBinding(sourcePath, phase, index);
  if (orbitBinding instanceof SourceParseError) return orbitBinding;

  const phaseAgents = normalizePhaseAgents(sourcePath, phase, index);
  if (phaseAgents instanceof SourceParseError) return phaseAgents;

  const requires = normalizePhaseRequirements(sourcePath, phase, index);
  if (requires instanceof SourceParseError) return requires;

  const singularAgent = phase.agent
    ? normalizePhaseNamedRef(
        sourcePath,
        `phases[${index}].agent`,
        phase.agent,
        normalizeAgentRefInput,
      )
    : undefined;
  if (singularAgent instanceof SourceParseError) return singularAgent;

  return {
    name: phase.name,
    ...(orbit ? { orbit } : {}),
    ...(orbitBinding ? { orbit_binding: orbitBinding } : {}),
    ...(singularAgent ? { agent: singularAgent } : {}),
    agents: phaseAgents.agents,
    requires,
    notes: phase.notes,
    ...(phase.telos !== undefined ? { telos: phase.telos } : {}),
    ...(phase.real_world_change !== undefined
      ? { real_world_change: phase.real_world_change }
      : {}),
    ...(phase.cold_pickup_test !== undefined
      ? { cold_pickup_test: phase.cold_pickup_test }
      : {}),
    ...(phase.workflow !== undefined ? { workflow: phase.workflow } : {}),
    ...(phase.body !== undefined ? { body: phase.body } : {}),
  };
};

const parseCanonicalToolName = (ref: string): string => {
  const colon = ref.indexOf(":");
  return colon === -1 ? ref : ref.slice(colon + 1);
};

const normalizeOrbitPermissionTool = (
  sourcePath: string,
  tool: OrbitToolPermissionTool,
  fieldPrefix: string,
  toolIndex: number,
): NormalizedOrbitToolPermissionTool | SourceParseError => {
  const rawRef = typeof tool === "string" ? tool : tool.ref;
  const ref = rawRef.trim();
  if (!ref) {
    return new SourceParseError({
      sourcePath,
      kind: "orbit",
      message: `${fieldPrefix}[${toolIndex}].ref: must be a non-empty canonical tool reference`,
    });
  }

  const rawLogicalName =
    typeof tool === "string" ? parseCanonicalToolName(ref) : tool.as ?? parseCanonicalToolName(ref);
  const logicalName = rawLogicalName.trim();
  if (!logicalName) {
    return new SourceParseError({
      sourcePath,
      kind: "orbit",
      message: `${fieldPrefix}[${toolIndex}].as: must be non-empty when provided`,
    });
  }

  return {
    ref,
    logicalName,
  };
};

const normalizeOrbitToolList = (
  sourcePath: string,
  tools: ReadonlyArray<OrbitToolPermissionTool>,
  fieldPrefix: string,
): NormalizedOrbitToolPermissionTool[] | SourceParseError => {
  const normalized: NormalizedOrbitToolPermissionTool[] = [];
  const logicalNames = new Set<string>();
  for (const [toolIndex, tool] of tools.entries()) {
    const normalizedTool = normalizeOrbitPermissionTool(
      sourcePath,
      tool,
      fieldPrefix,
      toolIndex,
    );
    if (normalizedTool instanceof SourceParseError) {
      return normalizedTool;
    }
    if (logicalNames.has(normalizedTool.logicalName)) {
      return new SourceParseError({
        sourcePath,
        kind: "orbit",
        message: `${fieldPrefix}[${toolIndex}].as: duplicate logical tool name '${normalizedTool.logicalName}'`,
      });
    }
    logicalNames.add(normalizedTool.logicalName);
    normalized.push(normalizedTool);
  }
  return normalized;
};

const normalizeOrbitOrchestrator = (
  sourcePath: string,
  orchestrator: OrbitDefinition["orchestrator"],
): NormalizedOrbitOrchestrator | undefined | SourceParseError => {
  if (!orchestrator) return undefined;

  const normalizedAgent = normalizeAgentRefInput(
    "orchestrator.agent",
    orchestrator.agent,
  );
  if (typeof normalizedAgent !== "string") {
    return new SourceParseError({
      sourcePath,
      kind: "orbit",
      message: `${normalizedAgent.field}: ${normalizedAgent.message}`,
    });
  }

  const tools = normalizeOrbitToolList(
    sourcePath,
    orchestrator.tools,
    "orchestrator.tools",
  );
  if (tools instanceof SourceParseError) {
    return tools;
  }

  return {
    agent: normalizedAgent,
    tools,
  };
};

const normalizeOrbitToolPermissions = (
  sourcePath: string,
  permissions: OrbitDefinition["tool_permissions"],
): NormalizedOrbitToolPermissionTool[] | SourceParseError =>
  normalizeOrbitToolList(sourcePath, permissions ?? [], "tool_permissions");

const parseOrbitDefinition = (
  sourcePath: string,
  raw: unknown,
  kind: "orbit",
  body: string,
): Effect.Effect<Orbit, CompileError> =>
  Effect.gen(function* () {
    const result = Schema.decodeUnknownEither(OrbitDefinitionSchema, STRICT_PARSE_OPTIONS)(raw);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind,
          message: result.left.message,
        }),
      );
    }

    const parsed = result.right;
    const fileStem = stripSuffix(basename(sourcePath), [ORBIT_SUFFIX_TS]);
    if (parsed.name !== fileStem) {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind,
          message: `orbit 'name' field ('${parsed.name}') must match file stem ('${fileStem}')`,
        }),
      );
    }

    const phases: NormalizedOrbitPhase[] = [];
    for (const [index, phase] of parsed.phases.entries()) {
      const normalized = normalizeOrbitPhase(sourcePath, phase, index);
      if (normalized instanceof SourceParseError) {
        return yield* Effect.fail(normalized);
      }
      phases.push(normalized);
    }

    const toolPermissions = normalizeOrbitToolPermissions(sourcePath, parsed.tool_permissions);
    if (toolPermissions instanceof SourceParseError) {
      return yield* Effect.fail(toolPermissions);
    }

    const orchestrator = normalizeOrbitOrchestrator(sourcePath, parsed.orchestrator);
    if (orchestrator instanceof SourceParseError) {
      return yield* Effect.fail(orchestrator);
    }

    const resolvedBody = (parsed.body ?? body).trim();

    return new Orbit({
      name: parsed.name,
      sourcePath,
      description: parsed.description,
      produces: parsed.produces,
      definitions: parsed.definitions,
      parameters: (parsed.parameters ?? []).map((parameter) => ({
        ...parameter,
        required: parameter.required ?? true,
      })),
      phases,
      ...(orchestrator ? { orchestrator } : {}),
      tool_permissions: toolPermissions,
      pulsar_checkpoints: parsed.pulsar_checkpoints ?? [],
      evolution: parsed.evolution,
      body: resolvedBody,
      ...(parsed.signal_emitter ? { signal_emitter: parsed.signal_emitter } : {}),
    });
  });

const parseOrbitTs = (
  sourcePath: string,
): Effect.Effect<Orbit, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "orbit");
    return yield* parseOrbitDefinition(sourcePath, raw, "orbit", "");
  });

const loadOrbits = (
  pluginPath: string,
): Effect.Effect<Map<string, Orbit>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "orbits");
    const entries = yield* listDir(dir);
    const map = new Map<string, Orbit>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(ORBIT_SUFFIX_TS)) {
        continue;
      }

      const orbit = yield* parseOrbitTs(join(dir, entry));

      const existing = map.get(orbit.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "orbit",
            name: orbit.name,
            firstPath: existing.sourcePath,
            secondPath: orbit.sourcePath,
          }),
        );
      }

      map.set(orbit.name, orbit);
    }

    return map;
  });

const parseHook = (sourcePath: string): Effect.Effect<Hook, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "hook");
    const unsupported = unsupportedHookFieldError(sourcePath, raw);
    if (unsupported) return yield* Effect.fail(unsupported);

    const result = Schema.decodeUnknownEither(HookDefinitionSchema, STRICT_PARSE_OPTIONS)(raw);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "hook",
          message: result.left.message,
        }),
      );
    }

    const parsed = result.right;
    const fileStem = stripSuffix(basename(sourcePath), [HOOK_SUFFIX_TS]);
    if (parsed.name !== fileStem) {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "hook",
          message: `hook 'name' field ('${parsed.name}') must match file stem ('${fileStem}')`,
        }),
      );
    }

    if (typeof parsed.handle !== "function") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "hook",
          message: `handle must be a function`,
        }),
      );
    }

    const match = normalizeHookMatch(sourcePath, parsed.event, parsed.match);
    if (match instanceof SourceParseError) {
      return yield* Effect.fail(match);
    }

    const targets = parsed.targets ?? [];
    const unknownTarget = targets.find((target) => !isPluginTargetId(target));
    if (unknownTarget !== undefined) {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "hook",
          message: `targets contains unknown target '${String(unknownTarget)}'`,
        }),
      );
    }

    return new Hook({
      name: parsed.name,
      sourcePath,
      description: parsed.description,
      event: parsed.event,
      targets,
      match,
      handle: parsed.handle,
      onDegraded: parsed.onDegraded,
    });
  });

const loadHooks = (
  pluginPath: string,
): Effect.Effect<Map<string, Hook>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "hooks");
    const entries = yield* listDir(dir);
    const map = new Map<string, Hook>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(HOOK_SUFFIX_TS)) continue;
      const hook = yield* parseHook(join(dir, entry));
      const existing = map.get(hook.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "hook",
            name: hook.name,
            firstPath: existing.sourcePath,
            secondPath: hook.sourcePath,
          }),
        );
      }
      map.set(hook.name, hook);
    }

    return map;
  });

interface PluginManifest {
  name: string;
  version: string;
  deps: Record<string, string>;
  targets: PluginManifestTargets;
  runtime: PluginRuntimeConfig;
}

const validatePluginManifestTargetsForLoad = (
  pluginPath: string,
  targets: PluginManifestTargets,
): Effect.Effect<void, CompileError> =>
  Effect.gen(function* () {
    const rawTargets = targets as Record<string, unknown>;
    const sourceNounSet = new Set<string>(SOURCE_NOUNS);
    const sourceNounList = SOURCE_NOUNS.join(", ");
    for (const key of Object.keys(rawTargets)) {
      if (sourceNounSet.has(key)) continue;
      return yield* Effect.fail(
        PluginManifestError.forPlugin(pluginPath, `Unknown targets key '${key}'. Expected one of: ${sourceNounList}`),
      );
    }

    for (const noun of SOURCE_NOUNS) {
      const declaredTargets = rawTargets[noun];
      if (declaredTargets === undefined) continue;

      if (!Array.isArray(declaredTargets)) {
        return yield* Effect.fail(
          PluginManifestError.forPlugin(pluginPath, `targets.${noun} must be an array of harness IDs and/or preset IDs`),
        );
      }

      if (declaredTargets.length === 0) {
        return yield* Effect.fail(
          PluginManifestError.forPlugin(pluginPath, `targets.${noun} must not be empty`),
        );
      }

      const unknownTarget = declaredTargets.find((target) => !isPluginTargetId(target));
      if (unknownTarget !== undefined) {
        return yield* Effect.fail(
          PluginManifestError.forPlugin(pluginPath, `targets.${noun} contains unknown target '${String(unknownTarget)}'`),
        );
      }

      const supportErrors = validateSourceTargetSupport(noun as SourceNoun, declaredTargets);
      if (supportErrors.length > 0) {
        return yield* Effect.fail(
          PluginManifestError.forPlugin(pluginPath, supportErrors.join("\n")),
        );
      }
    }
  });

const readPluginManifest = (
  pluginPath: string,
): Effect.Effect<PluginManifest, CompileError> =>
  Effect.gen(function* () {
    const manifestPath = join(pluginPath, "plugin.json");
    const raw = yield* Effect.tryPromise({
      try: () => Bun.file(manifestPath).json(),
      catch: (cause) =>
        PluginManifestError.forPlugin(
          pluginPath,
          cause instanceof Error
            ? `failed to read plugin.json: ${cause.message}`
            : "failed to read plugin.json",
        ),
    });

    const data = raw as Record<string, unknown>;
    const name = typeof data.name === "string" ? data.name : undefined;
    if (!name) {
      return yield* Effect.fail(
        PluginManifestError.forPlugin(pluginPath, "plugin.json is missing 'name' field"),
      );
    }

    const version = typeof data.version === "string" ? data.version : undefined;
    if (!version) {
      return yield* Effect.fail(
        PluginManifestError.forPlugin(pluginPath, "plugin.json is missing 'version' field"),
      );
    }

    const rawDeps = data.deps;
    let deps: Record<string, string> = {};
    if (rawDeps !== undefined) {
      if (rawDeps === null || typeof rawDeps !== "object" || Array.isArray(rawDeps)) {
        return yield* Effect.fail(
          PluginManifestError.forPlugin(pluginPath, "plugin.json 'deps' must be an object of {depName: localPath}"),
        );
      }

      for (const [depName, depValue] of Object.entries(rawDeps as Record<string, unknown>)) {
        if (typeof depValue !== "string") {
          return yield* Effect.fail(
            PluginManifestError.forPlugin(pluginPath, `plugin.json dep '${depName}' must be a string local path`),
          );
        }
        deps[depName] = depValue;
      }
    }

    const rawTargets = data.targets;
    const targets =
      rawTargets && typeof rawTargets === "object" && !Array.isArray(rawTargets)
        ? (rawTargets as PluginManifestTargets)
        : {};
    yield* validatePluginManifestTargetsForLoad(pluginPath, targets);

    const rawRuntime = data.runtime;
    let runtime: PluginRuntimeConfig = {};
    if (rawRuntime !== undefined) {
      if (rawRuntime === null || typeof rawRuntime !== "object" || Array.isArray(rawRuntime)) {
        return yield* Effect.fail(
          PluginManifestError.forPlugin(pluginPath, "plugin.json 'runtime' must be an object"),
        );
      }
      runtime = rawRuntime as PluginRuntimeConfig;
    }

    return { name, version, deps, targets, runtime };
  });

const parseCanonicalTool = (sourcePath: string): Effect.Effect<CanonicalTool, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "tool");
    const result = Schema.decodeUnknownEither(CanonicalToolSchema, STRICT_PARSE_OPTIONS)(raw);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "tool",
          message: result.left.message,
        }),
      );
    }

    const parsed = result.right;
    const fileStem = stripSuffix(basename(sourcePath), [TOOL_SUFFIX_TS]);
    if (parsed.name !== fileStem) {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "tool",
          message: `tool 'name' field ('${parsed.name}') must match file stem ('${fileStem}')`,
        }),
      );
    }

    if (typeof parsed.handle !== "function") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "tool",
          message: `handle must be a function`,
        }),
      );
    }

    return new CanonicalTool({
      name: parsed.name,
      sourcePath,
      description: parsed.description,
      input: parsed.input,
      output: parsed.output,
      slots: parsed.slots ?? {},
      handle: parsed.handle,
    });
  });

const loadCanonicalTools = (
  pluginPath: string,
): Effect.Effect<Map<string, CanonicalTool>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "tools");
    const entries = yield* listDir(dir);
    const map = new Map<string, CanonicalTool>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(TOOL_SUFFIX_TS)) continue;
      const tool = yield* parseCanonicalTool(join(dir, entry));
      const existing = map.get(tool.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "tool",
            name: tool.name,
            firstPath: existing.sourcePath,
            secondPath: tool.sourcePath,
          }),
        );
      }
      map.set(tool.name, tool);
    }

    return map;
  });

const loadPluginArtifacts = (
  pluginPath: string,
  pluginName: string,
  pluginVersion: string,
  dependencyPaths: Record<string, string>,
  targets: PluginManifestTargets,
  runtime: PluginRuntimeConfig,
): Effect.Effect<PluginRegistry, CompileError> =>
  Effect.gen(function* () {
    const registry = emptyRegistry(
      pluginPath,
      pluginName,
      pluginVersion,
      dependencyPaths,
      targets,
      runtime,
    );
    registry.identities = yield* loadIdentities(pluginPath);
    registry.personalities = yield* loadPersonalities(pluginPath);
    registry.toolspaces = yield* loadToolspaces(pluginPath);
    registry.modelspaces = yield* loadModelspaces(pluginPath);
    registry.skillspaces = yield* loadSkillspaces(pluginPath);
    registry.skills = yield* loadSkills(pluginPath);
    registry.traits = yield* loadTraits(pluginPath);
    registry.tools = yield* loadCanonicalTools(pluginPath);
    registry.hooks = yield* loadHooks(pluginPath);
    registry.orbits = yield* loadOrbits(pluginPath);
    registry.agents = yield* loadAgents(pluginPath);
    return registry;
  });

export const loadPlugin = (
  pluginPath: string,
): Effect.Effect<PluginRegistry, CompileError> =>
  Effect.gen(function* () {
    const cache = new Map<string, PluginRegistry>();
    return yield* loadPluginWithDeps(pluginPath, cache, []);
  });

const loadPluginWithDeps = (
  pluginPath: string,
  cache: Map<string, PluginRegistry>,
  stack: string[],
): Effect.Effect<PluginRegistry, CompileError> =>
  Effect.gen(function* () {
    const canonical = resolvePath(pluginPath);

    if (stack.includes(canonical)) {
      return yield* Effect.fail(
        new DependencyCycleError({ cycle: [...stack, canonical] }),
      );
    }

    const cached = cache.get(canonical);
    if (cached) return cached;

    const manifest = yield* readPluginManifest(canonical);
    const resolvedDeps = Object.fromEntries(
      Object.entries(manifest.deps).map(([depName, depPath]) => [
        depName,
        resolvePath(canonical, depPath),
      ]),
    );
    const registry = yield* loadPluginArtifacts(
      canonical,
      manifest.name,
      manifest.version,
      resolvedDeps,
      manifest.targets,
      manifest.runtime,
    );

    const nextStack = [...stack, canonical];
    for (const [depName, depPath] of Object.entries(manifest.deps)) {
      const resolvedDepPath = resolvePath(canonical, depPath);
      const depRegistry = yield* loadPluginWithDeps(resolvedDepPath, cache, nextStack);
      registry.deps.set(depName, depRegistry);
    }

    cache.set(canonical, registry);
    return registry;
  });
