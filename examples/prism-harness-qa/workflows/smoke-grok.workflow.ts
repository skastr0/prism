import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const echoSmokeOutput = Schema.Struct({
  echoed: Schema.String,
  timestamp: Schema.Number,
  reachable: Schema.Boolean,
});

const verifyEcho = defineTask({
  id: "verify-echo",
  agent: agents.prismHarnessQa.qaTester,
  prompt:
    "Verify that the generated MCP echo tool is reachable. " +
    "Call the echo tool with the message 'hello-grok'. " +
    "Return a JSON object with the echoed string, the timestamp from the tool response, and a boolean reachable flag.",
  output: echoSmokeOutput,
  worker: { worker: "grok", model: "grok-build" },
});

export default defineWorkflow({
  name: "grok-smoke",
  tasks: [verifyEcho],
});