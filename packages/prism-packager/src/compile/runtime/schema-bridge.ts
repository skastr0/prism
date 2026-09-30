/** Effect decoding remains the semantic authority for generated native tools. */
import { Schema } from "effect";
import {
  jsonSchemaFromEffectSchema,
  MCP_AST_TO_JSON_SCHEMA_OPTIONS,
} from "../../ast-to-json-schema.js";

export interface ToolRuntimeCost {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  currency?: string;
}

/** Portable context. OpenCode resolves workspace and metadata per execution. */
export interface ToolRuntimeContext {
  sessionID: string;
  agent: string;
  timestamp: string;
  sessionTitle?: string;
  durationMs?: number;
  cost?: ToolRuntimeCost;
  workingDirectory?: string;
  repoRoot?: string;
  signal?: AbortSignal;
}

/** Publish the canonical encoded JSON shape, including strict struct objects. */
export const toolInputFromSchema = (schema: Schema.Top): Record<string, unknown> =>
  jsonSchemaFromEffectSchema(schema, MCP_AST_TO_JSON_SCHEMA_OPTIONS);

/** Reject typos at every struct level, without stripping before Effect decoding. */
export const decodeInput = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  raw: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(raw, { onExcessProperty: "error" });
