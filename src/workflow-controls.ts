import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { expandPath } from "./fs.js";
import { loadWorkflowFile } from "./workflow-loader.js";
import { currentCliCommand } from "./workflow-cli-command.js";
import { spawnWorkflowProcess, type WorkflowSpawnedProcess } from "./workflow-runtime.js";
import {
  terminateWorkflowProcessGroup,
  workflowProcessGroupExists,
} from "./workflow-process-guard.js";
import { WorkflowStore, type WorkflowRunRecord } from "./workflow-store.js";
import {
  WORKFLOW_RUNNER_LOG_DIRECTORY_MODE,
  WORKFLOW_RUNNER_LOG_FILE_MODE,
  redactWorkflowRunnerLogInPlace,
  workflowRunnerLogDir,
  workflowRunnerLogPath,
  workflowRunnerLogPathIfPresent,
} from "./workflow-runner-log.js";
import { getWorkflowWorkerAdapter } from "./workflow-workers.js";

export interface WorkflowDetachedRunOptions {
  readonly mockOutput?: string;
  readonly worker?: string;
  readonly model?: string;
  readonly permission?: string;
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

export const workflowRunOptionsSnapshot = (
  options: WorkflowDetachedRunOptions,
): Record<string, unknown> => ({
  ...(options.worker !== undefined ? { worker: options.worker } : {}),
  ...(options.model !== undefined ? { model: options.model } : {}),
  ...(options.permission !== undefined ? { permission: options.permission } : {}),
  ...(options.mockOutput !== undefined ? { mockOutput: options.mockOutput } : {}),
});

const workflowDetachedRunOptionsFromSnapshot = (
  options: Record<string, unknown> | undefined,
): WorkflowDetachedRunOptions => ({
  ...(typeof options?.mockOutput === "string" ? { mockOutput: options.mockOutput } : {}),
  ...(typeof options?.worker === "string" ? { worker: options.worker } : {}),
  ...(typeof options?.model === "string" ? { model: options.model } : {}),
  ...(typeof options?.permission === "string" ? { permission: options.permission } : {}),
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
  };
};

/**
 * Directory holding per-run detached-runner stdout/stderr capture files, kept
 * as a sibling of the SQLite store so it travels with `--store`.
 */
export { workflowRunnerLogDir, workflowRunnerLogPath, workflowRunnerLogPathIfPresent };

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
  mkdirSync(dirname(logPath), { recursive: true, mode: WORKFLOW_RUNNER_LOG_DIRECTORY_MODE });
  chmodSync(dirname(logPath), WORKFLOW_RUNNER_LOG_DIRECTORY_MODE);
  const logFd = openSync(logPath, "a", WORKFLOW_RUNNER_LOG_FILE_MODE);
  chmodSync(logPath, WORKFLOW_RUNNER_LOG_FILE_MODE);

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
    await redactWorkflowRunnerLogInPlace(run.storePath, run.runId);
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
