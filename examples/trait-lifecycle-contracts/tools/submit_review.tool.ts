import { Schema } from "effect";
import { defineTool } from "agentpkg";

export default defineTool({
  name: "submit_review",
  description: "Submit review findings",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  handle: async (input, context) => ({ acknowledged: true }),
});
