import { expect, test } from "bun:test";
import { Schema } from "effect";
import { jsonSchemaFromEffectSchema, MCP_AST_TO_JSON_SCHEMA_OPTIONS } from "../../ast-to-json-schema.js";
import { decodeInput, toolInputFromSchema } from "./schema-bridge.js";

test("native tool input reuses canonical JSON Schema conversion", () => {
  const schema = Schema.Struct({
    name: Schema.String.annotate({ description: "User-visible name" }),
    mode: Schema.Literals(["fast", "slow"]),
    maybeCount: Schema.optional(Schema.Number),
    tags: Schema.Array(Schema.String),
    nested: Schema.Struct({ label: Schema.String }),
    payloads: Schema.Record(Schema.String, Schema.Unknown),
    unknown: Schema.Unknown,
    nothing: Schema.Null,
    variant: Schema.Union([
      Schema.Struct({ type: Schema.Literal("a"), label: Schema.String }),
      Schema.Struct({ type: Schema.Literal("b"), count: Schema.Number }),
    ]),
  });
  const input = toolInputFromSchema(schema);
  expect(input).toEqual(jsonSchemaFromEffectSchema(schema, MCP_AST_TO_JSON_SCHEMA_OPTIONS));
  expect(input.additionalProperties).toBe(false);
  expect(input.required).not.toContain("maybeCount");
  expect(input.properties).toMatchObject({
    name: { type: "string", description: "User-visible name" },
    mode: { enum: ["fast", "slow"] },
    nested: { additionalProperties: false },
    payloads: { type: "object", additionalProperties: true },
    unknown: {},
    nothing: { type: "null" },
    variant: { anyOf: expect.any(Array) },
  });
});

test("decodeInput preserves semantic validation and strict excess properties", () => {
  const schema = Schema.Struct({
    count: Schema.Number.check(Schema.isGreaterThan(0)),
    nested: Schema.Struct({ label: Schema.String }),
  });
  expect(decodeInput(schema, { count: 2, nested: { label: "x" } })).toEqual({ count: 2, nested: { label: "x" } });
  for (const raw of [
    { count: "2", nested: { label: "x" } },
    { count: -1, nested: { label: "x" } },
    { count: 2, nested: { label: "x" }, cuont: 3 },
    { count: 2, nested: { label: "x", lable: "typo" } },
  ]) expect(() => decodeInput(schema, raw)).toThrow();
});
