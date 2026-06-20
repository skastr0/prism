import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const challenge = "codex-cli-2026-06-20-001";

const challengeOutput = Schema.Struct({
  challenge: Schema.String,
  proof: Schema.String,
  source: Schema.Literal("prism-generated-tool"),
});

const verifyChallenge = defineTask({
  id: "verify-challenge",
  agent: agents.prismHarnessQa.qaTester,
  prompt:
    "Verify that the generated MCP challenge_echo tool is reachable. " +
    `Call challenge_echo with challenge ${JSON.stringify(challenge)}. ` +
    "Return exactly the tool response JSON.",
  output: challengeOutput,
  worker: { worker: "codex-cli" },
});

export default defineWorkflow({
  name: "codex-cli-smoke",
  tasks: [verifyChallenge],
});
