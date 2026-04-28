import { bindTrait, defineAgent, modelProfileRef } from "agentpkg";
import { SecurityReviewSlot } from "../schemas/review-slots.ts";

export default defineAgent({
  name: "security-reviewer",
  description: "Security reviewer variant using the same reviewable trait",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  traits: [
    bindTrait("agent-core:sdlc-practitioner"),
    bindTrait("submittable"),
    bindTrait("reviewable", {
      slots: {
        verdict: SecurityReviewSlot,
      },
    }),
    bindTrait("self-assessing"),
  ],
  targets: {
    opencode: {
      mode: "subagent",
    },
    "claude-code": {
      top_p: 0.4,
    },
  },
});
