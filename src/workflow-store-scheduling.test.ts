import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WORKFLOW_STORE_SCHEMA_VERSION, WorkflowStore } from "./workflow-store.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-scheduling-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A pid that is guaranteed not to be running. */
const deadPid = async (): Promise<number> => {
  const handle = Bun.spawn({ cmd: ["sh", "-c", "sleep 30"] });
  const pid = handle.pid;
  handle.kill("SIGKILL");
  await handle.exited;
  return pid;
};

const userVersion = (path: string): number => {
  const db = new Database(path);
  try {
    return db.query<{ readonly user_version: number }, []>("pragma user_version;").get()?.user_version ?? 0;
  } finally {
    db.close();
  }
};

const columns = (path: string, table: string): ReadonlyArray<string> => {
  const db = new Database(path);
  try {
    return db.query<{ readonly name: string }, []>(`pragma table_info(${table});`).all().map((row) => row.name);
  } finally {
    db.close();
  }
};

const V7_RUN_COLUMNS = [
  "scheduling_execution_id",
  "scheduling_schedule_id",
  "scheduled_for",
  "runner_boot_id",
  "runner_start_id",
] as const;

/** Turn a v7 store back into a v6 store: drop the v7 columns and rewind user_version. */
const rewindToVersion6 = (path: string): void => {
  const db = new Database(path);
  try {
    db.exec("drop index if exists workflow_runs_scheduling_execution_idx;");
    for (const column of V7_RUN_COLUMNS) {
      db.exec(`alter table workflow_runs drop column ${column};`);
    }
    db.exec("pragma user_version = 6;");
  } finally {
    db.close();
  }
};

/** Turn a v8 store back into a v7 store: remove Jev snapshot columns only. */
const rewindToVersion7 = (path: string): void => {
  const db = new Database(path);
  try {
    db.exec("alter table workflow_run_task_snapshots drop column request_json;");
    db.exec("alter table workflow_run_task_snapshots drop column task_kind;");
    db.exec("pragma user_version = 7;");
  } finally {
    db.close();
  }
};

const provenance = (runId: string) => ({
  executionId: `exec-${runId}`,
  scheduleId: "sched-1",
  scheduledFor: "2026-09-16T12:00:00.000Z",
});

describe("workflow store v7 migration", () => {
  test("migrates a v6 store forward, preserving runs and reporting the notice", async () => {
    const root = await createTempRoot();
    const path = join(root, "workflows.sqlite");

    const store = await WorkflowStore.open(path);
    const runId = store.createRun("legacy-v6");
    store.close();

    rewindToVersion6(path);
    expect(userVersion(path)).toBe(6);
    expect(columns(path, "workflow_runs")).not.toContain("scheduling_execution_id");

    const migrated = await WorkflowStore.open(path);
    expect(migrated.schemaNotice).toEqual({
      severity: "info",
      openedVersion: 6,
      currentVersion: WORKFLOW_STORE_SCHEMA_VERSION,
      message: `Workflow store at ${path} was schema version 6; migrated to ${WORKFLOW_STORE_SCHEMA_VERSION} on open.`,
    });
    // The pre-existing run survives, and reports no scheduling provenance —
    // which is the truthful answer for a run the scheduler never launched.
    expect(migrated.getRun(runId)).toMatchObject({ workflow: "legacy-v6", status: "running" });
    expect(migrated.scheduledRunState(runId)).toMatchObject({
      schedulingExecutionId: null,
      schedulingScheduleId: null,
      scheduledFor: null,
      runner: null,
    });
    migrated.close();

    expect(userVersion(path)).toBe(WORKFLOW_STORE_SCHEMA_VERSION);
    for (const column of V7_RUN_COLUMNS) {
      expect(columns(path, "workflow_runs")).toContain(column);
    }
  });

  test("records provenance for a scheduled run and nothing for a hand-run one", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    try {
      const scheduled = store.createRun("scheduled", undefined, provenance("a"));
      const manual = store.createRun("manual");

      expect(store.scheduledRunState(scheduled)).toMatchObject({
        schedulingExecutionId: "exec-a",
        schedulingScheduleId: "sched-1",
        scheduledFor: "2026-09-16T12:00:00.000Z",
      });
      expect(store.scheduledRunState(manual)).toMatchObject({
        schedulingExecutionId: null,
        schedulingScheduleId: null,
        scheduledFor: null,
      });
      // The provenance is also visible in the append-only event stream, so an
      // operator can see why a run exists without joining two databases.
      const started = store.listRunEvents(scheduled).find((event) => event.type === "run.started");
      expect(started?.payload).toMatchObject({
        scheduling: { executionId: "exec-a", scheduleId: "sched-1" },
      });
    } finally {
      store.close();
    }
  });
});

describe("workflow store v8 migration", () => {
  test("adds native-task snapshot columns to a scheduler-v7 store", async () => {
    const root = await createTempRoot();
    const path = join(root, "workflows.sqlite");

    const store = await WorkflowStore.open(path);
    const runId = store.createRun("legacy-v7");
    store.close();

    rewindToVersion7(path);
    expect(userVersion(path)).toBe(7);
    expect(columns(path, "workflow_runs")).toEqual(
      expect.arrayContaining([...V7_RUN_COLUMNS]),
    );
    expect(columns(path, "workflow_run_task_snapshots")).not.toContain("task_kind");
    expect(columns(path, "workflow_run_task_snapshots")).not.toContain("request_json");

    const migrated = await WorkflowStore.open(path);
    expect(migrated.schemaNotice).toEqual({
      severity: "info",
      openedVersion: 7,
      currentVersion: WORKFLOW_STORE_SCHEMA_VERSION,
      message: `Workflow store at ${path} was schema version 7; migrated to ${WORKFLOW_STORE_SCHEMA_VERSION} on open.`,
    });
    expect(migrated.getRun(runId)).toMatchObject({ workflow: "legacy-v7", status: "running" });
    migrated.close();

    expect(userVersion(path)).toBe(WORKFLOW_STORE_SCHEMA_VERSION);
    expect(columns(path, "workflow_run_task_snapshots")).toEqual(
      expect.arrayContaining(["task_kind", "request_json"]),
    );
  });
});

describe("workflow run launch authorization", () => {
  const scheduledRun = async (store: WorkflowStore, name: string) => {
    const runId = store.createRun(name, undefined, provenance(name));
    const token = randomUUID();
    store.setRunHandoffToken(runId, token);
    return { runId, token };
  };

  test("authorizes once, recording the runner identity in the same transaction", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    try {
      const { runId, token } = await scheduledRun(store, "authorize");
      expect(store.scheduledRunState(runId)?.launchAuthorized).toBe(false);
      expect(store.scheduledRunState(runId)?.runner).toBeNull();

      expect(
        store.beginScheduledRun({
          runId,
          token,
          runnerPid: process.pid,
          runnerBootId: "boot-1",
          runnerStartId: "start-1",
        }),
      ).toEqual({ kind: "authorized" });

      const state = store.scheduledRunState(runId);
      expect(state?.launchAuthorized).toBe(true);
      expect(state?.runner).toEqual({ pid: process.pid, bootId: "boot-1", startId: "start-1" });
      expect(state?.status).toBe("running");
      // Authorization does not publish the readiness heartbeat: that marker
      // belongs to markRunRunnerStarted, after the workflow module loads.
      expect(state?.heartbeatAt).toBeNull();
      expect(store.listRunEvents(runId).some((event) => event.type === "runner.authorized")).toBe(true);
    } finally {
      store.close();
    }
  });

  test("rejects a wrong token without recording anything", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    try {
      const { runId } = await scheduledRun(store, "wrong-token");
      const result = store.beginScheduledRun({
        runId,
        token: "not-the-token",
        runnerPid: process.pid,
        runnerBootId: null,
        runnerStartId: null,
      });
      expect(result.kind).toBe("unauthorized");
      const state = store.scheduledRunState(runId);
      // Nothing was consumed and nothing was written: the run is still
      // authorized-but-unclaimed, so a legitimate runner can still claim it.
      expect(state?.launchAuthorized).toBe(false);
      expect(state?.runner).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a second consumer of the same token loses", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    try {
      const { runId, token } = await scheduledRun(store, "double-claim");
      const first = store.beginScheduledRun({ runId, token, runnerPid: 111, runnerBootId: null, runnerStartId: null });
      const second = store.beginScheduledRun({ runId, token, runnerPid: 222, runnerBootId: null, runnerStartId: null });
      expect(first).toEqual({ kind: "authorized" });
      expect(second.kind).toBe("unauthorized");
      // Exactly one winner: the loser did not overwrite the winner's identity.
      expect(store.scheduledRunState(runId)?.runner?.pid).toBe(111);
    } finally {
      store.close();
    }
  });

  test("reports not-found and terminal instead of guessing", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    try {
      expect(
        store.beginScheduledRun({ runId: "missing", token: "t", runnerPid: 1, runnerBootId: null, runnerStartId: null }),
      ).toEqual({ kind: "not-found" });

      const { runId, token } = await scheduledRun(store, "terminal");
      store.finishRun(runId, "completed", { kind: "completed" });
      expect(
        store.beginScheduledRun({ runId, token, runnerPid: 1, runnerBootId: null, runnerStartId: null }),
      ).toEqual({ kind: "terminal", status: "completed" });
    } finally {
      store.close();
    }
  });

  test("an unissued run cannot be authorized", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    try {
      // A scheduled run whose token was never set — the shape a crashed
      // scheduler leaves when it dies between creating the run and issuing the
      // authorization. Nothing may claim it.
      const runId = store.createRun("no-token", undefined, provenance("no-token"));
      const result = store.beginScheduledRun({
        runId,
        token: "anything",
        runnerPid: process.pid,
        runnerBootId: null,
        runnerStartId: null,
      });
      expect(result.kind).toBe("unauthorized");
      expect(store.scheduledRunState(runId)?.runner).toBeNull();
    } finally {
      store.close();
    }
  });
});

/**
 * Reconciliation ownership. An observer deciding from a dead pid or an aged
 * heartbeat is guessing at exactly the thing the scheduler is equipped to
 * establish, and guessing wrong here means starting a second concurrent run of
 * a schedule that promises at most one.
 */
describe("scheduled runs are excluded from observer terminalization", () => {
  test("a scheduled run with a dead runner is left for the scheduler", async () => {
    const root = await createTempRoot();
    const path = join(root, "workflows.sqlite");
    const pid = await deadPid();

    const store = await WorkflowStore.open(path);
    const scheduledRunId = store.createRun("scheduled-dead", undefined, provenance("dead"));
    const token = randomUUID();
    store.setRunHandoffToken(scheduledRunId, token);
    store.beginScheduledRun({ runId: scheduledRunId, token, runnerPid: pid, runnerBootId: null, runnerStartId: null });

    const manualRunId = store.createRun("manual-dead");
    store.markRunRunnerStarted(manualRunId, pid);
    store.close();

    // `open` itself runs failDeadPidRuns on every observer.
    const reopened = await WorkflowStore.open(path);
    try {
      expect(reopened.getRun(scheduledRunId)?.status).toBe("running");
      expect(reopened.getRun(manualRunId)?.status).toBe("crashed");
      expect(reopened.failDeadPidRuns()).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  test("a scheduled run with an aged heartbeat is left for the scheduler", async () => {
    const root = await createTempRoot();
    const path = join(root, "workflows.sqlite");

    const store = await WorkflowStore.open(path);
    const scheduledRunId = store.createRun("scheduled-stale", undefined, provenance("stale"));
    const token = randomUUID();
    store.setRunHandoffToken(scheduledRunId, token);
    store.beginScheduledRun({
      runId: scheduledRunId,
      token,
      runnerPid: process.pid,
      runnerBootId: null,
      runnerStartId: null,
    });

    const manualRunId = store.createRun("manual-stale");
    store.markRunRunnerStarted(manualRunId, process.pid);
    store.close();

    // Age both heartbeats an hour. Both runs keep a LIVE pid, so heartbeat age
    // is the only signal left — which is precisely the signal that must not
    // terminalize a scheduled run.
    const raw = new Database(path);
    try {
      raw.exec("update workflow_runs set heartbeat_at = datetime('now', '-1 hour');");
    } finally {
      raw.close();
    }

    const reopened = await WorkflowStore.open(path);
    try {
      const crashed = reopened.failStaleRuns(60_000).map((run) => run.runId);
      expect(crashed).toContain(manualRunId);
      expect(crashed).not.toContain(scheduledRunId);
      expect(reopened.getRun(scheduledRunId)?.status).toBe("running");
      expect(reopened.getRun(manualRunId)?.status).toBe("crashed");
    } finally {
      reopened.close();
    }
  });
});
