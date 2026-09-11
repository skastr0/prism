/**
 * Load phase: discover source files in a plugin and parse them into typed
 * registry entries.
 *
 * Canonical structured artifacts are TypeScript-authored.
 */

import * as EffectModule from "effect";
import { Effect, Schema } from "effect";
import { realpathSync } from "node:fs";
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
  Modelspace,
  ModelspaceSchema,
  Personality,
  PersonalityFrontmatter,
  Skill,
  Skillspace,
  SkillspaceSchema,
  Sop,
  SopDefinitionSchema,
  normalizeAgentRefInput,
  normalizeModelProfileRefInput,
  normalizeSkillRefInput,
  type HookToolMatcherInput,
  type NormalizedHookMatch,
  type NormalizedHookToolMatcher,
  type NormalizedSopPhase,
  type SkillRefInput,
  type SopDefinition,
} from "./sources.js";
import {
  AgentNameMismatchError,
  DependencyCycleError,
  DuplicateNameError,
  SourceParseError,
  type CompileError,
} from "./errors.js";
import { existsSync } from "node:fs";
import { PluginManifestError } from "../errors.js";
import { validateSkillName } from "../manifest.js";
import { harnessModelsModulePath } from "../harness-types.js";
import { resolvePrismHome } from "../prism-home.js";
import { deriveProjectKey, projectGeneratedRefsDir } from "../project-key.js";
import { rewriteGeneratedRefsForRuntime } from "../workflow-generated-surface.js";
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
 * behavior identical to src/workflows.ts. Schema is read
 * from the binary's embedded Effect (globalThis.__prism_effect) so
 * Schema.isSchema and decodeTaskOutput operate on the binary's Effect instance.
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
  /** Target for bare `prism/harnesses` imports (global harness model types). */
  readonly prismHarnesses?: string;
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
  if (overrides.prismHarnesses !== undefined) {
    rewritten = replaceBareSpecifier(rewritten, "prism/harnesses", overrides.prismHarnesses);
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

  const ignoredDirs = new Set([".agents", ".git", "dist", "node_modules", ".runtime"]);
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
 * sops.ts, where the key is the project identity (toolchain & distribution
 * §4): git repository root of the process cwd, else realpath(cwd). An off-repo
 * workflow file run from inside a repo resolves to that repo's generated refs.
 */
export const resolveEffectRuntimePath = async (): Promise<string> =>
  (await getImportRuntimePaths()).effect;

const workflowRefsDirForImport = async (): Promise<string> => {
  const prismHome = resolvePrismHome();
  const { key } = deriveProjectKey();
  const refsDir = projectGeneratedRefsDir(prismHome, key);
  if (!existsSync(join(refsDir, "sops.ts"))) return refsDir;
  return rewriteGeneratedRefsForRuntime(refsDir, await resolveEffectRuntimePath());
};

const workflowRefsTargetPath = async (): Promise<string> =>
  join(await workflowRefsDirForImport(), "sops.ts");

const workflowRefsModuleTargets = async (cacheBust: string): Promise<Record<string, string>> => {
  const refsDir = await workflowRefsDirForImport();
  const modules = ["sops", "models"] as const;
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
  const harnessTypesPath = harnessModelsModulePath(resolvePrismHome());
  return {
    prism: toFileSpecifier(runtimePaths.workflowDsl),
    effect: toFileSpecifier(runtimePaths.effect),
    prismRefs: `${toFileSpecifier(await workflowRefsTargetPath())}${cacheBust}`,
    prismRefsModules: await workflowRefsModuleTargets(cacheBust),
    ...(existsSync(harnessTypesPath)
      ? { prismHarnesses: `${toFileSpecifier(harnessTypesPath)}${cacheBust}` }
      : {}),
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
  // A workflow transform embeds a cache-busted `prism/refs` URL. Reusing the
  // copied tree would also reuse that old URL (and any source bytes copied at
  // the same time), so a second load in the same process could execute stale
  // refs even though its outer module specifier was fresh. Workflow loads are
  // correctness-sensitive and normally happen once per CLI process: give each
  // one an uncached tree and remove it as soon as the import completes.
  const uncachedWorkflowParent = options.workflow
    ? await (async () => {
        const fs = await import("node:fs/promises");
        const outputParent = await fs.mkdtemp(join(tmpdir(), "prism-workflow-sources-"));
        await copyTransformedPluginTree({
          pluginRoot,
          outputParent,
          overrides,
          visited: new Set<string>(),
        });
        return outputParent;
      })()
    : undefined;
  const transformed = uncachedWorkflowParent === undefined
    ? await getTransformedPluginRoot(cacheKey, pluginRoot, overrides)
    : {
        cacheKey,
        pluginRoot,
        root: join(uncachedWorkflowParent, basename(pluginRoot)),
        outputParent: uncachedWorkflowParent,
        activeImports: 0,
        lastUsed: Date.now(),
        cleanupTimer: undefined,
      } satisfies TransformedPluginRoot;
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
      if (uncachedWorkflowParent !== undefined) {
        const fs = await import("node:fs/promises");
        await fs.rm(uncachedWorkflowParent, { recursive: true, force: true });
      } else {
        scheduleTransformedPluginRootCleanup(transformed);
      }
    },
  };
};

const normalizeImportPath = (path: string): string => {
  let normalized = path;
  try {
    // Canonicalize through symlinks (macOS /var -> /private/var): Bun's
    // bundler caches the canonical form after the first build, and mixing
    // raw and canonical specifiers makes the second build fail to resolve
    // the Prism-owned runtime module.
    normalized = realpathSync(path);
  } catch {
    // Fall through to the raw path when it does not exist yet.
  }
  return normalized.replace(/\\/g, "/");
};

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
const AGENT_SUFFIX_TS = ".agent.ts";
const MODELSPACE_SUFFIX_TS = ".modelspace.ts";
const SKILLSPACE_SUFFIX_TS = ".skillspace.ts";
const SOP_SUFFIX_TS = ".sop.ts";
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
    case "hook-native-tool": {
      const name = matcher.name.trim();
      if (!name) {
        return new SourceParseError({
          sourcePath,
          kind: "hook",
          message: `${field}.name: must be a non-empty native tool name`,
        });
      }
      return { kind: "native-tool", name };
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
  if (
    event !== "tool.before" &&
    event !== "tool.after" &&
    event !== "tool.failure" &&
    event !== "permission.request"
  ) {
    return new SourceParseError({
      sourcePath,
      kind: "hook",
      message: `match.tool is only supported for tool.before, tool.after, tool.failure, and permission.request hooks`,
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

type AgentDefinitionInput = typeof AgentSchema.Type;

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
    readonly model?: string;
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
    skills: parts.skills,
    color: parsed.color,
    targets: parsed.targets ?? {},
  });

const parseAgentModule = (
  sourcePath: string,
  raw: unknown,
): Effect.Effect<Agent, CompileError> =>
  Effect.gen(function* () {
    const parsed = decodeAgentDefinition(sourcePath, raw);
    if (parsed instanceof SourceParseError) return yield* Effect.fail(parsed);

    const nameMismatch = validateAgentFileName(sourcePath, parsed);
    if (nameMismatch) return yield* Effect.fail(nameMismatch);

    const model = normalizeAgentModel(sourcePath, parsed.model);
    if (model instanceof SourceParseError) return yield* Effect.fail(model);

    const skills = normalizeSkillRefs(sourcePath, "agent", "skills", parsed.skills);
    if (skills instanceof SourceParseError) return yield* Effect.fail(skills);

    return buildAgent(sourcePath, parsed, { model, skills });
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


const FORBIDDEN_SOP_FIELDS = [
  "agent",
  "agents",
  "roles",
  "role",
  "requires",
  "orchestrator",
  "tools",
  "tool_permissions",
  "signals",
  "signal_emitter",
  "checkpoints",
  "pulsar_checkpoints",
  "definitions",
  "parameters",
  "bindings",
] as const;

const SOP_INVARIANT =
  "a SOP says what must be true and never names who executes it, with what tool, or in what runtime";

const unsupportedSopFieldError = (
  sourcePath: string,
  raw: unknown,
): SourceParseError | undefined => {
  if (!isRecord(raw)) return undefined;

  for (const field of FORBIDDEN_SOP_FIELDS) {
    if (!hasOwn(raw, field)) continue;
    return forbiddenFieldError(sourcePath, "sop", field, `is not part of the SOP schema; ${SOP_INVARIANT}`);
  }

  const phases = raw.phases;
  if (!Array.isArray(phases)) return undefined;
  for (const [index, phase] of phases.entries()) {
    if (!isRecord(phase)) continue;
    for (const field of FORBIDDEN_SOP_FIELDS) {
      if (!hasOwn(phase, field)) continue;
      return forbiddenFieldError(
        sourcePath,
        "sop",
        `phases[${index}].${field}`,
        `is not part of the SOP phase schema; ${SOP_INVARIANT}`,
      );
    }
  }

  return undefined;
};

const sopSourceParseError = (
  sourcePath: string,
  field: string,
  message: string,
): SourceParseError =>
  new SourceParseError({
    sourcePath,
    kind: "sop",
    message: `${field}: ${message}`,
  });

const normalizeSopPhaseContract = (
  sourcePath: string,
  phase: SopDefinition["phases"][number],
  index: number,
): Pick<NormalizedSopPhase, "input" | "output"> | SourceParseError => {
  const normalized: {
    input?: Schema.Schema.AnyNoContext;
    output?: Schema.Schema.AnyNoContext;
  } = {};

  for (const side of ["input", "output"] as const) {
    const schema = phase[side];
    if (schema === undefined) continue;
    if (!isEffectSchema(schema)) {
      return sopSourceParseError(
        sourcePath,
        `phases[${index}].${side}`,
        "must be an Effect Schema",
      );
    }
    normalized[side] = schema;
  }

  return normalized;
};

const normalizeSopPhase = (
  sourcePath: string,
  phase: SopDefinition["phases"][number],
  index: number,
): NormalizedSopPhase | SourceParseError => {
  const contract = normalizeSopPhaseContract(sourcePath, phase, index);
  if (contract instanceof SourceParseError) return contract;

  return {
    name: phase.name,
    purpose: phase.purpose,
    ...(contract.input ? { input: contract.input } : {}),
    ...(contract.output ? { output: contract.output } : {}),
    acceptanceCriteria: [...(phase.acceptance_criteria ?? [])],
    ...(phase.escalation !== undefined ? { escalation: phase.escalation } : {}),
    body: phase.body.trim(),
  };
};

const parseSopDefinition = (
  sourcePath: string,
  raw: unknown,
): Effect.Effect<Sop, CompileError> =>
  Effect.gen(function* () {
    const unsupported = unsupportedSopFieldError(sourcePath, raw);
    if (unsupported) return yield* Effect.fail(unsupported);

    const result = Schema.decodeUnknownEither(SopDefinitionSchema, STRICT_PARSE_OPTIONS)(raw);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "sop",
          message: result.left.message,
        }),
      );
    }

    const parsed = result.right;
    const fileStem = stripSuffix(basename(sourcePath), [SOP_SUFFIX_TS]);
    if (parsed.name !== fileStem) {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "sop",
          message: `sop 'name' field ('${parsed.name}') must match file stem ('${fileStem}')`,
        }),
      );
    }

    const skillName = validateSkillName(parsed.name);
    if (!skillName.valid) {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "sop",
          message: `sop name must be a valid skill name: ${skillName.error}`,
        }),
      );
    }

    const phases: NormalizedSopPhase[] = [];
    for (const [index, phase] of parsed.phases.entries()) {
      const normalized = normalizeSopPhase(sourcePath, phase, index);
      if (normalized instanceof SourceParseError) {
        return yield* Effect.fail(normalized);
      }
      phases.push(normalized);
    }

    return new Sop({
      name: parsed.name,
      sourcePath,
      description: parsed.description,
      phases,
      body: (parsed.body ?? "").trim(),
    });
  });

const parseSopTs = (
  sourcePath: string,
): Effect.Effect<Sop, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "sop");
    return yield* parseSopDefinition(sourcePath, raw);
  });

const loadSops = (
  pluginPath: string,
): Effect.Effect<Map<string, Sop>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "sops");
    const entries = yield* listDir(dir);
    const map = new Map<string, Sop>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(SOP_SUFFIX_TS)) {
        continue;
      }

      const sop = yield* parseSopTs(join(dir, entry));

      const existing = map.get(sop.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "sop",
            name: sop.name,
            firstPath: existing.sourcePath,
            secondPath: sop.sourcePath,
          }),
        );
      }

      map.set(sop.name, sop);
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
      authority: parsed.authority,
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
    registry.modelspaces = yield* loadModelspaces(pluginPath);
    registry.skillspaces = yield* loadSkillspaces(pluginPath);
    registry.skills = yield* loadSkills(pluginPath);
    registry.tools = yield* loadCanonicalTools(pluginPath);
    registry.hooks = yield* loadHooks(pluginPath);
    registry.sops = yield* loadSops(pluginPath);
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
