import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

const challenge = "amp-code-rush-2026-06-20-001";

const verifyChallenge = defineTask({
  id: "verify-challenge",
  agent: agents.prismHarnessQa.qaTester,
  prompt: challengePrompt(challenge),
  output: challengeOutput,
  finish: challengeFinish(challenge),
  worker: { worker: "amp-code", model: "rush" },
});

export default defineWorkflow({
  name: "amp-code-rush-smoke",
  tasks: [verifyChallenge],
});
