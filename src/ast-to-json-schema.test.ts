import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  astToJsonSchema,
  jsonSchemaFromEffectSchema,
  MCP_AST_TO_JSON_SCHEMA_OPTIONS,
  WorkflowOutputSchemaError,
  WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
} from "./ast-to-json-schema.js";
import { workflowJsonSchemaFromEffectSchema } from "./workflow-output-schema.js";

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
        summary: Schema.String.annotate({ description: "Short result summary" }),
        count: Schema.Number,
        ok: Schema.Boolean,
        tags: Schema.Array(Schema.String),
        mode: Schema.Literals(["pass", "fail"]),
        modes: Schema.Array(Schema.Literals(["pass", "fail"])),
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
        mode: { type: "string", enum: ["pass", "fail"] },
        modes: { type: "array", items: { type: "string", enum: ["pass", "fail"] } },
        maybeScore: { type: "number" },
        nullableNote: {
          anyOf: [
            { type: "string" },
            { type: "null" },
          ],
        },
      },
      required: ["summary", "count", "ok", "tags", "mode", "modes", "nullableNote"],
      additionalProperties: false,
    });
  });

  test("rejects mixed non-literal unions", () => {
    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(
        Schema.Struct({ value: Schema.Union([Schema.String, Schema.Number]) }),
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

  test("rejects Refinement constructs under workflow options", () => {
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
        Schema.Struct({ label: Schema.String.check(Schema.isMinLength(1)) }),
        WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
      ),
      "Refinement",
      "label",
    );
  });

  test("rejects Record index signatures", () => {
    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(
        Schema.Struct({ counts: Schema.Record(Schema.String, Schema.Number) }),
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

  test("rejects encoded schemas: Schema.Class and Schema.DateFromString", () => {
    class User extends Schema.Class<User>("User")({ id: Schema.String }) {}

    // A Class decodes to a class instance, not a plain JSON value, so the strict
    // workflow policy rejects it exactly as v3 did (v3 Class was a Transformation).
    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(User, WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS),
      "Transformation",
    );

    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(
        Schema.Struct({ createdAt: Schema.DateFromString }),
        WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
      ),
      "Transformation",
      "createdAt",
    );
  });

  test("accepts a nominal brand and erases it from the wire schema", () => {
    // A brand adds TypeScript identity but no runtime validation, so it does not
    // change the wire shape. v3 behaved the same way (v3 brand was an annotation,
    // not a Refinement).
    expect(
      jsonSchemaFromEffectSchema(
        Schema.Struct({ id: Schema.String.pipe(Schema.brand("UserId")) }),
        WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
      ),
    ).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  test("still rejects a branded schema that also carries a check", () => {
    expectWorkflowError(
      () => jsonSchemaFromEffectSchema(
        Schema.Struct({
          id: Schema.String.pipe(Schema.brand("UserId"), Schema.check(Schema.isMinLength(1))),
        }),
        WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
      ),
      "Refinement",
      "id",
    );
  });

  test("supports explicit const literal representation", () => {
    const schema = astToJsonSchema(Schema.Literal("fixed").ast, {
      errorPrefix: "test",
      literalRepresentation: "const",
    });
    expect(schema).toEqual({ type: "string", const: "fixed" });
  });
});