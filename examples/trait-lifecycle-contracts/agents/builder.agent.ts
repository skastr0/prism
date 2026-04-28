import { bindTrait, defineAgent, modelProfileRef, toolRef } from "agentpkg";

export default defineAgent({
  name: "builder",
  description: "Builder agent using orthogonal trait conformance",
  identity: "builder",
  model: modelProfileRef("agent-core", "default-models", "builder"),
  traits: [
    bindTrait("agent-core:sdlc-practitioner"),
    bindTrait("agent-core:core-engineering"),
    bindTrait("agent-core:functional-thinking"),
    bindTrait("submittable"),
    bindTrait("committable"),
    bindTrait("self-assessing"),
  ],
  access: {
    tools: [toolRef("agent-core", "workspace-tools", "run_shell")],
  },
  targets: {
    opencode: {
      mode: "subagent",
      maxSteps: 12,
    },
    "claude-code": {
      top_p: 0.7,
    },
  },
});
