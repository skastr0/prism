import { stripBundlerPathComments } from "./bundle-normalize.js";
import { getAstToJsonSchemaSource } from "./embedded-runtime-sources.js";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BundleBuildError } from "../errors.js";
import type { Contract } from "./sources.js";
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

type McpAdapterSpec =
  | {
      readonly kind: "tool";
      readonly mcpName: string;
      readonly logicalName: string;
      readonly pluginName: string;
      readonly toolName: string;
      readonly sourcePath: string;
    }
  | {
      readonly kind: "synthetic";
      readonly mcpName: string;
      readonly logicalName: string;
      readonly pluginName: string;
      readonly contractName: string;
      readonly contractRelativePath: string;
    };

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
export const cliToolNameForBinding = (
  sourcePluginName: string,
  binding: ResolvedContractBinding,
): string => generatedToolNameForBinding(sourcePluginName, binding);

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

const pluginRootFromContractSource = (contractSourcePath: string): string => {
  const [sourcePath] = contractSourcePath.split("#");
  if (!sourcePath) {
    throw new Error(`contract source path '${contractSourcePath}' cannot be mapped to a plugin root`);
  }
  return dirname(dirname(sourcePath));
};

interface PluginMirrorCollectionState {
  readonly byPlugin: Map<
    string,
    { pluginRoot: string; entries: Map<string, MirrorFile> }
  >;
  readonly generatedFiles: Map<string, Map<string, string>>;
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
  return { byPlugin, generatedFiles: new Map() };
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

const addGeneratedContractFiles = (
  state: PluginMirrorCollectionState,
  contract: Contract,
): void => {
  if (!contract.generatedFiles || contract.generatedFiles.length === 0) return;
  const files = state.generatedFiles.get(contract.pluginName) ?? new Map<string, string>();
  for (const file of contract.generatedFiles) {
    const existing = files.get(file.relativePath);
    if (existing && existing !== file.content) {
      throw new Error(
        `generated contract name collision at ${contract.pluginName}:${file.relativePath}`,
      );
    }
    files.set(file.relativePath, file.content);
  }
  state.generatedFiles.set(contract.pluginName, files);
};

const contractPluginRootForBinding = (
  contract: Contract,
  sourcePluginName?: string,
  sourcePluginRoot?: string,
): string =>
  contract.pluginName === sourcePluginName && sourcePluginRoot
    ? sourcePluginRoot
    : pluginRootFromContractSource(contract.sourcePath);

const registerBindingMirrorInputs = (
  state: PluginMirrorCollectionState,
  binding: ResolvedContractBinding,
  sourcePluginName?: string,
  sourcePluginRoot?: string,
): void => {
  const toolRoot = pluginRootFromToolSource(binding.toolSourcePath);
  getOrCreateMirrorPluginEntries(state, binding.toolPluginName, toolRoot).set(
    `tools/${binding.toolName}.tool.ts`,
    {
      relativePath: `tools/${binding.toolName}.tool.ts`,
      sourcePath: binding.toolSourcePath,
    },
  );

  if (binding.kind !== "synthetic") return;
  if (!binding.contract) {
    throw new Error(`synthetic tool binding '${binding.logicalName}' is missing a contract`);
  }

  // Prefer the host plugin's root when the contract is attributed to it.
  // contract.sourcePath traces back to the trait file's location, which
  // may live in a *different* plugin from the contract's owning plugin
  // (e.g. cross-plugin trait + slot binding). Falling back to deriving
  // from contract.sourcePath would map the host plugin to the trait
  // plugin's root, which is wrong.
  getOrCreateMirrorPluginEntries(
    state,
    binding.contract.pluginName,
    contractPluginRootForBinding(binding.contract, sourcePluginName, sourcePluginRoot),
  );
  addGeneratedContractFiles(state, binding.contract);
};

const registerBindingsMirrorInputs = (
  state: PluginMirrorCollectionState,
  bindings: ReadonlyArray<ResolvedContractBinding>,
  sourcePluginName?: string,
  sourcePluginRoot?: string,
): void => {
  for (const binding of bindings) {
    registerBindingMirrorInputs(state, binding, sourcePluginName, sourcePluginRoot);
  }
};

const applyGeneratedFilesToMirrorEntries = (
  state: PluginMirrorCollectionState,
): void => {
  for (const [pluginName, generated] of state.generatedFiles) {
    const plugin = state.byPlugin.get(pluginName);
    if (!plugin) continue;
    for (const [relativePath, content] of generated) {
      plugin.entries.set(relativePath, { relativePath, content });
    }
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

  for (const [pluginName, files] of state.generatedFiles) {
    if (mirrors.some((mirror) => mirror.pluginName === pluginName)) continue;
    mirrors.push({
      pluginName,
      files: [...files.entries()].map(([relativePath, content]) => ({ relativePath, content })),
    });
  }

  return mirrors.sort((left, right) => left.pluginName.localeCompare(right.pluginName));
};

const collectMirrorsForBindings = async (
  bindings: ReadonlyArray<ResolvedContractBinding>,
  sourcePluginName?: string,
  sourcePluginRoot?: string,
  dependencyPluginRoots: ReadonlyMap<string, string> | ReadonlyArray<readonly [string, string]> = [],
): Promise<PluginMirror[]> => {
  const state = createPluginMirrorCollectionState(dependencyPluginRoots);
  registerBindingsMirrorInputs(state, bindings, sourcePluginName, sourcePluginRoot);
  applyGeneratedFilesToMirrorEntries(state);
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
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): McpAdapterSpec[] => {
  const byName = new Map<string, McpAdapterSpec>();
  const specs: McpAdapterSpec[] = [];
  for (const binding of bindings) {
    const mcpName = cliToolNameForBinding(sourcePluginName, binding);
    const spec: McpAdapterSpec =
      binding.kind === "permission"
        ? {
            kind: "tool",
            mcpName,
            logicalName: binding.logicalName,
            pluginName: binding.toolPluginName,
            toolName: binding.toolName,
            sourcePath: binding.toolSourcePath,
          }
        : {
            kind: "synthetic",
            mcpName,
            logicalName: binding.logicalName,
            pluginName: binding.contract!.pluginName,
            contractName: binding.contract!.name,
            contractRelativePath: `contracts/${binding.contract!.name}.contract`,
          };

    const existing = byName.get(mcpName);
    if (existing) {
      if (mcpAdapterSpecsEqual(existing, spec)) continue;
      throw new Error(
        `MCP tool name collision for '${mcpName}': ${describeMcpAdapterSpec(existing)} conflicts with ${describeMcpAdapterSpec(spec)}`,
      );
    }
    byName.set(mcpName, spec);
    specs.push(spec);
  }
  return specs.sort((left, right) => left.mcpName.localeCompare(right.mcpName));
};

const mcpAdapterSpecsEqual = (left: McpAdapterSpec, right: McpAdapterSpec): boolean => {
  if (left.kind !== right.kind || left.mcpName !== right.mcpName) return false;
  if (left.kind === "tool" && right.kind === "tool") {
    return (
      left.pluginName === right.pluginName &&
      left.toolName === right.toolName &&
      left.sourcePath === right.sourcePath
    );
  }
  if (left.kind === "synthetic" && right.kind === "synthetic") {
    return (
      left.pluginName === right.pluginName &&
      left.contractName === right.contractName &&
      left.contractRelativePath === right.contractRelativePath
    );
  }
  return false;
};

const describeMcpAdapterSpec = (spec: McpAdapterSpec): string => {
  if (spec.kind === "tool") {
    return `logical '${spec.logicalName}' -> tool ${spec.pluginName}:${spec.toolName}`;
  }
  return `logical '${spec.logicalName}' -> synthetic contract ${spec.pluginName}:${spec.contractName}`;
};

const safeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_$]/g, "_").replace(/^[^a-zA-Z_$]/, "_$&");

const SCHEMA_ANNOTATION_HELPERS = `const extractStringAnnotation = (
  ast: SchemaAST.AST,
  annotationId: symbol,
): string | undefined => {
  const annotation = SchemaAST.getAnnotation<string>(annotationId)(ast);
  return annotation._tag === "Some" ? annotation.value : undefined;
};

const extractDescriptionOrTitle = (ast: SchemaAST.AST): string | undefined =>
  extractStringAnnotation(ast, SchemaAST.DescriptionAnnotationId) ??
  extractStringAnnotation(ast, SchemaAST.TitleAnnotationId);`;

const TOOL_SURFACE_RUNTIME_TYPES = `type JsonSchema = Record<string, any>;
type ZodSchema = z.ZodType<any, any>;
type ToolSurface = {
  description?: string;
  input?: Schema.Schema.AnyNoContext;
  output?: Schema.Schema.AnyNoContext;
  Input?: Schema.Schema.AnyNoContext;
  Output?: Schema.Schema.AnyNoContext;
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

const inputJsonSchemaFromEffectSchema = (schema: Schema.Schema.AnyNoContext): JsonSchema => {
  if (schema.ast._tag !== "TypeLiteral") {
    unsupportedAst(schema.ast, "top-level Input must be a Schema.Struct");
  }
  return astToJsonSchema(schema.ast);
};

const literalToZod = (literal: string | number | boolean | null): ZodSchema => {
  // Use z.enum for string literals so the emitted JSON Schema uses "enum"
  // instead of "const". Some MCP clients (including Kimi) reject "const"
  // with "must be equal to constant". enum is draft-07 compatible and
  // universally supported.
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
  switch (ast._tag) {
    case "StringKeyword":
      return z.string();
    case "NumberKeyword":
      return z.number();
    case "BooleanKeyword":
      return z.boolean();
    case "UnknownKeyword":
      return z.any();
    case "UndefinedKeyword":
      return z.undefined();
    case "Literal":
      return literalToZod(ast.literal as string | number | boolean | null);
    case "Union": {
      const nonUndefined = ast.types.filter((type) => type._tag !== "UndefinedKeyword");
      return unionToZod(nonUndefined.map(astToZodSchema));
    }
    case "TupleType": {
      if (ast.elements.length === 0 && ast.rest.length === 1) {
        return z.array(astToZodSchema(ast.rest[0]!.type));
      }
      unsupportedAst(ast, "tuple elements=" + ast.elements.length + ", rest=" + ast.rest.length);
    }
    case "TypeLiteral": {
      // Pure Schema.Record → open string-keyed map (JSON Schema additionalProperties).
      if (ast.propertySignatures.length === 0 && ast.indexSignatures.length > 0) {
        const index = ast.indexSignatures[0]!;
        if (index.type._tag === "UnknownKeyword" || index.type._tag === "AnyKeyword") {
          return z.record(z.string(), z.unknown());
        }
        return z.record(z.string(), astToZodSchema(index.type));
      }
      const properties: Record<string, ZodSchema> = {};
      for (const prop of ast.propertySignatures) {
        const description = extractDescriptionOrTitle(prop.type);
        let property = astToZodSchema(prop.type);
        if (description) property = property.describe(description);
        properties[String(prop.name)] = prop.isOptional ? property.optional() : property;
      }
      let objectSchema = z.object(properties);
      if (ast.indexSignatures.length > 0) {
        const index = ast.indexSignatures[0]!;
        const value =
          index.type._tag === "UnknownKeyword" || index.type._tag === "AnyKeyword"
            ? z.unknown()
            : astToZodSchema(index.type);
        objectSchema = objectSchema.catchall(value);
      }
      return objectSchema;
    }
    case "Refinement":
      return astToZodSchema(ast.from);
    case "Transformation":
      return astToZodSchema(ast.from);
    case "Suspend":
      return astToZodSchema(ast.f());
    default:
      unsupportedAst(ast);
  }
};

const unwrapObjectAst = (ast: SchemaAST.AST): SchemaAST.AST => {
  switch (ast._tag) {
    case "Refinement":
      return unwrapObjectAst(ast.from);
    case "Transformation":
      return unwrapObjectAst(ast.from);
    case "Suspend":
      return unwrapObjectAst(ast.f());
    default:
      return ast;
  }
};

const objectZodFromEffectSchema = (
  schema: Schema.Schema.AnyNoContext,
  topLevelName: "Input/input" | "Output/output",
): ZodSchema => {
  const ast = unwrapObjectAst(schema.ast);
  if (ast._tag !== "TypeLiteral") {
    unsupportedAst(ast, "top-level " + topLevelName + " must be a Schema.Struct");
  }
  return astToZodSchema(ast);
};

const decodeWithSchema = <A>(schema: Schema.Schema<A, unknown, never>, raw: unknown): A =>
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
        const input = decodeWithSchema(inputSchema as Schema.Schema<unknown, unknown, never>, rawArgs ?? {});
        const output = await surface.handle(input, runtimeContext());
        const validatedOutput = decodeWithSchema(outputSchema as Schema.Schema<unknown, unknown, never>, output);
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
      const input = decodeWithSchema(inputSchema as Schema.Schema<unknown, unknown, never>, rawArgs ?? {});
      const output = await surface.handle(input, runtimeContext(ctx, signal));
      const validatedOutput = decodeWithSchema(outputSchema as Schema.Schema<unknown, unknown, never>, output);
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

const renderToolSurfaceImport = (ident: string, spec: McpAdapterSpec): string => {
  if (spec.kind === "tool") {
    return `import ${ident} from ${JSON.stringify(`./plugins/${spec.pluginName}/tools/${spec.toolName}.tool`)};`;
  }
  return `import * as ${ident} from ${JSON.stringify(`./plugins/${spec.pluginName}/${spec.contractRelativePath}`)};`;
};

const renderToolSurfaceBindings = (
  specs: ReadonlyArray<McpAdapterSpec>,
  renderEntry: (spec: McpAdapterSpec, ident: string) => string,
): RenderedToolSurfaceBindings => {
  const imports: string[] = [];
  const entries: string[] = [];
  for (const [index, spec] of specs.entries()) {
    const ident = `surface_${index}_${safeIdentifier(spec.mcpName)}`;
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
  readonly specs: ReadonlyArray<McpAdapterSpec>;
  readonly setupImports?: string;
  readonly setupSource?: string;
}): string => {
  const { imports, entries } = renderToolSurfaceBindings(
    options.specs,
    (spec, ident) =>
      `  createToolDefinition(${JSON.stringify(spec.mcpName)}, ${ident} as ToolSurface),`,
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
  readonly specs: ReadonlyArray<McpAdapterSpec>;
  readonly setupImports?: string;
  readonly setupSource?: string;
  readonly runtimeAgent: string;
  readonly harnessLabel: string;
}): string => {
  const { imports, entries } = renderToolSurfaceBindings(
    options.specs,
    (spec, ident) =>
      `  createToolDefinition(${JSON.stringify(spec.mcpName)}, ${ident} as ToolSurface),`,
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

/**
 * Sorted, deduped generated tool names for a binding set.
 */
export const mcpToolNamesForBindings = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): string[] =>
  adapterSpecsForBindings(sourcePluginName, bindings).map((spec) => spec.mcpName);

/** CLI-facing tool names (logical); one row per tool, no protocol wire prefixes. */
export const cliToolNamesForBindings = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): string[] =>
  adapterSpecsForBindings(sourcePluginName, bindings).map((spec) => spec.logicalName);

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
  readonly specs: ReadonlyArray<McpAdapterSpec>;
}): string => {
  const { imports, entries } = renderToolSurfaceBindings(
    options.specs,
    (spec, ident) =>
      `  ${JSON.stringify(spec.logicalName)}: createCliTool(${JSON.stringify(spec.logicalName)}, ${ident}),`,
  );
  return joinGeneratedSections([
    `// GENERATED by prism — do not edit.
// Stateless CLI tool runtime for ${options.sourcePluginName} v${options.version}.
// Loaded in-process by \`prism tools invoke\` — no daemon, no MCP.`,
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
  const specs = adapterSpecsForBindings(options.sourcePluginName, options.bindings);
  const toolNames = specs.map((spec) => spec.logicalName);
  const mirrors = await collectMirrorsForBindings(
    options.bindings,
    options.sourcePluginName,
    options.sourcePluginRoot,
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
  const specs = adapterSpecsForBindings(options.sourcePluginName, options.bindings);
  const toolNames = specs.map((spec) => spec.mcpName);
  const mirrors = await collectMirrorsForBindings(
    options.bindings,
    options.sourcePluginName,
    options.sourcePluginRoot,
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
  const specs = adapterSpecsForBindings(options.sourcePluginName, options.bindings);
  const toolNames = specs.map((spec) => spec.mcpName);
  const mirrors = await collectMirrorsForBindings(
    options.bindings,
    options.sourcePluginName,
    options.sourcePluginRoot,
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
