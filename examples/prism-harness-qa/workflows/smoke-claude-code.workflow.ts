import { defineTask, defineWorkflow } from "prism";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

const challenge = "claude-code-2026-06-20-001";

const verifyChallenge = defineTask({
  id: "verify-challenge",
  prompt: challengePrompt(challenge),
  output: challengeOutput,
  finish: challengeFinish(challenge),
  worker: { worker: "claude-code" },
});

export default defineWorkflow({
  name: "claude-code-smoke",
  tasks: [verifyChallenge],
});
