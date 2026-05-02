import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Contract } from "./sources.js";
import type { ResolvedContractBinding } from "./resolve.js";
import { effectBundleImportPath } from "./runtime-deps.js";

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
  readonly serverName: string;
  readonly version?: string;
  readonly bundleId?: string;
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
}

export interface McpServerBundle {
  /** Stable path future harness lowerers can place inside their compiled artifact. */
  readonly relativePath: string;
  readonly content: string;
  readonly toolNames: ReadonlyArray<string>;
}

const SOURCE_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

const BARE_IMPORT_PATTERN =
  /(\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?|\bimport\s*\(\s*)(["'])([^"'.][^"']*)\2/g;

const NODE_BUILTIN_EXTERNALS = [
  ...new Set([
    ...builtinModules,
    ...builtinModules.map((moduleName) => `node:${moduleName}`),
    "bun:sqlite",
    "node:sqlite",
  ]),
].sort();

const normalizeRelativePath = (path: string): string => path.replace(/\\/g, "/");

const normalizeGeneratedPluginName = (pluginName: string): string => {
  const normalized = pluginName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : "plugin";
};

const sanitizeToolSegment = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

const toolNamespace = (pluginName: string): string =>
  sanitizeToolSegment(normalizeGeneratedPluginName(pluginName), "plugin");

const ownerToolName = (toolPluginName: string, toolName: string): string =>
  `${toolNamespace(toolPluginName)}_${sanitizeToolSegment(toolName, "tool")}`;

const syntheticToolName = (sourcePluginName: string, contractName: string): string =>
  `${toolNamespace(sourcePluginName)}_${sanitizeToolSegment(contractName, "tool")}`;

export const mcpToolNameForBinding = (
  sourcePluginName: string,
  binding: ResolvedContractBinding,
): string => {
  if (binding.kind === "permission") {
    return ownerToolName(binding.toolPluginName, binding.toolName);
  }
  if (!binding.contract) {
    throw new Error(`synthetic tool binding '${binding.logicalName}' is missing a contract`);
  }
  return syntheticToolName(sourcePluginName, binding.contract.name);
};

export const mcpServerArtifactRelativePath = (bundleId: string): string =>
  `mcp/${sanitizeToolSegment(bundleId, "tools")}/server.mjs`;

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
};

const resolveTsImportCandidate = async (
  absoluteWithoutQuery: string,
): Promise<string | undefined> => {
  const candidates = extname(absoluteWithoutQuery)
    ? [absoluteWithoutQuery]
    : [`${absoluteWithoutQuery}.ts`, join(absoluteWithoutQuery, "index.ts")];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
};

const sourceIsInside = (sourcePath: string, root: string): boolean => {
  const rel = relative(root, sourcePath);
  return rel.length === 0 || (!rel.startsWith("..") && !rel.startsWith("/"));
};

const collectRelativeImportSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  for (const match of source.matchAll(SOURCE_IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
};

const resolveMirrorImport = async (options: {
  readonly pluginRoot: string;
  readonly file: MirrorFile;
  readonly specifier: string;
}): Promise<MirrorFile | undefined> => {
  const basePath = options.file.sourcePath
    ? dirname(options.file.sourcePath)
    : dirname(join(options.pluginRoot, options.file.relativePath));
  const resolved = await resolveTsImportCandidate(resolve(basePath, options.specifier));
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

const collectMirrorsForBindings = async (
  bindings: ReadonlyArray<ResolvedContractBinding>,
): Promise<PluginMirror[]> => {
  const byPlugin = new Map<string, { pluginRoot: string; entries: Map<string, MirrorFile> }>();
  const generatedFiles = new Map<string, Map<string, string>>();

  const ensurePlugin = (pluginName: string, pluginRoot: string): Map<string, MirrorFile> => {
    const current = byPlugin.get(pluginName) ?? {
      pluginRoot,
      entries: new Map<string, MirrorFile>(),
    };
    byPlugin.set(pluginName, current);
    return current.entries;
  };

  const addGeneratedFiles = (contract: Contract): void => {
    if (!contract.generatedFiles || contract.generatedFiles.length === 0) return;
    const files = generatedFiles.get(contract.pluginName) ?? new Map<string, string>();
    for (const file of contract.generatedFiles) {
      const existing = files.get(file.relativePath);
      if (existing && existing !== file.content) {
        throw new Error(
          `generated contract name collision at ${contract.pluginName}:${file.relativePath}`,
        );
      }
      files.set(file.relativePath, file.content);
    }
    generatedFiles.set(contract.pluginName, files);
  };

  const addCrossPluginRuntimeClosures = async (): Promise<void> => {
    const pluginRoots = new Map(
      [...byPlugin.entries()].map(([pluginName, state]) => [pluginName, state.pluginRoot] as const),
    );
    const queue: Array<{ pluginName: string; file: MirrorFile }> = [];
    for (const [pluginName, state] of byPlugin) {
      for (const file of state.entries.values()) queue.push({ pluginName, file });
    }

    for (let index = 0; index < queue.length; index++) {
      const { pluginName, file } = queue[index]!;
      const state = byPlugin.get(pluginName);
      if (!state) continue;
      const source = file.content ?? (file.sourcePath ? await readFile(file.sourcePath, "utf8") : "");
      const basePath = file.sourcePath
        ? dirname(file.sourcePath)
        : dirname(join(state.pluginRoot, file.relativePath));

      for (const specifier of collectRelativeImportSpecifiers(source)) {
        const resolved = await resolveTsImportCandidate(resolve(basePath, specifier));
        if (!resolved) continue;
        const owner = findSourcePlugin(resolved, pluginRoots);
        if (!owner || owner.pluginName === pluginName) continue;

        const ownerState = byPlugin.get(owner.pluginName);
        if (!ownerState) continue;
        const relativePath = normalizeRelativePath(relative(owner.pluginRoot, resolved));
        if (ownerState.entries.has(relativePath)) continue;
        const imported: MirrorFile = { relativePath, sourcePath: resolved };
        ownerState.entries.set(relativePath, imported);
        queue.push({ pluginName: owner.pluginName, file: imported });
      }
    }
  };

  for (const binding of bindings) {
    const toolRoot = pluginRootFromToolSource(binding.toolSourcePath);
    ensurePlugin(binding.toolPluginName, toolRoot).set(`tools/${binding.toolName}.tool.ts`, {
      relativePath: `tools/${binding.toolName}.tool.ts`,
      sourcePath: binding.toolSourcePath,
    });

    if (binding.kind === "synthetic") {
      if (!binding.contract) {
        throw new Error(`synthetic tool binding '${binding.logicalName}' is missing a contract`);
      }
      ensurePlugin(binding.contract.pluginName, pluginRootFromContractSource(binding.contract.sourcePath));
      addGeneratedFiles(binding.contract);
    }
  }

  const mirrors: PluginMirror[] = [];
  for (const [pluginName, state] of byPlugin) {
    const generated = generatedFiles.get(pluginName);
    if (generated) {
      for (const [relativePath, content] of generated) {
        state.entries.set(relativePath, { relativePath, content });
      }
    }
  }

  for (const [, state] of byPlugin) {
    const samePluginClosure = await collectMirrorRuntimeClosure(
      state.pluginRoot,
      [...state.entries.values()],
    );
    state.entries.clear();
    for (const file of samePluginClosure) {
      state.entries.set(file.relativePath, file);
    }
  }

  await addCrossPluginRuntimeClosures();

  for (const [pluginName, state] of byPlugin) {
    mirrors.push({
      pluginName,
      pluginRoot: state.pluginRoot,
      files: await collectMirrorRuntimeClosure(state.pluginRoot, [...state.entries.values()]),
    });
  }

  for (const [pluginName, files] of generatedFiles) {
    if (mirrors.some((mirror) => mirror.pluginName === pluginName)) continue;
    mirrors.push({
      pluginName,
      files: [...files.entries()].map(([relativePath, content]) => ({ relativePath, content })),
    });
  }

  return mirrors.sort((left, right) => left.pluginName.localeCompare(right.pluginName));
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

const resolveImportedSourcePath = (sourcePath: string, source: string): string => {
  const absolute = resolve(dirname(sourcePath), source);
  if (extname(absolute)) return absolute;
  return `${absolute}.ts`;
};

const relativeModulePath = (fromFile: string, toFileWithoutExtension: string): string => {
  const fromDir = posix.dirname(fromFile);
  let rel = posix.relative(fromDir, toFileWithoutExtension);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
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

const stripToolAuthoringHelpers = (source: string): string =>
  source.replace(
    /^\s*import\s+\{([^}]+)\}\s+from\s+["'][^"']+["'];\s*\n/gm,
    (match, specifiers: string) => {
      const original = specifiers.split(",").map((specifier) => specifier.trim()).filter(Boolean);
      const kept = original.filter((specifier) => {
        const importedName = specifier.replace(/\s+as\s+.*$/u, "").trim();
        return importedName !== "defineTool" && importedName !== "schemaSlot";
      });
      if (kept.length === original.length) return match;
      return kept.length > 0 ? match.replace(`{${specifiers}}`, `{ ${kept.join(", ")} }`) : "";
    },
  );

const rewriteGeneratedPluginImportsForStandaloneBundle = (
  source: string,
  currentGeneratedPath: string,
): string =>
  source.replace(
    /(["'])\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/agentpkg-generated-[^"']+\/src\/plugins\/([^/]+)\/([^"']+)\1/g,
    (_match, quote: string, pluginName: string, modulePath: string) => {
      const targetGeneratedPath = `plugins/${pluginName}/${modulePath}`;
      return `${quote}${relativeModulePath(currentGeneratedPath, targetGeneratedPath)}${quote}`;
    },
  );

const rewriteBareEffectImportsForBundle = (source: string): string =>
  source.replace(/(\bfrom\s+)(["'])effect\2/g, `$1${JSON.stringify(effectBundleImportPath())}`);

const packageNameFromSpecifier = (specifier: string): string => {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }

  return specifier.split("/")[0] ?? specifier;
};

const readPluginRuntimeDependencies = async (pluginRoot?: string): Promise<ReadonlySet<string>> => {
  if (!pluginRoot) return new Set();

  try {
    const raw = await readFile(join(pluginRoot, "package.json"), "utf8");
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

const resolvePluginDependencyImport = async (options: {
  readonly pluginRoot?: string;
  readonly runtimeDependencies: ReadonlySet<string>;
  readonly specifier: string;
}): Promise<string | undefined> => {
  if (!options.pluginRoot) return undefined;
  if (options.specifier.startsWith("node:")) return undefined;

  const packageName = packageNameFromSpecifier(options.specifier);
  if (!options.runtimeDependencies.has(packageName)) return undefined;

  try {
    return createRequire(join(options.pluginRoot, "package.json")).resolve(options.specifier).replace(/\\/g, "/");
  } catch {
    return undefined;
  }
};

const rewriteBarePluginDependencyImportsForBundle = async (options: {
  readonly source: string;
  readonly pluginRoot?: string;
}): Promise<string> => {
  const runtimeDependencies = await readPluginRuntimeDependencies(options.pluginRoot);
  if (runtimeDependencies.size === 0) return options.source;

  const replacements = new Map<string, string>();
  for (const match of options.source.matchAll(BARE_IMPORT_PATTERN)) {
    const specifier = match[3];
    if (!specifier || specifier === "effect") continue;

    const resolved = await resolvePluginDependencyImport({
      pluginRoot: options.pluginRoot,
      runtimeDependencies,
      specifier,
    });
    if (resolved) replacements.set(specifier, resolved);
  }

  if (replacements.size === 0) return options.source;

  return options.source.replace(BARE_IMPORT_PATTERN, (match, prefix: string, quote: string, specifier: string) => {
    const replacement = replacements.get(specifier);
    return replacement ? `${prefix}${quote}${replacement}${quote}` : match;
  });
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
  const withStandaloneImports = rewriteGeneratedPluginImportsForStandaloneBundle(
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

const renderMcpServerEntry = (options: {
  readonly serverName: string;
  readonly version: string;
  readonly specs: ReadonlyArray<McpAdapterSpec>;
}): string => {
  const imports: string[] = [];
  const toolEntries: string[] = [];
  for (const [index, spec] of options.specs.entries()) {
    const ident = `surface_${index}_${safeIdentifier(spec.mcpName)}`;
    if (spec.kind === "tool") {
      imports.push(`import ${ident} from ${JSON.stringify(`./plugins/${spec.pluginName}/tools/${spec.toolName}.tool`)};`);
    } else {
      imports.push(`import * as ${ident} from ${JSON.stringify(`./plugins/${spec.pluginName}/${spec.contractRelativePath}`)};`);
    }
    toolEntries.push(`  ${JSON.stringify(spec.mcpName)}: createTool(${JSON.stringify(spec.mcpName)}, ${ident} as ToolSurface),`);
  }

  return `#!/usr/bin/env bun
// GENERATED by agentpkg — do not edit.
// Standalone MCP stdio server for compiled canonical tool bindings.

import { Schema, SchemaAST } from ${JSON.stringify(effectBundleImportPath())};
${imports.join("\n")}

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: any };
type JsonSchema = Record<string, any>;
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
}

const extractDescription = (ast: SchemaAST.AST): string | undefined => {
  const desc = SchemaAST.getAnnotation<string>(SchemaAST.DescriptionAnnotationId)(ast);
  return desc._tag === "Some" ? desc.value : undefined;
};

const extractTitle = (ast: SchemaAST.AST): string | undefined => {
  const title = SchemaAST.getAnnotation<string>(SchemaAST.TitleAnnotationId)(ast);
  return title._tag === "Some" ? title.value : undefined;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const unsupportedAst = (ast: SchemaAST.AST, detail?: string): never => {
  throw new Error(
    \`mcp-schema-bridge: unsupported AST tag: \${ast._tag}\${detail ? \` (\${detail})\` : ""}\`,
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
      unsupportedAst(ast, \`union members: \${ast.types.map((type) => type._tag).join(" | ")}\`);
    }
    case "TupleType": {
      if (ast.elements.length === 0 && ast.rest.length === 1) {
        return { type: "array", items: astToJsonSchema(ast.rest[0]!.type) };
      }
      unsupportedAst(ast, \`tuple elements=\${ast.elements.length}, rest=\${ast.rest.length}\`);
    }
    case "TypeLiteral": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const prop of ast.propertySignatures) {
        const property = astToJsonSchema(prop.type);
        const description = extractDescription(prop.type) ?? extractTitle(prop.type);
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
  Schema.decodeUnknownSync(schema)(raw);

const runtimeContext = (): ToolRuntimeContext => ({
  sessionID: process.env.AGENTPKG_MCP_SESSION_ID ?? "mcp-stdio",
  agent: process.env.AGENTPKG_MCP_AGENT ?? "mcp-client",
  timestamp: new Date().toISOString(),
  workingDirectory: process.cwd(),
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

  return {
    description: surface.description ?? "",
    inputSchema: inputJsonSchema,
    async call(rawArgs: unknown): Promise<string> {
      const input = decodeWithSchema(inputSchema as Schema.Schema<unknown, unknown, never>, rawArgs ?? {});
      const output = await surface.handle(input, runtimeContext());
      const validatedOutput = decodeWithSchema(outputSchema as Schema.Schema<unknown, unknown, never>, output);
      return JSON.stringify(validatedOutput, null, 2);
    },
  };
};

const tools = {
${toolEntries.join("\n")}
};

if (process.env.AGENTPKG_MCP_VALIDATE === "1") {
  process.exit(0);
}

const writeMessage = (message: unknown): void => {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(\`Content-Length: \${payload.byteLength}\\r\\n\\r\\n\`);
  process.stdout.write(payload);
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
        serverInfo: { name: ${JSON.stringify(options.serverName)}, version: ${JSON.stringify(options.version)} },
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
      process.exitCode = 0;
      return;
    default:
      rpcError(id, -32601, \`Method not found: \${message.method}\`);
  }
};

let buffer = Buffer.alloc(0);
const drainBuffer = (): void => {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
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
    try {
      void handleMessage(JSON.parse(body) as JsonRpcMessage);
    } catch (error) {
      rpcError(null, -32700, errorMessage(error));
    }
  }
};

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  drainBuffer();
});
process.stdin.resume();
`;
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
      env: { ...process.env, AGENTPKG_MCP_VALIDATE: "1" },
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

export const generateMcpServerBundle = async (
  options: McpServerBundleOptions,
): Promise<McpServerBundle> => {
  const version = options.version ?? "0.1.0";
  const bundleId = options.bundleId ?? normalizeGeneratedPluginName(options.sourcePluginName);
  const specs = adapterSpecsForBindings(options.sourcePluginName, options.bindings);
  const toolNames = specs.map((spec) => spec.mcpName);
  const mirrors = await collectMirrorsForBindings(options.bindings);
  const importPluginRoots = new Map<string, string>();
  for (const mirror of mirrors) {
    if (mirror.pluginRoot) importPluginRoots.set(mirror.pluginName, mirror.pluginRoot);
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "agentpkg-mcp-bundle-"));
  try {
    const entrySource = renderMcpServerEntry({
      serverName: options.serverName,
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
