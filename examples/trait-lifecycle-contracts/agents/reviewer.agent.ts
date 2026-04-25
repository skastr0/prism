import { Schema } from "effect";
import { bindTrait, defineAgent, modelProfileRef } from "agentpkg";

export default defineAgent({
  name: "reviewer",
  description: "Reviewer agent using orthogonal trait conformance",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  traits: [
    bindTrait("submittable"),
    bindTrait("reviewable", {
      slots: {
        review_lane: "review-findings",
        review_input: Schema.Struct({
          summary: Schema.String,
          verdict: Schema.Literal("approve", "request_changes"),
        }),
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
