import { modelProfileRef, type AgentSource } from "prism";
import { ReviewFindingsSlot } from "../schemas/review-slots.ts";

export default {
  name: "reviewer",
  description: "Reviewer agent using orthogonal trait conformance",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  traits: [
    "agent-core:forge-practitioner",
    "agent-core:core-engineering",
    "agent-core:research-practice",
    "submittable",
    {
      trait: "reviewable",
      tools: {
        submit_review: {
          slots: {
            verdict: ReviewFindingsSlot,
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
      top_p: 0.5,
    },
  },
} satisfies AgentSource;
