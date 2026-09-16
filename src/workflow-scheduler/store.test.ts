import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEDULER_STORE_SCHEMA_VERSION, SchedulerStore, type ScheduleUpsert } from "./store.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-scheduler-store-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const install = (overrides: Partial<ScheduleUpsert> = {}): ScheduleUpsert => ({
  name: "inbox-router",
  workflowFile: "/work/inbox-router.workflow.ts",
  cwd: "/work",
  storePath: "/home/.prism/workflows/abc/workflows.sqlite",
  cron: "*/10 * * * *",
  timezone: "America/Sao_Paulo",
  overlap: "skip",
  missedRuns: "skip",
  options: {},
  nextDueAt: "2026-09-16T12:10:00.000Z",
  ...overrides,
});

const openStore = async (root: string): Promise<SchedulerStore> =>
  SchedulerStore.open(join(root, "workflow-scheduler.sqlite"));

describe("scheduler store", () => {
  test("creates schema v1 and refuses a newer version", async () => {
    const root = await createTempRoot();
    const path = join(root, "workflow-scheduler.sqlite");
    const store = await SchedulerStore.open(path);
    store.close();

    const db = new Database(path);
    expect(db.query<{ readonly user_version: number }, []>("pragma user_version;").get()?.user_version)
      .toBe(SCHEDULER_STORE_SCHEMA_VERSION);
    db.exec("pragma user_version = 99;");
    db.close();

    await expect(SchedulerStore.open(path)).rejects.toThrow(/newer than supported/);
  });

  test("installs a schedule and treats an unchanged reinstall as a no-op", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      const first = store.upsertSchedule(install());
      expect(first.kind).toBe("installed");
      expect(first.schedule.revision).toBe(1);
      expect(first.schedule.enabled).toBe(true);

      const again = store.upsertSchedule(install());
      // A periodic reinstall must not reset a live schedule's cursor.
      expect(again.kind).toBe("unchanged");
      expect(again.schedule.revision).toBe(1);
      expect(again.schedule.nextDueAt).toBe("2026-09-16T12:10:00.000Z");
      expect(store.listSchedules()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("a changed declaration bumps the revision and resets the cursor together", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      store.upsertSchedule(install());
      const changed = store.upsertSchedule(install({ cron: "*/5 * * * *", nextDueAt: "2026-09-16T12:05:00.000Z" }));
      expect(changed.kind).toBe("installed");
      expect(changed.schedule.revision).toBe(2);
      expect(changed.schedule.cron).toBe("*/5 * * * *");
      expect(changed.schedule.nextDueAt).toBe("2026-09-16T12:05:00.000Z");
      // One schedule, keyed by workflow file — not a duplicate.
      expect(store.listSchedules()).toHaveLength(1);
      expect(store.listEvents().some((event) => event.type === "schedule.updated")).toBe(true);
    } finally {
      store.close();
    }
  });

  test("the cursor advance is a compare-and-set on the revision", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      const { schedule } = store.upsertSchedule(install());
      expect(store.advanceCursor({
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        nextDueAt: "2026-09-16T12:20:00.000Z",
      })).toBe(true);
      expect(store.getSchedule(schedule.scheduleId)?.nextDueAt).toBe("2026-09-16T12:20:00.000Z");

      // The guard exists for a schedule *edit* landing between the tick's
      // decision and its write. Reinstalling with a changed declaration bumps
      // the revision and resets the cursor; the tick's now-stale plan must not
      // overwrite that with the occurrence it had already decided to consume.
      const edited = store.upsertSchedule(install({ cron: "*/5 * * * *", nextDueAt: "2026-09-16T12:05:00.000Z" }));
      expect(edited.schedule.revision).toBe(2);

      expect(store.advanceCursor({
        scheduleId: schedule.scheduleId,
        revision: schedule.revision,
        nextDueAt: "1999-01-01T00:00:00.000Z",
      })).toBe(false);
      expect(store.getSchedule(schedule.scheduleId)?.nextDueAt).toBe("2026-09-16T12:05:00.000Z");

      // At the current revision the advance applies normally.
      expect(store.advanceCursor({
        scheduleId: schedule.scheduleId,
        revision: edited.schedule.revision,
        nextDueAt: "2026-09-16T12:10:00.000Z",
      })).toBe(true);
      expect(store.getSchedule(schedule.scheduleId)?.nextDueAt).toBe("2026-09-16T12:10:00.000Z");
    } finally {
      store.close();
    }
  });
});

describe("schedule execution occupancy", () => {
  const reserve = (store: SchedulerStore, scheduleId: string, revision: number) =>
    store.reserveExecution({
      scheduleId,
      scheduleRevision: revision,
      scheduledFor: "2026-09-16T12:00:00.000Z",
      schedulerInstanceId: "instance-1",
    });

  test("allows at most one unresolved execution per schedule, enforced by the database", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      const { schedule } = store.upsertSchedule(install());
      const first = reserve(store, schedule.scheduleId, schedule.revision);
      expect(first.kind).toBe("reserved");

      const second = reserve(store, schedule.scheduleId, schedule.revision);
      expect(second.kind).toBe("occupied");
      expect(store.listOccupyingExecutions()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("a terminal execution frees the slot", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      const { schedule } = store.upsertSchedule(install());
      const first = reserve(store, schedule.scheduleId, schedule.revision);
      if (first.kind !== "reserved") throw new Error("expected a reservation");
      expect(store.updateExecution({
        executionId: first.execution.executionId,
        expectStatus: "reserved",
        status: "completed",
        finishedAt: new Date().toISOString(),
      })).toBe(true);
      expect(store.listOccupyingExecutions()).toHaveLength(0);
      expect(reserve(store, schedule.scheduleId, schedule.revision).kind).toBe("reserved");
    } finally {
      store.close();
    }
  });

  test("an uncertain execution keeps the slot occupied", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      const { schedule } = store.upsertSchedule(install());
      const first = reserve(store, schedule.scheduleId, schedule.revision);
      if (first.kind !== "reserved") throw new Error("expected a reservation");
      store.updateExecution({
        executionId: first.execution.executionId,
        expectStatus: "reserved",
        status: "uncertain",
        cause: { reason: "probe could not establish liveness" },
      });
      // Uncertainty is not resolved by a timer, so the slot stays held.
      expect(reserve(store, schedule.scheduleId, schedule.revision).kind).toBe("occupied");
    } finally {
      store.close();
    }
  });

  test("an update guarded by a stale expected status writes nothing", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      const { schedule } = store.upsertSchedule(install());
      const first = reserve(store, schedule.scheduleId, schedule.revision);
      if (first.kind !== "reserved") throw new Error("expected a reservation");
      const executionId = first.execution.executionId;

      expect(store.updateExecution({ executionId, expectStatus: "running", status: "failed" })).toBe(false);
      expect(store.getExecution(executionId)?.status).toBe("reserved");

      expect(store.updateExecution({ executionId, expectStatus: "reserved", status: "running" })).toBe(true);
      expect(store.getExecution(executionId)?.status).toBe("running");
      // The first guard can no longer fire.
      expect(store.updateExecution({ executionId, expectStatus: "reserved", status: "failed" })).toBe(false);
      expect(store.getExecution(executionId)?.status).toBe("running");
    } finally {
      store.close();
    }
  });

  test("records runner identity, exit status, and outcome on the execution", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      const { schedule } = store.upsertSchedule(install());
      const reserved = reserve(store, schedule.scheduleId, schedule.revision);
      if (reserved.kind !== "reserved") throw new Error("expected a reservation");
      const executionId = reserved.execution.executionId;

      store.updateExecution({
        executionId,
        expectStatus: "reserved",
        status: "running",
        childPid: 4321,
        childBootId: "boot-1",
        childStartId: "start-1",
        runId: "run-1",
      });
      const running = store.getExecution(executionId);
      expect(running).toMatchObject({
        status: "running",
        childPid: 4321,
        childBootId: "boot-1",
        childStartId: "start-1",
        runId: "run-1",
      });

      store.updateExecution({
        executionId,
        expectStatus: "running",
        status: "completed",
        observedExitCode: 0,
        outcome: { runStatus: "completed" },
        finishedAt: new Date().toISOString(),
      });
      const done = store.getExecution(executionId);
      expect(done).toMatchObject({ status: "completed", observedExitCode: 0, outcome: { runStatus: "completed" } });
      expect(done?.finishedAt).not.toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("schedule lifecycle", () => {
  test("refuses to remove a schedule while an execution occupies it", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      const { schedule } = store.upsertSchedule(install());
      store.reserveExecution({
        scheduleId: schedule.scheduleId,
        scheduleRevision: schedule.revision,
        scheduledFor: null,
        schedulerInstanceId: "instance-1",
      });
      const blocked = store.removeSchedule(schedule.scheduleId);
      expect(blocked.kind).toBe("occupied");
      expect(store.getSchedule(schedule.scheduleId)).not.toBeNull();

      // Removing the evidence would silently discard a possibly-running worker,
      // so even an uncertain execution blocks removal until it is reconciled.
      const occupying = store.occupyingExecution(schedule.scheduleId);
      if (occupying === null) throw new Error("expected an occupying execution");
      store.updateExecution({ executionId: occupying.executionId, expectStatus: "reserved", status: "uncertain" });
      expect(store.removeSchedule(schedule.scheduleId).kind).toBe("occupied");

      store.updateExecution({ executionId: occupying.executionId, expectStatus: "uncertain", status: "interrupted" });
      expect(store.removeSchedule(schedule.scheduleId)).toEqual({ kind: "removed" });
      expect(store.getSchedule(schedule.scheduleId)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("reports not-found for an unknown schedule", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      expect(store.removeSchedule("nope")).toEqual({ kind: "not-found" });
      expect(store.setScheduleEnabled("nope", false)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("disabling keeps the schedule and its cursor", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      const { schedule } = store.upsertSchedule(install());
      const disabled = store.setScheduleEnabled(schedule.scheduleId, false);
      expect(disabled).toMatchObject({ enabled: false, nextDueAt: "2026-09-16T12:10:00.000Z" });
      expect(store.listSchedules()).toHaveLength(1);
      expect(store.setScheduleEnabled(schedule.scheduleId, true)?.enabled).toBe(true);
    } finally {
      store.close();
    }
  });

  test("lists executions newest first for one schedule", async () => {
    const root = await createTempRoot();
    const store = await openStore(root);
    try {
      const { schedule } = store.upsertSchedule(install());
      for (const status of ["completed", "failed"] as const) {
        const reserved = store.reserveExecution({
          scheduleId: schedule.scheduleId,
          scheduleRevision: schedule.revision,
          scheduledFor: null,
          schedulerInstanceId: "instance-1",
        });
        if (reserved.kind !== "reserved") throw new Error("expected a reservation");
        store.updateExecution({
          executionId: reserved.execution.executionId,
          expectStatus: "reserved",
          status,
          finishedAt: new Date().toISOString(),
        });
      }
      const executions = store.listExecutions(schedule.scheduleId);
      expect(executions).toHaveLength(2);
      expect(executions.map((execution) => execution.status)).toEqual(["failed", "completed"]);
    } finally {
      store.close();
    }
  });
});
