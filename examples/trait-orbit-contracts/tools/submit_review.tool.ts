import { Schema } from "effect";
import { defineTool, schemaSlot } from "prism";

export default defineTool({
  name: "submit_review",
  description: "Submit review findings",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  slots: {
    verdict: schemaSlot({
      description: "Agent-specific review verdict fields",
    }),
  },
  handle: async (input, context) => ({ acknowledged: true }),
});
