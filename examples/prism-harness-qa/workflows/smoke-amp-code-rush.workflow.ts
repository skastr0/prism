import { defineTask, defineWorkflow } from "prism";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

const challenge = "amp-code-rush-2026-06-20-001";

const verifyChallenge = defineTask({
  id: "verify-challenge",
  prompt: challengePrompt(challenge),
  output: challengeOutput,
  finish: challengeFinish(challenge),
  worker: { worker: "amp-code", model: "low" },
});

export default defineWorkflow({
  name: "amp-code-rush-smoke",
  tasks: [verifyChallenge],
});
