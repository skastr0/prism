import { Either } from "effect";
import { decodeTaskOutput, type AnyWorkflowTask, type WorkflowDefinition } from "./workflows.js";
import { workflowTaskIdentity, type WorkflowStore, type WorkflowTaskIdentity } from "./workflow-store.js";

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

export type WorkflowTaskExecutor = (task: AnyWorkflowTask) => Promise<unknown | WorkflowTaskExecution>;

const isWorkflowTaskExecution = (value: unknown): value is WorkflowTaskExecution =>
  typeof value === "object" && value !== null && "output" in value;

const taskAgent = (task: AnyWorkflowTask) => ({
  plugin: task.agent.plugin,
  name: task.agent.name,
});

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
}): Promise<{ readonly rawOutput: unknown; readonly metadata?: Record<string, unknown> }> => {
  if (input.cached !== undefined && input.cached !== null) {
    return {
      rawOutput: input.cached.output,
      metadata: { cachedFrom: "workflow_task_records" },
    };
  }
  const executed = await input.executeTask(input.task);
  if (!isWorkflowTaskExecution(executed)) {
    return { rawOutput: executed };
  }
  return { rawOutput: executed.output, ...(executed.metadata ? { metadata: executed.metadata } : {}) };
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

const executeWorkflowTask = async (input: {
  readonly workflowTaskCount: number;
  readonly index: number;
  readonly task: AnyWorkflowTask;
  readonly identity: WorkflowTaskIdentity;
  readonly runId: string | null;
  readonly store?: WorkflowStore;
  readonly executeTask: WorkflowTaskExecutor;
  readonly useCache: boolean;
}): Promise<WorkflowRunTaskResult> => {
  const { workflowTaskCount, index, task, identity, runId, store, executeTask, useCache } = input;
  recordEvent(store, runId, task.id, "task.started", { cacheKey: identity.cacheKey });
  const { cached, cacheHit } = recordCacheLookup(store, runId, task, identity, useCache);

  let rawOutput: unknown;
  let metadata: Record<string, unknown> | undefined;
  try {
    if (!cacheHit) recordEvent(store, runId, task.id, "task.executor.started", {});
    ({ rawOutput, metadata } = await executeOrReuseTask({ task, cached, executeTask }));
    if (!cacheHit) recordEvent(store, runId, task.id, "task.executor.completed", metadata ?? {});
  } catch (error) {
    const output = { error: error instanceof Error ? error.message : String(error) };
    recordEvent(store, runId, task.id, "task.executor.failed", output);
    recordRunTaskIfPersisted({ store, runId, ordinal: index, identity, agent: taskAgent(task), status: "failed", cached: false, output, finishRunStatus: "failed" });
    throw error;
  }

  recordEvent(store, runId, task.id, "task.decode.started", {});
  const decoded = decodeTaskOutput(task, rawOutput);
  if (Either.isLeft(decoded)) {
    recordEvent(store, runId, task.id, "task.decode.failed", { error: String(decoded.left) });
    recordRunTaskIfPersisted({ store, runId, ordinal: index, identity, agent: taskAgent(task), status: "failed", cached: cacheHit, output: rawOutput, metadata, finishRunStatus: "failed" });
    throw new WorkflowTaskDecodeError(task.id, decoded.left);
  }

  recordEvent(store, runId, task.id, "task.decode.completed", {});
  if (useCache && !cacheHit) {
    store?.recordCompleted({ identity, agent: taskAgent(task), output: decoded.right });
    recordEvent(store, runId, task.id, "task.cache_write.completed", { cacheKey: identity.cacheKey });
  }
  recordRunTaskIfPersisted({
    store,
    runId,
    ordinal: index,
    identity,
    agent: taskAgent(task),
    status: "completed",
    cached: cacheHit,
    output: decoded.right,
    metadata,
    ...(index === workflowTaskCount - 1 ? { finishRunStatus: "completed" as const } : {}),
  });
  return { id: task.id, agent: taskAgent(task), output: decoded.right, cached: cacheHit, ...(metadata ? { metadata } : {}) };
};

export const runWorkflow = async (
  workflow: WorkflowDefinition<string, ReadonlyArray<AnyWorkflowTask>>,
  options: {
    readonly executeTask: WorkflowTaskExecutor;
    readonly store?: WorkflowStore;
    readonly cache?: boolean;
  },
): Promise<WorkflowRunResult> => {
  const useCache = options.cache !== false;
  const runId = options.store?.createRun(workflow.name) ?? null;
  const tasks: WorkflowRunTaskResult[] = [];
  if (workflow.tasks.length === 0 && runId !== null) {
    options.store?.finishRun(runId, "completed");
  }
  for (const [index, task] of workflow.tasks.entries()) {
    const identity = workflowTaskIdentity(workflow.name, task);
    tasks.push(await executeWorkflowTask({
      workflowTaskCount: workflow.tasks.length,
      index,
      task,
      identity,
      runId,
      store: options.store,
      executeTask: options.executeTask,
      useCache,
    }));
  }
  return { runId, workflow: workflow.name, tasks };
};
