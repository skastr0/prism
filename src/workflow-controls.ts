import { randomUUID } from "node:crypto";
import { expandPath } from "./fs.js";
import { loadWorkflowFile } from "./workflow-loader.js";
import { spawnWorkflowProcess } from "./workflow-runtime.js";
import { WorkflowStore, type WorkflowRunRecord } from "./workflow-store.js";
import { getWorkflowWorkerAdapter } from "./workflow-workers.js";

export interface WorkflowDetachedRunOptions {
  readonly mockOutput?: string;
  readonly worker?: string;
  readonly model?: string;
  readonly permission?: string;
  readonly maxConcurrentTasks?: number;
  readonly taskTimeoutMs?: number;
  readonly cache?: boolean;
}

export interface WorkflowUpdateResult {
  readonly previousRun: WorkflowRunRecord;
  readonly runId: string;
  readonly workflow: string;
  readonly status: "running";
  readonly detached: true;
  readonly update: {
    readonly previousRunId: string;
    readonly mode: "restart-with-cache";
  };
}

export const currentCliCommand = (): string[] => {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return [process.execPath];
  }
  if (/\.[cm]?[jt]s$/u.test(entrypoint)) {
    return [process.execPath, "run", entrypoint];
  }
  return [entrypoint];
};

export const workflowRunOptionsSnapshot = (
  options: WorkflowDetachedRunOptions,
): Record<string, unknown> => ({
  ...(options.worker !== undefined ? { worker: options.worker } : {}),
  ...(options.model !== undefined ? { model: options.model } : {}),
  ...(options.permission !== undefined ? { permission: options.permission } : {}),
  ...(options.mockOutput !== undefined ? { mockOutput: options.mockOutput } : {}),
  ...(options.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: options.maxConcurrentTasks } : {}),
  ...(options.taskTimeoutMs !== undefined ? { taskTimeoutMs: options.taskTimeoutMs } : {}),
  ...(options.cache === false ? { cache: false } : {}),
});

const workflowDetachedRunOptionsFromSnapshot = (
  options: Record<string, unknown> | undefined,
): WorkflowDetachedRunOptions => ({
  ...(typeof options?.mockOutput === "string" ? { mockOutput: options.mockOutput } : {}),
  ...(typeof options?.worker === "string" ? { worker: options.worker } : {}),
  ...(typeof options?.model === "string" ? { model: options.model } : {}),
  ...(typeof options?.permission === "string" ? { permission: options.permission } : {}),
  ...(typeof options?.maxConcurrentTasks === "number" && Number.isInteger(options.maxConcurrentTasks)
    ? { maxConcurrentTasks: options.maxConcurrentTasks }
    : {}),
  ...(typeof options?.taskTimeoutMs === "number" && Number.isInteger(options.taskTimeoutMs)
    ? { taskTimeoutMs: options.taskTimeoutMs }
    : {}),
  ...(options?.cache === false ? { cache: false } : {}),
});

const mergeWorkflowRunOptions = (
  previous: Record<string, unknown> | undefined,
  next: WorkflowDetachedRunOptions,
): WorkflowDetachedRunOptions => {
  const base = workflowDetachedRunOptionsFromSnapshot(previous);
  return {
    ...base,
    ...(next.mockOutput !== undefined ? { mockOutput: next.mockOutput } : {}),
    ...(next.worker !== undefined ? { worker: next.worker } : {}),
    ...(next.model !== undefined ? { model: next.model } : {}),
    ...(next.permission !== undefined ? { permission: next.permission } : {}),
    ...(next.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: next.maxConcurrentTasks } : {}),
    ...(next.taskTimeoutMs !== undefined ? { taskTimeoutMs: next.taskTimeoutMs } : {}),
    ...(next.cache === false ? { cache: false } : {}),
  };
};

export const startDetachedWorkflowRun = (
  file: string,
  options: WorkflowDetachedRunOptions,
  run: { readonly runId: string; readonly storePath: string; readonly token: string },
): number => {
  const args = [
    "workflow",
    "run",
    file,
    "--store",
    run.storePath,
    "--run-id",
    run.runId,
    "--run-token",
    run.token,
    ...(options.worker !== undefined ? ["--worker", options.worker] : []),
    ...(options.model !== undefined ? ["--model", options.model] : []),
    ...(options.permission !== undefined ? ["--permission", options.permission] : []),
    ...(options.mockOutput ? ["--mock-output", options.mockOutput] : []),
    ...(options.maxConcurrentTasks !== undefined ? ["--max-concurrent-tasks", String(options.maxConcurrentTasks)] : []),
    ...(options.taskTimeoutMs !== undefined ? ["--task-timeout-ms", String(options.taskTimeoutMs)] : []),
    ...(options.cache === false ? ["--no-cache"] : []),
  ];

  const child = spawnWorkflowProcess({
    cmd: [...currentCliCommand(), ...args],
    cwd: process.cwd(),
    env: { ...process.env, PRISM_WORKFLOW_DETACHED_CHILD: "1", PRISM_WORKFLOW_DETACHED_RUN_ID: run.runId },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  return child.pid;
};

export const requestWorkflowRunnerTermination = (
  store: WorkflowStore,
  run: { readonly runId: string; readonly runnerPid?: number },
  reason: string,
): void => {
  if (run.runnerPid === undefined) {
    return;
  }
  try {
    process.kill(run.runnerPid, "SIGTERM");
    store.recordEvent({
      runId: run.runId,
      type: "runner.termination_requested",
      payload: { reason, runnerPid: run.runnerPid, signal: "SIGTERM" },
    });
  } catch (error) {
    store.recordEvent({
      runId: run.runId,
      type: "runner.termination_skipped",
      payload: {
        reason,
        runnerPid: run.runnerPid,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
};

export const stopWorkflowRun = (
  store: WorkflowStore,
  runId: string,
  reason = "stop-requested",
): WorkflowRunRecord | null => {
  const stoppedRun = store.stopRunningRun(runId, reason);
  if (stoppedRun !== null) {
    requestWorkflowRunnerTermination(store, stoppedRun, reason);
  }
  return stoppedRun ?? store.getRun(runId);
};

export const updateDetachedWorkflowRun = async (input: {
  readonly runId: string;
  readonly file: string;
  readonly storePath: string;
  readonly options: WorkflowDetachedRunOptions;
  /**
   * When true (the `resume` CLI verb), a previous run that already reached a
   * terminal status (stopped/failed/completed) is tolerated: the next run
   * starts directly against the same store/cache instead of requiring the
   * previous run to still be `running`. Defaults to false so `update` keeps
   * its original contract — the previous run must still be running.
   */
  readonly allowTerminalPreviousRun?: boolean;
}): Promise<WorkflowUpdateResult> => {
  const workflow = await loadWorkflowFile(input.file, { skipTypecheck: true });
  const store = await WorkflowStore.open(expandPath(input.storePath));
  try {
    const previousRun = store.getRun(input.runId);
    if (previousRun === null) {
      throw new Error(`workflow run not found: ${input.runId}`);
    }
    if (previousRun.status !== "running" && input.allowTerminalPreviousRun !== true) {
      throw new Error(`workflow run is not running: ${input.runId}`);
    }
    const effectiveOptions = mergeWorkflowRunOptions(store.getRunSnapshot(input.runId)?.options, input.options);
    if (effectiveOptions.mockOutput === undefined && effectiveOptions.worker !== undefined) {
      getWorkflowWorkerAdapter(effectiveOptions.worker);
    }
    const nextRunId = randomUUID();
    const token = randomUUID();
    const wasRunning = previousRun.status === "running";
    let stoppedRun: WorkflowRunRecord;
    if (wasRunning) {
      const restarted = store.restartRunningRun({
        previousRunId: input.runId,
        nextRunId,
        nextWorkflow: workflow.name,
        handoffToken: token,
        reason: "update-requested",
        mode: "restart-with-cache",
      });
      if (restarted === null) {
        throw new Error(`workflow run is no longer running: ${input.runId}`);
      }
      stoppedRun = restarted;
    } else {
      // Already terminal (resume-of-terminal path) — nothing to stop; start the
      // next run directly and link it back to the previous run for provenance,
      // mirroring what restartRunningRun does above minus the "fail old" half.
      store.createRun(workflow.name, nextRunId);
      store.recordEvent({
        runId: nextRunId,
        type: "run.updated_from",
        payload: { previousRunId: input.runId, mode: "restart-with-cache" },
      });
      store.setRunHandoffToken(nextRunId, token);
      stoppedRun = previousRun;
    }
    store.recordRunSnapshot({
      runId: nextRunId,
      workflowFile: expandPath(input.file),
      options: workflowRunOptionsSnapshot(effectiveOptions),
    });
    if (wasRunning) {
      requestWorkflowRunnerTermination(store, stoppedRun, "update-requested");
    }
    try {
      const runnerPid = startDetachedWorkflowRun(input.file, effectiveOptions, { runId: nextRunId, storePath: input.storePath, token });
      store.markRunRunnerStarted(nextRunId, runnerPid);
    } catch (error) {
      store.recordEvent({
        runId: nextRunId,
        type: "runner.start_failed",
        payload: { cause: error instanceof Error ? error.message : String(error) },
      });
      store.stopRunningRun(nextRunId, "runner-start-failed");
      throw error;
    }
    return {
      previousRun: stoppedRun,
      runId: nextRunId,
      workflow: workflow.name,
      status: "running",
      detached: true,
      update: { previousRunId: input.runId, mode: "restart-with-cache" },
    };
  } finally {
    store.close();
  }
};
