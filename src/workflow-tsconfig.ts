/**
 * Generate the Prism-owned authoring tsconfig for workflow .ts files.
 *
 * The generated tsconfig maps the three virtual specifiers a workflow author
 * uses to their shipped type declarations:
 *
 *   "prism"      → <platform-package>/types/index.d.ts  (the emitted prism.d.ts)
 *   "prism/refs" → ~/.prism/state/projects/<key>/generated/refs.d.ts  (generated per-project)
 *   "effect"     → <platform-package>/node_modules/effect/dist/dts/index.d.ts
 *
 * Resolution strategy:
 *
 * When the Prism binary is installed, the platform package sits beside the
 * binary: `dirname(dirname(process.execPath))`. During development (source
 * checkout), we fall back to the local node_modules/effect and the repo's
 * dist/dts-tmp/ output, making the tsconfig usable without an install.
 *
 * The generated tsconfig is written to prismHome/state/tsconfig.workflow.json.
 * This file is Prism-owned and must never be committed to the user's project.
 */

import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
 * Find the prism.d.ts directory (types/index.d.ts relative to the platform
 * package root), or the dist/dts-tmp/ directory when running from source.
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

  // 2. Source-checkout fallback: use the just-emitted dist/dts-tmp/.
  const repoRoot = platformPackageRootFromSource();
  if (repoRoot) {
    const candidate = join(repoRoot, "dist", "dts-tmp");
    if (existsSync(join(candidate, "index.d.ts"))) {
      return candidate;
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
  const prismTypesDir = resolvePrismTypesDir();
  const effectDtsDir = resolveEffectDtsDir();

  const stateDir = join(options.prismHome, "state");
  await mkdir(stateDir, { recursive: true });
  const tsconfigPath = join(stateDir, WORKFLOW_TSCONFIG_FILENAME);

  // Build paths entries. Omit missing resolutions rather than emitting broken
  // paths — the user will see module-not-found errors, not type errors from
  // a wrong path.
  const paths: Record<string, string[]> = {};

  if (prismTypesDir) {
    paths["prism"] = [join(prismTypesDir, "index.d.ts")];
    // Sub-path imports (e.g. "prism/workflows") map to the same directory so
    // TypeScript resolves them via the types directory structure.
    paths["prism/*"] = [join(prismTypesDir, "*.d.ts")];
  }

  if (options.refsDir) {
    // "prism/refs" → the generated per-project refs index.
    const refsIndex = join(options.refsDir, "refs.d.ts");
    paths["prism/refs"] = [refsIndex];
  }

  if (effectDtsDir) {
    paths["effect"] = [join(effectDtsDir, "index.d.ts")];
    // Allow sub-path imports like "effect/Schema".
    paths["effect/*"] = [join(effectDtsDir, "*.d.ts")];
  }

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
