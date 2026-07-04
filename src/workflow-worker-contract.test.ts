import { describe, expect, test } from "bun:test";
import { parseWorkflowWorkerJsonOutput, WorkflowOutputParseError } from "./workflow-worker-contract.js";

describe("parseWorkflowWorkerJsonOutput brace-robust extraction", () => {
  test("extracts a trailing receipt past a brace-containing diff prefix", () => {
    const stdout = [
      "Applying change to skills/example/SKILL.md...",
      "export const schema = Schema.Struct({ id: Schema.String, name: Schema.String });",
      "Done.",
      '{"ok":true,"summary":"applied"}',
    ].join("\n");

    expect(parseWorkflowWorkerJsonOutput(stdout)).toEqual({ ok: true, summary: "applied" });
  });

  test("ignores trailing noise after a single JSON value", () => {
    expect(parseWorkflowWorkerJsonOutput('{"ok":true} deployment complete')).toEqual({ ok: true });
  });

  test("returns the last of multiple complete JSON objects", () => {
    expect(parseWorkflowWorkerJsonOutput('{"a":1}\n{"a":2}')).toEqual({ a: 2 });
  });

  test("handles a receipt whose string fields contain literal braces", () => {
    const stdout =
      '{"summary":"contains a literal { brace } inside a string value","ok":true}';

    expect(parseWorkflowWorkerJsonOutput(stdout)).toEqual({
      summary: "contains a literal { brace } inside a string value",
      ok: true,
    });
  });

  test("extracts an array receipt trailing prose", () => {
    expect(parseWorkflowWorkerJsonOutput("here is your result: [1,2,3]")).toEqual([1, 2, 3]);
  });

  test("still errors typed when there is no JSON at all", () => {
    expect(() => parseWorkflowWorkerJsonOutput("totally unrelated text, no braces here")).toThrow(
      WorkflowOutputParseError,
    );
    expect(() => parseWorkflowWorkerJsonOutput("totally unrelated text, no braces here")).toThrow(
      "workflow worker output did not contain JSON",
    );
  });

  test("still errors typed on an unterminated (incomplete) JSON value", () => {
    expect(() => parseWorkflowWorkerJsonOutput('prefix {"ok":true')).toThrow(
      "workflow worker output contained incomplete JSON",
    );
  });

  test("reproduces the hermes missing-session-id failure shape and parses the receipt with PRISM_WORKFLOW_HERMES_BIN unset", () => {
    expect(process.env.PRISM_WORKFLOW_HERMES_BIN).toBeUndefined();

    const hermesStdout = [
      "Applying skill_manage...",
      "--- a/skills/example/SKILL.md",
      "+++ b/skills/example/SKILL.md",
      "@@ -0,0 +1,4 @@",
      "+export const schema = Schema.Struct({",
      "+  id: Schema.String,",
      "+  name: Schema.String,",
      "+});",
      "Skill created successfully.",
      '{"ok":true,"summary":"created skill example"}',
    ].join("\n");

    expect(parseWorkflowWorkerJsonOutput(hermesStdout)).toEqual({
      ok: true,
      summary: "created skill example",
    });
  });
});
