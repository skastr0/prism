import { modelProfileRef, toolRef, type AgentSource } from "prism";

export default {
  name: "builder",
  description: "Builder agent using orthogonal trait conformance",
  identity: "builder",
  model: modelProfileRef("agent-core", "default-models", "builder"),
  traits: [
    "agent-core:forge-practitioner",
    "agent-core:core-engineering",
    "agent-core:functional-thinking",
    "submittable",
    "committable",
    "self-assessing",
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
} satisfies AgentSource;
