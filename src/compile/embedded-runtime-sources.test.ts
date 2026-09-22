import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAstToJsonSchemaSource,
  getWorkflowDslRuntimeSources,
} from "./embedded-runtime-sources.js";

test("getAstToJsonSchemaSource returns the canonical converter module text", () => {
  const source = getAstToJsonSchemaSource();
  const repoSource = readFileSync(
    join(import.meta.dirname, "../ast-to-json-schema.ts"),
    "utf8",
  );

  expect(source).toBe(repoSource);
  expect(source).toContain("export const astToJsonSchema");
  expect(source).toContain("WorkflowOutputSchemaError");
  expect(source).toContain("MCP_AST_TO_JSON_SCHEMA_OPTIONS");
});

test("getWorkflowDslRuntimeSources returns the canonical vendored DSL module texts", () => {
  const sources = getWorkflowDslRuntimeSources();

  expect(Object.keys(sources).sort()).toEqual([
    "jev.ts",
    "lowerer-capabilities.ts",
    "workflow-effort.ts",
    "workflow-errors.ts",
    "workflow-scheduler/cron.ts",
    "workflow-scheduler/errors.ts",
    "workflow-scheduler/schedule.ts",
    "workflows.ts",
  ]);
  for (const [name, source] of Object.entries(sources)) {
    expect(source).toBe(readFileSync(join(import.meta.dirname, "..", name), "utf8"));
  }
  expect(sources["workflows.ts"]).toContain("export const jev =");
  expect(sources["workflows.ts"]).toContain("export function defineWorkflow");
  expect(sources["workflows.ts"]).toContain("export const decodeTaskOutput");
  expect(sources["jev.ts"]).toContain("export function choice");
  expect(sources["jev.ts"]).toContain("export const jevResultSchema");
  expect(sources["lowerer-capabilities.ts"]).toContain("workflowEffort");
  expect(sources["workflow-effort.ts"]).toContain("legacyReasoningVariantError");
  expect(sources["workflow-errors.ts"]).toContain("WorkflowTaskInputError");
  expect(sources["workflow-scheduler/schedule.ts"]).toContain("parseWorkflowSchedule");
});
