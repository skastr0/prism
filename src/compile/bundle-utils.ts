import { readFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, extname, join, posix, resolve } from "node:path";
import { effectBundleImportPath } from "./runtime-deps.js";

export const NODE_BUILTIN_EXTERNALS = [
  ...new Set([
    ...builtinModules,
    ...builtinModules.map((moduleName) => `node:${moduleName}`),
    "bun:sqlite",
    "node:sqlite",
  ]),
].sort();

export const BARE_IMPORT_PATTERN =
  /(\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?|\bimport\s*\(\s*)(["'])([^"'.][^"']*)\2/g;

export const RELATIVE_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

export const collectRelativeImportSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  for (const match of source.matchAll(RELATIVE_IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
};

export const packageNameFromSpecifier = (specifier: string): string => {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }

  return specifier.split("/")[0] ?? specifier;
};

export const relativeModulePath = (
  fromFile: string,
  toFileWithoutExtension: string,
): string => {
  const fromDir = posix.dirname(fromFile);
  let rel = posix.relative(fromDir, toFileWithoutExtension);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
};

export const resolveImportedSourcePath = (sourcePath: string, source: string): string => {
  const absolute = resolve(dirname(sourcePath), source);
  if (extname(absolute)) return absolute;
  return `${absolute}.ts`;
};

export const stripToolAuthoringHelpers = (source: string): string =>
  source.replace(
    /^\s*import\s+\{([^}]+)\}\s+from\s+["'][^"']+["'];\s*\n/gm,
    (match, specifiers: string) => {
      const original = specifiers
        .split(",")
        .map((specifier) => specifier.trim())
        .filter(Boolean);
      const kept = original.filter((specifier) => {
        const importedName = specifier.replace(/\s+as\s+.*$/u, "").trim();
        return importedName !== "defineTool" && importedName !== "schemaSlot";
      });
      if (kept.length === original.length) return match;
      return kept.length > 0 ? match.replace(`{${specifiers}}`, `{ ${kept.join(", ")} }`) : "";
    },
  );

export const resolveTsImportCandidate = async (
  absoluteWithoutQuery: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<string | undefined> => {
  const candidates = extname(absoluteWithoutQuery)
    ? [absoluteWithoutQuery]
    : [`${absoluteWithoutQuery}.ts`, join(absoluteWithoutQuery, "index.ts")];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
};

export const rewriteBareImportsForBundle = (
  source: string,
  replacements: ReadonlyMap<string, string>,
): string => {
  if (replacements.size === 0) return source;
  return source.replace(
    BARE_IMPORT_PATTERN,
    (match, prefix: string, quote: string, specifier: string) => {
      const replacement = replacements.get(specifier);
      return replacement ? `${prefix}${quote}${replacement}${quote}` : match;
    },
  );
};

export const rewriteBareEffectImportsForBundle = (source: string): string =>
  rewriteBareImportsForBundle(
    source,
    new Map([["effect", effectBundleImportPath()]]),
  );

const readPluginRuntimeDependencies = async (
  pluginRoot?: string,
): Promise<ReadonlySet<string>> => {
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
    return createRequire(join(options.pluginRoot, "package.json"))
      .resolve(options.specifier)
      .replace(/\\/g, "/");
  } catch {
    return undefined;
  }
};

export const rewriteBarePluginDependencyImportsForBundle = async (options: {
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

  return rewriteBareImportsForBundle(options.source, replacements);
};
