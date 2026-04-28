import { defineAgent } from "agentpkg";

export default defineAgent({
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
  },
});
