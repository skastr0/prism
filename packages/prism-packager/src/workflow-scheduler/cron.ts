/**
 * Effect's `Cron` module, narrowed to Prism's scheduling dialect.
 *
 * Prism ships no cron parser. `effect`'s `Cron` already implements the
 * five-field dialect Prism documents — names, ranges, steps, lists, Vixie
 * DOM/DOW OR semantics, named timezones, and DST resolution — and it is
 * already a Prism-owned dependency pinned to one exact release by
 * `scripts/effect-version-guard.ts`. Re-deriving a parser here would be a
 * second implementation of the same contract, which AGENTS.md rule 3 forbids.
 *
 * This module is the adapter that *pins the dialect Prism accepts*, so the
 * accepted language lives in one place instead of being whatever the
 * dependency happens to accept today. Two deliberate narrowings, both
 * fail-closed:
 *
 *   - **Exactly five fields.** `Cron.parse` also accepts a six-field,
 *     seconds-first form. A six-field expression is rejected so an expression
 *     copied from a seconds-capable scheduler cannot silently mean something
 *     else than it reads.
 *   - **Named timezones only.** `Cron.parse` accepts fixed offsets such as
 *     `+03:00`. A fixed offset is not DST-aware, so a schedule declared with
 *     one drifts by an hour at a transition. A named IANA zone — including the
 *     DST-free `Etc/GMT+3` — is required.
 *
 * DST policy is inherited from `effect`'s `Cron` and pinned by `cron.test.ts`:
 * a wall-clock time inside a spring-forward gap resolves to the first valid
 * instant after the gap, and a time inside a fall-back fold resolves to the
 * **first** of the two occurrences. That is a documented policy, not an
 * accident of the dependency, so the tests assert it rather than assume it.
 *
 * Only `next` is exposed. Prism never asks "what was the previous occurrence?"
 * because the durable cursor is the schedule row's `next_due_at` — see
 * `docs/workflow-scheduling.md`. `Cron.prev` is also subtly exclusive at exact
 * minute boundaries, which makes it the wrong primitive for "the occurrence
 * that is due now".
 */

import { Cron, Result } from "effect";
import { WorkflowScheduleError } from "./errors.js";

/** The field count Prism accepts. Six-field (seconds-first) expressions are rejected. */
export const WORKFLOW_CRON_FIELD_COUNT = 5;

/**
 * A fixed-offset timezone such as `+03:00`, `-0800`, or `+3`. No IANA zone
 * name begins with `+` or `-`, so the leading sign is the whole test — and it
 * catches the forms `Cron` and `Intl` happen to reject too, which keeps the
 * diagnostic identical for every offset spelling instead of leaking a
 * dependency's parse failure for the ones they dislike.
 */
const FIXED_OFFSET_TIMEZONE = /^[+-]/u;

export interface ParsedWorkflowCron {
  readonly expression: string;
  readonly timezone: string;
  /** The parsed `effect` `Cron`, ready for `Cron.next`. */
  readonly cron: Cron.Cron;
}

const scheduleError = (
  message: string,
  field: string,
  hint: string,
): WorkflowScheduleError => new WorkflowScheduleError({ message, field, hint });

/**
 * Validate a cron expression + timezone pair, returning the parsed schedule.
 *
 * Throws `WorkflowScheduleError` — never a bare string or a dependency's error
 * type — so every rejection carries the field, a headline, and the exact fix.
 */
export const parseWorkflowCron = (expression: string, timezone: string): ParsedWorkflowCron => {
  const fields = expression.trim().split(/\s+/u).filter((field) => field.length > 0);
  if (fields.length !== WORKFLOW_CRON_FIELD_COUNT) {
    throw scheduleError(
      `cron expression '${expression}' has ${fields.length} field${fields.length === 1 ? "" : "s"}; Prism schedules take exactly ${WORKFLOW_CRON_FIELD_COUNT} (minute hour day-of-month month day-of-week)`,
      "cron",
      "write five fields, for example '*/10 * * * *' for every ten minutes",
    );
  }

  if (FIXED_OFFSET_TIMEZONE.test(timezone.trim())) {
    throw scheduleError(
      `timezone '${timezone}' is a fixed UTC offset, which cannot track daylight saving`,
      "timezone",
      "name an IANA zone instead, for example 'America/Sao_Paulo' or 'UTC'",
    );
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw scheduleError(
      `timezone '${timezone}' is not a recognized IANA time zone`,
      "timezone",
      "use a name from the IANA database, for example 'America/Sao_Paulo' or 'UTC'",
    );
  }

  const parsed = Cron.parse(expression, timezone);
  if (Result.isFailure(parsed)) {
    throw scheduleError(
      `cron expression '${expression}' is not valid for timezone '${timezone}'`,
      "cron",
      "use five fields of 'minute hour day-of-month month day-of-week', for example '0 9 * * MON-FRI'",
    );
  }

  return { expression, timezone, cron: parsed.success };
};

/**
 * The first occurrence strictly after `afterMs`.
 *
 * `Cron.next` is exclusive of its argument, which is what the tick algorithm
 * needs: advancing the cursor from a consumed occurrence must never re-yield
 * that same occurrence.
 */
export const nextWorkflowCronOccurrence = (
  schedule: ParsedWorkflowCron,
  afterMs: number,
): number => Cron.next(schedule.cron, afterMs).getTime();
