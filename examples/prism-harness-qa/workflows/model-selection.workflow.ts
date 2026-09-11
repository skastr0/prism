import { defineTask, defineWorkflow, type WorkflowTaskWorkerOptions } from "prism";
import { models } from "prism/refs/models";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

const task = (
  id: string,
  challenge: string,
  worker: WorkflowTaskWorkerOptions,
) =>
  defineTask({
    id,
    prompt: challengePrompt(challenge),
    output: challengeOutput,
    finish: challengeFinish(challenge),
    worker,
  });

export default defineWorkflow({
  name: "model-selection-smoke",
  tasks: [
    task("explicit-model-profile", "model-explicit-profile-2026-06-20-001", {
      worker: "opencode",
      model: models.prismHarnessQa.qaModels.explicit,
    }),
    task("raw-model-override", "model-raw-override-2026-06-20-001", {
      worker: "opencode",
      model: "ollama-cloud/deepseek-v4-flash",
    }),
  ],
});
