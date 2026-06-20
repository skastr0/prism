import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

const challenge = "codex-cli-2026-06-20-001";

const verifyChallenge = defineTask({
  id: "verify-challenge",
  agent: agents.prismHarnessQa.qaTester,
  prompt: challengePrompt(challenge),
  output: challengeOutput,
  finish: challengeFinish(challenge),
  worker: { worker: "codex-cli" },
});

export default defineWorkflow({
  name: "codex-cli-smoke",
  tasks: [verifyChallenge],
});
