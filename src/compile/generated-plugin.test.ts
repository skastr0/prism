import { expect, test } from "bun:test";
import {
  GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH,
  generatedSyntheticToolName,
} from "./generated-plugin.js";

test("generated synthetic tool names collapse repeated underscores", () => {
  expect(generatedSyntheticToolName("forge", "submit_review__review_details")).toBe(
    "forge_submit_review_review_details",
  );
});

test("generated synthetic tool names keep the exact portable length boundary", () => {
  const contractName = "a".repeat(GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH - "p_".length);
  const toolName = generatedSyntheticToolName("p", contractName);

  expect(toolName).toBe(`p_${contractName}`);
  expect(toolName.length).toBe(GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH);
});

test("generated synthetic tool names compact over the portable length boundary", () => {
  const original = `p_${"a".repeat(GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH - "p_".length + 1)}`;
  const toolName = generatedSyntheticToolName(
    "p",
    "a".repeat(GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH - "p_".length + 1),
  );

  expect(toolName).not.toBe(original);
  expect(toolName.length).toBe(GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH);
  expect(toolName).toMatch(/^p_a+_[0-9a-f]{8}$/u);
});
