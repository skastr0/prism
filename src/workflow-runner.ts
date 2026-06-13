import { Either } from "effect";
import { decodeTaskOutput, type AnyWorkflowTask, type WorkflowDefinition } from "./workflows.js";
import { workflowTaskIdentity, type WorkflowStore, type WorkflowTaskIdentity } from "./workflow-store.js";

export interface WorkflowRunTaskResult {
  readonly id: string;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly output: unknown;
  readonly cached: boolean;
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

export type WorkflowTaskExecutor = (task: AnyWorkflowTask) => Promise<unknown>;

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
  if (!useCache) {
    recordEvent(store, runId, task.id, "task.cache_lookup.skipped", { cacheKey: identity.cacheKey });
  } else {
    recordEvent(store, runId, task.id, "task.cache_lookup.started", identity);
  }
  const cached = useCache ? store?.getCompleted(identity) : null;
  const cacheHit = cached !== undefined && cached !== null;
  if (useCache) {
    recordEvent(store, runId, task.id, cacheHit ? "task.cache_lookup.hit" : "task.cache_lookup.miss", {
      cacheKey: identity.cacheKey,
    });
  }

  let rawOutput: unknown;
  try {
    if (!cacheHit) recordEvent(store, runId, task.id, "task.executor.started", {});
    rawOutput = cacheHit ? cached.output : await executeTask(task);
    if (!cacheHit) recordEvent(store, runId, task.id, "task.executor.completed", {});
  } catch (error) {
    const output = { error: error instanceof Error ? error.message : String(error) };
    recordEvent(store, runId, task.id, "task.executor.failed", output);
    if (runId !== null) {
      store?.recordRunTask({
        runId,
        ordinal: index,
        identity,
        agent: taskAgent(task),
        status: "failed",
        cached: false,
        output,
        finishRunStatus: "failed",
      });
    }
    throw error;
  }

  recordEvent(store, runId, task.id, "task.decode.started", {});
  const decoded = decodeTaskOutput(task, rawOutput);
  if (Either.isLeft(decoded)) {
    recordEvent(store, runId, task.id, "task.decode.failed", { error: String(decoded.left) });
    if (runId !== null) {
      store?.recordRunTask({
        runId,
        ordinal: index,
        identity,
        agent: taskAgent(task),
        status: "failed",
        cached: cacheHit,
        output: rawOutput,
        finishRunStatus: "failed",
      });
    }
    throw new WorkflowTaskDecodeError(task.id, decoded.left);
  }

  recordEvent(store, runId, task.id, "task.decode.completed", {});
  if (useCache && !cacheHit) {
    store?.recordCompleted({ identity, agent: taskAgent(task), output: decoded.right });
    recordEvent(store, runId, task.id, "task.cache_write.completed", { cacheKey: identity.cacheKey });
  }
  if (runId !== null) {
    store?.recordRunTask({
      runId,
      ordinal: index,
      identity,
      agent: taskAgent(task),
      status: "completed",
      cached: cacheHit,
      output: decoded.right,
      ...(index === workflowTaskCount - 1 ? { finishRunStatus: "completed" as const } : {}),
    });
  }
  return { id: task.id, agent: taskAgent(task), output: decoded.right, cached: cacheHit };
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
