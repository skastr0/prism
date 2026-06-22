import { Schema, SchemaAST } from "effect";

export type WorkflowJsonSchema = Record<string, unknown>;

export class WorkflowOutputSchemaError extends Error {
  override readonly name = "WorkflowOutputSchemaError";
}

const extractStringAnnotation = (
  ast: SchemaAST.AST,
  annotationId: symbol,
): string | undefined => {
  const annotation = SchemaAST.getAnnotation<string>(annotationId)(ast);
  return annotation._tag === "Some" ? annotation.value : undefined;
};

const extractDescriptionOrTitle = (ast: SchemaAST.AST): string | undefined =>
  extractStringAnnotation(ast, SchemaAST.DescriptionAnnotationId) ??
  extractStringAnnotation(ast, SchemaAST.TitleAnnotationId);

const unsupportedAst = (ast: SchemaAST.AST, detail?: string): never => {
  throw new WorkflowOutputSchemaError(
    `workflow output schema: unsupported AST tag: ${ast._tag}${detail ? ` (${detail})` : ""}`,
  );
};

const astToJsonSchema = (ast: SchemaAST.AST): WorkflowJsonSchema => {
  switch (ast._tag) {
    case "StringKeyword":
      return { type: "string" };
    case "NumberKeyword":
      return { type: "number" };
    case "BooleanKeyword":
      return { type: "boolean" };
    case "UnknownKeyword":
    case "AnyKeyword":
      return {};
    case "ObjectKeyword":
      return { type: "object", additionalProperties: true };
    case "Literal": {
      if (typeof ast.literal === "bigint") unsupportedAst(ast, "bigint literals are not JSON-serializable");
      return { enum: [ast.literal] };
    }
    case "Union": {
      const unionAst = ast as SchemaAST.Union;
      const allLiterals = unionAst.types.every((type) => type._tag === "Literal");
      if (allLiterals) {
        const values = unionAst.types.map((type) => {
          const literal = (type as SchemaAST.Literal).literal;
          if (typeof literal === "bigint") unsupportedAst(type, "bigint literals are not JSON-serializable");
          return literal;
        });
        return { enum: values };
      }
      const nonUndefined = unionAst.types.filter((type) => type._tag !== "UndefinedKeyword");
      if (nonUndefined.length === 1) return astToJsonSchema(nonUndefined[0]!);
      return unsupportedAst(unionAst, `union members: ${unionAst.types.map((type) => type._tag).join(" | ")}`);
    }
    case "TupleType": {
      const tupleAst = ast as SchemaAST.TupleType;
      if (tupleAst.elements.length === 0 && tupleAst.rest.length === 1) {
        return { type: "array", items: astToJsonSchema(tupleAst.rest[0]!.type) };
      }
      return unsupportedAst(tupleAst, `tuple elements=${tupleAst.elements.length}, rest=${tupleAst.rest.length}`);
    }
    case "TypeLiteral": {
      const typeLiteralAst = ast as SchemaAST.TypeLiteral;
      const properties: Record<string, WorkflowJsonSchema> = {};
      const required: string[] = [];
      for (const prop of typeLiteralAst.propertySignatures) {
        const property = astToJsonSchema(prop.type);
        const description = extractDescriptionOrTitle(prop.type);
        if (description) property.description = description;
        const name = String(prop.name);
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
      return astToJsonSchema(ast.from);
    case "Transformation":
      return astToJsonSchema(ast.from);
    case "Suspend":
      return astToJsonSchema(ast.f());
    default:
      return unsupportedAst(ast);
  }
};

export const workflowJsonSchemaFromEffectSchema = (
  schema: Schema.Schema.AnyNoContext,
): WorkflowJsonSchema =>
  astToJsonSchema(schema.ast);

export const tryWorkflowJsonSchemaFromEffectSchema = (
  schema: Schema.Schema.AnyNoContext,
): WorkflowJsonSchema | undefined => {
  try {
    return workflowJsonSchemaFromEffectSchema(schema);
  } catch (error) {
    if (error instanceof WorkflowOutputSchemaError) return undefined;
    throw error;
  }
};
