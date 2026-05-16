/**
 * Schema bridge: converts Effect Schema → the record of tool.schema builders
 * that opencode's `tool({ args })` expects. Ships verbatim into every
 * generated plugin at src/runtime/schema-bridge.ts.
 *
 * Supports the bounded schema feature set used in contracts:
 *
 *   - StringKeyword, NumberKeyword, BooleanKeyword, UnknownKeyword
 *   - Literal (single) and Union of Literals (enum)
 *   - TupleType with rest (arrays)
 *   - TypeLiteral (nested structs)
 *   - Refinement and Transformation (unwrapped; brands preserved via description)
 *   - optional fields
 *
 * Annotations flow through: a field's Schema.annotations({ description }) is
 * emitted as .describe(...) on the tool schema node so the LLM sees the
 * contract's own documentation.
 */

import { tool } from "@opencode-ai/plugin";
import { Schema, SchemaAST } from "effect";

type ZodNode = Parameters<(typeof tool.schema)["array"]>[0] & {
  describe(description: string): ZodNode;
  optional(): ZodNode;
};

export interface ToolRuntimeCost {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  currency?: string;
}

/**
 * Runtime context passed to synthetic contract handlers.
 *
 * The generated OpenCode adapter always provides `sessionID`, `agent`, and
 * `timestamp`. Additional metadata stays optional so contract authors can
 * tolerate harnesses that do not expose the richer fields yet.
 */
export interface ToolRuntimeContext {
  // Core identity
  sessionID: string;
  agent: string;

  // Time
  timestamp: string;

  // Session metadata (may be undefined if not provided by the harness)
  sessionTitle?: string;
  durationMs?: number;

  // Usage metadata (may be undefined)
  cost?: ToolRuntimeCost;

  // Workspace context (may be undefined across harnesses)
  // OpenCode currently normalizes `directory` -> `workingDirectory`
  // and `worktree` -> `repoRoot`.
  workingDirectory?: string;
  repoRoot?: string;
}

const extractStringAnnotation = (
  ast: SchemaAST.AST,
  annotationId: symbol,
): string | undefined => {
  const annotation = SchemaAST.getAnnotation<string>(annotationId)(ast);
  return annotation._tag === "Some" ? annotation.value : undefined;
};

type SchemaPropertySignature = SchemaAST.TypeLiteral["propertySignatures"][number];

const firstStringAnnotation = (
  ast: SchemaAST.AST,
  annotationIds: readonly symbol[],
): string | undefined => {
  for (const annotationId of annotationIds) {
    const annotation = extractStringAnnotation(ast, annotationId);
    if (annotation !== undefined) return annotation;
  }
  return undefined;
};

const astToToolSchema = (ast: SchemaAST.AST): ZodNode => {
  const primitiveNode = primitiveAstToToolSchema(ast);
  if (primitiveNode) return primitiveNode;

  switch (ast._tag) {
    case "Union":
      return unionAstToToolSchema(ast);
    case "TupleType":
      return tupleAstToArraySchema(ast);
    case "TypeLiteral":
      return typeLiteralAstToObjectSchema(ast, [SchemaAST.DescriptionAnnotationId]);
    case "Refinement":
    case "Transformation":
      return astToToolSchema(ast.from);
    case "Suspend":
      return astToToolSchema(ast.f());
    default:
      throw unsupportedAstError(ast);
  }
};

const primitiveAstToToolSchema = (ast: SchemaAST.AST): ZodNode | undefined => {
  switch (ast._tag) {
    case "StringKeyword":
      return tool.schema.string();
    case "NumberKeyword":
      return tool.schema.number();
    case "BooleanKeyword":
      return tool.schema.boolean();
    case "UnknownKeyword":
      return tool.schema.object({}).catchall(tool.schema.unknown());
    case "Literal":
      return tool.schema.literal(ast.literal as string | number | boolean);
    default:
      return undefined;
  }
};

const unionAstToToolSchema = (ast: SchemaAST.Union): ZodNode => {
  if (isLiteralUnion(ast)) return literalUnionAstToEnumSchema(ast);

  const optionalInner = optionalUnionInnerType(ast);
  if (optionalInner) return astToToolSchema(optionalInner);

  throw unsupportedUnionError(ast);
};

const isLiteralUnion = (ast: SchemaAST.Union): boolean =>
  ast.types.every((type) => type._tag === "Literal");

const literalUnionAstToEnumSchema = (ast: SchemaAST.Union): ZodNode => {
  const values = ast.types.map((type) => (type as SchemaAST.Literal).literal) as ReadonlyArray<
    string
  >;
  return tool.schema.enum(values as [string, ...string[]]);
};

const optionalUnionInnerType = (
  ast: SchemaAST.Union,
): SchemaAST.AST | undefined => {
  const nonUndefined = ast.types.filter((type) => type._tag !== "UndefinedKeyword");
  return nonUndefined.length === 1 ? nonUndefined[0] : undefined;
};

const tupleAstToArraySchema = (ast: SchemaAST.TupleType): ZodNode => {
  if (ast.elements.length === 0 && ast.rest.length === 1) {
    return tool.schema.array(astToToolSchema(ast.rest[0]!.type));
  }
  throw new Error("schema-bridge: only simple arrays are supported (TupleType with single rest)");
};

const typeLiteralAstToObjectSchema = (
  ast: SchemaAST.TypeLiteral,
  annotationIds: readonly symbol[],
): ZodNode => {
  const shape: Record<string, ZodNode> = {};
  for (const prop of ast.propertySignatures) {
    shape[String(prop.name)] = propertySignatureToToolSchema(prop, annotationIds);
  }
  return tool.schema.object(shape);
};

const propertySignatureToToolSchema = (
  prop: SchemaPropertySignature,
  annotationIds: readonly symbol[],
): ZodNode => {
  let node = astToToolSchema(prop.type);
  const desc = firstStringAnnotation(prop.type, annotationIds);
  if (desc) node = node.describe(desc);
  if (prop.isOptional) node = node.optional();
  return node;
};

const unsupportedUnionError = (ast: SchemaAST.Union): Error =>
  new Error(
    `schema-bridge: only unions of literals or optional-wrapped types are supported, got ${ast.types
      .map((type) => type._tag)
      .join(" | ")}`,
  );

const unsupportedAstError = (ast: SchemaAST.AST): Error =>
  new Error(`schema-bridge: unsupported AST tag: ${ast._tag}`);

/**
 * Convert a top-level Schema.Struct to the args record opencode expects.
 * Throws at plugin load time if the top-level schema is not a struct.
 */
export const toolArgsFromSchema = (
  schema: Schema.Schema.Any,
): Record<string, ZodNode> => {
  const ast = schema.ast;
  // Schema.extend produces a TypeLiteral; Schema.Struct produces a TypeLiteral.
  if (ast._tag !== "TypeLiteral") {
    throw new Error(
      `schema-bridge: top-level contract Input must be a Schema.Struct, got ${ast._tag}`,
    );
  }
  const result: Record<string, ZodNode> = {};
  for (const prop of ast.propertySignatures) {
    result[String(prop.name)] = propertySignatureToToolSchema(prop, [
      SchemaAST.DescriptionAnnotationId,
      SchemaAST.TitleAnnotationId,
    ]);
  }
  return result;
};

/**
 * Decode raw tool-call args against the contract's Input schema. Throws a
 * clear error if decoding fails; the error propagates back to the LLM as the
 * tool call's failure message.
 */
export const decodeInput = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  raw: unknown,
): A => {
  return Schema.decodeUnknownSync(schema as Schema.Schema<A, I, never>)(raw);
};
