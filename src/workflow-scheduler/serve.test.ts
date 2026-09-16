import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { WorkflowRunStatus, WorkflowScheduledRunState } from "../workflow-store.js";
import { SchedulerLaunchError } from "./errors.js";
import type { ProcessIdentity, ProcessObservation } from "./process-identity.js";
import type { ScheduledRunEvidence } from "./reconcile.js";
import { runSchedulerServe, type SchedulerServeOptions } from "./serve.js";
import {
  SchedulerStoreServiceLive,
  ScheduledRunHost,
  type PrepareScheduledRunInput,
  type ScheduledRunHostShape,
  type StartedScheduledRun,
} from "./services.js";
import { SchedulerStore, type ScheduleExecutionStatus } from "./store.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-scheduler-serve-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const NOW = Date.parse("2026-09-16T12:10:00.000Z");
const LIVE_RUNNER: ProcessIdentity = { pid: 5150, bootId: "boot-1", startId: "start-1" };
const SAME_PROCESS: ProcessObservation = { kind: "same-process", identity: LIVE_RUNNER };
const ABSENT: ProcessObservation = { kind: "absent", reason: "pid 5150 does not exist" };

interface FakeRun {
  readonly runId: string;
  readonly executionId: string;
  status: WorkflowRunStatus;
  authorized: boolean;
  runner: ProcessIdentity | null;
}

/**
 * An in-memory stand-in for the project ledger and the runner process.
 *
 * Deliberately not a mock of `ScheduledRunHost`'s internals: it models the same
 * durable facts — a run row with an authorization and an identity, and a process
 * whose exit is controlled — so recovery behaviour is exercised rather than
 * stubbed.
 */
const createFakeHost = () => {
  const runs = new Map<string, FakeRun>();
  const exits = new Map<string, Deferred.Deferred<number | null>>();
  const started: Array<PrepareScheduledRunInput> = [];
  let observation: ProcessObservation | null = SAME_PROCESS;
  let nextPid = 5150;
  let startError: string | null = null;
  let startDefect: string | null = null;
  let autoComplete: { readonly status: WorkflowRunStatus; readonly exitCode: number } | null = null;

  const host: ScheduledRunHostShape = {
    prepareRun: (input) =>
      Effect.sync(() => {
        runs.set(input.runId, {
          runId: input.runId,
          executionId: input.executionId,
          status: "running",
          authorized: false,
          runner: null,
        });
      }),
    startRun: (input) =>
      Effect.gen(function* () {
        // A defect, not a typed failure: used to prove the loop exits rather
        // than looping on a broken scheduler.
        if (startDefect !== null) {
          return yield* Effect.die(new Error(startDefect));
        }
        if (startError !== null) {
          return yield* Effect.fail(
            new SchedulerLaunchError({
              message: startError,
              hint: "scripted launch failure",
              executionId: input.executionId,
            }),
          );
        }
        started.push(input);
        const pid = nextPid++;
        const identity: ProcessIdentity = { pid, bootId: "boot-1", startId: `start-${pid}` };
        const run = runs.get(input.runId);
        if (run === undefined) return yield* Effect.die(new Error(`no prepared run for ${input.runId}`));
        // The runner claims its authorization and records its identity in one
        // step, exactly as beginScheduledRun does.
        runs.set(input.runId, { ...run, authorized: true, runner: identity });
        const exited = yield* Deferred.make<number | null>();
        exits.set(input.runId, exited);
        if (autoComplete !== null) {
          // A child that finishes within the tick, for testing `--once`'s
          // await-the-attempt semantics.
          runs.set(input.runId, { ...run, authorized: true, runner: identity, status: autoComplete.status });
          yield* Deferred.succeed(exited, autoComplete.exitCode);
        }
        const handle: StartedScheduledRun = {
          pid,
          identity,
          exited: Deferred.await(exited),
          terminate: Effect.void,
        };
        return handle;
      }),
    readRunEvidence: ({ runId }): Effect.Effect<ScheduledRunEvidence> =>
      Effect.sync(() => {
        const run = runs.get(runId);
        if (run === undefined) return { kind: "absent" };
        const state: WorkflowScheduledRunState = {
          runId: run.runId,
          workflow: "inbox-router",
          status: run.status,
          schedulingExecutionId: run.executionId,
          schedulingScheduleId: "sched",
          scheduledFor: null,
          runner: run.runner,
          launchAuthorized: run.authorized,
          terminalCause: null,
          finishedAt: null,
          heartbeatAt: null,
        };
        return { kind: "found", run: state };
      }),
    observe: (identity) => Effect.sync(() => (identity === null ? null : observation)),
    interruptRun: ({ runId, kind }) =>
      Effect.sync(() => {
        const run = runs.get(runId);
        if (run === undefined || run.status !== "running") return false;
        runs.set(runId, { ...run, status: kind === "interrupted" ? "crashed" : "stopped" });
        return true;
      }),
  };

  return {
    host,
    runs,
    started,
    setObservation: (next: ProcessObservation | null) => {
      observation = next;
    },
    setStartError: (message: string | null) => {
      startError = message;
    },
    setStartDefect: (message: string | null) => {
      startDefect = message;
    },
    setAutoComplete: (status: WorkflowRunStatus, exitCode = 0) => {
      autoComplete = { status, exitCode };
    },
    completeRun: (runId: string, status: WorkflowRunStatus, exitCode = 0) =>
      Effect.gen(function* () {
        const run = runs.get(runId);
        if (run !== undefined) runs.set(runId, { ...run, status });
        const exited = exits.get(runId);
        if (exited !== undefined) yield* Deferred.succeed(exited, exitCode);
      }),
    /** Seed a run that never claimed its authorization. */
    seedRun: (runId: string, executionId: string, claimed: boolean) => {
      runs.set(runId, {
        runId,
        executionId,
        status: "running",
        authorized: claimed,
        runner: claimed ? LIVE_RUNNER : null,
      });
    },
  };
};

const installSchedule = (
  store: SchedulerStore,
  overrides: { readonly nextDueAt?: string } = {},
) =>
  store.upsertSchedule({
    name: "inbox-router",
    workflowFile: "/work/inbox-router.workflow.ts",
    cwd: "/work",
    storePath: "/work/workflows.sqlite",
    cron: "*/10 * * * *",
    timezone: "UTC",
    overlap: "skip",
    missedRuns: "skip",
    options: {},
    nextDueAt: overrides.nextDueAt ?? "2026-09-16T12:10:00.000Z",
  }).schedule;

const serveOptions = (overrides: Partial<SchedulerServeOptions> = {}): SchedulerServeOptions => ({
  instanceId: "instance-1",
  version: "0.6.0",
  instanceMode: "manual",
  once: true,
  ...overrides,
});

/** Provide the store, a fake run host, and a controlled clock to a program. */
const withServices = <A, E, R>(
  store: SchedulerStore,
  fake: ReturnType<typeof createFakeHost>,
  program: Effect.Effect<A, E, R>,
) =>
  program.pipe(
    Effect.provide(SchedulerStoreServiceLive(store)),
    Effect.provide(Layer.succeed(ScheduledRunHost, fake.host)),
    Effect.provide(TestClock.layer()),
  );

/** Run recovery and one tick with the clock pinned to NOW. */
const runOnce = async (
  store: SchedulerStore,
  fake: ReturnType<typeof createFakeHost>,
  options: Partial<SchedulerServeOptions> = {},
) =>
  Effect.runPromise(
    withServices(
      store,
      fake,
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        return yield* Effect.scoped(runSchedulerServe(serveOptions(options)));
      }),
    ),
  );

/** Run the real loop in a forked fiber and hand control to the body. */
const withLoop = async (
  store: SchedulerStore,
  fake: ReturnType<typeof createFakeHost>,
  body: () => Effect.Effect<void>,
): Promise<void> => {
  await Effect.runPromise(
    withServices(
      store,
      fake,
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const fiber = yield* Effect.forkChild(
          Effect.scoped(runSchedulerServe(serveOptions({ once: false, pollMs: 1_000 }))),
        );
        yield* body();
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
};

/** Advance the clock one poll interval and let the loop finish its tick. */
const advanceOneTick = Effect.gen(function* () {
  yield* TestClock.adjust(1_000);
  yield* Effect.yieldNow;
  yield* Effect.yieldNow;
});

const executionStatuses = (store: SchedulerStore): ReadonlyArray<ScheduleExecutionStatus> => {
  const schedule = store.listSchedules()[0];
  return schedule === undefined
    ? []
    : store.listExecutions(schedule.scheduleId, 50).map((execution) => execution.status);
};

describe("scheduler loop: one tick", () => {
  test("launches a due schedule exactly once and advances the cursor", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      const schedule = installSchedule(store);
      // Observed through the loop rather than `--once`, because `--once` waits
      // for its attempts and this test asserts the state *while* one runs.
      await withLoop(store, fake, () =>
        Effect.gen(function* () {
          yield* advanceOneTick;
          expect(fake.started).toHaveLength(1);
          expect(fake.started[0]?.workflow).toBe("inbox-router");
          // The cursor moved to the first occurrence strictly after now.
          expect(store.getSchedule(schedule.scheduleId)?.nextDueAt).toBe("2026-09-16T12:20:00.000Z");
          // The execution occupies the slot, so the schedule cannot double-run.
          expect(store.occupyingExecution(schedule.scheduleId)?.status).toBe("running");
        }),
      );
    } finally {
      store.close();
    }
  });

  test("--once waits for the attempt it started, so the outcome is real", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      const schedule = installSchedule(store);
      fake.setAutoComplete("completed", 0);
      const report = await runOnce(store, fake);

      expect(report.launched).toBe(1);
      // The execution is closed with the child's real exit status, and the slot
      // is free again — the difference between "launched" and "finished".
      const execution = store.listExecutions(schedule.scheduleId, 10)[0];
      expect(execution?.status).toBe("completed");
      expect(execution?.observedExitCode).toBe(0);
      expect(store.occupyingExecution(schedule.scheduleId)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("counts a non-completing execution as a failure, and a skip as not one", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      installSchedule(store);
      // The run fails, so `--once` must be able to report that through `$?`.
      fake.setAutoComplete("failed", 1);
      const report = await runOnce(store, fake);
      expect(report.launched).toBe(1);
      expect(report.failed).toBe(1);
    } finally {
      store.close();
    }
  });

  test("a skipped overlap is not a failure", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      const schedule = installSchedule(store);
      const previous = store.reserveExecution({
        scheduleId: schedule.scheduleId,
        scheduleRevision: schedule.revision,
        scheduledFor: "2026-09-16T12:00:00.000Z",
        schedulerInstanceId: "instance-0",
      });
      if (previous.kind !== "reserved") throw new Error("expected a reservation");
      fake.seedRun("run-previous", previous.execution.executionId, true);
      const report = await runOnce(store, fake);
      expect(report.skippedOverlap).toBe(1);
      expect(report.failed).toBe(0);
    } finally {
      store.close();
    }
  });

  test("does nothing for a schedule that is not yet due", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      const schedule = installSchedule(store, { nextDueAt: "2026-09-16T13:00:00.000Z" });
      const report = await runOnce(store, fake);
      expect(report.launched).toBe(0);
      expect(store.getSchedule(schedule.scheduleId)?.nextDueAt).toBe("2026-09-16T13:00:00.000Z");
    } finally {
      store.close();
    }
  });

  test("coalesces an overdue cursor into exactly one opportunity, not a catch-up burst", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      // Three hours overdue, as if the machine had been asleep: an every-ten-
      // minutes schedule owes eighteen runs and must perform one.
      const schedule = installSchedule(store, { nextDueAt: "2026-09-16T09:00:00.000Z" });
      fake.setAutoComplete("completed", 0);
      const report = await runOnce(store, fake);

      expect(report.launched).toBe(1);
      // The cursor jumps straight to the next future occurrence.
      expect(store.getSchedule(schedule.scheduleId)?.nextDueAt).toBe("2026-09-16T12:20:00.000Z");
      expect(executionStatuses(store)).toEqual(["completed"]);
      // The single opportunity represents the most recent missed occurrence.
      expect(fake.started).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("consumes a due opportunity as a skip while the previous execution is unresolved", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      const schedule = installSchedule(store);
      const previous = store.reserveExecution({
        scheduleId: schedule.scheduleId,
        scheduleRevision: schedule.revision,
        scheduledFor: "2026-09-16T12:00:00.000Z",
        schedulerInstanceId: "instance-0",
      });
      if (previous.kind !== "reserved") throw new Error("expected a reservation");
      // The previous worker is alive, so recovery adopts it rather than closing.
      fake.seedRun("run-previous", previous.execution.executionId, true);

      const report = await runOnce(store, fake);
      expect(report.launched).toBe(0);
      expect(report.skippedOverlap).toBe(1);
      // The cursor still advanced, so a long run cannot build a backlog.
      expect(store.getSchedule(schedule.scheduleId)?.nextDueAt).toBe("2026-09-16T12:20:00.000Z");
      expect(executionStatuses(store)).toContain("skipped-overlap");
      expect(store.occupyingExecution(schedule.scheduleId)?.executionId).toBe(previous.execution.executionId);
    } finally {
      store.close();
    }
  });

  test("records launch-failed without occupying the schedule when the spawn dies", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      installSchedule(store);
      fake.setStartError("spawn exploded");
      await runOnce(store, fake);
      expect(executionStatuses(store)).toContain("launch-failed");
    } finally {
      store.close();
    }
  });
});

/**
 * Recovery is evidence-driven, and the loop must keep monitoring an adopted
 * execution rather than assuming it will report for itself. These tests drive
 * real ticks through TestClock.
 */
describe("scheduler loop: recovery across ticks", () => {
  test("a live adopted runner keeps the schedule occupied and skips the next opportunity", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      const schedule = installSchedule(store);
      const previous = store.reserveExecution({
        scheduleId: schedule.scheduleId,
        scheduleRevision: schedule.revision,
        scheduledFor: "2026-09-16T12:00:00.000Z",
        schedulerInstanceId: "instance-0",
      });
      if (previous.kind !== "reserved") throw new Error("expected a reservation");
      store.updateExecution({
        executionId: previous.execution.executionId,
        expectStatus: "reserved",
        status: "running",
        runId: "run-orphan",
      });
      fake.seedRun("run-orphan", previous.execution.executionId, true);

      await withLoop(store, fake, () =>
        Effect.gen(function* () {
          yield* advanceOneTick;
          expect(store.listEvents().some((event) => event.type === "execution.adopted")).toBe(true);
          expect(store.listEvents().some((event) => event.type === "execution.skipped_overlap")).toBe(true);
          expect(fake.started).toHaveLength(0);
          expect(store.occupyingExecution(schedule.scheduleId)?.executionId).toBe(previous.execution.executionId);
        }),
      );
    } finally {
      store.close();
    }
  });

  test("a never-authorized execution is cancelled and frees the schedule", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      const schedule = installSchedule(store, { nextDueAt: "2026-09-16T13:00:00.000Z" });
      const reserved = store.reserveExecution({
        scheduleId: schedule.scheduleId,
        scheduleRevision: schedule.revision,
        scheduledFor: "2026-09-16T12:00:00.000Z",
        schedulerInstanceId: "instance-0",
      });
      if (reserved.kind !== "reserved") throw new Error("expected a reservation");
      store.updateExecution({
        executionId: reserved.execution.executionId,
        expectStatus: "reserved",
        status: "running",
        runId: "run-unauthorized",
      });
      fake.seedRun("run-unauthorized", reserved.execution.executionId, false);

      await withLoop(store, fake, () =>
        Effect.gen(function* () {
          yield* advanceOneTick;
          // Cancelling revokes the authorization: the run is terminal and the
          // slot is free.
          expect(fake.runs.get("run-unauthorized")?.status).toBe("stopped");
          expect(store.occupyingExecution(schedule.scheduleId)).toBeNull();
          expect(store.listEvents().some((event) => event.type === "execution.closed")).toBe(true);
        }),
      );
    } finally {
      store.close();
    }
  });

  test("a run that finishes after adoption closes its execution", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      const schedule = installSchedule(store, { nextDueAt: "2026-09-16T13:00:00.000Z" });
      // An execution left by a previous scheduler instance whose worker is
      // still alive when this instance starts.
      const reserved = store.reserveExecution({
        scheduleId: schedule.scheduleId,
        scheduleRevision: schedule.revision,
        scheduledFor: "2026-09-16T12:00:00.000Z",
        schedulerInstanceId: "instance-0",
      });
      if (reserved.kind !== "reserved") throw new Error("expected a reservation");
      store.updateExecution({
        executionId: reserved.execution.executionId,
        expectStatus: "reserved",
        status: "running",
        runId: "run-adopt",
      });
      fake.seedRun("run-adopt", reserved.execution.executionId, true);

      await withLoop(store, fake, () =>
        Effect.gen(function* () {
          // First tick: the live worker is adopted, and the slot stays held.
          yield* advanceOneTick;
          expect(store.occupyingExecution(schedule.scheduleId)?.executionId).toBe(
            reserved.execution.executionId,
          );

          // The worker then finishes and exits. The loop is not awaiting it —
          // it belongs to a previous instance — so adoption monitoring is what
          // has to notice and close the execution.
          yield* fake.completeRun("run-adopt", "completed", 0);
          fake.setObservation(ABSENT);
          yield* advanceOneTick;
          expect(store.occupyingExecution(schedule.scheduleId)).toBeNull();
          expect(store.getExecution(reserved.execution.executionId)?.status).toBe("completed");
        }),
      );
    } finally {
      store.close();
    }
  });

  test("a dead runner with no recorded outcome is interrupted, never retried", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      const schedule = installSchedule(store, { nextDueAt: "2026-09-16T13:00:00.000Z" });
      const reserved = store.reserveExecution({
        scheduleId: schedule.scheduleId,
        scheduleRevision: schedule.revision,
        scheduledFor: "2026-09-16T12:00:00.000Z",
        schedulerInstanceId: "instance-0",
      });
      if (reserved.kind !== "reserved") throw new Error("expected a reservation");
      store.updateExecution({
        executionId: reserved.execution.executionId,
        expectStatus: "reserved",
        status: "running",
        runId: "run-dead",
      });
      // Claimed, then the runner died without writing an outcome.
      fake.seedRun("run-dead", reserved.execution.executionId, true);
      fake.setObservation(ABSENT);

      await withLoop(store, fake, () =>
        Effect.gen(function* () {
          yield* advanceOneTick;
          expect(fake.runs.get("run-dead")?.status).toBe("crashed");
          expect(store.getExecution(reserved.execution.executionId)?.status).toBe("interrupted");
          expect(store.occupyingExecution(schedule.scheduleId)).toBeNull();
        }),
      );
    } finally {
      store.close();
    }
  });
});

describe("scheduler loop: fatal defects end the process", () => {
  test("a defect in an attempt fiber fails the scheduler rather than looping on", async () => {
    const root = await createTempRoot();
    const store = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    const fake = createFakeHost();
    try {
      installSchedule(store);
      fake.setStartDefect("deliberate defect");
      const exit = await Effect.runPromise(
        withServices(
          store,
          fake,
          Effect.gen(function* () {
            yield* TestClock.setTime(NOW);
            const fiber = yield* Effect.forkChild(
              Effect.scoped(runSchedulerServe(serveOptions({ once: false, pollMs: 1_000 }))),
            );
            yield* advanceOneTick; // launch; the attempt dies
            yield* advanceOneTick; // the completion is drained
            return yield* Fiber.await(fiber);
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(store.listEvents().some((event) => event.type === "scheduler.fatal")).toBe(true);
    } finally {
      store.close();
    }
  });
});
