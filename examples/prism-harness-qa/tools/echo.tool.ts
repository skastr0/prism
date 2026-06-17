import { Schema } from "effect";
import { defineTool } from "prism";

export default defineTool({
  name: "echo",
  description: "Echo the input back unchanged. Used to verify MCP tool connectivity in the Kimi harness QA plugin.",
  input: Schema.Struct({
    message: Schema.String,
  }),
  output: Schema.Struct({
    echoed: Schema.String,
    timestamp: Schema.Number,
  }),
  async handle(input, _context) {
    return {
      echoed: input.message,
      timestamp: Date.now(),
    };
  },
});
