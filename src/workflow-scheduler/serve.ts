/**
 * The scheduler loop.
 *
 * One `Effect.gen` program owns the whole lifecycle: the instance record, the
 * recovery pass, the tick loop, and the supervision of every attempt it starts.
 * The Effect boundary sits here rather than around individual store calls,
 * because what Effect actually buys this feature is *structured* concurrency —
 * scoped attempt fibers that stop when the scheduler stops, an interruptible
 * sleep, and a test clock — not wrapping synchronous SQLite in `Effect.sync`.
 *
 * Deliberate choices, each of which had a plausible alternative:
 *
 * **Recovery is not a tick.** At startup the loop reconciles every occupying
 * execution, then *discards* overdue opportunities by advancing their cursors
 * past now. A wake means Prism was merely not watching, so the overdue
 * occurrence is honoured by the tick path; a restart is not evidence that the
 * missed work should happen now, so it is not replayed.
 *
 * **Adopted executions are monitored, not just recovered.** An execution left by
 * a previous scheduler is reconciled on every tick, so a worker that finishes
 * after the scheduler restarted still closes its execution. Without that,
 * adoption would pin a schedule forever.
 *
 * **Graceful shutdown does not kill in-flight runners.** They are detached
 * children with their own ledger rows; killing one mid-task is how a partially
 * processed item happens. Shutdown stops claiming and leaves them running, and
 * the next instance adopts them. Stopping a specific run is
 * `prism workflow runs stop <runId>`, which terminates the process group.
 *
 * **A defect ends the process.** Expected failures are recorded and the loop
 * continues; a defect is not swallowed into an endlessly "healthy"-looking loop.
 * Attempt fibers relay their Exit through a queue precisely because
 * `forkScoped` alone would let a child defect vanish.
 */

import { randomUUID } from "node:crypto";
import { Cause, Clock, Duration, Effect, Exit, Fiber, Ref, Result, Scope } from "effect";
import type { WorkflowDetachedRunOptions } from "../workflow-controls.js";
import { nextWorkflowCronOccurrence, parseWorkflowCron } from "./cron.js";
import { SchedulerFatalError, type SchedulerError } from "./errors.js";
import type { ProcessObservation } from "./process-identity.js";
import { reconcileExecution, type ScheduledRunEvidence } from "./reconcile.js";
import { SchedulerStoreService, ScheduledRunHost } from "./services.js";
import type {
  ScheduleExecutionRecord,
  SchedulerInstanceMode,
  WorkflowScheduleRecord,
} from "./store.js";

export const DEFAULT_SCHEDULER_POLL_MS = 1_000;

export interface SchedulerServeOptions {
  readonly instanceId: string;
  readonly version: string;
  readonly instanceMode: SchedulerInstanceMode;
  readonly pollMs?: number;
  /** Run recovery and exactly one tick, then return. Used by tests and `--once`. */
  readonly once?: boolean;
  /**
   * Run recovery only, then return without ticking. `prism workflow scheduler
   * reconcile` uses this: it is the explicit way to resolve executions left by a
   * previous scheduler, without also launching whatever is currently due.
   */
  readonly reconcileOnly?: boolean;
}

export interface SchedulerServeReport {
  readonly instanceId: string;
  readonly ticks: number;
  readonly launched: number;
  readonly skippedOverlap: number;
  readonly reconciled: number;
  readonly leftRunningOnShutdown: number;
}

interface AttemptCompletion {
  readonly executionId: string;
  readonly scheduleId: string;
  readonly exit: Exit.Exit<void, SchedulerError>;
}

const emptyCounters = () => ({
  ticks: 0,
  launched: 0,
  skippedOverlap: 0,
  reconciled: 0,
  leftRunningOnShutdown: 0,
});

/**
 * The ledger status an execution outcome represents.
 *
 * A run still `running` after its runner exited was left unfinished — killed,
 * or crashed before it could write a result — so `interrupted` is the truthful
 * mapping, not `failed`: nothing about the workflow itself failed.
 */
const executionStatusForRunStatus = (status: string): "completed" | "failed" | "interrupted" => {
  if (status === "completed") return "completed";
  if (status === "running" || status === "unknown") return "interrupted";
  return "failed";
};

/** The CLI fallbacks a schedule carries, narrowed to what the launcher accepts. */
const detachedRunOptions = (options: Record<string, unknown>): WorkflowDetachedRunOptions => ({
  ...(typeof options.worker === "string" ? { worker: options.worker } : {}),
  ...(typeof options.model === "string" ? { model: options.model } : {}),
  ...(typeof options.permission === "string" ? { permission: options.permission } : {}),
  ...(typeof options.mockOutput === "string" ? { mockOutput: options.mockOutput } : {}),
});

/**
 * Run the scheduler until interrupted (or for one tick, with `once`).
 *
 * Requires `Effect.scoped` at the call site: attempt fibers are scoped to this
 * program, so they stop when it stops.
 */
export const runSchedulerServe = (
  options: SchedulerServeOptions,
): Effect.Effect<
  SchedulerServeReport,
  SchedulerError,
  SchedulerStoreService | ScheduledRunHost | Scope.Scope
> =>
  Effect.gen(function* () {
    const store = yield* SchedulerStoreService;
    const host = yield* ScheduledRunHost;
    const pollMs = options.pollMs ?? DEFAULT_SCHEDULER_POLL_MS;

    /** Execution ids this process is actively supervising. */
    const inFlight = yield* Ref.make<ReadonlySet<string>>(new Set());
    /** Execution ids already reported as adopted, so adoption is logged once. */
    const adopted = yield* Ref.make<ReadonlySet<string>>(new Set());
    /**
     * Attempt exits, collected by the attempt fibers and drained by the loop.
     * A `Ref` rather than a `Queue` on purpose: `Queue.takeAll` *blocks* on an
     * empty queue, which would stall every tick that had nothing to drain.
     */
    const completions = yield* Ref.make<ReadonlyArray<AttemptCompletion>>([]);
    /** Attempt fibers started by this process, so `once` can await its own tick. */
    const attemptFibers = yield* Ref.make<ReadonlyArray<Fiber.Fiber<void, never>>>([]);
    const report = yield* Ref.make(emptyCounters());

    yield* store.registerInstance({
      instanceId: options.instanceId,
      pid: process.pid,
      bootId: null,
      startId: null,
      version: options.version,
      mode: options.instanceMode,
    });
    yield* store.recordEvent({
      instanceId: options.instanceId,
      type: "scheduler.started",
      payload: { pollMs, mode: options.instanceMode, once: options.once === true },
    });

    const observeChild = (
      execution: ScheduleExecutionRecord,
    ): Effect.Effect<ProcessObservation | null> =>
      host.observe(
        execution.childPid === null
          ? null
          : { pid: execution.childPid, bootId: execution.childBootId, startId: execution.childStartId },
      );

    const observeRunnerFor = (
      evidence: ScheduledRunEvidence,
    ): Effect.Effect<ProcessObservation | null> =>
      host.observe(evidence.kind === "found" ? evidence.run.runner : null);

    /**
     * Apply one reconciliation decision. Returns true when the execution was
     * closed, so the caller can count it.
     */
    const applyDecision = (
      schedule: WorkflowScheduleRecord,
      execution: ScheduleExecutionRecord,
      evidence: ScheduledRunEvidence,
      runnerObservation: ProcessObservation | null,
      childObservation: ProcessObservation | null,
    ): Effect.Effect<boolean, SchedulerError> =>
      Effect.gen(function* () {
        const decision = reconcileExecution({
          execution,
          run: evidence,
          runnerObservation,
          childObservation,
        });
        const runId = execution.runId;

        if (decision.action.kind === "adopt") {
          const already = yield* Ref.modify(adopted, (set) =>
            set.has(execution.executionId)
              ? ([true, set] as const)
              : ([false, new Set([...set, execution.executionId])] as const),
          );
          if (!already) {
            yield* store.recordEvent({
              instanceId: options.instanceId,
              scheduleId: execution.scheduleId,
              executionId: execution.executionId,
              type: "execution.adopted",
              payload: { reason: decision.reason, runId },
            });
          }
          return false;
        }

        if (decision.action.kind === "await-finalization") {
          yield* store.heartbeatExecution(execution.executionId);
          return false;
        }

        if (decision.action.kind === "stay-uncertain") {
          yield* store.updateExecution({
            executionId: execution.executionId,
            expectStatus: execution.status,
            status: "uncertain",
            cause: { reason: decision.reason, classification: decision.classification },
          });
          yield* store.recordEvent({
            instanceId: options.instanceId,
            scheduleId: execution.scheduleId,
            executionId: execution.executionId,
            type: "execution.uncertain",
            payload: { reason: decision.reason },
          });
          return false;
        }

        if (decision.action.kind === "close-with-result") {
          const runStatus = evidence.kind === "found" ? evidence.run.status : "unknown";
          yield* store.updateExecution({
            executionId: execution.executionId,
            expectStatus: execution.status,
            status: executionStatusForRunStatus(runStatus),
            finishedAt: new Date().toISOString(),
            outcome: {
              ...(runId === null ? {} : { runId }),
              runStatus,
              reconciledFrom: "previous-instance",
              runnerObservation: runnerObservation?.kind ?? "not-observed",
            },
          });
          yield* store.recordEvent({
            instanceId: options.instanceId,
            scheduleId: execution.scheduleId,
            executionId: execution.executionId,
            type: "execution.reconciled",
            payload: { runId, runStatus, classification: decision.classification },
          });
          return true;
        }

        // close-interrupted and close-cancelled both revoke the ledger run
        // first. The write is guarded on `status = 'running'`, so if a runner
        // claimed the run concurrently this reports false and the execution
        // stays occupied for the next pass rather than being closed underneath
        // a live worker.
        const kind = decision.action.kind === "close-interrupted" ? "interrupted" : "cancelled";
        if (runId !== null) {
          const wrote = yield* host.interruptRun({
            storePath: schedule.storePath,
            runId,
            kind,
            reason: decision.reason,
            runnerPid: execution.childPid,
            heartbeatAt: execution.leaseHeartbeatAt,
          });
          if (!wrote) {
            yield* store.recordEvent({
              instanceId: options.instanceId,
              scheduleId: execution.scheduleId,
              executionId: execution.executionId,
              type: "execution.reconcile_deferred",
              payload: { runId, reason: "the run was claimed or closed concurrently; re-classifying" },
            });
            return false;
          }
        }
        yield* store.updateExecution({
          executionId: execution.executionId,
          expectStatus: execution.status,
          status: kind === "interrupted" ? "interrupted" : "cancelled",
          finishedAt: new Date().toISOString(),
          cause: { reason: decision.reason, classification: decision.classification },
        });
        yield* store.recordEvent({
          instanceId: options.instanceId,
          scheduleId: execution.scheduleId,
          executionId: execution.executionId,
          type: "execution.closed",
          payload: { status: kind, reason: decision.reason },
        });
        return true;
      });

    /**
     * Reconcile executions this process is not already supervising. At startup
     * that is every occupying execution; on each later tick it is the ones left
     * by previous schedulers, so adoption is monitored rather than assumed.
     */
    const reconcileOrphans = (): Effect.Effect<void, SchedulerError> =>
      Effect.gen(function* () {
        const mine = yield* Ref.get(inFlight);
        for (const execution of yield* store.listOccupyingExecutions) {
          if (mine.has(execution.executionId)) continue;
          const schedule = yield* store.getSchedule(execution.scheduleId);
          if (schedule === null) {
            // The schedule was removed out from under an execution. Removal
            // refuses while an execution occupies the slot, so this means the
            // row was deleted by hand; there is nothing to reconcile against.
            yield* store.recordEvent({
              instanceId: options.instanceId,
              executionId: execution.executionId,
              type: "execution.orphaned",
              payload: { reason: "the owning schedule no longer exists" },
            });
            continue;
          }
          if (execution.runId === null) continue;
          const evidence = yield* host.readRunEvidence({
            storePath: schedule.storePath,
            runId: execution.runId,
          });
          const closed = yield* applyDecision(
            schedule,
            execution,
            evidence,
            yield* observeRunnerFor(evidence),
            yield* observeChild(execution),
          );
          if (closed) {
            yield* Ref.update(report, (current) => ({ ...current, reconciled: current.reconciled + 1 }));
          }
        }
      });

    /** Start one reserved execution as a scoped attempt fiber. */
    const launch = (
      schedule: WorkflowScheduleRecord,
      execution: ScheduleExecutionRecord,
      runId: string,
    ): Effect.Effect<void, SchedulerError, Scope.Scope> =>
      Effect.gen(function* () {
        yield* Ref.update(inFlight, (set) => new Set([...set, execution.executionId]));

        const attempt = Effect.gen(function* () {
          // The token is generated here and never persisted: it goes straight
          // from the ledger's stored hash into the child's argv. If the
          // scheduler dies between writing the run and spawning, the token is
          // simply lost, and recovery sees an unconsumed authorization — which
          // is exactly the state it should see.
          const token = randomUUID();
          const prepared = {
            storePath: schedule.storePath,
            workflow: schedule.name,
            workflowFile: schedule.workflowFile,
            executionId: execution.executionId,
            scheduleId: schedule.scheduleId,
            scheduledFor: execution.scheduledFor,
            runId,
            token,
            options: detachedRunOptions(schedule.options),
          };
          yield* host.prepareRun(prepared);
          const started = yield* host.startRun(prepared);
          yield* store.updateExecution({
            executionId: execution.executionId,
            expectStatus: "reserved",
            status: "running",
            childPid: started.pid,
            childBootId: started.identity.bootId,
            childStartId: started.identity.startId,
          });
          yield* store.recordEvent({
            instanceId: options.instanceId,
            scheduleId: schedule.scheduleId,
            executionId: execution.executionId,
            type: "execution.launched",
            payload: { runId, childPid: started.pid },
          });

          const exitCode = yield* started.exited;

          // The child is gone. Read what it left rather than assuming: the
          // runner identity comes from the ledger, and a run still `running`
          // here was left unfinished.
          const evidence = yield* host.readRunEvidence({ storePath: schedule.storePath, runId });
          const runStatus = evidence.kind === "found" ? evidence.run.status : "unknown";
          const runnerObservation = yield* observeRunnerFor(evidence);
          yield* store.updateExecution({
            executionId: execution.executionId,
            expectStatus: "running",
            status: executionStatusForRunStatus(runStatus),
            observedExitCode: exitCode,
            finishedAt: new Date().toISOString(),
            outcome: {
              runId,
              runStatus,
              observedExitCode: exitCode,
              runnerObservation: runnerObservation?.kind ?? "not-observed",
            },
          });
          yield* store.recordEvent({
            instanceId: options.instanceId,
            scheduleId: schedule.scheduleId,
            executionId: execution.executionId,
            type: "execution.finished",
            payload: { runId, runStatus, observedExitCode: exitCode },
          });
        }).pipe(
          Effect.catch((error: SchedulerError) =>
            Effect.gen(function* () {
              yield* store.updateExecution({
                executionId: execution.executionId,
                expectStatus: "reserved",
                status: "launch-failed",
                finishedAt: new Date().toISOString(),
                cause: { message: error.message, hint: error.hint },
              });
              yield* store.recordEvent({
                instanceId: options.instanceId,
                scheduleId: schedule.scheduleId,
                executionId: execution.executionId,
                type: "execution.launch_failed",
                payload: { message: error.message, hint: error.hint },
              });
            }),
          ),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              // Shutdown, not failure. The runner keeps its own ledger row and
              // the next instance adopts it; the execution stays occupying so
              // the schedule cannot be double-run in the meantime.
              yield* store.recordEvent({
                instanceId: options.instanceId,
                scheduleId: schedule.scheduleId,
                executionId: execution.executionId,
                type: "execution.left_running_on_shutdown",
                payload: { runId },
              });
              yield* Ref.update(report, (current) => ({
                ...current,
                leftRunningOnShutdown: current.leftRunningOnShutdown + 1,
              }));
            }),
          ),
          Effect.ensuring(
            Ref.update(inFlight, (set) => {
              const next = new Set(set);
              next.delete(execution.executionId);
              return next;
            }),
          ),
        );

        const fiber = yield* Effect.forkScoped(
          attempt.pipe(
            Effect.onExit((exit) =>
              Ref.update(completions, (pending) => [
                ...pending,
                { executionId: execution.executionId, scheduleId: schedule.scheduleId, exit },
              ]),
            ),
            Effect.asVoid,
          ),
        );
        yield* Ref.update(attemptFibers, (fibers) => [...fibers, fiber]);
      });

    /** One pass: reconcile orphans, then act on every due schedule. */
    const tick = (nowMs: number): Effect.Effect<void, SchedulerError, Scope.Scope> =>
      Effect.gen(function* () {
        yield* reconcileOrphans();
        for (const schedule of yield* store.listSchedules) {
          if (!schedule.enabled || schedule.nextDueAt === null) continue;
          const dueMs = Date.parse(schedule.nextDueAt);
          if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;

          const parsed = parseWorkflowCron(schedule.cron, schedule.timezone);
          const nextDueAt = new Date(nextWorkflowCronOccurrence(parsed, nowMs)).toISOString();

          if ((yield* store.occupyingExecution(schedule.scheduleId)) !== null) {
            // Consume the opportunity as a skip. The cursor advances whether or
            // not anything launches, so a long run cannot accumulate a backlog.
            const skipped = yield* store.recordSkippedOverlap({
              scheduleId: schedule.scheduleId,
              scheduleRevision: schedule.revision,
              scheduledFor: schedule.nextDueAt,
              schedulerInstanceId: options.instanceId,
            });
            yield* store.advanceCursor({
              scheduleId: schedule.scheduleId,
              revision: schedule.revision,
              nextDueAt,
              lastExecutionId: skipped.executionId,
            });
            yield* store.recordEvent({
              instanceId: options.instanceId,
              scheduleId: schedule.scheduleId,
              executionId: skipped.executionId,
              type: "execution.skipped_overlap",
              payload: { scheduledFor: schedule.nextDueAt },
            });
            yield* Ref.update(report, (current) => ({ ...current, skippedOverlap: current.skippedOverlap + 1 }));
            continue;
          }

          const reserved = yield* store.reserveExecution({
            scheduleId: schedule.scheduleId,
            scheduleRevision: schedule.revision,
            scheduledFor: schedule.nextDueAt,
            schedulerInstanceId: options.instanceId,
          });
          if (reserved.kind === "occupied") continue;

          const runId = randomUUID();
          const advanced = yield* store.advanceCursor({
            scheduleId: schedule.scheduleId,
            revision: schedule.revision,
            nextDueAt,
            lastExecutionId: reserved.execution.executionId,
          });
          if (!advanced) {
            // The schedule was edited between the decision and the write, so
            // this execution belongs to a plan that no longer exists.
            yield* store.updateExecution({
              executionId: reserved.execution.executionId,
              expectStatus: "reserved",
              status: "cancelled",
              finishedAt: new Date().toISOString(),
              cause: { reason: "the schedule was edited before the launch was authorized" },
            });
            continue;
          }

          yield* store.updateExecution({
            executionId: reserved.execution.executionId,
            expectStatus: "reserved",
            status: "reserved",
            runId,
          });
          yield* launch(schedule, reserved.execution, runId);
          yield* Ref.update(report, (current) => ({ ...current, launched: current.launched + 1 }));
        }
      });

    /** Surface an attempt's defect as a scheduler failure; typed failures were already recorded. */
    const drainCompletions = (): Effect.Effect<void, SchedulerError> =>
      Effect.gen(function* () {
        for (const completion of yield* Ref.getAndSet(completions, [])) {
          if (Exit.isSuccess(completion.exit)) continue;
          const cause = completion.exit.cause;
          if (Cause.findErrorOption(cause)._tag === "Some") continue;
          if (Cause.hasInterruptsOnly(cause)) continue;
          const defect = Cause.findDefect(cause);
          const message = Result.isSuccess(defect)
            ? String(defect.success instanceof Error ? defect.success.message : defect.success)
            : Cause.pretty(cause);
          yield* store.closeInstance(options.instanceId, message);
          yield* store.recordEvent({
            instanceId: options.instanceId,
            scheduleId: completion.scheduleId,
            executionId: completion.executionId,
            type: "scheduler.fatal",
            payload: { message },
          });
          return yield* Effect.fail(
            new SchedulerFatalError({
              message: `scheduler defect while supervising execution ${completion.executionId}: ${message}`,
              hint: "the scheduler process exits so its service manager can restart it; run `prism workflow scheduler reconcile` if an execution is left occupied",
            }),
          );
        }
      });

    // -- recovery ------------------------------------------------------------
    yield* store.recordEvent({
      instanceId: options.instanceId,
      type: "scheduler.recovery.started",
      payload: {},
    });
    yield* reconcileOrphans();

    // Nothing is discarded here, and that is deliberate. An overdue cursor fires
    // exactly one coalesced opportunity on the first tick and then jumps to the
    // next future occurrence, so "a machine asleep for three hours runs once, not
    // eighteen" falls out of the cursor rather than needing a rule. Discarding
    // instead would mean a scheduler restart silently swallowed an inbox poll,
    // and it is self-limiting without one: after that single run the cursor is in
    // the future, so even a crash-loop stays quiet until the next occurrence.
    yield* store.recordEvent({
      instanceId: options.instanceId,
      type: "scheduler.recovery.finished",
      payload: {},
    });

    // -- loop ----------------------------------------------------------------
    if (options.reconcileOnly === true) {
      const counted = yield* Ref.get(report);
      yield* store.recordEvent({
        instanceId: options.instanceId,
        type: "scheduler.reconcile_only",
        payload: counted,
      });
      yield* store.closeInstance(options.instanceId);
      return { instanceId: options.instanceId, ...counted };
    }
    if (options.once === true) {
      // `--once` is a synchronous tick: it waits for the attempts it started.
      // That is what makes it usable as a foreground cron entry, where the
      // caller needs a real exit status rather than "a process was launched" —
      // and it is the same reason the scheduler is not a detached launcher.
      yield* drainCompletions();
      yield* tick(yield* Clock.currentTimeMillis);
      for (const fiber of yield* Ref.getAndSet(attemptFibers, [])) {
        yield* Fiber.await(fiber);
      }
      yield* drainCompletions();
      yield* store.heartbeatInstance(options.instanceId);
    } else {
      yield* Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(pollMs));
          yield* drainCompletions();
          yield* tick(yield* Clock.currentTimeMillis);
          yield* store.heartbeatInstance(options.instanceId);
          yield* Ref.update(report, (current) => ({ ...current, ticks: current.ticks + 1 }));
        }),
      );
    }

    const counted = yield* Ref.get(report);
    yield* store.recordEvent({
      instanceId: options.instanceId,
      type: "scheduler.stopped",
      payload: counted,
    });
    yield* store.closeInstance(options.instanceId);
    return { instanceId: options.instanceId, ...counted };
  });
