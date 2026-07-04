import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import type * as TypeScript from "typescript";
import { expandPath } from "./fs.js";
// Importing from load.ts initializes the binary's Effect runtime bridge
// (globalThis.__prism_effect) as a module side-effect, so the workflow DSL
// runtime and the file's `from "effect"` rewrite resolve to the binary's
// Effect instance used by authored workflow modules.
import { prepareImportWrapper } from "./compile/load.js";
import { typescriptBundleImportPath } from "./compile/runtime-deps.js";
import { compileManifestPath } from "./compile/compile-manifest.js";
import { resolvePrismHome } from "./prism-home.js";
import { deriveProjectKey, projectGeneratedAgentsPath } from "./project-key.js";
import {
  buildWorkflowPaths,
  resolveWorkflowTypeDirs,
  WORKFLOW_TSCONFIG_FILENAME,
} from "./workflow-tsconfig.js";
import {
  isWorkflowDefinition,
  workflowSummary,
  type AnyWorkflowDefinition,
  type WorkflowValidationSummary,
} from "./workflows.js";

const ts = createRequire(import.meta.url)(typescriptBundleImportPath()) as typeof TypeScript;

export interface WorkflowTypecheckDiagnostic {
  readonly file: string;
  readonly line: number | null;
  readonly character: number | null;
  readonly message: string;
}

export class WorkflowLoadError extends Error {
  override readonly name = "WorkflowLoadError";
}

export class WorkflowTypecheckError extends Error {
  override readonly name = "WorkflowTypecheckError";
  constructor(
    readonly filePath: string,
    readonly diagnostics: ReadonlyArray<WorkflowTypecheckDiagnostic>,
  ) {
    const summary = diagnostics
      .slice(0, 5)
      .map((d) => `${d.file}:${d.line ?? "?"}:${d.character ?? "?"}: ${d.message}`)
      .join("\n");
    super(
      `workflow type error in ${filePath}:\n${summary}` +
        (diagnostics.length > 5 ? `\n... and ${diagnostics.length - 5} more` : ""),
    );
  }
}

type WorkflowModule = {
  readonly default?: unknown;
  readonly workflow?: unknown;
};

// ---------------------------------------------------------------------------
// Workflow refs location — machine-global, project-keyed
// (~/.prism/state/projects/<key>/generated/agents.ts). The key is the
// project identity (toolchain & distribution §4): git repository root of the
// process cwd, else realpath(cwd). An off-repo workflow file run from inside a
// repo therefore resolves prism/refs to that repo's generated refs.
// ---------------------------------------------------------------------------

const workflowRefsFilePath = (prismHome: string): string => {
  const { key } = deriveProjectKey();
  return projectGeneratedAgentsPath(prismHome, key);
};

// ---------------------------------------------------------------------------
// Ref-freshness: compare the manifest hash embedded in the generated refs
// against the current compile manifest so stale refs cannot silently lie.
// ---------------------------------------------------------------------------

const MANIFEST_HASH_RE = /\*\s+Source:\s+compile manifest\s+([a-f0-9]+)/;

/**
 * Extract the compile manifest hash stamped into the generated refs file
 * header comment. Returns undefined when the file does not exist or has
 * no hash comment.
 */
const extractRefsManifestHash = async (refsPath: string): Promise<string | undefined> => {
  if (!existsSync(refsPath)) return undefined;
  try {
    // Read only the first 512 bytes — the header comment is always near the top.
    const slice = (await readFile(refsPath, "utf8")).slice(0, 512);
    const match = MANIFEST_HASH_RE.exec(slice);
    return match?.[1];
  } catch {
    return undefined;
  }
};

/**
 * Read the top-level manifestHash from the current per-project compile
 * manifest on disk. Returns undefined when the manifest does not exist or
 * cannot be parsed.
 */
const readCurrentManifestHash = async (
  prismHome: string,
  projectKey: string,
): Promise<string | undefined> => {
  const manifestPath = compileManifestPath(prismHome, projectKey);
  if (!existsSync(manifestPath)) return undefined;
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { readonly manifestHash?: string };
    return typeof raw.manifestHash === "string" ? raw.manifestHash : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Check whether the generated refs are fresh relative to the current compile
 * manifest. Emits a warning to stderr when drift is detected. The check is
 * best-effort: missing refs or missing manifest produce no warning (the refs
 * file may simply not exist yet).
 */
export const checkWorkflowRefsFreshness = async (options: {
  readonly prismHome?: string;
}): Promise<void> => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const { key } = deriveProjectKey();
  const refsPath = workflowRefsFilePath(prismHome);

  const [refsHash, currentHash] = await Promise.all([
    extractRefsManifestHash(refsPath),
    readCurrentManifestHash(prismHome, key),
  ]);

  if (refsHash === undefined || currentHash === undefined) return;
  if (refsHash === currentHash) return;

  process.stderr.write(
    `warning: generated workflow refs are stale (refs were generated from manifest ` +
      `${refsHash.slice(0, 12)}, current manifest is ${currentHash.slice(0, 12)}). ` +
      `Run \`prism compile\` to regenerate refs.\n`,
  );
};

// ---------------------------------------------------------------------------
// In-process TypeScript typecheck (transparent pre-step of run and validate).
// ---------------------------------------------------------------------------

interface TsconfigJson {
  readonly compilerOptions?: Record<string, unknown>;
  readonly include?: string[];
}

/**
 * The fixed compilerOptions a workflow file is typechecked under. The `paths`
 * are layered on top from the resolved type environment.
 */
const BASE_WORKFLOW_COMPILER_OPTIONS = {
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "bundler",
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  allowImportingTsExtensions: true,
} as const;

interface WorkflowTypeEnvironment {
  readonly compilerOptions: TypeScript.CompilerOptions;
  /** True when the prism (DSL) declaration surface resolved. */
  readonly hasPrismTypes: boolean;
  /** True when the effect declaration surface resolved. */
  readonly hasEffectTypes: boolean;
  /** True when the project-keyed generated refs file resolved. */
  readonly hasRefs: boolean;
}

/**
 * Build the workflow type environment for the current project.
 *
 * Paths are computed in-memory from the resolved shipped declarations
 * (prism.d.ts / effect .d.ts) plus the project-keyed generated refs
 * (~/.prism/state/projects/<key>/generated/agents.ts), so a stale or absent
 * on-disk tsconfig cannot break a project whose refs exist. When a
 * Prism-generated tsconfig is present (legacy global or project-keyed), its
 * non-path compilerOptions are merged underneath as a base; the resolved paths
 * always win.
 *
 * Returns null only when no type surface at all can be resolved — neither prism
 * nor effect nor refs — meaning there is nothing to typecheck against and the
 * caller should warn+proceed.
 */
const resolveWorkflowTypeEnvironment = (
  prismHome: string,
): WorkflowTypeEnvironment | null => {
  const typeDirs = resolveWorkflowTypeDirs();
  const refsPath = workflowRefsFilePath(prismHome);
  const hasRefs = existsSync(refsPath);

  const paths = buildWorkflowPaths({
    typeDirs,
    refsDir: hasRefs ? dirname(refsPath) : undefined,
  });

  // Merge any on-disk Prism-generated tsconfig's non-path options as a base.
  // Prefer the project-keyed location (toolchain & distribution §5), falling
  // back to the legacy global file. The resolved `paths` above always override.
  const onDiskBase = readOnDiskWorkflowCompilerOptions(prismHome);

  const compilerOptionsJson: Record<string, unknown> = {
    ...BASE_WORKFLOW_COMPILER_OPTIONS,
    ...onDiskBase,
    paths,
  };

  const { options, errors } = ts.convertCompilerOptionsFromJson(
    compilerOptionsJson,
    resolvePath(prismHome, "state"),
  );
  if (errors.length > 0) return null;

  const hasPrismTypes = typeDirs.prismTypesDir !== undefined;
  const hasEffectTypes = typeDirs.effectDtsDir !== undefined;

  // Nothing resolvable at all — no type environment to check against.
  if (!hasPrismTypes && !hasEffectTypes && !hasRefs) return null;

  return { compilerOptions: options, hasPrismTypes, hasEffectTypes, hasRefs };
};

/**
 * Read the non-path compilerOptions from an on-disk Prism-generated workflow
 * tsconfig, preferring the project-keyed location over the legacy global one.
 * Returns an empty object when none exists or cannot be parsed. `paths` are
 * stripped — the live resolved paths always supersede whatever is on disk.
 */
const readOnDiskWorkflowCompilerOptions = (
  prismHome: string,
): Record<string, unknown> => {
  const { key } = deriveProjectKey();
  const candidates = [
    resolvePath(prismHome, "state", "projects", key, "tsconfig.json"),
    resolvePath(prismHome, "state", WORKFLOW_TSCONFIG_FILENAME),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const configJson = JSON.parse(readFileSync(candidate, "utf8")) as TsconfigJson;
      const { paths: _paths, ...rest } = configJson.compilerOptions ?? {};
      return rest;
    } catch {
      // Try the next candidate.
    }
  }
  return {};
};

/** TS diagnostic codes that mean the type ENVIRONMENT is missing, not a real
 * error inside the workflow. These never gate a run; they warn+proceed. */
const ENVIRONMENT_DIAGNOSTIC_CODES = new Set<number>([
  2307, // Cannot find module 'X' or its corresponding type declarations.
  2792, // Cannot find module 'X'. Did you mean to set 'moduleResolution'...
]);

/** TS code 7006: "Parameter 'x' implicitly has an 'any' type." This is a
 * cascade from an unresolved import (e.g. defineWorkflow typed as any), so it
 * is treated as environmental ONLY when an environment diagnostic is also
 * present. */
const IMPLICIT_ANY_CODE = 7006;

/**
 * Run an in-process TypeScript typecheck on a workflow file using the
 * binary-embedded TypeScript and the resolved type environment.
 *
 * Behaviour:
 *  - No resolvable type environment at all (never compiled, no shipped types):
 *    warn to stderr and proceed — the runtime loader works regardless.
 *  - Module-not-found / no-types-configured diagnostics: warn and proceed.
 *  - A genuine type error inside the workflow (e.g. an unknown agent ref like
 *    `agents.forge.doesNotExist`): throw WorkflowTypecheckError. This is the
 *    moat.
 */
export const typecheckWorkflowFile = (
  filePath: string,
  options: { readonly prismHome?: string } = {},
): void => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const environment = resolveWorkflowTypeEnvironment(prismHome);
  if (environment === null) {
    process.stderr.write(
      `warning: workflow type environment unavailable (no generated refs or ` +
        `shipped declarations for this project); skipping typecheck and ` +
        `proceeding with the run. Run \`prism compile\` to enable typechecking.\n`,
    );
    return;
  }

  const compilerOptions = environment.compilerOptions;
  const host = ts.createCompilerHost(compilerOptions);
  const program = ts.createProgram([filePath], compilerOptions, host);
  const allDiagnostics = ts.getPreEmitDiagnostics(program);

  // Filter to only diagnostics from the workflow file itself (not from
  // declaration files / lib files), to avoid noise from the ambient types.
  const fileDiagnostics = allDiagnostics.filter((d) => {
    if (!d.file) return false;
    const name = d.file.fileName;
    return (
      name === filePath ||
      name.replace(/\\/g, "/") === filePath.replace(/\\/g, "/")
    );
  });

  if (fileDiagnostics.length === 0) return;

  // Partition: environmental (module-not-found etc.) vs genuine type errors.
  const hasEnvironmentDiagnostic = fileDiagnostics.some((d) =>
    ENVIRONMENT_DIAGNOSTIC_CODES.has(d.code),
  );

  const realErrors = fileDiagnostics.filter((d) => {
    if (ENVIRONMENT_DIAGNOSTIC_CODES.has(d.code)) return false;
    // Implicit-any is a cascade from an unresolved import; only environmental
    // when an environment diagnostic was actually emitted in the same file.
    if (d.code === IMPLICIT_ANY_CODE && hasEnvironmentDiagnostic) return false;
    return true;
  });

  const toStructured = (d: TypeScript.Diagnostic): WorkflowTypecheckDiagnostic => {
    const pos =
      d.file !== undefined && d.start !== undefined
        ? ts.getLineAndCharacterOfPosition(d.file, d.start)
        : null;
    return {
      file: d.file?.fileName ?? filePath,
      line: pos ? pos.line + 1 : null,
      character: pos ? pos.character + 1 : null,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  };

  if (realErrors.length === 0) {
    // Only environmental noise remained — the type surface could not be fully
    // resolved for this file. Warn and proceed rather than hard-failing a
    // valid workflow whose types simply are not wired up yet.
    const summary = fileDiagnostics
      .slice(0, 3)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      .join("; ");
    process.stderr.write(
      `warning: workflow types could not be fully resolved for ${filePath} ` +
        `(${summary}); proceeding with the run.\n`,
    );
    return;
  }

  throw new WorkflowTypecheckError(filePath, realErrors.map(toStructured));
};

export const loadWorkflowFile = async (
  filePath: string,
  options: { readonly prismHome?: string; readonly skipTypecheck?: boolean } = {},
): Promise<AnyWorkflowDefinition> => {
  const resolved = expandPath(filePath);

  // Ref-freshness check (async; runs concurrently with typecheck below).
  const freshnessCheck = checkWorkflowRefsFreshness({
    prismHome: options.prismHome,
  });

  // Transparent typecheck pre-step: fail fast with structured diagnostics.
  if (options.skipTypecheck !== true) {
    typecheckWorkflowFile(resolved, { prismHome: options.prismHome });
  }

  // Await freshness so any warning is emitted before execution output.
  await freshnessCheck;

  const wrapper = await prepareImportWrapper(resolved, { workflow: true });
  let module: WorkflowModule;
  try {
    module = (await import(wrapper.specifier)) as WorkflowModule;
  } finally {
    await wrapper.cleanup();
  }
  const candidate = module.workflow ?? module.default;
  if (!isWorkflowDefinition(candidate)) {
    throw new WorkflowLoadError(
      "workflow module must export a WorkflowDefinition as `workflow` or default",
    );
  }
  return candidate;
};

export const validateWorkflowFile = async (
  filePath: string,
  options: { readonly prismHome?: string; readonly skipTypecheck?: boolean } = {},
): Promise<WorkflowValidationSummary> => {
  const resolved = expandPath(filePath);
  const workflow = await loadWorkflowFile(resolved, options);
  return workflowSummary(resolved, workflow);
};
