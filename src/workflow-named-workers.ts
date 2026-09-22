/** Portable, user-curated worker configurations. Runtime reads installed truth only. */
import { join } from "node:path";
import { Data, Effect, Schema } from "effect";
import { exists, expandPath, readFile, writeFile } from "./fs.js";
import { workflowWorkerHarnessIds } from "./lowerer-capabilities.js";
import type { HarnessTypesSnapshot } from "./harness-types.js";
import { loadHarnessTypesSnapshot } from "./workflow-models.js";
import { legacyReasoningVariantError, validateWorkflowEffort, workflowEffortValues } from "./workflow-effort.js";
import { assertWorkflowWorkerPermission } from "./workflow-workers.js";
import { resolveAmpCatalogPinPlan } from "./workflow-amp-worker.js";
import type { WorkflowTaskWorkerOptions, WorkflowWorkerId } from "./workflows.js";

const NonBlank = Schema.String.check(Schema.makeFilter((s) => s.trim().length > 0 || "Must not be blank"));
const ModelProfile = Schema.Struct({
  kind: Schema.Literal("model-profile-ref"),
  plugin: NonBlank,
  modelspace: NonBlank,
  profile: NonBlank,
  targets: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
});
const commonConfig = {
  model: Schema.optionalKey(Schema.Union([NonBlank, ModelProfile])),
  profile: Schema.optionalKey(NonBlank),
  restrictedTools: Schema.optionalKey(Schema.Array(NonBlank)),
  retry: Schema.optionalKey(Schema.Struct({
    maxAttempts: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    backoffMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  })),
};
const sessionPersistence = Schema.optionalKey(Schema.Literals(["persistent", "ephemeral"]));
const dialPermission = Schema.optionalKey(Schema.Literals(["legacy", "permissive", "full-access"]));
const toolsPermission = Schema.optionalKey(Schema.Literals(["legacy", "permissive", "restricted", "full-access"]));

// The wire schema is a harness-discriminated union, just like the DSL. Unknown
// fields fail decoding rather than being dropped (including unsupported effort).
const effortField = (worker: ReturnType<typeof workflowWorkerHarnessIds>[number], snapshot?: HarnessTypesSnapshot) => {
  const values = workflowEffortValues(worker, snapshot);
  if (values === undefined) {
    return Schema.optionalKey(Schema.String.check(Schema.makeFilter(() =>
      `Workflow worker '${worker}' has no per-task effort control.`,
    )));
  }
  return Schema.optionalKey(values.length > 0
    ? Schema.Literals(values as readonly [string, ...string[]])
    : NonBlank);
};

const workerConfigSchema = (snapshot?: HarnessTypesSnapshot) => Schema.Union(workflowWorkerHarnessIds().map((worker) => {
  switch (worker) {
    case "amp-code":
      return Schema.Struct({ ...commonConfig, worker: Schema.Literal(worker), permission: dialPermission,
        catalogModel: Schema.optionalKey(NonBlank), effort: effortField(worker, snapshot) });
    case "claude-code":
      return Schema.Struct({ ...commonConfig, effort: effortField(worker, snapshot), worker: Schema.Literal(worker), permission: toolsPermission, sessionPersistence });
    case "omp":
      return Schema.Struct({ ...commonConfig, effort: effortField(worker, snapshot), worker: Schema.Literal(worker), permission: toolsPermission, sessionPersistence });
    case "codex-cli":
      return Schema.Struct({ ...commonConfig, effort: effortField(worker, snapshot), worker: Schema.Literal(worker), sessionPersistence,
        permission: Schema.optionalKey(Schema.Literals(["legacy", "permissive", "full-access", "sandbox-read-only", "sandbox-workspace-write"])) });
    case "cursor":
      return Schema.Struct({ ...commonConfig, effort: effortField(worker, snapshot), worker: Schema.Literal(worker),
        permission: Schema.optionalKey(Schema.Literals(["legacy", "permissive", "full-access", "sandbox-workspace-write"])) });
    case "devin":
      return Schema.Struct({ ...commonConfig, effort: effortField(worker, snapshot), worker: Schema.Literal(worker), permission: toolsPermission });
    default:
      return Schema.Struct({ ...commonConfig, effort: effortField(worker, snapshot), worker: Schema.Literal(worker), permission: dialPermission });
  }
}));
const workerCatalogSchema = (snapshot?: HarnessTypesSnapshot) => Schema.Struct({
  version: Schema.Literal(1),
  workers: Schema.Array(Schema.Struct({
    name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*$/u)),
    description: NonBlank,
    config: workerConfigSchema(snapshot),
  })),
});

export interface NamedWorkflowWorker {
  readonly name: string;
  readonly description: string;
  readonly config: WorkflowTaskWorkerOptions & { readonly worker: NonNullable<WorkflowTaskWorkerOptions["worker"]> };
}

export interface WorkflowWorkerCatalog {
  readonly version: 1;
  readonly workers: readonly NamedWorkflowWorker[];
}

export class WorkflowWorkerCatalogError extends Data.TaggedError("WorkflowWorkerCatalogError")<{
  readonly path: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

const catalogError = (path: string, cause: unknown): WorkflowWorkerCatalogError =>
  new WorkflowWorkerCatalogError({ path, cause, message: `Worker catalog ${path}: ${cause instanceof Error ? cause.message : String(cause)}` });

const rawEffortValidationError = (input: unknown, snapshot?: HarnessTypesSnapshot): string | undefined => {
  if (typeof input !== "object" || input === null || !Array.isArray((input as { readonly workers?: unknown }).workers)) return undefined;
  for (const entry of (input as { readonly workers: readonly unknown[] }).workers) {
    if (typeof entry !== "object" || entry === null) continue;
    const config = (entry as { readonly config?: unknown }).config;
    if (typeof config !== "object" || config === null) continue;
    const row = config as Record<string, unknown>;
    if (
      typeof row.worker !== "string"
      || !workflowWorkerHarnessIds().includes(row.worker as WorkflowWorkerId)
      || typeof row.effort !== "string"
    ) continue;
    const message = validateWorkflowEffort({
      worker: row.worker as WorkflowWorkerId,
      effort: row.effort,
      model: typeof row.model === "string" ? row.model : undefined,
      catalogModel: typeof row.catalogModel === "string" ? row.catalogModel : undefined,
      snapshot,
    });
    if (message !== undefined) return message;
  }
  return undefined;
};

const catalogIo = <A>(path: string, run: () => Promise<A>): Effect.Effect<A, WorkflowWorkerCatalogError> =>
  Effect.tryPromise({ try: run, catch: (cause) => catalogError(path, cause) });

export const workflowWorkerCatalogPath = (prismHome: string): string =>
  join(prismHome, "state", "workflow-workers", "catalog.json");

export const workflowWorkersModulePath = (prismHome: string): string =>
  join(prismHome, "state", "workflow-workers", "workers.ts");

export const decodeWorkflowWorkerCatalog = (
  input: unknown,
  options: { readonly effortSnapshot?: HarnessTypesSnapshot } = {},
): WorkflowWorkerCatalog => {
  let catalog: WorkflowWorkerCatalog;
  try {
    catalog = Schema.decodeUnknownSync(workerCatalogSchema(options.effortSnapshot), { onExcessProperty: "error" })(input) as unknown as WorkflowWorkerCatalog;
  } catch (cause) {
    const effortError = rawEffortValidationError(input, options.effortSnapshot);
    if (effortError !== undefined) throw new Error(effortError);
    throw cause;
  }
  const names = new Set<string>();
  for (const { name, config } of catalog.workers) {
    if (names.has(name)) throw new Error(`Duplicate named worker ${JSON.stringify(name)}. Give each worker a unique name.`);
    names.add(name);
    assertWorkflowWorkerPermission(config.worker, config.permission ?? "permissive", config.restrictedTools);
    const modelRef = typeof config.model === "object" ? config.model : undefined;
    if (modelRef?.targets !== undefined) {
      const target = modelRef.targets[config.worker];
      const variantError = legacyReasoningVariantError(config.worker, target, `model.targets.${config.worker}`);
      if (variantError !== undefined) throw new Error(variantError);
    }
    const target = modelRef?.targets?.[config.worker];
    const targetBinding = target && typeof target === "object" && !Array.isArray(target)
      ? target as { readonly model?: unknown; readonly effort?: unknown; readonly models?: readonly unknown[] }
      : undefined;
    const firstChoice = targetBinding?.models?.find((entry) =>
      typeof entry === "object" && entry !== null && typeof (entry as { readonly model?: unknown }).model === "string") as
        { readonly model?: unknown; readonly effort?: unknown } | undefined;
    const model = typeof config.model === "string"
      ? config.model
      : typeof targetBinding?.model === "string"
        ? targetBinding.model
        : typeof firstChoice?.model === "string" ? firstChoice.model : undefined;
    const effort = typeof config.effort === "string"
      ? config.effort
      : typeof targetBinding?.effort === "string"
        ? targetBinding.effort
        : typeof firstChoice?.effort === "string" ? firstChoice.effort : undefined;
    const effortError = validateWorkflowEffort({
      worker: config.worker,
      effort,
      model,
      catalogModel: config.worker === "amp-code" ? config.catalogModel : undefined,
      snapshot: options.effortSnapshot,
    });
    if (effortError !== undefined) throw new Error(effortError);
    if (config.worker === "amp-code") {
      resolveAmpCatalogPinPlan({
        mode: typeof config.model === "string" ? config.model : undefined,
        catalogModel: config.catalogModel,
        effort: config.effort,
      });
    }
  }
  return catalog;
};

const readWorkerCatalog = Effect.fn("readWorkerCatalog")(function* (path: string, effortSnapshot?: HarnessTypesSnapshot) {
  const text = yield* catalogIo(path, () => readFile(path));
  return yield* Effect.try({
    try: () => decodeWorkflowWorkerCatalog(JSON.parse(text), { effortSnapshot }),
    catch: (cause) => catalogError(path, cause),
  });
});

export const loadWorkflowWorkerCatalog = Effect.fn("loadWorkflowWorkerCatalog")(function* (prismHome: string) {
  const path = workflowWorkerCatalogPath(prismHome);
  return yield* readWorkerCatalog(path, loadHarnessTypesSnapshot(prismHome)).pipe(Effect.catchIf(
    (error) => error.cause instanceof Error && "code" in error.cause && error.cause.code === "ENOENT",
    () => Effect.succeed({ version: 1, workers: [] } satisfies WorkflowWorkerCatalog),
  ));
});

export const namedWorkerRef = (name: string): string =>
  /^[a-z][a-z0-9_]*$/u.test(name) ? `workers.${name}` : `workers[${JSON.stringify(name)}]`;

export const renderWorkflowWorkersModule = (catalog: WorkflowWorkerCatalog): string => {
  const entries = catalog.workers.map(({ name, description, config }) =>
    `  /** ${description.replace(/\*\//gu, "* / ").replace(/\s+/gu, " ")} */\n  ${JSON.stringify(name)}: ${JSON.stringify(config)},`,
  );
  return `// Generated from the installed Prism worker catalog. Do not edit.\nimport type { WorkflowTaskWorkerOptions } from "prism";\n\nexport const workers = {\n${entries.join("\n")}\n} as const satisfies Record<string, WorkflowTaskWorkerOptions>;\n`;
};

/** Rebuild only from installed data, never from the user's source repository. */
export const ensureWorkflowWorkersModule = Effect.fn("ensureWorkflowWorkersModule")(function* (prismHome: string) {
  const catalog = yield* loadWorkflowWorkerCatalog(prismHome);
  const path = workflowWorkersModulePath(prismHome);
  const source = renderWorkflowWorkersModule(catalog);
  yield* catalogIo(path, async () => {
    if (!await exists(path) || await readFile(path) !== source) await writeFile(path, source);
  });
  return path;
});

/** Explicitly replace the installed catalog; multiple files merge only by unique names. */
export const installWorkflowWorkerCatalog = Effect.fn("installWorkflowWorkerCatalog")(function* (
  prismHome: string,
  sources: readonly string[],
) {
  const workers: NamedWorkflowWorker[] = [];
  const effortSnapshot = loadHarnessTypesSnapshot(prismHome);
  for (const source of sources) {
    const path = expandPath(source);
    workers.push(...(yield* readWorkerCatalog(path, effortSnapshot)).workers);
  }
  const path = workflowWorkerCatalogPath(prismHome);
  const catalog = yield* Effect.try({
    try: () => decodeWorkflowWorkerCatalog({ version: 1, workers }, { effortSnapshot }),
    catch: (cause) => catalogError(sources.join(", "), cause),
  });
  yield* catalogIo(path, () => writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`));
  yield* ensureWorkflowWorkersModule(prismHome);
  return catalog;
});

export const renderWorkflowWorkersHuman = (catalog: WorkflowWorkerCatalog): string => {
  if (catalog.workers.length === 0) {
    return "No named workers installed. Install a portable catalog: `prism workflow workers install ./workers.json`. Raw worker configurations remain available.";
  }
  return [
    'Import { workers } from "prism/refs/workers"; select a worker by its description, without choosing its harness/model again.',
    "",
    ...catalog.workers.flatMap(({ name, description, config }) => [
      `- \`${namedWorkerRef(name)}\` — ${description}`,
      `  Configuration: \`${JSON.stringify(config)}\``,
    ]),
  ].join("\n");
};
