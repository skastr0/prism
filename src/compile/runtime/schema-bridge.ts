/**
 * Schema bridge: converts Effect Schema → the record of tool.schema builders
 * that opencode's `tool({ args })` expects. Ships verbatim into every
 * generated plugin at src/runtime/schema-bridge.ts.
 *
 * Supports the bounded schema feature set used in contracts:
 *
 *   - String, Number, Boolean, Null
 *   - Unknown, Any (rendered honestly as z.unknown(): any JSON value)
 *   - Literal (single), Union of Literals (enum), and general unions (z.union)
 *   - Arrays with a single rest element (arrays)
 *   - Objects (nested structs), including optional fields
 *   - Records (`Schema.Record`) including mixed struct+index objects (catchall)
 *   - checks (refinements) and encodings (transformations) are rendered as
 *     their wire shape
 *   - nominal brands add no runtime validation and are not emitted
 *
 * A field's Schema.annotate({ description }) is emitted as .describe(...) on the
 * tool schema node so the LLM sees the contract's own documentation.
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

  // Cancellation propagated by transports that support it, including MCP SDK.
  signal?: AbortSignal;
}

/** Annotation kinds the bridge reads, in the order they take precedence. */
type AnnotationKind = "description" | "title";

const annotationText = (
  ast: SchemaAST.AST,
  kinds: readonly AnnotationKind[],
): string | undefined => {
  for (const kind of kinds) {
    const value = kind === "description"
      ? SchemaAST.resolveDescription(ast)
      : SchemaAST.resolveTitle(ast);
    if (value !== undefined) return value;
  }
  return undefined;
};

type SchemaPropertySignature = SchemaAST.Objects["propertySignatures"][number];

/**
 * A node's encoded side is its wire shape; refinements and transformations do
 * not change the JSON an LLM sends, so the bridge renders that shape.
 */
const encodedAstOf = (ast: SchemaAST.AST): SchemaAST.AST =>
  ast.encoding === undefined ? ast : encodedAstOf(ast.encoding[ast.encoding.length - 1]!.to);

const astToToolSchema = (ast: SchemaAST.AST): ZodNode => {
  const target = encodedAstOf(ast);
  const primitiveNode = primitiveAstToToolSchema(target);
  if (primitiveNode) return primitiveNode;

  if (SchemaAST.isUnion(target)) return unionAstToToolSchema(target);
  if (SchemaAST.isArrays(target)) return tupleAstToArraySchema(target);
  if (SchemaAST.isObjects(target)) return typeLiteralAstToObjectSchema(target, ["description"]);
  if (SchemaAST.isSuspend(target)) return astToToolSchema(target.thunk());
  throw unsupportedAstError(target);
};

const primitiveAstToToolSchema = (ast: SchemaAST.AST): ZodNode | undefined => {
  if (SchemaAST.isString(ast)) return tool.schema.string();
  if (SchemaAST.isNumber(ast)) return tool.schema.number();
  if (SchemaAST.isBoolean(ast)) return tool.schema.boolean();
  // Unknown/Any on the wire means any JSON value; an object-only mapping would
  // wrongly reject scalars and arrays. decodeInput stays the semantic authority.
  if (SchemaAST.isUnknown(ast) || SchemaAST.isAny(ast)) return tool.schema.unknown();
  if (SchemaAST.isNull(ast)) return tool.schema.null();
  if (SchemaAST.isLiteral(ast)) {
    if (ast.literal === null) return tool.schema.null();
    return tool.schema.literal(ast.literal as string | number | boolean);
  }
  return undefined;
};

const unionAstToToolSchema = (ast: SchemaAST.Union): ZodNode => {
  if (isLiteralUnion(ast)) return literalUnionAstToEnumSchema(ast);

  const nonUndefined = ast.types.filter((type) => !SchemaAST.isUndefined(type));
  if (nonUndefined.length === 1) return astToToolSchema(nonUndefined[0]!);
  if (nonUndefined.length === 0) throw unsupportedUnionError(ast);
  // General unions (e.g. discriminated question variants): z.union validates in
  // member order, matching Effect's Union semantics.
  return tool.schema.union(
    nonUndefined.map((type) => astToToolSchema(type)) as [ZodNode, ZodNode, ...ZodNode[]],
  );
};

const isLiteralUnion = (ast: SchemaAST.Union): boolean =>
  ast.types.every((type) => SchemaAST.isLiteral(type) && type.literal !== null);

const literalUnionAstToEnumSchema = (ast: SchemaAST.Union): ZodNode => {
  const values = ast.types.map((type) => (type as SchemaAST.Literal).literal) as ReadonlyArray<
    string
  >;
  return tool.schema.enum(values as [string, ...string[]]);
};

const tupleAstToArraySchema = (ast: SchemaAST.Arrays): ZodNode => {
  // A simple array has no fixed elements and exactly one rest element, which is
  // the element AST itself (not a `{ type }` wrapper as in v3).
  if (ast.elements.length === 0 && ast.rest.length === 1) {
    return tool.schema.array(astToToolSchema(ast.rest[0]!));
  }
  throw new Error("schema-bridge: only simple arrays are supported (a single rest element)");
};

const typeLiteralAstToObjectSchema = (
  ast: SchemaAST.Objects,
  annotationKinds: readonly AnnotationKind[],
): ZodNode => {
  const index = ast.indexSignatures[0];
  // Pure record (Schema.Record): an open string-keyed value map.
  if (index !== undefined && ast.propertySignatures.length === 0) {
    return tool.schema.record(tool.schema.string(), astToToolSchema(index.type));
  }
  const shape: Record<string, ZodNode> = {};
  for (const prop of ast.propertySignatures) {
    shape[String(prop.name)] = propertySignatureToToolSchema(prop, annotationKinds);
  }
  const objectNode = tool.schema.object(shape);
  // Mixed struct + index: fixed properties plus a catchall for extra keys.
  if (index !== undefined) {
    type CatchallObject = ZodNode & { catchall(value: ZodNode): ZodNode };
    return (objectNode as CatchallObject).catchall(astToToolSchema(index.type));
  }
  // Pure struct: reject unknown keys so a misspelled field surfaces as a
  // validation error instead of being silently stripped before decodeInput.
  type StrictObject = ZodNode & { strict(): ZodNode };
  return (objectNode as StrictObject).strict();
};

const propertySignatureToToolSchema = (
  prop: SchemaPropertySignature,
  annotationKinds: readonly AnnotationKind[],
): ZodNode => {
  let node = astToToolSchema(prop.type);
  const desc = annotationText(prop.type, annotationKinds);
  if (desc) node = node.describe(desc);
  if (SchemaAST.isOptional(prop.type)) node = node.optional();
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
  schema: Schema.Top,
): Record<string, ZodNode> => {
  const ast = encodedAstOf(schema.ast);
  // Schema.Struct and Schema.extend both produce an object node.
  if (!SchemaAST.isObjects(ast)) {
    throw new Error(
      `schema-bridge: top-level contract Input must be a Schema.Struct, got ${ast._tag}`,
    );
  }
  const result: Record<string, ZodNode> = {};
  for (const prop of ast.propertySignatures) {
    result[String(prop.name)] = propertySignatureToToolSchema(prop, ["description", "title"]);
  }
  return result;
};

/**
 * Decode raw tool-call args against the contract's Input schema. Throws a
 * clear error if decoding fails; the error propagates back to the LLM as the
 * tool call's failure message. Strict on excess properties: a misspelled
 * field is a typo to surface, not noise to strip.
 */
export const decodeInput = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  raw: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(raw, { onExcessProperty: "error" });
