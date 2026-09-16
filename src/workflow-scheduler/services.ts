/**
 * Effect service boundary for the scheduler.
 *
 * Two services, not one, because they have genuinely different lifetimes and
 * substitutability needs:
 *
 *   - `SchedulerStoreService` owns the scheduler's own database — schedules,
 *     executions, instances, events.
 *   - `ScheduledRunHost` owns everything outside it: the per-project workflow
 *     ledger, the runner child process, and process observation.
 *
 * Both follow the shape `src/services/snapshot-store.ts` establishes: a
 * `Live` layer delegating to plain synchronous code, and a `Test` layer that is
 * genuinely in-memory so a test cannot reach real state by accident. The
 * scheduler loop is the only consumer, and it needs exactly these operations —
 * not a mirror of every store method, which would make the boundary decorative.
 *
 * `ScheduledRunHost.startRun` is the one place a real child process is created.
 * It returns a retained handle rather than detaching, because the scheduler must
 * observe a real exit status; see `workflow-controls.ts`.
 */

import { Context, Effect, Layer } from "effect";
import { expandPath } from "../fs.js";
import {
  startWorkflowRunProcess,
  type WorkflowDetachedRunOptions,
  type WorkflowRunProcess,
} from "../workflow-controls.js";
import { WorkflowStore } from "../workflow-store.js";
import { SchedulerLaunchError, SchedulerStoreError } from "./errors.js";
import {
  observeProcessIdentity,
  processIdentityOf,
  type ProcessIdentity,
  type ProcessObservation,
} from "./process-identity.js";
import type { ScheduledRunEvidence } from "./reconcile.js";
import {
  SchedulerStore,
  type ScheduleExecutionRecord,
  type SchedulerInstanceMode,
  type WorkflowScheduleRecord,
} from "./store.js";

// ---------------------------------------------------------------------------
// Scheduler store service
// ---------------------------------------------------------------------------

export interface SchedulerStoreServiceShape {
  readonly listSchedules: Effect.Effect<ReadonlyArray<WorkflowScheduleRecord>>;
  readonly getSchedule: (scheduleId: string) => Effect.Effect<WorkflowScheduleRecord | null>;
  readonly listOccupyingExecutions: Effect.Effect<ReadonlyArray<ScheduleExecutionRecord>>;
  readonly occupyingExecution: (scheduleId: string) => Effect.Effect<ScheduleExecutionRecord | null>;
  readonly reserveExecution: (input: {
    readonly scheduleId: string;
    readonly scheduleRevision: number;
    readonly scheduledFor: string | null;
    readonly schedulerInstanceId: string;
  }) => Effect.Effect<
    { readonly kind: "reserved"; readonly execution: ScheduleExecutionRecord } | { readonly kind: "occupied" }
  >;
  readonly recordSkippedOverlap: (input: {
    readonly scheduleId: string;
    readonly scheduleRevision: number;
    readonly scheduledFor: string | null;
    readonly schedulerInstanceId: string;
  }) => Effect.Effect<ScheduleExecutionRecord>;
  readonly advanceCursor: (input: {
    readonly scheduleId: string;
    readonly revision: number;
    readonly nextDueAt: string;
    readonly lastExecutionId?: string | null;
  }) => Effect.Effect<boolean>;
  readonly updateExecution: (
    input: Parameters<SchedulerStore["updateExecution"]>[0],
  ) => Effect.Effect<boolean>;
  readonly heartbeatExecution: (executionId: string) => Effect.Effect<void>;
  readonly recordEvent: (input: Parameters<SchedulerStore["recordEvent"]>[0]) => Effect.Effect<void>;
  readonly registerInstance: (input: {
    readonly instanceId: string;
    readonly pid: number;
    readonly bootId: string | null;
    readonly startId: string | null;
    readonly version: string;
    readonly mode: SchedulerInstanceMode;
  }) => Effect.Effect<void>;
  readonly heartbeatInstance: (instanceId: string) => Effect.Effect<void>;
  readonly closeInstance: (instanceId: string, lastFatalCause?: string) => Effect.Effect<void>;
}

export class SchedulerStoreService extends Context.Service<
  SchedulerStoreService,
  SchedulerStoreServiceShape
>()("prism/SchedulerStoreService") {}

export const SchedulerStoreServiceLive = (
  store: SchedulerStore,
): Layer.Layer<SchedulerStoreService> =>
  Layer.succeed(SchedulerStoreService, {
    listSchedules: Effect.sync(() => store.listSchedules()),
    getSchedule: (scheduleId) => Effect.sync(() => store.getSchedule(scheduleId)),
    listOccupyingExecutions: Effect.sync(() => store.listOccupyingExecutions()),
    occupyingExecution: (scheduleId) => Effect.sync(() => store.occupyingExecution(scheduleId)),
    reserveExecution: (input) => Effect.sync(() => store.reserveExecution(input)),
    recordSkippedOverlap: (input) => Effect.sync(() => store.recordSkippedOverlap(input)),
    advanceCursor: (input) => Effect.sync(() => store.advanceCursor(input)),
    updateExecution: (input) => Effect.sync(() => store.updateExecution(input)),
    heartbeatExecution: (executionId) => Effect.sync(() => store.heartbeatExecution(executionId)),
    recordEvent: (input) => Effect.sync(() => store.recordEvent(input)),
    registerInstance: (input) => Effect.sync(() => store.registerInstance(input)),
    heartbeatInstance: (instanceId) => Effect.sync(() => store.heartbeatInstance(instanceId)),
    closeInstance: (instanceId, lastFatalCause) =>
      Effect.sync(() => store.closeInstance(instanceId, lastFatalCause)),
  });

// ---------------------------------------------------------------------------
// Scheduled run host
// ---------------------------------------------------------------------------

/** A runner process the scheduler has spawned and still owns. */
export interface StartedScheduledRun {
  readonly pid: number;
  readonly identity: ProcessIdentity;
  /** Resolves with the process's real exit code once it has exited and been reaped. */
  readonly exited: Effect.Effect<number | null>;
  /** SIGTERM the runner's process group, escalating to SIGKILL. */
  readonly terminate: Effect.Effect<void>;
}

export interface PrepareScheduledRunInput {
  readonly storePath: string;
  readonly workflow: string;
  readonly workflowFile: string;
  readonly executionId: string;
  readonly scheduleId: string;
  readonly scheduledFor: string | null;
  readonly runId: string;
  readonly token: string;
  readonly options: WorkflowDetachedRunOptions;
}

export interface ScheduledRunHostShape {
  /** Create the run, record its provenance, and issue its launch authorization. */
  readonly prepareRun: (input: PrepareScheduledRunInput) => Effect.Effect<void, SchedulerLaunchError>;
  /** Spawn the runner process and retain its handle. */
  readonly startRun: (input: PrepareScheduledRunInput) => Effect.Effect<StartedScheduledRun, SchedulerLaunchError>;
  /** Read the reconciliation evidence for a run. Never fails: an unreadable ledger is evidence too. */
  readonly readRunEvidence: (input: {
    readonly storePath: string;
    readonly runId: string;
  }) => Effect.Effect<ScheduledRunEvidence>;
  /** Observe a recorded process identity. `null` in, `null` out — there is nothing to observe. */
  readonly observe: (identity: ProcessIdentity | null) => Effect.Effect<ProcessObservation | null>;
  /** Terminalize a scheduled run the scheduler established cannot continue. */
  readonly interruptRun: (input: {
    readonly storePath: string;
    readonly runId: string;
    readonly kind: "interrupted" | "cancelled";
    readonly reason: string;
    readonly runnerPid?: number | null;
    readonly heartbeatAt?: string | null;
  }) => Effect.Effect<boolean>;
}

export class ScheduledRunHost extends Context.Service<ScheduledRunHost, ScheduledRunHostShape>()(
  "prism/ScheduledRunHost",
) {}

const withWorkflowStore = <A>(
  storePath: string,
  use: (store: WorkflowStore) => A,
): Effect.Effect<A, SchedulerLaunchError> =>
  Effect.tryPromise({
    try: async () => {
      const store = await WorkflowStore.open(expandPath(storePath));
      try {
        return use(store);
      } finally {
        store.close();
      }
    },
    catch: (cause) =>
      new SchedulerLaunchError({
        message: `could not open the workflow store at ${storePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        hint: "check that the schedule's store path is writable and that no newer Prism wrote it",
        executionId: "",
      }),
  });

const prepareRun = (input: PrepareScheduledRunInput): Effect.Effect<void, SchedulerLaunchError> =>
  withWorkflowStore(input.storePath, (store) => {
    store.createRun(input.workflow, input.runId, {
      executionId: input.executionId,
      scheduleId: input.scheduleId,
      scheduledFor: input.scheduledFor,
    });
    store.setRunHandoffToken(input.runId, input.token);
    store.recordRunSnapshot({
      runId: input.runId,
      workflowFile: input.workflowFile,
      options: input.options as Record<string, unknown>,
    });
  });

const startRun = (input: PrepareScheduledRunInput): Effect.Effect<StartedScheduledRun, SchedulerLaunchError> =>
  Effect.gen(function* () {
    const store = yield* Effect.tryPromise({
      try: () => WorkflowStore.open(expandPath(input.storePath)),
      catch: (cause) =>
        new SchedulerLaunchError({
          message: `could not open the workflow store at ${input.storePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          hint: "check that the schedule's store path is writable",
          executionId: input.executionId,
        }),
    });
    let process: WorkflowRunProcess;
    try {
      process = startWorkflowRunProcess({
        store,
        file: expandPath(input.workflowFile),
        options: input.options,
        run: { runId: input.runId, storePath: expandPath(input.storePath), token: input.token },
      });
    } catch (cause) {
      store.close();
      return yield* Effect.fail(
        new SchedulerLaunchError({
          message: `could not spawn a runner for ${input.workflowFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
          hint: "check that the Prism CLI is executable and that the workflow file still exists",
          executionId: input.executionId,
        }),
      );
    }
    // The scheduler is not a detached launcher: it keeps the handle so it can
    // observe the real exit status, and it must not close the store until the
    // child has been reaped.
    return {
      pid: process.pid,
      identity: processIdentityOf(process.pid),
      exited: Effect.promise(() => process.exited).pipe(
        Effect.ensuring(Effect.sync(() => store.close())),
      ),
      terminate: Effect.promise(() => process.terminate("scheduler-shutdown")),
    };
  });

const readRunEvidence = (input: {
  readonly storePath: string;
  readonly runId: string;
}): Effect.Effect<ScheduledRunEvidence> =>
  // `Effect.promise`, not `tryPromise`: this never rejects. An unreadable
  // ledger is itself evidence, and the reducer is entitled to it as such.
  Effect.promise(async (): Promise<ScheduledRunEvidence> => {
    try {
      const store = await WorkflowStore.open(expandPath(input.storePath));
      try {
        const state = store.scheduledRunState(input.runId);
        return state === null ? { kind: "absent" } : { kind: "found", run: state };
      } finally {
        store.close();
      }
    } catch (cause) {
      return {
        kind: "unreadable",
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });

export const ScheduledRunHostLive: Layer.Layer<ScheduledRunHost> = Layer.succeed(ScheduledRunHost, {
  prepareRun,
  startRun,
  readRunEvidence,
  observe: (identity) => Effect.sync(() => (identity === null ? null : observeProcessIdentity(identity))),
  interruptRun: (input) =>
    withWorkflowStore(input.storePath, (store) =>
      store.interruptScheduledRun({
        runId: input.runId,
        kind: input.kind,
        reason: input.reason,
        runnerPid: input.runnerPid ?? null,
        heartbeatAt: input.heartbeatAt ?? null,
      }),
    ).pipe(Effect.orElseSucceed(() => false)),
});

/**
 * Translate a scheduler-store failure at the edge. The store is synchronous, so
 * a throw there is a real defect in the store layer rather than a transient
 * condition to retry; it is surfaced as a typed error so the CLI can report it
 * with a hint instead of a stack.
 */
export const schedulerStoreError = (path: string, cause: unknown): SchedulerStoreError =>
  new SchedulerStoreError({
    message: `scheduler store failure at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    hint: "run `prism workflow scheduler status` to inspect the store, or remove it to start clean (installed schedules are lost)",
    path,
  });
