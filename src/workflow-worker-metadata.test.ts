import { describe, expect, test } from "bun:test";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction, WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WorkflowOutputParseError } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr, workflowWorkerFailureMetadata } from "./workflow-worker-metadata.js";
import type { WorkflowAgentRef } from "./workflows.js";

const builder = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["grok"],
} as const satisfies WorkflowAgentRef;

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

describe("workflowWorkerFailureMetadata (OBS-006)", () => {
  test("carries adapter + stderr summary + sessionId when all are known", () => {
    const metadata = workflowWorkerFailureMetadata({
      adapter: "codex-cli",
      stderr: "fatal: account mismatch",
      sessionId: "sess-123",
    });

    expect(metadata).toEqual({
      adapter: "codex-cli",
      stderrBytes: 23,
      stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      stderrExcerpt: "fatal: account mismatch",
      stderrTruncated: false,
      sessionId: "sess-123",
    });
  });

  test("omits sessionId when it could not be obtained", () => {
    const metadata = workflowWorkerFailureMetadata({ adapter: "grok-cli", stderr: "boom" });

    expect(metadata).not.toHaveProperty("sessionId");
    expect(metadata.adapter).toBe("grok-cli");
    expect(metadata.stderrExcerpt).toBe("boom");
  });

  test("ephemeral failures retain diagnostics without session pointers or stderr text", () => {
    const metadata = workflowWorkerFailureMetadata({
      adapter: "omp-cli",
      stderr: "session id: transient-omp-session",
      sessionId: "transient-omp-session",
      sessionPersistence: "ephemeral",
    });

    expect(metadata).toMatchObject({
      adapter: "omp-cli",
      sessionPersistence: "ephemeral",
      stderrBytes: 33,
      stderrSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(metadata).not.toHaveProperty("sessionId");
    expect(metadata).not.toHaveProperty("stderrExcerpt");
    expect(JSON.stringify(metadata)).not.toContain("transient-omp-session");
  });

  test("still reports the adapter when stderr is empty", () => {
    const metadata = workflowWorkerFailureMetadata({ adapter: "hermes", stderr: "   " });

    expect(metadata).toEqual({ adapter: "hermes" });
  });
});

describe("workflow worker contract", () => {
  test("renders one versioned JSON instruction for worker prompts", () => {
    const instruction = workflowWorkerJsonInstruction({
      kind: "workflow-task",
      id: "build",
      agent: builder,
      prompt: "Build it.",
      output: {} as never,
    });

    expect(instruction).toContain("Task id: build");
    expect(instruction).toContain("Agent identity: forge.builder");
    expect(instruction).toContain(`Contract version: ${WORKFLOW_WORKER_JSON_CONTRACT_VERSION}`);
    expect(instruction).toContain("Return exactly one JSON value and nothing else");
  });

  test("parses direct, fenced, and prefixed JSON outputs", () => {
    expect(parseWorkflowWorkerJsonOutput('{"ok":true}')).toEqual({ ok: true });
    expect(parseWorkflowWorkerJsonOutput("```json\n{\"ok\":true}\n```" )).toEqual({ ok: true });
    expect(parseWorkflowWorkerJsonOutput("done\n{\"ok\":true}\nthanks")).toEqual({ ok: true });
  });

  test("rejects empty or non-json worker output", () => {
    expect(() => parseWorkflowWorkerJsonOutput("  \n")).toThrow(WorkflowOutputParseError);
    expect(() => parseWorkflowWorkerJsonOutput("no json here")).toThrow("workflow worker output did not contain JSON");
  });

  test("preserves raw worker text on parse failures for debugging", () => {
    try {
      parseWorkflowWorkerJsonOutput("not valid json");
      throw new Error("expected parse failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowOutputParseError);
      expect((error as WorkflowOutputParseError).rawText).toBe("not valid json");
    }
  });
});
