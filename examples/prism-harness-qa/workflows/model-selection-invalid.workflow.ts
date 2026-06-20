import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";
import { models } from "prism/refs/models";

const challengeOutput = Schema.Struct({
  challenge: Schema.String,
  proof: Schema.String,
  source: Schema.Literal("prism-generated-tool"),
});

const invalidModelTarget = defineTask({
  id: "invalid-model-target",
  agent: agents.prismHarnessQa.qaTester,
  prompt:
    "This task should fail before worker dispatch because the selected model profile has no opencode target.",
  output: challengeOutput,
  worker: {
    worker: "opencode",
    model: models.prismHarnessQa.qaModels.unavailable,
  },
});

export default defineWorkflow({
  name: "model-selection-invalid",
  tasks: [invalidModelTarget],
});
