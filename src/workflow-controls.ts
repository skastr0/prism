import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandPath } from "./fs.js";
import { loadWorkflowFile } from "./workflow-loader.js";
import { currentCliCommand } from "./workflow-cli-command.js";
import { spawnWorkflowProcess, type WorkflowSpawnedProcess } from "./workflow-runtime.js";
import {
  terminateWorkflowProcessGroup,
  workflowProcessGroupExists,
} from "./workflow-process-guard.js";
import { WorkflowStore, type WorkflowRunRecord } from "./workflow-store.js";
import { getWorkflowWorkerAdapter } from "./workflow-workers.js";

export interface WorkflowDetachedRunOptions {
  readonly mockOutput?: string;
  readonly worker?: string;
  readonly model?: string;
  readonly permission?: string;
  readonly maxConcurrentTasks?: number;
  readonly taskTimeoutMs?: number;
  readonly maxWallMs?: number;
  readonly taskNoProgressMs?: number;
  readonly maxTasks?: number;
  readonly maxCostUsd?: number;
  readonly maxPromptBytes?: number;
}

export interface WorkflowUpdateResult {
  readonly previousRun: WorkflowRunRecord;
  readonly runId: string;
  readonly workflow: string;
  readonly status: WorkflowRunRecord["status"];
  readonly detached: true;
  readonly update: {
    readonly previousRunId: string;
    readonly mode: "restart-with-cache";
    readonly inheritedOptions: WorkflowDetachedRunOptions;
    readonly overrideOptions: WorkflowDetachedRunOptions;
    readonly effectiveOptions: WorkflowDetachedRunOptions;
  };
}

export { currentCliCommand } from "./workflow-cli-command.js";

const DETACHED_RUNNER_READINESS_TIMEOUT_MS = 5_000;
const DETACHED_RUNNER_READINESS_POLL_MS = 20;
const RUNNER_GROUP_TERM_GRACE_MS = 2_500;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isFinitePositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;

const isFiniteNonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export const workflowRunOptionsSnapshot = (
  options: WorkflowDetachedRunOptions,
): Record<string, unknown> => ({
  ...(options.worker !== undefined ? { worker: options.worker } : {}),
  ...(options.model !== undefined ? { model: options.model } : {}),
  ...(options.permission !== undefined ? { permission: options.permission } : {}),
  ...(options.mockOutput !== undefined ? { mockOutput: options.mockOutput } : {}),
  ...(options.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: options.maxConcurrentTasks } : {}),
  ...(options.taskTimeoutMs !== undefined ? { taskTimeoutMs: options.taskTimeoutMs } : {}),
  ...(options.maxWallMs !== undefined ? { maxWallMs: options.maxWallMs } : {}),
  ...(options.taskNoProgressMs !== undefined ? { taskNoProgressMs: options.taskNoProgressMs } : {}),
  ...(options.maxTasks !== undefined ? { maxTasks: options.maxTasks } : {}),
  ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
  ...(options.maxPromptBytes !== undefined ? { maxPromptBytes: options.maxPromptBytes } : {}),
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
  ...(isFinitePositiveInteger(options?.maxWallMs) ? { maxWallMs: options.maxWallMs } : {}),
  ...(isFinitePositiveInteger(options?.taskNoProgressMs) ? { taskNoProgressMs: options.taskNoProgressMs } : {}),
  ...(isFinitePositiveInteger(options?.maxTasks) ? { maxTasks: options.maxTasks } : {}),
  ...(isFiniteNonNegativeNumber(options?.maxCostUsd) ? { maxCostUsd: options.maxCostUsd } : {}),
  ...(isFinitePositiveInteger(options?.maxPromptBytes) ? { maxPromptBytes: options.maxPromptBytes } : {}),
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
    ...(next.maxWallMs !== undefined ? { maxWallMs: next.maxWallMs } : {}),
    ...(next.taskNoProgressMs !== undefined ? { taskNoProgressMs: next.taskNoProgressMs } : {}),
    ...(next.maxTasks !== undefined ? { maxTasks: next.maxTasks } : {}),
    ...(next.maxCostUsd !== undefined ? { maxCostUsd: next.maxCostUsd } : {}),
    ...(next.maxPromptBytes !== undefined ? { maxPromptBytes: next.maxPromptBytes } : {}),
  };
};

/**
 * Directory holding per-run detached-runner stdout/stderr capture files, kept
 * as a sibling of the SQLite store so it travels with `--store`.
 */
export const workflowRunnerLogDir = (storePath: string): string =>
  join(dirname(expandPath(storePath)), "runner-logs");

/**
 * Deterministic capture-file path for one run's detached runner. Derivable
 * from runId + storePath alone, with no store lookup required to find it —
 * including for a runner that died before writing its first ledger row.
 */
export const workflowRunnerLogPath = (storePath: string, runId: string): string =>
  join(workflowRunnerLogDir(storePath), `${runId}.log`);

/**
 * The capture-file path, but only when it is meaningful to surface: the run
 * actually had a detached runner (`runnerPid` set) and a file exists on disk.
 * Foreground runs, and runs recorded before this capture existed, get
 * `undefined` — silence, not a dangling path to nothing.
 */
export const workflowRunnerLogPathIfPresent = (
  storePath: string,
  run: { readonly runId: string; readonly runnerPid?: number },
): string | undefined => {
  if (run.runnerPid === undefined) return undefined;
  const path = workflowRunnerLogPath(storePath, run.runId);
  return existsSync(path) ? path : undefined;
};

export const requestWorkflowRunnerTermination = async (
  store: WorkflowStore,
  run: { readonly runId: string; readonly runnerPid?: number },
  reason: string,
): Promise<void> => {
  store.recordEvent({
    runId: run.runId,
    type: "runner.termination_requested",
    payload: {
      reason,
      runnerPid: run.runnerPid ?? null,
      signal: "SIGTERM",
    },
  });

  if (run.runnerPid === undefined) {
    store.recordEvent({
      runId: run.runId,
      type: "runner.termination_confirmed",
      payload: { reason, runnerPid: null, alreadyAbsent: true, escalated: false },
    });
    return;
  }

  try {
    const result = await terminateWorkflowProcessGroup(run.runnerPid, {
      termGraceMs: RUNNER_GROUP_TERM_GRACE_MS,
      onEscalated: () => {
        store.recordEvent({
          runId: run.runId,
          type: "runner.termination_escalated",
          payload: { reason, runnerPid: run.runnerPid, signal: "SIGKILL" },
        });
      },
    });
    store.recordEvent({
      runId: run.runId,
      type: "runner.termination_confirmed",
      payload: {
        reason,
        runnerPid: run.runnerPid,
        alreadyAbsent: result.alreadyAbsent,
        escalated: result.escalated,
      },
    });
  } catch (error) {
    store.recordEvent({
      runId: run.runId,
      type: "runner.termination_failed",
      payload: { reason, runnerPid: run.runnerPid, cause: errorMessage(error) },
    });
    throw error;
  }
};

export const workflowDetachedRunArgs = (
  file: string,
  options: WorkflowDetachedRunOptions,
  run: { readonly runId: string; readonly storePath: string; readonly token: string },
): ReadonlyArray<string> => [
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
  ...(options.maxWallMs !== undefined ? ["--max-wall-ms", String(options.maxWallMs)] : []),
  ...(options.taskNoProgressMs !== undefined ? ["--task-no-progress-ms", String(options.taskNoProgressMs)] : []),
  ...(options.maxTasks !== undefined ? ["--max-tasks", String(options.maxTasks)] : []),
  ...(options.maxCostUsd !== undefined ? ["--max-cost-usd", String(options.maxCostUsd)] : []),
  ...(options.maxPromptBytes !== undefined ? ["--max-prompt-bytes", String(options.maxPromptBytes)] : []),
];

export const startDetachedWorkflowRun = async (
  store: WorkflowStore,
  file: string,
  options: WorkflowDetachedRunOptions,
  run: { readonly runId: string; readonly storePath: string; readonly token: string },
): Promise<WorkflowRunRecord> => {
  const args = workflowDetachedRunArgs(file, options, run);

  // Opened BEFORE spawn and redirected in-place (not "ignore"): if the detached
  // runner dies before its first sqlite write (bad flags, module resolution
  // failure, env problem), this file is the only evidence that survives. Both
  // streams share one fd — a run-scoped crash-evidence channel, not a log
  // firehose. The parent's fd copy is closed right after spawn; the child
  // keeps its own duplicated reference to the same open file.
  const logPath = workflowRunnerLogPath(run.storePath, run.runId);
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");

  let child: WorkflowSpawnedProcess;
  try {
    child = spawnWorkflowProcess({
      cmd: [...currentCliCommand(), ...args],
      cwd: process.cwd(),
      env: { ...process.env, PRISM_WORKFLOW_DETACHED_CHILD: "1", PRISM_WORKFLOW_DETACHED_RUN_ID: run.runId },
      detached: true,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    });
  } catch (error) {
    store.recordEvent({
      runId: run.runId,
      type: "runner.start_failed",
      payload: { cause: errorMessage(error), runnerLog: logPath },
    });
    store.finishRun(run.runId, "crashed", { kind: "crashed", reason: "runner-start-failed" });
    throw error;
  } finally {
    closeSync(logFd);
  }

  try {
    const deadline = Date.now() + DETACHED_RUNNER_READINESS_TIMEOUT_MS;
    const exited = child.exited.then((code) => ({ kind: "exited" as const, code }));
    while (true) {
      const persisted = store.getRun(run.runId);
      if (persisted === null) {
        throw new Error(`detached workflow run disappeared during startup: ${run.runId}`);
      }
      if (persisted.runnerPid !== undefined && persisted.runnerPid !== child.pid) {
        throw new Error(
          `detached workflow runner pid mismatch for ${run.runId}: expected ${child.pid}, got ${persisted.runnerPid}`,
        );
      }
      const readinessPersisted =
        persisted.runnerPid === child.pid &&
        persisted.heartbeatAt !== undefined;
      if (
        persisted.status === "running" &&
        readinessPersisted &&
        workflowProcessGroupExists(child.pid)
      ) {
        return persisted;
      }
      if (persisted.status === "unknown" || (persisted.status !== "running" && !readinessPersisted)) {
        throw new Error(`detached workflow runner terminalized before readiness: ${run.runId}`);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for detached workflow runner ${run.runId} readiness`);
      }
      const next = await Promise.race([
        exited,
        delay(Math.min(DETACHED_RUNNER_READINESS_POLL_MS, remaining)).then(() => ({ kind: "poll" as const })),
      ]);
      if (next.kind === "exited") {
        const durable = store.getRun(run.runId);
        if (
          durable !== null &&
          durable.runnerPid === child.pid &&
          durable.heartbeatAt !== undefined &&
          (durable.status === "completed" || durable.status === "failed" || durable.status === "escalated")
        ) {
          return durable;
        }
        throw new Error(
          `detached workflow runner ${run.runId} exited before readiness${next.code === null ? "" : ` with code ${next.code}`}`,
        );
      }
    }
  } catch (error) {
    store.recordEvent({
      runId: run.runId,
      type: "runner.start_failed",
      payload: { cause: errorMessage(error), runnerPid: child.pid },
    });
    let terminationError: unknown;
    try {
      await requestWorkflowRunnerTermination(
        store,
        { runId: run.runId, runnerPid: child.pid },
        "runner-start-failed",
      );
    } catch (error) {
      terminationError = error;
    } finally {
      if (store.getRun(run.runId)?.status === "running") {
        store.finishRun(run.runId, "crashed", {
          kind: "crashed",
          reason: "runner-start-failed",
          runnerPid: child.pid,
        });
      }
    }
    if (terminationError !== undefined) {
      throw new Error(
        `${errorMessage(error)}; failed to confirm detached runner group termination: ${errorMessage(terminationError)}`,
        { cause: terminationError },
      );
    }
    throw error;
  } finally {
    child.unref();
  }
};

export const stopWorkflowRun = async (
  store: WorkflowStore,
  runId: string,
  reason = "stop-requested",
): Promise<WorkflowRunRecord | null> => {
  const stoppedRun = store.stopRunningRun(runId, reason);
  const run = stoppedRun ?? store.getRun(runId);
  if (run !== null) {
    await requestWorkflowRunnerTermination(store, run, reason);
  }
  return run;
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
    const snapshotOptions = store.getRunSnapshot(input.runId)?.options;
    const inheritedOptions = workflowDetachedRunOptionsFromSnapshot(snapshotOptions);
    const overrideOptions = workflowDetachedRunOptionsFromSnapshot(workflowRunOptionsSnapshot(input.options));
    const effectiveOptions = mergeWorkflowRunOptions(snapshotOptions, overrideOptions);
    if (effectiveOptions.mockOutput === undefined && effectiveOptions.worker !== undefined) {
      getWorkflowWorkerAdapter(effectiveOptions.worker);
    }
    const nextRunId = randomUUID();
    const token = randomUUID();
    const wasRunning = previousRun.status === "running";
    let stoppedRun: WorkflowRunRecord;
    if (wasRunning) {
      const stopped = store.stopRunningRun(input.runId, "update-requested");
      if (stopped === null) {
        throw new Error(`workflow run is no longer running: ${input.runId}`);
      }
      stoppedRun = stopped;
    } else {
      stoppedRun = previousRun;
    }

    await requestWorkflowRunnerTermination(store, stoppedRun, "update-requested");

    store.createRun(workflow.name, nextRunId);
    store.recordEvent({
      runId: nextRunId,
      type: "run.updated_from",
      payload: { previousRunId: input.runId, mode: "restart-with-cache" },
    });
    store.setRunHandoffToken(nextRunId, token);
    store.recordRunSnapshot({
      runId: nextRunId,
      workflowFile: expandPath(input.file),
      options: workflowRunOptionsSnapshot(effectiveOptions),
    });
    const startedRun = await startDetachedWorkflowRun(
      store,
      input.file,
      effectiveOptions,
      { runId: nextRunId, storePath: input.storePath, token },
    );
    return {
      previousRun: stoppedRun,
      runId: nextRunId,
      workflow: workflow.name,
      status: startedRun.status,
      detached: true,
      update: {
        previousRunId: input.runId,
        mode: "restart-with-cache",
        inheritedOptions,
        overrideOptions,
        effectiveOptions,
      },
    };
  } finally {
    store.close();
  }
};
