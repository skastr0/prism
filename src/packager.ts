import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { computeContentHash } from "./content-hash.js";
import {
  exists,
  expandPath,
  listDirRecursive,
  readFile,
  removeFile,
  writeFile,
} from "./fs.js";
import { renderPrismCause } from "./errors.js";
import { readManifest } from "./manifest.js";
import { normalizeGeneratedPluginName } from "./compile/generated-plugin.js";
import {
  planPluginForTarget,
  type CompileMcpLifecycleMode,
} from "./compile/pipeline.js";
import type { DesiredFile, DesiredRegion } from "./sync/desired.js";
import { readPrismProjectConfig } from "./project-config.js";
import type { HarnessId, HarnessScope } from "./types.js";

export interface PackageTargetOptions {
  readonly pluginPath: string;
  readonly target: HarnessId;
  readonly scope?: HarnessScope;
  readonly projectPath?: string;
  readonly out?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly generatorVersion?: string;
}

export interface PackageTargetsOptions extends Omit<PackageTargetOptions, "target"> {
  readonly targets: readonly HarnessId[];
}

export interface PackageWriteOperation {
  readonly type: "write" | "skip" | "prune" | "drift";
  readonly path: string;
  readonly reason: string;
}

export interface PackageResult {
  readonly target: HarnessId;
  readonly packageId: string;
  readonly packageRoot: string;
  readonly planRoot: string;
  readonly activationPath: string;
  readonly manifestPath: string;
  readonly operations: ReadonlyArray<PackageWriteOperation>;
  readonly compileFiles: ReadonlyArray<DesiredFile>;
  readonly compileRegions: ReadonlyArray<DesiredRegion>;
}

interface DesiredPackageFile {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
  readonly role: "payload" | "activation" | "manifest";
}

interface PreviousPackageManifest {
  readonly version?: number;
  readonly manifestHash?: string;
  readonly contentHash?: string;
  readonly files?: ReadonlyArray<{ readonly path?: string; readonly hash?: string }>;
}

const PACKAGE_MANIFEST = ".prism-package.json";
const ACTIVATION_MANIFEST = "prism.activation.json";
const PAYLOAD_ROOT = "payload";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const packageIdForPlugin = (pluginName: string): string =>
  `prism-generated-${normalizeGeneratedPluginName(pluginName)}`;

const normalizeRelativePath = (path: string): string => path.split(sep).join("/");

const relativePathInsideRoot = (root: string, target: string): string | undefined => {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  return normalizeRelativePath(rel);
};

const renderJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const manifestWithIntegrityHash = (
  body: Record<string, unknown>,
): Record<string, unknown> => ({
  ...body,
  manifestHash: computeContentHash(renderJson(body)),
});

const normalizeManifestFilePath = (path: string): string | undefined => {
  if (path.length === 0 || isAbsolute(path) || path.includes("\\")) return undefined;
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return undefined;
  }
  return parts.join("/");
};

const validatePreviousManifestFiles = (
  manifest: PreviousPackageManifest,
): PreviousPackageManifest => {
  const seen = new Set<string>();
  for (const [index, entry] of (manifest.files ?? []).entries()) {
    if (typeof entry.path !== "string" || typeof entry.hash !== "string") {
      throw new Error(`files[${index}] must include string path and hash`);
    }
    const normalizedPath = normalizeManifestFilePath(entry.path);
    if (!normalizedPath || normalizedPath !== entry.path || entry.path === PACKAGE_MANIFEST) {
      throw new Error(`files[${index}].path is not a safe package-relative path`);
    }
    if (seen.has(entry.path)) {
      throw new Error(`files[${index}].path duplicates another package file`);
    }
    seen.add(entry.path);
  }
  return manifest;
};

const activationRegionEntry = (
  region: DesiredRegion,
  planRoot: string,
): Record<string, unknown> => ({
  ...region,
  targetPath: relativePathInsideRoot(planRoot, region.targetPath) ?? region.targetPath,
});

const plannedPackagePaths = async (options: PackageTargetOptions): Promise<{
  readonly pluginPath: string;
  readonly packageId: string;
  readonly packageRoot: string;
  readonly planRoot: string;
}> => {
  const pluginPath = expandPath(options.pluginPath);
  const manifest = await readManifest(pluginPath);
  const projectConfig = await readPrismProjectConfig(options.projectPath ?? pluginPath);
  const targetConfig = projectConfig.distribution.packages[options.target] ?? {};
  const packageId = targetConfig.packageId ?? packageIdForPlugin(manifest.name);
  const baseOutDir = options.out ? expandPath(options.out) : projectConfig.distribution.outDir;
  const packageRoot = targetConfig.path
    ? (isAbsolute(targetConfig.path)
      ? targetConfig.path
      : resolve(projectConfig.root, targetConfig.path))
    : join(baseOutDir, options.target, packageId);

  return {
    pluginPath,
    packageId,
    packageRoot,
    planRoot: join(packageRoot, ".prism-plan-root"),
  };
};

const buildDesiredFiles = (options: {
  readonly planned: Awaited<ReturnType<typeof plannedPackagePaths>>;
  readonly target: HarnessId;
  readonly scope: HarnessScope;
  readonly generatorVersion: string;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
  readonly compileFiles: ReadonlyArray<DesiredFile>;
  readonly compileRegions: ReadonlyArray<DesiredRegion>;
}): Map<string, DesiredPackageFile> => {
  const desired = new Map<string, DesiredPackageFile>();
  const copiedFiles: Array<{ source: string; target: string; mode?: number }> = [];
  const activation: Record<string, unknown>[] = [];

  for (const file of options.compileFiles) {
    const target = relativePathInsideRoot(options.planned.planRoot, file.targetPath);
    if (!target) continue;
    const packagePath = `${PAYLOAD_ROOT}/${target}`;
    desired.set(packagePath, {
      path: packagePath,
      content: file.content,
      mode: file.mode,
      role: "payload",
    });
    copiedFiles.push({
      source: packagePath,
      target,
      ...(file.mode !== undefined ? { mode: file.mode } : {}),
    });
  }

  for (const region of options.compileRegions) {
    activation.push(activationRegionEntry(region, options.planned.planRoot));
  }

  const activationContent = renderJson({
    version: 1,
    sourcePlugin: {
      name: options.sourcePluginName,
      ...(options.sourcePluginVersion ? { version: options.sourcePluginVersion } : {}),
    },
    target: {
      harness: options.target,
      scope: options.scope,
    },
    package: {
      id: options.planned.packageId,
      payloadRoot: PAYLOAD_ROOT,
    },
    files: copiedFiles,
    activation,
    note: "Package mode does not mutate live harness configuration. Apply activation entries explicitly for the target harness.",
  });

  desired.set(ACTIVATION_MANIFEST, {
    path: ACTIVATION_MANIFEST,
    content: activationContent,
    role: "activation",
  });

  const manifestBody = {
    version: 1,
    generator: {
      name: "prism",
      version: options.generatorVersion,
    },
    sourcePlugin: {
      name: options.sourcePluginName,
      ...(options.sourcePluginVersion ? { version: options.sourcePluginVersion } : {}),
    },
    target: {
      harness: options.target,
      scope: options.scope,
    },
    package: {
      id: options.planned.packageId,
      payloadRoot: PAYLOAD_ROOT,
    },
    files: [...desired.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        path: file.path,
        role: file.role,
        hash: computeContentHash(file.content),
      })),
  };

  desired.set(PACKAGE_MANIFEST, {
    path: PACKAGE_MANIFEST,
    content: renderJson(manifestWithIntegrityHash(manifestBody)),
    role: "manifest",
  });

  return desired;
};

const readPreviousManifest = async (
  packageRoot: string,
  force: boolean,
): Promise<PreviousPackageManifest | undefined> => {
  const path = join(packageRoot, PACKAGE_MANIFEST);
  if (!(await exists(path))) return undefined;
  try {
    const content = await readFile(path);
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) throw new Error("manifest must be a JSON object");

    const { manifestHash, ...body } = parsed;
    if (typeof manifestHash !== "string") {
      throw new Error("manifestHash is missing");
    }

    const expectedManifestHash = computeContentHash(renderJson(body));
    if (manifestHash !== expectedManifestHash) {
      throw new Error("manifestHash does not match manifest body");
    }

    return validatePreviousManifestFiles({
      ...(parsed as PreviousPackageManifest),
      contentHash: computeContentHash(renderJson({ ...body, manifestHash })),
    });
  } catch (error) {
    if (force) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Package manifest is invalid: ${path}: ${message}`);
  }
};

const assertPackageRootIsWritable = async (
  packageRoot: string,
  previous: PreviousPackageManifest | undefined,
  force: boolean,
): Promise<void> => {
  if (previous || force || !(await exists(packageRoot))) return;
  const files = await listDirRecursive(packageRoot);
  if (files.length === 0) return;
  throw new Error(
    `Package output root exists but is not owned by Prism: ${packageRoot}. Use --force to write into it.`,
  );
};

const previousFileHashes = (
  previous: PreviousPackageManifest | undefined,
): Map<string, string> => {
  const entries = (previous?.files ?? [])
    .filter((entry): entry is { readonly path: string; readonly hash: string } =>
      typeof entry.path === "string" && typeof entry.hash === "string"
    )
    .map((entry) => [entry.path, entry.hash] as const);
  if (previous?.contentHash) entries.push([PACKAGE_MANIFEST, previous.contentHash]);
  return new Map(entries);
};

const planAndWriteFiles = async (options: {
  readonly packageRoot: string;
  readonly desired: ReadonlyMap<string, DesiredPackageFile>;
  readonly previous: PreviousPackageManifest | undefined;
  readonly dryRun: boolean;
  readonly force: boolean;
}): Promise<PackageWriteOperation[]> => {
  const operations: PackageWriteOperation[] = [];
  const previousHashes = previousFileHashes(options.previous);
  const ownedOrDesiredPaths = new Set([...previousHashes.keys(), ...options.desired.keys()]);

  for (const path of (await listDirRecursive(options.packageRoot)).sort()) {
    const normalizedPath = normalizeRelativePath(path);
    if (ownedOrDesiredPaths.has(normalizedPath)) continue;
    const absolutePath = join(options.packageRoot, normalizedPath);
    if (!options.force) {
      operations.push({ type: "drift", path: absolutePath, reason: "unowned file exists" });
      continue;
    }
    operations.push({ type: "prune", path: absolutePath, reason: "unowned file" });
  }

  for (const [path, previousHash] of [...previousHashes.entries()].sort()) {
    if (options.desired.has(path)) continue;
    const absolutePath = join(options.packageRoot, path);
    if (!(await exists(absolutePath))) continue;
    const currentHash = computeContentHash(await readFile(absolutePath));
    if (!options.force && currentHash !== previousHash) {
      operations.push({ type: "drift", path: absolutePath, reason: "managed file changed" });
      continue;
    }
    operations.push({ type: "prune", path: absolutePath, reason: "stale managed file" });
  }

  for (const file of [...options.desired.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const absolutePath = join(options.packageRoot, file.path);
    const desiredHash = computeContentHash(file.content);
    const previousHash = previousHashes.get(file.path);
    if (await exists(absolutePath)) {
      const current = await readFile(absolutePath);
      const currentHash = computeContentHash(current);
      if (!options.force && options.previous && previousHash === undefined) {
        operations.push({ type: "drift", path: absolutePath, reason: "unowned file exists" });
        continue;
      }
      if (currentHash === desiredHash) {
        operations.push({ type: "skip", path: absolutePath, reason: "unchanged" });
        continue;
      }
      if (!options.force && previousHash !== undefined && currentHash !== previousHash) {
        operations.push({ type: "drift", path: absolutePath, reason: "managed file changed" });
        continue;
      }
      if (!options.force && previousHash === undefined) {
        operations.push({ type: "drift", path: absolutePath, reason: "unowned file exists" });
        continue;
      }
    }

    operations.push({ type: "write", path: absolutePath, reason: "generated" });
  }

  const drift = operations.find((operation) => operation.type === "drift");
  if (drift) {
    throw new Error(`Refusing to overwrite package output: ${drift.path} (${drift.reason})`);
  }

  if (!options.dryRun) {
    for (const operation of operations) {
      if (operation.type === "prune") {
        await removeFile(operation.path);
      }
      if (operation.type === "write") {
        const relativePath = relativePathInsideRoot(options.packageRoot, operation.path);
        const file = relativePath ? options.desired.get(relativePath) : undefined;
        if (!file) continue;
        await writeFile(operation.path, file.content, { mode: file.mode });
      }
    }
  }

  return operations;
};

export const packagePluginForTarget = async (
  options: PackageTargetOptions,
): Promise<PackageResult> => {
  const scope = options.scope ?? "global";
  const generatorVersion = options.generatorVersion ?? "0.0.0-dev";
  const plannedPaths = await plannedPackagePaths(options);
  const compileExit = await Effect.runPromiseExit(
    planPluginForTarget({
      pluginPath: plannedPaths.pluginPath,
      target: options.target,
      scope,
      projectPath: options.projectPath,
      root: plannedPaths.planRoot,
      // Package mode never touches PRISM_HOME (the MCP bundle ships inside
      // the package payload); the plan root doubles as an inert home.
      prismHome: plannedPaths.planRoot,
      dryRun: true,
      mcpLifecycle: "none" satisfies CompileMcpLifecycleMode,
      packageMode: true,
    }),
  );

  if (compileExit._tag === "Failure") {
    throw new Error(renderPrismCause(compileExit.cause));
  }

  const desired = buildDesiredFiles({
    planned: plannedPaths,
    target: options.target,
    scope,
    generatorVersion,
    sourcePluginName: compileExit.value.sourcePluginName,
    sourcePluginVersion: compileExit.value.sourcePluginVersion,
    compileFiles: compileExit.value.files,
    compileRegions: compileExit.value.regions,
  });
  const previous = await readPreviousManifest(
    plannedPaths.packageRoot,
    options.force === true,
  );
  await assertPackageRootIsWritable(
    plannedPaths.packageRoot,
    previous,
    options.force === true,
  );
  const operations = await planAndWriteFiles({
    packageRoot: plannedPaths.packageRoot,
    desired,
    previous,
    dryRun: options.dryRun === true,
    force: options.force === true,
  });

  return {
    target: options.target,
    packageId: plannedPaths.packageId,
    packageRoot: plannedPaths.packageRoot,
    planRoot: plannedPaths.planRoot,
    activationPath: join(plannedPaths.packageRoot, ACTIVATION_MANIFEST),
    manifestPath: join(plannedPaths.packageRoot, PACKAGE_MANIFEST),
    operations,
    compileFiles: compileExit.value.files,
    compileRegions: compileExit.value.regions,
  };
};

export const packagePluginForTargets = async (
  options: PackageTargetsOptions,
): Promise<PackageResult[]> => {
  const results: PackageResult[] = [];
  for (const target of options.targets) {
    results.push(await packagePluginForTarget({ ...options, target }));
  }
  return results;
};

export const formatPackageOperations = (
  operations: ReadonlyArray<PackageWriteOperation>,
): string =>
  operations
    .map((operation) => `${operation.type.padEnd(6)} ${operation.path} (${operation.reason})`)
    .join("\n");
