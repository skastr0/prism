/**
 * Scheduler status reporting.
 *
 * Two independent questions, deliberately answered separately:
 *
 *   1. **Is a scheduler running?** Answered by trying to take the instance lock
 *      and by observing the recorded instance's process identity. Lock occupancy
 *      and record freshness are different facts: "lock held, metadata stale" is
 *      not healthy, and "no lock, stale record" is a crashed scheduler, not a
 *      running one.
 *   2. **What is each schedule doing?** Answered from the store: next due, the
 *      execution holding the slot, and the last outcome.
 *
 * There is no aggregate "health" boolean. A single green light over a set of
 * independent facts is how a degraded scheduler looks healthy, and this feature's
 * whole premise is that degradation must be visible.
 */

import { join } from "node:path";
import { observeProcessIdentity, type ProcessObservation } from "./process-identity.js";
import { summarizeSchedules, type WorkflowScheduleSummary } from "./install.js";
import { SchedulerStore, schedulerLockPath, type SchedulerInstanceRecord } from "./store.js";

export interface SchedulerStatusReport {
  /** `true`/`false` from an actual lock attempt; `null` when it could not be determined. */
  readonly lockHeld: boolean | null;
  /** The most recent instance record, whatever its state. */
  readonly instance: SchedulerInstanceRecord | null;
  /** Observation of that instance's process, when it recorded an identity. */
  readonly instanceObservation: ProcessObservation | null;
  readonly schedules: ReadonlyArray<WorkflowScheduleSummary>;
}

export type SchedulerInstanceState = "running" | "stopped" | "crashed" | "unknown";

/**
 * Classify the recorded instance.
 *
 * `unknown` is a real answer, not a fallback: an instance that recorded no
 * process identity, or whose identity cannot be probed, is not something Prism
 * can call running or crashed.
 */
export const classifyInstance = (
  instance: SchedulerInstanceRecord | null,
  observation: ProcessObservation | null,
): SchedulerInstanceState => {
  if (instance === null) return "stopped";
  if (instance.closedAt !== null) return "stopped";
  if (instance.pid === undefined) return "unknown";
  if (observation === null) return "unknown";
  if (observation.kind === "same-process") return "running";
  if (observation.kind === "absent") return "crashed";
  return "unknown";
};

export const readSchedulerStatus = async (input: {
  readonly prismHome: string;
  readonly lockHeld: boolean | null;
}): Promise<SchedulerStatusReport> => {
  const store = await SchedulerStore.open(join(input.prismHome, "state", "workflow-scheduler.sqlite"));
  try {
    const instances = store.listInstances();
    const instance = instances[0] ?? null;
    const observation =
      instance === null
        ? null
        : observeProcessIdentity({ pid: instance.pid, bootId: instance.bootId, startId: instance.startId });
    return {
      lockHeld: input.lockHeld,
      instance,
      instanceObservation: observation,
      schedules: summarizeSchedules(store),
    };
  } finally {
    store.close();
  }
};

export { schedulerLockPath };

const pad = (rows: ReadonlyArray<ReadonlyArray<string>>, header: ReadonlyArray<string>): string => {
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const format = (cells: ReadonlyArray<string>): string =>
    cells.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ");
  return [format(header), format(widths.map((width) => "-".repeat(width))), ...rows.map(format)].join("\n");
};

/**
 * Relative time in either direction.
 *
 * A "next due" value is in the future and a heartbeat is in the past, so a
 * one-directional age would render an upcoming occurrence as a negative number
 * of seconds ago — which reads as a bug in the schedule rather than as a time.
 */
const relativeTime = (iso: string | null): string => {
  if (iso === null) return "never";
  const deltaMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(deltaMs)) return iso;
  const magnitude = Math.abs(deltaMs);
  const seconds = Math.round(magnitude / 1000);
  const unit = seconds < 60
    ? `${seconds}s`
    : seconds < 3_600
      ? `${Math.round(seconds / 60)}m`
      : `${Math.round(seconds / 3_600)}h`;
  return deltaMs >= 0 ? `${unit} ago` : `in ${unit}`;
};

export const renderSchedulerStatusHuman = (report: SchedulerStatusReport): string => {
  const state = classifyInstance(report.instance, report.instanceObservation);
  const lines: string[] = [];

  lines.push(`Scheduler: ${state}`);
  lines.push(`  instance lock   ${report.lockHeld === null ? "unknown" : report.lockHeld ? "held" : "free"}`);
  if (report.instance === null) {
    lines.push("  instance        none recorded");
  } else {
    lines.push(`  instance id     ${report.instance.instanceId}`);
    lines.push(`  mode            ${report.instance.mode}`);
    lines.push(`  pid             ${report.instance.pid}`);
    lines.push(`  version         ${report.instance.version}`);
    lines.push(`  heartbeat       ${relativeTime(report.instance.heartbeatAt)}`);
    lines.push(`  closed          ${report.instance.closedAt === null ? "no" : report.instance.closedAt}`);
    if (report.instance.lastFatalCause !== null) {
      lines.push(`  last fatal      ${report.instance.lastFatalCause}`);
    }
    if (report.instanceObservation !== null && report.instanceObservation.kind !== "same-process") {
      lines.push(`  process         ${report.instanceObservation.kind}: ${report.instanceObservation.reason}`);
    }
  }

  lines.push("", "Schedules:");
  if (report.schedules.length === 0) {
    lines.push("  none installed");
    return lines.join("\n");
  }
  lines.push(
    pad(
      report.schedules.map((summary) => [
        summary.schedule.name,
        summary.schedule.enabled ? "enabled" : "disabled",
        summary.schedule.nextDueAt === null ? "-" : relativeTime(summary.schedule.nextDueAt),
        summary.occupying === null ? "-" : summary.occupying.status,
        summary.lastExecution === null ? "never" : summary.lastExecution.status,
        summary.occupying === null && summary.lastExecution?.status === "uncertain" ? "DEGRADED" : "",
      ]),
      ["name", "state", "next due", "active", "last", "note"],
    ),
  );
  return lines.join("\n");
};
