import { expect, test } from "bun:test";
import { Schema } from "effect";
import { decodeInput, toolArgsFromSchema } from "./schema-bridge.js";

type TestSchemaNode = {
  readonly description?: string;
  readonly shape?: Record<string, unknown>;
  parse(input: unknown): unknown;
  safeParse(input: unknown): { readonly success: boolean };
};

const schemaNode = (nodes: Record<string, unknown>, name: string): TestSchemaNode => {
  const node = nodes[name];
  expect(node).toBeDefined();
  return node as TestSchemaNode;
};

test("toolArgsFromSchema maps supported Effect schema shapes", () => {
  const args = toolArgsFromSchema(
    Schema.Struct({
      name: Schema.String.annotations({ description: "User-visible name" }),
      count: Schema.Number,
      enabled: Schema.Boolean,
      payload: Schema.Unknown,
      payloadTitle: Schema.Unknown.annotations({ title: "Payload title" }),
      mode: Schema.Literal("fast", "slow"),
      tags: Schema.Array(Schema.String),
      maybeCount: Schema.optional(Schema.Number),
      nested: Schema.Struct({
        label: Schema.String.annotations({ description: "Nested label" }),
        optionalScore: Schema.optional(Schema.Number),
      }),
    }),
  );

  const name = schemaNode(args, "name");
  const count = schemaNode(args, "count");
  const enabled = schemaNode(args, "enabled");
  const payload = schemaNode(args, "payload");
  const payloadTitle = schemaNode(args, "payloadTitle");
  const mode = schemaNode(args, "mode");
  const tags = schemaNode(args, "tags");
  const maybeCount = schemaNode(args, "maybeCount");
  const nested = schemaNode(args, "nested");
  const nestedShape = nested.shape;

  expect(name.description).toBe("User-visible name");
  expect(name.parse("Ada")).toBe("Ada");
  expect(count.parse(3)).toBe(3);
  expect(enabled.parse(true)).toBe(true);
  expect(payload.parse({ arbitrary: ["json"] })).toEqual({ arbitrary: ["json"] });
  expect(payloadTitle.description).toBe("Payload title");
  expect(mode.safeParse("fast").success).toBe(true);
  expect(mode.safeParse("medium").success).toBe(false);
  expect(tags.parse(["compile", "runtime"])).toEqual(["compile", "runtime"]);
  expect(maybeCount.parse(undefined)).toBeUndefined();
  expect(nested.parse({ label: "child" })).toEqual({ label: "child" });
  expect(nestedShape).toBeDefined();
  expect(schemaNode(nestedShape!, "label").description).toBe("Nested label");
  expect(schemaNode(nestedShape!, "optionalScore").parse(undefined)).toBeUndefined();
});

test("toolArgsFromSchema preserves unsupported union diagnostics", () => {
  expect(() =>
    toolArgsFromSchema(
      Schema.Struct({
        value: Schema.Union(Schema.String, Schema.Number),
      }),
    ),
  ).toThrow(
    "schema-bridge: only unions of literals or optional-wrapped types are supported, got StringKeyword | NumberKeyword",
  );
});

test("decodeInput decodes with the contract schema", () => {
  const inputSchema = Schema.Struct({
    count: Schema.Number,
  });

  expect(decodeInput(inputSchema, { count: 2 })).toEqual({ count: 2 });
  expect(() => decodeInput(inputSchema, { count: "2" })).toThrow();
});
