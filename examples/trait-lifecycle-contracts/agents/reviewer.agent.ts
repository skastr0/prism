import { bindTrait, defineAgent, modelProfileRef } from "agentpkg";
import { ReviewFindingsSlot } from "../schemas/review-slots.ts";

export default defineAgent({
  name: "reviewer",
  description: "Reviewer agent using orthogonal trait conformance",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  traits: [
    bindTrait("agent-core:sdlc-practitioner"),
    bindTrait("submittable"),
    bindTrait("reviewable", {
      slots: {
        verdict: ReviewFindingsSlot,
      },
    }),
    bindTrait("self-assessing"),
  ],
  targets: {
    opencode: {
      mode: "subagent",
    },
    "claude-code": {
      top_p: 0.5,
    },
  },
});
