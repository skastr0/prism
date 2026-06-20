import { defineTask, defineWorkflow, type WorkflowTaskWorkerOptions } from "prism";
import { agents } from "prism/refs";
import { models } from "prism/refs/models";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

const task = (
  id: string,
  challenge: string,
  worker: WorkflowTaskWorkerOptions,
) =>
  defineTask({
    id,
    agent: agents.prismHarnessQa.qaTester,
    prompt: challengePrompt(challenge),
    output: challengeOutput,
    finish: challengeFinish(challenge),
    worker,
  });

export default defineWorkflow({
  name: "model-selection-smoke",
  tasks: [
    task("agent-default-modelspace", "model-agent-default-2026-06-20-001", { worker: "opencode" }),
    task("explicit-model-profile", "model-explicit-profile-2026-06-20-001", {
      worker: "opencode",
      model: models.prismHarnessQa.qaModels.explicit,
    }),
    task("raw-model-override", "model-raw-override-2026-06-20-001", {
      worker: "opencode",
      model: "ollama-cloud/deepseek-v4-flash",
    }),
    task("model-resolver", "model-resolver-2026-06-20-001", {
      worker: "opencode",
      modelResolver: (target) => {
        const first = target.deepseekV4Flash;
        if (Array.isArray(first)) return first[0]?.model ?? "";
        return first?.model ?? "";
      },
    }),
  ],
});
