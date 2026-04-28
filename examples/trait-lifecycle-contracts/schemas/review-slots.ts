import { Schema } from "effect";

export const ReviewFindingsSlot = Schema.Struct({
  verdict: Schema.Literal("approve", "request_changes"),
});

export const SecurityReviewSlot = Schema.Struct({
  severity: Schema.Literal("low", "medium", "high"),
  findings: Schema.Array(Schema.String),
});
