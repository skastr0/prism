/**
 * The inert `schedule` declaration on a workflow definition.
 *
 * A workflow may declare how it wants to be scheduled; declaring it does
 * nothing. `defineWorkflow` records the policy on the definition object and
 * no more — importing, typechecking, validating, or running the file has no
 * scheduling side effect whatsoever. Registration happens only through
 * `prism workflow schedule install`, which reads the declaration back out of
 * the loaded definition. This split is what makes `install` the single
 * activation gate, and it is why a schedule edit requires a reinstall while a
 * task/prompt edit does not.
 *
 * **Only implemented policies are representable.** `overlap` and `missedRuns`
 * each admit exactly one value, so `overlap: "queue"` is a TypeScript error at
 * authoring time and a hard, self-explaining `WorkflowScheduleError` at the
 * cross-version boundary. AGENTS.md rule 6 forbids warnings, and rule 8 says a
 * type that needs a runtime membership check is lying — so the unions stay
 * closed rather than admitting a policy Prism does not implement.
 *
 * The two policies, stated precisely, because both names are easy to misread:
 *
 *   - `overlap: "skip"` — at most one unresolved execution per schedule. A due
 *     occurrence that arrives while the previous execution is still running,
 *     still reserving, or still *uncertain* is consumed as a skip and
 *     recorded; it is never queued and never run in parallel. A stranded
 *     execution cannot be cleared by a timeout, only by evidence.
 *   - `missedRuns: "skip"` — overdue occurrences are coalesced into at most one
 *     opportunity. A machine asleep for three hours produces one run on wake, not
 *     eighteen, and a scheduler restart behaves the same way rather than silently
 *     swallowing an occurrence. Nothing accumulates: the cursor advances whether
 *     or not the run succeeds, so a crash-loop fires at most once per occurrence.
 */

import { parseWorkflowCron } from "./cron.js";
import { WorkflowScheduleError } from "./errors.js";

/** Policies Prism implements for a due occurrence that overlaps a live execution. */
export const WORKFLOW_SCHEDULE_OVERLAP_POLICIES = ["skip"] as const;
export type WorkflowScheduleOverlap = (typeof WORKFLOW_SCHEDULE_OVERLAP_POLICIES)[number];

/** Policies Prism implements for occurrences that passed while nothing was watching. */
export const WORKFLOW_SCHEDULE_MISSED_RUN_POLICIES = ["skip"] as const;
export type WorkflowScheduleMissedRuns = (typeof WORKFLOW_SCHEDULE_MISSED_RUN_POLICIES)[number];

export interface WorkflowSchedule {
  /** Five-field cron: `minute hour day-of-month month day-of-week`. */
  readonly cron: string;
  /** A named IANA timezone. Fixed UTC offsets are rejected; see `cron.ts`. */
  readonly timezone: string;
  readonly overlap: WorkflowScheduleOverlap;
  readonly missedRuns: WorkflowScheduleMissedRuns;
}

/** The complete key set. An unrecognized key is an error, not an ignored field. */
export const WORKFLOW_SCHEDULE_KEYS: ReadonlyArray<keyof WorkflowSchedule> = [
  "cron",
  "timezone",
  "overlap",
  "missedRuns",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scheduleError = (message: string, field: string, hint: string): WorkflowScheduleError =>
  new WorkflowScheduleError({ message, field, hint });

/**
 * Validate an already-loaded `schedule` value and return it typed.
 *
 * Used twice on purpose: `defineWorkflow` calls it so an authoring mistake
 * fails at import with the file in front of the author, and
 * `prism workflow schedule install` calls it again because an installed
 * schedule is data that crossed a boundary (a hand-written object, or a
 * definition produced by a different Prism version) and must not be trusted
 * just because some other layer once checked it.
 */
export const parseWorkflowSchedule = (value: unknown): WorkflowSchedule => {
  if (!isRecord(value)) {
    throw scheduleError(
      `workflow schedule must be an object with ${WORKFLOW_SCHEDULE_KEYS.join(", ")}`,
      "schedule",
      `declare schedule: { cron: "*/10 * * * *", timezone: "<IANA zone>", overlap: "skip", missedRuns: "skip" }`,
    );
  }

  for (const key of Object.keys(value)) {
    if (!(WORKFLOW_SCHEDULE_KEYS as ReadonlyArray<string>).includes(key)) {
      throw scheduleError(
        `workflow schedule has unknown key '${key}'`,
        key,
        `remove it; Prism schedules accept exactly ${WORKFLOW_SCHEDULE_KEYS.join(", ")}`,
      );
    }
  }

  const cron = value.cron;
  if (typeof cron !== "string" || cron.trim().length === 0) {
    throw scheduleError(
      "workflow schedule requires a non-empty string 'cron'",
      "cron",
      "write five fields, for example '*/10 * * * *' for every ten minutes",
    );
  }

  const timezone = value.timezone;
  if (typeof timezone !== "string" || timezone.trim().length === 0) {
    throw scheduleError(
      "workflow schedule requires a non-empty string 'timezone'",
      "timezone",
      "name an IANA zone, for example 'America/Sao_Paulo' or 'UTC'",
    );
  }

  const overlap = value.overlap;
  if (overlap !== "skip") {
    throw scheduleError(
      `workflow schedule overlap '${String(overlap)}' is not implemented`,
      "overlap",
      `use overlap: "skip" — the only policy Prism implements today`,
    );
  }

  const missedRuns = value.missedRuns;
  if (missedRuns !== "skip") {
    throw scheduleError(
      `workflow schedule missedRuns '${String(missedRuns)}' is not implemented`,
      "missedRuns",
      `use missedRuns: "skip" — the only policy Prism implements today`,
    );
  }

  // Dialect validation last, so a shape error is reported before a dialect
  // error and the author fixes the object before the expression.
  parseWorkflowCron(cron, timezone);

  return { cron, timezone, overlap, missedRuns };
};

/** Non-throwing form for the `isWorkflowDefinition` type guard. */
export const isWorkflowSchedule = (value: unknown): value is WorkflowSchedule => {
  try {
    parseWorkflowSchedule(value);
    return true;
  } catch {
    return false;
  }
};
