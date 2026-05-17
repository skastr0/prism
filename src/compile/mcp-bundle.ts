import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
import { effectBundleImportPath } from "./runtime-deps.js";
import {
  generatedToolNameForBinding,
  normalizeGeneratedPluginName,
  sanitizeGeneratedToolSegment,
  sourceIsInside,
} from "./generated-plugin.js";

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

export type McpServerBundleTransport = "stdio" | "streamable-http";

export interface McpHttpServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly tokenEnv?: string;
}

export interface McpServerBundleOptions {
  readonly sourcePluginName: string;
  readonly sourcePluginRoot?: string;
  readonly dependencyPluginRoots?: ReadonlyMap<string, string> | ReadonlyArray<readonly [string, string]>;
  readonly serverName: string;
  readonly version?: string;
  readonly bundleId?: string;
  readonly transport?: McpServerBundleTransport;
  readonly http?: McpHttpServerOptions;
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
}

export interface McpServerBundle {
  /** Stable path future harness lowerers can place inside their compiled artifact. */
  readonly relativePath: string;
  readonly content: string;
  readonly toolNames: ReadonlyArray<string>;
}

export interface AmpPluginBundleOptions {
  readonly sourcePluginName: string;
  readonly sourcePluginRoot?: string;
  readonly dependencyPluginRoots?: ReadonlyMap<string, string> | ReadonlyArray<readonly [string, string]>;
  readonly version?: string;
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
}

export interface AmpPluginBundle {
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

const ensureMirrorPluginEntries = (
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
  ensureMirrorPluginEntries(state, binding.toolPluginName, toolRoot).set(
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
  ensureMirrorPluginEntries(
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
}`;

const MCP_JSON_RPC_TYPES = `type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: any; result?: any; error?: any };`;

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
      return { const: ast.literal };
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
const configuredToolTimeoutMs = Number(process.env.PRISM_MCP_TOOL_TIMEOUT_MS ?? "120000");
const prismToolTimeoutMs = Number.isFinite(configuredToolTimeoutMs) && configuredToolTimeoutMs > 0
  ? configuredToolTimeoutMs
  : 120000;

const withToolTimeout = async <A>(name: string, operation: Promise<A>): Promise<A> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<A>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(\`MCP tool '\${name}' timed out after \${prismToolTimeoutMs}ms\`));
        }, prismToolTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

interface ToolCallRuntimeContext {
  sessionID?: string;
  agent?: string;
}

const runtimeContext = (callContext: ToolCallRuntimeContext = {}): ToolRuntimeContext => ({
  sessionID: callContext.sessionID ?? process.env.PRISM_MCP_SESSION_ID ?? "mcp-stdio",
  agent: callContext.agent ?? process.env.PRISM_MCP_AGENT ?? "mcp-client",
  timestamp: new Date().toISOString(),
  workingDirectory: prismWorkingDirectory,
  repoRoot: prismRepoRoot,
});

const createTool = (name: string, surface: ToolSurface) => {
  const inputSchema = surface.Input ?? surface.input;
  const outputSchema = surface.Output ?? surface.output;
  if (!inputSchema) throw new Error(\`MCP tool '\${name}' is missing an Input/input schema\`);
  if (!outputSchema) throw new Error(\`MCP tool '\${name}' is missing an Output/output schema\`);
  let inputJsonSchema: JsonSchema;
  try {
    inputJsonSchema = inputJsonSchemaFromEffectSchema(inputSchema);
  } catch (error) {
    throw new Error(\`MCP tool '\${name}' has unsupported Input/input schema: \${errorMessage(error)}\`);
  }

  const runTool = async (rawArgs: unknown, callContext?: ToolCallRuntimeContext): Promise<string> => {
    const input = decodeWithSchema(inputSchema as Schema.Schema<unknown, unknown, never>, rawArgs ?? {});
    const output = await surface.handle(input, runtimeContext(callContext));
    const validatedOutput = decodeWithSchema(outputSchema as Schema.Schema<unknown, unknown, never>, output);
    return JSON.stringify(validatedOutput, null, 2);
  };

  return {
    description: surface.description ?? "",
    inputSchema: inputJsonSchema,
    run: runTool,
    async call(rawArgs: unknown, callContext?: ToolCallRuntimeContext): Promise<string> {
      return await withToolTimeout(name, runTool(rawArgs, callContext));
    },
  };
};`;

const MCP_RPC_RUNTIME = `const tools = {
__PRISM_TOOL_ENTRIES__
};

if (process.env.PRISM_MCP_VALIDATE === "1") {
  process.exit(0);
}

type RpcFraming = "content-length" | "newline";

let responseFraming: RpcFraming = "content-length";
let exiting = false;

const exitSoon = (code = 0): void => {
  if (exiting) return;
  exiting = true;
  process.exitCode = code;
  process.stdin.pause();
  setTimeout(() => process.exit(code), 0).unref?.();
};

process.on("SIGTERM", () => exitSoon(0));
process.on("SIGINT", () => exitSoon(0));

const writeMessage = (message: unknown): void => {
  const payload = JSON.stringify(message);
  if (responseFraming === "newline") {
    process.stdout.write(payload + "\\n");
    return;
  }

  const bytes = Buffer.from(payload, "utf8");
  process.stdout.write(
    \`Content-Length: \${bytes.byteLength}\\r\\n\\r\\n\`,
  );
  process.stdout.write(bytes);
};

const rpcResult = (id: JsonRpcId | undefined, result: unknown): void => {
  if (id === undefined) return;
  writeMessage({ jsonrpc: "2.0", id, result });
};

const rpcError = (id: JsonRpcId | undefined, code: number, message: string): void => {
  if (id === undefined) return;
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
};

const handleMessage = async (message: JsonRpcMessage): Promise<void> => {
  const id = message.id;
  if (!message.method) {
    rpcError(id, -32600, "Invalid JSON-RPC request: missing method");
    return;
  }

  switch (message.method) {
    case "initialize":
      rpcResult(id, {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: __PRISM_SERVER_NAME__, version: __PRISM_SERVER_VERSION__ },
      });
      return;
    case "notifications/initialized":
      return;
    case "ping":
      rpcResult(id, {});
      return;
    case "tools/list":
      rpcResult(id, {
        tools: Object.entries(tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;
    case "tools/call": {
      const name = message.params?.name;
      if (typeof name !== "string" || !(name in tools)) {
        rpcError(id, -32602, \`Unknown tool: \${String(name)}\`);
        return;
      }
      try {
        const text = await tools[name as keyof typeof tools].call(message.params?.arguments ?? {});
        rpcResult(id, { content: [{ type: "text", text }] });
      } catch (error) {
        rpcResult(id, { isError: true, content: [{ type: "text", text: errorMessage(error) }] });
      }
      return;
    }
    case "shutdown":
      rpcResult(id, null);
      exitSoon(0);
      return;
    case "notifications/exit":
      exitSoon(0);
      return;
    default:
      rpcError(id, -32601, \`Method not found: \${message.method}\`);
  }
};

let buffer = Buffer.alloc(0);
const drainBuffer = (): void => {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd !== -1) {
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = /content-length:\\s*(\\d+)/i.exec(header);
      if (!lengthMatch) {
        buffer = buffer.subarray(headerEnd + 4);
        rpcError(null, -32700, "Missing Content-Length header");
        continue;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.byteLength < bodyEnd) return;
      const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.subarray(bodyEnd);
      responseFraming = "content-length";
      try {
        void handleMessage(JSON.parse(body) as JsonRpcMessage);
      } catch (error) {
        rpcError(null, -32700, errorMessage(error));
      }
      continue;
    }

    const newlineEnd = buffer.indexOf("\\n");
    if (newlineEnd === -1) return;
    const line = buffer.subarray(0, newlineEnd).toString("utf8").trim();
    buffer = buffer.subarray(newlineEnd + 1);
    if (line.length === 0) continue;
    responseFraming = "newline";
    try {
      void handleMessage(JSON.parse(line) as JsonRpcMessage);
    } catch (error) {
      rpcError(null, -32700, errorMessage(error));
    }
  }
};

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  drainBuffer();
});
process.stdin.on("end", () => exitSoon(0));
process.stdin.on("close", () => exitSoon(0));
process.stdin.resume();`;

const MCP_HTTP_RUNTIME = `const tools = {
__PRISM_TOOL_ENTRIES__
};

if (process.env.PRISM_MCP_VALIDATE === "1") {
  process.exit(0);
}

const httpHost = process.env.PRISM_MCP_HTTP_HOST ?? __PRISM_HTTP_HOST__;
const isLoopbackBindHost = (value: string): boolean =>
  value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
if (!isLoopbackBindHost(httpHost) && process.env.PRISM_MCP_ALLOW_NON_LOOPBACK_HTTP !== "1") {
  throw new Error("Prism MCP Streamable HTTP server refuses to bind non-loopback hosts unless PRISM_MCP_ALLOW_NON_LOOPBACK_HTTP=1");
}
const httpPort = Number(process.env.PRISM_MCP_HTTP_PORT ?? __PRISM_HTTP_PORT__);
const httpPath = process.env.PRISM_MCP_HTTP_PATH ?? "/mcp";
const httpTokenEnvName = __PRISM_HTTP_TOKEN_ENV__;
const httpToken = process.env[httpTokenEnvName] ?? process.env.PRISM_MCP_HTTP_TOKEN;
if (!httpToken) {
  throw new Error(\`Prism MCP Streamable HTTP server requires token env '\${httpTokenEnvName}'\`);
}
const supportedProtocolVersions = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
interface HttpSessionState {
  updatedAt: number;
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
const sessions = new Map<string, HttpSessionState>();
const configuredMaxConcurrentToolCalls = Number(process.env.PRISM_MCP_MAX_CONCURRENT_CALLS ?? "16");
const maxConcurrentToolCalls = Number.isFinite(configuredMaxConcurrentToolCalls) && configuredMaxConcurrentToolCalls > 0
  ? configuredMaxConcurrentToolCalls
  : 16;
let activeToolCalls = 0;

const withToolConcurrency = async <A>(name: string, operation: () => Promise<A>): Promise<A> => {
  if (activeToolCalls >= maxConcurrentToolCalls) {
    throw new Error(\`MCP tool '\${name}' rejected because \${activeToolCalls} tool call(s) are already running\`);
  }
  activeToolCalls += 1;
  let operationPromise: Promise<A>;
  try {
    operationPromise = operation();
  } catch (error) {
    activeToolCalls -= 1;
    throw error;
  }
  operationPromise.then(
    () => { activeToolCalls -= 1; },
    () => { activeToolCalls -= 1; },
  );
  return await withToolTimeout(name, operationPromise);
};

const responseHeaders = (extra?: HeadersInit): Headers => {
  const headers = new Headers(extra);
  headers.set("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
  headers.set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Origin", "null");
  headers.set("Cache-Control", "no-store");
  return headers;
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = responseHeaders(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
};

const emptyResponse = (status: number, init: ResponseInit = {}): Response =>
  new Response(null, { ...init, status, headers: responseHeaders(init.headers) });

const rpcResultMessage = (id: JsonRpcId | undefined, result: unknown): JsonRpcMessage | undefined =>
  id === undefined ? undefined : { jsonrpc: "2.0", id, result };

const rpcErrorMessage = (id: JsonRpcId | undefined, code: number, message: string): JsonRpcMessage | undefined =>
  id === undefined ? undefined : { jsonrpc: "2.0", id, error: { code, message } } as JsonRpcMessage;

const isInitializeRequest = (message: JsonRpcMessage): boolean =>
  message.method === "initialize";

const pruneExpiredSessions = (): void => {
  const now = Date.now();
  for (const [sessionID, session] of sessions) {
    if (now - session.updatedAt > sessionTtlMs) {
      sessions.delete(sessionID);
    }
  }
};

const touchSession = (sessionID: string): void => {
  sessions.set(sessionID, { updatedAt: Date.now() });
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

const authorize = (request: Request): Response | undefined => {
  if (!isAllowedHostHeader(request.headers.get("host"))) {
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden host" }, id: null }, { status: 403 });
  }
  if (!isAllowedOrigin(request.headers.get("origin"))) {
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden origin" }, id: null }, { status: 403 });
  }
  if (httpToken) {
    const expected = \`Bearer \${httpToken}\`;
    if (request.headers.get("authorization") !== expected) {
      return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized" }, id: null }, { status: 401 });
    }
  }
  return undefined;
};

const validateProtocolVersion = (request: Request): Response | undefined => {
  const version = request.headers.get("mcp-protocol-version");
  if (!version || !supportedProtocolVersions.has(version)) {
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or unsupported MCP-Protocol-Version" }, id: null }, { status: 400 });
  }
  return undefined;
};

const handleRpcMessage = async (
  message: JsonRpcMessage,
  sessionID: string,
): Promise<JsonRpcMessage | undefined> => {
  const id = message.id;
  if (!message.method) {
    return rpcErrorMessage(id, -32600, "Invalid JSON-RPC request: missing method");
  }

  switch (message.method) {
    case "initialize":
      return rpcResultMessage(id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: __PRISM_SERVER_NAME__, version: __PRISM_SERVER_VERSION__ },
      });
    case "notifications/initialized":
      return undefined;
    case "ping":
      return rpcResultMessage(id, {});
    case "tools/list":
      return rpcResultMessage(id, {
        tools: Object.entries(tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    case "tools/call": {
      const name = message.params?.name;
      if (typeof name !== "string" || !(name in tools)) {
        return rpcErrorMessage(id, -32602, \`Unknown tool: \${String(name)}\`);
      }
      try {
        const text = await withToolConcurrency(name, () =>
          tools[name as keyof typeof tools].run(message.params?.arguments ?? {}, {
            sessionID,
            agent: requestAgentName(message),
          }),
        );
        return rpcResultMessage(id, { content: [{ type: "text", text }] });
      } catch (error) {
        return rpcResultMessage(id, { isError: true, content: [{ type: "text", text: errorMessage(error) }] });
      }
    }
    case "shutdown":
      sessions.delete(sessionID);
      return rpcResultMessage(id, null);
    case "notifications/exit":
      sessions.delete(sessionID);
      return undefined;
    default:
      return rpcErrorMessage(id, -32601, \`Method not found: \${message.method}\`);
  }
};

const requestAgentName = (message: JsonRpcMessage): string => {
  const clientName = message.params?.clientInfo?.name;
  return typeof clientName === "string" && clientName.length > 0
    ? clientName
    : "mcp-http-client";
};

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

const readJsonMessage = async (request: Request): Promise<JsonRpcMessage> => {
  const text = await readLimitedRequestBody(request);

  const raw = JSON.parse(text);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Request body must be a single JSON-RPC object");
  }
  return raw as JsonRpcMessage;
};

const handlePost = async (request: Request): Promise<Response> => {
  let message: JsonRpcMessage;
  try {
    message = await readJsonMessage(request);
  } catch (error) {
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32700, message: errorMessage(error) }, id: null }, { status: 400 });
  }

  let sessionID = request.headers.get("mcp-session-id") ?? undefined;
  const headers = responseHeaders();
  pruneExpiredSessions();

  if (isInitializeRequest(message)) {
    if (sessions.size >= maxSessions) {
      return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "MCP session limit reached" }, id: message.id ?? null }, { status: 429 });
    }
    sessionID = crypto.randomUUID();
    touchSession(sessionID);
    headers.set("MCP-Session-Id", sessionID);
  } else if (!sessionID || !sessions.has(sessionID)) {
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or invalid MCP session" }, id: message.id ?? null }, { status: sessionID ? 404 : 400 });
  } else {
    touchSession(sessionID);
  }

  const response = await handleRpcMessage(message, sessionID);
  if (!response) return emptyResponse(202, { headers });
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(response), { status: 200, headers });
};

const handleDelete = (request: Request): Response => {
  const sessionID = request.headers.get("mcp-session-id") ?? undefined;
  pruneExpiredSessions();
  if (!sessionID || !sessions.has(sessionID)) {
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or invalid MCP session" }, id: null }, { status: sessionID ? 404 : 400 });
  }
  sessions.delete(sessionID);
  return emptyResponse(202);
};

const server = Bun.serve({
  hostname: httpHost,
  port: httpPort,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return emptyResponse(204);
    if (url.pathname !== httpPath) return jsonResponse({ error: "not found" }, { status: 404 });

    const denied = authorize(request);
    if (denied) return denied;

    if (request.method === "POST" || request.method === "DELETE") {
      const invalidProtocol = validateProtocolVersion(request);
      if (invalidProtocol) return invalidProtocol;
    }

    if (request.method === "POST") return await handlePost(request);
    if (request.method === "DELETE") return handleDelete(request);
    if (request.method === "GET") {
      return jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "SSE stream is not supported by this generated Prism MCP server" }, id: null }, { status: 405 });
    }
    return jsonResponse({ error: "method not allowed" }, { status: 405 });
  },
});

const stopServer = (): void => {
  server.stop(true);
  process.exit(0);
};

process.on("SIGTERM", stopServer);
process.on("SIGINT", stopServer);

console.error(\`prism MCP Streamable HTTP server listening on http://\${server.hostname}:\${server.port}\${httpPath}\`);`;

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

export default function (amp: { registerTool(definition: any): unknown }) {
  for (const definition of toolDefinitions) {
    amp.registerTool(definition);
  }
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

const renderMcpRpcRuntime = (options: {
  readonly serverName: string;
  readonly version: string;
  readonly toolEntries: string;
}): string =>
  replaceTemplateTokens(MCP_RPC_RUNTIME, {
    __PRISM_TOOL_ENTRIES__: options.toolEntries,
    __PRISM_SERVER_NAME__: JSON.stringify(options.serverName),
    __PRISM_SERVER_VERSION__: JSON.stringify(options.version),
  });

const renderMcpHttpRuntime = (options: {
  readonly serverName: string;
  readonly version: string;
  readonly toolEntries: string;
  readonly http?: McpHttpServerOptions;
}): string =>
  replaceTemplateTokens(MCP_HTTP_RUNTIME, {
    __PRISM_TOOL_ENTRIES__: options.toolEntries,
    __PRISM_SERVER_NAME__: JSON.stringify(options.serverName),
    __PRISM_SERVER_VERSION__: JSON.stringify(options.version),
    __PRISM_HTTP_HOST__: JSON.stringify(options.http?.host ?? "127.0.0.1"),
    __PRISM_HTTP_PORT__: JSON.stringify(String(options.http?.port ?? 0)),
    __PRISM_HTTP_TOKEN_ENV__: JSON.stringify(options.http?.tokenEnv ?? "PRISM_MCP_HTTP_TOKEN"),
  });

const renderAmpToolRegistrationRuntime = (toolEntries: string): string =>
  replaceTemplateTokens(AMP_TOOL_FACTORY_RUNTIME, {
    __PRISM_TOOL_ENTRIES__: toolEntries,
  });

const renderMcpServerEntry = (options: {
  readonly serverName: string;
  readonly version: string;
  readonly specs: ReadonlyArray<McpAdapterSpec>;
  readonly transport: McpServerBundleTransport;
  readonly http?: McpHttpServerOptions;
}): string => {
  const { imports, entries } = renderToolSurfaceBindings(
    options.specs,
    (spec, ident) =>
      `  ${JSON.stringify(spec.mcpName)}: createTool(${JSON.stringify(spec.mcpName)}, ${ident} as ToolSurface),`,
  );
  const runtime =
    options.transport === "streamable-http"
      ? renderMcpHttpRuntime({
          serverName: options.serverName,
          version: options.version,
          toolEntries: entries,
          http: options.http,
        })
      : renderMcpRpcRuntime({
          serverName: options.serverName,
          version: options.version,
          toolEntries: entries,
        });

  return joinGeneratedSections([
    `#!/usr/bin/env bun
// GENERATED by prism — do not edit.
// Standalone MCP ${options.transport} server for compiled canonical tool bindings.`,
    `import { Schema, SchemaAST } from ${JSON.stringify(effectBundleImportPath())};`,
    imports,
    MCP_JSON_RPC_TYPES,
    TOOL_SURFACE_RUNTIME_TYPES,
    renderSchemaBridgeRuntime("mcp-schema-bridge"),
    MCP_TOOL_FACTORY_RUNTIME,
    runtime,
  ]);
};

const renderAmpPluginEntry = (options: {
  readonly sourcePluginName: string;
  readonly version: string;
  readonly specs: ReadonlyArray<McpAdapterSpec>;
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
    imports,
    TOOL_SURFACE_RUNTIME_TYPES,
    renderSchemaBridgeRuntime("amp-schema-bridge"),
    renderAmpToolRegistrationRuntime(entries),
  ]);
};

const writeTempBundleSources = async (options: {
  readonly tempRoot: string;
  readonly mirrors: ReadonlyArray<PluginMirror>;
  readonly importPluginRoots: ReadonlyMap<string, string>;
  readonly entrySource: string;
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

  const entryPath = join(options.tempRoot, "server-entry.ts");
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
  try {
    await execFileAsync("bun", [builtPath], {
      env: { ...process.env, PRISM_MCP_VALIDATE: "1" },
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `failed to validate MCP server bundle with bun: ${validationErrorDetail(error)}`,
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

const normalizeBuiltAmpPluginBundle = (content: string): string =>
  content.replace(/^\/\/ .*prism-amp-plugin-[^\n]*\n/gm, "");

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
      transport: options.transport ?? "stdio",
      http: options.http,
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
      throw new Error(`failed to build MCP server bundle: ${diagnostics}`);
    }

    const builtPath = join(outdir, "server.mjs");
    await validateBuiltMcpServerBundle(builtPath);
    const content = await readFile(builtPath, "utf8");
    return {
      relativePath: mcpServerArtifactRelativePath(bundleId),
      content: content.startsWith("#!") ? content : `#!/usr/bin/env bun\n${content}`,
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
      naming: "plugin.mjs",
      sourcemap: "none",
      minify: false,
    });

    if (!build.success) {
      const diagnostics = build.logs.map((log) => log.message).join("\n");
      throw new Error(`failed to build Amp plugin bundle: ${diagnostics}`);
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
