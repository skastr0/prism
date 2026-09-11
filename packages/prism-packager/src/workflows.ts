import { Effect, Schema } from "effect";
import { isLeft } from "effect/Either";
import type { Either } from "effect/Either";
import type { ParseError } from "effect/ParseResult";
import { WorkflowTaskInputError, type WorkflowRuntimeError } from "./workflow-errors.js";
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
  | "cursor"
  | "devin"
  | "grok"
  | "hermes"
  | "kimi-code"
  | "opencode"
  | "omp";

/**
 * Per-harness model identifier map. Empty in core so `worker.model` stays
 * `string` until `prism workflow refresh-harness-types` augments keys with
 * live unions. Do not pre-declare `string` properties here — interface
 * merging cannot narrow `string` to a slug union.
 */
export interface WorkflowHarnessModelMap {}

/**
 * Amp catalog `provider/model` ids from `show-agent-options`. Empty in core;
 * refresh augments `"amp-code"` for `worker.catalogModel`.
 */
export interface WorkflowHarnessCatalogModelMap {}

/**
 * Amp reasoning-effort ladders from the catalog. Empty in core; refresh
 * augments `"amp-code"` for `worker.effort`.
 */
export interface WorkflowHarnessEffortMap {}

export type WorkflowHarnessModel<W extends WorkflowWorkerId> =
  | (W extends keyof WorkflowHarnessModelMap ? WorkflowHarnessModelMap[W] : string)
  | WorkflowModelProfileRef;

export type WorkflowHarnessCatalogModel<W extends WorkflowWorkerId> =
  W extends keyof WorkflowHarnessCatalogModelMap ? WorkflowHarnessCatalogModelMap[W] : string;

export type WorkflowHarnessEffort<W extends WorkflowWorkerId> =
  W extends keyof WorkflowHarnessEffortMap ? WorkflowHarnessEffortMap[W] : string;

/** Plugin-free agent stub so a workflow can dispatch a worker without `prism/refs`. */
export const anonymousWorkflowAgent = {
  kind: "agent-ref",
  plugin: "prism",
  name: "anonymous",
  description: "Plugin-free workflow worker (no compiled Prism agent).",
  sourceHash: "0".repeat(64),
  manifestHash: "0".repeat(64),
  installs: [] as const,
} as const satisfies WorkflowAgentRef;

export const isAnonymousWorkflowAgent = (agent: {
  readonly plugin: string;
  readonly name: string;
}): boolean => agent.plugin === "prism" && agent.name === "anonymous";

export type WorkflowPermissionMode =
  | "legacy"
  | "permissive"
  | "restricted"
  | "interactive"
  | "sandbox-read-only"
  | "sandbox-workspace-write"
  | "full-access";

/** Workers with no sandbox flag and no per-invocation allowlist. */
export type WorkflowDialPermissionMode = Extract<
  WorkflowPermissionMode,
  "legacy" | "permissive" | "full-access"
>;

export type AntigravityWorkflowPermissionMode = WorkflowDialPermissionMode;

export type ClaudeWorkflowPermissionMode = Extract<
  WorkflowPermissionMode,
  "legacy" | "permissive" | "restricted" | "full-access"
>;

export type CodexWorkflowPermissionMode = Extract<
  WorkflowPermissionMode,
  "legacy" | "permissive" | "full-access" | "sandbox-read-only" | "sandbox-workspace-write"
>;

export type CursorWorkflowPermissionMode = Extract<
  WorkflowPermissionMode,
  "legacy" | "permissive" | "full-access" | "sandbox-workspace-write"
>;

export type DevinWorkflowPermissionMode = Extract<
  WorkflowPermissionMode,
  "legacy" | "permissive" | "restricted" | "full-access"
>;

export type OmpWorkflowPermissionMode = Extract<
  WorkflowPermissionMode,
  "legacy" | "permissive" | "restricted" | "full-access"
>;

export type WorkflowWorkerPermissionMode<W extends WorkflowWorkerId> =
  W extends "claude-code" ? ClaudeWorkflowPermissionMode
    : W extends "codex-cli" ? CodexWorkflowPermissionMode
      : W extends "cursor" ? CursorWorkflowPermissionMode
        : W extends "devin" ? DevinWorkflowPermissionMode
          : W extends "omp" ? OmpWorkflowPermissionMode
            : WorkflowDialPermissionMode;

export const WORKFLOW_SESSION_PERSISTENCE_WORKERS = [
  "claude-code",
  "codex-cli",
  "omp",
] as const satisfies ReadonlyArray<WorkflowWorkerId>;

export type WorkflowSessionPersistenceWorkerId =
  typeof WORKFLOW_SESSION_PERSISTENCE_WORKERS[number];

export type WorkflowSessionPersistence = "persistent" | "ephemeral";

/** @deprecated Use WorkflowSessionPersistence. */
export type CodexWorkflowSessionPersistence = WorkflowSessionPersistence;

export const workflowWorkerSupportsSessionPersistence = (
  worker: unknown,
): worker is WorkflowSessionPersistenceWorkerId =>
  typeof worker === "string"
  && (WORKFLOW_SESSION_PERSISTENCE_WORKERS as readonly string[]).includes(worker);

/**
 * Per-task override for the executor-level transient-failure retry (WFE-009). Only
 * classified-transient executor failures (process/idle timeout, unclassified non-zero
 * exit) are retried; config/load errors and cancellation-barrier outcomes never are.
 * `maxAttempts` counts total attempts (default 2, i.e. one retry) — the same convention
 * as the shipped `agy` adapter's own `maxAttempts` option.
 */
export interface WorkflowTaskWorkerRetryOptions {
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
}

type WorkflowTaskWorkerOptionsCommon<W extends WorkflowWorkerId = WorkflowWorkerId> = {
  readonly model?: WorkflowHarnessModel<W>;
  readonly modelResolver?: (models: WorkflowResolvedModelTarget) => string;
  readonly profile?: string;
  readonly restrictedTools?: ReadonlyArray<string>;
  readonly retry?: WorkflowTaskWorkerRetryOptions;
};

type WorkflowTaskWorkerOptionsFor<W extends WorkflowWorkerId> =
  WorkflowTaskWorkerOptionsCommon<W> & {
    readonly worker: W;
    readonly permission?: WorkflowWorkerPermissionMode<W>;
  } & (W extends "amp-code"
    ? {
      readonly sessionPersistence?: never;
      readonly catalogModel?: WorkflowHarnessCatalogModel<"amp-code">;
      readonly effort?: WorkflowHarnessEffort<"amp-code">;
    }
    : W extends WorkflowSessionPersistenceWorkerId
      ? { readonly sessionPersistence?: WorkflowSessionPersistence }
      : { readonly sessionPersistence?: never });

export type WorkflowTaskWorkerOptions =
  | (WorkflowTaskWorkerOptionsCommon & {
    readonly worker?: undefined;
    readonly permission?: WorkflowPermissionMode;
    readonly sessionPersistence?: never;
  })
  | {
    [W in WorkflowWorkerId]: WorkflowTaskWorkerOptionsFor<W>;
  }[WorkflowWorkerId];

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
): { readonly model: string; readonly provider?: string; readonly variant?: string } | undefined => {
  if (target === undefined) return undefined;
  const direct = target.model;
  if (typeof direct === "string" && direct.length > 0) {
    return {
      model: direct,
      ...(typeof target.provider === "string" ? { provider: target.provider } : {}),
      ...(typeof target.variant === "string" ? { variant: target.variant } : {}),
    };
  }
  const models = target.models;
  if (Array.isArray(models)) {
    for (const candidate of models) {
      if (typeof candidate === "object" && candidate !== null) {
        const entry = candidate as {
          readonly model?: unknown;
          readonly provider?: unknown;
          readonly variant?: unknown;
        };
        if (typeof entry.model === "string" && entry.model.length > 0) {
          return {
            model: entry.model,
            ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
            ...(typeof entry.variant === "string" ? { variant: entry.variant } : {}),
          };
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
  /** Harness-bound model variant, such as Codex reasoning effort. */
  readonly variant?: string;
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
    if (task.agent === undefined) {
      throw new WorkflowModelResolutionError(
        `task '${task.id}' declares worker.modelResolver but no agent; a modelResolver picks from an agent's model targets — pass worker.model directly instead`,
      );
    }
    const agentTarget = task.agent.model?.targets?.[worker ?? ""];
    if (agentTarget === undefined) {
      throw new WorkflowModelResolutionError(
        `agent ${task.agent.plugin}:${task.agent.name} has no model target for worker '${worker ?? "<missing>"}' — cannot resolve modelResolver`,
      );
    }
    const resolved = resolveModelTargetForPicker(agentTarget);
    const picked = task.worker.modelResolver(resolved);
    if (typeof picked === "string" && picked.length > 0)
      return { model: picked, source: "task" };
    throw new WorkflowModelResolutionError(
      `modelResolver for agent ${task.agent.plugin}:${task.agent.name} returned an invalid model string for worker '${worker ?? "<missing>"}'`,
    );
  }

  if (task.agent?.model?.modelspace !== undefined || task.agent?.model?.profile !== undefined) {
    const target = modelTargetForWorker(task.agent.model, worker);
    const choice = firstModelChoice(target);
    if (choice !== undefined) return { ...choice, source: "profile" };
    const fallback = resolveFallbackModel(worker, options.fallbackModel);
    if (fallback !== undefined) return fallback;
    throw new WorkflowModelResolutionError(
      `agent ${task.agent.plugin}:${task.agent.name} modelspace profile ${describeModelRef(task.agent.model ?? {})} has no concrete model for workflow worker '${worker ?? "<missing>"}'`,
    );
  }

  return options.fallbackModel !== undefined
    ? { model: options.fallbackModel, source: "cli-fallback" }
    : undefined;
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

export const DEFAULT_WORKFLOW_DECODE_REPAIRS = 2;

export interface WorkflowFinishOptions<Output> {
  /** Maximum repairs requested by deterministic or judge finish criteria. Defaults to zero. */
  readonly maxRepairs?: number;
  /**
   * Maximum repairs after JSON parse or output schema decode failures.
   * Defaults to DEFAULT_WORKFLOW_DECODE_REPAIRS.
   */
  readonly maxDecodeRepairs?: number;
  readonly criteria?: ReadonlyArray<WorkflowFinishCriterion<Output>>;
}

export interface WorkflowTaskDefinition<
  Id extends string,
  Output extends WorkflowOutputSchema,
> {
  readonly id: Id;
  /**
   * Optional executor identity. A task may run on a bare worker with a prompt
   * and a model; `defineTask` normalizes a missing agent to
   * {@link anonymousWorkflowAgent}, so runtime tasks always carry one.
   */
  readonly agent?: WorkflowAgentRef;
  readonly prompt: string;
  readonly output: Output;
  readonly phase?: string;
  readonly cacheKey?: string;
  readonly worker?: WorkflowTaskWorkerOptions;
  readonly finish?: WorkflowFinishOptions<Schema.Schema.Type<Output>>;
}

export type WorkflowTask<
  Id extends string = string,
  Output extends WorkflowOutputSchema = WorkflowOutputSchema,
> = WorkflowTaskDefinition<Id, Output> & {
  readonly kind: "workflow-task";
  readonly agent: WorkflowAgentRef;
};

export type AnyWorkflowTask = WorkflowTask<string, WorkflowOutputSchema>;

export type WorkflowTaskOutput<Task extends AnyWorkflowTask> = Schema.Schema.Type<Task["output"]>;

export const resolveWorkflowTaskSessionPersistence = (
  task: Pick<AnyWorkflowTask, "worker">,
  effectiveWorker: string | undefined = task.worker?.worker,
): WorkflowSessionPersistence | undefined => {
  if (!workflowWorkerSupportsSessionPersistence(effectiveWorker)) return undefined;
  if (task.worker?.worker !== effectiveWorker) return "persistent";
  return task.worker.sessionPersistence ?? "persistent";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const hasValidWorkflowTaskSessionPersistence = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const sessionPersistence = value.sessionPersistence;
  if (sessionPersistence === undefined) return true;
  return workflowWorkerSupportsSessionPersistence(value.worker)
    && (sessionPersistence === "persistent" || sessionPersistence === "ephemeral");
};

export const assertWorkflowTaskSessionPersistence = (task: AnyWorkflowTask): void => {
  const worker = task.worker as unknown;
  if (hasValidWorkflowTaskSessionPersistence(worker)) return;
  if (
    isRecord(worker)
    && workflowWorkerSupportsSessionPersistence(worker.worker)
  ) {
    throw new TypeError(
      `workflow task '${task.id}' worker.sessionPersistence must be 'persistent' or 'ephemeral'`,
    );
  }
  throw new TypeError(
    `workflow task '${task.id}' worker.sessionPersistence is supported only for workers ${WORKFLOW_SESSION_PERSISTENCE_WORKERS.map((workerId) => `'${workerId}'`).join(", ")}`,
  );
};

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
  (value.cacheKey === undefined || typeof value.cacheKey === "string") &&
  hasValidWorkflowTaskSessionPersistence(value.worker);

export interface WorkflowDefinition<Name extends string, Tasks extends ReadonlyArray<AnyWorkflowTask>> {
  readonly kind: "workflow";
  readonly name: Name;
  readonly tasks: Tasks;
}

export interface PhaseFraming {
  readonly purpose?: string;
  readonly when?: string;
  readonly escalation?: string;
}

/**
 * A SOP phase contract. The generated `sops.<plugin>.<sop>.phases.<phase>`
 * value from `prism/refs/sops` satisfies this shape directly: `name`, `sop`,
 * `plugin`, optional `input`/`output` schemas, optional `criteria`, and
 * optional `framing`.
 */
export interface PhaseContract<
  Name extends string,
  Input extends WorkflowOutputSchema | undefined,
  Output extends WorkflowOutputSchema | undefined,
> {
  readonly name: Name;
  readonly sop: string;
  readonly plugin: string;
  readonly input?: Input;
  readonly output?: Output;
  readonly criteria?: readonly string[];
  readonly framing?: PhaseFraming;
}

export type PhaseTaskFinishOptions<Output> = WorkflowFinishOptions<Output> & {
  readonly inherit?: boolean;
};

/** Decoded TypeScript value of a phase input contract (unknown when no contract). */
export type PhaseTaskInputValue<Input extends WorkflowOutputSchema | undefined> =
  Input extends WorkflowOutputSchema ? Schema.Schema.Type<Input> : unknown;

export type PhaseTaskDefinition<
  Id extends string,
  Input extends WorkflowOutputSchema | undefined = undefined,
  Output extends WorkflowOutputSchema = WorkflowOutputSchema,
> = Omit<WorkflowTaskDefinition<Id, Output>, "output" | "phase" | "finish"> & {
  readonly input?: PhaseTaskInputValue<Input>;
  readonly output?: Output;
  readonly phase?: string;
  readonly finish?: PhaseTaskFinishOptions<Schema.Schema.Type<Output>>;
  readonly brief?: boolean;
};

export type PhaseCtxTask<
  Input extends WorkflowOutputSchema | undefined,
  DefaultOutput extends WorkflowOutputSchema | undefined,
> = <
  const Id extends string,
  const TaskOutput extends WorkflowOutputSchema = Extract<DefaultOutput, WorkflowOutputSchema>,
>(
  def: PhaseTaskDefinition<Id, Input, TaskOutput>,
) => Effect.Effect<WorkflowTaskOutput<WorkflowTask<Id, TaskOutput>>, WorkflowRuntimeError>;

export interface PhaseCtx<
  Name extends string,
  Input extends WorkflowOutputSchema | undefined,
  DefaultOutput extends WorkflowOutputSchema | undefined,
> {
  readonly name: Name;
  readonly sop: string;
  readonly plugin: string;
  readonly phase: string;
  readonly task: PhaseCtxTask<Input, DefaultOutput>;
}

type AnyPhaseContract = PhaseContract<
  string,
  WorkflowOutputSchema | undefined,
  WorkflowOutputSchema | undefined
>;

const composePhaseFramingPreamble = (
  contract: AnyPhaseContract,
  prompt: string,
): string => {
  const framing = contract.framing;
  if (framing === undefined) return prompt;
  const lines: string[] = [];
  if (framing.purpose !== undefined) lines.push(`Purpose: ${framing.purpose}`);
  if (framing.when !== undefined) lines.push(`When: ${framing.when}`);
  if (framing.escalation !== undefined) lines.push(`Escalation: ${framing.escalation}`);
  if (lines.length === 0) return prompt;
  return `## Phase ${contract.sop}:${contract.name}\n${lines.join("\n")}\n\n${prompt}`;
};

const renderPhaseInputBlock = (value: unknown): string =>
  ["## Input", "", "```json", JSON.stringify(value, null, 2), "```"].join("\n");

const isSubstantiveWorkflowValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0 && value.some(isSubstantiveWorkflowValue);
  if (typeof value === "object") return Object.values(value).some(isSubstantiveWorkflowValue);
  return true;
};

const defaultPhaseJudgeCriterion = <Output>(
  criteria: readonly string[],
): WorkflowJudgeFinishCriterion<Output> => ({
  kind: "judge",
  name: "phase-contract",
  goal: criteria.join("\n"),
  selectEvidence: ({ output }) => ({ output }),
  evaluate: (context) =>
    isSubstantiveWorkflowValue(context.output)
      ? Effect.succeed({ verdict: "pass" as const })
      : Effect.succeed({
          verdict: "fail" as const,
          feedback: `Phase output is empty or trivial. Satisfy the phase finish criteria:\n${context.goal}`,
        }),
});

const mergePhaseTaskFinish = <Output>(
  contract: AnyPhaseContract,
  authorFinish: PhaseTaskFinishOptions<Output> | undefined,
): WorkflowFinishOptions<Output> | undefined => {
  const inherit = authorFinish?.inherit !== false;
  const { inherit: _inherit, criteria: authorCriteria, ...restFinish } = authorFinish ?? {};
  const inheritedCriteria =
    inherit && contract.criteria !== undefined && contract.criteria.length > 0
      ? [defaultPhaseJudgeCriterion<Output>(contract.criteria)]
      : [];
  const mergedCriteria = [...inheritedCriteria, ...(authorCriteria ?? [])];
  if (
    mergedCriteria.length === 0 &&
    restFinish.maxRepairs === undefined &&
    restFinish.maxDecodeRepairs === undefined
  ) return undefined;
  return {
    ...restFinish,
    ...(mergedCriteria.length > 0 ? { criteria: mergedCriteria } : {}),
  };
};

const createPhaseCtx = <
  const Name extends string,
  const Input extends WorkflowOutputSchema | undefined,
  const Output extends WorkflowOutputSchema | undefined,
>(
  runtime: Pick<WorkflowRuntime, "runTask">,
  contract: PhaseContract<Name, Input, Output>,
  phaseKey: string,
): PhaseCtx<Name, Input, Output> => {
  const task: PhaseCtxTask<Input, Output> = (def) => {
    const {
      brief,
      finish: authorFinish,
      output: outputOverride,
      phase: phaseOverride,
      input: taskInput,
      ...rest
    } = def;
    const output = outputOverride ?? contract.output;
    if (output === undefined) {
      throw new Error(
        `phase '${phaseKey}' declares no output schema; declare one on the SOP phase or pass \`output\` to ctx.task()`,
      );
    }

    let inputBlock = "";
    if (contract.input !== undefined) {
      const decoded = Schema.decodeUnknownEither(contract.input)(taskInput);
      if (isLeft(decoded)) {
        return Effect.fail(new WorkflowTaskInputError(phaseKey, decoded.left));
      }
      inputBlock = renderPhaseInputBlock(decoded.right);
    } else if (taskInput !== undefined) {
      inputBlock = renderPhaseInputBlock(taskInput);
    }

    const framedPrompt = brief === false
      ? rest.prompt
      : composePhaseFramingPreamble(contract, rest.prompt);
    const prompt = inputBlock.length > 0 ? `${framedPrompt}\n\n${inputBlock}` : framedPrompt;
    const finish = mergePhaseTaskFinish(
      contract,
      authorFinish as PhaseTaskFinishOptions<unknown> | undefined,
    );
    const workflowTask = defineTask({
      ...rest,
      prompt,
      output,
      phase: phaseOverride ?? phaseKey,
      ...(finish !== undefined ? { finish } : {}),
    } as WorkflowTaskDefinition<string, WorkflowOutputSchema>);
    return runtime.runTask(workflowTask) as Effect.Effect<WorkflowTaskOutput<AnyWorkflowTask>, WorkflowRuntimeError>;
  };

  return {
    name: contract.name,
    sop: contract.sop,
    plugin: contract.plugin,
    phase: phaseKey,
    task,
  };
};

export const phase = <
  const Name extends string,
  const Input extends WorkflowOutputSchema | undefined,
  const Output extends WorkflowOutputSchema | undefined,
  Result,
  Err = WorkflowRuntimeError,
>(
  runtime: Pick<WorkflowRuntime, "runTask">,
  contract: PhaseContract<Name, Input, Output>,
  fn: (ctx: PhaseCtx<Name, Input, Output>) => Effect.Effect<Result, Err, never>,
): Effect.Effect<Result, Err | WorkflowRuntimeError, never> =>
  Effect.gen(function* () {
    const phaseKey = `${contract.sop}:${contract.name}`;
    const ctx = createPhaseCtx(runtime, contract, phaseKey);
    return yield* fn(ctx);
  }).pipe(
    Effect.withSpan(`workflow.phase.${contract.sop}:${contract.name}`, {
      attributes: { sop: contract.sop, phase: contract.name },
    }),
  );

export interface WorkflowRuntime {
  runTask: <Task extends AnyWorkflowTask>(task: Task) => Effect.Effect<WorkflowTaskOutput<Task>, WorkflowRuntimeError>;
  phase: <
    const Name extends string,
    const Input extends WorkflowOutputSchema | undefined,
    const Output extends WorkflowOutputSchema | undefined,
    Result,
    Err = WorkflowRuntimeError,
  >(
    contract: PhaseContract<Name, Input, Output>,
    fn: (ctx: PhaseCtx<Name, Input, Output>) => Effect.Effect<Result, Err, never>,
  ) => Effect.Effect<Result, Err | WorkflowRuntimeError, never>;
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
  const Output extends WorkflowOutputSchema,
>(definition: WorkflowTaskDefinition<Id, Output>): WorkflowTask<Id, Output> => ({
  kind: "workflow-task",
  ...definition,
  // Authors may omit `agent`; normalize to the plugin-free sentinel so every
  // runtime task carries an executor identity.
  agent: definition.agent ?? anonymousWorkflowAgent,
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
