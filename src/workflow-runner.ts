import { Effect, Either } from "effect";
import { computeContentHash } from "./content-hash.js";
import {
  decodeTaskOutput,
  type AnyWorkflowDefinition,
  type AnyWorkflowTask,
  type WorkflowJudgeCriterionContext,
  type WorkflowJudgeFinishCriterion,
  type WorkflowJudgeTaskMetadata,
  type WorkflowJudgeVerdict,
  type WorkflowRuntime,
  type WorkflowRuntimeOptions,
} from "./workflows.js";
import { workflowTaskIdentity, type WorkflowJudgeIdentity, type WorkflowStore, type WorkflowTaskIdentity } from "./workflow-store.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE, WorkflowOutputParseError } from "./workflow-worker-contract.js";

export interface WorkflowTaskExecution {
  readonly output: unknown;
  readonly metadata?: Record<string, unknown>;
}

export interface WorkflowRunTaskResult {
  readonly id: string;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly output: unknown;
  readonly cached: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface WorkflowRunResult {
  readonly runId: string | null;
  readonly workflow: string;
  readonly tasks: ReadonlyArray<WorkflowRunTaskResult>;
  readonly output?: unknown;
}

export class WorkflowTaskDecodeError extends Error {
  override readonly name = "WorkflowTaskDecodeError";
  constructor(
    readonly taskId: string,
    readonly cause: unknown,
  ) {
    super(`workflow task ${taskId} returned output that failed schema decode`);
  }
}

export class WorkflowRunStoppedError extends Error {
  override readonly name = "WorkflowRunStoppedError";
  constructor(readonly runId: string) {
    super(`workflow run ${runId} is no longer running`);
  }
}

export class WorkflowTaskEscalatedError extends Error {
  override readonly name = "WorkflowTaskEscalatedError";
  constructor(
    readonly taskId: string,
    readonly criterion: string,
    readonly feedback?: string,
  ) {
    super(`workflow task ${taskId} escalated by judge criterion '${criterion}'${feedback !== undefined ? `: ${feedback}` : ""}`);
  }
}

export type WorkflowTaskRepairMode = "native-continuation" | "fresh-executor-invocation" | "none";

export interface WorkflowTaskRepairContext {
  readonly attempt: number;
  readonly criterion: string;
  readonly repairPrompt: string;
  readonly mode: Exclude<WorkflowTaskRepairMode, "none">;
  readonly previousMetadata?: Record<string, unknown>;
  readonly fallbackReason?: "adapter-does-not-support-continuation" | "executor-does-not-advertise-continuation" | "missing-session-id";
  readonly continuation?: {
    readonly adapter: string;
    readonly sessionId: string;
  };
}

export interface WorkflowTaskExecutionContext {
  readonly abortSignal?: AbortSignal;
  readonly repair?: WorkflowTaskRepairContext;
}

export type WorkflowTaskExecutor = (
  task: AnyWorkflowTask,
  context?: WorkflowTaskExecutionContext,
) => Promise<unknown | WorkflowTaskExecution>;

export const DEFAULT_WORKFLOW_TASK_CONCURRENCY = 8;

interface TaskExecutionLimiter {
  readonly run: <A>(operation: () => Promise<A>) => Promise<A>;
  readonly cancelPending: (reason: unknown) => void;
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

const stringMetadata = (metadata: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const repairExecutionPlan = (
  metadata: Record<string, unknown> | undefined,
): Pick<WorkflowTaskRepairContext, "mode" | "fallbackReason" | "continuation"> => {
  const adapter = stringMetadata(metadata, "adapter");
  if (adapter === "claude-code") {
    const sessionId = stringMetadata(metadata, "sessionId")
      ?? stringMetadata(metadata, "sessionID")
      ?? stringMetadata(metadata, "session_id")
      ?? stringMetadata(metadata, "externalSessionPointer");
    if (sessionId !== undefined) {
      return { mode: "native-continuation", continuation: { adapter, sessionId } };
    }
    return { mode: "fresh-executor-invocation", fallbackReason: "missing-session-id" };
  }
  return {
    mode: "fresh-executor-invocation",
    fallbackReason: adapter === undefined ? "executor-does-not-advertise-continuation" : "adapter-does-not-support-continuation",
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
  const base = metadata ?? {};
  if (objectMetadata(base.repairExecution) !== undefined) return base;
  return {
    ...base,
    repairExecution: {
      attempt: repair.attempt,
      criterion: repair.criterion,
      mode: repair.mode,
      ...(repair.fallbackReason !== undefined ? { fallbackReason: repair.fallbackReason } : {}),
      ...(repair.continuation !== undefined ? { continuation: repair.continuation } : {}),
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
      .sort(([left], [right]) => left.localeCompare(right))
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
    cancelPending,
    run: async (operation) => {
      await acquire();
      try {
        return await operation();
      } catch (error) {
        cancelPending(error);
        throw error;
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
  if (input.cached !== undefined && input.cached !== null) {
    return {
      rawOutput: input.cached.output,
      metadata: { ...workflowContractMetadata, ...(input.cached.metadata ?? {}), cachedFrom: "workflow_task_records" },
    };
  }
  const executed = await input.executeTask(input.task, input.context);
  if (!isWorkflowTaskExecution(executed)) {
    return {
      rawOutput: executed,
      metadata: metadataWithRepairExecution(workflowContractMetadata, input.context?.repair),
    };
  }
  return {
    rawOutput: executed.output,
    metadata: metadataWithRepairExecution({ ...workflowContractMetadata, ...(executed.metadata ?? {}) }, input.context?.repair),
  };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  readonly useCache: boolean;
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
  const cached = input.useCache ? input.store?.getJudgeRecord(identity) ?? null : null;
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
  recordEvent(input.store, input.runId, input.task.id, input.useCache ? "task.judge.cache_lookup.miss" : "task.judge.cache_lookup.skipped", {
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
  const verdict = await Effect.runPromise(input.criterion.evaluate(context));
  input.store?.recordJudge({ identity, verdict, evidence, output: input.output, taskMetadata });
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
  readonly useCache: boolean;
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
          useCache: input.useCache,
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
  useCache: boolean,
): { readonly cached: { readonly output: unknown } | null | undefined; readonly cacheHit: boolean } => {
  if (!useCache) {
    recordEvent(store, runId, task.id, "task.cache_lookup.skipped", { cacheKey: identity.cacheKey });
    return { cached: null, cacheHit: false };
  }
  recordEvent(store, runId, task.id, "task.cache_lookup.started", identity);
  const cached = store?.getCompleted(identity);
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
  readonly finishRunStatus?: "completed" | "failed" | "escalated";
}): void => {
  if (input.runId === null) return;
  input.store?.recordRunTask({
    runId: input.runId,
    ordinal: input.ordinal,
    identity: input.identity,
    agent: input.agent,
    status: input.status,
    cached: input.cached,
    output: input.output,
    metadata: input.metadata,
    ...(input.finishRunStatus ? { finishRunStatus: input.finishRunStatus } : {}),
  });
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

const createRunAbortMonitor = (
  store: WorkflowStore | undefined,
  runId: string | null,
  taskId: string,
  externalAbortSignal?: AbortSignal,
): { readonly signal?: AbortSignal; readonly dispose: () => void } => {
  if ((store === undefined || runId === null) && externalAbortSignal === undefined) return { dispose: () => {} };
  const controller = new AbortController();
  let aborted = false;
  const abort = (reason: string): void => {
    if (!aborted) {
      aborted = true;
      if (store !== undefined && runId !== null) {
        store.recordEvent({
          runId,
          taskId,
          type: "task.abort_monitor_triggered",
          payload: { reason },
        });
      }
    }
    controller.abort();
  };
  const onExternalAbort = (): void => abort("runner-termination-signal");
  if (externalAbortSignal?.aborted === true) {
    onExternalAbort();
  } else {
    externalAbortSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  const interval = store !== undefined && runId !== null ? setInterval(() => {
    if (store.getRun(runId)?.status !== "running") {
      abort("run-not-running");
    }
  }, 250) : undefined;
  return {
    signal: controller.signal,
    dispose: () => {
      if (interval !== undefined) clearInterval(interval);
      externalAbortSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
};

const executeWorkflowTask = async (input: {
  readonly isLastTask?: boolean;
  readonly finishRunOnFailure?: boolean;
  readonly ordinal: number;
  readonly task: AnyWorkflowTask;
  readonly identity: WorkflowTaskIdentity;
  readonly runId: string | null;
  readonly store?: WorkflowStore;
  readonly executeTask: WorkflowTaskExecutor;
  readonly useCache: boolean;
  readonly limiter?: TaskExecutionLimiter;
  readonly abortSignal?: AbortSignal;
}): Promise<WorkflowRunTaskResult> => {
  const { isLastTask = false, finishRunOnFailure = true, ordinal, task, identity, runId, store, executeTask, useCache } = input;
  assertRunStillRunning(store, runId);
  recordEvent(store, runId, task.id, "task.started", { cacheKey: identity.cacheKey });
  const { cached, cacheHit } = recordCacheLookup(store, runId, task, identity, useCache);

  const runTaskBoundary = async (): Promise<WorkflowRunTaskResult> => {
    let rawOutput: unknown;
    let decodedOutput: unknown = undefined;
    let metadata: Record<string, unknown> | undefined;
    // Objective decode/parse repair is independent of finish criteria: a malformed
    // output is unambiguously wrong and re-promptable, so it self-heals by default
    // even when the task declares no `finish`. Subjective finish-criterion "continue"
    // repair stays gated on the author-declared finish budget.
    const DEFAULT_DECODE_REPAIRS = 2;
    const decodeRepairs = cacheHit ? 0 : task.finish?.maxRepairs ?? DEFAULT_DECODE_REPAIRS;
    const finishRepairs = cacheHit ? 0 : task.finish?.maxRepairs ?? 0;
    let attemptTask = task;
    let repairs = 0;
    let pendingRepair: WorkflowTaskRepairContext | undefined;
    let finishJudgeRuns: ReadonlyArray<{ readonly criterion: string; readonly verdict: WorkflowJudgeVerdict["verdict"]; readonly cached: boolean; readonly cacheKey: string }> = [];
    const repairAttempts: Array<{
      attempt: number;
      criterion: string;
      mode: Exclude<WorkflowTaskRepairMode, "none">;
      fallbackReason?: WorkflowTaskRepairContext["fallbackReason"];
      continuation?: WorkflowTaskRepairContext["continuation"];
    }> = [];
    const beginRepair = (criterion: string, repairPrompt: string): void => {
      assertRunStillRunning(store, runId);
      const plan = repairExecutionPlan(metadata);
      pendingRepair = {
        attempt: repairs,
        criterion,
        repairPrompt,
        previousMetadata: metadata,
        mode: plan.mode,
        ...(plan.fallbackReason !== undefined ? { fallbackReason: plan.fallbackReason } : {}),
        ...(plan.continuation !== undefined ? { continuation: plan.continuation } : {}),
      };
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
      assertRunStillRunning(store, runId);
      try {
        if (!cacheHit) recordEvent(store, runId, task.id, "task.executor.started", { attempt: repairs });
        const abortMonitor = createRunAbortMonitor(store, runId, task.id, input.abortSignal);
        try {
          ({ rawOutput, metadata } = await executeOrReuseTask({
            task: attemptTask,
            cached: repairs === 0 ? cached : null,
            executeTask,
            ...(abortMonitor.signal || pendingRepair !== undefined
              ? { context: { ...(abortMonitor.signal ? { abortSignal: abortMonitor.signal } : {}), ...(pendingRepair !== undefined ? { repair: pendingRepair } : {}) } }
              : {}),
          }));
        } finally {
          abortMonitor.dispose();
        }
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
      } catch (error) {
        if (error instanceof WorkflowOutputParseError && repairs < decodeRepairs) {
          recordEvent(store, runId, task.id, "task.decode.failed", {
            attempt: repairs,
            error: error.message,
            ...(error.rawText !== undefined ? { rawText: error.rawText } : {}),
          });
          repairs += 1;
          const repairPrompt = parseRepairPrompt(error);
          beginRepair("output-json-parse", repairPrompt);
          continue;
        }
        const output: Record<string, unknown> = { error: errorMessage(error) };
        const rawText = (error as { readonly rawText?: unknown } | null | undefined)?.rawText;
        if (rawText !== undefined) {
          output.rawText = rawText;
        }
        recordEvent(store, runId, task.id, "task.executor.failed", { attempt: repairs, ...output });
        recordRunTaskIfPersisted({
          store,
          runId,
          ordinal,
          identity,
          agent: taskAgent(task),
          status: "failed",
          cached: false,
          output,
          metadata: workflowContractMetadata,
          ...(finishRunOnFailure ? { finishRunStatus: "failed" as const } : {}),
        });
        throw error;
      }

      recordEvent(store, runId, task.id, "task.decode.started", { attempt: repairs });
      const decoded = decodeTaskOutput(task, rawOutput);
      if (Either.isLeft(decoded)) {
        const error = decoded.left;
        recordEvent(store, runId, task.id, "task.decode.failed", { attempt: repairs, error: String(error), attemptedOutput: rawOutput });
        if (repairs < decodeRepairs) {
          repairs += 1;
          const repairPrompt = schemaRepairPrompt(error);
          beginRepair("output-schema", repairPrompt);
          continue;
        }
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
          ...(finishRunOnFailure ? { finishRunStatus: "failed" as const } : {}),
        });
        throw new WorkflowTaskDecodeError(task.id, error);
      }

      decodedOutput = decoded.right;
      recordEvent(store, runId, task.id, "task.decode.completed", { attempt: repairs });
      const finish = await runFinishCriteria({
        task,
        workflowIdentity: identity,
        output: decodedOutput,
        rawOutput,
        metadata,
        store,
        runId,
        useCache,
      });
      finishJudgeRuns = finish.judgeRuns;
      if (finish.ok) {
        const repairMode = summarizeRepairMode(repairAttempts.map((repair) => repair.mode));
        recordEvent(store, runId, task.id, "task.finish.completed", {
          repairs,
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
      if (finish.status === "continue" && repairs < finishRepairs) {
        repairs += 1;
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
          ...(finishRunOnFailure ? { finishRunStatus: "escalated" as const } : {}),
        });
        throw new WorkflowTaskEscalatedError(task.id, finish.criterion, finish.feedback);
      }
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
        ...(finishRunOnFailure ? { finishRunStatus: "failed" as const } : {}),
      });
      throw new Error(`workflow task ${task.id} failed finish criterion '${finish.criterion}': ${errorMessage(finish.error)}`);
    }

    const criteria = task.finish?.criteria?.map((criterion) => criterion.name) ?? [];
    const repairMode = summarizeRepairMode(repairAttempts.map((repair) => repair.mode));
    const finalMetadata = repairs > 0 || task.finish !== undefined || hasNonContractMetadata(metadata)
      ? {
        ...workflowContractMetadata,
        ...(metadata ?? {}),
        finish: {
          repairs,
          criteria,
          repairMode,
          ...(repairAttempts.length > 0 ? { repairAttempts } : {}),
          ...(finishJudgeRuns.length > 0 ? { judgeRuns: finishJudgeRuns } : {}),
        },
      }
      : { ...workflowContractMetadata, ...(metadata ?? {}) };
    if (useCache && !cacheHit) {
      store?.recordCompleted({ identity, agent: taskAgent(task), output: decodedOutput, metadata: finalMetadata });
      recordEvent(store, runId, task.id, "task.cache_write.completed", { cacheKey: identity.cacheKey });
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
      ...(isLastTask ? { finishRunStatus: "completed" as const } : {}),
    });
    return { id: task.id, agent: taskAgent(task), output: decodedOutput, cached: cacheHit, metadata: finalMetadata };
  };

  if (cacheHit || input.limiter === undefined) {
    return runTaskBoundary();
  }
  return input.limiter.run(runTaskBoundary);
};

const runStaticWorkflow = async (input: {
  readonly workflow: AnyWorkflowDefinition;
  readonly runId: string | null;
  readonly store?: WorkflowStore;
  readonly executeTask: WorkflowTaskExecutor;
  readonly useCache: boolean;
  readonly limiter: TaskExecutionLimiter;
  readonly runtimeOptions: WorkflowRuntimeOptions;
  readonly abortSignal?: AbortSignal;
}): Promise<ReadonlyArray<WorkflowRunTaskResult>> => {
  const tasks: WorkflowRunTaskResult[] = [];
  if (input.workflow.tasks.length === 0 && input.runId !== null) {
    input.store?.finishRun(input.runId, "completed");
  }
  for (const [index, task] of input.workflow.tasks.entries()) {
    const identity = workflowTaskIdentity(input.workflow.name, task, input.runtimeOptions);
    tasks.push(await executeWorkflowTask({
      isLastTask: index === input.workflow.tasks.length - 1,
      ordinal: index,
      task,
      identity,
      runId: input.runId,
      store: input.store,
      executeTask: input.executeTask,
      useCache: input.useCache,
      limiter: input.limiter,
      abortSignal: input.abortSignal,
    }));
  }
  return tasks;
};

const runDynamicWorkflow = async (input: {
  readonly workflow: AnyWorkflowDefinition & { readonly run: (runtime: WorkflowRuntime) => Effect.Effect<unknown, unknown> };
  readonly runId: string | null;
  readonly store?: WorkflowStore;
  readonly executeTask: WorkflowTaskExecutor;
  readonly useCache: boolean;
  readonly limiter: TaskExecutionLimiter;
  readonly runtimeOptions: WorkflowRuntimeOptions;
  readonly abortSignal?: AbortSignal;
}): Promise<{ readonly output: unknown; readonly tasks: ReadonlyArray<WorkflowRunTaskResult> }> => {
  const tasks: Array<WorkflowRunTaskResult | undefined> = [];
  const inFlightTasks: Array<Promise<WorkflowRunTaskResult>> = [];
  let ordinal = 0;
  const runtime: WorkflowRuntime = {
    runTask: (task) => Effect.tryPromise({
      try: async () => {
        const taskOrdinal = ordinal++;
        const taskRun = executeWorkflowTask({
          finishRunOnFailure: false,
          ordinal: taskOrdinal,
          task,
          identity: workflowTaskIdentity(input.workflow.name, task, input.runtimeOptions),
          runId: input.runId,
          store: input.store,
          executeTask: input.executeTask,
          useCache: input.useCache,
          limiter: input.limiter,
          abortSignal: input.abortSignal,
        });
        inFlightTasks.push(taskRun);
        const result = await taskRun;
        tasks[taskOrdinal] = result;
        return result.output as never;
      },
      catch: (error) => error,
    }),
  };
  try {
    const output = await Effect.runPromise(input.workflow.run(runtime));
    await Promise.allSettled(inFlightTasks);
    if (input.runId !== null) input.store?.finishRun(input.runId, "completed");
    return { output, tasks: tasks.flatMap((task) => task === undefined ? [] : [task]) };
  } catch (error) {
    input.limiter.cancelPending(error);
    await Promise.allSettled(inFlightTasks);
    if (input.runId !== null && input.store?.listRuns().find((run) => run.runId === input.runId)?.status === "running") {
      input.store.finishRun(input.runId, error instanceof WorkflowTaskEscalatedError ? "escalated" : "failed");
    }
    throw error;
  }
};

export const runWorkflow = async (
  workflow: AnyWorkflowDefinition,
  options: {
    readonly executeTask: WorkflowTaskExecutor;
    readonly store?: WorkflowStore;
    readonly cache?: boolean;
    readonly maxConcurrentTasks?: number;
    readonly runId?: string;
    readonly runtimeOptions?: WorkflowRuntimeOptions;
    readonly abortSignal?: AbortSignal;
  },
): Promise<WorkflowRunResult> => {
  const useCache = options.cache !== false;
  const runtimeOptions = options.runtimeOptions ?? {};
  const maxConcurrentTasks = options.maxConcurrentTasks ?? DEFAULT_WORKFLOW_TASK_CONCURRENCY;
  if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) {
    throw new RangeError("maxConcurrentTasks must be a positive integer");
  }
  const limiter = createTaskLimiter(maxConcurrentTasks);
  const runId = options.store === undefined ? null : options.runId ?? options.store.createRun(workflow.name);
  if ("run" in workflow) {
    const result = await runDynamicWorkflow({
      workflow: workflow as AnyWorkflowDefinition & { readonly run: (runtime: WorkflowRuntime) => Effect.Effect<unknown, unknown> },
      runId,
      store: options.store,
      executeTask: options.executeTask,
      useCache,
      limiter,
      runtimeOptions,
      abortSignal: options.abortSignal,
    });
    return { runId, workflow: workflow.name, tasks: result.tasks, output: result.output };
  }
  const tasks = await runStaticWorkflow({ workflow, runId, store: options.store, executeTask: options.executeTask, useCache, limiter, runtimeOptions, abortSignal: options.abortSignal });
  return { runId, workflow: workflow.name, tasks };
};
