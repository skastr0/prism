import { Schema } from "effect";
import { defineTool } from "prism";

export default defineTool({
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
});
