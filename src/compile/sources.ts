/**
 * Source types for the current structured compile language.
 *
 * Canonical structured artifacts are TypeScript-authored:
 * - Agent         : agents/*.agent.ts
 * - Trait         : traits/*.trait.ts
 * - Orbit     : orbits/*.orbit.ts
 * - Toolspace     : toolspaces/*.toolspace.ts
 * - Modelspace    : modelspaces/*.modelspace.ts
 * - Skillspace    : skillspaces/*.skillspace.ts
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

export const OrbitRefInputSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("orbit-ref"),
    plugin: Schema.optional(Schema.String),
    name: Schema.String,
  }),
);
export type OrbitRefInput = typeof OrbitRefInputSchema.Type;

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

export const SkillRefInputSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("skill-ref"),
    plugin: Schema.optional(Schema.String),
    name: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("skillspace-ref"),
    plugin: Schema.optional(Schema.String),
    skillspace: Schema.String,
    name: Schema.String,
  }),
);
export type SkillRefInput = typeof SkillRefInputSchema.Type;

// ---------------------------------------------------------------------------
// Hook refs, events, payloads, and results
// ---------------------------------------------------------------------------

export const HookEventSchema = Schema.Literal(
  "tool.before",
  "tool.after",
  "session.start",
  "session.end",
);
export type HookEvent = typeof HookEventSchema.Type;

export const HookToolMatcherInputSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("hook-any-tool") }),
  Schema.Struct({
    kind: Schema.Literal("hook-toolspace-tool"),
    tool: ToolRefInputSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("hook-toolspace-group"),
    group: ToolGroupRefInputSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("hook-canonical-tool"),
    ref: Schema.String,
  }),
);
export type HookToolMatcherInput = typeof HookToolMatcherInputSchema.Type;

export const HookMatchInputSchema = Schema.Struct({
  tool: Schema.optional(HookToolMatcherInputSchema),
});
export type HookMatchInput = typeof HookMatchInputSchema.Type;

export const NormalizedHookToolMatcherSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("any") }),
  Schema.Struct({
    kind: Schema.Literal("toolspace-tool"),
    ref: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("toolspace-group"),
    ref: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("canonical-tool"),
    ref: Schema.String,
  }),
);
export type NormalizedHookToolMatcher = typeof NormalizedHookToolMatcherSchema.Type;

export const NormalizedHookMatchSchema = Schema.Struct({
  tool: Schema.optional(NormalizedHookToolMatcherSchema),
});
export type NormalizedHookMatch = typeof NormalizedHookMatchSchema.Type;

export const HookDefinitionSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  event: HookEventSchema,
  match: Schema.optional(HookMatchInputSchema),
  handle: Schema.Any,
});
export type HookDefinition = typeof HookDefinitionSchema.Type;

export const HookTargetContextSchema = Schema.Struct({
  harness: Schema.String,
  nativeEvent: Schema.String,
});
export type HookTargetContext = typeof HookTargetContextSchema.Type;

export const HookSessionContextSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  transcriptPath: Schema.optional(Schema.String),
});
export type HookSessionContext = typeof HookSessionContextSchema.Type;

export const HookToolContextSchema = Schema.Struct({
  logical: Schema.optional(Schema.String),
  nativeName: Schema.String,
  input: Schema.Unknown,
});
export type HookToolContext = typeof HookToolContextSchema.Type;

export const ToolBeforeEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("tool.before"),
  target: HookTargetContextSchema,
  tool: HookToolContextSchema,
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
});
export type ToolBeforeEventPayload = typeof ToolBeforeEventPayloadSchema.Type;

export const ToolAfterEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("tool.after"),
  target: HookTargetContextSchema,
  tool: Schema.extend(
    HookToolContextSchema,
    Schema.Struct({
      output: Schema.Unknown,
      success: Schema.optional(Schema.Boolean),
    }),
  ),
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
});
export type ToolAfterEventPayload = typeof ToolAfterEventPayloadSchema.Type;

export const SessionStartEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("session.start"),
  target: HookTargetContextSchema,
  cwd: Schema.optional(Schema.String),
  session: HookSessionContextSchema,
});
export type SessionStartEventPayload = typeof SessionStartEventPayloadSchema.Type;

export const SessionEndEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("session.end"),
  target: HookTargetContextSchema,
  cwd: Schema.optional(Schema.String),
  session: HookSessionContextSchema,
  reason: Schema.optional(Schema.String),
});
export type SessionEndEventPayload = typeof SessionEndEventPayloadSchema.Type;

export const HookEventPayloadSchema = Schema.Union(
  ToolBeforeEventPayloadSchema,
  ToolAfterEventPayloadSchema,
  SessionStartEventPayloadSchema,
  SessionEndEventPayloadSchema,
);
export type HookEventPayload = typeof HookEventPayloadSchema.Type;

const NativeToolBeforeContextSchema = Schema.Struct({
  logical: Schema.optional(Schema.String),
  name: Schema.String,
  input: Schema.Unknown,
});

const NativeToolAfterContextSchema = Schema.Struct({
  logical: Schema.optional(Schema.String),
  name: Schema.String,
  input: Schema.Unknown,
  output: Schema.Unknown,
  success: Schema.optional(Schema.Boolean),
});

export const NativeToolBeforeHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    tool: NativeToolBeforeContextSchema,
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
  }),
  ToolBeforeEventPayloadSchema,
  {
    decode: (native) => ({
      event: "tool.before" as const,
      target: native.target,
      tool: {
        logical: native.tool.logical,
        nativeName: native.tool.name,
        input: native.tool.input,
      },
      cwd: native.cwd,
      session: native.session,
    }),
    encode: (payload) => ({
      target: payload.target,
      tool: {
        logical: payload.tool.logical,
        name: payload.tool.nativeName,
        input: payload.tool.input,
      },
      cwd: payload.cwd,
      session: payload.session,
    }),
  },
);
export type NativeToolBeforeHookPayload = typeof NativeToolBeforeHookPayloadSchema.Type;

export const NativeToolAfterHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    tool: NativeToolAfterContextSchema,
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
  }),
  ToolAfterEventPayloadSchema,
  {
    decode: (native) => ({
      event: "tool.after" as const,
      target: native.target,
      tool: {
        logical: native.tool.logical,
        nativeName: native.tool.name,
        input: native.tool.input,
        output: native.tool.output,
        success: native.tool.success,
      },
      cwd: native.cwd,
      session: native.session,
    }),
    encode: (payload) => ({
      target: payload.target,
      tool: {
        logical: payload.tool.logical,
        name: payload.tool.nativeName,
        input: payload.tool.input,
        output: payload.tool.output,
        success: payload.tool.success,
      },
      cwd: payload.cwd,
      session: payload.session,
    }),
  },
);
export type NativeToolAfterHookPayload = typeof NativeToolAfterHookPayloadSchema.Type;

export const NativeSessionStartHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    cwd: Schema.optional(Schema.String),
    session: HookSessionContextSchema,
  }),
  SessionStartEventPayloadSchema,
  {
    decode: (native) => ({
      event: "session.start" as const,
      target: native.target,
      cwd: native.cwd,
      session: native.session,
    }),
    encode: (payload) => ({
      target: payload.target,
      cwd: payload.cwd,
      session: payload.session,
    }),
  },
);
export type NativeSessionStartHookPayload = typeof NativeSessionStartHookPayloadSchema.Type;

export const NativeSessionEndHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    cwd: Schema.optional(Schema.String),
    session: HookSessionContextSchema,
    reason: Schema.optional(Schema.String),
  }),
  SessionEndEventPayloadSchema,
  {
    decode: (native) => ({
      event: "session.end" as const,
      target: native.target,
      cwd: native.cwd,
      session: native.session,
      reason: native.reason,
    }),
    encode: (payload) => ({
      target: payload.target,
      cwd: payload.cwd,
      session: payload.session,
      reason: payload.reason,
    }),
  },
);
export type NativeSessionEndHookPayload = typeof NativeSessionEndHookPayloadSchema.Type;

export const NativeHookPayloadSchema = Schema.Union(
  NativeToolBeforeHookPayloadSchema,
  NativeToolAfterHookPayloadSchema,
  NativeSessionStartHookPayloadSchema,
  NativeSessionEndHookPayloadSchema,
);
export type NativeHookPayload = typeof NativeHookPayloadSchema.Type;

export const ToolBeforeHookResultSchema = Schema.Union(
  Schema.Struct({ decision: Schema.Literal("continue") }),
  Schema.Struct({ decision: Schema.Literal("block"), message: Schema.String }),
);
export type ToolBeforeHookResult = typeof ToolBeforeHookResultSchema.Type;

export const ContinueHookResultSchema = Schema.Struct({
  decision: Schema.Literal("continue"),
});
export type ContinueHookResult = typeof ContinueHookResultSchema.Type;

export const ObservationalHookResultSchema = ContinueHookResultSchema;
export type ObservationalHookResult = ContinueHookResult;

export const HookEventResultSchema = Schema.Union(
  Schema.Struct({
    event: Schema.Literal("tool.before"),
    result: ToolBeforeHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("tool.after"),
    result: ObservationalHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("session.start"),
    result: ObservationalHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("session.end"),
    result: ObservationalHookResultSchema,
  }),
);
export type HookEventResult = typeof HookEventResultSchema.Type;

export const HookResultSchema = Schema.Union(
  ToolBeforeHookResultSchema,
  ObservationalHookResultSchema,
);
export type HookResult = typeof HookResultSchema.Type;

export const hookResultSchemaForEvent = (
  event: HookEvent,
): Schema.Schema.AnyNoContext =>
  event === "tool.before" ? ToolBeforeHookResultSchema : ObservationalHookResultSchema;

export const decodeHookResultForEvent = (event: HookEvent, result: unknown) =>
  Schema.decodeUnknownEither(hookResultSchemaForEvent(event))(result);

export const nativeHookPayloadSchemaForEvent = (
  event: HookEvent,
): Schema.Schema.AnyNoContext => {
  switch (event) {
    case "tool.before":
      return NativeToolBeforeHookPayloadSchema;
    case "tool.after":
      return NativeToolAfterHookPayloadSchema;
    case "session.start":
      return NativeSessionStartHookPayloadSchema;
    case "session.end":
      return NativeSessionEndHookPayloadSchema;
  }
};

export const decodeNativeHookPayloadForEvent = (event: HookEvent, payload: unknown) =>
  Schema.decodeUnknownEither(nativeHookPayloadSchemaForEvent(event))(payload);

export class Hook extends Schema.Class<Hook>("Hook")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.optional(Schema.String),
  event: HookEventSchema,
  match: NormalizedHookMatchSchema,
  handle: Schema.Any,
}) {}

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

export const normalizeOrbitRefInput = (
  field: string,
  value: OrbitRefInput,
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

export const normalizeSkillRefInput = (
  field: string,
  value: SkillRefInput,
): string | RefNormalizationError => {
  if (typeof value === "string") {
    return invalidRef(
      field,
      "plain skill strings are not allowed; use skillRef(...) for managed plugin skills or skillspaceRef(...) for harness-native skills",
    );
  }

  if (value.kind === "skill-ref") {
    if (!isNonEmpty(value.name)) {
      return invalidRef(field, "skill ref object must include a non-empty 'name'");
    }

    if (value.plugin !== undefined && !isNonEmpty(value.plugin)) {
      return invalidRef(field, "skill ref object 'plugin' must be non-empty when provided");
    }

    return value.plugin ? `${value.plugin}:${value.name}` : value.name;
  }

  if (!isNonEmpty(value.skillspace)) {
    return invalidRef(
      field,
      "skillspace ref object must include a non-empty 'skillspace'",
    );
  }

  if (!isNonEmpty(value.name)) {
    return invalidRef(
      field,
      "skillspace ref object must include a non-empty 'name'",
    );
  }

  if (value.plugin !== undefined && !isNonEmpty(value.plugin)) {
    return invalidRef(
      field,
      "skillspace ref object 'plugin' must be non-empty when provided",
    );
  }

  const head = value.plugin ? `${value.plugin}:${value.skillspace}` : value.skillspace;
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
  skills: Schema.optional(Schema.Array(SkillRefInputSchema)),
});
export type Access = typeof AccessSchema.Type;

export const NormalizedAccessSchema = Schema.Struct({
  tools: Schema.Array(Schema.String),
  toolGroups: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.String),
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
  skills: Schema.optional(Schema.Array(SkillRefInputSchema)),
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
  skills: Schema.optional(Schema.Array(SkillRefInputSchema)),
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
  skills: Schema.optional(Schema.Array(SkillRefInputSchema)),
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
// Skillspace
// ---------------------------------------------------------------------------

export class Skill extends Schema.Class<Skill>("Skill")({
  name: Schema.String,
  sourcePath: Schema.String,
}) {}

export const SkillTargetBindingSchema = Schema.Struct({
  name: Schema.String,
});
export type SkillTargetBinding = typeof SkillTargetBindingSchema.Type;

export const SkillDefinitionSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  targets: Schema.Record({ key: Schema.String, value: SkillTargetBindingSchema }),
});
export type SkillDefinition = typeof SkillDefinitionSchema.Type;

export const SkillspaceSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  skills: Schema.Record({ key: Schema.String, value: SkillDefinitionSchema }),
});
export type SkillspaceInput = typeof SkillspaceSchema.Type;

export class Skillspace extends Schema.Class<Skillspace>("Skillspace")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.optional(Schema.String),
  skills: Schema.Record({ key: Schema.String, value: SkillDefinitionSchema }),
}) {}

// ---------------------------------------------------------------------------
// Orbit
// ---------------------------------------------------------------------------

export const OrbitParameterSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
export type OrbitParameter = typeof OrbitParameterSchema.Type;

export const OrbitBindingSchema = Schema.Struct({
  orbit: OrbitRefInputSchema,
  bindings: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});
export type OrbitBinding = typeof OrbitBindingSchema.Type;

export const OrbitPhaseTraitRequirementSchema = Schema.Struct({
  all: Schema.Array(TraitRefInputSchema),
  min: Schema.optional(Schema.Number),
});
export type OrbitPhaseTraitRequirement =
  typeof OrbitPhaseTraitRequirementSchema.Type;

export const OrbitToolPermissionToolSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    ref: Schema.String,
    as: Schema.optional(Schema.String),
  }),
);
export type OrbitToolPermissionTool = typeof OrbitToolPermissionToolSchema.Type;

export const OrbitOrchestratorSchema = Schema.Struct({
  agent: AgentRefInputSchema,
  tools: Schema.Array(OrbitToolPermissionToolSchema),
});
export type OrbitOrchestrator = typeof OrbitOrchestratorSchema.Type;

export const OrbitPhaseSchema = Schema.Struct({
  name: Schema.String,
  orbit: Schema.optional(OrbitRefInputSchema),
  orbit_binding: Schema.optional(OrbitBindingSchema),
  agents: Schema.optional(Schema.Array(AgentRefInputSchema)),
  agent: Schema.optional(AgentRefInputSchema),
  requires: Schema.optional(Schema.Array(OrbitPhaseTraitRequirementSchema)),
  notes: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  telos: Schema.optional(Schema.String),
  real_world_change: Schema.optional(Schema.String),
  cold_pickup_test: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
});
export type OrbitPhase = typeof OrbitPhaseSchema.Type;

export const NormalizedOrbitBindingSchema = Schema.Struct({
  orbit: Schema.String,
  bindings: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});

export const NormalizedOrbitPhaseTraitRequirementSchema = Schema.Struct({
  all: Schema.Array(Schema.String),
  min: Schema.optional(Schema.Number),
});
export type NormalizedOrbitPhaseTraitRequirement =
  typeof NormalizedOrbitPhaseTraitRequirementSchema.Type;

export const NormalizedOrbitPhaseSchema = Schema.Struct({
  name: Schema.String,
  orbit: Schema.optional(Schema.String),
  orbit_binding: Schema.optional(NormalizedOrbitBindingSchema),
  agent: Schema.optional(Schema.String),
  agents: Schema.Array(Schema.String),
  requires: Schema.Array(NormalizedOrbitPhaseTraitRequirementSchema),
  notes: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  telos: Schema.optional(Schema.String),
  real_world_change: Schema.optional(Schema.String),
  cold_pickup_test: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
});
export type NormalizedOrbitPhase = typeof NormalizedOrbitPhaseSchema.Type;

export const NormalizedOrbitToolPermissionToolSchema = Schema.Struct({
  ref: Schema.String,
  logicalName: Schema.String,
});
export type NormalizedOrbitToolPermissionTool =
  typeof NormalizedOrbitToolPermissionToolSchema.Type;

export const NormalizedOrbitOrchestratorSchema = Schema.Struct({
  agent: Schema.String,
  tools: Schema.Array(NormalizedOrbitToolPermissionToolSchema),
});
export type NormalizedOrbitOrchestrator =
  typeof NormalizedOrbitOrchestratorSchema.Type;

export const OrbitPulsarCheckpointSchema = Schema.Struct({
  after: Schema.optional(Schema.String),
  before: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});
export type OrbitPulsarCheckpoint = typeof OrbitPulsarCheckpointSchema.Type;

export const OrbitDefinitionEntrySchema = Schema.Struct({
  purpose: Schema.String,
  contains: Schema.optional(Schema.Array(Schema.String)),
  boundaries: Schema.optional(Schema.Array(Schema.String)),
  avoid: Schema.optional(Schema.Array(Schema.String)),
});
export type OrbitDefinitionEntry = typeof OrbitDefinitionEntrySchema.Type;

export const OrbitDefinitionsSchema = Schema.Struct({
  glyphs: Schema.optional(OrbitDefinitionEntrySchema),
  dispatches: Schema.optional(OrbitDefinitionEntrySchema),
  chatter: Schema.optional(OrbitDefinitionEntrySchema),
  signals: Schema.optional(OrbitDefinitionEntrySchema),
});
export type OrbitDefinitions = typeof OrbitDefinitionsSchema.Type;

export const OrbitDefinitionSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  produces: Schema.optional(Schema.String),
  definitions: Schema.optional(OrbitDefinitionsSchema),
  parameters: Schema.optional(Schema.Array(OrbitParameterSchema)),
  phases: Schema.Array(OrbitPhaseSchema),
  orchestrator: Schema.optional(OrbitOrchestratorSchema),
  tool_permissions: Schema.optional(Schema.Array(OrbitToolPermissionToolSchema)),
  pulsar_checkpoints: Schema.optional(Schema.Array(OrbitPulsarCheckpointSchema)),
  evolution: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
});
export type OrbitDefinition = typeof OrbitDefinitionSchema.Type;

export class Orbit extends Schema.Class<Orbit>("Orbit")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.String,
  produces: Schema.optional(Schema.String),
  definitions: Schema.optional(OrbitDefinitionsSchema),
  parameters: Schema.Array(OrbitParameterSchema),
  phases: Schema.Array(NormalizedOrbitPhaseSchema),
  orchestrator: Schema.optional(NormalizedOrbitOrchestratorSchema),
  tool_permissions: Schema.Array(NormalizedOrbitToolPermissionToolSchema),
  pulsar_checkpoints: Schema.Array(OrbitPulsarCheckpointSchema),
  evolution: Schema.optional(Schema.String),
  body: Schema.String,
}) {}
