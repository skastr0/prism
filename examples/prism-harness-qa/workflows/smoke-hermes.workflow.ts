import { defineTask, defineWorkflow } from "prism";
import { models } from "prism/refs/models";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

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

const verifyChallenge = defineTask({
  id: "verify-challenge",
  agent: hermesQaAgent,
  prompt: challengePrompt(challenge),
  output: challengeOutput,
  finish: challengeFinish(challenge),
  worker: {
    worker: "hermes",
    model: models.prismHarnessQa.qaModels.smoke,
  },
});

export default defineWorkflow({
  name: "hermes-smoke",
  tasks: [verifyChallenge],
});
