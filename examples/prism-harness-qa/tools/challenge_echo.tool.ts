import { Schema } from "effect";
import type { ToolSource } from "prism";

export default {
  name: "challenge_echo",
  description: "Returns deterministic proof that this generated Prism tool executed.",
  input: Schema.Struct({
    challenge: Schema.String,
  }),
  output: Schema.Struct({
    challenge: Schema.String,
    proof: Schema.String,
    source: Schema.Literal("prism-generated-tool"),
  }),
  handle(input) {
    return {
      challenge: input.challenge,
      proof: `prism-tool-proof:${input.challenge}`,
      source: "prism-generated-tool" as const,
    };
  },
} satisfies ToolSource;
