import { describe, expect, test } from "bun:test";
import type { HarnessTypesSnapshot } from "./harness-types.js";
import { legacyReasoningVariantError, validateWorkflowEffort, workflowEffortValues } from "./workflow-effort.js";

const snapshot: HarnessTypesSnapshot = {
  generatedAt: "2026-09-22T00:00:00.000Z",
  harnesses: [
    {
      harness: "amp-code",
      source: "command",
      models: [
        { id: "provider/model-a", kind: "model", efforts: ["low", "high"] },
        { id: "provider/model-b", kind: "model", efforts: ["low"] },
      ],
    },
    {
      harness: "codex-cli",
      source: "command",
      models: [
        { id: "gpt-5.6-codex", efforts: ["low", "high", "xhigh"] },
        { id: "gpt-5.5", efforts: ["low", "medium"] },
      ],
    },
    {
      harness: "grok",
      source: "command",
      models: [{ id: "grok-build", efforts: ["low", "high"] }],
    },
  ],
};

describe("workflow effort capabilities", () => {
  test("fixed CLI values come from the capability registry", () => {
    expect(workflowEffortValues("claude-code")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(workflowEffortValues("claude-code", snapshot)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(workflowEffortValues("devin", snapshot)).toBeUndefined();
  });

  test("catalog values are discovered and checked against the selected model row", () => {
    expect(workflowEffortValues("codex-cli", snapshot)).toEqual(["high", "low", "medium", "xhigh"]);
    expect(validateWorkflowEffort({ worker: "codex-cli", model: "gpt-5.6-codex", effort: "xhigh", snapshot })).toBeUndefined();
    expect(validateWorkflowEffort({ worker: "codex-cli", model: "gpt-5.5", effort: "xhigh", snapshot })).toContain(
      'does not list effort "xhigh"',
    );
    expect(validateWorkflowEffort({ worker: "amp-code", catalogModel: "provider/model-b", effort: "high", snapshot })).toContain(
      'does not list effort "high"',
    );
  });

  test("catalog-backed effort fails closed without discovery or a selected model row", () => {
    expect(validateWorkflowEffort({ worker: "grok", effort: "high" })).toContain(
      "prism workflow refresh-harness-types",
    );
    expect(validateWorkflowEffort({ worker: "grok", model: "unknown-model", effort: "high", snapshot })).toContain(
      'Unknown grok model "unknown-model"',
    );
  });

  test("fixed values and unsupported workers have one-line remediation", () => {
    expect(validateWorkflowEffort({ worker: "claude-code", effort: "bogus" })).toContain(
      'Fix: set worker.effort to "low".',
    );
    expect(validateWorkflowEffort({ worker: "devin", effort: "high" })).toContain(
      "Fix: remove the `effort` property",
    );
  });

  test("Codex and OMP reject legacy modelspace variant with an exact replacement", () => {
    expect(legacyReasoningVariantError("codex-cli", { model: "gpt-5", variant: "high" }, "targets.codex-cli"))
      .toBe("codex-cli modelspace reasoning uses 'effort', not 'variant', at targets.codex-cli. Fix: replace `variant: \"high\"` with `effort: \"high\"` at targets.codex-cli.");
    expect(legacyReasoningVariantError("omp", { models: [{ model: "m", variant: "low" }] }, "targets.omp"))
      .toBe("omp modelspace reasoning uses 'effort', not 'variant', at targets.omp.models[0]. Fix: replace `variant: \"low\"` with `effort: \"low\"` at targets.omp.models[0].");
    expect(legacyReasoningVariantError("opencode", { model: "m", variant: "low" }, "targets.opencode")).toBeUndefined();
  });
});
