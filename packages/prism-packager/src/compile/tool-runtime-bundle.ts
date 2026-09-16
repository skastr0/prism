import { stripBundlerPathComments } from "./bundle-normalize.js";
import { getAstToJsonSchemaSource } from "./embedded-runtime-sources.js";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BundleBuildError } from "../errors.js";
import type { ResolvedContractBinding } from "./resolve.js";
import {
  collectRelativeImportSpecifiers,
  NODE_BUILTIN_EXTERNALS,
  relativeModulePath,
  rewriteBareEffectImportsForBundle,
  rewriteBarePluginDependencyImportsForBundle,
  rewriteGeneratedPluginBundleImports,
  resolveImportedSourcePath,
  resolveTsImportCandidate,
  stripToolAuthoringHelpers,
} from "./bundle-utils.js";
import {
  effectBundleImportPath,
  zodV4BundleImportPath,
} from "./runtime-deps.js";
import {
  generatedToolNameForBinding,
  sourceIsInside,
} from "./generated-plugin.js";

const AST_TO_JSON_SCHEMA_RUNTIME_IMPORT =
  `import { astToJsonSchema as coreAstToJsonSchema, MCP_AST_TO_JSON_SCHEMA_OPTIONS } from "./ast-to-json-schema.ts";`;

interface MirrorFile {
  readonly relativePath: string;
  readonly sourcePath?: string;
  readonly content?: string;
}

interface PluginMirror {
  readonly pluginName: string;
  readonly pluginRoot?: string;
  readonly files: ReadonlyArray<MirrorFile>;
}

interface ToolAdapterSpec {
  /** Generated identity used in runtime maps / native registration. */
  readonly name: string;
  readonly logicalName: string;
  readonly pluginName: string;
  readonly toolName: string;
  readonly sourcePath: string;
}

export interface AmpPluginBundleOptions {
  readonly sourcePluginName: string;
  readonly sourcePluginRoot?: string;
  readonly dependencyPluginRoots?: ReadonlyMap<string, string> | ReadonlyArray<readonly [string, string]>;
  readonly version?: string;
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
  readonly setupImports?: string;
  readonly setupSource?: string;
}

export interface AmpPluginBundle {
  readonly content: string;
  readonly toolNames: ReadonlyArray<string>;
}

export interface PiExtensionBundleOptions {
  readonly sourcePluginName: string;
  readonly sourcePluginRoot?: string;
  readonly dependencyPluginRoots?: ReadonlyMap<string, string> | ReadonlyArray<readonly [string, string]>;
  readonly version?: string;
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
  readonly setupImports?: string;
  readonly setupSource?: string;
  readonly runtimeAgent?: string;
  readonly harnessLabel?: string;
}

export interface PiExtensionBundle {
  readonly content: string;
  readonly toolNames: ReadonlyArray<string>;
}

const normalizeRelativePath = (path: string): string => path.replace(/\\/g, "/");

/** Generated tool name for a binding (canonical). */
export const cliToolNameForBinding = (binding: ResolvedContractBinding): string =>
  generatedToolNameForBinding(binding);

export const ampPluginToolNameForBinding = cliToolNameForBinding;

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
};

const resolveMirrorImport = async (options: {
  readonly pluginRoot: string;
  readonly file: MirrorFile;
  readonly specifier: string;
}): Promise<MirrorFile | undefined> => {
  const basePath = options.file.sourcePath
    ? dirname(options.file.sourcePath)
    : dirname(join(options.pluginRoot, options.file.relativePath));
  const resolved = await resolveTsImportCandidate(resolve(basePath, options.specifier), fileExists);
  if (!resolved || !sourceIsInside(resolved, options.pluginRoot)) return undefined;

  return {
    relativePath: normalizeRelativePath(relative(options.pluginRoot, resolved)),
    sourcePath: resolved,
  };
};

const collectMirrorRuntimeClosure = async (
  pluginRoot: string,
  entries: ReadonlyArray<MirrorFile>,
): Promise<MirrorFile[]> => {
  const files = new Map<string, MirrorFile>();
  const queue: MirrorFile[] = [...entries];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file.relativePath)) continue;
    files.set(file.relativePath, file);

    const source = file.content ?? (file.sourcePath ? await readFile(file.sourcePath, "utf8") : "");
    for (const specifier of collectRelativeImportSpecifiers(source)) {
      const imported = await resolveMirrorImport({ pluginRoot, file, specifier });
      if (!imported || files.has(imported.relativePath)) continue;
      queue.push(imported);
    }
  }

  return [...files.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
};

const pluginRootFromToolSource = (toolSourcePath: string): string =>
  dirname(dirname(toolSourcePath));

interface PluginMirrorCollectionState {
  readonly byPlugin: Map<
    string,
    { pluginRoot: string; entries: Map<string, MirrorFile> }
  >;
}

const createPluginMirrorCollectionState = (
  dependencyPluginRoots: ReadonlyMap<string, string> | ReadonlyArray<readonly [string, string]>,
): PluginMirrorCollectionState => {
  const byPlugin = new Map<string, { pluginRoot: string; entries: Map<string, MirrorFile> }>();
  for (const [pluginName, pluginRoot] of dependencyPluginRoots instanceof Map
    ? dependencyPluginRoots.entries()
    : dependencyPluginRoots) {
    byPlugin.set(pluginName, { pluginRoot, entries: new Map() });
  }
  return { byPlugin };
};

const getOrCreateMirrorPluginEntries = (
  state: PluginMirrorCollectionState,
  pluginName: string,
  pluginRoot: string,
): Map<string, MirrorFile> => {
  const current = state.byPlugin.get(pluginName) ?? {
    pluginRoot,
    entries: new Map<string, MirrorFile>(),
  };
  state.byPlugin.set(pluginName, current);
  return current.entries;
};

const registerBindingMirrorInputs = (
  state: PluginMirrorCollectionState,
  binding: ResolvedContractBinding,
): void => {
  const toolRoot = pluginRootFromToolSource(binding.toolSourcePath);
  getOrCreateMirrorPluginEntries(state, binding.toolPluginName, toolRoot).set(
    `tools/${binding.toolName}.tool.ts`,
    {
      relativePath: `tools/${binding.toolName}.tool.ts`,
      sourcePath: binding.toolSourcePath,
    },
  );
};

const registerBindingsMirrorInputs = (
  state: PluginMirrorCollectionState,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): void => {
  for (const binding of bindings) {
    registerBindingMirrorInputs(state, binding);
  }
};

const expandSamePluginRuntimeClosures = async (
  state: PluginMirrorCollectionState,
): Promise<void> => {
  for (const [, plugin] of state.byPlugin) {
    const closure = await collectMirrorRuntimeClosure(
      plugin.pluginRoot,
      [...plugin.entries.values()],
    );
    plugin.entries.clear();
    for (const file of closure) plugin.entries.set(file.relativePath, file);
  }
};

const collectCrossPluginRuntimeClosure = async (
  state: PluginMirrorCollectionState,
): Promise<void> => {
  const pluginRoots = new Map(
    [...state.byPlugin.entries()].map(
      ([pluginName, plugin]) => [pluginName, plugin.pluginRoot] as const,
    ),
  );
  const queue: Array<{ pluginName: string; file: MirrorFile }> = [];
  for (const [pluginName, plugin] of state.byPlugin) {
    for (const file of plugin.entries.values()) queue.push({ pluginName, file });
  }

  for (let index = 0; index < queue.length; index++) {
    const { pluginName, file } = queue[index]!;
    const plugin = state.byPlugin.get(pluginName);
    if (!plugin) continue;
    const source = file.content ?? (file.sourcePath ? await readFile(file.sourcePath, "utf8") : "");
    const basePath = file.sourcePath
      ? dirname(file.sourcePath)
      : dirname(join(plugin.pluginRoot, file.relativePath));

    for (const specifier of collectRelativeImportSpecifiers(source)) {
      await addCrossPluginMirrorImport(
        state,
        pluginName,
        basePath,
        specifier,
        pluginRoots,
        queue,
      );
    }
  }
};

const addCrossPluginMirrorImport = async (
  state: PluginMirrorCollectionState,
  pluginName: string,
  basePath: string,
  specifier: string,
  pluginRoots: ReadonlyMap<string, string>,
  queue: Array<{ pluginName: string; file: MirrorFile }>,
): Promise<void> => {
  const resolved = await resolveTsImportCandidate(resolve(basePath, specifier), fileExists);
  if (!resolved) return;
  const owner = findSourcePlugin(resolved, pluginRoots);
  if (!owner || owner.pluginName === pluginName) return;

  const ownerState = state.byPlugin.get(owner.pluginName);
  if (!ownerState) return;
  const relativePath = normalizeRelativePath(relative(owner.pluginRoot, resolved));
  if (ownerState.entries.has(relativePath)) return;
  const imported: MirrorFile = { relativePath, sourcePath: resolved };
  ownerState.entries.set(relativePath, imported);
  queue.push({ pluginName: owner.pluginName, file: imported });
};

const buildPluginMirrorsFromState = async (
  state: PluginMirrorCollectionState,
): Promise<PluginMirror[]> => {
  const mirrors: PluginMirror[] = [];
  for (const [pluginName, plugin] of state.byPlugin) {
    if (plugin.entries.size === 0) continue;
    mirrors.push({
      pluginName,
      pluginRoot: plugin.pluginRoot,
      files: await collectMirrorRuntimeClosure(plugin.pluginRoot, [...plugin.entries.values()]),
    });
  }

  return mirrors.sort((left, right) => left.pluginName.localeCompare(right.pluginName));
};

const collectMirrorsForBindings = async (
  bindings: ReadonlyArray<ResolvedContractBinding>,
  dependencyPluginRoots: ReadonlyMap<string, string> | ReadonlyArray<readonly [string, string]> = [],
): Promise<PluginMirror[]> => {
  const state = createPluginMirrorCollectionState(dependencyPluginRoots);
  registerBindingsMirrorInputs(state, bindings);
  await expandSamePluginRuntimeClosures(state);
  await collectCrossPluginRuntimeClosure(state);
  return buildPluginMirrorsFromState(state);
};

const findSourcePlugin = (
  sourcePath: string,
  pluginRoots: ReadonlyMap<string, string>,
): { pluginName: string; pluginRoot: string } | undefined => {
  const matches = [...pluginRoots.entries()]
    .filter(([, pluginRoot]) => sourceIsInside(sourcePath, pluginRoot))
    .sort((left, right) => right[1].length - left[1].length);
  const first = matches[0];
  return first ? { pluginName: first[0], pluginRoot: first[1] } : undefined;
};

const rewriteCrossPluginRelativeImports = (options: {
  readonly pluginName: string;
  readonly pluginRoot?: string;
  readonly sourcePath?: string;
  readonly source: string;
  readonly currentGeneratedPath: string;
  readonly importPluginRoots: ReadonlyMap<string, string>;
}): string => {
  if (!options.sourcePath || !options.pluginRoot) return options.source;

  return options.source.replace(
    /(\bfrom\s+)(["'])(\.[^"']+)\2/g,
    (match, prefix: string, quote: string, specifier: string) => {
      const importedSourcePath = resolveImportedSourcePath(options.sourcePath!, specifier);
      const owner = findSourcePlugin(importedSourcePath, options.importPluginRoots);
      if (!owner || owner.pluginName === options.pluginName) return match;

      const modulePath = normalizeRelativePath(
        relative(owner.pluginRoot, importedSourcePath),
      ).replace(/\.ts$/, "");
      const targetGeneratedPath = `plugins/${owner.pluginName}/${modulePath}`;
      return `${prefix}${quote}${relativeModulePath(
        options.currentGeneratedPath,
        targetGeneratedPath,
      )}${quote}`;
    },
  );
};

const normalizeMirroredPluginSource = async (options: {
  readonly pluginName: string;
  readonly pluginRoot?: string;
  readonly relativePath: string;
  readonly sourcePath?: string;
  readonly source: string;
  readonly importPluginRoots: ReadonlyMap<string, string>;
}): Promise<string> => {
  const currentGeneratedPath = `plugins/${options.pluginName}/${options.relativePath}`;
  const withCrossPluginImports = rewriteCrossPluginRelativeImports({
    pluginName: options.pluginName,
    pluginRoot: options.pluginRoot,
    sourcePath: options.sourcePath,
    source: options.source,
    currentGeneratedPath,
    importPluginRoots: options.importPluginRoots,
  });
  const withStandaloneImports = rewriteGeneratedPluginBundleImports(
    withCrossPluginImports,
    currentGeneratedPath,
  );

  const withBundledEffectImports = rewriteBareEffectImportsForBundle(withStandaloneImports);
  const withPluginDependencyImports = await rewriteBarePluginDependencyImportsForBundle({
    source: withBundledEffectImports,
    pluginRoot: options.pluginRoot,
  });

  if (!options.relativePath.endsWith(".tool.ts")) return withPluginDependencyImports;

  return stripToolAuthoringHelpers(withPluginDependencyImports)
    .replace(/\bdefineTool\s*\(/g, "(")
    .replace(/\bschemaSlot\s*\(/g, "(");
};

const adapterSpecsForBindings = (
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ToolAdapterSpec[] => {
  const byName = new Map<string, ToolAdapterSpec>();
  const specs: ToolAdapterSpec[] = [];
  for (const binding of bindings) {
    const name = cliToolNameForBinding(binding);
    const spec: ToolAdapterSpec = {
      name,
      logicalName: binding.logicalName,
      pluginName: binding.toolPluginName,
      toolName: binding.toolName,
      sourcePath: binding.toolSourcePath,
    };

    const existing = byName.get(name);
    if (existing) {
      if (toolAdapterSpecsEqual(existing, spec)) continue;
      throw new Error(
        `tool name collision for '${name}': ${describeToolAdapterSpec(existing)} conflicts with ${describeToolAdapterSpec(spec)}`,
      );
    }
    byName.set(name, spec);
    specs.push(spec);
  }
  return specs.sort((left, right) => left.name.localeCompare(right.name));
};

const toolAdapterSpecsEqual = (left: ToolAdapterSpec, right: ToolAdapterSpec): boolean =>
  left.name === right.name &&
  left.pluginName === right.pluginName &&
  left.toolName === right.toolName &&
  left.sourcePath === right.sourcePath;

const describeToolAdapterSpec = (spec: ToolAdapterSpec): string =>
  `tool ${spec.pluginName}/${spec.toolName} as ${spec.name}`;

const safeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_$]/g, "_").replace(/^[^a-zA-Z_$]/, "_$&");

const SCHEMA_ANNOTATION_HELPERS = `const extractDescriptionOrTitle = (ast: SchemaAST.AST): string | undefined =>
  SchemaAST.resolveDescription(ast) ?? SchemaAST.resolveTitle(ast);

/** A node's encoded side is its wire shape; refinements and transformations do not change it. */
const encodedAstOf = (ast: SchemaAST.AST): SchemaAST.AST =>
  ast.encoding === undefined ? ast : encodedAstOf(ast.encoding[ast.encoding.length - 1]!.to);

const isFreeFormAst = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isUnknown(ast) || SchemaAST.isAny(ast);`;

const TOOL_SURFACE_RUNTIME_TYPES = `type JsonSchema = Record<string, any>;
type ZodSchema = z.ZodType<any, any>;
type ToolSurface = {
  description?: string;
  input?: Schema.Top;
  output?: Schema.Top;
  Input?: Schema.Top;
  Output?: Schema.Top;
  handle: (input: unknown, context: ToolRuntimeContext) => Promise<unknown>;
};

interface ToolRuntimeContext {
  sessionID: string;
  agent: string;
  timestamp: string;
  workingDirectory?: string;
  repoRoot?: string;
  signal?: AbortSignal;
}`;

const SCHEMA_BRIDGE_RUNTIME = `${SCHEMA_ANNOTATION_HELPERS}

const schemaBridgeName = __PRISM_SCHEMA_BRIDGE_NAME__;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const unsupportedAst = (ast: SchemaAST.AST, detail?: string): never => {
  throw new Error(
    schemaBridgeName + ": unsupported AST tag: " + ast._tag + (detail ? " (" + detail + ")" : ""),
  );
};

const astToJsonSchema = (ast: SchemaAST.AST): JsonSchema =>
  coreAstToJsonSchema(ast, {
    ...MCP_AST_TO_JSON_SCHEMA_OPTIONS,
    errorPrefix: schemaBridgeName,
  });

const inputJsonSchemaFromEffectSchema = (schema: Schema.Top): JsonSchema => {
  if (!SchemaAST.isObjects(schema.ast)) {
    unsupportedAst(schema.ast, "top-level Input must be a Schema.Struct");
  }
  return astToJsonSchema(schema.ast);
};

const literalToZod = (literal: string | number | boolean | null): ZodSchema => {
  // Use z.enum for string literals so the emitted JSON Schema uses "enum"
  // instead of "const" — enum is draft-07 compatible and widely supported.
  if (typeof literal === "string") {
    return z.enum([literal] as [string, ...string[]]);
  }
  return z.literal(literal);
};

const unionToZod = (members: ZodSchema[]): ZodSchema => {
  if (members.length === 0) return z.undefined();
  if (members.length === 1) return members[0]!;
  return z.union(members as [ZodSchema, ZodSchema, ...ZodSchema[]]);
};

const astToZodSchema = (ast: SchemaAST.AST): ZodSchema => {
  const target = encodedAstOf(ast);
  if (SchemaAST.isString(target)) return z.string();
  if (SchemaAST.isNumber(target)) return z.number();
  if (SchemaAST.isBoolean(target)) return z.boolean();
  if (isFreeFormAst(target)) return z.any();
  if (SchemaAST.isUndefined(target)) return z.undefined();
  if (SchemaAST.isNull(target)) return z.null();
  if (SchemaAST.isLiteral(target)) {
    return literalToZod(target.literal as string | number | boolean | null);
  }
  if (SchemaAST.isUnion(target)) {
    const nonUndefined = target.types.filter((type) => !SchemaAST.isUndefined(type));
    return unionToZod(nonUndefined.map(astToZodSchema));
  }
  if (SchemaAST.isArrays(target)) {
    // A simple array has no fixed elements and exactly one rest element, which
    // is the element AST itself (not a type wrapper as in v3).
    if (target.elements.length === 0 && target.rest.length === 1) {
      return z.array(astToZodSchema(target.rest[0]!));
    }
    unsupportedAst(target, "array elements=" + target.elements.length + ", rest=" + target.rest.length);
  }
  if (SchemaAST.isObjects(target)) {
    // Pure Schema.Record → open string-keyed map (JSON Schema additionalProperties).
    if (target.propertySignatures.length === 0 && target.indexSignatures.length > 0) {
      const index = target.indexSignatures[0]!;
      if (isFreeFormAst(index.type)) return z.record(z.string(), z.unknown());
      return z.record(z.string(), astToZodSchema(index.type));
    }
    const properties: Record<string, ZodSchema> = {};
    for (const prop of target.propertySignatures) {
      const description = extractDescriptionOrTitle(prop.type);
      let property = astToZodSchema(prop.type);
      if (description) property = property.describe(description);
      properties[String(prop.name)] = SchemaAST.isOptional(prop.type) ? property.optional() : property;
    }
    let objectSchema = z.object(properties);
    if (target.indexSignatures.length > 0) {
      const index = target.indexSignatures[0]!;
      const value = isFreeFormAst(index.type) ? z.unknown() : astToZodSchema(index.type);
      objectSchema = objectSchema.catchall(value);
    }
    return objectSchema;
  }
  if (SchemaAST.isSuspend(target)) return astToZodSchema(target.thunk());
  return unsupportedAst(target);
};

const unwrapObjectAst = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (ast.encoding !== undefined) {
    return unwrapObjectAst(ast.encoding[ast.encoding.length - 1]!.to);
  }
  if (SchemaAST.isSuspend(ast)) return unwrapObjectAst(ast.thunk());
  return ast;
};

const objectZodFromEffectSchema = (
  schema: Schema.Top,
  topLevelName: "Input/input" | "Output/output",
): ZodSchema => {
  const ast = unwrapObjectAst(schema.ast);
  if (!SchemaAST.isObjects(ast)) {
    unsupportedAst(ast, "top-level " + topLevelName + " must be a Schema.Struct");
  }
  return astToZodSchema(ast);
};

const decodeWithSchema = <A>(schema: Schema.Codec<A, unknown, never, never>, raw: unknown): A =>
  Schema.decodeUnknownSync(schema)(raw);`;

const AMP_TOOL_FACTORY_RUNTIME = `const runtimeContext = (): ToolRuntimeContext => ({
  sessionID: "amp-plugin",
  agent: "amp",
  timestamp: new Date().toISOString(),
  workingDirectory: process.cwd(),
  repoRoot: process.cwd(),
});

const createToolDefinition = (name: string, surface: ToolSurface) => {
  const inputSchema = surface.Input ?? surface.input;
  const outputSchema = surface.Output ?? surface.output;
  if (!inputSchema) throw new Error("Amp tool '" + name + "' is missing an Input/input schema");
  if (!outputSchema) throw new Error("Amp tool '" + name + "' is missing an Output/output schema");
  let inputJsonSchema: JsonSchema;
  try {
    inputJsonSchema = inputJsonSchemaFromEffectSchema(inputSchema);
  } catch (error) {
    throw new Error("Amp tool '" + name + "' has unsupported Input/input schema: " + errorMessage(error));
  }

  return {
    name,
    description: surface.description ?? "",
    inputSchema: inputJsonSchema,
    async execute(rawArgs: Record<string, unknown>, ctx: { logger?: { log: (...args: unknown[]) => void } }) {
      try {
        const input = decodeWithSchema(inputSchema as Schema.Codec<unknown, unknown, never, never>, rawArgs ?? {});
        const output = await surface.handle(input, runtimeContext());
        const validatedOutput = decodeWithSchema(outputSchema as Schema.Codec<unknown, unknown, never, never>, output);
        return JSON.stringify(validatedOutput, null, 2);
      } catch (error) {
        ctx.logger?.log("prism Amp tool failed", name, errorMessage(error));
        throw error;
      }
    },
  };
};

const toolDefinitions = [
__PRISM_TOOL_ENTRIES__
];

export default function (amp: {
  registerTool(definition: any): unknown;
  registerCommand?: (id: string, options: any, handler: (ctx: any) => void | Promise<void>) => unknown;
  on?: (event: string, handler: any) => unknown;
}) {
  for (const definition of toolDefinitions) {
    amp.registerTool(definition);
  }
__PRISM_PLUGIN_SETUP__
}`;

const PI_EXTENSION_RUNTIME = `const runtimeRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const runtimeContext = (ctx?: unknown, signal?: AbortSignal): ToolRuntimeContext => {
  const context = runtimeRecord(ctx);
  const cwd = typeof context?.cwd === "string" ? context.cwd : process.cwd();
  const sessionManager = runtimeRecord(context?.sessionManager);
  const getSessionFile = sessionManager?.getSessionFile;
  const sessionFile = typeof getSessionFile === "function"
    ? Reflect.apply(getSessionFile, sessionManager, [])
    : undefined;
  return {
    sessionID: typeof sessionFile === "string" ? sessionFile : __PRISM_RUNTIME_AGENT__,
    agent: __PRISM_RUNTIME_AGENT__,
    timestamp: new Date().toISOString(),
    workingDirectory: cwd,
    repoRoot: cwd,
    ...(signal ? { signal } : {}),
  };
};

const createToolDefinition = (name: string, surface: ToolSurface) => {
  const inputSchema = surface.Input ?? surface.input;
  const outputSchema = surface.Output ?? surface.output;
  if (!inputSchema) throw new Error(__PRISM_HARNESS_LABEL__ + " tool '" + name + "' is missing an Input/input schema");
  if (!outputSchema) throw new Error(__PRISM_HARNESS_LABEL__ + " tool '" + name + "' is missing an Output/output schema");
  let inputJsonSchema: JsonSchema;
  try {
    inputJsonSchema = inputJsonSchemaFromEffectSchema(inputSchema);
  } catch (error) {
    throw new Error(__PRISM_HARNESS_LABEL__ + " tool '" + name + "' has unsupported Input/input schema: " + errorMessage(error));
  }

  return {
    name,
    label: name,
    description: surface.description ?? "",
    promptSnippet: (surface.description ?? name).slice(0, 240),
    parameters: inputJsonSchema,
    async execute(
      _toolCallId: string,
      rawArgs: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: unknown,
    ) {
      const input = decodeWithSchema(inputSchema as Schema.Codec<unknown, unknown, never, never>, rawArgs ?? {});
      const output = await surface.handle(input, runtimeContext(ctx, signal));
      const validatedOutput = decodeWithSchema(outputSchema as Schema.Codec<unknown, unknown, never, never>, output);
      return {
        content: [{ type: "text", text: JSON.stringify(validatedOutput, null, 2) }],
        details: { structuredContent: validatedOutput },
      };
    },
  };
};

const toolDefinitions = [
__PRISM_TOOL_ENTRIES__
];

export default function (pi: {
  registerTool(definition: unknown): unknown;
  on?: (event: string, handler: (event: unknown, context: unknown) => unknown) => unknown;
}) {
  for (const definition of toolDefinitions) {
    pi.registerTool(definition);
  }
__PRISM_EXTENSION_SETUP__
}`;

const replaceTemplateTokens = (
  source: string,
  replacements: Readonly<Record<string, string>>,
): string => {
  let rendered = source;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, value);
  }
  return rendered;
};

const joinGeneratedSections = (sections: ReadonlyArray<string>): string =>
  `${sections.filter((section) => section.trim().length > 0).join("\n\n")}\n`;
const renderSchemaBridgeRuntime = (schemaBridgeName: string): string =>
  replaceTemplateTokens(SCHEMA_BRIDGE_RUNTIME, {
    __PRISM_SCHEMA_BRIDGE_NAME__: JSON.stringify(schemaBridgeName),
  });

interface RenderedToolSurfaceBindings {
  readonly imports: string;
  readonly entries: string;
}

const renderToolSurfaceImport = (ident: string, spec: ToolAdapterSpec): string =>
  `import ${ident} from ${JSON.stringify(`./plugins/${spec.pluginName}/tools/${spec.toolName}.tool`)};`;

const renderToolSurfaceBindings = (
  specs: ReadonlyArray<ToolAdapterSpec>,
  renderEntry: (spec: ToolAdapterSpec, ident: string) => string,
): RenderedToolSurfaceBindings => {
  const imports: string[] = [];
  const entries: string[] = [];
  for (const [index, spec] of specs.entries()) {
    const ident = `surface_${index}_${safeIdentifier(spec.name)}`;
    imports.push(renderToolSurfaceImport(ident, spec));
    entries.push(renderEntry(spec, ident));
  }
  return { imports: imports.join("\n"), entries: entries.join("\n") };
};
const renderAmpToolRegistrationRuntime = (
  toolEntries: string,
  setupSource: string | undefined,
): string =>
  replaceTemplateTokens(AMP_TOOL_FACTORY_RUNTIME, {
    __PRISM_TOOL_ENTRIES__: toolEntries,
    __PRISM_PLUGIN_SETUP__: setupSource ? setupSource.trimEnd().replace(/^/gm, "  ") : "",
  });

const renderPiExtensionRuntime = (
  toolEntries: string,
  setupSource: string | undefined,
  runtimeAgent: string,
  harnessLabel: string,
): string =>
  replaceTemplateTokens(PI_EXTENSION_RUNTIME, {
    __PRISM_TOOL_ENTRIES__: toolEntries,
    __PRISM_EXTENSION_SETUP__: setupSource ? setupSource.trimEnd().replace(/^/gm, "  ") : "",
    __PRISM_RUNTIME_AGENT__: JSON.stringify(runtimeAgent),
    __PRISM_HARNESS_LABEL__: JSON.stringify(harnessLabel),
  });
const renderAmpPluginEntry = (options: {
  readonly sourcePluginName: string;
  readonly version: string;
  readonly specs: ReadonlyArray<ToolAdapterSpec>;
  readonly setupImports?: string;
  readonly setupSource?: string;
}): string => {
  const { imports, entries } = renderToolSurfaceBindings(
    options.specs,
    (spec, ident) =>
      `  createToolDefinition(${JSON.stringify(spec.name)}, ${ident} as ToolSurface),`,
  );

  return joinGeneratedSections([
    `// GENERATED by prism — do not edit.
// Amp plugin for compiled canonical tool bindings.
// Source plugin: ${options.sourcePluginName} v${options.version}`,
    `import { Schema, SchemaAST } from ${JSON.stringify(effectBundleImportPath())};`,
    `import * as z from ${JSON.stringify(zodV4BundleImportPath())};`,
    imports,
    options.setupImports ?? "",
    AST_TO_JSON_SCHEMA_RUNTIME_IMPORT,
    TOOL_SURFACE_RUNTIME_TYPES,
    renderSchemaBridgeRuntime("amp-schema-bridge"),
    renderAmpToolRegistrationRuntime(entries, options.setupSource),
  ]);
};

const renderPiExtensionEntry = (options: {
  readonly sourcePluginName: string;
  readonly version: string;
  readonly specs: ReadonlyArray<ToolAdapterSpec>;
  readonly setupImports?: string;
  readonly setupSource?: string;
  readonly runtimeAgent: string;
  readonly harnessLabel: string;
}): string => {
  const { imports, entries } = renderToolSurfaceBindings(
    options.specs,
    (spec, ident) =>
      `  createToolDefinition(${JSON.stringify(spec.name)}, ${ident} as ToolSurface),`,
  );

  return joinGeneratedSections([
    `// GENERATED by prism — do not edit.
// ${options.harnessLabel} extension for compiled Prism canonical tool bindings.
// Source plugin: ${options.sourcePluginName} v${options.version}`,
    `import { Schema, SchemaAST } from ${JSON.stringify(effectBundleImportPath())};`,
    imports,
    options.setupImports ?? "",
    AST_TO_JSON_SCHEMA_RUNTIME_IMPORT,
    TOOL_SURFACE_RUNTIME_TYPES,
    renderSchemaBridgeRuntime(`${options.runtimeAgent}-schema-bridge`),
    renderPiExtensionRuntime(
      entries,
      options.setupSource,
      options.runtimeAgent,
      options.harnessLabel,
    ),
  ]);
};

const writeTempBundleSources = async (options: {
  readonly tempRoot: string;
  readonly mirrors: ReadonlyArray<PluginMirror>;
  readonly importPluginRoots: ReadonlyMap<string, string>;
  readonly entrySource: string;
  readonly entryFileName?: string;
}): Promise<string> => {
  const astToJsonSchemaSource = getAstToJsonSchemaSource().replace(
    /from "effect";/,
    `from ${JSON.stringify(effectBundleImportPath())};`,
  );
  await writeFile(join(options.tempRoot, "ast-to-json-schema.ts"), astToJsonSchemaSource);
  for (const mirror of options.mirrors) {
    for (const file of mirror.files) {
      const target = join(options.tempRoot, "plugins", mirror.pluginName, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      const raw = file.content ?? (await readFile(file.sourcePath!, "utf8"));
      const normalized = await normalizeMirroredPluginSource({
        pluginName: mirror.pluginName,
        pluginRoot: mirror.pluginRoot,
        relativePath: file.relativePath,
        sourcePath: file.sourcePath,
        source: raw,
        importPluginRoots: options.importPluginRoots,
      });
      await writeFile(target, normalized);
    }
  }

  const entryPath = join(options.tempRoot, options.entryFileName ?? "server-entry.ts");
  await writeFile(entryPath, options.entrySource);
  return entryPath;
};
const validateBuiltAmpPluginBundle = async (builtPath: string): Promise<void> => {
  const moduleUrl = `${pathToFileURL(builtPath).href}?prism=${Date.now()}`;
  const loaded = await import(moduleUrl) as { readonly default?: unknown };
  if (typeof loaded.default !== "function") {
    throw new Error("built Amp plugin bundle does not export a default plugin function");
  }
};

const validateBuiltPiExtensionBundle = async (builtPath: string): Promise<void> => {
  const moduleUrl = `${pathToFileURL(builtPath).href}?prism=${Date.now()}`;
  const loaded = await import(moduleUrl) as { readonly default?: unknown };
  if (typeof loaded.default !== "function") {
    throw new Error("built Pi extension bundle does not export a default extension function");
  }
};

const normalizeBuiltAmpPluginBundle = stripBundlerPathComments;

const normalizeBuiltPiExtensionBundle = stripBundlerPathComments;

/** Sorted, deduped tool names (generated identity) for a binding set. */
export const cliToolNamesForBindings = (
  bindings: ReadonlyArray<ResolvedContractBinding>,
): string[] => adapterSpecsForBindings(bindings).map((spec) => spec.name);

export interface ToolCliRuntimeBundleOptions {
  readonly sourcePluginName: string;
  readonly sourcePluginRoot?: string;
  readonly dependencyPluginRoots?: ReadonlyMap<string, string> | ReadonlyArray<readonly [string, string]>;
  readonly version?: string;
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
}

export interface ToolCliRuntimeBundle {
  readonly content: string;
  readonly toolNames: ReadonlyArray<string>;
}

const CLI_TOOL_RUNTIME = `const decodeWithSchema = (schema, raw) => Schema.decodeUnknownSync(schema)(raw);

const runtimeContext = (callContext = {}) => ({
  sessionID: callContext.sessionID ?? "prism-tools-cli",
  agent: callContext.agent ?? "prism-tools-cli",
  timestamp: new Date().toISOString(),
  workingDirectory: callContext.workingDirectory ?? process.cwd(),
  repoRoot: callContext.repoRoot ?? callContext.workingDirectory ?? process.cwd(),
  ...(callContext.signal ? { signal: callContext.signal } : {}),
});

const createCliTool = (name, surface) => {
  const inputSchema = surface.Input ?? surface.input;
  const outputSchema = surface.Output ?? surface.output;
  if (!inputSchema) throw new Error("CLI tool '" + name + "' is missing an Input/input schema");
  if (!outputSchema) throw new Error("CLI tool '" + name + "' is missing an Output/output schema");
  return {
    description: surface.description ?? "",
    async run(rawArgs, callContext) {
      const input = decodeWithSchema(inputSchema, rawArgs ?? {});
      const output = await surface.handle(input, runtimeContext(callContext));
      return decodeWithSchema(outputSchema, output);
    },
  };
};

const tools = {
__PRISM_TOOL_ENTRIES__
};

export const toolNames = Object.keys(tools);

export const invokeTool = async (name, rawArgs = {}, callContext = {}) => {
  const tool = tools[name];
  if (!tool) {
    const available = toolNames.join(", ");
    throw new Error(
      "unknown tool '" + name + "'" +
        (available.length > 0 ? "; available: " + available : " (empty runtime)"),
    );
  }
  return tool.run(rawArgs, callContext);
};
`;

const renderToolCliRuntimeEntry = (options: {
  readonly sourcePluginName: string;
  readonly version: string;
  readonly specs: ReadonlyArray<ToolAdapterSpec>;
}): string => {
  const { imports, entries } = renderToolSurfaceBindings(
    options.specs,
    (spec, ident) =>
      `  ${JSON.stringify(spec.logicalName)}: createCliTool(${JSON.stringify(spec.logicalName)}, ${ident}),`,
  );
  return joinGeneratedSections([
    `// GENERATED by prism — do not edit.
// Stateless CLI tool runtime for ${options.sourcePluginName} v${options.version}.
// Loaded in-process by \`prism tools invoke\` (one-shot).`,
    `import { Schema } from ${JSON.stringify(effectBundleImportPath())};`,
    imports,
    replaceTemplateTokens(CLI_TOOL_RUNTIME, {
      __PRISM_TOOL_ENTRIES__: entries,
    }),
  ]);
};

const validateBuiltToolCliRuntimeBundle = async (builtPath: string): Promise<void> => {
  const moduleUrl = `${pathToFileURL(builtPath).href}?prism=${Date.now()}`;
  const loaded = await import(moduleUrl) as {
    readonly invokeTool?: unknown;
    readonly toolNames?: unknown;
  };
  if (typeof loaded.invokeTool !== "function") {
    throw new Error("built CLI tool runtime does not export invokeTool");
  }
  if (!Array.isArray(loaded.toolNames)) {
    throw new Error("built CLI tool runtime does not export toolNames array");
  }
};

/**
 * Bundle canonical tool handles for one-shot in-process CLI invoke.
 * Writes no servers, sockets, or protocol glue.
 */
export const generateToolCliRuntimeBundle = async (
  options: ToolCliRuntimeBundleOptions,
): Promise<ToolCliRuntimeBundle> => {
  const version = options.version ?? "0.1.0";
  const specs = adapterSpecsForBindings(options.bindings);
  const toolNames = specs.map((spec) => spec.logicalName);
  const mirrors = await collectMirrorsForBindings(
    options.bindings,
    options.dependencyPluginRoots,
  );
  const importPluginRoots = new Map<string, string>();
  for (const mirror of mirrors) {
    if (mirror.pluginRoot) importPluginRoots.set(mirror.pluginName, mirror.pluginRoot);
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "prism-tool-cli-runtime-"));
  try {
    const entrySource = renderToolCliRuntimeEntry({
      sourcePluginName: options.sourcePluginName,
      version,
      specs,
    });
    const entryPath = await writeTempBundleSources({
      tempRoot,
      mirrors,
      importPluginRoots,
      entrySource,
    });
    const outdir = join(tempRoot, "dist");
    const build = await Bun.build({
      entrypoints: [entryPath],
      outdir,
      target: "bun",
      format: "esm",
      packages: "bundle",
      external: NODE_BUILTIN_EXTERNALS,
      naming: "runtime.mjs",
      sourcemap: "none",
      minify: false,
    });

    if (!build.success) {
      const diagnostics = build.logs.map((log) => log.message).join("\n");
      throw new BundleBuildError({ bundleKind: "CLI tool runtime", diagnostics });
    }

    const builtPath = join(outdir, "runtime.mjs");
    await validateBuiltToolCliRuntimeBundle(builtPath);
    return {
      content: stripBundlerPathComments(await readFile(builtPath, "utf8")),
      toolNames,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};
export const generateAmpPluginBundle = async (
  options: AmpPluginBundleOptions,
): Promise<AmpPluginBundle> => {
  const version = options.version ?? "0.1.0";
  const specs = adapterSpecsForBindings(options.bindings);
  const toolNames = specs.map((spec) => spec.name);
  const mirrors = await collectMirrorsForBindings(
    options.bindings,
    options.dependencyPluginRoots,
  );
  const importPluginRoots = new Map<string, string>();
  for (const mirror of mirrors) {
    if (mirror.pluginRoot) importPluginRoots.set(mirror.pluginName, mirror.pluginRoot);
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "prism-amp-plugin-"));
  try {
    const entrySource = renderAmpPluginEntry({
      sourcePluginName: options.sourcePluginName,
      version,
      specs,
      setupImports: options.setupImports,
      setupSource: options.setupSource,
    });
    const entryPath = await writeTempBundleSources({
      tempRoot,
      mirrors,
      importPluginRoots,
      entrySource,
    });
    const outdir = join(tempRoot, "dist");
    const build = await Bun.build({
      entrypoints: [entryPath],
      outdir,
      target: "node",
      format: "esm",
      packages: "bundle",
      external: NODE_BUILTIN_EXTERNALS,
      naming: "plugin.mjs",
      sourcemap: "none",
      minify: false,
    });

    if (!build.success) {
      const diagnostics = build.logs.map((log) => log.message).join("\n");
      throw new BundleBuildError({ bundleKind: "Amp plugin", diagnostics });
    }

    const builtPath = join(outdir, "plugin.mjs");
    await validateBuiltAmpPluginBundle(builtPath);
    return {
      content: normalizeBuiltAmpPluginBundle(await readFile(builtPath, "utf8")),
      toolNames,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

export const generatePiExtensionBundle = async (
  options: PiExtensionBundleOptions,
): Promise<PiExtensionBundle> => {
  const version = options.version ?? "0.1.0";
  const specs = adapterSpecsForBindings(options.bindings);
  const toolNames = specs.map((spec) => spec.name);
  const mirrors = await collectMirrorsForBindings(
    options.bindings,
    options.dependencyPluginRoots,
  );
  const importPluginRoots = new Map<string, string>();
  for (const mirror of mirrors) {
    if (mirror.pluginRoot) importPluginRoots.set(mirror.pluginName, mirror.pluginRoot);
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "prism-pi-extension-"));
  try {
    const entrySource = renderPiExtensionEntry({
      sourcePluginName: options.sourcePluginName,
      version,
      specs,
      setupImports: options.setupImports,
      setupSource: options.setupSource,
      runtimeAgent: options.runtimeAgent ?? "pi",
      harnessLabel: options.harnessLabel ?? "Pi",
    });
    const entryPath = await writeTempBundleSources({
      tempRoot,
      mirrors,
      importPluginRoots,
      entrySource,
    });
    const outdir = join(tempRoot, "dist");
    const build = await Bun.build({
      entrypoints: [entryPath],
      outdir,
      target: "bun",
      format: "esm",
      packages: "bundle",
      external: NODE_BUILTIN_EXTERNALS,
      naming: "extension.js",
      sourcemap: "none",
      minify: false,
    });

    if (!build.success) {
      const diagnostics = build.logs.map((log) => log.message).join("\n");
      throw new BundleBuildError({ bundleKind: "Pi extension", diagnostics });
    }

    const builtPath = join(outdir, "extension.js");
    await validateBuiltPiExtensionBundle(builtPath);
    return {
      content: normalizeBuiltPiExtensionBundle(await readFile(builtPath, "utf8")),
      toolNames,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};
