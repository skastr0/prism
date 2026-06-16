import { Schema } from "effect";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type * as TypeScript from "typescript";
import { expandPath } from "./fs.js";
// Importing from load.ts initializes the binary's Effect runtime bridge
// (globalThis.__prism_effect) as a module side-effect, so the workflow DSL
// runtime and the file's `from "effect"` rewrite resolve to the binary's
// Effect instance — making Schema.isSchema and decodeTaskOutput operate on
// the same Effect the runner uses.
import { prepareImportWrapper } from "./compile/load.js";
import { typescriptBundleImportPath } from "./compile/runtime-deps.js";
import { compileManifestPath } from "./compile/compile-manifest.js";
import { resolvePrismHome } from "./prism-home.js";
import type { AnyWorkflowDefinition, AnyWorkflowTask, WorkflowAgentRef } from "./workflows.js";

const ts = createRequire(import.meta.url)(typescriptBundleImportPath()) as typeof TypeScript;

export interface WorkflowTaskSummary {
  readonly id: string;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly cacheKey?: string;
}

export interface WorkflowValidationSummary {
  readonly path: string;
  readonly name: string;
  readonly tasks: ReadonlyArray<WorkflowTaskSummary>;
  readonly dynamic: boolean;
}

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isWorkflowAgentRef = (value: unknown): value is WorkflowAgentRef =>
  isRecord(value) &&
  value.kind === "agent-ref" &&
  typeof value.plugin === "string" &&
  typeof value.name === "string" &&
  typeof value.description === "string" &&
  typeof value.sourceHash === "string" &&
  typeof value.manifestHash === "string" &&
  isStringArray(value.installs);

const isWorkflowTask = (value: unknown): value is AnyWorkflowTask =>
  isRecord(value) &&
  value.kind === "workflow-task" &&
  typeof value.id === "string" &&
  isWorkflowAgentRef(value.agent) &&
  typeof value.prompt === "string" &&
  Schema.isSchema(value.output) &&
  (value.cacheKey === undefined || typeof value.cacheKey === "string");

export const isWorkflowDefinition = (
  value: unknown,
): value is AnyWorkflowDefinition =>
  isRecord(value) &&
  value.kind === "workflow" &&
  typeof value.name === "string" &&
  Array.isArray(value.tasks) &&
  value.tasks.every(isWorkflowTask) &&
  (value.run === undefined || typeof value.run === "function");

export const workflowSummary = (
  path: string,
  workflow: AnyWorkflowDefinition,
): WorkflowValidationSummary => ({
  path,
  name: workflow.name,
  dynamic: "run" in workflow,
  tasks: workflow.tasks.map((task) => ({
    id: task.id,
    agent: {
      plugin: task.agent.plugin,
      name: task.agent.name,
    },
    ...(task.cacheKey ? { cacheKey: task.cacheKey } : {}),
  })),
});

// ---------------------------------------------------------------------------
// Workflow refs location (stays in cwd-relative location until the storage
// migration glyph moves it to ~/.prism/state/projects/<key>/generated).
// ---------------------------------------------------------------------------

const workflowRefsFilePath = (): string =>
  resolvePath(process.cwd(), ".prism", "generated", "workflows", "agents.ts");

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
    const file = Bun.file(refsPath);
    const slice = await file.slice(0, 512).text();
    const match = MANIFEST_HASH_RE.exec(slice);
    return match?.[1];
  } catch {
    return undefined;
  }
};

/**
 * Read the top-level manifestHash from the current compile manifest on disk.
 * Returns undefined when the manifest does not exist or cannot be parsed.
 */
const readCurrentManifestHash = async (prismHome: string): Promise<string | undefined> => {
  const manifestPath = compileManifestPath(prismHome);
  if (!existsSync(manifestPath)) return undefined;
  try {
    const raw = await Bun.file(manifestPath).json() as { readonly manifestHash?: string };
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
  const refsPath = workflowRefsFilePath();

  const [refsHash, currentHash] = await Promise.all([
    extractRefsManifestHash(refsPath),
    readCurrentManifestHash(prismHome),
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
 * Load and parse the Prism-generated workflow tsconfig, then augment it with
 * the current project refs path so `prism/refs` resolves to the generated
 * file. Returns null when the tsconfig does not exist (typecheck skipped).
 */
const loadWorkflowCompilerOptions = (
  prismHome: string,
): TypeScript.CompilerOptions | null => {
  const tsconfigPath = resolvePath(prismHome, "state", "tsconfig.workflow.json");
  if (!existsSync(tsconfigPath)) return null;

  let configJson: TsconfigJson;
  try {
    configJson = JSON.parse(readFileSync(tsconfigPath, "utf8")) as TsconfigJson;
  } catch {
    return null;
  }

  const compilerOptionsJson: Record<string, unknown> = {
    ...(configJson.compilerOptions ?? {}),
  };

  // Inject `prism/refs` → generated refs file. Always set it so that a
  // workflow that imports prism/refs can be typechecked even when the
  // tsconfig was generated without a refsDir (pre-5 toolchain step).
  const refsPath = workflowRefsFilePath();
  if (existsSync(refsPath)) {
    const existingPaths = (compilerOptionsJson.paths as Record<string, string[]>) ?? {};
    compilerOptionsJson.paths = {
      ...existingPaths,
      "prism/refs": [refsPath],
    };
  }

  const { options, errors } = ts.convertCompilerOptionsFromJson(
    compilerOptionsJson,
    resolvePath(prismHome, "state"),
  );
  if (errors.length > 0) return null;

  return options;
};

/**
 * Run an in-process TypeScript typecheck on a workflow file using the
 * binary-embedded TypeScript and the Prism-generated tsconfig.
 *
 * Throws WorkflowTypecheckError when the file has type errors.
 * Skips silently when the tsconfig is unavailable (guards against the
 * case where the user has not yet generated the tsconfig via `prism compile`).
 */
export const typecheckWorkflowFile = (
  filePath: string,
  options: { readonly prismHome?: string } = {},
): void => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const compilerOptions = loadWorkflowCompilerOptions(prismHome);
  if (compilerOptions === null) return; // No tsconfig available; skip.

  const host = ts.createCompilerHost(compilerOptions);
  const program = ts.createProgram([filePath], compilerOptions, host);
  const allDiagnostics = ts.getPreEmitDiagnostics(program);

  // Filter to only diagnostics from the workflow file itself (not from
  // declaration files / lib files), to avoid noise from the ambient types.
  const fileDiagnostics = allDiagnostics.filter((d) => {
    if (!d.file) return false;
    const name = d.file.fileName;
    // Include diagnostics from the workflow file, or from the refs and prism
    // declaration files the workflow directly imports.
    return (
      name === filePath ||
      name.replace(/\\/g, "/") === filePath.replace(/\\/g, "/")
    );
  });

  if (fileDiagnostics.length === 0) return;

  const structured: WorkflowTypecheckDiagnostic[] = fileDiagnostics.map((d) => {
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
  });

  throw new WorkflowTypecheckError(filePath, structured);
};

export const loadWorkflowFile = async (
  filePath: string,
  options: { readonly prismHome?: string; readonly skipTypecheck?: boolean } = {},
): Promise<AnyWorkflowDefinition> => {
  const resolved = expandPath(filePath);

  // Ref-freshness check (async; runs concurrently with typecheck below).
  const freshnessCheck = checkWorkflowRefsFreshness({ prismHome: options.prismHome });

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
