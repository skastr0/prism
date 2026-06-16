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

import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Platform package root resolution
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve the Prism platform package root from the running binary.
 * When running as a compiled binary, `process.execPath` is the binary itself,
 * which lives at `<package-root>/bin/prism`. Two dirname() calls reach the
 * package root.
 */
const platformPackageRootFromBinary = (): string | undefined => {
  if (typeof process.execPath !== "string" || process.execPath.length === 0) {
    return undefined;
  }
  const candidate = dirname(dirname(process.execPath));
  // Sanity check: the platform package should have a package.json.
  if (existsSync(join(candidate, "package.json"))) {
    return candidate;
  }
  return undefined;
};

/**
 * Resolve the platform package root from the source checkout (development
 * fallback). Uses the location of this module file to navigate to the repo
 * root and then to the darwin-arm64 package (the local platform on macOS arm64
 * is used only when no binary root is available).
 */
const platformPackageRootFromSource = (): string | undefined => {
  try {
    // __filename lives at src/workflow-tsconfig.ts -> repo root is two up.
    const selfPath = fileURLToPath(import.meta.url);
    // selfPath ends with workflow-tsconfig.js (compiled) or .ts (source); both
    // sit directly in src/
    const srcDir = dirname(selfPath);
    const repoRoot = dirname(srcDir);
    // Return the repo root so callers can resolve dist/dts-tmp and node_modules.
    return repoRoot;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Locate shipped declarations and effect types
// ---------------------------------------------------------------------------

/**
 * Candidate platform-package directory names, most-specific first. During a
 * source checkout the shipped declarations live inside the matching platform
 * package under packages/npm/. We probe the host's platform/arch package first,
 * then fall through to the rest so a non-darwin-arm64 dev box still resolves.
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
 * Find the prism.d.ts directory. Resolution order:
 *   1. Installed binary: <package-root>/types/index.d.ts.
 *   2. Source checkout: the shipped declarations inside the matching
 *      packages/npm/prism-<platform>/types directory (populated by build:npm).
 *   3. Source checkout fallback: the freshly-emitted dist/dts-tmp/.
 *
 * Returns undefined when none resolve — callers then warn + proceed rather than
 * pointing "prism" at a nonexistent file (which would surface as a misleading
 * "Cannot find module 'prism'" type error on every valid workflow).
 */
const resolvePrismTypesDir = (): string | undefined => {
  // 1. Installed binary path.
  const binaryRoot = platformPackageRootFromBinary();
  if (binaryRoot) {
    const candidate = join(binaryRoot, "types");
    if (existsSync(join(candidate, "index.d.ts"))) {
      return candidate;
    }
  }

  const repoRoot = platformPackageRootFromSource();
  if (repoRoot) {
    // 2. Source-checkout: shipped platform-package declarations (build:npm).
    for (const name of platformPackageDirNames()) {
      const candidate = join(repoRoot, "packages", "npm", name, "types");
      if (existsSync(join(candidate, "index.d.ts"))) {
        return candidate;
      }
    }

    // 3. Source-checkout fallback: the just-emitted dist/dts-tmp/.
    const tmp = join(repoRoot, "dist", "dts-tmp");
    if (existsSync(join(tmp, "index.d.ts"))) {
      return tmp;
    }
  }

  return undefined;
};

/**
 * Find the shipped effect .d.ts directory (node_modules/effect/dist/dts/).
 * When running from a compiled binary the platform package owns its own
 * node_modules. When running from source the repo's node_modules is used.
 */
const resolveEffectDtsDir = (): string | undefined => {
  // 1. Platform package's node_modules (installed binary).
  const binaryRoot = platformPackageRootFromBinary();
  if (binaryRoot) {
    const candidate = join(binaryRoot, "node_modules", "effect", "dist", "dts");
    if (existsSync(join(candidate, "index.d.ts"))) {
      return candidate;
    }
  }

  // 2. Source-checkout fallback.
  const repoRoot = platformPackageRootFromSource();
  if (repoRoot) {
    const candidate = join(repoRoot, "node_modules", "effect", "dist", "dts");
    if (existsSync(join(candidate, "index.d.ts"))) {
      return candidate;
    }
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
