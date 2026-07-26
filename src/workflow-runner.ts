import { Cause, Effect, Either, Exit, Layer, Option } from "effect";
import { compareCodePoint } from "@skastr0/prism-sdk/stable-json";
import { computeContentHash } from "./content-hash.js";
import {
  assertWorkflowTaskSessionPersistence,
  DEFAULT_WORKFLOW_DECODE_REPAIRS,
  decodeTaskOutput,
  resolveWorkflowTaskSessionPersistence,
  type AnyWorkflowDefinition,
  type AnyWorkflowTask,
  type WorkflowJudgeCriterionContext,
  type WorkflowJudgeFinishCriterion,
  type WorkflowJudgeTaskMetadata,
  type WorkflowJudgeVerdict,
  phase,
  type WorkflowRuntime,
  type WorkflowRuntimeOptions,
  type WorkflowRuntimeError,
} from "./workflows.js";
import {
  WorkflowCostExceededError,
  WorkflowCostUnavailableError,
  WorkflowFanoutExceededError,
  WorkflowPromptLimitError,
  WorkflowRunStoppedError,
  WorkflowRunTimeoutError,
  WorkflowTaskDecodeError,
  WorkflowTaskEscalatedError,
  WorkflowTaskNoProgressError,
} from "./workflow-errors.js";
import {
  workflowRunTaskSnapshotForTask,
  workflowTaskIdentity,
  type WorkflowJudgeIdentity,
  type WorkflowTaskIdentity,
} from "./workflow-identity.js";
import type {
  WorkflowRunTerminalCause,
  WorkflowRunStatus,
  WorkflowStore,
  WorkflowTaskAttemptFailure,
  WorkflowTaskAttemptFailureKind,
  WorkflowTaskAttemptStatus,
} from "./workflow-store.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE, WorkflowOutputParseError, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { parsePositiveInteger } from "./workflow-harness-detection.js";
import {
  normalizeWorkflowSessionMetadata,
  workflowAdapterFromMetadata,
  workflowContinuationSupportForAdapter,
  workflowStableSessionFromMetadata,
  type WorkflowRepairLoopContinuationWorkerId,
  type WorkflowStableSession,
} from "./workflow-session.js";
import {
  createWorkflowTraceRecorder,
  makeWorkflowEffectTracer,
  type WorkflowTraceRecorder,
} from "./workflow-tracing.js";
import { workflowUsageFromMetadata } from "./workflow-usage.js";

export interface WorkflowTaskExecution {
  readonly output: unknown;
  readonly metadata?: Record<string, unknown>;
}

export type WorkflowRunTaskResultStatus = "completed" | "failed" | "escalated";

export interface WorkflowRunTaskResult {
  readonly id: string;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly output: unknown;
  readonly cached: boolean;
  readonly status: WorkflowRunTaskResultStatus;
  readonly metadata?: Record<string, unknown>;
  readonly error?: string;
}

interface WorkflowTaskFailureEvidence {
  readonly taskId: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly errorName: string;
  readonly message: string;
}

/**
 * Fault-isolation envelope for a task. A task that crashes, times out, or exhausts repair
 * resolves to `{ result: <failed>, failure }` so the dynamic runtime can keep isolated
 * siblings running. Run-level cancellation still rejects from {@link executeWorkflowTask}.
 */
type WorkflowTaskOutcome =
  | { readonly result: WorkflowRunTaskResult }
  | {
    readonly result: WorkflowRunTaskResult;
    readonly failure: unknown;
    readonly failureEvidence: WorkflowTaskFailureEvidence;
  };

export interface WorkflowRunResult {
  readonly runId: string | null;
  readonly workflow: string;
  readonly tasks: ReadonlyArray<WorkflowRunTaskResult>;
  readonly output?: unknown;
}

export {
  WorkflowRunStoppedError,
  WorkflowTaskDecodeError,
  WorkflowTaskEscalatedError,
  WorkflowRunTimeoutError,
  WorkflowTaskNoProgressError,
  WorkflowFanoutExceededError,
  WorkflowCostExceededError,
  WorkflowCostUnavailableError,
  WorkflowPromptLimitError,
  type WorkflowRuntimeError,
} from "./workflow-errors.js";

export type WorkflowTaskRepairMode = "native-continuation" | "fresh-executor-invocation" | "none";

export type WorkflowTaskProgressSource = "executor" | "worker-stdout" | "worker-stderr";

export type WorkflowTaskProgressReporter = (source?: WorkflowTaskProgressSource) => void;

export type WorkflowTaskRepairFallbackReason =
  | "adapter-does-not-support-continuation"
  | "ephemeral-session"
  | "executor-does-not-advertise-continuation"
  | "missing-session-id";

interface WorkflowTaskRepairContextBase {
  readonly attempt: number;
  readonly criterion: string;
  readonly repairPrompt: string;
  readonly previousMetadata?: Record<string, unknown>;
}

export type WorkflowTaskRepairContext = WorkflowTaskRepairContextBase & (
  | {
    readonly mode: "native-continuation";
    readonly continuation: WorkflowStableSession;
    readonly fallbackReason?: never;
  }
  | {
    readonly mode: "fresh-executor-invocation";
    readonly fallbackReason: WorkflowTaskRepairFallbackReason;
    readonly continuation?: never;
  }
);

type WorkflowTaskRepairPlan =
  | {
    readonly mode: "native-continuation";
    readonly continuation: WorkflowStableSession;
    readonly fallbackReason?: never;
  }
  | {
    readonly mode: "fresh-executor-invocation";
    readonly fallbackReason: WorkflowTaskRepairFallbackReason;
    readonly continuation?: never;
  };

export interface WorkflowTaskExecutionContext {
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
  readonly repair?: WorkflowTaskRepairContext;
}

export interface WorkflowTaskExecutionContextWithoutRepair {
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
}

export type WorkflowTaskRepairLoopOption<Worker extends string> =
  Worker extends WorkflowRepairLoopContinuationWorkerId
    ? { readonly repair?: WorkflowTaskRepairContext }
    : { readonly repair?: never };

export type WorkflowTaskExecutor = (
  task: AnyWorkflowTask,
  context?: WorkflowTaskExecutionContext,
) => Promise<unknown | WorkflowTaskExecution>;

export const DEFAULT_WORKFLOW_TASK_CONCURRENCY = 8;

// No default prompt ceiling: prompt size is a property of the work, not a risk
// to police. A limit applies only when a run asks for one via
// `--max-prompt-bytes`.

const WORKFLOW_TASK_PROGRESS_EVENT_MIN_INTERVAL_MS = 5_000;

const assertWorkflowRepairBudget = (
  name: "maxRepairs" | "maxDecodeRepairs",
  value: number | undefined,
): void => {
  if (value !== undefined && (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)) {
    throw new RangeError(`finish.${name} must be a finite non-negative integer`);
  }
};

const assertWorkflowTaskRepairBudgets = (task: AnyWorkflowTask): void => {
  assertWorkflowTaskSessionPersistence(task);
  assertWorkflowRepairBudget("maxRepairs", task.finish?.maxRepairs);
  assertWorkflowRepairBudget("maxDecodeRepairs", task.finish?.maxDecodeRepairs);
  const retryMaxAttempts = task.worker?.retry?.maxAttempts;
  if (retryMaxAttempts !== undefined && (!Number.isFinite(retryMaxAttempts) || !Number.isInteger(retryMaxAttempts) || retryMaxAttempts < 1)) {
    throw new RangeError("worker.retry.maxAttempts must be a finite positive integer");
  }
  const retryBackoffMs = task.worker?.retry?.backoffMs;
  if (retryBackoffMs !== undefined && (!Number.isFinite(retryBackoffMs) || !Number.isInteger(retryBackoffMs) || retryBackoffMs < 0)) {
    throw new RangeError("worker.retry.backoffMs must be a finite non-negative integer");
  }
};

const assertFinitePositiveInteger = (name: string, value: number | undefined): void => {
  if (value !== undefined && (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)) {
    throw new RangeError(`${name} must be a finite positive integer`);
  }
};

const assertWorkflowRunBudgets = (options: {
  readonly maxWallMs?: number;
  readonly taskNoProgressMs?: number;
  readonly maxTasks?: number;
  readonly maxCostUsd?: number;
  readonly maxPromptBytes?: number;
}): void => {
  assertFinitePositiveInteger("maxWallMs", options.maxWallMs);
  assertFinitePositiveInteger("taskNoProgressMs", options.taskNoProgressMs);
  assertFinitePositiveInteger("maxTasks", options.maxTasks);
  assertFinitePositiveInteger("maxPromptBytes", options.maxPromptBytes);
  if (
    options.maxCostUsd !== undefined
    && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd < 0)
  ) {
    throw new RangeError("maxCostUsd must be a finite non-negative number");
  }
};

interface TaskExecutionLimiter {
  readonly run: <A>(operation: () => Promise<A>) => Promise<A>;
  readonly cancelPending: (reason: unknown) => void;
}

interface RunCancellationBarrier {
  readonly signal: AbortSignal;
  readonly abort: (reason: unknown, eventReason: string) => void;
  readonly throwIfAborted: () => void;
  readonly attemptInterruption: () => {
    readonly status: Extract<WorkflowTaskAttemptStatus, "stopped" | "crashed">;
    readonly failure: {
      readonly kind: Extract<WorkflowTaskAttemptFailureKind, "stopped" | "crashed">;
      readonly message: string;
    };
  } | undefined;
  readonly trackTask: (taskId: string) => () => void;
  readonly dispose: () => void;
}

interface WorkflowRunBudget {
  readonly admitLiveTask: () => void;
  readonly assertPrompt: (task: AnyWorkflowTask) => void;
  readonly observeLiveAttempt: (
    metadata: Record<string, unknown> | undefined,
    requireReportedCost: boolean,
  ) => void;
  readonly dispose: () => void;
}

const isWorkflowTaskExecution = (value: unknown): value is WorkflowTaskExecution =>
  typeof value === "object" && value !== null && "output" in value;

const taskAgent = (task: AnyWorkflowTask) => ({
  plugin: task.agent.plugin,
  name: task.agent.name,
});

const workflowContractMetadata = {
  contractVersion: WORKFLOW_WORKER_JSON_CONTRACT_VERSION,
  instructionSource: WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE,
} as const;

const hasNonContractMetadata = (metadata: Record<string, unknown> | undefined): boolean => {
  if (metadata === undefined) return false;
  return Object.keys(metadata).some((key) => !(key in workflowContractMetadata));
};

const repairExecutionPlan = (
  task: AnyWorkflowTask,
  metadata: Record<string, unknown> | undefined,
): WorkflowTaskRepairPlan => {
  if (
    resolveWorkflowTaskSessionPersistence(task) === "ephemeral"
    || metadata?.sessionPersistence === "ephemeral"
  ) {
    return { mode: "fresh-executor-invocation", fallbackReason: "ephemeral-session" };
  }
  const session = workflowStableSessionFromMetadata(metadata);
  if (session !== undefined) {
    return { mode: "native-continuation", continuation: session };
  }
  const adapter = workflowAdapterFromMetadata(metadata);
  const support = workflowContinuationSupportForAdapter(adapter);
  if (support?.stableSessionIds === true) {
    return { mode: "fresh-executor-invocation", fallbackReason: "missing-session-id" };
  }
  if (adapter !== undefined) {
    return { mode: "fresh-executor-invocation", fallbackReason: "adapter-does-not-support-continuation" };
  }
  return {
    mode: "fresh-executor-invocation",
    fallbackReason: "executor-does-not-advertise-continuation",
  };
};

const objectMetadata = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const metadataWithRepairExecution = (
  metadata: Record<string, unknown> | undefined,
  repair: WorkflowTaskRepairContext | undefined,
): Record<string, unknown> | undefined => {
  if (repair === undefined) return metadata;
  const normalized = normalizeWorkflowSessionMetadata(metadata);
  const base: Record<string, unknown> = normalized ?? {};
  const session = workflowStableSessionFromMetadata(base);
  if (repair.mode === "native-continuation") {
    if (
      session !== undefined &&
      (session.adapter !== repair.continuation.adapter || session.sessionId !== repair.continuation.sessionId)
    ) {
      throw new Error(
        `workflow repair continuation returned sessionId '${session.sessionId}' for adapter '${session.adapter}', expected '${repair.continuation.sessionId}' for '${repair.continuation.adapter}'`,
      );
    }
    const pinned: Record<string, unknown> = {
      ...base,
      adapter: repair.continuation.adapter,
      sessionId: repair.continuation.sessionId,
    };
    if (objectMetadata(pinned["repairExecution"]) !== undefined) return pinned;
    return {
      ...pinned,
      repairExecution: {
        attempt: repair.attempt,
        criterion: repair.criterion,
        mode: repair.mode,
        continuation: repair.continuation,
      },
    };
  }
  if (objectMetadata(base["repairExecution"]) !== undefined) return base;
  return {
    ...base,
    repairExecution: {
      attempt: repair.attempt,
      criterion: repair.criterion,
      mode: repair.mode,
      fallbackReason: repair.fallbackReason,
    },
  };
};

const metadataRepairMode = (
  metadata: Record<string, unknown> | undefined,
  fallback: Exclude<WorkflowTaskRepairMode, "none">,
): Exclude<WorkflowTaskRepairMode, "none"> => {
  const repairExecution = objectMetadata(metadata?.repairExecution);
  const mode = repairExecution?.mode;
  return mode === "native-continuation" || mode === "fresh-executor-invocation" ? mode : fallback;
};

const summarizeRepairMode = (repairModes: ReadonlyArray<Exclude<WorkflowTaskRepairMode, "none">>): WorkflowTaskRepairMode => {
  if (repairModes.length === 0) return "none";
  return repairModes.every((mode) => mode === "native-continuation")
    ? "native-continuation"
    : "fresh-executor-invocation";
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "function") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      // NFC code-point sort, not locale-sensitive: mirrors packages/prism-sdk/src/stable-json.ts
      // (compareCodePoint) so cache keys stay stable across machines/locales.
      .sort(([left], [right]) => compareCodePoint(left, right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
};

const stableJson = (value: unknown): string =>
  JSON.stringify(stableValue(value));

const judgeCriterionDefinition = (criterion: WorkflowJudgeFinishCriterion<unknown, unknown>): unknown => ({
  kind: criterion.kind,
  name: criterion.name,
  goal: typeof criterion.goal === "function" ? criterion.goal.toString() : criterion.goal ?? null,
  selectEvidence: criterion.selectEvidence?.toString() ?? null,
  evaluate: criterion.evaluate.toString(),
});

const taskJudgeMetadata = (task: AnyWorkflowTask): WorkflowJudgeTaskMetadata => ({
  id: task.id,
  agent: taskAgent(task),
  ...(task.cacheKey !== undefined ? { cacheKey: task.cacheKey } : {}),
  ...(task.worker !== undefined ? { worker: task.worker } : {}),
});

const judgeFeedback = (verdict: WorkflowJudgeVerdict): string | undefined =>
  "feedback" in verdict ? verdict.feedback : undefined;

const createTaskLimiter = (maxConcurrentTasks: number): TaskExecutionLimiter => {
  let active = 0;
  const queue: Array<{
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  const acquire = async (): Promise<void> => {
    if (active < maxConcurrentTasks) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => queue.push({ resolve, reject }));
  };
  const cancelPending = (reason: unknown) => {
    const pending = queue.splice(0);
    for (const waiter of pending) {
      waiter.reject(reason);
    }
  };
  const release = () => {
    const next = queue.shift();
    if (next !== undefined) {
      next.resolve();
      return;
    }
    active -= 1;
  };
  return {
    // Only the run-scoped barrier cancels queued admission. A task-local failure remains
    // isolated unless it escapes the author program and terminalizes the whole run.
    cancelPending,
    run: async (operation) => {
      await acquire();
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
};

const recordEvent = (
  store: WorkflowStore | undefined,
  runId: string | null,
  taskId: string,
  type: string,
  payload: unknown,
): void => {
  if (runId === null) return;
  store?.recordEvent({ runId, taskId, type, payload });
};

const executeOrReuseTask = async (input: {
  readonly task: AnyWorkflowTask;
  readonly cached: { readonly output: unknown; readonly metadata?: Record<string, unknown> } | null | undefined;
  readonly executeTask: WorkflowTaskExecutor;
  readonly context?: WorkflowTaskExecutionContext;
}): Promise<{ readonly rawOutput: unknown; readonly metadata?: Record<string, unknown> }> => {
  const normalizeForTask = (
    metadata: Record<string, unknown>,
  ): Record<string, unknown> | undefined => normalizeWorkflowSessionMetadata({
    ...metadata,
    ...(resolveWorkflowTaskSessionPersistence(input.task) === "ephemeral"
      ? { sessionPersistence: "ephemeral" }
      : {}),
  });
  if (input.cached !== undefined && input.cached !== null) {
    return {
      rawOutput: input.cached.output,
      metadata: normalizeForTask({
        ...workflowContractMetadata,
        ...(input.cached.metadata ?? {}),
        cachedFrom: "workflow_task_records",
      }),
    };
  }
  const executed = await input.executeTask(input.task, input.context);
  if (!isWorkflowTaskExecution(executed)) {
    return {
      rawOutput: executed,
      metadata: metadataWithRepairExecution(
        normalizeForTask(workflowContractMetadata),
        input.context?.repair,
      ),
    };
  }
  return {
    rawOutput: executed.output,
    metadata: metadataWithRepairExecution(
      normalizeForTask({ ...workflowContractMetadata, ...(executed.metadata ?? {}) }),
      input.context?.repair,
    ),
  };
};

const executeLiveTaskAttempt = async (input: {
  readonly task: AnyWorkflowTask;
  readonly executeTask: WorkflowTaskExecutor;
  readonly runSignal: AbortSignal;
  readonly taskNoProgressMs?: number;
  readonly repair?: WorkflowTaskRepairContext;
  readonly onProgress?: (source: WorkflowTaskProgressSource) => void;
}): Promise<{ readonly rawOutput: unknown; readonly metadata?: Record<string, unknown> }> => {
  const controller = new AbortController();
  let settled = false;
  let progressTimer: NodeJS.Timeout | undefined;
  let lastProgressEventAt: number | undefined;
  const abortFromRun = (): void => {
    if (!controller.signal.aborted) controller.abort(input.runSignal.reason);
  };
  if (input.runSignal.aborted) abortFromRun();
  else input.runSignal.addEventListener("abort", abortFromRun, { once: true });
  const resetProgressTimer = (): void => {
    if (settled || controller.signal.aborted || input.taskNoProgressMs === undefined) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      controller.abort(new WorkflowTaskNoProgressError(input.task.id, input.taskNoProgressMs!));
    }, input.taskNoProgressMs);
  };
  const reportProgress: WorkflowTaskProgressReporter = (source) => {
    if (settled || controller.signal.aborted) return;
    resetProgressTimer();
    const now = Date.now();
    if (
      lastProgressEventAt !== undefined
      && now - lastProgressEventAt < WORKFLOW_TASK_PROGRESS_EVENT_MIN_INTERVAL_MS
    ) return;
    lastProgressEventAt = now;
    input.onProgress?.(
      source === "worker-stdout" || source === "worker-stderr" ? source : "executor",
    );
  };
  resetProgressTimer();
  let rejectOnAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = (): void => rejectOnAbort(controller.signal.reason);
  if (controller.signal.aborted) onAbort();
  else controller.signal.addEventListener("abort", onAbort, { once: true });
  const execution = executeOrReuseTask({
    task: input.task,
    cached: null,
    executeTask: input.executeTask,
    context: {
      abortSignal: controller.signal,
      reportProgress,
      ...(input.repair !== undefined ? { repair: input.repair } : {}),
    },
  });
  // A timed-out provider may ignore its AbortSignal and settle later. Keep a rejection
  // observer attached while Promise.race returns promptly; the late settlement must never
  // re-enter attempt bookkeeping or become an unhandled rejection.
  void execution.catch(() => undefined);
  try {
    return await Promise.race([execution, aborted]);
  } finally {
    settled = true;
    clearTimeout(progressTimer);
    input.runSignal.removeEventListener("abort", abortFromRun);
    controller.signal.removeEventListener("abort", onAbort);
  }
};
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorName = (error: unknown): string =>
  error instanceof Error && error.name.length > 0 ? error.name : "Error";

const normalizedAttemptMetadata = (
  metadata: Record<string, unknown> | undefined,
  error?: unknown,
): Record<string, unknown> | undefined => normalizeWorkflowSessionMetadata({
  ...workflowContractMetadata,
  ...(metadata ?? {}),
  ...(objectMetadata((error as { readonly metadata?: unknown } | null | undefined)?.metadata) ?? {}),
});

const failedTaskResult = (
  task: AnyWorkflowTask,
  cached: boolean,
  error: unknown,
): WorkflowRunTaskResult => {
  const message = errorMessage(error);
  const output: Record<string, unknown> = { error: message };
  const rawText = (error as { readonly rawText?: unknown } | null | undefined)?.rawText;
  if (rawText !== undefined) output.rawText = rawText;
  return {
    id: task.id,
    agent: taskAgent(task),
    output,
    cached,
    status: error instanceof WorkflowTaskEscalatedError ? "escalated" : "failed",
    error: message,
    // OBS-006: reads whatever forensics the adapter attached to error.metadata (stderr
    // excerpt, harness session id, ...) the same way the persisted-task-record path already
    // does via normalizedAttemptMetadata — this is the isolated/dynamic-fanout result path
    // (e.g. Effect.either(wf.runTask(...))), a separate call site that previously fell back
    // to bare contract metadata regardless of what the adapter knew about the failure.
    metadata: normalizedAttemptMetadata(undefined, error),
  };
};

/**
 * The failure surfaced by {@link WorkflowRuntime.runTask} for a task that crashed, timed out,
 * or exhausted repair. Authors may isolate it per-arm (e.g. `Effect.either`); its `message`
 * mirrors the underlying task error so author-side `error.message` reads unchanged.
 *
 * Two distinct outcomes follow depending on whether the author isolates it:
 * - **Isolated** (author catches it, e.g. `Effect.either`, and the program still succeeds):
 *   the run status is `"completed"` with the partial results already recorded — a single
 *   task's failure never aborts the whole run.
 * - **Unhandled** (the author lets it bubble to the top of the dynamic program): the
 *   run-wide barrier cancels siblings, waits for every started executor, persists `"failed"`,
 *   and rejects with the original task error. An escalation (`WorkflowTaskEscalatedError`)
 *   keeps its own distinct `"escalated"` status in both cases.
 *
 * A genuine failure of the author's own program (an explicit `Effect.fail`, a defect) is
 * *not* a WorkflowTaskFailure and always fails the run.
 */
class WorkflowTaskFailure extends Error {
  override readonly name = "WorkflowTaskFailure";
  constructor(
    readonly taskError: unknown,
    readonly evidence: WorkflowTaskFailureEvidence,
  ) {
    super(errorMessage(taskError));
  }
}

const appendRepairPrompt = (task: AnyWorkflowTask, repairPrompt: string): AnyWorkflowTask => ({
  ...task,
  prompt: `${task.prompt}\n\nYou are still inside the same Prism workflow task. Your previous response did not satisfy the task finish requirements.\n\n${repairPrompt}\n\nReturn the corrected final response now.`,
});

const schemaRepairPrompt = (error: unknown): string =>
  `Your previous response failed the output schema decode. Preserve the substance of your answer, but re-express it so it exactly satisfies the requested JSON shape. Decode error: ${errorMessage(error)}`;

const parseRepairPrompt = (error: WorkflowOutputParseError): string => {
  const rawText = error.rawText?.slice(0, 4_000);
  return `Your previous response was not valid JSON, so Prism could not parse it before schema validation. Preserve the substance of your answer, but re-express it as exactly one valid JSON value. Parse error: ${error.message}${rawText !== undefined ? `\n\nPrevious raw output excerpt:\n${rawText}` : ""}`;
};

type WorkflowFinishCriteriaResult =
  | { readonly ok: true; readonly judgeRuns: ReadonlyArray<{ readonly criterion: string; readonly verdict: WorkflowJudgeVerdict["verdict"]; readonly cached: boolean; readonly cacheKey: string }> }
  | { readonly ok: false; readonly status: "continue"; readonly criterion: string; readonly error: unknown; readonly repairPrompt: string; readonly judgeRuns: ReadonlyArray<{ readonly criterion: string; readonly verdict: WorkflowJudgeVerdict["verdict"]; readonly cached: boolean; readonly cacheKey: string }> }
  | { readonly ok: false; readonly status: "fail"; readonly criterion: string; readonly error: unknown; readonly judgeRuns: ReadonlyArray<{ readonly criterion: string; readonly verdict: WorkflowJudgeVerdict["verdict"]; readonly cached: boolean; readonly cacheKey: string }> }
  | { readonly ok: false; readonly status: "escalate"; readonly criterion: string; readonly error: unknown; readonly feedback?: string; readonly judgeRuns: ReadonlyArray<{ readonly criterion: string; readonly verdict: WorkflowJudgeVerdict["verdict"]; readonly cached: boolean; readonly cacheKey: string }> };

const runJudgeCriterion = async (input: {
  readonly criterion: WorkflowJudgeFinishCriterion<unknown, unknown>;
  readonly workflowIdentity: WorkflowTaskIdentity;
  readonly task: AnyWorkflowTask;
  readonly output: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly store: WorkflowStore | undefined;
  readonly runId: string | null;
  readonly tracing?: WorkflowTraceRecorder;
  readonly parentSpanId?: string;
}): Promise<{ readonly verdict: WorkflowJudgeVerdict; readonly cached: boolean; readonly identity: WorkflowJudgeIdentity; readonly evidence: unknown; readonly taskMetadata: WorkflowJudgeTaskMetadata }> => {
  const taskMetadata = taskJudgeMetadata(input.task);
  const goalContext = { output: input.output as never, metadata: input.metadata, task: taskMetadata };
  const goal = typeof input.criterion.goal === "function"
    ? input.criterion.goal(goalContext)
    : input.criterion.goal ?? input.task.prompt;
  const evidenceSelectionContext = { goal, output: input.output as never, metadata: input.metadata, task: taskMetadata };
  const evidence = input.criterion.selectEvidence?.(evidenceSelectionContext) ?? null;
  const cacheKey = computeContentHash(stableJson({
    criterion: judgeCriterionDefinition(input.criterion),
    goal,
    output: input.output,
    taskMetadata,
    evidence,
  }));
  const identity: WorkflowJudgeIdentity = {
    workflow: input.workflowIdentity.workflow,
    taskId: input.workflowIdentity.taskId,
    taskCacheKey: input.workflowIdentity.cacheKey,
    criterion: input.criterion.name,
    cacheKey,
  };
  recordEvent(input.store, input.runId, input.task.id, "task.judge.cache_lookup.started", {
    criterion: input.criterion.name,
    cacheKey,
  });
  const cached = input.store?.getJudgeRecord(identity) ?? null;
  if (cached !== null) {
    const verdict: WorkflowJudgeVerdict = {
      verdict: cached.verdict,
      ...(cached.feedback !== undefined ? { feedback: cached.feedback } : {}),
      ...(cached.metadata !== undefined ? { metadata: cached.metadata } : {}),
    } as WorkflowJudgeVerdict;
    recordEvent(input.store, input.runId, input.task.id, "task.judge.cache_lookup.hit", {
      criterion: input.criterion.name,
      cacheKey,
      verdict: verdict.verdict,
    });
    return { verdict, cached: true, identity, evidence, taskMetadata };
  }
  recordEvent(input.store, input.runId, input.task.id, "task.judge.cache_lookup.miss", {
    criterion: input.criterion.name,
    cacheKey,
  });
  const context: WorkflowJudgeCriterionContext<unknown, unknown> = {
    goal,
    output: input.output,
    metadata: input.metadata,
    task: taskMetadata,
    evidence,
  };
  recordEvent(input.store, input.runId, input.task.id, "task.judge.started", {
    criterion: input.criterion.name,
    cacheKey,
    goal,
  });
  const judgeSpan = input.tracing?.startSpan("task.judge", {
    ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
    taskId: input.task.id,
    attributes: { "judge.criterion": input.criterion.name },
  });
  let verdict: WorkflowJudgeVerdict;
  try {
    verdict = await Effect.runPromise(input.criterion.evaluate(context));
  } catch (error) {
    judgeSpan?.end("error", error);
    throw error;
  }
  judgeSpan?.annotate("judge.verdict", verdict.verdict);
  judgeSpan?.end("ok");
  const cacheWrite = input.store?.recordJudge({ identity, verdict, evidence, output: input.output, taskMetadata });
  if (cacheWrite?.stored === false) {
    recordEvent(input.store, input.runId, input.task.id, "task.judge.cache_write.skipped_sensitive", {
      criterion: input.criterion.name,
      cacheKey,
      findingCount: cacheWrite.findingCount,
    });
  }
  recordEvent(input.store, input.runId, input.task.id, "task.judge.completed", {
    criterion: input.criterion.name,
    cacheKey,
    verdict: verdict.verdict,
    ...(judgeFeedback(verdict) !== undefined ? { feedback: judgeFeedback(verdict) } : {}),
  });
  return { verdict, cached: false, identity, evidence, taskMetadata };
};

const runFinishCriteria = async (input: {
  readonly task: AnyWorkflowTask;
  readonly workflowIdentity: WorkflowTaskIdentity;
  readonly output: unknown;
  readonly rawOutput: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly store: WorkflowStore | undefined;
  readonly runId: string | null;
  readonly tracing?: WorkflowTraceRecorder;
  readonly parentSpanId?: string;
}): Promise<WorkflowFinishCriteriaResult> => {
  const judgeRuns: Array<{ readonly criterion: string; readonly verdict: WorkflowJudgeVerdict["verdict"]; readonly cached: boolean; readonly cacheKey: string }> = [];
  for (const criterion of input.task.finish?.criteria ?? []) {
    if (criterion.kind === "judge") {
      try {
        const judge = await runJudgeCriterion({
          criterion: criterion as WorkflowJudgeFinishCriterion<unknown, unknown>,
          workflowIdentity: input.workflowIdentity,
          task: input.task,
          output: input.output,
          metadata: input.metadata,
          store: input.store,
          runId: input.runId,
          ...(input.tracing !== undefined ? { tracing: input.tracing } : {}),
          ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
        });
        judgeRuns.push({
          criterion: criterion.name,
          verdict: judge.verdict.verdict,
          cached: judge.cached,
          cacheKey: judge.identity.cacheKey,
        });
        if (judge.verdict.verdict === "pass") continue;
        if (judge.verdict.verdict === "continue") {
          return {
            ok: false,
            status: "continue",
            criterion: criterion.name,
            error: judge.verdict.feedback,
            repairPrompt: judge.verdict.feedback,
            judgeRuns,
          };
        }
        if (judge.verdict.verdict === "escalate") {
          return {
            ok: false,
            status: "escalate",
            criterion: criterion.name,
            error: judge.verdict.feedback ?? "judge requested escalation",
            feedback: judge.verdict.feedback,
            judgeRuns,
          };
        }
        return {
          ok: false,
          status: "fail",
          criterion: criterion.name,
          error: judge.verdict.feedback ?? "judge criterion failed",
          judgeRuns,
        };
      } catch (error) {
        return { ok: false, status: "fail", criterion: criterion.name, error, judgeRuns };
      }
    }
    const context = {
      output: input.output as never,
      rawOutput: input.rawOutput,
      metadata: input.metadata,
    };
    try {
      await Effect.runPromise(criterion.check(context));
    } catch (error) {
      return {
        ok: false,
        status: "continue",
        criterion: criterion.name,
        error,
        repairPrompt: criterion.repairPrompt?.(error, context) ??
          `Finish criterion '${criterion.name}' failed: ${errorMessage(error)}. Preserve the useful substance, fix the issue, and return the corrected final response.`,
        judgeRuns,
      };
    }
  }
  return { ok: true, judgeRuns };
};

const recordCacheLookup = (
  store: WorkflowStore | undefined,
  runId: string | null,
  task: AnyWorkflowTask,
  identity: WorkflowTaskIdentity,
  mockOutput: boolean,
): { readonly cached: { readonly output: unknown } | null | undefined; readonly cacheHit: boolean } => {
  recordEvent(store, runId, task.id, "task.cache_lookup.started", identity);
  const cached = store?.getCompleted(identity, { allowMockSourced: mockOutput });
  const cacheHit = cached !== undefined && cached !== null;
  recordEvent(store, runId, task.id, cacheHit ? "task.cache_lookup.hit" : "task.cache_lookup.miss", {
    cacheKey: identity.cacheKey,
  });
  return { cached, cacheHit };
};

const recordRunTaskIfPersisted = (input: {
  readonly store: WorkflowStore | undefined;
  readonly runId: string | null;
  readonly ordinal: number;
  readonly identity: WorkflowTaskIdentity;
  readonly agent: { readonly plugin: string; readonly name: string };
  readonly status: "completed" | "failed" | "escalated";
  readonly cached: boolean;
  readonly output: unknown;
  readonly metadata?: Record<string, unknown>;
}): void => {
  if (input.store === undefined || input.runId === null) return;
  if (input.store.getRun(input.runId)?.status !== "running") return;
  if (input.store.listRunTasks(input.runId).some((record) => record.ordinal === input.ordinal)) return;
  try {
    input.store.recordRunTask({
      runId: input.runId,
      ordinal: input.ordinal,
      identity: input.identity,
      agent: input.agent,
      status: input.status,
      cached: input.cached,
      output: input.output,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
  } catch (error) {
    if (input.store.getRun(input.runId)?.status !== "running") return;
    throw error;
  }
};

const assertRunStillRunning = (
  store: WorkflowStore | undefined,
  runId: string | null,
): void => {
  if (store === undefined || runId === null) return;
  const run = store.getRun(runId);
  if (run?.status !== "running") {
    throw new WorkflowRunStoppedError(runId);
  }
};

const createRunCancellationBarrier = (
  store: WorkflowStore | undefined,
  runId: string | null,
  limiter: TaskExecutionLimiter,
  externalAbortSignal?: AbortSignal,
): RunCancellationBarrier => {
  const controller = new AbortController();
  const activeTaskCounts = new Map<string, number>();
  let eventReason = "run-cancelled";
  const recordTaskAbort = (taskId: string): void => {
    if (store === undefined || runId === null) return;
    store.recordEvent({
      runId,
      taskId,
      type: "task.abort_monitor_triggered",
      payload: { reason: eventReason },
    });
  };
  const abort = (reason: unknown, nextEventReason: string): void => {
    if (controller.signal.aborted) return;
    eventReason = nextEventReason;
    for (const taskId of activeTaskCounts.keys()) recordTaskAbort(taskId);
    controller.abort(reason);
    limiter.cancelPending(reason);
  };
  const onExternalAbort = (): void => {
    abort(externalAbortSignal?.reason ?? new Error("workflow run aborted"), "runner-termination-signal");
  };
  if (externalAbortSignal?.aborted === true) {
    onExternalAbort();
  } else {
    externalAbortSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  const interval = store !== undefined && runId !== null ? setInterval(() => {
    if (store.getRun(runId)?.status !== "running") {
      abort(new WorkflowRunStoppedError(runId), "run-not-running");
    }
  }, 250) : undefined;
  return {
    signal: controller.signal,
    abort,
    throwIfAborted: () => {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    attemptInterruption: () => {
      const run = store !== undefined && runId !== null ? store.getRun(runId) : undefined;
      const terminalCause = run?.terminalCause;
      const message = terminalCause !== null && terminalCause !== undefined && "reason" in terminalCause
        ? terminalCause.reason
        : errorMessage(controller.signal.reason ?? new Error("workflow run cancelled"));
      if (run?.status === "crashed") {
        return { status: "crashed", failure: { kind: "crashed", message } };
      }
      if (
        run?.status === "stopped"
        || eventReason === "runner-termination-signal"
        || (eventReason === "run-not-running" && run?.status !== "failed" && run?.status !== "escalated")
      ) {
        return { status: "stopped", failure: { kind: "stopped", message } };
      }
      return undefined;
    },
    trackTask: (taskId) => {
      activeTaskCounts.set(taskId, (activeTaskCounts.get(taskId) ?? 0) + 1);
      return () => {
        const remaining = (activeTaskCounts.get(taskId) ?? 1) - 1;
        if (remaining === 0) activeTaskCounts.delete(taskId);
        else activeTaskCounts.set(taskId, remaining);
      };
    },
    dispose: () => {
      clearInterval(interval);
      externalAbortSignal?.removeEventListener("abort", onExternalAbort);
      activeTaskCounts.clear();
    },
  };
};

const isWorkflowRunBudgetError = (
  error: unknown,
): error is WorkflowRunTimeoutError | WorkflowFanoutExceededError | WorkflowCostExceededError | WorkflowCostUnavailableError | WorkflowPromptLimitError =>
  error instanceof WorkflowRunTimeoutError
  || error instanceof WorkflowFanoutExceededError
  || error instanceof WorkflowCostExceededError
  || error instanceof WorkflowCostUnavailableError
  || error instanceof WorkflowPromptLimitError;

const createWorkflowRunBudget = (
  options: {
    readonly maxWallMs?: number;
    readonly maxTasks?: number;
    readonly maxCostUsd?: number;
    readonly maxPromptBytes?: number;
  },
  cancellation: RunCancellationBarrier,
): WorkflowRunBudget => {
  let liveTasks = 0;
  let observedCostUsd = 0;
  const maxPromptBytes = options.maxPromptBytes;
  const wallTimer = options.maxWallMs === undefined ? undefined : setTimeout(() => {
    const error = new WorkflowRunTimeoutError(options.maxWallMs!);
    cancellation.abort(error, "workflow-timeout");
  }, options.maxWallMs);
  return {
    admitLiveTask: () => {
      cancellation.throwIfAborted();
      const observed = liveTasks + 1;
      if (options.maxTasks !== undefined && observed > options.maxTasks) {
        const error = new WorkflowFanoutExceededError(options.maxTasks, observed);
        cancellation.abort(error, "workflow-fanout-exceeded");
        throw error;
      }
      liveTasks = observed;
    },
    assertPrompt: (task) => {
      if (maxPromptBytes === undefined) return;
      const observedBytes = Buffer.byteLength(
        `${task.prompt}${workflowWorkerJsonInstruction(task)}`,
        "utf8",
      );
      if (observedBytes <= maxPromptBytes || cancellation.signal.aborted) return;
      const error = new WorkflowPromptLimitError(task.id, maxPromptBytes, observedBytes);
      cancellation.abort(error, "workflow-prompt-limit-exceeded");
      throw error;
    },
    observeLiveAttempt: (metadata, requireReportedCost) => {
      const costUsd = workflowUsageFromMetadata(metadata).costUsd;
      if (
        options.maxCostUsd !== undefined
        && requireReportedCost
        && costUsd === undefined
        && !cancellation.signal.aborted
      ) {
        const error = new WorkflowCostUnavailableError(options.maxCostUsd);
        cancellation.abort(error, "workflow-cost-unavailable");
        throw error;
      }
      observedCostUsd += costUsd ?? 0;
      if (
        options.maxCostUsd !== undefined
        && observedCostUsd > options.maxCostUsd
        && !cancellation.signal.aborted
      ) {
        const error = new WorkflowCostExceededError(options.maxCostUsd, observedCostUsd);
        cancellation.abort(error, "workflow-cost-exceeded");
        throw error;
      }
    },
    dispose: () => {
      clearTimeout(wallTimer);
    },
  };
};

const awaitRunScoped = async <A>(
  operation: Promise<A>,
  cancellation: RunCancellationBarrier,
): Promise<A> => {
  let rejectOnAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = (): void => rejectOnAbort(cancellation.signal.reason);
  if (cancellation.signal.aborted) onAbort();
  else cancellation.signal.addEventListener("abort", onAbort, { once: true });
  void operation.catch(() => undefined);
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    cancellation.signal.removeEventListener("abort", onAbort);
  }
};

// WFE-009: one shared executor-level retry mechanism, generalized from the shipped `agy`
// adapter's own retry (7ea1e27) so every worker gets the same transient-failure recovery
// without per-adapter duplication. Defaults mirror `agy`'s waitForAgyBackoff shape: 1 retry
// (2 attempts total), fixed 2000ms backoff capped by the remaining process-timeout deadline
// when — and only when — the task declared one.
const DEFAULT_WORKFLOW_EXECUTOR_RETRY_MAX_ATTEMPTS = 2;
const DEFAULT_WORKFLOW_EXECUTOR_RETRY_BACKOFF_MS = 2_000;

type WorkflowExecutorFailureClass = "transient" | "terminal";

// Every worker adapter throws these two message shapes verbatim for process-level timeout
// and non-zero exit (see workflow-{codex,opencode,claude,grok,kimi,amp,hermes,devin,omp}-worker.ts).
// Anything else — WorkflowPermissionError, model-resolution errors, adapter-specific config/parse
// errors — does not match and stays terminal by construction; no denylist needed.
const WORKFLOW_EXECUTOR_PROCESS_TIMEOUT_PATTERN = /\bexceeded Prism process timeout after \d+ms\b/u;
const WORKFLOW_EXECUTOR_NONZERO_EXIT_PATTERN = /\bexited with -?\d+:/u;

const classifyWorkflowExecutorFailure = (error: unknown): WorkflowExecutorFailureClass => {
  if (error instanceof WorkflowTaskNoProgressError) return "transient";
  if (!(error instanceof Error)) return "terminal";
  if (WORKFLOW_EXECUTOR_PROCESS_TIMEOUT_PATTERN.test(error.message)) return "transient";
  if (WORKFLOW_EXECUTOR_NONZERO_EXIT_PATTERN.test(error.message)) return "transient";
  return "terminal";
};

const resolveWorkflowExecutorRetryMaxAttempts = (task: AnyWorkflowTask): number =>
  task.worker?.retry?.maxAttempts
  ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_EXECUTOR_RETRY_MAX_ATTEMPTS)
  ?? DEFAULT_WORKFLOW_EXECUTOR_RETRY_MAX_ATTEMPTS;

const resolveWorkflowExecutorRetryBackoffMs = (task: AnyWorkflowTask): number =>
  task.worker?.retry?.backoffMs
  ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_EXECUTOR_RETRY_BACKOFF_MS)
  ?? DEFAULT_WORKFLOW_EXECUTOR_RETRY_BACKOFF_MS;

const waitForWorkflowExecutorRetryBackoff = async (input: {
  readonly delayMs: number;
  readonly abortSignal: AbortSignal;
}): Promise<void> => {
  if (input.delayMs <= 0) return;
  if (input.abortSignal.aborted) throw input.abortSignal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(input.abortSignal.reason);
    };
    const timer = setTimeout(() => {
      input.abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, input.delayMs);
    input.abortSignal.addEventListener("abort", onAbort, { once: true });
  });
};

const executeWorkflowTask = async (input: {
  readonly ordinal: number;
  readonly task: AnyWorkflowTask;
  readonly identity: WorkflowTaskIdentity;
  readonly runId: string | null;
  readonly store?: WorkflowStore;
  readonly executeTask: WorkflowTaskExecutor;
  readonly mockOutput: boolean;
  readonly taskNoProgressMs?: number;
  readonly runtimeOptions: WorkflowRuntimeOptions;
  readonly limiter?: TaskExecutionLimiter;
  readonly cancellation: RunCancellationBarrier;
  readonly budget: WorkflowRunBudget;
  readonly tracing: WorkflowTraceRecorder;
  readonly parentSpanId?: string;
}): Promise<WorkflowTaskOutcome> => {
  const { ordinal, task, identity, runId, store, executeTask, mockOutput, tracing } = input;
  input.cancellation.throwIfAborted();
  assertRunStillRunning(store, runId);
  const taskSpan = tracing.startSpan("workflow.task", {
    ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
    taskId: task.id,
    attributes: {
      "task.id": task.id,
      "task.ordinal": ordinal,
      "agent.plugin": task.agent.plugin,
      "agent.name": task.agent.name,
      "task.cache_key": identity.cacheKey,
    },
  });
  if (store !== undefined && runId !== null) {
    store.recordRunTaskSnapshot(workflowRunTaskSnapshotForTask({
      runId,
      ordinal,
      workflow: identity.workflow,
      task,
      runtimeOptions: input.runtimeOptions,
    }));
  }
  recordEvent(store, runId, task.id, "task.started", { cacheKey: identity.cacheKey });
  const { cached, cacheHit } = recordCacheLookup(store, runId, task, identity, mockOutput);

  let taskFailureEvidence: WorkflowTaskFailureEvidence | undefined;
  let lastAttempt = 0;

  const runTaskBoundary = async (): Promise<WorkflowRunTaskResult> => {
    let rawOutput: unknown;
    let decodedOutput: unknown = undefined;
    let metadata: Record<string, unknown> | undefined;
    // Objective decode/parse repair is independent of finish criteria: a malformed
    // output is unambiguously wrong and re-promptable, so it self-heals by default
    // even when the task declares no `finish`. Subjective finish-criterion "continue"
    // repair stays gated on the author-declared finish budget.
    const maxDecodeRepairs = cacheHit ? 0 : task.finish?.maxDecodeRepairs ?? DEFAULT_WORKFLOW_DECODE_REPAIRS;
    const maxFinishRepairs = cacheHit ? 0 : task.finish?.maxRepairs ?? 0;
    // WFE-009: executor-level transient-failure retry budget. `maxAttempts` counts total
    // attempts, so the retry count is one less; the deadline anchors to this boundary's
    // start so backoff never outruns the task's own process-timeout budget.
    const executorRetryMaxRetries = cacheHit ? 0 : Math.max(0, resolveWorkflowExecutorRetryMaxAttempts(task) - 1);
    const executorRetryBackoffMs = resolveWorkflowExecutorRetryBackoffMs(task);
    const executorRetryDeadlineAt = task.worker?.processTimeoutMs === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() + task.worker.processTimeoutMs;
    let executorRetries = 0;
    let attemptTask = task;
    let repairs = 0;
    let decodeRepairs = 0;
    let finishRepairs = 0;
    let pendingRepair: WorkflowTaskRepairContext | undefined;
    let finishJudgeRuns: ReadonlyArray<{ readonly criterion: string; readonly verdict: WorkflowJudgeVerdict["verdict"]; readonly cached: boolean; readonly cacheKey: string }> = [];
    const repairAttempts: Array<{
      attempt: number;
      criterion: string;
      mode: Exclude<WorkflowTaskRepairMode, "none">;
      fallbackReason?: WorkflowTaskRepairContext["fallbackReason"];
      continuation?: WorkflowTaskRepairContext["continuation"];
    }> = [];
    const attemptStartMetadata = (): Record<string, unknown> | undefined => {
      if (cacheHit) return undefined;
      return metadataWithRepairExecution(normalizeWorkflowSessionMetadata({
        ...workflowContractMetadata,
        ...(pendingRepair?.mode === "native-continuation" ? pendingRepair.previousMetadata : {}),
        ...(task.worker?.worker !== undefined ? { adapter: task.worker.worker } : {}),
        ...(typeof task.worker?.model === "string" ? { model: task.worker.model } : {}),
        nativeAgent: task.agent.name,
      }), pendingRepair);
    };
    let activeAttempt: number | undefined;
    const startAttempt = (): void => {
      if (cacheHit) return;
      const attempt = repairs + 1;
      if (store !== undefined && runId !== null) {
        const metadata = attemptStartMetadata();
        store.recordTaskAttemptStarted({
          runId,
          ordinal,
          attempt,
          taskId: task.id,
          ...(metadata !== undefined ? { metadata } : {}),
        });
      }
      activeAttempt = attempt;
      lastAttempt = attempt;
    };
    const finishAttempt = (
      status: Exclude<WorkflowTaskAttemptStatus, "running">,
      attemptMetadata: Record<string, unknown> | undefined,
      failure?: WorkflowTaskAttemptFailure,
    ): void => {
      const attempt = activeAttempt;
      if (attempt === undefined) return;
      if (store !== undefined && runId !== null) {
        const persistedAttempt = store.listRunTaskAttempts(runId).find(
          (record) => record.ordinal === ordinal && record.attempt === attempt,
        );
        if (store.getRun(runId)?.status === "running" && persistedAttempt?.status === "running") {
          try {
            store.recordTaskAttemptFinished({
              runId,
              ordinal,
              attempt,
              status,
              ...(attemptMetadata !== undefined ? { metadata: attemptMetadata } : {}),
              ...(failure !== undefined ? { failure } : {}),
            });
          } catch (error) {
            const current = store.listRunTaskAttempts(runId).find(
              (record) => record.ordinal === ordinal && record.attempt === attempt,
            );
            if (current === undefined || current.status === "running") throw error;
          }
        }
      }
      activeAttempt = undefined;
    };
    const finishFailedAttempt = (
      kind: Extract<WorkflowTaskAttemptFailureKind, "executor" | "decode" | "finish">,
      error: unknown,
      attemptMetadata: Record<string, unknown> | undefined = metadata,
    ): void => {
      finishAttempt("failed", normalizedAttemptMetadata(attemptMetadata, error), {
        kind,
        message: errorMessage(error),
      });
      taskFailureEvidence = {
        taskId: task.id,
        ordinal,
        attempt: lastAttempt,
        errorName: errorName(error),
        message: errorMessage(error),
      };
    };
    const finishInterruptedAttempt = (error: unknown): boolean => {
      const interruption = input.cancellation.attemptInterruption();
      if (interruption === undefined) return false;
      finishAttempt(
        interruption.status,
        normalizedAttemptMetadata(metadata, error),
        interruption.failure,
      );
      return true;
    };
    const beginRepair = (criterion: string, repairPrompt: string): void => {
      assertRunStillRunning(store, runId);
      const plan = repairExecutionPlan(task, metadata);
      if (plan.mode === "native-continuation") {
        pendingRepair = {
          attempt: repairs,
          criterion,
          repairPrompt,
          previousMetadata: metadata,
          mode: "native-continuation",
          continuation: plan.continuation,
        };
      } else {
        pendingRepair = {
          attempt: repairs,
          criterion,
          repairPrompt,
          previousMetadata: metadata,
          mode: "fresh-executor-invocation",
          fallbackReason: plan.fallbackReason,
        };
      }
      repairAttempts.push({
        attempt: repairs,
        criterion,
        mode: plan.mode,
        ...(plan.fallbackReason !== undefined ? { fallbackReason: plan.fallbackReason } : {}),
        ...(plan.continuation !== undefined ? { continuation: plan.continuation } : {}),
      });
      recordEvent(store, runId, task.id, "task.repair.started", {
        attempt: repairs,
        criterion,
        mode: plan.mode,
        ...(plan.fallbackReason !== undefined ? { fallbackReason: plan.fallbackReason } : {}),
        ...(plan.continuation !== undefined ? { continuation: plan.continuation } : {}),
        repairPrompt,
      });
      attemptTask = appendRepairPrompt(task, repairPrompt);
    };
    while (true) {
      if (!cacheHit) metadata = undefined;
      input.cancellation.throwIfAborted();
      assertRunStillRunning(store, runId);
      input.budget.assertPrompt(attemptTask);
      const executorSpan = cacheHit ? undefined : tracing.startSpan("task.executor", {
        parentSpanId: taskSpan.spanId,
        taskId: task.id,
        attributes: { "executor.attempt": repairs },
      });
      let attemptUsageObserved = false;
      try {
        input.cancellation.throwIfAborted();
        startAttempt();
        if (!cacheHit) recordEvent(store, runId, task.id, "task.executor.started", { attempt: repairs });
        const stopTracking = input.cancellation.trackTask(task.id);
        try {
          if (cacheHit) {
            ({ rawOutput, metadata } = await executeOrReuseTask({
              task: attemptTask,
              cached: repairs === 0 ? cached : null,
              executeTask,
            }));
          } else {
            ({ rawOutput, metadata } = await executeLiveTaskAttempt({
              task: attemptTask,
              executeTask,
              runSignal: input.cancellation.signal,
              taskNoProgressMs: input.taskNoProgressMs,
              onProgress: (source) => recordEvent(
                store,
                runId,
                task.id,
                "task.progress",
                { source },
              ),
              ...(pendingRepair !== undefined ? { repair: pendingRepair } : {}),
            }));
            attemptUsageObserved = true;
            input.budget.observeLiveAttempt(metadata, !mockOutput);
          }
        } finally {
          stopTracking();
        }
        input.cancellation.throwIfAborted();
        if (pendingRepair !== undefined) {
          const repairExecution = repairAttempts.at(-1);
          if (repairExecution !== undefined) {
            repairAttempts[repairAttempts.length - 1] = {
              ...repairExecution,
              mode: metadataRepairMode(metadata, pendingRepair.mode),
              ...(objectMetadata(metadata?.repairExecution)?.fallbackReason !== undefined
                ? { fallbackReason: objectMetadata(metadata?.repairExecution)?.fallbackReason as WorkflowTaskRepairContext["fallbackReason"] }
                : {}),
            };
          }
          pendingRepair = undefined;
        }
        if (!cacheHit) recordEvent(store, runId, task.id, "task.executor.completed", { attempt: repairs, ...(metadata ?? {}) });
        if (executorSpan !== undefined) {
          for (const key of ["adapter", "model", "nativeAgent", "sessionId"] as const) {
            const value = metadata?.[key];
            if (typeof value === "string") executorSpan.annotate(`worker.${key}`, value);
          }
          executorSpan.end("ok");
        }
      } catch (caught) {
        let error: unknown = caught;
        metadata = normalizedAttemptMetadata(metadata, error);
        if (!cacheHit && !attemptUsageObserved) {
          attemptUsageObserved = true;
          try {
            input.budget.observeLiveAttempt(metadata, !mockOutput);
          } catch (budgetError) {
            error = budgetError;
          }
        }
        if (isWorkflowRunBudgetError(input.cancellation.signal.reason)) {
          error = input.cancellation.signal.reason;
        }
        executorSpan?.end("error", error);
        const parseError = error instanceof WorkflowOutputParseError ? error : undefined;
        let parseAttemptFinished = false;
        let parseInterrupted = false;
        if (parseError !== undefined) {
          parseInterrupted = finishInterruptedAttempt(error);
          if (!parseInterrupted) finishFailedAttempt("decode", error);
          parseAttemptFinished = true;
          recordEvent(store, runId, task.id, "task.decode.failed", {
            attempt: repairs,
            error: parseError.message,
            ...(parseError.rawText !== undefined ? { rawText: parseError.rawText } : {}),
          });
        }
        if (parseError !== undefined && !parseInterrupted && decodeRepairs < maxDecodeRepairs) {
          repairs += 1;
          decodeRepairs += 1;
          const repairPrompt = parseRepairPrompt(parseError);
          beginRepair("output-json-parse", repairPrompt);
          continue;
        }
        // WFE-009: retry classified-transient executor failures (process/idle timeout,
        // unclassified non-zero exit) in place, before falling through to the terminal path.
        // Cancellation-barrier outcomes (stopped/crashed) and config/load errors never match
        // and always fall through unchanged. The antigravity-cli adapter already retries
        // internally (waitForAgyBackoff) — exempt it here so failure classes are never
        // retried twice by two mechanisms.
        if (
          parseError === undefined
          && executorRetries < executorRetryMaxRetries
          && input.cancellation.attemptInterruption() === undefined
          && metadata?.adapter !== "antigravity-cli"
          && classifyWorkflowExecutorFailure(error) === "transient"
        ) {
          const remainingMs = executorRetryDeadlineAt - Date.now();
          if (remainingMs > 0) {
            finishFailedAttempt("executor", error);
            repairs += 1;
            executorRetries += 1;
            const backoffMs = Math.min(executorRetryBackoffMs, remainingMs);
            recordEvent(store, runId, task.id, "task.executor.retrying", {
              attempt: repairs,
              executorRetries,
              backoffMs,
              error: errorMessage(error),
            });
            await waitForWorkflowExecutorRetryBackoff({ delayMs: backoffMs, abortSignal: input.cancellation.signal });
            continue;
          }
        }
        const interrupted = parseAttemptFinished ? parseInterrupted : finishInterruptedAttempt(error);
        if (!interrupted && !parseAttemptFinished) finishFailedAttempt("executor", error);
        const output: Record<string, unknown> = { error: errorMessage(error) };
        const rawText = (error as { readonly rawText?: unknown } | null | undefined)?.rawText;
        if (rawText !== undefined) output.rawText = rawText;
        // OBS-006: a hard executor failure (aborted, timed out, non-zero exit, unparseable
        // output, ...) previously discarded everything the adapter knew about the failure —
        // the stderr excerpt/hash and the harness session id captured on the success path —
        // down to bare contract metadata, in the event payload. `metadata` above is already
        // merged with error.metadata (normalizedAttemptMetadata at the top of this catch);
        // carry it into the event too so a failed task can be joined to its harness session
        // and stderr tail from the event stream, not only from the persisted row.
        recordEvent(store, runId, task.id, "task.executor.failed", { attempt: repairs, ...output, ...(metadata ?? {}) });
        recordRunTaskIfPersisted({
          store,
          runId,
          ordinal,
          identity,
          agent: taskAgent(task),
          status: "failed",
          cached: false,
          output,
          metadata: normalizedAttemptMetadata(metadata, error),
        });
        throw error;
      }

      recordEvent(store, runId, task.id, "task.decode.started", { attempt: repairs });
      const decoded = decodeTaskOutput(task, rawOutput);
      if (Either.isLeft(decoded)) {
        const error = decoded.left;
        if (decodeRepairs < maxDecodeRepairs) {
          finishFailedAttempt("decode", error);
          recordEvent(store, runId, task.id, "task.decode.failed", { attempt: repairs, error: String(error), attemptedOutput: rawOutput });
          repairs += 1;
          decodeRepairs += 1;
          const repairPrompt = schemaRepairPrompt(error);
          beginRepair("output-schema", repairPrompt);
          continue;
        }
        const decodeError = new WorkflowTaskDecodeError(task.id, error);
        finishFailedAttempt("decode", decodeError);
        recordEvent(store, runId, task.id, "task.decode.failed", { attempt: repairs, error: String(error), attemptedOutput: rawOutput });
        recordRunTaskIfPersisted({
          store,
          runId,
          ordinal,
          identity,
          agent: taskAgent(task),
          status: "failed",
          cached: cacheHit,
          output: rawOutput,
          metadata,
        });
        throw decodeError;
      }

      decodedOutput = decoded.right;
      recordEvent(store, runId, task.id, "task.decode.completed", { attempt: repairs });
      let finish: WorkflowFinishCriteriaResult;
      try {
        finish = await runFinishCriteria({
          task,
          workflowIdentity: identity,
          output: decodedOutput,
          rawOutput,
          metadata,
          store,
          runId,
          tracing,
          ...(tracing.enabled ? { parentSpanId: taskSpan.spanId } : {}),
        });
        input.cancellation.throwIfAborted();
        assertRunStillRunning(store, runId);
      } catch (error) {
        if (!finishInterruptedAttempt(error)) finishFailedAttempt("finish", error);
        throw error;
      }
      finishJudgeRuns = finish.judgeRuns;
      if (finish.ok) {
        const repairMode = summarizeRepairMode(repairAttempts.map((repair) => repair.mode));
        recordEvent(store, runId, task.id, "task.finish.completed", {
          repairs,
          decodeRepairs,
          finishRepairs,
          repairMode,
          criteria: task.finish?.criteria?.map((criterion) => criterion.name) ?? [],
          judgeRuns: finish.judgeRuns,
        });
        break;
      }
      recordEvent(store, runId, task.id, "task.finish.failed", {
        attempt: repairs,
        criterion: finish.criterion,
        status: finish.status,
        error: errorMessage(finish.error),
        output: decodedOutput,
        judgeRuns: finish.judgeRuns,
      });
      if (finish.status === "continue" && finishRepairs < maxFinishRepairs) {
        finishFailedAttempt("finish", finish.error);
        repairs += 1;
        finishRepairs += 1;
        beginRepair(finish.criterion, finish.repairPrompt);
        continue;
      }
      if (finish.status === "escalate") {
        const repairMode = summarizeRepairMode(repairAttempts.map((repair) => repair.mode));
        const escalatedMetadata = {
          ...workflowContractMetadata,
          ...(metadata ?? {}),
          finish: {
            repairs,
            decodeRepairs,
            finishRepairs,
            criteria: task.finish?.criteria?.map((criterion) => criterion.name) ?? [],
            repairMode,
            judgeRuns: finish.judgeRuns,
            escalated: true,
            escalation: {
              criterion: finish.criterion,
              ...(finish.feedback !== undefined ? { feedback: finish.feedback } : {}),
            },
          },
        };
        const escalationError = new WorkflowTaskEscalatedError(task.id, finish.criterion, finish.feedback);
        finishFailedAttempt("finish", escalationError, escalatedMetadata);
        recordRunTaskIfPersisted({
          store,
          runId,
          ordinal,
          identity,
          agent: taskAgent(task),
          status: "escalated",
          cached: cacheHit,
          output: decodedOutput,
          metadata: escalatedMetadata,
        });
        throw escalationError;
      }
      const finishError = new Error(`workflow task ${task.id} failed finish criterion '${finish.criterion}': ${errorMessage(finish.error)}`);
      finishFailedAttempt("finish", finishError);
      recordRunTaskIfPersisted({
        store,
        runId,
        ordinal,
        identity,
        agent: taskAgent(task),
        status: "failed",
        cached: cacheHit,
        output: rawOutput,
        metadata,
      });
      throw finishError;
    }

    const criteria = task.finish?.criteria?.map((criterion) => criterion.name) ?? [];
    const repairMode = summarizeRepairMode(repairAttempts.map((repair) => repair.mode));
    const finalMetadata = repairs > 0 || task.finish !== undefined || hasNonContractMetadata(metadata)
      ? {
        ...workflowContractMetadata,
        ...(metadata ?? {}),
        finish: {
          repairs,
          decodeRepairs,
          finishRepairs,
          criteria,
          repairMode,
          ...(repairAttempts.length > 0 ? { repairAttempts } : {}),
          ...(finishJudgeRuns.length > 0 ? { judgeRuns: finishJudgeRuns } : {}),
        },
      }
      : { ...workflowContractMetadata, ...(metadata ?? {}) };
    try {
      input.cancellation.throwIfAborted();
      assertRunStillRunning(store, runId);
      finishAttempt("completed", finalMetadata);
    } catch (error) {
      if (!finishInterruptedAttempt(error)) finishFailedAttempt("finish", error, finalMetadata);
      throw error;
    }
    if (!cacheHit) {
      const cacheWrite = store?.recordCompleted({
        identity,
        agent: taskAgent(task),
        output: decodedOutput,
        metadata: finalMetadata,
        ...(mockOutput ? { outputSource: "mock-output" as const } : {}),
      });
      if (cacheWrite?.stored === false) {
        recordEvent(store, runId, task.id, "task.cache_write.skipped_sensitive", {
          cacheKey: identity.cacheKey,
          findingCount: cacheWrite.findingCount,
        });
      } else {
        recordEvent(store, runId, task.id, "task.cache_write.completed", {
          cacheKey: identity.cacheKey,
          ...(mockOutput ? { outputSource: "mock-output" } : {}),
        });
      }
    }
    recordRunTaskIfPersisted({
      store,
      runId,
      ordinal,
      identity,
      agent: taskAgent(task),
      status: "completed",
      cached: cacheHit,
      output: decodedOutput,
      metadata: finalMetadata,
    });
    if (repairs > 0) taskSpan.annotate("task.repairs", repairs);
    return { id: task.id, agent: taskAgent(task), output: decodedOutput, cached: cacheHit, status: "completed", metadata: finalMetadata };
  };

  try {
    const result = cacheHit || input.limiter === undefined
      ? await runTaskBoundary()
      : await input.limiter.run(async () => {
        input.budget.admitLiveTask();
        return await runTaskBoundary();
      });
    taskSpan.annotate("task.cached", result.cached);
    taskSpan.annotate("task.status", result.status);
    taskSpan.end("ok");
    return { result };
  } catch (error) {
    const result = failedTaskResult(task, cacheHit, error);
    // External/user stop, internal run budgets, and persisted runner loss remain run-level
    // interruptions. Task-local no-progress timeouts remain fault-isolated.
    if (
      isWorkflowRunBudgetError(error)
      || error instanceof WorkflowRunStoppedError
      || input.cancellation.attemptInterruption() !== undefined
    ) {
      recordRunTaskIfPersisted({
        store,
        runId,
        ordinal,
        identity,
        agent: taskAgent(task),
        status: "failed",
        cached: cacheHit,
        output: result.output,
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
      });
      taskSpan.annotate("task.cached", result.cached);
      taskSpan.annotate("task.status", result.status);
      taskSpan.end("error", error);
      throw error;
    }
    // Every task-local executor/decode/finish failure remains fault-isolated.
    taskSpan.annotate("task.cached", result.cached);
    taskSpan.annotate("task.status", result.status);
    taskSpan.end("error", error);
    return {
      result,
      failure: error,
      failureEvidence: taskFailureEvidence ?? {
        taskId: task.id,
        ordinal,
        attempt: lastAttempt,
        errorName: errorName(error),
        message: errorMessage(error),
      },
    };
  }
};

const finishRunIfRunning = (
  store: WorkflowStore | undefined,
  runId: string | null,
  status: Exclude<WorkflowRunStatus, "running" | "unknown">,
  terminalCause: WorkflowRunTerminalCause,
): void => {
  if (store === undefined || runId === null || store.getRun(runId)?.status !== "running") return;
  try {
    store.finishRun(runId, status, terminalCause);
  } catch (error) {
    if (store.getRun(runId)?.status !== "running") return;
    throw error;
  }
};

const taskTerminalCause = (
  status: Extract<WorkflowRunTaskResultStatus, "failed" | "escalated">,
  evidence: WorkflowTaskFailureEvidence,
): WorkflowRunTerminalCause => ({
  kind: status === "escalated" ? "task-escalated" : "task-failed",
  taskId: evidence.taskId,
  ordinal: evidence.ordinal,
  attempt: evidence.attempt,
  errorName: evidence.errorName,
  message: evidence.message,
});

const workflowRunBudgetTerminalCause = (
  error: WorkflowRunTimeoutError | WorkflowFanoutExceededError | WorkflowCostExceededError | WorkflowCostUnavailableError | WorkflowPromptLimitError,
): WorkflowRunTerminalCause => {
  if (error instanceof WorkflowRunTimeoutError) {
    return { kind: "workflow-timeout", limitMs: error.limitMs };
  }
  if (error instanceof WorkflowFanoutExceededError) {
    return {
      kind: "workflow-fanout-exceeded",
      limit: error.limit,
      observed: error.observed,
    };
  }
  if (error instanceof WorkflowCostUnavailableError) {
    return {
      kind: "workflow-cost-unavailable",
      limitUsd: error.limitUsd,
    };
  }
  if (error instanceof WorkflowPromptLimitError) {
    return {
      kind: "workflow-prompt-limit-exceeded",
      taskId: error.taskId,
      limitBytes: error.limitBytes,
      observedBytes: error.observedBytes,
    };
  }
  return {
    kind: "workflow-cost-exceeded",
    limitUsd: error.limitUsd,
    observedUsd: error.observedUsd,
  };
};

const interruptionTerminalCause = (
  cancellation: RunCancellationBarrier,
  error: unknown,
): { readonly status: "stopped" | "crashed"; readonly cause: WorkflowRunTerminalCause } => {
  const interruption = cancellation.attemptInterruption();
  if (interruption?.status === "crashed") {
    return { status: "crashed", cause: { kind: "crashed", reason: interruption.failure.message } };
  }
  const reason = interruption?.failure.message ?? errorMessage(error);
  const signal = (error as { readonly signal?: unknown } | null | undefined)?.signal;
  return {
    status: "stopped",
    cause: {
      kind: "stopped",
      reason,
      ...(typeof signal === "string" ? { signal } : {}),
    },
  };
};

const runStaticWorkflow = async (input: {
  readonly workflow: AnyWorkflowDefinition;
  readonly runId: string | null;
  readonly store?: WorkflowStore;
  readonly executeTask: WorkflowTaskExecutor;
  readonly mockOutput: boolean;
  readonly taskNoProgressMs?: number;
  readonly limiter: TaskExecutionLimiter;
  readonly runtimeOptions: WorkflowRuntimeOptions;
  readonly cancellation: RunCancellationBarrier;
  readonly budget: WorkflowRunBudget;
  readonly tracing: WorkflowTraceRecorder;
  readonly rootSpanId?: string;
}): Promise<ReadonlyArray<WorkflowRunTaskResult>> => {
  const tasks: WorkflowRunTaskResult[] = [];
  for (const [index, task] of input.workflow.tasks.entries()) {
    const identity = workflowTaskIdentity(input.workflow.name, task, input.runtimeOptions);
    // A static pipeline is sequential: a failed task must stop the downstream chain, so its
    // captured failure is terminalized after its invocation settles and then re-thrown.
    const outcome = await executeWorkflowTask({
      ordinal: index,
      task,
      identity,
      runId: input.runId,
      store: input.store,
      executeTask: input.executeTask,
      mockOutput: input.mockOutput,
      ...(input.taskNoProgressMs !== undefined ? { taskNoProgressMs: input.taskNoProgressMs } : {}),
      runtimeOptions: input.runtimeOptions,
      limiter: input.limiter,
      cancellation: input.cancellation,
      budget: input.budget,
      tracing: input.tracing,
      ...(input.rootSpanId !== undefined ? { parentSpanId: input.rootSpanId } : {}),
    });
    if ("failure" in outcome) {
      const status = outcome.result.status === "escalated" ? "escalated" : "failed";
      finishRunIfRunning(
        input.store,
        input.runId,
        status,
        taskTerminalCause(status, outcome.failureEvidence),
      );
      throw outcome.failure;
    }
    tasks.push(outcome.result);
  }
  finishRunIfRunning(input.store, input.runId, "completed", { kind: "completed" });
  return tasks;
};

const runDynamicWorkflow = async (input: {
  readonly workflow: AnyWorkflowDefinition & {
    readonly run: (runtime: WorkflowRuntime) => Effect.Effect<unknown, WorkflowRuntimeError, never>;
  };
  readonly runId: string | null;
  readonly store?: WorkflowStore;
  readonly executeTask: WorkflowTaskExecutor;
  readonly mockOutput: boolean;
  readonly taskNoProgressMs?: number;
  readonly limiter: TaskExecutionLimiter;
  readonly runtimeOptions: WorkflowRuntimeOptions;
  readonly cancellation: RunCancellationBarrier;
  readonly budget: WorkflowRunBudget;
  readonly tracing: WorkflowTraceRecorder;
  readonly rootSpanId?: string;
}): Promise<{ readonly output: unknown; readonly tasks: ReadonlyArray<WorkflowRunTaskResult> }> => {
  const tasks: Array<WorkflowRunTaskResult | undefined> = [];
  const inFlightTasks: Array<Promise<WorkflowTaskOutcome>> = [];
  let ordinal = 0;
  const collectTasks = (): ReadonlyArray<WorkflowRunTaskResult> =>
    tasks.flatMap((task) => task === undefined ? [] : [task]);
  const finishRun = (
    status: Exclude<WorkflowRunStatus, "running" | "unknown">,
    terminalCause: WorkflowRunTerminalCause,
  ): void => {
    finishRunIfRunning(input.store, input.runId, status, terminalCause);
  };
  const runtime: WorkflowRuntime = {
    // The author's current span (if any) becomes the task span's parent, so tasks nest
    // under author-side Effect.withSpan/Effect.fn structure in the run's trace.
    runTask: (task) => Effect.flatMap(Effect.option(Effect.currentSpan), (currentSpan) => Effect.suspend(() => {
      assertWorkflowTaskRepairBudgets(task);
      const parentSpanId = Option.isSome(currentSpan) ? currentSpan.value.spanId : input.rootSpanId;
      const taskOrdinal = ordinal++;
      // Record the settled result the moment the task finishes — inside the promise chain,
      // not after an Effect await — so a failed sibling's outcome survives fan-out
      // interruption and forked fibers are never orphaned; every started task lands in
      // inFlightTasks and is awaited before the run reports its results.
      const taskRun = executeWorkflowTask({
        ordinal: taskOrdinal,
        task,
        identity: workflowTaskIdentity(input.workflow.name, task, input.runtimeOptions),
        runId: input.runId,
        store: input.store,
        executeTask: input.executeTask,
        mockOutput: input.mockOutput,
        ...(input.taskNoProgressMs !== undefined ? { taskNoProgressMs: input.taskNoProgressMs } : {}),
        runtimeOptions: input.runtimeOptions,
        limiter: input.limiter,
        cancellation: input.cancellation,
        budget: input.budget,
        tracing: input.tracing,
        ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      }).then((outcome) => {
        tasks[taskOrdinal] = outcome.result;
        return outcome;
      });
      inFlightTasks.push(taskRun);
      // taskRun rejects only when the run-scoped barrier has already cancelled admission;
      // surfacing that as a defect prevents author-level error handling from swallowing a
      // whole-run stop. A task-local failure resolves and enters the E channel through a
      // WorkflowTaskFailure marker, which authors may isolate per arm.
      return Effect.flatMap(Effect.promise(() => taskRun), (outcome) =>
        "failure" in outcome
          ? Effect.fail(new WorkflowTaskFailure(outcome.failure, outcome.failureEvidence))
          : Effect.succeed(outcome.result.output as never));
    })),
    phase: (contract, fn) => phase(runtime, contract, fn),
  };
  // Provide the run's tracer to the author program so Effect.withSpan / Effect.fn spans
  // land in the same trace as engine spans, all rooted under the run root span.
  const program = input.tracing.enabled
    ? input.workflow.run(runtime).pipe(
      Effect.withSpan("workflow.program", { attributes: { workflow: input.workflow.name } }),
      Effect.provide(Layer.setTracer(makeWorkflowEffectTracer(
        input.tracing,
        input.rootSpanId !== undefined ? { defaultParentSpanId: input.rootSpanId } : {},
      ))),
    )
    : input.workflow.run(runtime);
  const exit = await awaitRunScoped(Effect.runPromiseExit(program), input.cancellation);
  if (Exit.isSuccess(exit)) {
    await Promise.allSettled(inFlightTasks);
    input.cancellation.throwIfAborted();
    finishRun("completed", { kind: "completed" });
    return { output: exit.value, tasks: collectTasks() };
  }
  // The author program faulted. runPromiseExit exposes the raw Cause, so squash it back to
  // the originating error before cancelling executor promises that outlive interrupted
  // Effect fibers. The cancellation barrier closes queued admission and signals every
  // executor before the run awaits the complete started-task set.
  const error = Cause.squash(exit.cause);
  const terminalError = error instanceof WorkflowTaskFailure ? error.taskError : error;
  input.cancellation.abort(
    terminalError,
    error instanceof WorkflowRunStoppedError ? "run-not-running" : "run-failed",
  );
  await Promise.allSettled(inFlightTasks);
  if (isWorkflowRunBudgetError(terminalError)) {
    finishRun("failed", workflowRunBudgetTerminalCause(terminalError));
    throw terminalError;
  }
  if (error instanceof WorkflowRunStoppedError) {
    const terminal = interruptionTerminalCause(input.cancellation, error);
    finishRun(terminal.status, terminal.cause);
    throw error;
  }
  if (error instanceof WorkflowTaskFailure) {
    // Effect.either and other author-level recovery produce a successful program exit and
    // never reach this branch. An unhandled task failure is terminal only after every
    // sibling executor and its durable attempt row have settled.
    const status = error.taskError instanceof WorkflowTaskEscalatedError ? "escalated" : "failed";
    finishRun(status, taskTerminalCause(status, error.evidence));
    throw error.taskError;
  }
  if (input.cancellation.attemptInterruption() !== undefined) {
    const terminal = interruptionTerminalCause(input.cancellation, error);
    finishRun(terminal.status, terminal.cause);
  } else {
    finishRun("failed", {
      kind: "workflow-failed",
      errorName: errorName(error),
      message: errorMessage(error),
    });
  }
  throw error;
};

export const runWorkflow = async (
  workflow: AnyWorkflowDefinition,
  options: {
    readonly executeTask: WorkflowTaskExecutor;
    readonly store?: WorkflowStore;
    readonly mockOutput?: boolean;
    readonly maxConcurrentTasks?: number;
    readonly maxWallMs?: number;
    readonly taskNoProgressMs?: number;
    readonly maxTasks?: number;
    readonly maxCostUsd?: number;
    readonly maxPromptBytes?: number;
    readonly runId?: string;
    readonly runtimeOptions?: WorkflowRuntimeOptions;
    readonly abortSignal?: AbortSignal;
  },
): Promise<WorkflowRunResult> => {
  const mockOutput = options.mockOutput === true;
  const runtimeOptions = options.runtimeOptions ?? {};
  const maxConcurrentTasks = options.maxConcurrentTasks ?? DEFAULT_WORKFLOW_TASK_CONCURRENCY;
  if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) {
    throw new RangeError("maxConcurrentTasks must be a positive integer");
  }
  assertWorkflowRunBudgets(options);
  if (!("run" in workflow)) {
    for (const task of workflow.tasks) assertWorkflowTaskRepairBudgets(task);
  }
  const limiter = createTaskLimiter(maxConcurrentTasks);
  const runId = options.store === undefined ? null : options.runId ?? options.store.createRun(workflow.name);
  const tracing = createWorkflowTraceRecorder({
    ...(options.store !== undefined ? { store: options.store } : {}),
    runId,
  });
  const rootSpan = tracing.startSpan("workflow.run", {
    attributes: {
      workflow: workflow.name,
      "workflow.mode": "run" in workflow ? "dynamic" : "static",
      "workflow.max_concurrent_tasks": maxConcurrentTasks,
      "workflow.max_prompt_bytes": options.maxPromptBytes ?? null,
    },
  });
  const rootSpanId = tracing.enabled ? rootSpan.spanId : undefined;
  const annotateRunStatus = (): string | undefined => {
    const status = runId !== null && options.store !== undefined ? options.store.getRun(runId)?.status : undefined;
    if (status !== undefined) rootSpan.annotate("run.status", status);
    return status;
  };
  const endRootSpan = (): void => {
    const status = annotateRunStatus();
    rootSpan.end(
      status === "failed" || status === "escalated" || status === "crashed" ? "error" : "ok",
    );
  };
  const cancellation = createRunCancellationBarrier(options.store, runId, limiter, options.abortSignal);
  const budget = createWorkflowRunBudget(options, cancellation);
  try {
    if ("run" in workflow) {
      const result = await runDynamicWorkflow({
        workflow: workflow as AnyWorkflowDefinition & {
          readonly run: (runtime: WorkflowRuntime) => Effect.Effect<unknown, WorkflowRuntimeError, never>;
        },
        runId,
        store: options.store,
        executeTask: options.executeTask,
        mockOutput,
        ...(options.taskNoProgressMs !== undefined ? { taskNoProgressMs: options.taskNoProgressMs } : {}),
        limiter,
        runtimeOptions,
        cancellation,
        budget,
        tracing,
        ...(rootSpanId !== undefined ? { rootSpanId } : {}),
      });
      endRootSpan();
      return { runId, workflow: workflow.name, tasks: result.tasks, output: result.output };
    }
    const tasks = await awaitRunScoped(runStaticWorkflow({
      workflow,
      runId,
      store: options.store,
      executeTask: options.executeTask,
      mockOutput,
      ...(options.taskNoProgressMs !== undefined ? { taskNoProgressMs: options.taskNoProgressMs } : {}),
      limiter,
      runtimeOptions,
      cancellation,
      budget,
      tracing,
      ...(rootSpanId !== undefined ? { rootSpanId } : {}),
    }), cancellation);
    endRootSpan();
    return { runId, workflow: workflow.name, tasks };
  } catch (error) {
    const interruptionBeforeCatch = cancellation.attemptInterruption();
    cancellation.abort(error, error instanceof WorkflowRunStoppedError ? "run-not-running" : "run-failed");
    if (options.store !== undefined && runId !== null && options.store.getRun(runId)?.status === "running") {
      if (isWorkflowRunBudgetError(error)) {
        finishRunIfRunning(options.store, runId, "failed", workflowRunBudgetTerminalCause(error));
      } else if (interruptionBeforeCatch !== undefined || error instanceof WorkflowRunStoppedError) {
        const terminal = interruptionTerminalCause(cancellation, error);
        finishRunIfRunning(options.store, runId, terminal.status, terminal.cause);
      } else {
        finishRunIfRunning(options.store, runId, "failed", {
          kind: "workflow-failed",
          errorName: errorName(error),
          message: errorMessage(error),
        });
      }
    }
    annotateRunStatus();
    rootSpan.end("error", error);
    throw error;
  } finally {
    budget.dispose();
    cancellation.dispose();
  }
};
