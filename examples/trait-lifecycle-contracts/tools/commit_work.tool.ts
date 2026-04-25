import { Schema } from "effect";
import { defineTool } from "agentpkg";

export default defineTool({
  name: "commit_work",
  description: "Commit validated implementation work",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  handle: async (input, context) => ({ acknowledged: true }),
});
