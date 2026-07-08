import type { Schema } from "effect";
import {
  jsonSchemaFromEffectSchema,
  WorkflowOutputSchemaError,
  WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS,
  type JsonSchema as WorkflowJsonSchema,
} from "./ast-to-json-schema.js";

export { WorkflowOutputSchemaError };
export type { WorkflowJsonSchema };

export const workflowJsonSchemaFromEffectSchema = (
  schema: Schema.Schema.AnyNoContext,
): WorkflowJsonSchema =>
  jsonSchemaFromEffectSchema(schema, WORKFLOW_AST_TO_JSON_SCHEMA_OPTIONS);

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