import type { ModelspaceSource } from "prism";

export default {
  name: "default-models",
  description: "Shared logical model profiles",
  profiles: {
    builder: {
      description: "Primary build profile",
      targets: {
        opencode: {
          model: "openai/gpt-5.4",
          variant: "xhigh",
          temperature: 0.2,
        },
        "claude-code": {
          model: "sonnet",
          temperature: 0.1,
        },
      },
    },
    reviewer: {
      description: "Primary review profile",
      targets: {
        opencode: {
          model: "openai/gpt-5.4",
          variant: "medium",
          temperature: 0.1,
        },
        "claude-code": {
          model: "opus",
          temperature: 0.1,
        },
      },
    },
  },
} satisfies ModelspaceSource;
