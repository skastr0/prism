/**
 * Load phase: discover source files in a plugin and parse them into typed
 * registry entries.
 *
 * Canonical structured artifacts are TypeScript-authored.
 */

import * as EffectModule from "effect";
import { Effect, Schema } from "effect";
import { basename, join, relative, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import matter from "gray-matter";
import {
  Agent,
  AgentSchema,
  CanonicalTool,
  CanonicalToolSchema,
  Identity,
  IdentityFrontmatter,
  Lifecycle,
  LifecycleDefinitionSchema,
  Modelspace,
  ModelspaceSchema,
  Personality,
  PersonalityFrontmatter,
  Toolspace,
  ToolspaceSchema,
  Trait,
  TraitSchema,
  normalizeAgentRefInput,
  normalizeLifecycleRefInput,
  normalizeModelProfileRefInput,
  normalizeToolGroupRefInput,
  normalizeToolRefInput,
  normalizeTraitRefInput,
  type Access,
  type LifecycleDefinition,
  type LifecycleToolPermissionTool,
  type NormalizedAccess,
  type NormalizedLifecyclePhase,
  type NormalizedLifecycleToolPermission,
  type NormalizedTraitBinding,
  type NormalizedTraitBindingToolSlot,
} from "./sources.js";
import {
  AgentNameMismatchError,
  DependencyCycleError,
  DuplicateNameError,
  PluginManifestError,
  SourceParseError,
  type CompileError,
} from "./errors.js";
import { emptyRegistry, type PluginRegistry } from "./registry.js";

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
  __agentpkg_effect?: typeof EffectModule;
};
globalWithCompileRuntime.__agentpkg_effect = EffectModule;

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

const AUTHORING_RUNTIME_JS = `
const withNamedRef = (kind, first, second) =>
  second === undefined ? { kind, name: first } : { kind, plugin: first, name: second };

export const traitRef = (first, second) => withNamedRef("trait-ref", first, second);
export const agentRef = (first, second) => withNamedRef("agent-ref", first, second);
export const lifecycleRef = (first, second) => withNamedRef("lifecycle-ref", first, second);

export const toolRef = (first, second, third) =>
  third === undefined
    ? { kind: "tool-ref", toolspace: first, name: second }
    : { kind: "tool-ref", plugin: first, toolspace: second, name: third };

export const toolGroupRef = (first, second, third) =>
  third === undefined
    ? { kind: "tool-group-ref", toolspace: first, name: second }
    : { kind: "tool-group-ref", plugin: first, toolspace: second, name: third };

export const modelProfileRef = (first, second, third) =>
  third === undefined
    ? { kind: "model-profile-ref", modelspace: first, name: second }
    : { kind: "model-profile-ref", plugin: first, modelspace: second, name: third };

export const schemaSlot = (options = {}) => ({ kind: "schema", ...options });
export const bindTrait = (trait, options = {}) => ({
  kind: "trait-binding",
  trait,
  ...(options.tools ? { tools: options.tools } : {}),
});

export const defineAgent = (agent) => agent;
export const defineTrait = (trait) => trait;
export const defineLifecycle = (lifecycle) => lifecycle;
export const defineTool = (tool) => tool;
export const defineToolspace = (toolspace) => toolspace;
export const defineModelspace = (modelspace) => modelspace;
`;

const makeEffectRuntimeJs = (): string => {
  const namedExports = Object.keys(EffectModule)
    .filter((key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && key !== "default")
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `export const ${key} = effect[${JSON.stringify(key)}];`)
    .join("\n");

  return `
const effect = globalThis.__agentpkg_effect;
if (!effect) {
  throw new Error("agentpkg Effect runtime bridge was not initialized");
}

${namedExports}

export default effect;
`;
};

let importRuntimePaths: Promise<{
  readonly authoring: string;
  readonly effect: string;
}> | undefined;

const getImportRuntimePaths = async (): Promise<{
  readonly authoring: string;
  readonly effect: string;
}> => {
  importRuntimePaths ??= (async () => {
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp(join(tmpdir(), "agentpkg-authoring-"));
    const authoringPath = join(dir, "agentpkg-authoring-runtime.mjs");
    const effectPath = join(dir, "effect-runtime.mjs");
    await fs.writeFile(authoringPath, AUTHORING_RUNTIME_JS, "utf8");
    await fs.writeFile(effectPath, makeEffectRuntimeJs(), "utf8");
    return { authoring: authoringPath, effect: effectPath };
  })();

  return importRuntimePaths;
};

const toFileSpecifier = (path: string): string => pathToFileURL(path).href;

const rewriteImportSpecifiers = (
  source: string,
  authoringRuntimeSpecifier: string,
  effectRuntimeSpecifier: string,
): string => {
  return source
    .replace(
      /(\bfrom\s*)(["'])agentpkg\2/g,
      (_match, prefix) => `${prefix}${JSON.stringify(authoringRuntimeSpecifier)}`,
    )
    .replace(
      /(\bimport\s*\(\s*)(["'])agentpkg\2(\s*\))/g,
      (_match, prefix, _quote, suffix) =>
        `${prefix}${JSON.stringify(authoringRuntimeSpecifier)}${suffix}`,
    )
    .replace(
      /(\bfrom\s*)(["'])effect\2/g,
      (_match, prefix) => `${prefix}${JSON.stringify(effectRuntimeSpecifier)}`,
    )
    .replace(
      /(\bimport\s*\(\s*)(["'])effect\2(\s*\))/g,
      (_match, prefix, _quote, suffix) =>
        `${prefix}${JSON.stringify(effectRuntimeSpecifier)}${suffix}`,
    );
};

const TRANSFORMED_PLUGIN_CACHE_TTL_MS = 30_000;
const MAX_TRANSFORMED_PLUGIN_CACHE_ENTRIES = 16;

interface TransformedPluginRoot {
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

  const current = await transformedPluginRoots.get(entry.pluginRoot)?.catch(() => undefined);
  if (current !== entry) return;

  transformedPluginRoots.delete(entry.pluginRoot);
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

const getTransformedPluginRoot = async (pluginRoot: string): Promise<TransformedPluginRoot> => {
  const existing = transformedPluginRoots.get(pluginRoot);
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
    const runtimePaths = await getImportRuntimePaths();
    const authoringRuntimeSpecifier = toFileSpecifier(runtimePaths.authoring);
    const effectRuntimeSpecifier = toFileSpecifier(runtimePaths.effect);
    const outputParent = await fs.mkdtemp(join(tmpdir(), "agentpkg-sources-"));
    await copyTransformedPluginTree({
      pluginRoot,
      outputParent,
      authoringRuntimeSpecifier,
      effectRuntimeSpecifier,
      visited: new Set<string>(),
    });

    return {
      pluginRoot,
      root: join(outputParent, basename(pluginRoot)),
      outputParent,
      activeImports: 0,
      lastUsed: Date.now(),
      cleanupTimer: undefined,
    };
  })();

  transformedPluginRoots.set(pluginRoot, pending);
  await pruneTransformedPluginRootCache();
  return pending;
};

const copyTransformedPluginTree = async (options: {
  readonly pluginRoot: string;
  readonly outputParent: string;
  readonly authoringRuntimeSpecifier: string;
  readonly effectRuntimeSpecifier: string;
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
    const rewritten = rewriteImportSpecifiers(
      source,
      options.authoringRuntimeSpecifier,
      options.effectRuntimeSpecifier,
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

const prepareImportWrapper = async (
  sourcePath: string,
): Promise<{ readonly specifier: string; readonly cleanup: () => Promise<void> }> => {
  const pluginRoot = await findPluginRoot(sourcePath);
  const transformed = await getTransformedPluginRoot(pluginRoot);
  transformed.activeImports += 1;
  transformed.lastUsed = Date.now();
  let cleaned = false;
  const transformedPath = join(transformed.root, relative(pluginRoot, sourcePath));

  return {
    specifier: `${toFileSpecifier(transformedPath)}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      transformed.activeImports = Math.max(0, transformed.activeImports - 1);
      transformed.lastUsed = Date.now();
      scheduleTransformedPluginRootCleanup(transformed);
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
const LIFECYCLE_SUFFIX_TS = ".lifecycle.ts";
const TOOL_SUFFIX_TS = ".tool.ts";

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

  return { tools, toolGroups };
};

const isEffectSchema = (value: unknown): value is Schema.Schema.AnyNoContext =>
  Schema.isSchema(value);

interface SchemaSymbolSource {
  readonly sourcePath: string;
  readonly exportName: string;
}

type BindingToolSlotSources = Map<number, Map<string, Map<string, SchemaSymbolSource>>>;

const propertyNameText = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
};

const objectProperty = (
  object: ts.ObjectLiteralExpression | undefined,
  name: string,
): ts.Expression | undefined => {
  if (!object) return undefined;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = propertyNameText(property.name);
    if (propertyName === name) return property.initializer;
  }
  return undefined;
};

const asObjectLiteral = (value: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined =>
  value && ts.isObjectLiteralExpression(value) ? value : undefined;

const asArrayLiteral = (value: ts.Expression | undefined): ts.ArrayLiteralExpression | undefined =>
  value && ts.isArrayLiteralExpression(value) ? value : undefined;

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
  source: ts.SourceFile,
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

  const collectFromBindTrait = (
    traitIndex: number,
    call: ts.CallExpression,
  ): void => {
    const options = asObjectLiteral(call.arguments[1]);
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

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineAgent"
    ) {
      const agent = asObjectLiteral(node.arguments[0]);
      const traits = asArrayLiteral(objectProperty(agent, "traits"));
      if (traits) {
        for (const [traitIndex, element] of traits.elements.entries()) {
          if (
            ts.isCallExpression(element) &&
            ts.isIdentifier(element.expression) &&
            element.expression.text === "bindTrait"
          ) {
            collectFromBindTrait(traitIndex, element);
          }
        }
      }
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

const parseTrait = (sourcePath: string): Effect.Effect<Trait, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "trait");
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

    const access = normalizeAccess(sourcePath, "trait", "access", result.right.access);
    if (access instanceof SourceParseError) {
      return yield* Effect.fail(access);
    }

    const tools: Record<string, Trait["tools"][string]> = {};
    for (const [toolName, tool] of Object.entries(result.right.tools ?? {})) {
      if (!tool.ref || typeof tool.ref !== "string" || tool.ref.trim().length === 0) {
        return yield* Effect.fail(
          new SourceParseError({
            sourcePath,
            kind: "trait",
            message: `tools.${toolName}.ref: must be a non-empty canonical tool reference`,
          }),
        );
      }

      const attachment: Record<string, unknown> = { ref: tool.ref };

      tools[toolName] = attachment as Trait["tools"][string];
    }

    return new Trait({
      name: result.right.name,
      sourcePath,
      description: result.right.description,
      instructions: normalizeTraitInstructions(result.right.instructions),
      access,
      tools,
      inject: {
        skills: result.right.inject?.skills ?? [],
      },
      require: {
        tools: result.right.require?.tools ?? [],
        skills: result.right.require?.skills ?? [],
      },
    });
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

const parseAgentModule = (
  sourcePath: string,
  raw: unknown,
): Effect.Effect<Agent, CompileError> =>
  Effect.gen(function* () {
    const sourceText = yield* readText(sourcePath, "agent");
    const bindingToolSlotSources = collectBindingToolSlotSources(sourcePath, sourceText);
    const result = Schema.decodeUnknownEither(AgentSchema, STRICT_PARSE_OPTIONS)(raw);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "agent",
          message: result.left.message,
        }),
      );
    }

    const parsed = result.right;
    const fileName = basename(sourcePath);
    const fileStem = stripSuffix(fileName, [AGENT_SUFFIX_TS]);

    if (parsed.name !== fileStem) {
      return yield* Effect.fail(
        new AgentNameMismatchError({
          sourcePath,
          fileStem,
          agentName: parsed.name,
        }),
      );
    }

    const traits: NormalizedTraitBinding[] = [];
    for (const [index, trait] of (parsed.traits ?? []).entries()) {
      const traitRef =
        typeof trait === "string" || trait.kind === "trait-ref"
          ? trait
          : trait.trait;
      const normalized = normalizeTraitRefInput(`traits[${index}]`, traitRef);
      if (typeof normalized !== "string") {
        return yield* Effect.fail(
          new SourceParseError({
            sourcePath,
            kind: "agent",
            message: `${normalized.field}: ${normalized.message}`,
          }),
        );
      }
      const tools: Record<string, { slots: Record<string, NormalizedTraitBindingToolSlot> }> = {};
      if (typeof trait !== "string" && trait.kind !== "trait-ref") {
        const sourceTools = bindingToolSlotSources.get(index) ?? new Map();
        for (const [logicalName, toolBinding] of Object.entries(trait.tools ?? {})) {
          const normalizedSlots: Record<string, NormalizedTraitBindingToolSlot> = {};
          const sourceSlots = sourceTools.get(logicalName) ?? new Map();
          for (const [slotName, schema] of Object.entries(toolBinding.slots ?? {})) {
            if (!isEffectSchema(schema)) {
              return yield* Effect.fail(
                new SourceParseError({
                  sourcePath,
                  kind: "agent",
                  message: `traits[${index}].tools.${logicalName}.slots.${slotName}: must be an Effect Schema`,
                }),
              );
            }
            const source = sourceSlots.get(slotName);
            if (!source) {
              return yield* Effect.fail(
                new SourceParseError({
                  sourcePath,
                  kind: "agent",
                  message:
                    `traits[${index}].tools.${logicalName}.slots.${slotName}: ` +
                    "must be an imported schema identifier; inline Effect Schema expressions are not supported",
                }),
              );
            }
            normalizedSlots[slotName] = { schema, source };
          }
          tools[logicalName] = { slots: normalizedSlots };
        }
      }
      traits.push({
        ref: normalized,
        tools,
      });
    }

    const model = parsed.model
      ? normalizeModelProfileRefInput("model", parsed.model)
      : undefined;
    if (model && typeof model !== "string") {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind: "agent",
          message: `${model.field}: ${model.message}`,
        }),
      );
    }

    if (model && !model.includes("/")) {
      return yield* Effect.fail(
        forbiddenFieldError(
          sourcePath,
          "agent",
          "model",
          "must reference a canonical model profile (<modelspace>/<name> or modelProfileRef(...))",
        ),
      );
    }

    const access = normalizeAccess(sourcePath, "agent", "access", parsed.access);
    if (access instanceof SourceParseError) {
      return yield* Effect.fail(access);
    }

    return new Agent({
      name: parsed.name,
      sourcePath,
      description: parsed.description,
      identity: parsed.identity,
      personality: parsed.personality,
      ...(model ? { model } : {}),
      traits,
      access,
      skills: parsed.skills ?? [],
      color: parsed.color,
      targets: parsed.targets ?? {},
    });
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

const normalizeLifecyclePhase = (
  sourcePath: string,
  phase: LifecycleDefinition["phases"][number],
  index: number,
): NormalizedLifecyclePhase | SourceParseError => {
  const lifecycle = phase.lifecycle
    ? normalizeLifecycleRefInput(`phases[${index}].lifecycle`, phase.lifecycle)
    : undefined;
  if (lifecycle && typeof lifecycle !== "string") {
    return new SourceParseError({
      sourcePath,
      kind: "lifecycle",
      message: `${lifecycle.field}: ${lifecycle.message}`,
    });
  }

  let lifecycleBinding:
    | { lifecycle: string; bindings?: Record<string, string> }
    | undefined;
  if (phase.lifecycle_binding) {
    const normalized = normalizeLifecycleRefInput(
      `phases[${index}].lifecycle_binding.lifecycle`,
      phase.lifecycle_binding.lifecycle,
    );
    if (typeof normalized !== "string") {
      return new SourceParseError({
        sourcePath,
        kind: "lifecycle",
        message: `${normalized.field}: ${normalized.message}`,
      });
    }
    lifecycleBinding = {
      lifecycle: normalized,
      ...(phase.lifecycle_binding.bindings
        ? { bindings: { ...phase.lifecycle_binding.bindings } }
        : {}),
    };
  }

  const aliasSources = [
    phase.agents && phase.agents.length > 0 ? "agents" : undefined,
    phase.agent ? "agent" : undefined,
  ].filter((value): value is string => value !== undefined);

  const uniqueAliases = [...new Set(aliasSources)];
  if (uniqueAliases.length > 1) {
    return new SourceParseError({
        sourcePath,
        kind: "lifecycle",
        message: `phase ${index + 1} ('${phase.name}') declares multiple agent assignment aliases (${uniqueAliases.join(", ")}); use only one of agent or agents`,
      });
  }

  const rawAgents = phase.agents ?? (phase.agent ? [phase.agent] : undefined) ?? [];

  const agents: string[] = [];
  for (const [agentIndex, agent] of rawAgents.entries()) {
    const normalized = normalizeAgentRefInput(
      `phases[${index}].agents[${agentIndex}]`,
      agent,
    );
    if (typeof normalized !== "string") {
      return new SourceParseError({
        sourcePath,
        kind: "lifecycle",
        message: `${normalized.field}: ${normalized.message}`,
      });
    }
    agents.push(normalized);
  }

  const requires: Array<{ all: string[]; min?: number }> = [];
  for (const [requirementIndex, requirement] of (phase.requires ?? []).entries()) {
    const all: string[] = [];
    for (const [traitIndex, trait] of requirement.all.entries()) {
      const normalized = normalizeTraitRefInput(
        `phases[${index}].requires[${requirementIndex}].all[${traitIndex}]`,
        trait,
      );
      if (typeof normalized !== "string") {
        return new SourceParseError({
          sourcePath,
          kind: "lifecycle",
          message: `${normalized.field}: ${normalized.message}`,
        });
      }
      all.push(normalized);
    }

    requires.push({ all, ...(requirement.min !== undefined ? { min: requirement.min } : {}) });
  }

  const singularAgent = phase.agent;
  let normalizedSingularAgent: string | undefined;
  if (singularAgent) {
    const normalized = normalizeAgentRefInput(`phases[${index}].agent`, singularAgent);
    if (typeof normalized !== "string") {
      return new SourceParseError({
        sourcePath,
        kind: "lifecycle",
        message: `${normalized.field}: ${normalized.message}`,
      });
    }
    normalizedSingularAgent = normalized;
  }

  return {
    name: phase.name,
    ...(lifecycle ? { lifecycle } : {}),
    ...(lifecycleBinding ? { lifecycle_binding: lifecycleBinding } : {}),
    ...(normalizedSingularAgent ? { agent: normalizedSingularAgent } : {}),
    agents,
    requires,
    notes: phase.notes,
  };
};

const parseCanonicalToolName = (ref: string): string => {
  const colon = ref.indexOf(":");
  return colon === -1 ? ref : ref.slice(colon + 1);
};

const normalizeLifecyclePermissionTool = (
  sourcePath: string,
  tool: LifecycleToolPermissionTool,
  permissionIndex: number,
  toolIndex: number,
): NormalizedLifecycleToolPermission["tools"][number] | SourceParseError => {
  const rawRef = typeof tool === "string" ? tool : tool.ref;
  const ref = rawRef.trim();
  if (!ref) {
    return new SourceParseError({
      sourcePath,
      kind: "lifecycle",
      message: `tool_permissions[${permissionIndex}].tools[${toolIndex}].ref: must be a non-empty canonical tool reference`,
    });
  }

  const rawLogicalName =
    typeof tool === "string" ? parseCanonicalToolName(ref) : tool.as ?? parseCanonicalToolName(ref);
  const logicalName = rawLogicalName.trim();
  if (!logicalName) {
    return new SourceParseError({
      sourcePath,
      kind: "lifecycle",
      message: `tool_permissions[${permissionIndex}].tools[${toolIndex}].as: must be non-empty when provided`,
    });
  }

  return {
    ref,
    logicalName,
  };
};

const normalizeLifecycleToolPermissions = (
  sourcePath: string,
  permissions: LifecycleDefinition["tool_permissions"],
): NormalizedLifecycleToolPermission[] | SourceParseError => {
  const normalized: NormalizedLifecycleToolPermission[] = [];

  for (const [permissionIndex, permission] of (permissions ?? []).entries()) {
    const agents: string[] = [];
    for (const [agentIndex, agent] of permission.agents.entries()) {
      const normalizedAgent = normalizeAgentRefInput(
        `tool_permissions[${permissionIndex}].agents[${agentIndex}]`,
        agent,
      );
      if (typeof normalizedAgent !== "string") {
        return new SourceParseError({
          sourcePath,
          kind: "lifecycle",
          message: `${normalizedAgent.field}: ${normalizedAgent.message}`,
        });
      }
      agents.push(normalizedAgent);
    }

    const tools: Array<NormalizedLifecycleToolPermission["tools"][number]> = [];
    const logicalNames = new Set<string>();
    for (const [toolIndex, tool] of permission.tools.entries()) {
      const normalizedTool = normalizeLifecyclePermissionTool(
        sourcePath,
        tool,
        permissionIndex,
        toolIndex,
      );
      if (normalizedTool instanceof SourceParseError) {
        return normalizedTool;
      }
      if (logicalNames.has(normalizedTool.logicalName)) {
        return new SourceParseError({
          sourcePath,
          kind: "lifecycle",
          message: `tool_permissions[${permissionIndex}].tools[${toolIndex}].as: duplicate logical tool name '${normalizedTool.logicalName}'`,
        });
      }
      logicalNames.add(normalizedTool.logicalName);
      tools.push(normalizedTool);
    }

    normalized.push({
      agents,
      tools,
    });
  }

  return normalized;
};

const parseLifecycleDefinition = (
  sourcePath: string,
  raw: unknown,
  kind: "lifecycle",
  body: string,
): Effect.Effect<Lifecycle, CompileError> =>
  Effect.gen(function* () {
    const result = Schema.decodeUnknownEither(LifecycleDefinitionSchema, STRICT_PARSE_OPTIONS)(raw);
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
    const fileStem = stripSuffix(basename(sourcePath), [LIFECYCLE_SUFFIX_TS]);
    if (parsed.name !== fileStem) {
      return yield* Effect.fail(
        new SourceParseError({
          sourcePath,
          kind,
          message: `lifecycle 'name' field ('${parsed.name}') must match file stem ('${fileStem}')`,
        }),
      );
    }

    const phases: NormalizedLifecyclePhase[] = [];
    for (const [index, phase] of parsed.phases.entries()) {
      const normalized = normalizeLifecyclePhase(sourcePath, phase, index);
      if (normalized instanceof SourceParseError) {
        return yield* Effect.fail(normalized);
      }
      phases.push(normalized);
    }

    const toolPermissions = normalizeLifecycleToolPermissions(sourcePath, parsed.tool_permissions);
    if (toolPermissions instanceof SourceParseError) {
      return yield* Effect.fail(toolPermissions);
    }

    return new Lifecycle({
      name: parsed.name,
      sourcePath,
      description: parsed.description,
      produces: parsed.produces,
      parameters: (parsed.parameters ?? []).map((parameter) => ({
        ...parameter,
        required: parameter.required ?? true,
      })),
      phases,
      tool_permissions: toolPermissions,
      taste_checkpoints: parsed.taste_checkpoints ?? [],
      evolution: parsed.evolution,
      body: body.trim(),
    });
  });

const parseLifecycleTs = (
  sourcePath: string,
): Effect.Effect<Lifecycle, CompileError> =>
  Effect.gen(function* () {
    const raw = yield* importTsModule<unknown>(sourcePath, "lifecycle");
    return yield* parseLifecycleDefinition(sourcePath, raw, "lifecycle", "");
  });

const loadLifecycles = (
  pluginPath: string,
): Effect.Effect<Map<string, Lifecycle>, CompileError> =>
  Effect.gen(function* () {
    const dir = join(pluginPath, "lifecycles");
    const entries = yield* listDir(dir);
    const map = new Map<string, Lifecycle>();

    for (const entry of entries.sort()) {
      if (!entry.endsWith(LIFECYCLE_SUFFIX_TS)) {
        continue;
      }

      const lifecycle = yield* parseLifecycleTs(join(dir, entry));

      const existing = map.get(lifecycle.name);
      if (existing) {
        return yield* Effect.fail(
          new DuplicateNameError({
            kind: "lifecycle",
            name: lifecycle.name,
            firstPath: existing.sourcePath,
            secondPath: lifecycle.sourcePath,
          }),
        );
      }

      map.set(lifecycle.name, lifecycle);
    }

    return map;
  });

interface PluginManifest {
  name: string;
  version: string;
  deps: Record<string, string>;
}

const readPluginManifest = (
  pluginPath: string,
): Effect.Effect<PluginManifest, CompileError> =>
  Effect.gen(function* () {
    const manifestPath = join(pluginPath, "plugin.json");
    const raw = yield* Effect.tryPromise({
      try: () => Bun.file(manifestPath).json(),
      catch: (cause) =>
        new PluginManifestError({
          pluginPath,
          message:
            cause instanceof Error
              ? `failed to read plugin.json: ${cause.message}`
              : "failed to read plugin.json",
        }),
    });

    const data = raw as Record<string, unknown>;
    const name = typeof data.name === "string" ? data.name : undefined;
    if (!name) {
      return yield* Effect.fail(
        new PluginManifestError({
          pluginPath,
          message: "plugin.json is missing 'name' field",
        }),
      );
    }

    const version = typeof data.version === "string" ? data.version : undefined;
    if (!version) {
      return yield* Effect.fail(
        new PluginManifestError({
          pluginPath,
          message: "plugin.json is missing 'version' field",
        }),
      );
    }

    const rawDeps = data.deps;
    let deps: Record<string, string> = {};
    if (rawDeps !== undefined) {
      if (rawDeps === null || typeof rawDeps !== "object" || Array.isArray(rawDeps)) {
        return yield* Effect.fail(
          new PluginManifestError({
            pluginPath,
            message: "plugin.json 'deps' must be an object of {depName: localPath}",
          }),
        );
      }

      for (const [depName, depValue] of Object.entries(rawDeps as Record<string, unknown>)) {
        if (typeof depValue !== "string") {
          return yield* Effect.fail(
            new PluginManifestError({
              pluginPath,
              message: `plugin.json dep '${depName}' must be a string local path`,
            }),
          );
        }
        deps[depName] = depValue;
      }
    }

    return { name, version, deps };
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
): Effect.Effect<PluginRegistry, CompileError> =>
  Effect.gen(function* () {
    const registry = emptyRegistry(pluginPath, pluginName, pluginVersion, dependencyPaths);
    registry.identities = yield* loadIdentities(pluginPath);
    registry.personalities = yield* loadPersonalities(pluginPath);
    registry.toolspaces = yield* loadToolspaces(pluginPath);
    registry.modelspaces = yield* loadModelspaces(pluginPath);
    registry.traits = yield* loadTraits(pluginPath);
    registry.tools = yield* loadCanonicalTools(pluginPath);
    registry.lifecycles = yield* loadLifecycles(pluginPath);
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
