import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  tryWorkflowJsonSchemaFromEffectSchema,
  workflowJsonSchemaFromEffectSchema,
} from "./workflow-output-schema.js";

describe("workflow output JSON Schema", () => {
  test("maps common task output schemas", () => {
    const schema = workflowJsonSchemaFromEffectSchema(
      Schema.Struct({
        summary: Schema.String.annotations({ description: "Short result summary" }),
        count: Schema.Number,
        ok: Schema.Boolean,
        tags: Schema.Array(Schema.String),
        mode: Schema.Literal("pass", "fail"),
        maybeScore: Schema.optional(Schema.Number),
        nullableNote: Schema.NullOr(Schema.String),
      }),
    );

    expect(schema).toEqual({
      type: "object",
      properties: {
        summary: { type: "string", description: "Short result summary" },
        count: { type: "number" },
        ok: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        mode: { enum: ["pass", "fail"] },
        maybeScore: { type: "number" },
        nullableNote: {
          anyOf: [
            { type: "string" },
            { type: "null" },
          ],
        },
      },
      required: ["summary", "count", "ok", "tags", "mode", "nullableNote"],
      additionalProperties: false,
    });
  });

  test("keeps unsupported schemas opportunistic", () => {
    expect(tryWorkflowJsonSchemaFromEffectSchema(
      Schema.Struct({
        value: Schema.Union(Schema.String, Schema.Number),
      }),
    )).toBeUndefined();

    expect(tryWorkflowJsonSchemaFromEffectSchema(
      Schema.Literal(1n),
    )).toBeUndefined();

    expect(tryWorkflowJsonSchemaFromEffectSchema(
      Schema.Struct({ createdAt: Schema.DateFromString }),
    )).toBeUndefined();

    expect(tryWorkflowJsonSchemaFromEffectSchema(
      Schema.Struct({ counts: Schema.Record({ key: Schema.String, value: Schema.Number }) }),
    )).toBeUndefined();
  });
});