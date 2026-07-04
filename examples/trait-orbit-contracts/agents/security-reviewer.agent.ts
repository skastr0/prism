import { modelProfileRef, type AgentSource } from "prism";
import { SecurityReviewSlot } from "../schemas/review-slots.ts";

export default {
  name: "security-reviewer",
  description: "Security reviewer variant using the same reviewable trait",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  traits: [
    "agent-core:forge-practitioner",
    "agent-core:core-engineering",
    "agent-core:functional-thinking",
    "submittable",
    {
      trait: "reviewable",
      tools: {
        submit_review: {
          slots: {
            verdict: SecurityReviewSlot,
          },
        },
      },
    },
    "self-assessing",
  ],
  targets: {
    opencode: {
      mode: "subagent",
    },
    "claude-code": {
      top_p: 0.4,
    },
  },
} satisfies AgentSource;
