import { describe, expect, test } from "bun:test";
import { nextWorkflowCronOccurrence, parseWorkflowCron, WORKFLOW_CRON_FIELD_COUNT } from "./cron.js";
import { WorkflowScheduleError } from "./errors.js";

const next = (expression: string, timezone: string, from: string): string =>
  new Date(nextWorkflowCronOccurrence(parseWorkflowCron(expression, timezone), Date.parse(from))).toISOString();

const rejection = (expression: string, timezone: string): WorkflowScheduleError => {
  try {
    parseWorkflowCron(expression, timezone);
  } catch (error) {
    if (error instanceof WorkflowScheduleError) return error;
    throw error;
  }
  throw new Error(`expected ${expression} @ ${timezone} to be rejected`);
};

describe("workflow cron dialect", () => {
  test("accepts the documented five-field forms", () => {
    for (const expression of [
      "*/10 * * * *",
      "0 9 * * MON-FRI",
      "0 0-6/2 1,15 * *",
      "30 2 * * 7",
      "  0   9   *   *   *  ",
    ]) {
      expect(() => parseWorkflowCron(expression, "UTC")).not.toThrow();
    }
    expect(WORKFLOW_CRON_FIELD_COUNT).toBe(5);
  });

  test("rejects a six-field seconds-first expression rather than reinterpreting it", () => {
    // `Cron.parse` accepts six fields; Prism must not, or an expression copied
    // from a seconds-capable scheduler would silently mean something else.
    const error = rejection("0 */10 * * * *", "UTC");
    expect(error.field).toBe("cron");
    expect(error.message).toContain("6 fields");
    expect(error.hint).toContain("five fields");
  });

  test("rejects four fields, an empty expression, and unparseable text", () => {
    for (const expression of ["*/10 * * *", "", "   ", "nope", "*/10 * * * * * *"]) {
      expect(() => parseWorkflowCron(expression, "UTC")).toThrow(WorkflowScheduleError);
    }
  });

  test("rejects a fixed UTC offset, which cannot track daylight saving", () => {
    for (const timezone of ["+03:00", "-0800", "+3"]) {
      const error = rejection("*/10 * * * *", timezone);
      expect(error.field).toBe("timezone");
      expect(error.message).toContain("fixed UTC offset");
    }
  });

  test("rejects an unknown zone and accepts named IANA zones including DST-free ones", () => {
    expect(rejection("*/10 * * * *", "Not/AZone").field).toBe("timezone");
    for (const timezone of ["UTC", "America/Sao_Paulo", "Europe/London", "Etc/GMT+3"]) {
      expect(() => parseWorkflowCron("*/10 * * * *", timezone)).not.toThrow();
    }
  });
});

describe("workflow cron next-occurrence", () => {
  test("is strictly after its argument, so a consumed occurrence never re-yields", () => {
    const occurrence = "2026-09-16T12:10:00.000Z";
    expect(next("*/10 * * * *", "UTC", occurrence)).toBe("2026-09-16T12:20:00.000Z");
    expect(next("*/10 * * * *", "UTC", "2026-09-16T12:10:00.001Z")).toBe("2026-09-16T12:20:00.000Z");
    expect(next("*/10 * * * *", "UTC", "2026-09-16T12:09:59.999Z")).toBe(occurrence);
  });

  test("resolves the occurrence in the declared zone, not the machine's", () => {
    // 09:00 in São Paulo is 12:00Z; asking after 12:00Z must roll to tomorrow.
    expect(next("0 9 * * *", "America/Sao_Paulo", "2026-09-16T12:00:00Z")).toBe("2026-09-17T12:00:00.000Z");
    expect(next("0 9 * * *", "America/Sao_Paulo", "2026-09-16T11:59:59Z")).toBe("2026-09-16T12:00:00.000Z");
    // The same wall clock in UTC is a different instant: 11:59:59Z is already
    // past 09:00Z, so UTC rolls to tomorrow while São Paulo does not.
    expect(next("0 9 * * *", "UTC", "2026-09-16T11:59:59Z")).toBe("2026-09-17T09:00:00.000Z");
  });

  test("skips the weekend for a weekday schedule", () => {
    // Friday 2026-09-18T12:00Z -> Monday 2026-09-21T09:00Z.
    expect(next("0 9 * * MON-FRI", "UTC", "2026-09-18T12:00:00Z")).toBe("2026-09-21T09:00:00.000Z");
  });

  test("uses Vixie DOM/DOW OR semantics when both are restricted", () => {
    // 2026-09-01 is a Tuesday, so `1 * MON` fires on the 1st *and* on Mondays.
    expect(next("0 0 1 * MON", "UTC", "2026-09-01T00:00:00Z")).toBe("2026-09-07T00:00:00.000Z");
  });

  test("finds the next leap day rather than failing on an impossible date", () => {
    expect(next("0 0 29 2 *", "UTC", "2026-01-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
  });
});

/**
 * DST policy is inherited from `effect`'s `Cron`. These tests exist so the
 * policy is a pinned Prism contract rather than an accident of whichever
 * Effect release is installed: a wall-clock time inside a spring-forward gap
 * resolves to the first valid instant after the gap, and a time inside a
 * fall-back fold resolves to the **first** of the two occurrences.
 */
describe("workflow cron daylight-saving policy", () => {
  test("spring-forward gap resolves forward to the first valid local time", () => {
    // US: 2026-03-08 02:00 EST jumps to 03:00 EDT, so 02:30 does not exist.
    expect(next("30 2 * * *", "America/New_York", "2026-03-08T05:00:00Z")).toBe("2026-03-08T07:30:00.000Z");
    // UK: 2026-03-29 01:00 GMT jumps to 02:00 BST, so 01:30 does not exist.
    expect(next("30 1 * * *", "Europe/London", "2026-03-29T00:00:00Z")).toBe("2026-03-29T01:30:00.000Z");
  });

  test("fall-back fold resolves to the first of the two occurrences", () => {
    // US: 2026-11-01 01:30 occurs twice; 05:30Z is the EDT one.
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z")).toBe("2026-11-01T05:30:00.000Z");
    // UK: 2026-10-25 01:30 occurs twice; 00:30Z is the BST one.
    expect(next("30 1 * * *", "Europe/London", "2026-10-25T00:00:00Z")).toBe("2026-10-25T00:30:00.000Z");
  });

  test("a zone without daylight saving keeps a stable offset across the year", () => {
    // São Paulo abolished DST in 2019; every 09:00 local is 12:00Z.
    expect(next("0 9 * * *", "America/Sao_Paulo", "2026-01-15T00:00:00Z")).toBe("2026-01-15T12:00:00.000Z");
    expect(next("0 9 * * *", "America/Sao_Paulo", "2026-07-15T00:00:00Z")).toBe("2026-07-15T12:00:00.000Z");
  });
});
