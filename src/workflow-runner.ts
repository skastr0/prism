import { Effect, Either } from "effect";
import { decodeTaskOutput, type AnyWorkflowDefinition, type AnyWorkflowTask, type WorkflowRuntime, type WorkflowRuntimeOptions } from "./workflows.js";
import { workflowTaskIdentity, type WorkflowStore, type WorkflowTaskIdentity } from "./workflow-store.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";

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

export interface WorkflowTaskExecutionContext {
  readonly abortSignal?: AbortSignal;
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
  readonly cached: { readonly output: unknown } | null | undefined;
  readonly executeTask: WorkflowTaskExecutor;
  readonly context?: WorkflowTaskExecutionContext;
}): Promise<{ readonly rawOutput: unknown; readonly metadata?: Record<string, unknown> }> => {
  if (input.cached !== undefined && input.cached !== null) {
    return {
      rawOutput: input.cached.output,
      metadata: { ...workflowContractMetadata, cachedFrom: "workflow_task_records" },
    };
  }
  const executed = await input.executeTask(input.task, input.context);
  if (!isWorkflowTaskExecution(executed)) {
    return { rawOutput: executed, metadata: workflowContractMetadata };
  }
  return { rawOutput: executed.output, metadata: { ...workflowContractMetadata, ...(executed.metadata ?? {}) } };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const appendRepairPrompt = (task: AnyWorkflowTask, repairPrompt: string): AnyWorkflowTask => ({
  ...task,
  prompt: `${task.prompt}\n\nYou are still inside the same Prism workflow task. Your previous response did not satisfy the task finish requirements.\n\n${repairPrompt}\n\nReturn the corrected final response now.`,
});

const schemaRepairPrompt = (error: unknown): string =>
  `Your previous response failed the output schema decode. Preserve the substance of your answer, but re-express it so it exactly satisfies the requested JSON shape. Decode error: ${errorMessage(error)}`;

const runFinishCriteria = async (input: {
  readonly task: AnyWorkflowTask;
  readonly output: unknown;
  readonly rawOutput: unknown;
  readonly metadata?: Record<string, unknown>;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly criterion: string; readonly error: unknown; readonly repairPrompt: string }> => {
  for (const criterion of input.task.finish?.criteria ?? []) {
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
        criterion: criterion.name,
        error,
        repairPrompt: criterion.repairPrompt?.(error, context) ??
          `Finish criterion '${criterion.name}' failed: ${errorMessage(error)}. Preserve the useful substance, fix the issue, and return the corrected final response.`,
      };
    }
  }
  return { ok: true };
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
  readonly status: "completed" | "failed";
  readonly cached: boolean;
  readonly output: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly finishRunStatus?: "completed" | "failed";
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
): { readonly signal?: AbortSignal; readonly dispose: () => void } => {
  if (store === undefined || runId === null) return { dispose: () => {} };
  const controller = new AbortController();
  const interval = setInterval(() => {
    if (store.getRun(runId)?.status !== "running") {
      controller.abort();
    }
  }, 250);
  return {
    signal: controller.signal,
    dispose: () => clearInterval(interval),
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
}): Promise<WorkflowRunTaskResult> => {
  const { isLastTask = false, finishRunOnFailure = true, ordinal, task, identity, runId, store, executeTask, useCache } = input;
  assertRunStillRunning(store, runId);
  recordEvent(store, runId, task.id, "task.started", { cacheKey: identity.cacheKey });
  const { cached, cacheHit } = recordCacheLookup(store, runId, task, identity, useCache);

  const runTaskBoundary = async (): Promise<WorkflowRunTaskResult> => {
    let rawOutput: unknown;
    let decodedOutput: unknown = undefined;
    let metadata: Record<string, unknown> | undefined;
    const maxRepairs = cacheHit ? 0 : task.finish?.maxRepairs ?? 0;
    let attemptTask = task;
    let repairs = 0;
    while (true) {
      try {
        if (!cacheHit) recordEvent(store, runId, task.id, "task.executor.started", { attempt: repairs });
        const abortMonitor = createRunAbortMonitor(store, runId);
        try {
          ({ rawOutput, metadata } = await executeOrReuseTask({
            task: attemptTask,
            cached: repairs === 0 ? cached : null,
            executeTask,
            ...(abortMonitor.signal ? { context: { abortSignal: abortMonitor.signal } } : {}),
          }));
        } finally {
          abortMonitor.dispose();
        }
        if (!cacheHit) recordEvent(store, runId, task.id, "task.executor.completed", { attempt: repairs, ...(metadata ?? {}) });
      } catch (error) {
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
        if (repairs < maxRepairs) {
          repairs += 1;
          const repairPrompt = schemaRepairPrompt(error);
          recordEvent(store, runId, task.id, "task.repair.started", {
            attempt: repairs,
            criterion: "output-schema",
            mode: "new-executor-invocation",
            repairPrompt,
          });
          attemptTask = appendRepairPrompt(task, repairPrompt);
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
      const finish = await runFinishCriteria({ task, output: decodedOutput, rawOutput, metadata });
      if (finish.ok) {
        recordEvent(store, runId, task.id, "task.finish.completed", {
          repairs,
          criteria: task.finish?.criteria?.map((criterion) => criterion.name) ?? [],
        });
        break;
      }
      recordEvent(store, runId, task.id, "task.finish.failed", {
        attempt: repairs,
        criterion: finish.criterion,
        error: errorMessage(finish.error),
        output: decodedOutput,
      });
      if (repairs < maxRepairs) {
        repairs += 1;
        recordEvent(store, runId, task.id, "task.repair.started", {
          attempt: repairs,
          criterion: finish.criterion,
          mode: "new-executor-invocation",
          repairPrompt: finish.repairPrompt,
        });
        attemptTask = appendRepairPrompt(task, finish.repairPrompt);
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
      throw new Error(`workflow task ${task.id} failed finish criterion '${finish.criterion}': ${errorMessage(finish.error)}`);
    }

    const criteria = task.finish?.criteria?.map((criterion) => criterion.name) ?? [];
    const finalMetadata = repairs > 0 || task.finish !== undefined || hasNonContractMetadata(metadata)
      ? {
        ...workflowContractMetadata,
        ...(metadata ?? {}),
        finish: {
          repairs,
          criteria,
          repairMode: repairs > 0 ? "new-executor-invocation" : "none",
        },
      }
      : { ...workflowContractMetadata, ...(metadata ?? {}) };
    if (useCache && !cacheHit) {
      store?.recordCompleted({ identity, agent: taskAgent(task), output: decodedOutput });
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
      input.store.finishRun(input.runId, "failed");
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
    });
    return { runId, workflow: workflow.name, tasks: result.tasks, output: result.output };
  }
  const tasks = await runStaticWorkflow({ workflow, runId, store: options.store, executeTask: options.executeTask, useCache, limiter, runtimeOptions });
  return { runId, workflow: workflow.name, tasks };
};
