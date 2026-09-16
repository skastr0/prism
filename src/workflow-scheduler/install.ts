/**
 * Schedule installation and reporting.
 *
 * `install` is the single activation gate. A workflow's `schedule` declaration
 * is inert, and this is the only thing that turns one into a registered
 * schedule — which is why a task or prompt edit takes effect on the next run
 * with no reinstall, while a schedule edit requires one.
 *
 * Installation deliberately does **not** use `validateWorkflowFile`. That
 * function probes a dynamic workflow by running it with `wf.runTask` mocked, so
 * installing would execute the author's `run` program and any effects it
 * performs before the first task. Loading the module is unavoidable — the
 * declaration lives in it — so installation is honest about its boundary:
 * Prism promises that *declaring* a schedule registers nothing and that
 * *installing* never runs `run`. It does not claim that importing an arbitrary
 * TypeScript module is free of top-level side effects, because it is not.
 */

import { expandPath } from "../fs.js";
import { loadWorkflowFile } from "../workflow-loader.js";
import { nextWorkflowCronOccurrence, parseWorkflowCron } from "./cron.js";
import { WorkflowScheduleInstallError } from "./errors.js";
import { parseWorkflowSchedule } from "./schedule.js";
import {
  SchedulerStore,
  schedulerStorePath,
  type ScheduleExecutionRecord,
  type WorkflowScheduleRecord,
} from "./store.js";

export interface WorkflowScheduleSummary {
  readonly schedule: WorkflowScheduleRecord;
  /** The execution currently holding the schedule's slot, if any. */
  readonly occupying: ScheduleExecutionRecord | null;
  /** The most recent execution, whatever its outcome. */
  readonly lastExecution: ScheduleExecutionRecord | null;
}

export interface InstallWorkflowScheduleInput {
  readonly prismHome: string;
  readonly workflowFile: string;
  readonly cwd?: string;
  readonly storePath: string;
  readonly worker?: string;
  readonly model?: string;
  readonly permission?: string;
  /**
   * Mock outputs for a rehearsal run. Scheduling does not cap spend — that is
   * the whole doctrine in docs/workflows.md — so the way to try a schedule
   * without dispatching real work is the same way you try any workflow:
   * `--mock-output`, carried on the schedule so a scheduled run can use it.
   */
  readonly mockOutput?: string;
  /** The clock to compute the first occurrence from. */
  readonly now?: number;
}

export interface InstallWorkflowScheduleResult {
  readonly kind: "installed" | "unchanged";
  readonly schedule: WorkflowScheduleRecord;
}

export const installWorkflowSchedule = async (
  input: InstallWorkflowScheduleInput,
): Promise<InstallWorkflowScheduleResult> => {
  const workflowFile = expandPath(input.workflowFile);
  const workflow = await loadWorkflowFile(workflowFile);

  if (workflow.schedule === undefined) {
    throw new WorkflowScheduleInstallError({
      message: `workflow '${workflow.name}' declares no schedule, so there is nothing to install`,
      hint: `add schedule: { cron: "*/10 * * * *", timezone: "<IANA zone>", overlap: "skip", missedRuns: "skip" } to ${workflowFile}`,
    });
  }

  // Re-validated here even though defineWorkflow already checked it: an
  // installed schedule is boundary data, and the loaded definition is not
  // guaranteed to have come through this process's own type surface.
  const schedule = parseWorkflowSchedule(workflow.schedule);
  const parsed = parseWorkflowCron(schedule.cron, schedule.timezone);
  const now = input.now ?? Date.now();
  const nextDueAt = new Date(nextWorkflowCronOccurrence(parsed, now)).toISOString();

  const options: Record<string, unknown> = {
    ...(input.worker !== undefined ? { worker: input.worker } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.permission !== undefined ? { permission: input.permission } : {}),
    ...(input.mockOutput !== undefined ? { mockOutput: expandPath(input.mockOutput) } : {}),
  };

  const store = await SchedulerStore.open(schedulerStorePath(input.prismHome));
  try {
    const result = store.upsertSchedule({
      name: workflow.name,
      workflowFile,
      cwd: expandPath(input.cwd ?? process.cwd()),
      storePath: expandPath(input.storePath),
      cron: schedule.cron,
      timezone: schedule.timezone,
      overlap: schedule.overlap,
      missedRuns: schedule.missedRuns,
      options,
      nextDueAt,
    });
    return { kind: result.kind, schedule: result.schedule };
  } finally {
    store.close();
  }
};

export const summarizeSchedules = (store: SchedulerStore): ReadonlyArray<WorkflowScheduleSummary> =>
  store.listSchedules().map((schedule) => ({
    schedule,
    occupying: store.occupyingExecution(schedule.scheduleId),
    lastExecution: store.listExecutions(schedule.scheduleId, 1)[0] ?? null,
  }));

/** One-line outcome for an execution, for tables and `show`. */
export const describeExecutionOutcome = (execution: ScheduleExecutionRecord | null): string => {
  if (execution === null) return "never";
  const cause = execution.cause as { readonly reason?: unknown } | null;
  const reason = typeof cause?.reason === "string" ? ` — ${cause.reason}` : "";
  return `${execution.status}${reason}`;
};

const pad = (rows: ReadonlyArray<ReadonlyArray<string>>, header: ReadonlyArray<string>): string => {
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const format = (cells: ReadonlyArray<string>): string =>
    cells.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ");
  return [format(header), format(widths.map((width) => "-".repeat(width))), ...rows.map(format)].join("\n");
};

/** Compact local time in the schedule's own zone, so the table reads as authored. */
const localTime = (iso: string | null, timezone: string): string => {
  if (iso === null) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const renderScheduleListHuman = (
  summaries: ReadonlyArray<WorkflowScheduleSummary>,
): string => {
  if (summaries.length === 0) {
    return "No schedules installed. Install one with `prism workflow schedule install <file>`.";
  }
  const rows = summaries.map((summary) => [
    summary.schedule.name,
    summary.schedule.enabled ? "enabled" : "disabled",
    `${summary.schedule.cron} ${summary.schedule.timezone}`,
    localTime(summary.schedule.nextDueAt, summary.schedule.timezone),
    summary.occupying === null ? "-" : summary.occupying.status,
    describeExecutionOutcome(summary.lastExecution),
    summary.schedule.scheduleId.slice(0, 8),
  ]);
  return pad(rows, ["name", "state", "schedule", "next", "active", "last", "id"]);
};

export const renderScheduleShowHuman = (
  summary: WorkflowScheduleSummary,
  executions: ReadonlyArray<ScheduleExecutionRecord>,
): string => {
  const { schedule } = summary;
  const lines = [
    `${schedule.name}  (${schedule.enabled ? "enabled" : "disabled"})`,
    `  id          ${schedule.scheduleId}`,
    `  workflow    ${schedule.workflowFile}`,
    `  cwd         ${schedule.cwd}`,
    `  store       ${schedule.storePath}`,
    `  schedule    ${schedule.cron}  ${schedule.timezone}`,
    `  policies    overlap=${schedule.overlap}  missedRuns=${schedule.missedRuns}`,
    `  revision    ${schedule.revision}`,
    `  next due    ${localTime(schedule.nextDueAt, schedule.timezone)}`,
    `  active      ${summary.occupying === null ? "none" : summary.occupying.status}`,
  ];
  if (executions.length === 0) {
    lines.push("", "No executions recorded yet.");
    return lines.join("\n");
  }
  lines.push("", "Recent executions:");
  lines.push(
    pad(
      executions.map((execution) => [
        localTime(execution.startedAt, schedule.timezone),
        execution.status,
        execution.scheduledFor === null ? "-" : localTime(execution.scheduledFor, schedule.timezone),
        execution.observedExitCode === null ? "-" : String(execution.observedExitCode),
        describeExecutionOutcome(execution),
      ]),
      ["started", "status", "for", "exit", "cause"],
    ),
  );
  return lines.join("\n");
};
