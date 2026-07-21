import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKFLOW_RETENTION_DAYS,
  DEFAULT_WORKFLOW_RETENTION_AGE,
  DEFAULT_WORKFLOW_RETENTION_MS,
  addWorkflowRunArtifactCounts,
  emptyWorkflowRunArtifactCounts,
  parseWorkflowRetentionAge,
  workflowRetentionCutoff,
} from "./workflow-data-governance.js";

describe("workflow ledger retention policy", () => {
  test("defines one bounded 30-day production default", () => {
    expect(DEFAULT_WORKFLOW_RETENTION_DAYS).toBe(30);
    expect(DEFAULT_WORKFLOW_RETENTION_AGE).toBe("30d");
    expect(DEFAULT_WORKFLOW_RETENTION_MS).toBe(2_592_000_000);
  });

  test("parses explicit minute, hour, and day cleanup ages", () => {
    expect(parseWorkflowRetentionAge("30m")).toBe(1_800_000);
    expect(parseWorkflowRetentionAge("24h")).toBe(86_400_000);
    expect(parseWorkflowRetentionAge("30d")).toBe(DEFAULT_WORKFLOW_RETENTION_MS);
  });

  test.each(["", "0d", "-1d", "1.5d", "30", "forever"])(
    "rejects invalid cleanup duration %p",
    (value) => {
      expect(() => parseWorkflowRetentionAge(value)).toThrow("positive duration");
    },
  );

  test("computes a deterministic cutoff from the provided clock", () => {
    expect(workflowRetentionCutoff(
      24 * 60 * 60 * 1_000,
      new Date("2026-07-21T12:00:00.000Z"),
    ).toISOString()).toBe("2026-07-20T12:00:00.000Z");
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid cleanup age %p",
    (olderThanMs) => {
      expect(() => workflowRetentionCutoff(olderThanMs)).toThrow(
        "positive integer number of milliseconds",
      );
    },
  );

  test("adds exact per-table deletion counts", () => {
    expect(addWorkflowRunArtifactCounts(emptyWorkflowRunArtifactCounts(), {
      runs: 1,
      tasks: 2,
      attempts: 3,
      events: 4,
      spans: 5,
      runSnapshots: 1,
      taskSnapshots: 2,
    })).toEqual({
      runs: 1,
      tasks: 2,
      attempts: 3,
      events: 4,
      spans: 5,
      runSnapshots: 1,
      taskSnapshots: 2,
    });
  });
});
