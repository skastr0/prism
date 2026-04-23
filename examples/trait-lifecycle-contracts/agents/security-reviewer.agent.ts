import { Schema } from "effect";
import { bindTrait, defineAgent, modelProfileRef } from "../../../src/index.ts";

export default defineAgent({
  name: "security-reviewer",
  description: "Security reviewer variant using the same reviewable trait",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  traits: [
    bindTrait("submittable"),
    bindTrait("reviewable", {
      slots: {
        review_lane: "security-review",
        review_input: Schema.Struct({
          summary: Schema.String,
          severity: Schema.Literal("low", "medium", "high"),
          findings: Schema.Array(Schema.String),
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
      top_p: 0.4,
    },
  },
});
