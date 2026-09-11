import { defineTask, defineWorkflow } from "prism";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

const challenge = "grok-2026-06-20-001";

const verifyChallenge = defineTask({
  id: "verify-challenge",
  prompt: challengePrompt(challenge),
  output: challengeOutput,
  finish: challengeFinish(challenge),
  // Not "grok-build": that model fails config validation
  // ("auto_background_on_timeout requires enabled_background to be true")
  // against Prism's generated Grok layout (PQ-176). grok-composer-2.5-fast
  // is grok's own CLI default and is verified working.
  worker: { worker: "grok", model: "grok-composer-2.5-fast" },
});

export default defineWorkflow({
  name: "grok-smoke",
  tasks: [verifyChallenge],
});
