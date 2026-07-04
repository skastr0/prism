import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathContains } from "../fs.js";

const normalizeImportPath = (path: string): string => path.replace(/\\/g, "/");

interface PackageSpecifierParts {
  readonly packageName: string;
  readonly subpath: string;
}

interface RuntimePackageResolution {
  readonly path?: string;
  readonly attemptedPackagePaths: readonly string[];
  readonly checkedRuntimeRoots: readonly string[];
}

interface PackageJson {
  readonly main?: string;
  readonly module?: string;
  readonly exports?: unknown;
}

const warnedRuntimeDependencyFallbacks = new Set<string>();

const packageRootFromExecutable = (): string | undefined => {
  if (typeof process.execPath !== "string" || process.execPath.length === 0) {
    return undefined;
  }

  return dirname(dirname(process.execPath));
};

const runtimePackageRoots = (): string[] => {
  const roots = new Set<string>();
  const overrideRoot = process.env.PRISM_RUNTIME_DEPS_PACKAGE_ROOT;

  if (typeof overrideRoot === "string" && overrideRoot.trim().length > 0) {
    roots.add(overrideRoot);
  }

  const executableRoot = packageRootFromExecutable();
  if (executableRoot) {
    roots.add(executableRoot);
  }

  return Array.from(roots);
};

const parsePackageSpecifier = (specifier: string): PackageSpecifierParts => {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subpath: parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".",
    };
  }

  return {
    packageName: parts[0] ?? specifier,
    subpath: parts.length > 1 ? `./${parts.slice(1).join("/")}` : ".",
  };
};

const packageRootsForResolution = (root: string, packageName: string): string[] => {
  const roots: string[] = [];
  let current = root;

  while (true) {
    roots.push(join(current, "node_modules", packageName));
    if (current.endsWith(`${join("node_modules")}`) || current.endsWith("/node_modules")) {
      roots.push(join(current, packageName));
    }

    const parent = dirname(current);
    if (parent === current) {
      return roots;
    }
    current = parent;
  }
};

const readPackageJson = (packageRoot: string): PackageJson | undefined => {
  try {
    return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const resolveExistingPath = (path: string): string | undefined => {
  const candidates = [
    path,
    `${path}.js`,
    `${path}.mjs`,
    `${path}.cjs`,
    join(path, "index.js"),
    join(path, "index.mjs"),
    join(path, "index.cjs"),
  ];

  return candidates.find((candidate) => isFile(candidate));
};

const resolvePackageTarget = (packageRoot: string, target: string): string | undefined => {
  const resolved = resolveExistingPath(join(packageRoot, target));
  if (!resolved || !pathContains(packageRoot, resolved)) {
    return undefined;
  }
  return resolved;
};

const resolveExportValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const candidate of value) {
      const resolved = resolveExportValue(candidate);
      if (resolved) return resolved;
    }
    return undefined;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const condition of ["import", "module", "default", "node", "require"]) {
      const resolved = resolveExportValue(record[condition]);
      if (resolved) return resolved;
    }
  }

  return undefined;
};

const resolvePackageExport = (
  packageRoot: string,
  packageJson: PackageJson,
  subpath: string,
): string | undefined => {
  const exports = packageJson.exports;

  if (exports !== undefined) {
    if (typeof exports === "string" || Array.isArray(exports)) {
      if (subpath === ".") {
        const target = resolveExportValue(exports);
        if (target) return resolvePackageTarget(packageRoot, target);
      }
      return undefined;
    }

    if (exports && typeof exports === "object") {
      const record = exports as Record<string, unknown>;
      const target = resolveExportValue(record[subpath] ?? (subpath === "." ? record : undefined));
      if (target) return resolvePackageTarget(packageRoot, target);

      for (const [pattern, value] of Object.entries(record)) {
        if (!pattern.includes("*")) continue;
        const parts = pattern.split("*", 2);
        const prefix = parts[0] ?? "";
        const suffix = parts[1] ?? "";
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
        const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
        const patternTarget = resolveExportValue(value);
        if (!patternTarget) continue;
        const resolved = resolvePackageTarget(packageRoot, patternTarget.replaceAll("*", matched));
        if (resolved) return resolved;
      }
    }
  }

  if (subpath !== ".") {
    return resolvePackageTarget(packageRoot, subpath.slice(2));
  }

  if (packageJson.module) {
    const resolved = resolvePackageTarget(packageRoot, packageJson.module);
    if (resolved) return resolved;
  }

  if (packageJson.main) {
    const resolved = resolvePackageTarget(packageRoot, packageJson.main);
    if (resolved) return resolved;
  }

  return resolvePackageTarget(packageRoot, "index");
};

const resolveFromPackageRootFilesystem = (
  root: string,
  specifier: string,
): string | undefined => {
  const { packageName, subpath } = parsePackageSpecifier(specifier);

  for (const packageRoot of packageRootsForResolution(root, packageName)) {
    const packageJson = readPackageJson(packageRoot);
    if (!packageJson) continue;

    const resolved = resolvePackageExport(packageRoot, packageJson, subpath);
    if (resolved) {
      return normalizeImportPath(resolved);
    }
  }

  return undefined;
};

const resolveFromPackageRoot = (root: string, specifier: string): string | undefined => {
  const packageJson = join(root, "package.json");

  if (!existsSync(packageJson)) {
    return undefined;
  }

  const filesystemResolved = resolveFromPackageRootFilesystem(root, specifier);
  if (filesystemResolved) {
    return filesystemResolved;
  }

  try {
    return normalizeImportPath(Bun.resolveSync(specifier, root));
  } catch {
    // Fall through to Node's resolver for runtimes where Bun cannot resolve the package root.
  }

  try {
    return normalizeImportPath(createRequire(packageJson).resolve(specifier));
  } catch {
    return undefined;
  }
};

const resolveRuntimePackageImportPath = (specifier: string): RuntimePackageResolution => {
  const { packageName } = parsePackageSpecifier(specifier);
  const attemptedPackagePaths: string[] = [];
  const checkedRuntimeRoots: string[] = [];

  for (const root of runtimePackageRoots()) {
    if (!existsSync(join(root, "package.json"))) {
      continue;
    }

    checkedRuntimeRoots.push(root);
    attemptedPackagePaths.push(...packageRootsForResolution(root, packageName));

    const resolved = resolveFromPackageRoot(root, specifier);
    if (resolved) {
      return { path: resolved, attemptedPackagePaths, checkedRuntimeRoots };
    }
  }

  return { attemptedPackagePaths, checkedRuntimeRoots };
};

const warnRuntimeDependencyFallback = (
  specifier: string,
  runtimeResolution: RuntimePackageResolution,
  fallbackPath: string,
): void => {
  if (runtimeResolution.checkedRuntimeRoots.length === 0) return;

  const runtimePaths = runtimeResolution.attemptedPackagePaths.length > 0
    ? runtimeResolution.attemptedPackagePaths.map(normalizeImportPath).join(", ")
    : runtimeResolution.checkedRuntimeRoots.map(normalizeImportPath).join(", ");
  const normalizedFallback = normalizeImportPath(fallbackPath);
  const warningKey = `${specifier}\0${runtimePaths}\0${normalizedFallback}`;
  if (warnedRuntimeDependencyFallbacks.has(warningKey)) return;
  warnedRuntimeDependencyFallbacks.add(warningKey);

  console.warn(
    `warning: runtime dependency ${specifier} resolved via source fallback ${normalizedFallback} ` +
      `after runtime package lookup failed from ${runtimePaths}`,
  );
};

const resolveBundleImportPath = (specifier: string): string => {
  const runtimePackage = resolveRuntimePackageImportPath(specifier);
  if (runtimePackage.path) {
    return runtimePackage.path;
  }

  try {
    const fallbackPath = normalizeImportPath(fileURLToPath(import.meta.resolve(specifier)));
    warnRuntimeDependencyFallback(specifier, runtimePackage, fallbackPath);
    return fallbackPath;
  } catch (error) {
    throw new Error(`Unable to resolve runtime dependency ${specifier}`, { cause: error });
  }
};

export const effectBundleImportPath = (): string => resolveBundleImportPath("effect");

export const mcpSdkMcpBundleImportPath = (): string =>
  resolveBundleImportPath("@modelcontextprotocol/sdk/server/mcp.js");

export const mcpSdkWebStandardHttpBundleImportPath = (): string =>
  resolveBundleImportPath("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");

export const mcpSdkStdioBundleImportPath = (): string =>
  resolveBundleImportPath("@modelcontextprotocol/sdk/server/stdio.js");

export const opencodePluginBundleImportPath = (): string =>
  resolveBundleImportPath("@opencode-ai/plugin");

export const typescriptBundleImportPath = (): string => resolveBundleImportPath("typescript");

export const zodV4BundleImportPath = (): string => resolveBundleImportPath("zod/v4");

export const udsRegistryBundleImportPath = (): string => {
  // The registry is an internal MCP module in prism-core
  // Resolve it from the source tree using import.meta.resolve
  try {
    return normalizeImportPath(fileURLToPath(import.meta.resolve("../../packages/prism-core/src/mcp/uds-registry.js")));
  } catch (error) {
    throw new Error("Unable to resolve uds-registry module", { cause: error });
  }
};
