import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  astToJsonSchema,
  jsonSchemaFromEffectSchema,
  MCP_AST_TO_JSON_SCHEMA_OPTIONS,
  WorkflowOutputSchemaError,
  WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
} from "./ast-to-json-schema.js";

const expectWorkflowError = (run: () => unknown, construct: string, fieldPath?: string): void => {
  try {
    run();
    throw new Error("expected WorkflowOutputSchemaError");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowOutputSchemaError);
    const message = (error as WorkflowOutputSchemaError).message;
    expect(message).toContain(construct);
    if (fieldPath !== undefined) {
      expect(message).toContain(`at field "${fieldPath}"`);
    }
  }
};

describe("astToJsonSchema", () => {
  test("maps the supported workflow output subset", () => {
    const schema = jsonSchemaFromEffectSchema(
      Schema.Struct({
        summary: Schema.String.annotations({ description: "Short result summary" }),
        count: Schema.Number,
        ok: Schema.Boolean,
        tags: Schema.Array(Schema.String),
        mode: Schema.Literal("pass", "fail"),
        maybeScore: Schema.optional(Schema.Number),
        nullableNote: Schema.NullOr(Schema.String),
      }),
      WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
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

  test("rejects mixed non-literal unions", () => {
    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(
        Schema.Struct({ value: Schema.Union(Schema.String, Schema.Number) }),
        WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
      ),
      "Union",
      "value",
    );
  });

  test("rejects bigint literals", () => {
    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(Schema.Literal(1n), WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS),
      "Literal",
    );
  });

  test("rejects Transformation constructs", () => {
    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(
        Schema.Struct({ createdAt: Schema.DateFromString }),
        WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
      ),
      "Transformation",
      "createdAt",
    );
  });

  test("rejects Refinement constructs", () => {
    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(
        Schema.Struct({ label: Schema.NonEmptyString }),
        WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
      ),
      "Refinement",
      "label",
    );

    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(
        Schema.Struct({ label: Schema.String.pipe(Schema.minLength(1)) }),
        WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
      ),
      "Refinement",
      "label",
    );
  });

  test("rejects Record index signatures", () => {
    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(
        Schema.Struct({ counts: Schema.Record({ key: Schema.String, value: Schema.Number }) }),
        WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
      ),
      "Record",
      "counts",
    );
  });

  test("rejects non-terminating Suspend recursion", () => {
    type Recursive = { readonly child: Recursive };
    const recursive: Schema.Schema<Recursive> = Schema.suspend(() =>
      Schema.Struct({ child: recursive }),
    );

    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(recursive, WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS),
      "Suspend",
      "child",
    );
  });

  test("honors MCP enum literal representation and unknown keyword mapping", () => {
    const schema = jsonSchemaFromEffectSchema(
      Schema.Struct({
        mode: Schema.Literal("on"),
        extra: Schema.Unknown,
      }),
      MCP_AST_TO_JSON_SCHEMA_OPTIONS,
    );

    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties).toMatchObject({
      mode: { enum: ["on"] },
      extra: { type: "object", additionalProperties: true },
    });
    expect(properties.mode).not.toHaveProperty("const");
  });

  test("supports explicit const literal representation", () => {
    const schema = astToJsonSchema(Schema.Literal("fixed").ast, {
      errorPrefix: "test",
      literalRepresentation: "const",
    });
    expect(schema).toEqual({ const: "fixed" });
  });
});