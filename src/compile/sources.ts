/**
 * Source types for the current structured compile language.
 *
 * Canonical structured artifacts are TypeScript-authored:
 * - Agent         : agents/*.agent.ts
 * - Trait         : traits/*.trait.ts
 * - Lifecycle     : lifecycles/*.lifecycle.ts
 * - Toolspace     : toolspaces/*.toolspace.ts
 * - Modelspace    : modelspaces/*.modelspace.ts
 *
 * Prose artifacts remain markdown-authored:
 * - Identity      : identities/*.identity.md
 * - Personality   : personalities/*.personality.md
 */

import { Schema } from "effect";

export const TargetId = Schema.String;
export type TargetId = typeof TargetId.Type;

// ---------------------------------------------------------------------------
// Shared refs
// ---------------------------------------------------------------------------

const NamedRefObjectSchema = Schema.Struct({
  plugin: Schema.optional(Schema.String),
  name: Schema.String,
});

export const TraitRefInputSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("trait-ref"),
    plugin: Schema.optional(Schema.String),
    name: Schema.String,
  }),
);
export type TraitRefInput = typeof TraitRefInputSchema.Type;

export const AgentRefInputSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("agent-ref"),
    plugin: Schema.optional(Schema.String),
    name: Schema.String,
  }),
);
export type AgentRefInput = typeof AgentRefInputSchema.Type;

export const LifecycleRefInputSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("lifecycle-ref"),
    plugin: Schema.optional(Schema.String),
    name: Schema.String,
  }),
);
export type LifecycleRefInput = typeof LifecycleRefInputSchema.Type;

export const ToolRefInputSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("tool-ref"),
    plugin: Schema.optional(Schema.String),
    toolspace: Schema.String,
    name: Schema.String,
  }),
);
export type ToolRefInput = typeof ToolRefInputSchema.Type;

export const ToolGroupRefInputSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("tool-group-ref"),
    plugin: Schema.optional(Schema.String),
    toolspace: Schema.String,
    name: Schema.String,
  }),
);
export type ToolGroupRefInput = typeof ToolGroupRefInputSchema.Type;

export const ModelProfileRefInputSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("model-profile-ref"),
    plugin: Schema.optional(Schema.String),
    modelspace: Schema.String,
    name: Schema.String,
  }),
);
export type ModelProfileRefInput = typeof ModelProfileRefInputSchema.Type;

export interface RefNormalizationError {
  readonly field: string;
  readonly message: string;
}

const invalidRef = (field: string, message: string): RefNormalizationError => ({
  field,
  message,
});

const isNonEmpty = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeNamedRefParts = (
  field: string,
  value: string | typeof NamedRefObjectSchema.Type,
): string | RefNormalizationError => {
  if (typeof value === "string") {
    return isNonEmpty(value)
      ? value
      : invalidRef(field, "reference must be a non-empty string");
  }

  if (!isNonEmpty(value.name)) {
    return invalidRef(field, "reference object must include a non-empty 'name'");
  }

  if (value.plugin !== undefined && !isNonEmpty(value.plugin)) {
    return invalidRef(field, "reference object 'plugin' must be non-empty when provided");
  }

  return value.plugin ? `${value.plugin}:${value.name}` : value.name;
};

export const normalizeTraitRefInput = (
  field: string,
  value: TraitRefInput,
): string | RefNormalizationError =>
  typeof value === "string"
    ? normalizeNamedRefParts(field, value)
    : normalizeNamedRefParts(field, { plugin: value.plugin, name: value.name });

export const normalizeAgentRefInput = (
  field: string,
  value: AgentRefInput,
): string | RefNormalizationError =>
  typeof value === "string"
    ? normalizeNamedRefParts(field, value)
    : normalizeNamedRefParts(field, { plugin: value.plugin, name: value.name });

export const normalizeLifecycleRefInput = (
  field: string,
  value: LifecycleRefInput,
): string | RefNormalizationError =>
  typeof value === "string"
    ? normalizeNamedRefParts(field, value)
    : normalizeNamedRefParts(field, { plugin: value.plugin, name: value.name });

export const normalizeToolRefInput = (
  field: string,
  value: ToolRefInput,
): string | RefNormalizationError => {
  if (typeof value === "string") {
    if (!isNonEmpty(value)) {
      return invalidRef(field, "tool ref must be a non-empty string");
    }
    return value;
  }

  if (!isNonEmpty(value.toolspace)) {
    return invalidRef(field, "tool ref object must include a non-empty 'toolspace'");
  }

  if (!isNonEmpty(value.name)) {
    return invalidRef(field, "tool ref object must include a non-empty 'name'");
  }

  if (value.plugin !== undefined && !isNonEmpty(value.plugin)) {
    return invalidRef(field, "tool ref object 'plugin' must be non-empty when provided");
  }

  const head = value.plugin ? `${value.plugin}:${value.toolspace}` : value.toolspace;
  return `${head}/${value.name}`;
};

export const normalizeToolGroupRefInput = (
  field: string,
  value: ToolGroupRefInput,
): string | RefNormalizationError => {
  if (typeof value === "string") {
    if (!isNonEmpty(value)) {
      return invalidRef(field, "tool group ref must be a non-empty string");
    }
    return value;
  }

  if (!isNonEmpty(value.toolspace)) {
    return invalidRef(
      field,
      "tool group ref object must include a non-empty 'toolspace'",
    );
  }

  if (!isNonEmpty(value.name)) {
    return invalidRef(field, "tool group ref object must include a non-empty 'name'");
  }

  if (value.plugin !== undefined && !isNonEmpty(value.plugin)) {
    return invalidRef(
      field,
      "tool group ref object 'plugin' must be non-empty when provided",
    );
  }

  const head = value.plugin ? `${value.plugin}:${value.toolspace}` : value.toolspace;
  return `${head}#${value.name}`;
};

export const normalizeModelProfileRefInput = (
  field: string,
  value: ModelProfileRefInput,
): string | RefNormalizationError => {
  if (typeof value === "string") {
    if (!isNonEmpty(value)) {
      return invalidRef(field, "model profile ref must be a non-empty string");
    }
    return value;
  }

  if (!isNonEmpty(value.modelspace)) {
    return invalidRef(
      field,
      "model profile ref object must include a non-empty 'modelspace'",
    );
  }

  if (!isNonEmpty(value.name)) {
    return invalidRef(
      field,
      "model profile ref object must include a non-empty 'name'",
    );
  }

  if (value.plugin !== undefined && !isNonEmpty(value.plugin)) {
    return invalidRef(
      field,
      "model profile ref object 'plugin' must be non-empty when provided",
    );
  }

  const head = value.plugin ? `${value.plugin}:${value.modelspace}` : value.modelspace;
  return `${head}/${value.name}`;
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const IdentityFrontmatter = Schema.Struct({
  description: Schema.String,
});
export type IdentityFrontmatter = typeof IdentityFrontmatter.Type;

export class Identity extends Schema.Class<Identity>("Identity")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.String,
  body: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Personality
// ---------------------------------------------------------------------------

export const PersonalityFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  temperament: Schema.optional(Schema.String),
  orientation: Schema.optional(Schema.String),
  virtues: Schema.optional(Schema.String),
  integration: Schema.optional(Schema.String),
  communication: Schema.optional(Schema.String),
});
export type PersonalityFrontmatter = typeof PersonalityFrontmatter.Type;

export class Personality extends Schema.Class<Personality>("Personality")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.String,
  temperament: Schema.optional(Schema.String),
  orientation: Schema.optional(Schema.String),
  virtues: Schema.optional(Schema.String),
  integration: Schema.optional(Schema.String),
  communication: Schema.optional(Schema.String),
  body: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Model target blocks
// ---------------------------------------------------------------------------

export const OpenCodeModelTarget = Schema.Struct({
  model: Schema.String,
  variant: Schema.optional(Schema.String),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
});
export type OpenCodeModelTarget = typeof OpenCodeModelTarget.Type;

export const ClaudeCodeModelTarget = Schema.Struct({
  model: Schema.optional(Schema.String),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
});
export type ClaudeCodeModelTarget = typeof ClaudeCodeModelTarget.Type;

// ---------------------------------------------------------------------------
// Shared access intent
// ---------------------------------------------------------------------------

export const AccessSchema = Schema.Struct({
  tools: Schema.optional(Schema.Array(ToolRefInputSchema)),
  toolGroups: Schema.optional(Schema.Array(ToolGroupRefInputSchema)),
});
export type Access = typeof AccessSchema.Type;

export const NormalizedAccessSchema = Schema.Struct({
  tools: Schema.Array(Schema.String),
  toolGroups: Schema.Array(Schema.String),
});
export type NormalizedAccess = typeof NormalizedAccessSchema.Type;

export const SchemaSourceRefSchema = Schema.Struct({
  sourcePath: Schema.String,
  exportName: Schema.String,
});
export type SchemaSourceRef = typeof SchemaSourceRefSchema.Type;

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

export const TraitInjectSchema = Schema.Struct({
  skills: Schema.optional(Schema.Array(Schema.String)),
});
export type TraitInject = typeof TraitInjectSchema.Type;

export const ToolSchemaSlotSchema = Schema.Struct({
  kind: Schema.Literal("schema"),
  description: Schema.optional(Schema.String),
});
export type ToolSchemaSlot = typeof ToolSchemaSlotSchema.Type;

export const ToolSlotSchema = ToolSchemaSlotSchema;
export type ToolSlot = typeof ToolSlotSchema.Type;

export const TraitToolAttachmentSchema = Schema.Struct({
  ref: Schema.String,
});
export type TraitToolAttachment = typeof TraitToolAttachmentSchema.Type;

export const TraitRequireSchema = Schema.Struct({
  tools: Schema.optional(Schema.Array(Schema.String)),
  skills: Schema.optional(Schema.Array(Schema.String)),
});
export type TraitRequire = typeof TraitRequireSchema.Type;

export const TraitInstructionsInputSchema = Schema.Union(
  Schema.String,
  Schema.Array(Schema.String),
);
export type TraitInstructionsInput = typeof TraitInstructionsInputSchema.Type;

export const TraitSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(TraitInstructionsInputSchema),
  access: Schema.optional(AccessSchema),
  tools: Schema.optional(Schema.Record({ key: Schema.String, value: TraitToolAttachmentSchema })),
  inject: Schema.optional(TraitInjectSchema),
  require: Schema.optional(TraitRequireSchema),
});

export const NormalizedTraitToolAttachmentSchema = Schema.Struct({
  ref: Schema.String,
});
export type NormalizedTraitToolAttachment = typeof NormalizedTraitToolAttachmentSchema.Type;

export class Trait extends Schema.Class<Trait>("Trait")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.optional(Schema.String),
  instructions: Schema.Array(Schema.String),
  access: NormalizedAccessSchema,
  tools: Schema.Record({ key: Schema.String, value: NormalizedTraitToolAttachmentSchema }),
  inject: Schema.Struct({
    skills: Schema.Array(Schema.String),
  }),
  require: Schema.Struct({
    tools: Schema.Array(Schema.String),
    skills: Schema.Array(Schema.String),
  }),
}) {}

// ---------------------------------------------------------------------------
// Canonical Tool
// ---------------------------------------------------------------------------

export const CanonicalToolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input: Schema.Unknown,
  output: Schema.Unknown,
  slots: Schema.optional(Schema.Record({ key: Schema.String, value: ToolSlotSchema })),
  handle: Schema.Any,
});
export type CanonicalToolInput = typeof CanonicalToolSchema.Type;

export class CanonicalTool extends Schema.Class<CanonicalTool>("CanonicalTool")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.String,
  input: Schema.Unknown,
  output: Schema.Unknown,
  slots: Schema.Record({ key: Schema.String, value: ToolSlotSchema }),
  handle: Schema.Any,
}) {}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const TraitBindingInputSchema = Schema.Struct({
  kind: Schema.Literal("trait-binding"),
  trait: TraitRefInputSchema,
  tools: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      slots: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    }),
  })),
});
export type TraitBindingInput = typeof TraitBindingInputSchema.Type;

export const NormalizedTraitBindingToolSlotSchema = Schema.Struct({
  schema: Schema.Unknown,
  source: SchemaSourceRefSchema,
});
export type NormalizedTraitBindingToolSlot =
  typeof NormalizedTraitBindingToolSlotSchema.Type;

export const NormalizedTraitBindingToolSchema = Schema.Struct({
  slots: Schema.Record({ key: Schema.String, value: NormalizedTraitBindingToolSlotSchema }),
});
export type NormalizedTraitBindingTool = typeof NormalizedTraitBindingToolSchema.Type;

export const NormalizedTraitBindingSchema = Schema.Struct({
  ref: Schema.String,
  tools: Schema.Record({ key: Schema.String, value: NormalizedTraitBindingToolSchema }),
});
export type NormalizedTraitBinding = typeof NormalizedTraitBindingSchema.Type;

export const AgentSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  identity: Schema.String,
  personality: Schema.optional(Schema.String),
  model: Schema.optional(ModelProfileRefInputSchema),
  traits: Schema.optional(Schema.Array(Schema.Union(TraitRefInputSchema, TraitBindingInputSchema))),
  access: Schema.optional(AccessSchema),
  skills: Schema.optional(Schema.Array(Schema.String)),
  color: Schema.optional(Schema.String),
  targets: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Object }),
  ),
});

export class Agent extends Schema.Class<Agent>("Agent")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.String,
  identity: Schema.String,
  personality: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  traits: Schema.Array(NormalizedTraitBindingSchema),
  access: NormalizedAccessSchema,
  skills: Schema.Array(Schema.String),
  color: Schema.optional(Schema.String),
  targets: Schema.Record({ key: Schema.String, value: Schema.Object }),
}) {}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const GeneratedContractFileSchema = Schema.Struct({
  relativePath: Schema.String,
  content: Schema.String,
});
export type GeneratedContractFile = typeof GeneratedContractFileSchema.Type;

export class Contract extends Schema.Class<Contract>("Contract")({
  name: Schema.String,
  sourcePath: Schema.String,
  pluginName: Schema.String,
  generatedFiles: Schema.optional(Schema.Array(GeneratedContractFileSchema)),
}) {}

// ---------------------------------------------------------------------------
// Toolspace
// ---------------------------------------------------------------------------

export const ToolTargetBindingSchema = Schema.Struct({
  name: Schema.String,
});
export type ToolTargetBinding = typeof ToolTargetBindingSchema.Type;

export const ToolDefinitionSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  targets: Schema.Record({ key: Schema.String, value: ToolTargetBindingSchema }),
});
export type ToolDefinition = typeof ToolDefinitionSchema.Type;

export const ToolGroupSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  tools: Schema.Array(ToolRefInputSchema),
});
export type ToolGroup = typeof ToolGroupSchema.Type;

export const ToolspaceSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  tools: Schema.Record({ key: Schema.String, value: ToolDefinitionSchema }),
  groups: Schema.optional(Schema.Record({ key: Schema.String, value: ToolGroupSchema })),
});

export const NormalizedToolDefinitionSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  targets: Schema.Record({ key: Schema.String, value: Schema.String }),
});
export type NormalizedToolDefinition = typeof NormalizedToolDefinitionSchema.Type;

export const NormalizedToolGroupSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  tools: Schema.Array(Schema.String),
});
export type NormalizedToolGroup = typeof NormalizedToolGroupSchema.Type;

export class Toolspace extends Schema.Class<Toolspace>("Toolspace")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.optional(Schema.String),
  tools: Schema.Record({ key: Schema.String, value: NormalizedToolDefinitionSchema }),
  groups: Schema.Record({ key: Schema.String, value: NormalizedToolGroupSchema }),
}) {}

// ---------------------------------------------------------------------------
// Modelspace
// ---------------------------------------------------------------------------

export const ModelProfileSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  targets: Schema.Record({ key: Schema.String, value: Schema.Object }),
});
export type ModelProfile = typeof ModelProfileSchema.Type;

export const ModelspaceSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  profiles: Schema.Record({ key: Schema.String, value: ModelProfileSchema }),
});

export class Modelspace extends Schema.Class<Modelspace>("Modelspace")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.optional(Schema.String),
  profiles: Schema.Record({ key: Schema.String, value: ModelProfileSchema }),
}) {}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const LifecycleParameterSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
export type LifecycleParameter = typeof LifecycleParameterSchema.Type;

export const LifecycleBindingSchema = Schema.Struct({
  lifecycle: LifecycleRefInputSchema,
  bindings: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});
export type LifecycleBinding = typeof LifecycleBindingSchema.Type;

export const LifecyclePhaseTraitRequirementSchema = Schema.Struct({
  all: Schema.Array(TraitRefInputSchema),
  min: Schema.optional(Schema.Number),
});
export type LifecyclePhaseTraitRequirement =
  typeof LifecyclePhaseTraitRequirementSchema.Type;

export const LifecycleToolGrantToolSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    ref: Schema.String,
    as: Schema.optional(Schema.String),
  }),
);
export type LifecycleToolGrantTool = typeof LifecycleToolGrantToolSchema.Type;

export const LifecycleToolGrantSchema = Schema.Struct({
  agents: Schema.Array(AgentRefInputSchema),
  tools: Schema.Array(LifecycleToolGrantToolSchema),
});
export type LifecycleToolGrant = typeof LifecycleToolGrantSchema.Type;

export const LifecyclePhaseSchema = Schema.Struct({
  name: Schema.String,
  lifecycle: Schema.optional(LifecycleRefInputSchema),
  lifecycle_binding: Schema.optional(LifecycleBindingSchema),
  agents: Schema.optional(Schema.Array(AgentRefInputSchema)),
  agent: Schema.optional(AgentRefInputSchema),
  requires: Schema.optional(Schema.Array(LifecyclePhaseTraitRequirementSchema)),
  notes: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});
export type LifecyclePhase = typeof LifecyclePhaseSchema.Type;

export const NormalizedLifecycleBindingSchema = Schema.Struct({
  lifecycle: Schema.String,
  bindings: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});

export const NormalizedLifecyclePhaseTraitRequirementSchema = Schema.Struct({
  all: Schema.Array(Schema.String),
  min: Schema.optional(Schema.Number),
});
export type NormalizedLifecyclePhaseTraitRequirement =
  typeof NormalizedLifecyclePhaseTraitRequirementSchema.Type;

export const NormalizedLifecyclePhaseSchema = Schema.Struct({
  name: Schema.String,
  lifecycle: Schema.optional(Schema.String),
  lifecycle_binding: Schema.optional(NormalizedLifecycleBindingSchema),
  agent: Schema.optional(Schema.String),
  agents: Schema.Array(Schema.String),
  requires: Schema.Array(NormalizedLifecyclePhaseTraitRequirementSchema),
  notes: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});
export type NormalizedLifecyclePhase = typeof NormalizedLifecyclePhaseSchema.Type;

export const NormalizedLifecycleToolGrantToolSchema = Schema.Struct({
  ref: Schema.String,
  logicalName: Schema.String,
});
export type NormalizedLifecycleToolGrantTool =
  typeof NormalizedLifecycleToolGrantToolSchema.Type;

export const NormalizedLifecycleToolGrantSchema = Schema.Struct({
  agents: Schema.Array(Schema.String),
  tools: Schema.Array(NormalizedLifecycleToolGrantToolSchema),
});
export type NormalizedLifecycleToolGrant =
  typeof NormalizedLifecycleToolGrantSchema.Type;

export const LifecycleTasteCheckpointSchema = Schema.Struct({
  after: Schema.optional(Schema.String),
  before: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});
export type LifecycleTasteCheckpoint = typeof LifecycleTasteCheckpointSchema.Type;

export const LifecycleDefinitionSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  produces: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Array(LifecycleParameterSchema)),
  phases: Schema.Array(LifecyclePhaseSchema),
  tool_grants: Schema.optional(Schema.Array(LifecycleToolGrantSchema)),
  taste_checkpoints: Schema.optional(Schema.Array(LifecycleTasteCheckpointSchema)),
  evolution: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
});
export type LifecycleDefinition = typeof LifecycleDefinitionSchema.Type;

export class Lifecycle extends Schema.Class<Lifecycle>("Lifecycle")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.String,
  produces: Schema.optional(Schema.String),
  parameters: Schema.Array(LifecycleParameterSchema),
  phases: Schema.Array(NormalizedLifecyclePhaseSchema),
  tool_grants: Schema.Array(NormalizedLifecycleToolGrantSchema),
  taste_checkpoints: Schema.Array(LifecycleTasteCheckpointSchema),
  evolution: Schema.optional(Schema.String),
  body: Schema.String,
}) {}
