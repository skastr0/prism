import { Effect, Schema } from "effect";
import type { Either } from "effect/Either";
import type { ParseError } from "effect/ParseResult";
import type { WorkflowRuntimeError } from "./workflow-errors.js";
import { workflowHarnessDefaultModel, workflowHarnessDefaultProvider } from "./workflow-harness-detection.js";

export type { WorkflowRuntimeError } from "./workflow-errors.js";

export interface WorkflowModelRef {
  readonly modelspace?: string;
  readonly profile?: string;
  readonly targets?: Readonly<Record<string, WorkflowModelTarget>>;
}

export type WorkflowModelTarget = Readonly<Record<string, unknown>>;

export interface WorkflowModelspaceRef {
  readonly kind: "modelspace-ref";
  readonly plugin: string;
  readonly modelspace: string;
}

export interface WorkflowModelProfileRef {
  readonly kind: "model-profile-ref";
  readonly plugin: string;
  readonly modelspace: string;
  readonly profile: string;
  readonly targets?: Readonly<Record<string, WorkflowModelTarget>>;
}

export interface WorkflowManagedSkillRef {
  readonly kind: "managed-skill-ref";
  readonly plugin: string;
  readonly name: string;
}

export interface WorkflowSkillspaceRef {
  readonly kind: "skillspace-ref";
  readonly plugin: string;
  readonly skillspace: string;
  readonly skills: ReadonlyArray<string>;
}

export interface WorkflowAgentRef {
  readonly kind: "agent-ref";
  readonly plugin: string;
  readonly name: string;
  readonly description: string;
  readonly sourceHash: string;
  readonly manifestHash: string;
  readonly model?: WorkflowModelRef;
  readonly installs: ReadonlyArray<string>;
}

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

export type WorkflowOutputSchema = Schema.Schema.AnyNoContext;

export type WorkflowFinishCriterionError = Error;

export type WorkflowWorkerId =
  | "amp-code"
  | "antigravity-cli"
  | "claude-code"
  | "codex-cli"
  | "grok"
  | "hermes"
  | "kimi-code"
  | "opencode";

export type WorkflowPermissionMode =
  | "legacy"
  | "permissive"
  | "restricted"
  | "interactive"
  | "sandbox-read-only"
  | "sandbox-workspace-write"
  | "full-access";

export type AntigravityWorkflowPermissionMode = Extract<WorkflowPermissionMode, "legacy" | "permissive" | "full-access">;

type WorkflowTaskWorkerOptionsBase = {
  readonly model?: string | WorkflowModelProfileRef;
  readonly modelResolver?: (models: WorkflowResolvedModelTarget) => string;
  readonly profile?: string;
  readonly restrictedTools?: ReadonlyArray<string>;
  readonly processTimeoutMs?: number;
};

export type WorkflowTaskWorkerOptions =
  | (WorkflowTaskWorkerOptionsBase & {
    readonly worker?: Exclude<WorkflowWorkerId, "antigravity-cli">;
    readonly permission?: WorkflowPermissionMode;
  })
  | (WorkflowTaskWorkerOptionsBase & {
    readonly worker: "antigravity-cli";
    readonly permission?: AntigravityWorkflowPermissionMode;
  });

export type WorkflowResolvedModelEntry = Readonly<{ readonly model: string }>;

export type WorkflowResolvedModelTarget = Readonly<Record<string, WorkflowResolvedModelEntry | WorkflowResolvedModelEntry[]>>;

export class WorkflowModelResolutionError extends Error {
  override readonly name = "WorkflowModelResolutionError";
}

const isWorkflowModelProfileRef = (value: unknown): value is WorkflowModelProfileRef =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly kind?: unknown }).kind === "model-profile-ref" &&
  typeof (value as { readonly plugin?: unknown }).plugin === "string" &&
  typeof (value as { readonly modelspace?: unknown }).modelspace === "string" &&
  typeof (value as { readonly profile?: unknown }).profile === "string";

const modelTargetForWorker = (
  ref: WorkflowModelProfileRef | WorkflowModelRef,
  worker: string | undefined,
): WorkflowModelTarget | undefined => {
  if (worker === undefined) {
    throw new WorkflowModelResolutionError(
      `cannot resolve modelspace profile ${"plugin" in ref ? `${ref.plugin}:` : ""}${ref.modelspace ?? "<unknown>"}/${ref.profile ?? "<unknown>"} without a workflow worker`,
    );
  }
  return ref.targets?.[worker];
};

const firstModelString = (target: WorkflowModelTarget | undefined): string | undefined =>
  firstModelChoice(target)?.model;

/** First concrete {model, provider?} pair in a modelspace target (direct or ordered-list form). */
const firstModelChoice = (
  target: WorkflowModelTarget | undefined,
): { readonly model: string; readonly provider?: string } | undefined => {
  if (target === undefined) return undefined;
  const direct = target.model;
  if (typeof direct === "string" && direct.length > 0) {
    return { model: direct, ...(typeof target.provider === "string" ? { provider: target.provider } : {}) };
  }
  const models = target.models;
  if (Array.isArray(models)) {
    for (const candidate of models) {
      if (typeof candidate === "object" && candidate !== null) {
        const entry = candidate as { readonly model?: unknown; readonly provider?: unknown };
        if (typeof entry.model === "string" && entry.model.length > 0) {
          return { model: entry.model, ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}) };
        }
      }
    }
  }
  return undefined;
};

const describeModelRef = (ref: WorkflowModelProfileRef | WorkflowModelRef): string => {
  const plugin = "plugin" in ref ? `${ref.plugin}:` : "";
  return `${plugin}${ref.modelspace ?? "<unknown>"}/${ref.profile ?? "<unknown>"}`;
};

const identityKeyFromModel = (modelSlug: string): string => {
  const bare = modelSlug.includes("/")
    ? modelSlug.split("/").pop() ?? modelSlug
    : modelSlug;
  const parts = bare
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "model";
  const [first, ...rest] = parts;
  return [
    first![0]!.toLowerCase() + first!.slice(1),
    ...rest.map((part) => part[0]!.toUpperCase() + part.slice(1)),
  ].join("");
};

const resolveModelTargetForPicker = (
  target: WorkflowModelTarget,
): WorkflowResolvedModelTarget => {
  const result: Record<string, WorkflowResolvedModelEntry | WorkflowResolvedModelEntry[]> = {};

  const direct = target.model;
  if (typeof direct === "string" && direct.length > 0) {
    result[identityKeyFromModel(direct)] = { model: direct };
  }

  const models = target.models;
  if (Array.isArray(models)) {
    const byKey: Record<string, WorkflowResolvedModelEntry[]> = {};
    for (const candidate of models) {
      if (typeof candidate === "object" && candidate !== null) {
        const model = (candidate as { readonly model?: unknown }).model;
        if (typeof model === "string" && model.length > 0) {
          const key = identityKeyFromModel(model);
          if (!byKey[key]) byKey[key] = [];
          byKey[key].push({ model });
        }
      }
    }
    for (const [key, entries] of Object.entries(byKey)) {
      if (entries.length === 1) {
        result[key] = entries[0]!;
      } else {
        result[key] = entries;
      }
    }
  }

  return result;
};

export type WorkflowTaskModelResolutionSource = "task" | "profile" | "default" | "cli-fallback";

export interface WorkflowTaskModelResolution {
  readonly model: string;
  /** Harness-side inference provider (e.g. hermes `--provider xai-oauth`), from the modelspace target or harness default. */
  readonly provider?: string;
  readonly source: WorkflowTaskModelResolutionSource;
}

/**
 * Resolves the CLI --model fallback (if supplied); otherwise the harness's
 * cheap-fast registry default (workflow-harness-detection.ts). CLI intent
 * always wins over the baked-in default when both are available.
 *
 * Intentionally NOT consulted by the final catch-all below: a task with no
 * task/profile/agent model info at all resolves to `undefined` there (as
 * before this change) so per-worker CLIs that tolerate an omitted --model
 * flag (e.g. opencode) keep doing so. The registry default only rescues the
 * agent-modelspace branch, whose ref exists but doesn't cover this worker —
 * the concrete "no concrete model for workflow worker X" crash this exists
 * to fix (see WDX-009).
 */
const resolveFallbackModel = (
  worker: string | undefined,
  fallbackModel: string | undefined,
): WorkflowTaskModelResolution | undefined => {
  if (fallbackModel !== undefined) return { model: fallbackModel, source: "cli-fallback" };
  const defaultModel = worker !== undefined ? workflowHarnessDefaultModel(worker) : undefined;
  if (defaultModel === undefined) return undefined;
  const defaultProvider = worker !== undefined ? workflowHarnessDefaultProvider(worker) : undefined;
  return { model: defaultModel, ...(defaultProvider !== undefined ? { provider: defaultProvider } : {}), source: "default" };
};

export const resolveWorkflowTaskModelResolution = (
  task: AnyWorkflowTask,
  options: { readonly worker?: string; readonly fallbackModel?: string } = {},
): WorkflowTaskModelResolution | undefined => {
  const explicit = task.worker?.model;
  if (typeof explicit === "string") return { model: explicit, source: "task" };

  const worker = task.worker?.worker ?? options.worker;
  if (isWorkflowModelProfileRef(explicit)) {
    const target = modelTargetForWorker(explicit, worker);
    const choice = firstModelChoice(target);
    if (choice !== undefined) return { ...choice, source: "task" };
    throw new WorkflowModelResolutionError(
      `modelspace profile ${describeModelRef(explicit)} has no concrete model for workflow worker '${worker ?? "<missing>"}'`,
    );
  }

  if (task.worker?.modelResolver !== undefined) {
    const agentTarget = task.agent.model?.targets?.[worker ?? ""];
    if (agentTarget === undefined) {
      throw new WorkflowModelResolutionError(
        `agent ${task.agent.plugin}:${task.agent.name} has no model target for worker '${worker ?? "<missing>"}' — cannot resolve modelResolver`,
      );
    }
    const resolved = resolveModelTargetForPicker(agentTarget);
    const picked = task.worker.modelResolver(resolved);
    if (typeof picked === "string" && picked.length > 0) return { model: picked, source: "task" };
    throw new WorkflowModelResolutionError(
      `modelResolver for agent ${task.agent.plugin}:${task.agent.name} returned an invalid model string for worker '${worker ?? "<missing>"}'`,
    );
  }

  if (task.agent.model?.modelspace !== undefined || task.agent.model?.profile !== undefined) {
    const target = modelTargetForWorker(task.agent.model, worker);
    const choice = firstModelChoice(target);
    if (choice !== undefined) return { ...choice, source: "profile" };
    const fallback = resolveFallbackModel(worker, options.fallbackModel);
    if (fallback !== undefined) return fallback;
    throw new WorkflowModelResolutionError(
      `agent ${task.agent.plugin}:${task.agent.name} modelspace profile ${describeModelRef(task.agent.model ?? {})} has no concrete model for workflow worker '${worker ?? "<missing>"}'`,
    );
  }

  return options.fallbackModel !== undefined ? { model: options.fallbackModel, source: "cli-fallback" } : undefined;
};

export const resolveWorkflowTaskModel = (
  task: AnyWorkflowTask,
  options: { readonly worker?: string; readonly fallbackModel?: string } = {},
): string | undefined => resolveWorkflowTaskModelResolution(task, options)?.model;

export interface WorkflowFinishCriterionContext<Output> {
  readonly output: Output;
  readonly rawOutput: unknown;
  readonly metadata?: Record<string, unknown>;
}

export interface WorkflowDeterministicFinishCriterion<Output> {
  readonly kind?: "deterministic";
  readonly name: string;
  readonly check: (context: WorkflowFinishCriterionContext<Output>) => Effect.Effect<void, WorkflowFinishCriterionError>;
  readonly repairPrompt?: (error: unknown, context: WorkflowFinishCriterionContext<Output>) => string;
}

export type WorkflowJudgeVerdict =
  | { readonly verdict: "pass"; readonly feedback?: string; readonly metadata?: Record<string, unknown> }
  | { readonly verdict: "continue"; readonly feedback: string; readonly metadata?: Record<string, unknown> }
  | { readonly verdict: "fail"; readonly feedback?: string; readonly metadata?: Record<string, unknown> }
  | { readonly verdict: "escalate"; readonly feedback?: string; readonly metadata?: Record<string, unknown> };

export interface WorkflowJudgeTaskMetadata {
  readonly id: string;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly cacheKey?: string;
  readonly worker?: WorkflowTaskWorkerOptions;
}

export interface WorkflowJudgeEvidenceSelectionContext<Output> {
  readonly goal: string;
  readonly output: Output;
  readonly metadata?: Record<string, unknown>;
  readonly task: WorkflowJudgeTaskMetadata;
}

export interface WorkflowJudgeCriterionContext<Output, Evidence = unknown> extends WorkflowJudgeEvidenceSelectionContext<Output> {
  readonly evidence: Evidence;
}

export interface WorkflowJudgeFinishCriterion<Output, Evidence = unknown> {
  readonly kind: "judge";
  readonly name: string;
  readonly goal?: string | ((context: Omit<WorkflowJudgeEvidenceSelectionContext<Output>, "goal">) => string);
  readonly selectEvidence?: (context: WorkflowJudgeEvidenceSelectionContext<Output>) => Evidence;
  readonly evaluate: (context: WorkflowJudgeCriterionContext<Output, Evidence>) => Effect.Effect<WorkflowJudgeVerdict, WorkflowFinishCriterionError>;
}

export type WorkflowFinishCriterion<Output> =
  | WorkflowDeterministicFinishCriterion<Output>
  | WorkflowJudgeFinishCriterion<Output>;

export interface WorkflowFinishOptions<Output> {
  readonly maxRepairs?: number;
  readonly criteria?: ReadonlyArray<WorkflowFinishCriterion<Output>>;
}

export interface WorkflowTaskDefinition<
  Id extends string,
  Agent extends WorkflowAgentRef,
  Output extends WorkflowOutputSchema,
> {
  readonly id: Id;
  readonly agent: Agent;
  readonly prompt: string;
  readonly output: Output;
  readonly phase?: string;
  readonly cacheKey?: string;
  readonly worker?: WorkflowTaskWorkerOptions;
  readonly finish?: WorkflowFinishOptions<Schema.Schema.Type<Output>>;
}

export interface WorkflowTask<
  Id extends string = string,
  Agent extends WorkflowAgentRef = WorkflowAgentRef,
  Output extends WorkflowOutputSchema = WorkflowOutputSchema,
> extends WorkflowTaskDefinition<Id, Agent, Output> {
  readonly kind: "workflow-task";
}

export type AnyWorkflowTask = WorkflowTask<string, WorkflowAgentRef, WorkflowOutputSchema>;

export type WorkflowTaskOutput<Task extends AnyWorkflowTask> = Schema.Schema.Type<Task["output"]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const isWorkflowAgentRef = (value: unknown): value is WorkflowAgentRef =>
  isRecord(value) &&
  value.kind === "agent-ref" &&
  typeof value.plugin === "string" &&
  typeof value.name === "string" &&
  typeof value.description === "string" &&
  typeof value.sourceHash === "string" &&
  typeof value.manifestHash === "string" &&
  isStringArray(value.installs);

export const isWorkflowTask = (value: unknown): value is AnyWorkflowTask =>
  isRecord(value) &&
  value.kind === "workflow-task" &&
  typeof value.id === "string" &&
  isWorkflowAgentRef(value.agent) &&
  typeof value.prompt === "string" &&
  Schema.isSchema(value.output) &&
  (value.cacheKey === undefined || typeof value.cacheKey === "string");

export interface WorkflowDefinition<Name extends string, Tasks extends ReadonlyArray<AnyWorkflowTask>> {
  readonly kind: "workflow";
  readonly name: Name;
  readonly tasks: Tasks;
}

export interface WorkflowRuntime {
  runTask: <Task extends AnyWorkflowTask>(task: Task) => Effect.Effect<WorkflowTaskOutput<Task>, WorkflowRuntimeError>;
}

export interface WorkflowRuntimeOptions {
  readonly fallbackWorker?: string;
  readonly fallbackModel?: string;
  readonly fallbackPermission?: WorkflowPermissionMode;
}

export interface DynamicWorkflowDefinition<
  Name extends string,
  Result = unknown,
  Err = WorkflowRuntimeError,
> {
  readonly kind: "workflow";
  readonly name: Name;
  readonly tasks: readonly [];
  readonly run: (runtime: WorkflowRuntime) => Effect.Effect<Result, Err, never>;
}

export type AnyWorkflowDefinition =
  | WorkflowDefinition<string, ReadonlyArray<AnyWorkflowTask>>
  | DynamicWorkflowDefinition<string>;

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

export const defineTask = <
  const Id extends string,
  const Agent extends WorkflowAgentRef,
  const Output extends WorkflowOutputSchema,
>(definition: WorkflowTaskDefinition<Id, Agent, Output>): WorkflowTask<Id, Agent, Output> => ({
  kind: "workflow-task",
  ...definition,
});

export function defineWorkflow<const Name extends string, const Tasks extends ReadonlyArray<AnyWorkflowTask>>(
  definition: { readonly name: Name; readonly tasks: Tasks },
): WorkflowDefinition<Name, Tasks>;
export function defineWorkflow<const Name extends string, Result, Err = WorkflowRuntimeError>(
  definition: {
    readonly name: Name;
    readonly run: (runtime: WorkflowRuntime) => Effect.Effect<Result, Err, never>;
  },
): DynamicWorkflowDefinition<Name, Result, Err>;
export function defineWorkflow<const Name extends string, Result, Err = WorkflowRuntimeError>(
  definition:
    | { readonly name: Name; readonly tasks: ReadonlyArray<AnyWorkflowTask> }
    | {
      readonly name: Name;
      readonly run: (runtime: WorkflowRuntime) => Effect.Effect<Result, Err, never>;
    },
): WorkflowDefinition<Name, ReadonlyArray<AnyWorkflowTask>> | DynamicWorkflowDefinition<Name, Result, Err> {
  if ("run" in definition) {
    return {
      kind: "workflow",
      name: definition.name,
      tasks: [],
      run: definition.run,
    };
  }
  return {
  kind: "workflow",
  ...definition,
  };
}

export const decodeTaskOutput = <Task extends AnyWorkflowTask>(
  task: Task,
  value: unknown,
): Either<Schema.Schema.Type<Task["output"]>, ParseError> =>
  Schema.decodeUnknownEither(task.output)(value);
