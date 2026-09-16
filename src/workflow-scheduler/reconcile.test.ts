import { describe, expect, test } from "bun:test";
import type { WorkflowRunStatus, WorkflowScheduledRunState } from "../workflow-store.js";
import type { ProcessObservation } from "./process-identity.js";
import { reconcileExecution, type ScheduledRunEvidence } from "./reconcile.js";
import type { ScheduleExecutionRecord, ScheduleExecutionStatus } from "./store.js";

const execution = (overrides: Partial<ScheduleExecutionRecord> = {}): ScheduleExecutionRecord => ({
  executionId: "exec-1",
  scheduleId: "sched-1",
  scheduleRevision: 1,
  status: "running",
  scheduledFor: "2026-09-16T12:00:00.000Z",
  schedulerInstanceId: "instance-old",
  runId: "run-1",
  childPid: 4242,
  childBootId: "boot-1",
  childStartId: "start-1",
  authorizedAt: "2026-09-16T12:00:01.000Z",
  leaseHeartbeatAt: "2026-09-16T12:00:01.000Z",
  startedAt: "2026-09-16T12:00:00.000Z",
  finishedAt: null,
  observedExitCode: null,
  outcome: null,
  cause: null,
  ...overrides,
});

const run = (overrides: Partial<WorkflowScheduledRunState> = {}): WorkflowScheduledRunState => ({
  runId: "run-1",
  workflow: "inbox-router",
  status: "running",
  schedulingExecutionId: "exec-1",
  schedulingScheduleId: "sched-1",
  scheduledFor: "2026-09-16T12:00:00.000Z",
  runner: { pid: 4242, bootId: "boot-1", startId: "start-1" },
  launchAuthorized: true,
  terminalCause: null,
  finishedAt: null,
  heartbeatAt: "2026-09-16T12:00:05.000Z",
  ...overrides,
});

const found = (overrides: Partial<WorkflowScheduledRunState> = {}): ScheduledRunEvidence => ({
  kind: "found",
  run: run(overrides),
});

const sameProcess: ProcessObservation = {
  kind: "same-process",
  identity: { pid: 4242, bootId: "boot-1", startId: "start-1" },
};
const absent: ProcessObservation = { kind: "absent", reason: "pid 4242 does not exist" };
const unknown: ProcessObservation = { kind: "unknown", reason: "start identity is unreadable" };

const classify = (
  evidence: ScheduledRunEvidence,
  runnerObservation: ProcessObservation | null,
  childObservation: ProcessObservation | null = null,
  executionOverrides: Partial<ScheduleExecutionRecord> = {},
) =>
  reconcileExecution({
    execution: execution(executionOverrides),
    run: evidence,
    runnerObservation,
    childObservation,
  });

describe("reconciliation classifications", () => {
  test("a demonstrably live runner is adopted, not replaced", () => {
    const decision = classify(found(), sameProcess);
    expect(decision.classification).toBe("alive");
    expect(decision.action).toEqual({ kind: "adopt" });
  });

  test("a live runner is adopted even when its heartbeat has gone quiet", () => {
    // The whole point: heartbeat age is not evidence. A live process with a
    // stale heartbeat is degraded, and replacing it would double-run the work.
    const decision = classify(found({ heartbeatAt: "1999-01-01T00:00:00.000Z" }), sameProcess);
    expect(decision.classification).toBe("alive");
    expect(decision.action).toEqual({ kind: "adopt" });
  });

  test("a terminal run whose runner is still present is finalizing, not closed", () => {
    for (const status of ["completed", "failed", "crashed"] as const) {
      const decision = classify(found({ status }), sameProcess);
      expect(decision.classification).toBe("finalizing");
      expect(decision.action).toEqual({ kind: "await-finalization" });
    }
  });

  test("a terminal run whose runner is gone is closed with its durable outcome", () => {
    for (const status of ["completed", "failed", "escalated", "stopped", "crashed"] as const) {
      const decision = classify(found({ status }), absent);
      expect(decision.classification).toBe("ended-with-result");
      expect(decision.action).toEqual({ kind: "close-with-result" });
    }
  });

  test("a gone runner with no recorded outcome is interrupted, never replayed", () => {
    const decision = classify(found(), absent);
    expect(decision.classification).toBe("dead-without-result");
    expect(decision.action.kind).toBe("close-interrupted");
    expect(decision.reason).toContain("no outcome");
  });

  test("an unconsumed authorization is cancelled, because no workflow code ran", () => {
    const decision = classify(found({ launchAuthorized: false, runner: null }), null);
    expect(decision.classification).toBe("never-authorized");
    expect(decision.action.kind).toBe("close-cancelled");
  });

  test("an unconsumed authorization with a live child is still cancelled, and revokes", () => {
    // Cancelling is a revocation, not a bet: the runner's claim requires the run
    // to still be running, so a child that arrives late cannot import user code.
    const decision = classify(
      found({ launchAuthorized: false, runner: null }),
      null,
      sameProcess,
    );
    expect(decision.classification).toBe("never-authorized");
    expect(decision.action.kind).toBe("close-cancelled");
    expect(decision.reason).toContain("revokes");
  });

  test("a missing run row means nothing was launched", () => {
    const decision = classify({ kind: "absent" }, null);
    expect(decision.classification).toBe("never-authorized");
    expect(decision.action.kind).toBe("close-cancelled");
  });
});

/**
 * The cases that must *not* be decided. Each one is a way of learning the wrong
 * thing, and the honest answer to all of them is to keep the schedule occupied.
 */
describe("reconciliation stays uncertain rather than guessing", () => {
  test("an unreadable ledger decides nothing", () => {
    const decision = classify({ kind: "unreadable", reason: "the store file is missing" }, null);
    expect(decision.classification).toBe("uncertain");
    expect(decision.action.kind).toBe("stay-uncertain");
    expect(decision.reason).toContain("could not be read");
  });

  test("a runner that cannot be inspected is uncertain, not dead", () => {
    const decision = classify(found(), unknown);
    expect(decision.classification).toBe("uncertain");
    expect(decision.reason).toContain("could not be classified");
  });

  test("a reused pid is uncertain-free: an identity mismatch is definitive absence", () => {
    // The observation module already turned a start-identity mismatch into
    // `absent`, so the reducer sees a definitive answer rather than a guess.
    const reused: ProcessObservation = { kind: "absent", reason: "pid 4242 was reused by a different process" };
    expect(classify(found(), reused).classification).toBe("dead-without-result");
  });

  test("a consumed authorization with no recorded identity is uncertain", () => {
    const decision = classify(found({ runner: null }), null);
    expect(decision.classification).toBe("uncertain");
    expect(decision.reason).toContain("no runner identity");
  });

  test("a recorded identity that could not be observed is uncertain", () => {
    const decision = classify(found(), null);
    expect(decision.classification).toBe("uncertain");
    expect(decision.reason).toContain("could not be observed");
  });
});

describe("reconciliation is exhaustive over run statuses", () => {
  test("every non-running status either finalizes or closes with a result", () => {
    const statuses: ReadonlyArray<WorkflowRunStatus> = [
      "completed",
      "failed",
      "escalated",
      "stopped",
      "crashed",
      "unknown",
    ];
    for (const status of statuses) {
      const live = classify(found({ status }), sameProcess);
      const gone = classify(found({ status }), absent);
      // Never interrupted for a terminal ledger row: an outcome exists, even if
      // it is `unknown`, so there is nothing to mark as interrupted.
      expect(live.classification).not.toBe("dead-without-result");
      expect(gone.classification).not.toBe("dead-without-result");
      expect(["finalizing", "ended-with-result"]).toContain(live.classification);
      expect(["finalizing", "ended-with-result"]).toContain(gone.classification);
    }
  });

  test("only a running ledger row can be interrupted", () => {
    expect(classify(found({ status: "running" }), absent).classification).toBe("dead-without-result");
  });
});

/**
 * The execution's own status is bookkeeping; the run's evidence is authority.
 * A recovered execution in any occupying state must reconcile from evidence,
 * not from what the previous scheduler last managed to write about itself.
 */
describe("the execution's own status does not drive the decision", () => {
  test("the same evidence yields the same decision from reserved, running, and uncertain", () => {
    const decisions = (["reserved", "running", "uncertain"] as ReadonlyArray<ScheduleExecutionStatus>).map(
      (status) => classify(found(), absent, null, { status }),
    );
    expect(new Set(decisions.map((decision) => decision.classification))).toEqual(
      new Set(["dead-without-result"]),
    );
  });
});
