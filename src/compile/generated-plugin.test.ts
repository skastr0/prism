import { expect, test } from "bun:test";
import {
  GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH,
  generatedCursorPluginId,
  generatedPluginIdForOwner,
  generatedOwnerToolName,
} from "./generated-plugin.js";

test("generated owner tool names collapse repeated underscores", () => {
  expect(generatedOwnerToolName("forge", "submit_review__review_details")).toBe(
    "forge_submit_review_review_details",
  );
});

test("generated owner tool names keep the exact portable length boundary", () => {
  const toolName = "a".repeat(GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH - "p_".length);
  const generated = generatedOwnerToolName("p", toolName);

  expect(generated).toBe(`p_${toolName}`);
  expect(generated.length).toBe(GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH);
});

test("generated owner tool names compact over the portable length boundary", () => {
  const original = `p_${"a".repeat(GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH - "p_".length + 1)}`;
  const generated = generatedOwnerToolName(
    "p",
    "a".repeat(GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH - "p_".length + 1),
  );

  expect(generated).not.toBe(original);
  expect(generated.length).toBe(GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH);
  expect(generated).toMatch(/^p_a+_[0-9a-f]{8}$/u);
});

test("Cursor generated plugin ids kebabize underscores", () => {
  expect(generatedPluginIdForOwner("agent_core")).toBe("prism-generated-agent_core");
  expect(generatedCursorPluginId("agent_core")).toBe("prism-generated-agent-core");
  expect(generatedCursorPluginId("my-plugin")).toBe("prism-generated-my-plugin");
});
