import { stripBundlerPathComments } from "./bundle-normalize.js";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BundleBuildError } from "../errors.js";
import { computeContentHash } from "../content-hash.js";
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
  mcpSdkMcpBundleImportPath,
  mcpSdkStdioBundleImportPath,
  mcpSdkWebStandardHttpBundleImportPath,
  zodV4BundleImportPath,
} from "./runtime-deps.js";
import {
  generatedToolNameForBinding,
  normalizeGeneratedPluginName,
  sanitizeGeneratedToolSegment,
  sourceIsInside,
} from "./generated-plugin.js";
import { DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS } from "./mcp-policy.js";

const execFileAsync = promisify(execFile);

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

export interface McpServerBundleOptions {
  readonly sourcePluginName: string;
  readonly sourcePluginRoot?: string;
  readonly dependencyPluginRoots?: ReadonlyMap<string, string> | ReadonlyArray<readonly [string, string]>;
  readonly serverName: string;
  readonly version?: string;
  readonly bundleId?: string;
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
  readonly exposureProfiles?: ReadonlyArray<McpServerExposureProfile>;
}

export interface McpServerExposureProfile {
  readonly name: string;
  readonly toolNames: ReadonlyArray<string>;
}

export interface McpServerBundle {
  /** Stable path future harness lowerers can place inside their compiled artifact. */
  readonly relativePath: string;
  readonly content: string;
  readonly stdioRelativePath: string;
  readonly stdioContent: string;
  readonly toolNames: ReadonlyArray<string>;
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
}

export interface PiExtensionBundle {
  readonly content: string;
  readonly toolNames: ReadonlyArray<string>;
}

const normalizeRelativePath = (path: string): string => path.replace(/\\/g, "/");

export const mcpToolNameForBinding = (
  sourcePluginName: string,
  binding: ResolvedContractBinding,
): string => generatedToolNameForBinding(sourcePluginName, binding);

export const ampPluginToolNameForBinding = mcpToolNameForBinding;

export const mcpServerArtifactRelativePath = (bundleId: string): string =>
  `mcp/${sanitizeGeneratedToolSegment(bundleId, "tools")}/server.mjs`;

export const mcpServerStdioArtifactRelativePath = (bundleId: string): string =>
  `mcp/${sanitizeGeneratedToolSegment(bundleId, "tools")}/entry-stdio.mjs`;

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
    const mcpName = mcpToolNameForBinding(sourcePluginName, binding);
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

const astToJsonSchema = (ast: SchemaAST.AST): JsonSchema => {
  switch (ast._tag) {
    case "StringKeyword":
      return { type: "string" };
    case "NumberKeyword":
      return { type: "number" };
    case "BooleanKeyword":
      return { type: "boolean" };
    case "UnknownKeyword":
      return { type: "object", additionalProperties: true };
    case "Literal":
      // Emit enum with a single value instead of const. Some MCP clients
      // (including Kimi) do not accept JSON Schema "const" and report
      // "must be equal to constant". enum: [value] is draft-07 compatible
      // and universally supported.
      return { enum: [ast.literal] };
    case "Union": {
      const allLiterals = ast.types.every((type) => type._tag === "Literal");
      if (allLiterals) {
        return { enum: ast.types.map((type) => (type as SchemaAST.Literal).literal) };
      }
      const nonUndefined = ast.types.filter((type) => type._tag !== "UndefinedKeyword");
      if (nonUndefined.length === 1) return astToJsonSchema(nonUndefined[0]!);
      unsupportedAst(ast, "union members: " + ast.types.map((type) => type._tag).join(" | "));
    }
    case "TupleType": {
      if (ast.elements.length === 0 && ast.rest.length === 1) {
        return { type: "array", items: astToJsonSchema(ast.rest[0]!.type) };
      }
      unsupportedAst(ast, "tuple elements=" + ast.elements.length + ", rest=" + ast.rest.length);
    }
    case "TypeLiteral": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const prop of ast.propertySignatures) {
        const property = astToJsonSchema(prop.type);
        const description = extractDescriptionOrTitle(prop.type);
        if (description) property.description = description;
        const name = String(prop.name);
        properties[name] = property;
        if (!prop.isOptional) required.push(name);
      }
      return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      };
    }
    case "Refinement":
      return astToJsonSchema(ast.from);
    case "Transformation":
      return astToJsonSchema(ast.from);
    case "Suspend":
      return astToJsonSchema(ast.f());
    default:
      unsupportedAst(ast);
  }
};

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
      const properties: Record<string, ZodSchema> = {};
      for (const prop of ast.propertySignatures) {
        const description = extractDescriptionOrTitle(prop.type);
        let property = astToZodSchema(prop.type);
        if (description) property = property.describe(description);
        properties[String(prop.name)] = prop.isOptional ? property.optional() : property;
      }
      return z.object(properties);
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

const MCP_TOOL_FACTORY_RUNTIME = `const resolveWorkingDirectory = (): string => {
  const configured = process.env.PRISM_MCP_WORKING_DIRECTORY;
  if (configured && configured !== process.cwd()) {
    try {
      process.chdir(configured);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(\`prism MCP: failed to change working directory to '\${configured}': \${message}\`);
    }
  }
  return process.cwd();
};

const prismWorkingDirectory = resolveWorkingDirectory();
const prismRepoRoot = process.env.PRISM_MCP_REPO_ROOT ?? prismWorkingDirectory;
const configuredToolTimeoutMs = Number(process.env.PRISM_MCP_TOOL_TIMEOUT_MS ?? "__PRISM_TOOL_TIMEOUT_MS__");
const prismToolTimeoutMs = Number.isFinite(configuredToolTimeoutMs) && configuredToolTimeoutMs > 0
  ? configuredToolTimeoutMs
  : __PRISM_TOOL_TIMEOUT_MS__;
// Fingerprint of the runtime templates this bundle was generated from (never
// per-harness identity, never env-supplied): baked in at build time so a
// bundle's provenance is checkable without trusting daemon-supplied state.
const PRISM_MCP_SERVER_SOURCE_SHA = "__PRISM_SERVER_SOURCE_SHA256__";

const abortError = (name: string, reason?: unknown): Error => {
  if (reason instanceof Error) return reason;
  return new Error(\`MCP tool '\${name}' was aborted\`);
};

const linkAbortSignal = (
  controller: AbortController,
  signal: AbortSignal | undefined,
  name: string,
): (() => void) => {
  if (!signal) return () => {};
  const abort = () => controller.abort(abortError(name, signal.reason));
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
};

const withToolTimeout = async <A>(
  name: string,
  operation: (signal: AbortSignal) => Promise<A>,
  parentSignal?: AbortSignal,
): Promise<A> => {
  const controller = new AbortController();
  const unlinkAbortSignal = linkAbortSignal(controller, parentSignal, name);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (controller.signal.aborted) throw abortError(name, controller.signal.reason);
    return await Promise.race([
      operation(controller.signal),
      new Promise<A>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(\`MCP tool '\${name}' timed out after \${prismToolTimeoutMs}ms\`);
          controller.abort(error);
          reject(error);
        }, prismToolTimeoutMs);
        controller.signal.addEventListener("abort", () => reject(abortError(name, controller.signal.reason)), {
          once: true,
        });
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    unlinkAbortSignal();
  }
};

interface ToolCallRuntimeContext {
  sessionID?: string;
  agent?: string;
  signal?: AbortSignal;
}

const runtimeContext = (callContext: ToolCallRuntimeContext = {}): ToolRuntimeContext => ({
  sessionID: callContext.sessionID ?? process.env.PRISM_MCP_SESSION_ID ?? "mcp-http",
  agent: callContext.agent ?? process.env.PRISM_MCP_AGENT ?? "mcp-client",
  timestamp: new Date().toISOString(),
  workingDirectory: prismWorkingDirectory,
  repoRoot: prismRepoRoot,
  ...(callContext.signal ? { signal: callContext.signal } : {}),
});

const createTool = (name: string, surface: ToolSurface) => {
  const inputSchema = surface.Input ?? surface.input;
  const outputSchema = surface.Output ?? surface.output;
  if (!inputSchema) throw new Error(\`MCP tool '\${name}' is missing an Input/input schema\`);
  if (!outputSchema) throw new Error(\`MCP tool '\${name}' is missing an Output/output schema\`);
  let inputZodSchema: ZodSchema;
  let outputZodSchema: ZodSchema;
  try {
    inputJsonSchemaFromEffectSchema(inputSchema);
    inputZodSchema = objectZodFromEffectSchema(inputSchema, "Input/input");
  } catch (error) {
    throw new Error(\`MCP tool '\${name}' has unsupported Input/input schema: \${errorMessage(error)}\`);
  }
  try {
    outputZodSchema = objectZodFromEffectSchema(outputSchema, "Output/output");
  } catch (error) {
    throw new Error(\`MCP tool '\${name}' has unsupported Output/output schema: \${errorMessage(error)}\`);
  }

  const runTool = async (
    rawArgs: unknown,
    callContext?: ToolCallRuntimeContext,
  ): Promise<{ readonly text: string; readonly structuredContent: unknown }> => {
    const input = decodeWithSchema(inputSchema as Schema.Schema<unknown, unknown, never>, rawArgs ?? {});
    const output = await surface.handle(input, runtimeContext(callContext));
    const validatedOutput = decodeWithSchema(outputSchema as Schema.Schema<unknown, unknown, never>, output);
    return {
      text: JSON.stringify(validatedOutput, null, 2),
      structuredContent: validatedOutput,
    };
  };

  return {
    description: surface.description ?? "",
    inputSchema: inputZodSchema,
    outputSchema: outputZodSchema,
    run: runTool,
    async call(rawArgs: unknown, callContext?: ToolCallRuntimeContext) {
      return await withToolTimeout(name, (signal) => runTool(rawArgs, { ...callContext, signal }), callContext?.signal);
    },
  };
};`;

const MCP_SDK_SERVER_FACTORY_RUNTIME = `const tools = {
__PRISM_TOOL_ENTRIES__
};

const prismMcpValidateOnly = process.env.PRISM_MCP_VALIDATE === "1";

const exposureProfiles: Record<string, readonly string[]> = __PRISM_EXPOSURE_PROFILES__;
const exposureHeaderName = "x-prism-mcp-exposure";

const toolNameSet = (names: readonly string[]): Set<string> =>
  new Set(names.map((name) => name.trim()).filter((name) => name.length > 0));

const configuredMaxConcurrentToolCalls = Number(process.env.PRISM_MCP_MAX_CONCURRENT_CALLS ?? "16");
const maxConcurrentToolCalls = Number.isFinite(configuredMaxConcurrentToolCalls) && configuredMaxConcurrentToolCalls > 0
  ? configuredMaxConcurrentToolCalls
  : 16;
let activeToolCalls = 0;

const withToolConcurrency = async <A>(
  name: string,
  operation: (signal: AbortSignal) => Promise<A>,
  parentSignal?: AbortSignal,
): Promise<A> => {
  if (activeToolCalls >= maxConcurrentToolCalls) {
    throw new Error(\`MCP tool '\${name}' rejected because \${activeToolCalls} tool call(s) are already running\`);
  }
  activeToolCalls += 1;
  try {
    return await withToolTimeout(name, operation, parentSignal);
  } finally {
    activeToolCalls -= 1;
  }
};

const registeredToolCount = (enabledToolNames?: ReadonlySet<string>): number => {
  let count = 0;
  for (const name of Object.keys(tools)) {
    if (enabledToolNames !== undefined && !enabledToolNames.has(name)) continue;
    count += 1;
  }
  return count;
};

const registerPrismTools = (server: McpServer, enabledToolNames?: ReadonlySet<string>): void => {
  for (const [name, tool] of Object.entries(tools)) {
    if (enabledToolNames !== undefined && !enabledToolNames.has(name)) continue;
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      },
      async (args: unknown, extra: any) => {
        const result = await withToolConcurrency(name, (signal) =>
          tool.run(args, {
            sessionID: extra?.sessionId,
            agent: "mcp-client",
            signal,
          }),
          extra?.signal,
        );
        return {
          content: [{ type: "text", text: result.text }],
          structuredContent: result.structuredContent,
        };
      },
    );
  }
};

const createPrismMcpServer = (enabledToolNames?: ReadonlySet<string>): McpServer => {
  const server = new McpServer({
    name: __PRISM_SERVER_NAME__,
    version: __PRISM_SERVER_VERSION__,
  });
  registerPrismTools(server, enabledToolNames);
  return server;
};`;

const MCP_SDK_HTTP_RUNTIME = `// Runtime identity is never baked into bundle bytes: the daemon supervisor
// passes host/port via environment when it spawns this server.
const httpHost = process.env.PRISM_MCP_HTTP_HOST ?? "127.0.0.1";
const isLoopbackBindHost = (value: string): boolean =>
  value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
if (!isLoopbackBindHost(httpHost) && process.env.PRISM_MCP_ALLOW_NON_LOOPBACK_HTTP !== "1") {
  throw new Error("Prism MCP Streamable HTTP server refuses to bind non-loopback hosts unless PRISM_MCP_ALLOW_NON_LOOPBACK_HTTP=1");
}
const httpPort = Number(process.env.PRISM_MCP_HTTP_PORT ?? "0");
if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) {
  throw new Error("Prism MCP Streamable HTTP server requires env PRISM_MCP_HTTP_PORT (1-65535)");
}
const httpPath = process.env.PRISM_MCP_HTTP_PATH ?? "/mcp";
const httpHealthPath = process.env.PRISM_MCP_HTTP_HEALTH_PATH ?? "/healthz";
const serverStartedAt = Date.now();
const serverSha256 = process.env.PRISM_MCP_SERVER_SHA256;
const sseDisabledSearchParam = "prism_sse";

interface HttpSessionState {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  updatedAt: number;
}

interface AuthorizedRequest {
  enabledToolNames?: ReadonlySet<string>;
  denied?: Response;
}

const configuredMaxSessions = Number(process.env.PRISM_MCP_MAX_SESSIONS ?? "128");
const maxSessions = Number.isFinite(configuredMaxSessions) && configuredMaxSessions > 0
  ? configuredMaxSessions
  : 128;
const configuredSessionTtlMs = Number(process.env.PRISM_MCP_SESSION_TTL_MS ?? "3600000");
const sessionTtlMs = Number.isFinite(configuredSessionTtlMs) && configuredSessionTtlMs > 0
  ? configuredSessionTtlMs
  : 3600000;
const configuredMaxRequestBytes = Number(process.env.PRISM_MCP_MAX_REQUEST_BYTES ?? "1048576");
const maxRequestBytes = Number.isFinite(configuredMaxRequestBytes) && configuredMaxRequestBytes > 0
  ? configuredMaxRequestBytes
  : 1048576;
// Must stay well under the 255s idleTimeout below so a standalone SSE stream
// never sits fully idle long enough for Bun to close the socket.
const configuredSseKeepaliveMs = Number(process.env.PRISM_MCP_SSE_KEEPALIVE_MS ?? "20000");
const sseKeepaliveIntervalMs = Number.isFinite(configuredSseKeepaliveMs) && configuredSseKeepaliveMs > 0
  ? configuredSseKeepaliveMs
  : 20000;
const configuredShutdownDrainMs = Number(process.env.PRISM_MCP_SHUTDOWN_DRAIN_MS ?? "10000");
const shutdownDrainMs = Number.isFinite(configuredShutdownDrainMs) && configuredShutdownDrainMs >= 0
  ? configuredShutdownDrainMs
  : 10000;
const configuredShutdownFlushMs = Number(process.env.PRISM_MCP_SHUTDOWN_FLUSH_MS ?? "300");
const shutdownFlushGraceMs = Number.isFinite(configuredShutdownFlushMs) && configuredShutdownFlushMs >= 0
  ? configuredShutdownFlushMs
  : 300;
const sessions = new Map<string, HttpSessionState>();
let pendingSessionBootstraps = 0;

const activeOrPendingSessionCount = (): number =>
  sessions.size + pendingSessionBootstraps;

const responseHeaders = (extra?: HeadersInit, request?: Request): Headers => {
  const headers = new Headers(extra);
  const origin = request?.headers.get("origin");
  headers.set("Access-Control-Allow-Headers", "content-type, mcp-protocol-version, mcp-session-id, last-event-id");
  headers.set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Origin", origin ? (isAllowedOrigin(origin) ? origin : "null") : "*");
  headers.set("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
  headers.set("Cache-Control", "no-store");
  headers.append("Vary", "Origin");
  return headers;
};

const jsonResponse = (body: unknown, init: ResponseInit = {}, request?: Request): Response => {
  const headers = responseHeaders(init.headers, request);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
};

const emptyResponse = (status: number, init: ResponseInit = {}, request?: Request): Response =>
  new Response(null, { ...init, status, headers: responseHeaders(init.headers, request) });

const attachResponseHeaders = (response: Response, request: Request): Response => {
  const headers = responseHeaders(response.headers, request);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const closeSession = async (sessionID: string): Promise<void> => {
  const session = sessions.get(sessionID);
  if (!session) return;
  sessions.delete(sessionID);
  try {
    await session.transport.close();
  } catch {
    // The SDK transport may already be closed by a DELETE request.
  }
  try {
    await session.server.close();
  } catch {
    // The server connection may already be closed by transport cleanup.
  }
};

const pruneExpiredSessions = async (): Promise<void> => {
  const now = Date.now();
  const expired: string[] = [];
  for (const [sessionID, session] of sessions) {
    if (now - session.updatedAt > sessionTtlMs) expired.push(sessionID);
  }
  await Promise.all(expired.map(closeSession));
};

const touchSession = (sessionID: string): void => {
  const session = sessions.get(sessionID);
  if (session) sessions.set(sessionID, { ...session, updatedAt: Date.now() });
};

const isAllowedHostHeader = (value: string | null): boolean => {
  if (!value) return false;
  const lower = value.toLowerCase();
  const configured = httpHost.toLowerCase();
  return (
    lower === "localhost" ||
    lower.startsWith("localhost:") ||
    lower === "127.0.0.1" ||
    lower.startsWith("127.0.0.1:") ||
    lower === "[::1]" ||
    lower.startsWith("[::1]:") ||
    lower === configured ||
    lower.startsWith(configured + ":")
  );
};

const isAllowedOrigin = (value: string | null): boolean => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isAllowedHostHeader(url.host)
    );
  } catch {
    return false;
  }
};

const authorize = (request: Request): AuthorizedRequest => {
  if (!isAllowedHostHeader(request.headers.get("host"))) {
    return { denied: jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden host" }, id: null }, { status: 403 }, request) };
  }
  if (!isAllowedOrigin(request.headers.get("origin"))) {
    return { denied: jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden origin" }, id: null }, { status: 403 }, request) };
  }
  const profile = request.headers.get(exposureHeaderName);
  if (profile) {
    const toolNames = exposureProfiles[profile];
    if (!toolNames) {
      return { denied: jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown MCP exposure profile" }, id: null }, { status: 403 }, request) };
    }
    return { enabledToolNames: toolNameSet(toolNames) };
  }
  return {};
};

const healthPayload = (enabledToolNames?: ReadonlySet<string>) => ({
  schema: "prism.mcp-health.v1",
  serverName: __PRISM_SERVER_NAME__,
  transport: "streamable-http",
  startedAt: new Date(serverStartedAt).toISOString(),
  uptimeMs: Math.max(0, Date.now() - serverStartedAt),
  pid: process.pid,
  toolCount: registeredToolCount(enabledToolNames),
  ...(serverSha256 ? { serverSha256 } : {}),
  serverSourceSha256: PRISM_MCP_SERVER_SOURCE_SHA,
});

const readLimitedRequestBody = async (request: Request): Promise<string> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxRequestBytes) {
    throw new Error(\`Request body exceeds \${maxRequestBytes} bytes\`);
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > maxRequestBytes) {
      try {
        await reader.cancel();
      } catch {
        // The client may already have closed the body stream.
      }
      throw new Error(\`Request body exceeds \${maxRequestBytes} bytes\`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const readJsonBody = async (request: Request): Promise<unknown> => {
  const text = await readLimitedRequestBody(request);
  if (text.trim().length === 0) return undefined;
  return JSON.parse(text);
};

const sseDisabledForRequest = (url: URL): boolean =>
  url.searchParams.get(sseDisabledSearchParam) === "off";

// SSE comment frame per the event-stream spec: a line starting with ":" is
// ignored by EventSource clients but is still real bytes on the wire, so it
// resets Bun's per-socket idle timer the same as any other traffic.
const SSE_KEEPALIVE_FRAME = ":\\n\\n";

// Standalone GET SSE streams (server push / notifications) are tracked here
// so shutdown can end them explicitly instead of leaving them to abrupt
// socket teardown.
const activeSseStreamEnders = new Set<() => void>();

/**
 * Wraps an SSE Response with a periodic keepalive comment frame so the
 * standalone GET notification stream never sits fully idle for
 * sseKeepaliveIntervalMs, well inside the 255s idleTimeout Bun would
 * otherwise silently enforce on a truly idle connection. Non-SSE responses
 * (DELETE, disabled-SSE GET) pass through unchanged.
 */
const withSseKeepalive = (response: Response): Response => {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body || !contentType.includes("text/event-stream")) return response;

  const encoder = new TextEncoder();
  const source = response.body;
  const reader = source.getReader();
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let ended = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stopKeepalive = (): void => {
    if (keepaliveTimer !== undefined) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
  };

  const endStream = (): void => {
    if (ended) return;
    ended = true;
    activeSseStreamEnders.delete(endStream);
    stopKeepalive();
    try {
      controllerRef?.close();
    } catch {
      // Controller may already be closed by the pump loop or the consumer.
    }
    void reader.cancel().catch(() => {});
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      activeSseStreamEnders.add(endStream);
      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(SSE_KEEPALIVE_FRAME));
        } catch {
          // Controller already closed; the pump loop below settles \`ended\`.
        }
      }, sseKeepaliveIntervalMs);

      void (async () => {
        try {
          while (!ended) {
            const { done, value } = await reader.read();
            if (done || ended) break;
            controller.enqueue(value);
          }
          if (!ended) {
            ended = true;
            activeSseStreamEnders.delete(endStream);
            stopKeepalive();
            controller.close();
          }
        } catch (error) {
          if (!ended) {
            ended = true;
            activeSseStreamEnders.delete(endStream);
            stopKeepalive();
            controller.error(error);
          }
        }
      })();
    },
    cancel(reason) {
      if (ended) return;
      ended = true;
      activeSseStreamEnders.delete(endStream);
      stopKeepalive();
      void reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
};

// In-flight Streamable HTTP request/response cycles racing against shutdown.
// See raceAgainstShutdown for why this is required rather than relying on
// WebStandardStreamableHTTPServerTransport#close().
const inFlightShutdownWaiters = new Set<() => void>();

const bestEffortJsonRpcId = (parsedBody: unknown): unknown => {
  if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) && "id" in parsedBody) {
    return (parsedBody as { id?: unknown }).id ?? null;
  }
  return null;
};

/**
 * Races a Streamable HTTP request/response cycle against server shutdown.
 *
 * WebStandardStreamableHTTPServerTransport's JSON-response mode (enabled
 * below) resolves the HTTP response only when transport.send() delivers the
 * final tool-call result. Its close() -- called while draining sessions on
 * shutdown -- clears the internal stream map via a \`cleanup\` callback that,
 * for a pending JSON-mode stream, only deletes the map entry: it never calls
 * the stored \`resolveJson\`. Left alone, that orphans the awaited Promise and
 * the caller's HTTP request simply hangs (until it hits its own multi-minute
 * client-side timeout) instead of ever seeing a response. Racing the real
 * transport promise against an explicit shutdown signal guarantees a
 * terminal JSON-RPC error is sent instead.
 */
const raceAgainstShutdown = async (
  request: Request,
  parsedBody: unknown,
  inner: Promise<Response>,
): Promise<Response> => {
  let resolveShutdown: (() => void) | undefined;
  const shutdownResponse = new Promise<Response>((resolve) => {
    resolveShutdown = () =>
      resolve(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: bestEffortJsonRpcId(parsedBody),
            error: { code: -32000, message: "Prism MCP server is shutting down" },
          },
          { status: 503 },
          request,
        ),
      );
    inFlightShutdownWaiters.add(resolveShutdown);
  });
  try {
    return await Promise.race([inner, shutdownResponse]);
  } finally {
    if (resolveShutdown) inFlightShutdownWaiters.delete(resolveShutdown);
  }
};

// Prism only routes a new HTTP session here. The SDK transport still owns
// initialize semantics and the protocol method dispatch after routing.
const isSdkSessionBootstrapRequest = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value as { method?: unknown }).method === "initialize";

const handleSdkSessionBootstrapPost = async (
  request: Request,
  parsedBody: unknown,
  enabledToolNames?: ReadonlySet<string>,
): Promise<Response> => {
  if (activeOrPendingSessionCount() >= maxSessions) {
    const id = parsedBody && typeof parsedBody === "object" && "id" in parsedBody
      ? (parsedBody as { id?: unknown }).id
      : null;
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "MCP session limit reached" }, id: id ?? null }, { status: 429 }, request);
  }

  pendingSessionBootstraps += 1;
  const server = createPrismMcpServer(enabledToolNames);
  let initializedSessionID: string | undefined;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionID) => {
      initializedSessionID = sessionID;
      sessions.set(sessionID, { server, transport, updatedAt: Date.now() });
    },
    onsessionclosed: (sessionID) => {
      sessions.delete(sessionID);
    },
  });

  try {
    await server.connect(transport);
    const response = await raceAgainstShutdown(request, parsedBody, transport.handleRequest(request, { parsedBody }));
    if (initializedSessionID) touchSession(initializedSessionID);
    return attachResponseHeaders(response, request);
  } finally {
    pendingSessionBootstraps -= 1;
    if (!initializedSessionID) {
      try {
        await transport.close();
      } catch {
        // The SDK transport may already be closed after a failed bootstrap.
      }
      try {
        await server.close();
      } catch {
        // The server connection may already be closed by transport cleanup.
      }
    }
  }
};

const handlePost = async (
  request: Request,
  enabledToolNames?: ReadonlySet<string>,
): Promise<Response> => {
  let parsedBody: unknown;
  try {
    parsedBody = await readJsonBody(request);
  } catch (error) {
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32700, message: errorMessage(error) }, id: null }, { status: 400 }, request);
  }

  await pruneExpiredSessions();

  if (isSdkSessionBootstrapRequest(parsedBody)) {
    return await handleSdkSessionBootstrapPost(request, parsedBody, enabledToolNames);
  }

  const sessionID = request.headers.get("mcp-session-id") ?? undefined;
  const session = sessionID ? sessions.get(sessionID) : undefined;
  if (!sessionID || !session) {
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or invalid MCP session" }, id: null }, { status: sessionID ? 404 : 400 }, request);
  }

  touchSession(sessionID);
  const response = await raceAgainstShutdown(
    request,
    parsedBody,
    session.transport.handleRequest(request, { parsedBody }),
  );
  return attachResponseHeaders(response, request);
};

const handleSessionRequest = async (request: Request): Promise<Response> => {
  const sessionID = request.headers.get("mcp-session-id") ?? undefined;
  await pruneExpiredSessions();
  const session = sessionID ? sessions.get(sessionID) : undefined;
  if (!sessionID || !session) {
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or invalid MCP session" }, id: null }, { status: sessionID ? 404 : 400 }, request);
  }
  touchSession(sessionID);
  return withSseKeepalive(attachResponseHeaders(await session.transport.handleRequest(request), request));
};

const server = Bun.serve({
  hostname: httpHost,
  port: httpPort,
  // MCP connections sit idle between tool calls. Bun's default idleTimeout is
  // 10s, which silently closes the socket; clients that reuse the closed
  // connection (observed with Grok) then hang until their own multi-minute
  // timeout. 255 is Bun's maximum. A per-request JSON-mode tool call never
  // trips this: Bun only counts idle time between distinct request/response
  // cycles on a connection, not time spent awaiting a still-in-flight
  // handler (confirmed empirically against Bun 1.3.14). The one connection
  // that genuinely sits idle between byte transfers is the standalone GET
  // SSE stream, which withSseKeepalive keeps alive with periodic comment
  // frames well inside this window; see PRISM_MCP_SSE_KEEPALIVE_MS.
  idleTimeout: 255,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return emptyResponse(204, {}, request);
    if (url.pathname === httpHealthPath) {
      const authorization = authorize(request);
      if (authorization.denied) return authorization.denied;
      if (request.method === "GET") return jsonResponse(healthPayload(authorization.enabledToolNames), {}, request);
      return jsonResponse({ error: "method not allowed" }, { status: 405 }, request);
    }
    if (url.pathname !== httpPath) return jsonResponse({ error: "not found" }, { status: 404 }, request);

    const authorization = authorize(request);
    if (authorization.denied) return authorization.denied;

    if (request.method === "POST") return await handlePost(request, authorization.enabledToolNames);
    if (request.method === "GET" && sseDisabledForRequest(url)) {
      return jsonResponse({ error: "SSE stream disabled for this MCP client" }, { status: 405 }, request);
    }
    if (request.method === "DELETE" || request.method === "GET") return await handleSessionRequest(request);
    return jsonResponse({ error: "method not allowed" }, { status: 405 }, request);
  },
});

const stopServer = async (): Promise<void> => {
  // Graceful drain: stop accepting new connections, let in-flight tool calls
  // finish within a bounded window, then close sessions and force-close anything
  // still open (e.g. idle SSE streams). Avoids dropping live tool calls on
  // restart/SIGTERM.
  server.stop();

  // Standalone SSE notification streams have no tool-call-style "let it
  // finish" completion condition -- they're just left open for future
  // server-initiated pushes -- so end them now instead of making clients
  // wait out the drain window before observing a close.
  for (const endSseStream of [...activeSseStreamEnders]) endSseStream();

  const drainDeadline = Date.now() + shutdownDrainMs;
  while (activeToolCalls > 0 && Date.now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // A tool call that outlived the graceful drain window gets an explicit
  // terminal JSON-RPC error here instead of a silent drop: closeSession's
  // transport.close() below clears the SDK's internal stream map without
  // ever settling a pending JSON-mode response promise (see
  // raceAgainstShutdown), so without this the caller's request would just
  // hang until socket teardown -- exactly the multi-minute-timeout failure
  // this exists to prevent.
  for (const resolvePending of [...inFlightShutdownWaiters]) resolvePending();
  if (shutdownFlushGraceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, shutdownFlushGraceMs));
  }

  await Promise.all([...sessions.keys()].map(closeSession));
  server.stop(true);
  process.exit(0);
};

process.on("SIGTERM", () => void stopServer());
process.on("SIGINT", () => void stopServer());

console.error(\`prism MCP Streamable HTTP server listening on http://\${server.hostname}:\${server.port}\${httpPath}\`);`;

const MCP_SDK_STDIO_RUNTIME = `const enabledToolNamesFromEnv = (): ReadonlySet<string> | undefined => {
  const raw = process.env.PRISM_MCP_ENABLED_TOOLS;
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return toolNameSet(raw.split(","));
};

const server = createPrismMcpServer(enabledToolNamesFromEnv());
const transport = new StdioServerTransport();

await server.connect(transport);`;

/**
 * Runtime template sources that govern generated MCP server behavior
 * independent of any specific plugin's tool bindings (transport handling,
 * the tool-call factory, the schema bridge, the health payload shape). A
 * build whose templates differ here produces bytes a running daemon must
 * not keep serving — even when the plugin's own bindings never changed and
 * nobody has recompiled that specific plugin yet. A per-plugin bundle
 * content hash cannot see this class of drift, because nothing about a
 * specific plugin's bundle changes until someone recompiles it; this
 * fingerprint is what lets an already-running daemon (or an on-disk bundle
 * nobody has restarted yet) be checked against the generator that produced
 * it, not just against itself.
 */
const MCP_SERVER_RUNTIME_SOURCE_SECTIONS: readonly string[] = [
  SCHEMA_ANNOTATION_HELPERS,
  TOOL_SURFACE_RUNTIME_TYPES,
  SCHEMA_BRIDGE_RUNTIME,
  MCP_TOOL_FACTORY_RUNTIME,
  MCP_SDK_SERVER_FACTORY_RUNTIME,
  MCP_SDK_HTTP_RUNTIME,
  MCP_SDK_STDIO_RUNTIME,
];

/**
 * Stable fingerprint of the MCP server runtime templates baked into this
 * build of prism. Embedded into the Streamable HTTP bundle as the literal
 * `PRISM_MCP_SERVER_SOURCE_SHA` constant (see `MCP_TOOL_FACTORY_RUNTIME`)
 * and mirrored into the live `/healthz` payload as `serverSourceSha256` —
 * the long-running HTTP daemon is the transport that can drift from source
 * independently of any specific plugin's bindings, since nothing forces it
 * to restart when the shared runtime templates change. A stdio server is
 * re-spawned fresh per client session directly off whatever bytes are on
 * disk right now, so there is no persistent process for this fingerprint to
 * describe; the bundler tree-shakes the otherwise-unreferenced constant out
 * of the stdio bundle.
 */
export const mcpServerRuntimeSourceSha256 = (): string =>
  computeContentHash(MCP_SERVER_RUNTIME_SOURCE_SECTIONS.join(" "));

// Bun's bundler rewrites top-level `const` to `var` when merging scopes
// across bundled modules, so the declaration keyword in a *built* bundle is
// not guaranteed to match the literal template text — match either.
const MCP_SERVER_SOURCE_SHA_PATTERN = /(?:const|var|let)\s+PRISM_MCP_SERVER_SOURCE_SHA\s*=\s*"([0-9a-f]{64})"/u;

/**
 * Reads the embedded runtime-source fingerprint back out of a generated MCP
 * server bundle's raw text without executing it — safe to call on an
 * arbitrary (possibly stale or broken) bundle already sitting on disk.
 * Returns undefined for a bundle that never embedded one (a stdio bundle, or
 * one built before this fingerprint existed at all).
 */
export const readMcpServerSourceSha256FromBundle = (bundleContent: string): string | undefined =>
  MCP_SERVER_SOURCE_SHA_PATTERN.exec(bundleContent)?.[1];

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

const PI_EXTENSION_RUNTIME = `const runtimeContext = (ctx?: any, signal?: AbortSignal): ToolRuntimeContext => {
  const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
  const sessionFile = typeof ctx?.sessionManager?.getSessionFile === "function"
    ? ctx.sessionManager.getSessionFile()
    : undefined;
  return {
    sessionID: typeof sessionFile === "string" ? sessionFile : "pi-extension",
    agent: "pi",
    timestamp: new Date().toISOString(),
    workingDirectory: cwd,
    repoRoot: cwd,
    ...(signal ? { signal } : {}),
  };
};

const createToolDefinition = (name: string, surface: ToolSurface) => {
  const inputSchema = surface.Input ?? surface.input;
  const outputSchema = surface.Output ?? surface.output;
  if (!inputSchema) throw new Error("Pi tool '" + name + "' is missing an Input/input schema");
  if (!outputSchema) throw new Error("Pi tool '" + name + "' is missing an Output/output schema");
  let inputJsonSchema: JsonSchema;
  try {
    inputJsonSchema = inputJsonSchemaFromEffectSchema(inputSchema);
  } catch (error) {
    throw new Error("Pi tool '" + name + "' has unsupported Input/input schema: " + errorMessage(error));
  }

  return {
    name,
    label: name,
    description: surface.description ?? "",
    promptSnippet: (surface.description ?? name).slice(0, 240),
    parameters: inputJsonSchema,
    async execute(_toolCallId: string, rawArgs: Record<string, unknown>, signal?: AbortSignal, _onUpdate?: unknown, ctx?: any) {
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

export default function (pi: { registerTool(definition: any): unknown; on?: (event: string, handler: any) => unknown }) {
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

const guardMcpTransportRuntimeForValidation = (runtime: string): string =>
  `if (!prismMcpValidateOnly) {\n${runtime}\n}`;

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

const renderExposureProfiles = (
  profiles: ReadonlyArray<McpServerExposureProfile> | undefined,
): string => {
  const rendered: Record<string, string[]> = {};
  for (const profile of profiles ?? []) {
    rendered[profile.name] = [...new Set(profile.toolNames)].sort((left, right) =>
      left.localeCompare(right),
    );
  }
  return JSON.stringify(rendered, null, 2);
};

const renderMcpHttpTransportRuntime = (options: {
  readonly serverName: string;
  readonly version: string;
  readonly toolEntries: string;
  readonly exposureProfiles: string;
}): string =>
  joinGeneratedSections([
    replaceTemplateTokens(MCP_SDK_SERVER_FACTORY_RUNTIME, {
      __PRISM_TOOL_ENTRIES__: options.toolEntries,
      __PRISM_SERVER_NAME__: JSON.stringify(options.serverName),
      __PRISM_SERVER_VERSION__: JSON.stringify(options.version),
      __PRISM_EXPOSURE_PROFILES__: options.exposureProfiles,
    }),
    guardMcpTransportRuntimeForValidation(
      replaceTemplateTokens(MCP_SDK_HTTP_RUNTIME, {
        __PRISM_SERVER_NAME__: JSON.stringify(options.serverName),
      }),
    ),
  ]);

const renderMcpStdioTransportRuntime = (options: {
  readonly serverName: string;
  readonly version: string;
  readonly toolEntries: string;
  readonly exposureProfiles: string;
}): string =>
  joinGeneratedSections([
    replaceTemplateTokens(MCP_SDK_SERVER_FACTORY_RUNTIME, {
      __PRISM_TOOL_ENTRIES__: options.toolEntries,
      __PRISM_SERVER_NAME__: JSON.stringify(options.serverName),
      __PRISM_SERVER_VERSION__: JSON.stringify(options.version),
      __PRISM_EXPOSURE_PROFILES__: options.exposureProfiles,
    }),
    guardMcpTransportRuntimeForValidation(MCP_SDK_STDIO_RUNTIME),
  ]);

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
): string =>
  replaceTemplateTokens(PI_EXTENSION_RUNTIME, {
    __PRISM_TOOL_ENTRIES__: toolEntries,
    __PRISM_EXTENSION_SETUP__: setupSource ? setupSource.trimEnd().replace(/^/gm, "  ") : "",
  });

const renderMcpServerEntry = (options: {
  readonly serverName: string;
  readonly version: string;
  readonly specs: ReadonlyArray<McpAdapterSpec>;
  readonly exposureProfiles?: ReadonlyArray<McpServerExposureProfile>;
}): string => {
  const { imports, entries } = renderToolSurfaceBindings(
    options.specs,
    (spec, ident) =>
      `  ${JSON.stringify(spec.mcpName)}: createTool(${JSON.stringify(spec.mcpName)}, ${ident} as ToolSurface),`,
  );
  const runtime = renderMcpHttpTransportRuntime({
    serverName: options.serverName,
    version: options.version,
    toolEntries: entries,
    exposureProfiles: renderExposureProfiles(options.exposureProfiles),
  });

  return joinGeneratedSections([
    `#!/usr/bin/env bun
// GENERATED by prism — do not edit.
// Standalone MCP server for compiled canonical tool bindings.
// Streamable HTTP identity (host/port) is read from the environment at startup.`,
    `import { Schema, SchemaAST } from ${JSON.stringify(effectBundleImportPath())};`,
    `import { McpServer } from ${JSON.stringify(mcpSdkMcpBundleImportPath())};`,
    `import { WebStandardStreamableHTTPServerTransport } from ${JSON.stringify(mcpSdkWebStandardHttpBundleImportPath())};`,
    `import * as z from ${JSON.stringify(zodV4BundleImportPath())};`,
    imports,
    TOOL_SURFACE_RUNTIME_TYPES,
    renderSchemaBridgeRuntime("mcp-schema-bridge"),
    replaceTemplateTokens(MCP_TOOL_FACTORY_RUNTIME, {
      // The default is a compile-time constant (never per-harness identity):
      // harnesses override at runtime via PRISM_MCP_TOOL_TIMEOUT_MS.
      __PRISM_TOOL_TIMEOUT_MS__: String(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS),
      __PRISM_SERVER_SOURCE_SHA256__: mcpServerRuntimeSourceSha256(),
    }),
    runtime,
  ]);
};

const renderMcpStdioServerEntry = (options: {
  readonly serverName: string;
  readonly version: string;
  readonly specs: ReadonlyArray<McpAdapterSpec>;
  readonly exposureProfiles?: ReadonlyArray<McpServerExposureProfile>;
}): string => {
  const { imports, entries } = renderToolSurfaceBindings(
    options.specs,
    (spec, ident) =>
      `  ${JSON.stringify(spec.mcpName)}: createTool(${JSON.stringify(spec.mcpName)}, ${ident} as ToolSurface),`,
  );
  const runtime = renderMcpStdioTransportRuntime({
    serverName: options.serverName,
    version: options.version,
    toolEntries: entries,
    exposureProfiles: renderExposureProfiles(options.exposureProfiles),
  });

  return joinGeneratedSections([
    `#!/usr/bin/env node
// GENERATED by prism — do not edit.
// Standalone stdio MCP server for compiled canonical tool bindings.`,
    `import { Schema, SchemaAST } from ${JSON.stringify(effectBundleImportPath())};`,
    `import { McpServer } from ${JSON.stringify(mcpSdkMcpBundleImportPath())};`,
    `import { StdioServerTransport } from ${JSON.stringify(mcpSdkStdioBundleImportPath())};`,
    `import * as z from ${JSON.stringify(zodV4BundleImportPath())};`,
    imports,
    TOOL_SURFACE_RUNTIME_TYPES,
    renderSchemaBridgeRuntime("mcp-schema-bridge"),
    replaceTemplateTokens(MCP_TOOL_FACTORY_RUNTIME, {
      // The default is a compile-time constant (never per-harness identity):
      // harnesses override at runtime via PRISM_MCP_TOOL_TIMEOUT_MS.
      __PRISM_TOOL_TIMEOUT_MS__: String(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS),
      __PRISM_SERVER_SOURCE_SHA256__: mcpServerRuntimeSourceSha256(),
    }),
    runtime,
  ]);
};

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
}): string => {
  const { imports, entries } = renderToolSurfaceBindings(
    options.specs,
    (spec, ident) =>
      `  createToolDefinition(${JSON.stringify(spec.mcpName)}, ${ident} as ToolSurface),`,
  );

  return joinGeneratedSections([
    `// GENERATED by prism — do not edit.
// Pi extension for compiled Prism canonical tool bindings.
// Source plugin: ${options.sourcePluginName} v${options.version}`,
    `import { Schema, SchemaAST } from ${JSON.stringify(effectBundleImportPath())};`,
    imports,
    options.setupImports ?? "",
    TOOL_SURFACE_RUNTIME_TYPES,
    renderSchemaBridgeRuntime("pi-schema-bridge"),
    renderPiExtensionRuntime(entries, options.setupSource),
  ]);
};

const writeTempBundleSources = async (options: {
  readonly tempRoot: string;
  readonly mirrors: ReadonlyArray<PluginMirror>;
  readonly importPluginRoots: ReadonlyMap<string, string>;
  readonly entrySource: string;
  readonly entryFileName?: string;
}): Promise<string> => {
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

const validationErrorDetail = (error: unknown): string => {
  const failure = error as {
    readonly code?: unknown;
    readonly signal?: unknown;
    readonly stderr?: unknown;
    readonly stdout?: unknown;
    readonly message?: unknown;
  };
  const status =
    failure.signal !== undefined && failure.signal !== null
      ? `signal ${String(failure.signal)}`
      : failure.code !== undefined && failure.code !== null
        ? `exit ${String(failure.code)}`
        : undefined;
  const output = [failure.stderr, failure.stdout]
    .filter((value): value is string | Buffer => typeof value === "string" || Buffer.isBuffer(value))
    .map((value) => value.toString())
    .join("\n")
    .trim();
  const message = typeof failure.message === "string" ? failure.message : String(error);
  return [status, output || message].filter(Boolean).join(": ");
};

const validateBuiltMcpServerBundle = async (builtPath: string): Promise<void> => {
  const previousValidate = process.env.PRISM_MCP_VALIDATE;
  process.env.PRISM_MCP_VALIDATE = "1";
  try {
    await import(`${pathToFileURL(builtPath).href}?prism-validate=${Date.now()}`);
  } catch (error) {
    throw new Error(
      `failed to validate MCP server bundle: ${validationErrorDetail(error)}`,
      { cause: error },
    );
  } finally {
    if (previousValidate === undefined) {
      delete process.env.PRISM_MCP_VALIDATE;
    } else {
      process.env.PRISM_MCP_VALIDATE = previousValidate;
    }
  }
};

const validateBuiltMcpStdioBundle = async (builtPath: string): Promise<void> => {
  try {
    await execFileAsync("node", [builtPath], {
      env: {
        ...process.env,
        PRISM_MCP_VALIDATE: "1",
      },
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `failed to validate MCP stdio bundle with node: ${validationErrorDetail(error)}`,
      { cause: error },
    );
  }
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

const normalizeBuiltMcpServerBundle = stripBundlerPathComments;

/**
 * Sorted, deduped MCP tool names for a binding set — the same names the
 * generated server registers, computable without building the bundle.
 */
export const mcpToolNamesForBindings = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): string[] =>
  adapterSpecsForBindings(sourcePluginName, bindings).map((spec) => spec.mcpName);

export const generateMcpServerBundle = async (
  options: McpServerBundleOptions,
): Promise<McpServerBundle> => {
  const version = options.version ?? "0.1.0";
  const bundleId = options.bundleId ?? normalizeGeneratedPluginName(options.sourcePluginName);
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

  const tempRoot = await mkdtemp(join(tmpdir(), "prism-mcp-bundle-"));
  try {
    const entrySource = renderMcpServerEntry({
      serverName: options.serverName,
      version,
      specs,
      exposureProfiles: options.exposureProfiles,
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
      naming: "server.mjs",
      sourcemap: "none",
      minify: false,
    });

    if (!build.success) {
      const diagnostics = build.logs.map((log) => log.message).join("\n");
      throw new BundleBuildError({ bundleKind: "MCP server", diagnostics });
    }

    const builtPath = join(outdir, "server.mjs");
    await validateBuiltMcpServerBundle(builtPath);
    const content = normalizeBuiltMcpServerBundle(await readFile(builtPath, "utf8"));

    const stdioEntrySource = renderMcpStdioServerEntry({
      serverName: options.serverName,
      version,
      specs,
      exposureProfiles: options.exposureProfiles,
    });
    const stdioEntryPath = await writeTempBundleSources({
      tempRoot,
      mirrors,
      importPluginRoots,
      entrySource: stdioEntrySource,
      entryFileName: "stdio-entry.ts",
    });
    const stdioBuild = await Bun.build({
      entrypoints: [stdioEntryPath],
      outdir,
      target: "node",
      format: "esm",
      packages: "bundle",
      external: NODE_BUILTIN_EXTERNALS,
      naming: "entry-stdio.mjs",
      sourcemap: "none",
      minify: false,
    });

    if (!stdioBuild.success) {
      const diagnostics = stdioBuild.logs.map((log) => log.message).join("\n");
      throw new BundleBuildError({ bundleKind: "MCP stdio server", diagnostics });
    }

    const builtStdioPath = join(outdir, "entry-stdio.mjs");
    await validateBuiltMcpStdioBundle(builtStdioPath);
    const stdioContent = normalizeBuiltMcpServerBundle(await readFile(builtStdioPath, "utf8"));
    return {
      relativePath: mcpServerArtifactRelativePath(bundleId),
      content: content.startsWith("#!") ? content : `#!/usr/bin/env bun\n${content}`,
      stdioRelativePath: mcpServerStdioArtifactRelativePath(bundleId),
      stdioContent: stdioContent.startsWith("#!")
        ? stdioContent
        : `#!/usr/bin/env node\n${stdioContent}`,
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
