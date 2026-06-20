import { Schema } from "effect";
import { defineTask, defineWorkflow, type WorkflowTaskWorkerOptions } from "prism";
import { agents } from "prism/refs";
import { models } from "prism/refs/models";

const challengeOutput = Schema.Struct({
  challenge: Schema.String,
  proof: Schema.String,
  source: Schema.Literal("prism-generated-tool"),
});

const task = (
  id: string,
  challenge: string,
  worker: WorkflowTaskWorkerOptions,
) =>
  defineTask({
    id,
    agent: agents.prismHarnessQa.qaTester,
    prompt:
      "Verify that the generated MCP challenge_echo tool is reachable. " +
      `Call challenge_echo with challenge ${JSON.stringify(challenge)}. ` +
      "Return exactly the tool response JSON.",
    output: challengeOutput,
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
