import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAstToJsonSchemaSource } from "./embedded-runtime-sources.js";

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