import { Schema, SchemaAST } from "effect";

export type JsonSchema = Record<string, unknown>;

export type AstToJsonSchemaOptions = {
  readonly errorPrefix?: string;
  /** Kimi and some MCP clients reject JSON Schema `const`; `enum` is the safe default. */
  readonly literalRepresentation?: "enum" | "const";
  readonly unknownKeywordSchema?: JsonSchema;
  /**
   * When true, a node's checks (refinements) are ignored and an encoding
   * (transformation) is followed to its encoded side, so the JSON Schema
   * describes the wire shape. This is the MCP / Zod / OpenCode schema-bridge
   * stance. Workflow output schemas keep the default (reject), because their
   * decoded value must equal its JSON representation.
   */
  readonly allowChecksAndEncodings?: boolean;
  /**
   * When true, map Effect `Schema.Record` (index signatures on the object node)
   * to JSON Schema `{ type: "object", additionalProperties: ... }`. Workflow
   * output schemas keep the default (reject).
   */
  readonly allowIndexSignatures?: boolean;
};

export class WorkflowOutputSchemaError extends Error {
  override readonly name = "WorkflowOutputSchemaError";
}

const defaultEffectTextAnnotations = new Set(["a string", "a number", "a boolean", "string", "number", "boolean"]);

const descriptionOrTitle = (ast: SchemaAST.AST): string | undefined => {
  const description = SchemaAST.resolveDescription(ast);
  if (description !== undefined && !defaultEffectTextAnnotations.has(description)) return description;
  const title = SchemaAST.resolveTitle(ast);
  if (title !== undefined && !defaultEffectTextAnnotations.has(title)) return title;
  return undefined;
};

/** The node's own annotation wins, falling back to the wrapper it replaced. */
const wrapperDescription = (
  wrapper: SchemaAST.AST,
  base: SchemaAST.AST,
): string | undefined => descriptionOrTitle(wrapper) ?? descriptionOrTitle(base);

const isFreeFormAst = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isUnknown(ast) || SchemaAST.isAny(ast);

const isNullAst = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isNull(ast) || (SchemaAST.isLiteral(ast) && ast.literal === null);

const formatFieldPath = (fieldPath: string): string =>
  fieldPath.length > 0 ? ` at field "${fieldPath}"` : "";

const unsupportedConstruct = (
  construct: string,
  fieldPath: string,
  options: AstToJsonSchemaOptions,
  detail?: string,
): never => {
  const prefix = options.errorPrefix ?? "schema";
  const suffix = detail ? ` (${detail})` : "";
  throw new WorkflowOutputSchemaError(
    `${prefix}: ${construct}${formatFieldPath(fieldPath)}${suffix}`,
  );
};

/**
 * JSON Schema `type` for a literal value. Strict validators (Kimi's
 * Moonshot-flavored schema check, OpenAI structured outputs) reject `enum` and
 * `const` without a sibling `type`, and an array of enum-only items leaves
 * `items` untyped — so literal schemas always carry one.
 */
const literalJsonSchemaType = (
  literal: string | number | boolean | null,
): "string" | "number" | "boolean" | "null" =>
  literal === null
    ? "null"
    : typeof literal === "boolean"
      ? "boolean"
      : typeof literal === "number"
        ? "number"
        : "string";

const literalJsonSchema = (
  literal: string | number | boolean | null | bigint,
  fieldPath: string,
  options: AstToJsonSchemaOptions,
): JsonSchema => {
  if (typeof literal === "bigint") {
    return unsupportedConstruct("Literal", fieldPath, options, "bigint literals are not JSON-serializable");
  }
  const type = literalJsonSchemaType(literal);
  if (options.literalRepresentation === "const") {
    return { type, const: literal };
  }
  return { type, enum: [literal] };
};

const objectsAstToJsonSchema = (
  ast: SchemaAST.Objects,
  options: AstToJsonSchemaOptions,
  fieldPath: string,
  visiting: Set<SchemaAST.AST>,
): JsonSchema => {
  const indexSignaturesAllowed = options.allowIndexSignatures === true && ast.indexSignatures.length > 0;
  if (ast.indexSignatures.length > 0 && !options.allowIndexSignatures) {
    unsupportedConstruct("Record", fieldPath, options, "index signatures are not supported");
  }

  const additionalPropertiesForIndex = (): boolean | JsonSchema => {
    const index = ast.indexSignatures[0]!;
    const valuePath = fieldPath.length > 0 ? `${fieldPath}.*` : "*";
    // Unknown/any values → free-form object; typed values → additionalProperties schema.
    return isFreeFormAst(index.type)
      ? true
      : astToJsonSchemaInner(index.type, options, valuePath, visiting);
  };

  // Pure record (Schema.Record): object with open additionalProperties.
  if (indexSignaturesAllowed && ast.propertySignatures.length === 0) {
    return { type: "object", additionalProperties: additionalPropertiesForIndex() };
  }
  // Mixed struct + index: fixed props plus additionalProperties from the first
  // index. Rare; keep deterministic rather than fail closed for MCP tool surfaces.

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const prop of ast.propertySignatures) {
    const name = String(prop.name);
    const childPath = fieldPath.length > 0 ? `${fieldPath}.${name}` : name;
    const property = astToJsonSchemaInner(prop.type, options, childPath, visiting);
    const description = descriptionOrTitle(prop.type);
    if (description !== undefined) property.description = description;
    properties[name] = property;
    if (!SchemaAST.isOptional(prop.type)) required.push(name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: indexSignaturesAllowed ? additionalPropertiesForIndex() : false,
  };
};

const arraysAstToJsonSchema = (
  ast: SchemaAST.Arrays,
  options: AstToJsonSchemaOptions,
  fieldPath: string,
  visiting: Set<SchemaAST.AST>,
): JsonSchema => {
  // Simple array: no fixed elements and exactly one rest element, which is the
  // element AST itself (not a `{ type }` wrapper as in v3).
  if (ast.elements.length === 0 && ast.rest.length === 1) {
    return {
      type: "array",
      items: astToJsonSchemaInner(ast.rest[0]!, options, fieldPath, visiting),
    };
  }
  return unsupportedConstruct(
    "Tuple",
    fieldPath,
    options,
    `tuple elements=${ast.elements.length}, rest=${ast.rest.length}`,
  );
};

const unionAstToJsonSchema = (
  ast: SchemaAST.Union,
  options: AstToJsonSchemaOptions,
  fieldPath: string,
  visiting: Set<SchemaAST.AST>,
): JsonSchema => {
  if (ast.types.every((type) => SchemaAST.isLiteral(type))) {
    const values = ast.types.map((type) => {
      const literal = (type as SchemaAST.Literal).literal;
      if (typeof literal === "bigint") {
        return unsupportedConstruct("Literal", fieldPath, options, "bigint literals are not JSON-serializable");
      }
      return literal;
    });
    const literalTypes = new Set(values.map((value) => literalJsonSchemaType(value)));
    // Mixed-type literal unions have no single `type`; omit it rather than lie.
    return literalTypes.size === 1
      ? { type: [...literalTypes][0]!, enum: values }
      : { enum: values };
  }

  const nonUndefined = ast.types.filter((type) => !SchemaAST.isUndefined(type));
  if (nonUndefined.length === 1) {
    return astToJsonSchemaInner(nonUndefined[0]!, options, fieldPath, visiting);
  }
  const nullMember = nonUndefined.find(isNullAst);
  const nonNull = nonUndefined.filter((type) => type !== nullMember);
  if (nullMember !== undefined && nonNull.length === 1) {
    const item = astToJsonSchemaInner(nonNull[0]!, options, fieldPath, visiting);
    return { anyOf: [item, { type: "null" }] };
  }
  return unsupportedConstruct(
    "Union",
    fieldPath,
    options,
    `union members: ${ast.types.map((type) => type._tag).join(" | ")}`,
  );
};

/**
 * Render a node's own structure, ignoring any checks or encoding. Callers handle
 * those wrappers first so the strict and permissive policies stay in one place.
 */
const structuralAstToJsonSchema = (
  ast: SchemaAST.AST,
  options: AstToJsonSchemaOptions,
  fieldPath: string,
  visiting: Set<SchemaAST.AST>,
): JsonSchema => {
  if (SchemaAST.isObjects(ast)) return objectsAstToJsonSchema(ast, options, fieldPath, visiting);
  if (SchemaAST.isArrays(ast)) return arraysAstToJsonSchema(ast, options, fieldPath, visiting);
  if (SchemaAST.isUnion(ast)) return unionAstToJsonSchema(ast, options, fieldPath, visiting);
  if (SchemaAST.isLiteral(ast)) return literalJsonSchema(ast.literal, fieldPath, options);
  if (SchemaAST.isString(ast)) return { type: "string" };
  if (SchemaAST.isNumber(ast)) return { type: "number" };
  if (SchemaAST.isBoolean(ast)) return { type: "boolean" };
  if (isFreeFormAst(ast)) return options.unknownKeywordSchema ?? {};
  if (SchemaAST.isObjectKeyword(ast)) return { type: "object", additionalProperties: true };
  if (SchemaAST.isSuspend(ast)) {
    if (visiting.has(ast)) {
      unsupportedConstruct("Suspend", fieldPath, options, "non-terminating recursive schema");
    }
    visiting.add(ast);
    try {
      return astToJsonSchemaInner(ast.thunk(), options, fieldPath, visiting);
    } finally {
      visiting.delete(ast);
    }
  }
  return unsupportedConstruct(ast._tag, fieldPath, options);
};

const astToJsonSchemaInner = (
  ast: SchemaAST.AST,
  options: AstToJsonSchemaOptions,
  fieldPath: string,
  visiting: Set<SchemaAST.AST>,
): JsonSchema => {
  const hasEncoding = ast.encoding !== undefined;
  const hasChecks = ast.checks !== undefined;

  if (!options.allowChecksAndEncodings) {
    if (hasEncoding) {
      return unsupportedConstruct(
        "Transformation",
        fieldPath,
        options,
        "the schema's decoded value differs from its JSON representation; declare the wire shape instead",
      );
    }
    if (hasChecks) {
      return unsupportedConstruct("Refinement", fieldPath, options);
    }
    return structuralAstToJsonSchema(ast, options, fieldPath, visiting);
  }

  if (!hasEncoding && !hasChecks) {
    return structuralAstToJsonSchema(ast, options, fieldPath, visiting);
  }

  // Permissive: JSON Schema describes the encoded (wire) shape. The last link of
  // the encoding chain is the final encoded node.
  const encodedTarget = hasEncoding ? ast.encoding![ast.encoding!.length - 1]!.to : undefined;
  const rendered = encodedTarget === undefined
    ? structuralAstToJsonSchema(ast, options, fieldPath, visiting)
    : astToJsonSchemaInner(encodedTarget, options, fieldPath, visiting);
  const description = wrapperDescription(ast, encodedTarget ?? ast);
  if (description !== undefined && rendered.description === undefined) {
    return { ...rendered, description };
  }
  return rendered;
};

export const astToJsonSchema = (
  ast: SchemaAST.AST,
  options: AstToJsonSchemaOptions = {},
  fieldPath: string = "",
): JsonSchema =>
  astToJsonSchemaInner(ast, options, fieldPath, new Set());

export const jsonSchemaFromEffectSchema = (
  schema: Schema.Top,
  options?: AstToJsonSchemaOptions,
): JsonSchema =>
  astToJsonSchema(schema.ast, options);

export const WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS = {
  errorPrefix: "workflow output schema",
  literalRepresentation: "enum",
} as const satisfies AstToJsonSchemaOptions;

export const MCP_AST_TO_JSON_SCHEMA_OPTIONS = {
  errorPrefix: "mcp-schema-bridge",
  literalRepresentation: "enum",
  unknownKeywordSchema: { type: "object", additionalProperties: true },
  // Match Zod / schema-bridge: refinements are runtime-only; JSON Schema sees the base type.
  allowChecksAndEncodings: true,
  // Schema.Record (payload maps, free-form objects) is common on tool inputs.
  allowIndexSignatures: true,
} as const satisfies AstToJsonSchemaOptions;