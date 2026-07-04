import { Schema } from "effect";
import type { ToolSource } from "prism";

export default {
  name: "submit_work",
  description: "Submit completed work",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  handle: async (input, context) => ({ acknowledged: true }),
} satisfies ToolSource;
