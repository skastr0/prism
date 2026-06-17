import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const qaTester = {
  kind: "agent-ref" as const,
  plugin: "prism-harness-qa",
  name: "qa-tester",
  description: "Quality-assurance tester for Prism OpenCode harness parity.",
  sourceHash: "0".repeat(64),
  manifestHash: "0".repeat(64),
  installs: ["opencode"],
};

const echoSmokeOutput = Schema.Struct({
  echoed: Schema.String,
  timestamp: Schema.Number,
  reachable: Schema.Boolean,
});

const verifyEcho = defineTask({
  id: "verify-echo",
  agent: qaTester,
  prompt:
    "Verify that the generated MCP echo tool is reachable. " +
    "Call the echo tool with the message 'hello-opencode'. " +
    "Return a JSON object with the echoed string, the timestamp from the tool response, and a boolean reachable flag.",
  output: echoSmokeOutput,
  worker: { worker: "opencode" },
});

export default defineWorkflow({
  name: "opencode-smoke",
  tasks: [verifyEcho],
});
