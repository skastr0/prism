import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

const challenge = "grok-2026-06-20-001";

const verifyChallenge = defineTask({
  id: "verify-challenge",
  agent: agents.prismHarnessQa.qaTester,
  prompt: challengePrompt(challenge),
  output: challengeOutput,
  finish: challengeFinish(challenge),
  // Not "grok-build": that model fails config validation
  // ("auto_background_on_timeout requires enabled_background to be true")
  // against a custom --agent file with a restricted tools: list — every
  // Prism-generated agent, this one included (PQ-176). grok-composer-2.5-fast
  // is grok's own CLI default and is verified working against this exact
  // agent shape.
  worker: { worker: "grok", model: "grok-composer-2.5-fast" },
});

export default defineWorkflow({
  name: "grok-smoke",
  tasks: [verifyChallenge],
});
