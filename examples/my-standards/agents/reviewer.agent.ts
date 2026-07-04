import type { AgentSource } from "prism";

export default {
  name: "reviewer",
  description: "Code reviewer that focuses on best practices",
  identity: "reviewer",
  targets: {
    opencode: {
      mode: "subagent",
      model: "anthropic/claude-sonnet-4-20250514",
      temperature: 0.1,
      tools: {
        write: false,
        edit: false,
      },
    },
    "claude-code": {
      model: "sonnet",
    },
    "factory-droid": {
      model: "inherit",
      tools: ["Read", "Grep", "Glob"],
    },
  },
} satisfies AgentSource;
