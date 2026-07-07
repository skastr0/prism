import { Effect, Schema } from "effect";
import type { WorkflowFinishOptions } from "prism";
import { challengeProof } from "../tools/proof";

export const challengeOutput = Schema.Struct({
  challenge: Schema.String,
  proof: Schema.String,
  source: Schema.Literal("prism-generated-tool"),
});

type ChallengeOutput = Schema.Schema.Type<typeof challengeOutput>;

export const challengePrompt = (challenge: string): string =>
  "Verify that the generated MCP challenge_echo tool is reachable. " +
  `The exact challenge string is ${JSON.stringify(challenge)}; copy it byte-for-byte and do not reorder, normalize, shorten, or derive it from the task id. ` +
  "Call the generated tool named challenge_echo with input " +
  `${JSON.stringify({ challenge })}; in Claude Code it may appear as ` +
  "mcp__prism-mcp-shim__p_f3119df0_prism_harness_qa_challenge_echo. " +
  "The tool's proof value is keyed and cannot be computed without calling the tool. " +
  "Do not use shell, files, env, fallback JSON, or any echo/status helper. " +
  "Return exactly the generated tool response JSON.";

export const challengeFinish = (challenge: string): WorkflowFinishOptions<ChallengeOutput> => ({
  // Decode/schema repair uses this budget. Proof mismatch fails closed below.
  maxRepairs: 1,
  criteria: [
    {
      kind: "judge",
      name: "challenge_echo_proof",
      goal: "Fail unless the task output is the exact keyed generated-tool proof.",
      evaluate: ({ output }) => {
        if (
          output.challenge === challenge &&
          output.proof === challengeProof(challenge) &&
          output.source === "prism-generated-tool"
        ) {
          return Effect.succeed({ verdict: "pass" as const });
        }
        return Effect.succeed({
          verdict: "fail" as const,
          feedback: `expected keyed generated-tool proof for challenge '${challenge}'`,
        });
      },
    },
  ],
});
