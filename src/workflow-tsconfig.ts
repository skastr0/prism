/**
 * Generate the Prism-owned authoring tsconfig for workflow .ts files.
 *
 * The generated tsconfig maps the three virtual specifiers a workflow author
 * uses to their shipped type declarations:
 *
 *   "prism"      → <platform-package>/types/index.d.ts  (the emitted prism.d.ts)
 *   "prism/refs" → ~/.prism/state/projects/<key>/generated/agents.ts  (per-project refs)
 *   "effect"     → <platform-package>/node_modules/effect/dist/dts/index.d.ts
 *
 * Resolution strategy:
 *
 * When the Prism binary is installed, the platform package sits beside the
 * binary: `dirname(dirname(process.execPath))`. During development (source
 * checkout) the shipped declarations live inside the matching
 * packages/npm/prism-<platform>/types directory (populated by build:npm), with
 * the repo's node_modules/effect and dist/dts-tmp/ as further fallbacks — so
 * the type surface resolves without an install.
 *
 * The resolved type dirs (resolveWorkflowTypeDirs) and path builder
 * (buildWorkflowPaths) are shared with the in-process typecheck in
 * workflow-loader, which constructs compilerOptions in-memory rather than
 * relying solely on the on-disk tsconfig.
 *
 * The generated tsconfig is written to prismHome/state/tsconfig.workflow.json.
 * This file is Prism-owned and must never be committed to the user's project.
 */

import { existsSync, realpathSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Platform package root resolution
// ---------------------------------------------------------------------------

/**
 * Candidate platform-package directory names, most-specific first. During a
 * source checkout the shipped declarations live inside the matching platform
 * package under packages/npm/. We probe the host's platform/arch package first,
 * then fall through to the rest so a non-darwin-arm64 dev box still resolves.
 *
 * Defined before the binary-root heuristic so it can be called from there.
 */
const platformPackageDirNames = (): readonly string[] => {
  const host = `prism-${process.platform}-${process.arch}`;
  const all = [
    "prism-darwin-arm64",
    "prism-darwin-x64",
    "prism-linux-arm64",
    "prism-linux-x64",
  ];
  return [host, ...all.filter((name) => name !== host)];
};

/**
 * Attempt to resolve the Prism platform package root from the running binary.
 *
 * Two layouts are supported:
 *
 *   1. npm-installed binary: `<package-root>/bin/prism`
 *      Two dirname() calls reach `<package-root>`, which contains `types/`.
 *
 *   2. Dev symlink (dist/prism-<platform>):
 *      Two dirname() calls reach the repo root, which does NOT have `types/`
 *      at the top level but does have `packages/npm/prism-<platform>/types/`.
 *      We detect this case by checking for a `packages/npm` subdirectory and
 *      fall through to the per-platform package under it.
 *
 * Returns the platform package root directory (the one that contains `types/`)
 * when it can be located, or `undefined` otherwise.
 */
const platformPackageRootFromBinary = (): string | undefined => {
  if (typeof process.execPath !== "string" || process.execPath.length === 0) {
    return undefined;
  }
  // In a compiled Bun binary process.execPath is the real binary path (not a
  // virtual $bunfs path), so we can safely navigate from it. Resolve symlinks
  // first: dev installs often link the binary into a directory like ~/.local/bin,
  // and navigation from the symlink path would otherwise miss the package root.
  let binaryPath: string;
  try {
    binaryPath = realpathSync(process.execPath);
  } catch {
    binaryPath = process.execPath;
  }
  const binaryDir = dirname(binaryPath);
  const candidate = dirname(binaryDir);

  if (!existsSync(join(candidate, "package.json"))) {
    return undefined;
  }

  // Case 1: npm-installed binary — <package-root>/bin/prism.
  // The package root itself has types/.
  if (existsSync(join(candidate, "types", "index.d.ts"))) {
    return candidate;
  }

  // Case 2: dev binary layout — <repo-root>/dist/prism-<platform>.
  // The repo root has packages/npm/<platform-name>/types/index.d.ts.
  if (existsSync(join(candidate, "packages", "npm"))) {
    for (const name of platformPackageDirNames()) {
      const pkgRoot = join(candidate, "packages", "npm", name);
      if (existsSync(join(pkgRoot, "types", "index.d.ts"))) {
        return pkgRoot;
      }
    }
  }

  return undefined;
};

/**
 * Resolve the repo root from the source checkout (development fallback used
 * only when the binary-path heuristic cannot locate the platform package).
 *
 * NOTE: `import.meta.url` in a compiled Bun binary resolves to a virtual
 * `$bunfs` path, not the real binary path — it cannot be used for filesystem
 * navigation. `process.execPath` is always the real path and is preferred here.
 */
const platformPackageRootFromSource = (): string | undefined => {
  // Try process.execPath first (reliable in compiled Bun binaries). Resolve
  // symlinks so dev-symlinked binaries still navigate to the real package/repo
  // root.
  if (typeof process.execPath === "string" && process.execPath.length > 0) {
    let binaryPath: string;
    try {
      binaryPath = realpathSync(process.execPath);
    } catch {
      binaryPath = process.execPath;
    }
    const candidate = dirname(dirname(binaryPath));
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  // Fall back to import.meta.url for source-run (bun src/cli.ts) scenarios
  // where the module file is a real on-disk .ts path.
  try {
    const selfPath = fileURLToPath(import.meta.url);
    // Only trust this path when it resolves to a real on-disk location
    // (i.e. not a $bunfs virtual path from a compiled binary).
    if (!selfPath.startsWith("/$bunfs")) {
      const srcDir = dirname(selfPath);
      const repoRoot = dirname(srcDir);
      return repoRoot;
    }
  } catch {
    // Ignore; the process.execPath path above is the primary branch.
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Locate shipped declarations and effect types
// ---------------------------------------------------------------------------

/**
 * Find the prism.d.ts directory. Resolution order:
 *   1. Binary heuristic: platformPackageRootFromBinary() returns the platform
 *      package root (handles both npm-installed and dev-symlink layouts).
 *      Check <pkg-root>/types/index.d.ts.
 *   2. Source-checkout fallback: the freshly-emitted dist/dts-tmp/.
 *
 * Returns undefined when none resolve — callers then warn + proceed rather than
 * pointing "prism" at a nonexistent file (which would surface as a misleading
 * "Cannot find module 'prism'" type error on every valid workflow).
 */
const resolvePrismTypesDir = (): string | undefined => {
  // 1. Platform package root (npm-installed or dev-symlink via binary heuristic).
  const pkgRoot = platformPackageRootFromBinary();
  if (pkgRoot) {
    const candidate = join(pkgRoot, "types");
    if (existsSync(join(candidate, "index.d.ts"))) {
      return candidate;
    }
  }

  // 2. Source-checkout fallback: the freshly-emitted dist/dts-tmp/.
  const repoRoot = platformPackageRootFromSource();
  if (repoRoot) {
    const tmp = join(repoRoot, "dist", "dts-tmp");
    if (existsSync(join(tmp, "index.d.ts"))) {
      return tmp;
    }

    // 3. Source-checkout fallback: pre-built platform package types under
    // packages/npm/. This covers `bun run src/cli.ts` workflows when the
    // lightweight build:cli target has not yet emitted dist/dts-tmp/.
    if (existsSync(join(repoRoot, "packages", "npm"))) {
      for (const name of platformPackageDirNames()) {
        const candidate = join(repoRoot, "packages", "npm", name, "types");
        if (existsSync(join(candidate, "index.d.ts"))) {
          return candidate;
        }
      }
    }
  }

  return undefined;
};

/**
 * Resolve effect's dist/dts directory via real node resolution from a root that
 * owns effect as a dependency. This handles npm's dependency HOISTING: when the
 * platform package is npm-installed, `effect` is lifted to a parent
 * node_modules rather than nested under the platform package, so a fixed
 * `<root>/node_modules/effect` path misses it. `require.resolve` walks the
 * node_modules chain and finds it wherever it landed.
 */
const effectDtsViaResolution = (fromRoot: string | undefined): string | undefined => {
  if (!fromRoot || !existsSync(join(fromRoot, "package.json"))) return undefined;
  try {
    const requireFrom = createRequire(join(fromRoot, "package.json"));
    const candidate = join(dirname(requireFrom.resolve("effect/package.json")), "dist", "dts");
    if (existsSync(join(candidate, "index.d.ts"))) return candidate;
  } catch {
    // effect not resolvable from this root
  }
  return undefined;
};

/**
 * Find the shipped effect .d.ts directory (node_modules/effect/dist/dts/).
 * Tries, in order, the runtime-deps root the wrapper points the binary at, the
 * platform package root (installed binary), and the repo root (source checkout).
 * For each it checks the directly-nested layout first, then falls back to node
 * resolution to cover the hoisted layout npm produces on install.
 */
const resolveEffectDtsDir = (): string | undefined => {
  const roots: ReadonlyArray<string | undefined> = [
    process.env.PRISM_RUNTIME_DEPS_PACKAGE_ROOT,
    platformPackageRootFromBinary(),
    platformPackageRootFromSource(),
  ];
  for (const root of roots) {
    if (!root) continue;
    const nested = join(root, "node_modules", "effect", "dist", "dts");
    if (existsSync(join(nested, "index.d.ts"))) return nested;
    const resolved = effectDtsViaResolution(root);
    if (resolved) return resolved;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Resolved type environment — shared by tsconfig generation and the in-process
// typecheck (workflow-loader). The loader builds compilerOptions from these
// resolved dirs directly so a stale or absent on-disk tsconfig cannot break a
// project whose refs are present.
// ---------------------------------------------------------------------------

export interface WorkflowTypeDirs {
  /** Directory holding the shipped prism declarations (types/index.d.ts). */
  readonly prismTypesDir: string | undefined;
  /** Directory holding the effect declarations (dist/dts/index.d.ts). */
  readonly effectDtsDir: string | undefined;
}

/**
 * Resolve the prism and effect declaration directories for the running
 * environment (installed binary or source checkout). Either may be undefined
 * when the corresponding type surface cannot be located.
 */
export const resolveWorkflowTypeDirs = (): WorkflowTypeDirs => ({
  prismTypesDir: resolvePrismTypesDir(),
  effectDtsDir: resolveEffectDtsDir(),
});

/**
 * Build the `compilerOptions.paths` map for typechecking a workflow file from
 * the resolved type dirs and (optionally) the project-keyed generated refs.
 *
 * Entries are only emitted when the underlying declaration exists, so callers
 * can detect a missing type environment (empty/partial paths) and warn+proceed
 * instead of pointing a specifier at a nonexistent file.
 */
export const buildWorkflowPaths = (options: {
  readonly typeDirs: WorkflowTypeDirs;
  /** Absolute path to the generated refs file (~/.../generated/agents.ts). */
  readonly refsFile?: string;
}): Record<string, string[]> => {
  const paths: Record<string, string[]> = {};
  const { prismTypesDir, effectDtsDir } = options.typeDirs;

  if (prismTypesDir) {
    paths["prism"] = [join(prismTypesDir, "index.d.ts")];
    paths["prism/*"] = [join(prismTypesDir, "*.d.ts")];
  }
  if (options.refsFile) {
    paths["prism/refs"] = [options.refsFile];
  }
  if (effectDtsDir) {
    paths["effect"] = [join(effectDtsDir, "index.d.ts")];
    paths["effect/*"] = [join(effectDtsDir, "*.d.ts")];
  }
  return paths;
};

// ---------------------------------------------------------------------------
// tsconfig generation
// ---------------------------------------------------------------------------

export interface WorkflowTsconfigOptions {
  /**
   * Prism home directory. Defaults to ~/.prism via resolvePrismHome().
   * The generated tsconfig is written to prismHome/state/tsconfig.workflow.json.
   */
  readonly prismHome: string;
  /**
   * Absolute path to the project's generated refs directory
   * (~/.prism/state/projects/<key>/generated/).
   * Used to wire "prism/refs" paths.
   * If omitted, "prism/refs" paths entry is omitted from the tsconfig.
   */
  readonly refsDir?: string;
  /**
   * Absolute path to the directory containing the user's workflow .ts files.
   * Added to tsconfig `include` so the IDE and tsc pick them up automatically.
   */
  readonly workflowDir?: string;
}

export interface GeneratedWorkflowTsconfig {
  /** Absolute path where the tsconfig was written. */
  readonly path: string;
  /** Absolute path to the prism types directory (types/index.d.ts). */
  readonly prismTypesDir: string | undefined;
  /** Absolute path to the effect dts directory (dist/dts/index.d.ts). */
  readonly effectDtsDir: string | undefined;
}

/** The filename for the generated workflow authoring tsconfig. */
export const WORKFLOW_TSCONFIG_FILENAME = "tsconfig.workflow.json";

/**
 * Generate and write the Prism workflow-authoring tsconfig.
 *
 * Returns the path where the tsconfig was written, plus the resolved type
 * directories for caller inspection or further wiring.
 */
export const generateWorkflowTsconfig = async (
  options: WorkflowTsconfigOptions,
): Promise<GeneratedWorkflowTsconfig> => {
  const typeDirs = resolveWorkflowTypeDirs();
  const { prismTypesDir, effectDtsDir } = typeDirs;

  const stateDir = join(options.prismHome, "state");
  await mkdir(stateDir, { recursive: true });
  const tsconfigPath = join(stateDir, WORKFLOW_TSCONFIG_FILENAME);

  // Build paths entries. Omit missing resolutions rather than emitting broken
  // paths — the typecheck pre-step detects a missing prism/effect surface and
  // warns+proceeds rather than reporting a misleading "Cannot find module".
  //
  // "prism/refs" maps to the generated refs entry file (agents.ts), matching
  // what the loader injects per project key at typecheck time.
  const refsFile = options.refsDir
    ? join(options.refsDir, "agents.ts")
    : undefined;
  const paths = buildWorkflowPaths({ typeDirs, refsFile });

  const include: string[] = [];
  if (options.workflowDir) {
    include.push(join(options.workflowDir, "**", "*.ts"));
  }

  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      // Required so .ts extensions in imports do not cause errors when the
      // author writes `import { defineWorkflow } from "prism"`.
      allowImportingTsExtensions: true,
      paths,
    },
    include: include.length > 0 ? include : undefined,
  };

  await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2), "utf8");

  return {
    path: tsconfigPath,
    prismTypesDir,
    effectDtsDir,
  };
};

// ---------------------------------------------------------------------------
// Convenience: resolve the default tsconfig path (no write)
// ---------------------------------------------------------------------------

/** Returns the expected tsconfig path given a prismHome directory. */
export const workflowTsconfigPath = (prismHome: string): string =>
  join(prismHome, "state", WORKFLOW_TSCONFIG_FILENAME);
