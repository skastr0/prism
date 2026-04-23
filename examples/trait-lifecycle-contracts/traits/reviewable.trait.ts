import { Schema } from "effect";
import {
  defineTrait,
  schemaSlot,
  slotRef,
  toolGroupRef,
  valueSlot,
} from "../../../src/index.ts";

export default defineTrait({
  name: "reviewable",
  description: "Can submit review findings",
  access: {
    toolGroups: [toolGroupRef("agent-core", "workspace-tools", "repo_inspection")],
  },
  slots: {
    review_input: schemaSlot({
      description: "Agent-specific review packet schema",
    }),
    review_lane: valueSlot(Schema.String, {
      description: "Review routing lane",
    }),
  },
  tools: {
    submit_review: {
      ref: "submit_review",
      description: "Submit review findings to ${review_lane}",
      input: slotRef("review_input"),
      output: Schema.Struct({
        acknowledged: Schema.Boolean,
      }),
    },
  },
  require: {
    tools: ["submit_review"],
  },
});
