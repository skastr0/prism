/**
 * Scheduler error vocabulary.
 *
 * These are `Schema.TaggedError`s rather than plain `Error`s for two reasons:
 * every one of them is both a typed Effect failure *and* a durable record (a
 * scheduler event, an execution's `cause_json`), and `message` is an explicit
 * schema field so the rendered headline survives a round trip through SQLite.
 * `Schema.TaggedError`'s optional third-argument message function is not used
 * because it does not take effect in this Effect release; carrying `message`
 * as a field keeps the rendered text identical before and after persistence.
 *
 * `hint` is required, never optional: AGENTS.md rule 6 forbids warnings, so a
 * failure that cannot name its own remediation does not belong here.
 */

import { Schema } from "effect";

/** A declared schedule that Prism cannot accept. `field` is the offending key. */
export class WorkflowScheduleError extends Schema.TaggedError<WorkflowScheduleError>()(
  "WorkflowScheduleError",
  {
    message: Schema.String,
    field: Schema.String,
    hint: Schema.String,
  },
) {}

/** A schedule installation or lifecycle operation Prism refuses to perform. */
export class WorkflowScheduleInstallError extends Schema.TaggedError<WorkflowScheduleInstallError>()(
  "WorkflowScheduleInstallError",
  {
    message: Schema.String,
    hint: Schema.String,
  },
) {}

/** The scheduler store could not be opened, migrated, or read as expected. */
export class SchedulerStoreError extends Schema.TaggedError<SchedulerStoreError>()(
  "SchedulerStoreError",
  {
    message: Schema.String,
    hint: Schema.String,
    path: Schema.String,
  },
) {}

/** Another scheduler instance holds the machine-wide instance lock. */
export class SchedulerAlreadyRunningError extends Schema.TaggedError<SchedulerAlreadyRunningError>()(
  "SchedulerAlreadyRunningError",
  {
    message: Schema.String,
    hint: Schema.String,
    holderInstanceId: Schema.NullOr(Schema.String),
    holderPid: Schema.NullOr(Schema.Number),
  },
) {}

/** A worker process could not be launched, or its launch could not be authorized. */
export class SchedulerLaunchError extends Schema.TaggedError<SchedulerLaunchError>()(
  "SchedulerLaunchError",
  {
    message: Schema.String,
    hint: Schema.String,
    executionId: Schema.String,
  },
) {}

/**
 * The scheduler loop itself hit an unrecoverable defect. The owner's contract
 * is explicit that a scheduler defect must surface and end the process so the
 * service manager restarts it — never be swallowed into an endlessly
 * "healthy"-looking loop.
 */
export class SchedulerFatalError extends Schema.TaggedError<SchedulerFatalError>()(
  "SchedulerFatalError",
  {
    message: Schema.String,
    hint: Schema.String,
  },
) {}

export type SchedulerError =
  | WorkflowScheduleError
  | WorkflowScheduleInstallError
  | SchedulerStoreError
  | SchedulerAlreadyRunningError
  | SchedulerLaunchError
  | SchedulerFatalError;

/** One-line headline plus a `hint:` line — the repo's human error shape. */
export const renderSchedulerError = (error: SchedulerError): string => {
  const lines = [error.message];
  if ("path" in error && typeof error.path === "string" && error.path.length > 0) {
    lines.push(`  at ${error.path}`);
  }
  lines.push(`  hint: ${error.hint}`);
  return lines.join("\n");
};
