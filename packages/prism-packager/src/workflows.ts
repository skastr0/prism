import { Effect, Result, Schema, type SchemaAST } from "effect";
import {
  LOWERER_CAPABILITIES,
  type WorkflowEffortCapabilityFor,
  type WorkflowEffortWorkerHarnessId,
  type WorkflowWorkerHarnessId,
} from "./lowerer-capabilities.js";
import { legacyReasoningVariantError } from "./workflow-effort.js";
import { WorkflowTaskInputError, type WorkflowRuntimeError } from "./workflow-errors.js";
import { isWorkflowSchedule, parseWorkflowSchedule, type WorkflowSchedule } from "./workflow-scheduler/schedule.js";
import {
  jevResultSchema,
  normalizeJevRequest,
  type JevEntry,
  type JevQuestions,
  type JevRequest,
  type JevResult,
  type JevResultCodec,
} from "./jev.js";

export type { WorkflowRuntimeError } from "./workflow-errors.js";
export {
  WORKFLOW_SCHEDULE_MISSED_RUN_POLICIES,
  WORKFLOW_SCHEDULE_OVERLAP_POLICIES,
  isWorkflowSchedule,
  parseWorkflowSchedule,
  type WorkflowSchedule,
  type WorkflowScheduleMissedRuns,
  type WorkflowScheduleOverlap,
} from "./workflow-scheduler/schedule.js";

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

export interface WorkflowTaskSummary {
  readonly id: string;
  readonly cacheKey?: string;
}

export interface WorkflowValidationSummary {
  readonly path: string;
  readonly name: string;
  readonly tasks: ReadonlyArray<WorkflowTaskSummary>;
  readonly dynamic: boolean;
}

/**
 * Constraint for a workflow task's output schema.
 *
 * The load-bearing part is `never, never`: a task output schema must decode and
 * encode without services. `Type` stays `unknown` so the generic bound cannot
 * silently turn decoded values into `any`.
 *
 * `WorkflowFinishOptions` consumes `Output` in contravariant callback positions,
 * which makes a task invariant in its output type. A heterogeneous task tuple is
 * therefore accepted only where the output type is erased, which happens at
 * `AnyWorkflowTask` rather than here.
 */
export type WorkflowOutputSchema = Schema.Codec<unknown, unknown, never, never>;

export type WorkflowFinishCriterionError = Error;

export type WorkflowWorkerId = WorkflowWorkerHarnessId;

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
 * Model-specific reasoning-effort ladders from installed CLI catalogs.
 * Fixed CLI values come from `LOWERER_CAPABILITIES` and are not discovered.
 * Refresh augments only catalog-backed workers.
 */
export interface WorkflowHarnessEffortMap {}

/**
 * Discovered Amp orb projects (`amp projects list --json`). Empty in core;
 * refresh augments `"amp-orb"` so `worker.project` narrows to known projects.
 */
export interface WorkflowHarnessProjectMap {}

export type WorkflowHarnessProject<W extends WorkflowWorkerId> =
  W extends keyof WorkflowHarnessProjectMap ? WorkflowHarnessProjectMap[W] : string;

/**
 * Discovered Amp runners (`list_runners`, captured by
 * `refresh-harness-types --discover-amp-runners`). Empty in core; refresh
 * augments one key per runner whose value is the union of the directories
 * that runner serves.
 */
export interface WorkflowHarnessRunnerDirMap {}

/**
 * The `amp-runner` target: with a runner snapshot, a discriminated union over
 * the live runner ids so `runnerDir` follows the chosen id (a directory
 * another runner serves is a type error); without one, both stay plain
 * strings. `validate` enforces the pair again at load time.
 */
export type AmpRunnerTargetOptions =
  keyof WorkflowHarnessRunnerDirMap extends never
    ? {
      /** Runner id from `amp --no-tui --runner-id <id>` (`--executor runner:<id>`). */
      readonly runnerId: string;
      /** Absolute directory the runner serves (`--runner-dir`); defaults to the runner's start directory. */
      readonly runnerDir?: string;
    }
    : {
      [R in keyof WorkflowHarnessRunnerDirMap]: {
        readonly runnerId: R;
        readonly runnerDir?: WorkflowHarnessRunnerDirMap[R];
      };
    }[keyof WorkflowHarnessRunnerDirMap];

export type WorkflowHarnessModel<W extends WorkflowWorkerId> =
  | (W extends keyof WorkflowHarnessModelMap ? WorkflowHarnessModelMap[W] : string)
  | WorkflowModelProfileRef;

export type WorkflowHarnessCatalogModel<W extends WorkflowWorkerId> =
  W extends keyof WorkflowHarnessCatalogModelMap ? WorkflowHarnessCatalogModelMap[W] : string;

type WorkflowHarnessEffortForCapability<W extends WorkflowWorkerId, Capability> =
  Capability extends {
    readonly kind: "fixed";
    readonly values: readonly (infer Value extends string)[];
  }
    ? Value
    : Capability extends { readonly kind: "catalog" }
      ? W extends keyof WorkflowHarnessEffortMap ? WorkflowHarnessEffortMap[W] : never
      : never;

type WorkflowHarnessEffortForOne<W extends WorkflowWorkerId> =
  WorkflowHarnessEffortForCapability<W, NonNullable<WorkflowEffortCapabilityFor<W>>>;

/** Harness-bound effort values; catalog-backed values require a refreshed type map. */
export type WorkflowHarnessEffort<W extends WorkflowWorkerId> =
  W extends WorkflowWorkerId ? WorkflowHarnessEffortForOne<W> : never;

export const workflowWorkerSupportsEffort = (worker: unknown): worker is WorkflowEffortWorkerHarnessId =>
  typeof worker === "string"
  && Object.hasOwn(LOWERER_CAPABILITIES, worker)
  && LOWERER_CAPABILITIES[worker as WorkflowWorkerId].workflowEffort !== null;

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

export const WORKFLOW_SESSION_PERSISTENCE_WORKERS = [
  "claude-code",
  "codex-cli",
  "omp",
] as const satisfies ReadonlyArray<WorkflowWorkerId>;

/** Remote Amp executors: hosted orbs and operator-declared runners. */
export type AmpRemoteWorkflowWorkerId = Extract<WorkflowWorkerId, "amp-orb" | "amp-runner">;

/**
 * Workers whose full options can be built from `{ worker, model, ... }` alone.
 * TypeScript's smarter union checking (TS 3.5+) decomposes a wide `worker`
 * discriminant across the options union, so a helper typed against the full
 * {@link WorkflowWorkerId} that cannot supply remote workers' required fields
 * (`project`, `runnerId`) would silently accept remote ids as invalid tasks.
 * Loose helpers must narrow to this.
 */
export type WorkflowWorkerIdWithoutRequiredOptions = Exclude<WorkflowWorkerId, AmpRemoteWorkflowWorkerId>;

/**
 * Remote Amp executors (orb, runner) read tool permissions from the remote
 * machine's Amp settings or the ampcode.com project; Prism has no
 * per-invocation override that reaches them.
 */
export type AmpRemoteWorkflowPermissionMode = Extract<WorkflowPermissionMode, "legacy">;

export type WorkflowWorkerPermissionMode<W extends WorkflowWorkerId> =
  W extends "claude-code" ? ClaudeWorkflowPermissionMode
    : W extends "codex-cli" ? CodexWorkflowPermissionMode
      : W extends "cursor" ? CursorWorkflowPermissionMode
        : W extends "devin" ? DevinWorkflowPermissionMode
          : W extends "omp" ? OmpWorkflowPermissionMode
            : W extends AmpRemoteWorkflowWorkerId ? AmpRemoteWorkflowPermissionMode
              : WorkflowDialPermissionMode;

/** Documented orb sizes (https://ampcode.com/docs/orbs/sizes-and-costs); `a1.3xlarge` needs Gigawatt/Enterprise. */
export const AMP_ORB_SIZES = ["a1.tiny", "a1.small", "a1.medium", "a1.large", "a1.xxlarge", "a1.3xlarge"] as const;
export type AmpOrbSize = (typeof AMP_ORB_SIZES)[number];

/** Amp thread visibility values (`--visibility`). */
export const AMP_THREAD_VISIBILITIES = ["private", "unlisted", "workspace", "group"] as const;
export type AmpThreadVisibility = (typeof AMP_THREAD_VISIBILITIES)[number];

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
  readonly profile?: string;
  readonly restrictedTools?: ReadonlyArray<string>;
  readonly retry?: WorkflowTaskWorkerRetryOptions;
};

type WorkflowTaskWorkerOptionsFor<W extends WorkflowWorkerId> =
  WorkflowTaskWorkerOptionsCommon<W> & {
    readonly worker: W;
    readonly permission?: WorkflowWorkerPermissionMode<W>;
  } & (W extends "amp-code"
    ? { readonly catalogModel?: WorkflowHarnessCatalogModel<"amp-code"> }
    : W extends "amp-runner"
      ? { readonly catalogModel?: WorkflowHarnessCatalogModel<"amp-code"> }
      : { readonly catalogModel?: never })
  & (W extends WorkflowEffortWorkerHarnessId
    ? { readonly effort?: WorkflowHarnessEffort<W> }
    : { readonly effort?: never })
  & (W extends WorkflowSessionPersistenceWorkerId
    ? { readonly sessionPersistence?: WorkflowSessionPersistence }
    : { readonly sessionPersistence?: never })
  // Remote Amp executors (amp-orb, amp-runner): labels are cosmetic and never
  // join cache identity; local workers take none.
  & (W extends AmpRemoteWorkflowWorkerId
    ? { readonly labels?: ReadonlyArray<string> }
    : { readonly labels?: never })
  & (W extends "amp-orb"
    ? {
      /**
       * Amp project for the orb (`--project`): namespace/name, owner/repo, or repository URL.
       * Narrows to discovered projects after `prism workflow refresh-harness-types`.
       */
      readonly project: WorkflowHarnessProject<"amp-orb">;
      /** `--orb-size`; defaults to the project's size. */
      readonly size?: AmpOrbSize;
      /** Thread visibility; defaults to Amp's own default. Cosmetic: not part of cache identity. */
      readonly visibility?: AmpThreadVisibility;
    }
    : { readonly project?: never; readonly size?: never; readonly visibility?: never })
  & (W extends "amp-runner"
    ? AmpRunnerTargetOptions
    : { readonly runnerId?: never; readonly runnerDir?: never });

export type WorkflowTaskWorkerOptions =
  | (WorkflowTaskWorkerOptionsCommon & {
    readonly worker?: undefined;
    readonly permission?: WorkflowPermissionMode;
    readonly catalogModel?: never;
    readonly effort?: never;
    readonly sessionPersistence?: never;
  })
  | {
    [W in WorkflowWorkerId]: WorkflowTaskWorkerOptionsFor<W>;
  }[WorkflowWorkerId];

export class WorkflowModelResolutionError extends Error {
  override readonly name = "WorkflowModelResolutionError";
}

export type WorkflowTaskModelResolutionSource = "task" | "default" | "cli-fallback";

export interface WorkflowTaskModelResolution {
  readonly model: string;
  /** Harness-side inference provider (e.g. hermes `--provider xai-oauth`), from the modelspace target or harness default. */
  readonly provider?: string;
  /** Model-selection variant, such as OpenCode's `provider/model#variant`. */
  readonly variant?: string;
  /** Harness-bound reasoning effort from a modelspace target. */
  readonly effort?: string;
  readonly source: WorkflowTaskModelResolutionSource;
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

/** First concrete model binding in a modelspace target (direct or ordered-list form). */
const firstModelChoice = (
  target: WorkflowModelTarget | undefined,
  worker: string,
): { readonly model: string; readonly provider?: string; readonly variant?: string; readonly effort?: string } | undefined => {
  if (target === undefined) return undefined;
  const legacyVariantError = legacyReasoningVariantError(worker, target, `targets.${worker}`);
  if (legacyVariantError !== undefined) throw new WorkflowModelResolutionError(legacyVariantError);
  const direct = target.model;
  if (typeof direct === "string" && direct.length > 0) {
    return {
      model: direct,
      ...(typeof target.provider === "string" ? { provider: target.provider } : {}),
      ...(typeof target.variant === "string" ? { variant: target.variant } : {}),
      ...(typeof target.effort === "string" ? { effort: target.effort } : {}),
    };
  }
  const models = target.models;
  if (Array.isArray(models)) {
    for (const [index, candidate] of models.entries()) {
      if (typeof candidate === "object" && candidate !== null) {
        const entry = candidate as {
          readonly model?: unknown;
          readonly provider?: unknown;
          readonly variant?: unknown;
          readonly effort?: unknown;
        };
        const legacyEntryVariantError = legacyReasoningVariantError(
          worker,
          entry,
          `targets.${worker}`,
        );
        if (legacyEntryVariantError !== undefined) throw new WorkflowModelResolutionError(legacyEntryVariantError);
        if (typeof entry.model === "string" && entry.model.length > 0) {
          return {
            model: entry.model,
            ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
            ...(typeof entry.variant === "string" ? { variant: entry.variant } : {}),
            ...(typeof entry.effort === "string" ? { effort: entry.effort } : {}),
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

/**
 * Resolves a task's model to a concrete string: `worker.model` (or the
 * modelspace profile it points at) wins; otherwise only the CLI `--model`
 * fallback is consulted. A task with no model info at all resolves to
 * `undefined` so per-worker CLIs that tolerate an omitted --model flag
 * (e.g. opencode) keep doing so.
 */
export const resolveWorkflowTaskModelResolution = (
  task: AnyWorkflowWorkerTask,
  options: { readonly worker?: string; readonly fallbackModel?: string } = {},
): WorkflowTaskModelResolution | undefined => {
  const explicit = task.worker?.model;
  if (typeof explicit === "string") return { model: explicit, source: "task" };

  const worker = task.worker?.worker ?? options.worker;
  if (isWorkflowModelProfileRef(explicit)) {
    const target = modelTargetForWorker(explicit, worker);
    const choice = firstModelChoice(target, worker ?? "");
    if (choice !== undefined) return { ...choice, source: "task" };
    throw new WorkflowModelResolutionError(
      `modelspace profile ${describeModelRef(explicit)} has no concrete model for workflow worker '${worker ?? "<missing>"}'`,
    );
  }

  return options.fallbackModel !== undefined
    ? { model: options.fallbackModel, source: "cli-fallback" }
    : undefined;
};

export const resolveWorkflowTaskModel = (
  task: AnyWorkflowWorkerTask,
  options: { readonly worker?: string; readonly fallbackModel?: string } = {},
): string | undefined => resolveWorkflowTaskModelResolution(task, options)?.model;

/** Task-level effort is the explicit override; modelspace effort is the fallback. */
export const resolveWorkflowTaskEffort = (
  task: AnyWorkflowWorkerTask,
  options: { readonly worker?: string; readonly fallbackModel?: string } = {},
): string | undefined => {
  const worker = task.worker?.worker ?? options.worker;
  const configured = task.worker?.worker === worker && task.worker !== undefined && "effort" in task.worker
    ? task.worker.effort
    : undefined;
  if (typeof configured === "string") return configured;
  return resolveWorkflowTaskModelResolution(task, options)?.effort;
};

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
  readonly prompt: string;
  readonly output: Output;
  readonly phase?: string;
  readonly cacheKey?: string;
  readonly worker?: WorkflowTaskWorkerOptions;
  readonly finish?: WorkflowFinishOptions<Output["Type"]>;
}

export type WorkflowTask<
  Id extends string = string,
  Output extends WorkflowOutputSchema = WorkflowOutputSchema,
> = WorkflowTaskDefinition<Id, Output> & {
  readonly kind: "workflow-task";
};

/**
 * A workflow task whose output type is erased.
 *
 * A task is invariant in its output type (`WorkflowFinishOptions` consumes it in
 * callback positions), so `defineWorkflow({ tasks: [build, review] })` only
 * accepts a heterogeneous tuple when the element bound erases that type. The
 * erasure is deliberately local to this bound: `WorkflowOutputSchema` keeps
 * `unknown` so ordinary authoring and `defineTask` inference stay precise, and
 * `WorkflowTaskOutput<Task>` still reads the concrete output of a concrete task.
 *
 * The encoded side and the service-free requirement (`never, never`) are not
 * erased. This is a deliberate loss of proof at the task-collection boundary,
 * not sound existential quantification.
 */
export type AnyWorkflowWorkerTask = WorkflowTask<string, Schema.Codec<any, unknown, never, never>>;

/**
 * A Jev task whose question types are erased. Like the worker erasure above,
 * this keeps heterogeneous `tasks: [...] tuples writable while concrete
 * `jev(...)` calls keep their precise inferred output.
 */
export type AnyJevTask = JevTask<string, any>;

export type AnyWorkflowTask =
  | AnyWorkflowWorkerTask
  | AnyJevTask;

export type WorkflowTaskOutput<Task extends AnyWorkflowTask> = Task["output"]["Type"];

// ---------------------------------------------------------------------------
// Jev decision tasks (kind: "jev")
//
// A Jev task is a native first-class decision step: it calls the TypeSafe
// System One API in-process through the JevClient service (src/services/jev.ts)
// instead of spawning a harness worker. Its output schema is derived from the
// questions map — authors cannot supply or override it, so the decoded output
// type always matches the request contract. Jev tasks have no prompt, worker
// options, finish criteria, or repair semantics: a low-confidence answer is a
// successful decision, and routing is workflow code, not a retry loop.
// ---------------------------------------------------------------------------

export interface JevTaskDefinition<
  Id extends string,
  Q extends JevQuestions,
> extends JevRequest<Q> {
  readonly id: Id;
  /** Per-HTTP-attempt timeout override passed to the JevClient call. */
  readonly timeoutMs?: number;
  readonly phase?: string;
  readonly cacheKey?: string;
}

export type JevTask<
  Id extends string = string,
  Q extends JevQuestions = JevQuestions,
> = JevTaskDefinition<Id, Q> & {
  readonly kind: "jev";
  readonly output: JevResultCodec<Q>;
};

const JEV_TASK_DEFINITION_KEYS = new Set([
  "id",
  "state",
  "questions",
  "model",
  "timeoutMs",
  "phase",
  "cacheKey",
]);

/**
 * Construct a native Jev decision task. The state/questions are validated,
 * deep-copied, and frozen immediately so identity hashing and execution can
 * never disagree, and the output codec is derived from the questions.
 */
export const jev = <const Id extends string, const Q extends JevQuestions>(
  definition: JevTaskDefinition<Id, Q>,
): JevTask<Id, Q> => {
  for (const key of Object.keys(definition)) {
    if (!JEV_TASK_DEFINITION_KEYS.has(key)) {
      throw new WorkflowTaskInputError(
        "jev",
        `unsupported jev task field '${key}' (a jev task has no prompt, worker options, or finish criteria)`,
      );
    }
  }
  if (typeof definition.id !== "string" || definition.id.length === 0) {
    throw new WorkflowTaskInputError("jev", "jev task id must be a non-empty string");
  }
  if (
    definition.timeoutMs !== undefined
    && (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0)
  ) {
    throw new WorkflowTaskInputError("jev", "jev task timeoutMs must be a positive finite number");
  }
  const request = normalizeJevRequest({
    state: definition.state,
    questions: definition.questions,
    ...(definition.model !== undefined ? { model: definition.model } : {}),
  });
  return Object.freeze({
    kind: "jev",
    id: definition.id,
    state: request.state,
    questions: request.questions,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(definition.timeoutMs !== undefined ? { timeoutMs: definition.timeoutMs } : {}),
    ...(definition.phase !== undefined ? { phase: definition.phase } : {}),
    ...(definition.cacheKey !== undefined ? { cacheKey: definition.cacheKey } : {}),
    output: jevResultSchema(request.questions),
  }) as JevTask<Id, Q>;
};

export const resolveWorkflowTaskSessionPersistence = (
  task: Pick<AnyWorkflowWorkerTask, "worker">,
  effectiveWorker: string | undefined = task.worker?.worker,
): WorkflowSessionPersistence | undefined => {
  if (!workflowWorkerSupportsSessionPersistence(effectiveWorker)) return undefined;
  if (task.worker?.worker !== effectiveWorker) return "persistent";
  return task.worker.sessionPersistence ?? "persistent";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasValidWorkflowTaskSessionPersistence = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const sessionPersistence = value.sessionPersistence;
  if (sessionPersistence === undefined) return true;
  return workflowWorkerSupportsSessionPersistence(value.worker)
    && (sessionPersistence === "persistent" || sessionPersistence === "ephemeral");
};

export const assertWorkflowTaskSessionPersistence = (task: AnyWorkflowWorkerTask): void => {
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

export const isWorkflowWorkerTask = (value: unknown): value is AnyWorkflowWorkerTask =>
  isRecord(value) &&
  value.kind === "workflow-task" &&
  typeof value.id === "string" &&
  typeof value.prompt === "string" &&
  Schema.isSchema(value.output) &&
  (value.cacheKey === undefined || typeof value.cacheKey === "string") &&
  hasValidWorkflowTaskSessionPersistence(value.worker);

export const isJevTask = (value: unknown): value is AnyJevTask =>
  isRecord(value) &&
  value.kind === "jev" &&
  typeof value.id === "string" &&
  Schema.isSchema(value.output) &&
  (value.cacheKey === undefined || typeof value.cacheKey === "string");

export const isWorkflowTask = (value: unknown): value is AnyWorkflowTask =>
  isWorkflowWorkerTask(value) || isJevTask(value);

export interface WorkflowDefinition<Name extends string, Tasks extends ReadonlyArray<AnyWorkflowTask>> {
  readonly kind: "workflow";
  readonly name: Name;
  readonly tasks: Tasks;
  /**
   * Inert scheduling policy. Declaring it registers nothing; only
   * `prism workflow schedule install` activates a schedule. See
   * `workflow-scheduler/schedule.ts`.
   */
  readonly schedule?: WorkflowSchedule;
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
  Input extends WorkflowOutputSchema ? Input["Type"] : unknown;

export type PhaseTaskDefinition<
  Id extends string,
  Input extends WorkflowOutputSchema | undefined = undefined,
  Output extends WorkflowOutputSchema = WorkflowOutputSchema,
> = Omit<WorkflowTaskDefinition<Id, Output>, "output" | "phase" | "finish"> & {
  readonly input?: PhaseTaskInputValue<Input>;
  readonly output?: Output;
  readonly phase?: string;
  readonly finish?: PhaseTaskFinishOptions<Output["Type"]>;
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

/**
 * A `ctx.jev(...)` definition. When the phase binds an input contract, the
 * Jev state is that contract's decoded value (it must still be a valid System
 * One entry — schemas describing functions or class instances do not belong
 * in state and will fail entry validation at run time).
 */
export type PhaseJevTaskDefinition<
  Id extends string,
  Input extends WorkflowOutputSchema | undefined,
  Q extends JevQuestions,
> = Omit<JevTaskDefinition<Id, Q>, "state"> & {
  readonly state: Input extends WorkflowOutputSchema
    ? Input["Type"] & JevEntry
    : JevEntry;
};

export type PhaseCtxJev<
  Input extends WorkflowOutputSchema | undefined,
> = <
  const Id extends string,
  const Q extends JevQuestions,
>(
  definition: PhaseJevTaskDefinition<Id, Input, Q>,
) => Effect.Effect<JevResult<Q>, WorkflowRuntimeError>;

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
  /**
   * Run a native Jev decision inside this phase. Unlike `ctx.task`, no prompt
   * framing, serialized-input block, finish criteria, or phase output schema
   * is applied — a decision is defined by its state and questions alone.
   */
  readonly jev: PhaseCtxJev<Input>;
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
      const decoded = Schema.decodeUnknownResult(contract.input)(taskInput);
      if (Result.isFailure(decoded)) {
        return Effect.fail(new WorkflowTaskInputError(phaseKey, decoded.failure));
      }
      inputBlock = renderPhaseInputBlock(decoded.success);
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

  const jevTask: PhaseCtxJev<Input> = <const Id extends string, const Q extends JevQuestions>(
    def: PhaseJevTaskDefinition<Id, Input, Q>,
  ): Effect.Effect<JevResult<Q>, WorkflowRuntimeError> => {
    const { phase: phaseOverride, state: rawState, ...rest } = def as Omit<typeof def, "state"> & {
      readonly phase?: string;
      readonly state: unknown;
    };
    let state = rawState;
    if (contract.input !== undefined) {
      const decoded = Schema.decodeUnknownResult(contract.input)(rawState);
      if (Result.isFailure(decoded)) {
        return Effect.fail(new WorkflowTaskInputError(phaseKey, decoded.failure));
      }
      state = decoded.success;
    }
    const task = jev({
      ...rest,
      state: state as JevEntry,
      phase: phaseOverride ?? phaseKey,
    } as JevTaskDefinition<string, JevQuestions>);
    // Contained assertion: the compile surface (PhaseJevTaskDefinition)
    // proves Q's shape; the runtime re-validates state/questions in jev() and
    // the runner decodes the result against the same question-derived codec.
    return runtime.runTask(task) as unknown as Effect.Effect<JevResult<Q>, WorkflowRuntimeError>;
  };

  return {
    name: contract.name,
    sop: contract.sop,
    plugin: contract.plugin,
    phase: phaseKey,
    task,
    jev: jevTask,
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
  /** Inert scheduling policy; see `WorkflowDefinition.schedule`. */
  readonly schedule?: WorkflowSchedule;
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
  (value.run === undefined || typeof value.run === "function") &&
  (value.schedule === undefined || isWorkflowSchedule(value.schedule));

export const workflowSummary = (
  path: string,
  workflow: AnyWorkflowDefinition,
): WorkflowValidationSummary => ({
  path,
  name: workflow.name,
  dynamic: "run" in workflow,
  tasks: workflow.tasks.map((task) => ({
    id: task.id,
    ...(task.cacheKey ? { cacheKey: task.cacheKey } : {}),
  })),
});

export const defineTask = <
  const Id extends string,
  const Output extends WorkflowOutputSchema,
>(definition: WorkflowTaskDefinition<Id, Output>): WorkflowTask<Id, Output> => ({
  kind: "workflow-task",
  ...definition,
});

/**
 * `schedule` is validated here rather than left to `install` so an authoring
 * mistake fails at import, with the file in front of the author. `install`
 * re-validates because an installed schedule is boundary data — a hand-written
 * object, or a definition produced by a different Prism version.
 */
const validatedWorkflowSchedule = (value: unknown): WorkflowSchedule | undefined =>
  value === undefined ? undefined : parseWorkflowSchedule(value);

export function defineWorkflow<const Name extends string, const Tasks extends ReadonlyArray<AnyWorkflowTask>>(
  definition: { readonly name: Name; readonly tasks: Tasks; readonly schedule?: WorkflowSchedule },
): WorkflowDefinition<Name, Tasks>;
export function defineWorkflow<const Name extends string, Result, Err = WorkflowRuntimeError>(
  definition: {
    readonly name: Name;
    readonly run: (runtime: WorkflowRuntime) => Effect.Effect<Result, Err, never>;
    readonly schedule?: WorkflowSchedule;
  },
): DynamicWorkflowDefinition<Name, Result, Err>;
export function defineWorkflow<const Name extends string, Result, Err = WorkflowRuntimeError>(
  definition:
    | { readonly name: Name; readonly tasks: ReadonlyArray<AnyWorkflowTask>; readonly schedule?: WorkflowSchedule }
    | {
      readonly name: Name;
      readonly run: (runtime: WorkflowRuntime) => Effect.Effect<Result, Err, never>;
      readonly schedule?: WorkflowSchedule;
    },
): WorkflowDefinition<Name, ReadonlyArray<AnyWorkflowTask>> | DynamicWorkflowDefinition<Name, Result, Err> {
  const schedule = validatedWorkflowSchedule(definition.schedule);
  if ("run" in definition) {
    return {
      kind: "workflow",
      name: definition.name,
      tasks: [],
      run: definition.run,
      ...(schedule !== undefined ? { schedule } : {}),
    };
  }
  return {
  kind: "workflow",
  ...definition,
  ...(schedule !== undefined ? { schedule } : {}),
  };
}

export const decodeTaskOutput = <Task extends AnyWorkflowTask | AnyJevTask>(
  task: Task,
  value: unknown,
  options?: SchemaAST.ParseOptions,
): Result.Result<Task["output"]["Type"], Schema.SchemaError> =>
  Schema.decodeUnknownResult(task.output)(value, options);
