import { Schema, SchemaAST } from "effect";

export type JsonSchema = Record<string, unknown>;

export type AstToJsonSchemaOptions = {
  readonly errorPrefix?: string;
  /** Kimi and some MCP clients reject JSON Schema `const`; `enum` is the safe default. */
  readonly literalRepresentation?: "enum" | "const";
  readonly unknownKeywordSchema?: JsonSchema;
};

export class WorkflowOutputSchemaError extends Error {
  override readonly name = "WorkflowOutputSchemaError";
}

const defaultEffectTextAnnotations = new Set(["a string", "a number", "a boolean", "string", "number", "boolean"]);

const extractStringAnnotation = (
  ast: SchemaAST.AST,
  annotationId: symbol,
): string | undefined => {
  const annotation = SchemaAST.getAnnotation<string>(annotationId)(ast);
  return annotation._tag === "Some" ? annotation.value : undefined;
};

const extractDescriptionOrTitle = (ast: SchemaAST.AST): string | undefined => {
  const description = extractStringAnnotation(ast, SchemaAST.DescriptionAnnotationId);
  if (description !== undefined && !defaultEffectTextAnnotations.has(description)) return description;
  const title = extractStringAnnotation(ast, SchemaAST.TitleAnnotationId);
  if (title !== undefined && !defaultEffectTextAnnotations.has(title)) return title;
  return undefined;
};

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

const literalJsonSchema = (
  literal: string | number | boolean | null | bigint,
  fieldPath: string,
  options: AstToJsonSchemaOptions,
): JsonSchema => {
  if (typeof literal === "bigint") {
    unsupportedConstruct("Literal", fieldPath, options, "bigint literals are not JSON-serializable");
  }
  if (options.literalRepresentation === "const") {
    return { const: literal };
  }
  return { enum: [literal] };
};

const astToJsonSchemaInner = (
  ast: SchemaAST.AST,
  options: AstToJsonSchemaOptions,
  fieldPath: string,
  visiting: Set<SchemaAST.AST>,
): JsonSchema => {
  switch (ast._tag) {
    case "StringKeyword":
      return { type: "string" };
    case "NumberKeyword":
      return { type: "number" };
    case "BooleanKeyword":
      return { type: "boolean" };
    case "UnknownKeyword":
    case "AnyKeyword":
      return options.unknownKeywordSchema ?? {};
    case "ObjectKeyword":
      return { type: "object", additionalProperties: true };
    case "Literal":
      return literalJsonSchema(ast.literal, fieldPath, options);
    case "Union": {
      const unionAst = ast as SchemaAST.Union;
      const allLiterals = unionAst.types.every((type) => type._tag === "Literal");
      if (allLiterals) {
        const values = unionAst.types.map((type) => {
          const literal = (type as SchemaAST.Literal).literal;
          if (typeof literal === "bigint") {
            unsupportedConstruct("Literal", fieldPath, options, "bigint literals are not JSON-serializable");
          }
          return literal;
        });
        return { enum: values };
      }
      const nonUndefined = unionAst.types.filter((type) => type._tag !== "UndefinedKeyword");
      if (nonUndefined.length === 1) {
        return astToJsonSchemaInner(nonUndefined[0]!, options, fieldPath, visiting);
      }
      const nullLiteral = nonUndefined.find(
        (type) => type._tag === "Literal" && (type as SchemaAST.Literal).literal === null,
      );
      const nonNull = nonUndefined.filter((type) => type !== nullLiteral);
      if (nullLiteral !== undefined && nonNull.length === 1) {
        const item = astToJsonSchemaInner(nonNull[0]!, options, fieldPath, visiting);
        return { anyOf: [item, { type: "null" }] };
      }
      return unsupportedConstruct(
        "Union",
        fieldPath,
        options,
        `union members: ${unionAst.types.map((type) => type._tag).join(" | ")}`,
      );
    }
    case "TupleType": {
      const tupleAst = ast as SchemaAST.TupleType;
      if (tupleAst.elements.length === 0 && tupleAst.rest.length === 1) {
        return { type: "array", items: astToJsonSchemaInner(tupleAst.rest[0]!.type, options, fieldPath, visiting) };
      }
      return unsupportedConstruct(
        "TupleType",
        fieldPath,
        options,
        `tuple elements=${tupleAst.elements.length}, rest=${tupleAst.rest.length}`,
      );
    }
    case "TypeLiteral": {
      const typeLiteralAst = ast as SchemaAST.TypeLiteral;
      if (typeLiteralAst.indexSignatures.length > 0) {
        unsupportedConstruct("Record", fieldPath, options, "index signatures are not supported");
      }
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const prop of typeLiteralAst.propertySignatures) {
        const name = String(prop.name);
        const childPath = fieldPath.length > 0 ? `${fieldPath}.${name}` : name;
        const property = astToJsonSchemaInner(prop.type, options, childPath, visiting);
        const description = extractDescriptionOrTitle(prop.type);
        if (description) property.description = description;
        properties[name] = property;
        if (!prop.isOptional) required.push(name);
      }
      return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      };
    }
    case "Refinement":
      return unsupportedConstruct("Refinement", fieldPath, options);
    case "Transformation":
      return unsupportedConstruct("Transformation", fieldPath, options);
    case "Suspend": {
      if (visiting.has(ast)) {
        unsupportedConstruct("Suspend", fieldPath, options, "non-terminating recursive schema");
      }
      visiting.add(ast);
      try {
        return astToJsonSchemaInner(ast.f(), options, fieldPath, visiting);
      } finally {
        visiting.delete(ast);
      }
    }
    default:
      return unsupportedConstruct(ast._tag, fieldPath, options);
  }
};

export const astToJsonSchema = (
  ast: SchemaAST.AST,
  options: AstToJsonSchemaOptions = {},
  fieldPath: string = "",
): JsonSchema =>
  astToJsonSchemaInner(ast, options, fieldPath, new Set());

export const jsonSchemaFromEffectSchema = (
  schema: Schema.Schema.AnyNoContext,
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
} as const satisfies AstToJsonSchemaOptions;