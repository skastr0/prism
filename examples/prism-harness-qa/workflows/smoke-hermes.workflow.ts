import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { models } from "prism/refs/models";

const challenge = "hermes-2026-06-20-001";

const hermesQaAgent = {
  kind: "agent-ref",
  plugin: "prism-harness-qa",
  name: "qa-tester",
  description: "Prompted Hermès QA contract for generated-tool workflow smoke tests.",
  sourceHash: "hermes-workflow-inline-contract",
  manifestHash: "hermes-workflow-inline-contract",
  installs: [],
} as const;

const challengeOutput = Schema.Struct({
  challenge: Schema.String,
  proof: Schema.String,
  source: Schema.Literal("prism-generated-tool"),
});

const verifyChallenge = defineTask({
  id: "verify-challenge",
  agent: hermesQaAgent,
  prompt:
    "Verify that the generated MCP challenge_echo tool is reachable. " +
    `Call challenge_echo with challenge ${JSON.stringify(challenge)}. ` +
    "Return exactly the tool response JSON.",
  output: challengeOutput,
  worker: {
    worker: "hermes",
    model: models.prismHarnessQa.qaModels.smoke,
  },
});

export default defineWorkflow({
  name: "hermes-smoke",
  tasks: [verifyChallenge],
});
