/**
 * Reconciliation: deciding what became of an execution the scheduler is no
 * longer watching.
 *
 * This module is a **pure reducer**. It reads no clock, opens no database, and
 * touches no process; it turns durable evidence plus a process observation into
 * a decision. Everything that could be flaky is injected, which is what makes
 * the interesting cases — a reused pid, an unreadable ledger, a worker that died
 * mid-run — testable as table entries rather than as races.
 *
 * The evidence is deliberately narrow and each part is load-bearing:
 *
 *   - **Run evidence** from the project ledger. `launchAuthorized` is the
 *     strongest fact available: the runner consumes its authorization in the
 *     same transaction that records its identity, so an unconsumed
 *     authorization *proves* no workflow code ran.
 *   - **Process observation** of the runner's recorded identity, which is a
 *     triple (pid, boot, start) rather than a pid — see `process-identity.ts`.
 *
 * Four outcomes are possible, and the fourth is not a failure to decide:
 *
 * | Evidence | Classification | Action |
 * |---|---|---|
 * | Recorded runner demonstrably present | `alive` | Keep the schedule occupied and adopt monitoring. A stale heartbeat is degraded, not dead. |
 * | Durable outcome, runner still present | `finalizing` | Keep occupied; the runner is finishing its own cleanup. |
 * | Durable outcome, runner gone | `ended-with-result` | Reconcile the outcome and close. |
 * | Runner demonstrably gone, no outcome | `dead-without-result` | Close as interrupted. **Never replayed.** |
 * | Authorization never consumed | `never-authorized` | Close as cancelled. |
 * | Anything else | `uncertain` | Keep occupied, record why, re-probe. |
 *
 * Two decisions are worth stating outright, because the obvious alternative is
 * wrong:
 *
 * **Cancelling is safe, and it is a revocation.** The runner's claim requires
 * the run to still be `running` *and* the authorization token to match, in one
 * compare-and-set transaction. So closing a never-authorized run as cancelled
 * makes a late-arriving child's claim fail before it can import user code. If
 * the child claims first, the cancel's own `where status = 'running'` guard
 * fails and nothing is written — one of the two wins, and the caller re-reads.
 * That is why a never-authorized execution does not have to sit in `uncertain`
 * forever: there is no race to lose.
 *
 * **Lease expiry is never evidence.** A quiet heartbeat means unhealthy. The
 * only things that establish death are an authoritative absence or a verified
 * identity mismatch. A decision that cannot be reached honestly stays
 * `uncertain`, and the schedule stays occupied.
 */

import type { WorkflowScheduledRunState } from "../workflow-store.js";
import type { ProcessObservation } from "./process-identity.js";
import type { ScheduleExecutionRecord } from "./store.js";

/** What the project ledger says about the execution's run. */
export type ScheduledRunEvidence =
  | { readonly kind: "found"; readonly run: WorkflowScheduledRunState }
  /** The ledger was read and has no such run. */
  | { readonly kind: "absent" }
  /** The ledger could not be read, so nothing can be concluded from it. */
  | { readonly kind: "unreadable"; readonly reason: string };

export type ReconciliationClassification =
  | "alive"
  | "finalizing"
  | "ended-with-result"
  | "dead-without-result"
  | "never-authorized"
  | "uncertain";

export type ReconciliationAction =
  /** Keep the schedule occupied and monitor the adopted runner. */
  | { readonly kind: "adopt" }
  /** Keep the schedule occupied; the runner is finishing its own cleanup. */
  | { readonly kind: "await-finalization" }
  /** Close with the durable outcome the runner recorded. */
  | { readonly kind: "close-with-result" }
  /** Close as interrupted, and terminalize the ledger run as crashed. */
  | { readonly kind: "close-interrupted"; readonly reason: string }
  /** Revoke the authorization and close as cancelled. */
  | { readonly kind: "close-cancelled"; readonly reason: string }
  /** Keep occupied, record the reason, and re-probe on a later pass. */
  | { readonly kind: "stay-uncertain"; readonly reason: string };

export interface ReconciliationDecision {
  readonly classification: ReconciliationClassification;
  readonly action: ReconciliationAction;
  /** One sentence, recorded on the execution and in the event stream. */
  readonly reason: string;
}

export interface ReconciliationInput {
  readonly execution: ScheduleExecutionRecord;
  readonly run: ScheduledRunEvidence;
  /**
   * Observation of the identity the runner recorded for itself. `null` only
   * when the run recorded no identity.
   */
  readonly runnerObservation: ProcessObservation | null;
  /**
   * Observation of the pid the scheduler recorded when it spawned, used only to
   * describe an unauthorized execution accurately. `null` when the scheduler
   * died before recording one.
   */
  readonly childObservation: ProcessObservation | null;
}

const alive = (reason: string): ReconciliationDecision => ({
  classification: "alive",
  action: { kind: "adopt" },
  reason,
});

const uncertain = (reason: string): ReconciliationDecision => ({
  classification: "uncertain",
  action: { kind: "stay-uncertain", reason },
  reason,
});

/**
 * Decide what an occupying execution's evidence means.
 *
 * The order of the checks is the argument: authorization is checked before
 * liveness, because "no runner ever claimed this" is provable and settles the
 * question regardless of what any process is doing.
 */
export const reconcileExecution = (input: ReconciliationInput): ReconciliationDecision => {
  const { execution, run } = input;

  if (run.kind === "unreadable") {
    return uncertain(`the run ledger could not be read (${run.reason})`);
  }

  if (run.kind === "absent") {
    // The scheduler creates the run before it spawns anything, so a missing run
    // row means the launch never got as far as a process.
    return {
      classification: "never-authorized",
      action: {
        kind: "close-cancelled",
        reason: "no run was ever created for this execution, so nothing was launched",
      },
      reason: "no run was ever created for this execution, so nothing was launched",
    };
  }

  const state = run.run;

  if (!state.launchAuthorized) {
    const childAlive = input.childObservation?.kind === "same-process";
    const reason = childAlive
      ? "the launch authorization was never consumed; a child process is still present, and cancelling revokes its authorization"
      : "the launch authorization was never consumed, so no workflow code ran";
    return {
      classification: "never-authorized",
      action: { kind: "close-cancelled", reason },
      reason,
    };
  }

  if (state.runner === null) {
    // beginScheduledRun writes the identity in the same transaction that
    // consumes the authorization, so this is not reachable through the normal
    // protocol. It is treated as unknown rather than as anything stronger.
    return uncertain("the launch authorization was consumed but the run recorded no runner identity");
  }

  const observation = input.runnerObservation;
  if (observation === null) {
    return uncertain("the run recorded a runner identity that could not be observed");
  }

  if (state.status !== "running") {
    // A scheduled run is never terminalized by an observer — `failDeadPidRuns`
    // and `failStaleRuns` skip it — so a terminal status here was written by
    // the runner itself and the outcome is durable.
    if (observation.kind === "same-process") {
      return {
        classification: "finalizing",
        action: { kind: "await-finalization" },
        reason: `the run reached '${state.status}' and its runner is still finalizing`,
      };
    }
    return {
      classification: "ended-with-result",
      action: { kind: "close-with-result" },
      reason: `the run reached '${state.status}' and its runner is no longer present`,
    };
  }

  switch (observation.kind) {
    case "same-process":
      return alive(
        `the recorded runner for run ${state.runId} is still running (execution ${execution.executionId})`,
      );
    case "absent":
      return {
        classification: "dead-without-result",
        action: {
          kind: "close-interrupted",
          reason: `the recorded runner is gone and the run recorded no outcome (${observation.reason})`,
        },
        reason: `the recorded runner is gone and the run recorded no outcome (${observation.reason})`,
      };
    case "unknown":
      return uncertain(`the recorded runner could not be classified (${observation.reason})`);
  }
};
