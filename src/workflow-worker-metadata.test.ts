import { describe, expect, test } from "bun:test";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";

describe("workflow worker metadata", () => {
  test("omits empty stderr metadata", () => {
    expect(summarizeWorkflowWorkerStderr("\n\t ")).toEqual({});
  });

  test("summarizes short stderr without truncation", () => {
    const metadata = summarizeWorkflowWorkerStderr(" warning ", 32);

    expect(metadata).toEqual({
      stderrBytes: 7,
      stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      stderrExcerpt: "warning",
      stderrTruncated: false,
    });
  });

  test("truncates long stderr to a utf8-safe tail excerpt", () => {
    const metadata = summarizeWorkflowWorkerStderr(`start ${"x".repeat(64)} café tail`, 16);

    expect(metadata.stderrBytes).toBeGreaterThan(16);
    expect(metadata.stderrSha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(metadata.stderrExcerpt).toEndWith(" café tail");
    expect(Buffer.byteLength(metadata.stderrExcerpt ?? "", "utf8")).toBeLessThanOrEqual(16);
    expect(metadata.stderrTruncated).toBe(true);
  });
});
