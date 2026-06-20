import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";
import { models } from "prism/refs/models";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

const challenge = "model-invalid-2026-06-20-001";

const invalidModelTarget = defineTask({
  id: "invalid-model-target",
  agent: agents.prismHarnessQa.qaTester,
  prompt: challengePrompt(challenge),
  output: challengeOutput,
  finish: challengeFinish(challenge),
  worker: {
    worker: "opencode",
    model: models.prismHarnessQa.qaModels.unavailable,
  },
});

export default defineWorkflow({
  name: "model-selection-invalid",
  tasks: [invalidModelTarget],
});
