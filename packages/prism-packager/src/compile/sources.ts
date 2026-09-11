/**
 * Source types for the current structured compile language.
 *
 * Canonical structured artifacts are TypeScript-authored:
 * - Agent         : agents/*.agent.ts
 * - Sop           : sops/*.sop.ts
 * - Modelspace    : modelspaces/*.modelspace.ts
 * - Skillspace    : skillspaces/*.skillspace.ts
 *
 * Prose artifacts remain markdown-authored:
 * - Identity      : identities/*.identity.md
 * - Personality   : personalities/*.personality.md
 */

import { Schema } from "effect";
import { ToolAuthoritySchema, type ToolAuthority } from "@skastr0/prism-sdk/compile-manifest";

export type { ToolAuthority };
export const TargetId = Schema.String;
export type TargetId = typeof TargetId.Type;

// ---------------------------------------------------------------------------
// Shared refs
// ---------------------------------------------------------------------------

const NamedRefObjectSchema = Schema.Struct({
  plugin: Schema.optional(Schema.String),
  name: Schema.String,
});

export const AgentRefInputSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("agent-ref"),
    plugin: Schema.optional(Schema.String),
    name: Schema.String,
  }),
);
export type AgentRefInput = typeof AgentRefInputSchema.Type;

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
  "prompt.submit",
  "permission.request",
  "session.start",
  "session.end",
  "tool.failure",
  "stop",
  "subagent.start",
  "subagent.stop",
  "compact.before",
  "compact.after",
  "notification",
);
export type HookEvent = typeof HookEventSchema.Type;

export const HookToolMatcherInputSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("hook-any-tool") }),
  Schema.Struct({
    kind: Schema.Literal("hook-native-tool"),
    name: Schema.String,
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
    kind: Schema.Literal("native-tool"),
    name: Schema.String,
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
  targets: Schema.optional(Schema.Array(Schema.String)),
  match: Schema.optional(HookMatchInputSchema),
  handle: Schema.Any,
  onDegraded: Schema.optional(Schema.Literal("fail", "degrade", "skip")),
});
export type HookDefinition = typeof HookDefinitionSchema.Type;
export const HookSourceSchema = HookDefinitionSchema;
export type HookSource = typeof HookSourceSchema.Type;

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

export const HookNativeContextSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
export type HookNativeContext = typeof HookNativeContextSchema.Type;

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
  native: Schema.optional(HookNativeContextSchema),
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
  native: Schema.optional(HookNativeContextSchema),
});
export type ToolAfterEventPayload = typeof ToolAfterEventPayloadSchema.Type;

export const SessionStartEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("session.start"),
  target: HookTargetContextSchema,
  cwd: Schema.optional(Schema.String),
  session: HookSessionContextSchema,
  native: Schema.optional(HookNativeContextSchema),
});
export type SessionStartEventPayload = typeof SessionStartEventPayloadSchema.Type;

export const PromptSubmitEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("prompt.submit"),
  target: HookTargetContextSchema,
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
  prompt: Schema.String,
  native: Schema.optional(HookNativeContextSchema),
});
export type PromptSubmitEventPayload = typeof PromptSubmitEventPayloadSchema.Type;

export const PermissionRequestEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("permission.request"),
  target: HookTargetContextSchema,
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
  tool: Schema.optional(HookToolContextSchema),
  native: Schema.optional(HookNativeContextSchema),
});
export type PermissionRequestEventPayload = typeof PermissionRequestEventPayloadSchema.Type;

export const SessionEndEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("session.end"),
  target: HookTargetContextSchema,
  cwd: Schema.optional(Schema.String),
  session: HookSessionContextSchema,
  reason: Schema.optional(Schema.String),
  native: Schema.optional(HookNativeContextSchema),
});
export type SessionEndEventPayload = typeof SessionEndEventPayloadSchema.Type;

export const ToolFailureEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("tool.failure"),
  target: HookTargetContextSchema,
  tool: Schema.extend(
    HookToolContextSchema,
    Schema.Struct({
      error: Schema.Unknown,
    }),
  ),
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
  native: Schema.optional(HookNativeContextSchema),
});
export type ToolFailureEventPayload = typeof ToolFailureEventPayloadSchema.Type;

export const StopEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("stop"),
  target: HookTargetContextSchema,
  stopHookActive: Schema.optional(Schema.Boolean),
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
  native: Schema.optional(HookNativeContextSchema),
});
export type StopEventPayload = typeof StopEventPayloadSchema.Type;

export const SubagentStartEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("subagent.start"),
  target: HookTargetContextSchema,
  subagent: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
    }),
  ),
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
  native: Schema.optional(HookNativeContextSchema),
});
export type SubagentStartEventPayload = typeof SubagentStartEventPayloadSchema.Type;

export const SubagentStopEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("subagent.stop"),
  target: HookTargetContextSchema,
  subagent: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
    }),
  ),
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
  native: Schema.optional(HookNativeContextSchema),
});
export type SubagentStopEventPayload = typeof SubagentStopEventPayloadSchema.Type;

export const CompactBeforeEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("compact.before"),
  target: HookTargetContextSchema,
  trigger: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
  native: Schema.optional(HookNativeContextSchema),
});
export type CompactBeforeEventPayload = typeof CompactBeforeEventPayloadSchema.Type;

export const CompactAfterEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("compact.after"),
  target: HookTargetContextSchema,
  trigger: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
  native: Schema.optional(HookNativeContextSchema),
});
export type CompactAfterEventPayload = typeof CompactAfterEventPayloadSchema.Type;

export const NotificationEventPayloadSchema = Schema.Struct({
  event: Schema.Literal("notification"),
  target: HookTargetContextSchema,
  message: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  session: Schema.optional(HookSessionContextSchema),
  native: Schema.optional(HookNativeContextSchema),
});
export type NotificationEventPayload = typeof NotificationEventPayloadSchema.Type;

export const HookEventPayloadSchema = Schema.Union(
  ToolBeforeEventPayloadSchema,
  ToolAfterEventPayloadSchema,
  PromptSubmitEventPayloadSchema,
  PermissionRequestEventPayloadSchema,
  SessionStartEventPayloadSchema,
  SessionEndEventPayloadSchema,
  ToolFailureEventPayloadSchema,
  StopEventPayloadSchema,
  SubagentStartEventPayloadSchema,
  SubagentStopEventPayloadSchema,
  CompactBeforeEventPayloadSchema,
  CompactAfterEventPayloadSchema,
  NotificationEventPayloadSchema,
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
    native: Schema.optional(HookNativeContextSchema),
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
      native: native.native,
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
      native: payload.native,
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
    native: Schema.optional(HookNativeContextSchema),
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
      native: native.native,
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
      native: payload.native,
    }),
  },
);
export type NativeToolAfterHookPayload = typeof NativeToolAfterHookPayloadSchema.Type;

export const NativeSessionStartHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    cwd: Schema.optional(Schema.String),
    session: HookSessionContextSchema,
    native: Schema.optional(HookNativeContextSchema),
  }),
  SessionStartEventPayloadSchema,
  {
    decode: (native) => ({
      event: "session.start" as const,
      target: native.target,
      cwd: native.cwd,
      session: native.session,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      cwd: payload.cwd,
      session: payload.session,
      native: payload.native,
    }),
  },
);
export type NativeSessionStartHookPayload = typeof NativeSessionStartHookPayloadSchema.Type;

export const NativePromptSubmitHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
    prompt: Schema.String,
    native: Schema.optional(HookNativeContextSchema),
  }),
  PromptSubmitEventPayloadSchema,
  {
    decode: (native) => ({
      event: "prompt.submit" as const,
      target: native.target,
      cwd: native.cwd,
      session: native.session,
      prompt: native.prompt,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      cwd: payload.cwd,
      session: payload.session,
      prompt: payload.prompt,
      native: payload.native,
    }),
  },
);
export type NativePromptSubmitHookPayload = typeof NativePromptSubmitHookPayloadSchema.Type;

export const NativePermissionRequestHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
    tool: Schema.optional(NativeToolBeforeContextSchema),
    native: Schema.optional(HookNativeContextSchema),
  }),
  PermissionRequestEventPayloadSchema,
  {
    decode: (native) => ({
      event: "permission.request" as const,
      target: native.target,
      cwd: native.cwd,
      session: native.session,
      tool: native.tool
        ? {
            logical: native.tool.logical,
            nativeName: native.tool.name,
            input: native.tool.input,
          }
        : undefined,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      cwd: payload.cwd,
      session: payload.session,
      tool: payload.tool
        ? {
            logical: payload.tool.logical,
            name: payload.tool.nativeName,
            input: payload.tool.input,
          }
        : undefined,
      native: payload.native,
    }),
  },
);
export type NativePermissionRequestHookPayload =
  typeof NativePermissionRequestHookPayloadSchema.Type;

export const NativeSessionEndHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    cwd: Schema.optional(Schema.String),
    session: HookSessionContextSchema,
    reason: Schema.optional(Schema.String),
    native: Schema.optional(HookNativeContextSchema),
  }),
  SessionEndEventPayloadSchema,
  {
    decode: (native) => ({
      event: "session.end" as const,
      target: native.target,
      cwd: native.cwd,
      session: native.session,
      reason: native.reason,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      cwd: payload.cwd,
      session: payload.session,
      reason: payload.reason,
      native: payload.native,
    }),
  },
);
export type NativeSessionEndHookPayload = typeof NativeSessionEndHookPayloadSchema.Type;

const NativeToolFailureContextSchema = Schema.Struct({
  logical: Schema.optional(Schema.String),
  name: Schema.String,
  input: Schema.Unknown,
  error: Schema.Unknown,
});

export const NativeToolFailureHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    tool: NativeToolFailureContextSchema,
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
    native: Schema.optional(HookNativeContextSchema),
  }),
  ToolFailureEventPayloadSchema,
  {
    decode: (native) => ({
      event: "tool.failure" as const,
      target: native.target,
      tool: {
        logical: native.tool.logical,
        nativeName: native.tool.name,
        input: native.tool.input,
        error: native.tool.error,
      },
      cwd: native.cwd,
      session: native.session,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      tool: {
        logical: payload.tool.logical,
        name: payload.tool.nativeName,
        input: payload.tool.input,
        error: payload.tool.error,
      },
      cwd: payload.cwd,
      session: payload.session,
      native: payload.native,
    }),
  },
);
export type NativeToolFailureHookPayload = typeof NativeToolFailureHookPayloadSchema.Type;

export const NativeStopHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    stopHookActive: Schema.optional(Schema.Boolean),
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
    native: Schema.optional(HookNativeContextSchema),
  }),
  StopEventPayloadSchema,
  {
    decode: (native) => ({
      event: "stop" as const,
      target: native.target,
      stopHookActive: native.stopHookActive,
      cwd: native.cwd,
      session: native.session,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      stopHookActive: payload.stopHookActive,
      cwd: payload.cwd,
      session: payload.session,
      native: payload.native,
    }),
  },
);
export type NativeStopHookPayload = typeof NativeStopHookPayloadSchema.Type;

export const NativeSubagentStartHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    subagent: Schema.optional(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        type: Schema.optional(Schema.String),
      }),
    ),
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
    native: Schema.optional(HookNativeContextSchema),
  }),
  SubagentStartEventPayloadSchema,
  {
    decode: (native) => ({
      event: "subagent.start" as const,
      target: native.target,
      subagent: native.subagent,
      cwd: native.cwd,
      session: native.session,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      subagent: payload.subagent,
      cwd: payload.cwd,
      session: payload.session,
      native: payload.native,
    }),
  },
);
export type NativeSubagentStartHookPayload = typeof NativeSubagentStartHookPayloadSchema.Type;

export const NativeSubagentStopHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    subagent: Schema.optional(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        type: Schema.optional(Schema.String),
      }),
    ),
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
    native: Schema.optional(HookNativeContextSchema),
  }),
  SubagentStopEventPayloadSchema,
  {
    decode: (native) => ({
      event: "subagent.stop" as const,
      target: native.target,
      subagent: native.subagent,
      cwd: native.cwd,
      session: native.session,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      subagent: payload.subagent,
      cwd: payload.cwd,
      session: payload.session,
      native: payload.native,
    }),
  },
);
export type NativeSubagentStopHookPayload = typeof NativeSubagentStopHookPayloadSchema.Type;

export const NativeCompactBeforeHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    trigger: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
    native: Schema.optional(HookNativeContextSchema),
  }),
  CompactBeforeEventPayloadSchema,
  {
    decode: (native) => ({
      event: "compact.before" as const,
      target: native.target,
      trigger: native.trigger,
      cwd: native.cwd,
      session: native.session,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      trigger: payload.trigger,
      cwd: payload.cwd,
      session: payload.session,
      native: payload.native,
    }),
  },
);
export type NativeCompactBeforeHookPayload = typeof NativeCompactBeforeHookPayloadSchema.Type;

export const NativeCompactAfterHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    trigger: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
    native: Schema.optional(HookNativeContextSchema),
  }),
  CompactAfterEventPayloadSchema,
  {
    decode: (native) => ({
      event: "compact.after" as const,
      target: native.target,
      trigger: native.trigger,
      cwd: native.cwd,
      session: native.session,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      trigger: payload.trigger,
      cwd: payload.cwd,
      session: payload.session,
      native: payload.native,
    }),
  },
);
export type NativeCompactAfterHookPayload = typeof NativeCompactAfterHookPayloadSchema.Type;

export const NativeNotificationHookPayloadSchema = Schema.transform(
  Schema.Struct({
    target: HookTargetContextSchema,
    message: Schema.optional(Schema.String),
    kind: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    session: Schema.optional(HookSessionContextSchema),
    native: Schema.optional(HookNativeContextSchema),
  }),
  NotificationEventPayloadSchema,
  {
    decode: (native) => ({
      event: "notification" as const,
      target: native.target,
      message: native.message,
      kind: native.kind,
      cwd: native.cwd,
      session: native.session,
      native: native.native,
    }),
    encode: (payload) => ({
      target: payload.target,
      message: payload.message,
      kind: payload.kind,
      cwd: payload.cwd,
      session: payload.session,
      native: payload.native,
    }),
  },
);
export type NativeNotificationHookPayload = typeof NativeNotificationHookPayloadSchema.Type;

export const NativeHookPayloadSchema = Schema.Union(
  NativeToolBeforeHookPayloadSchema,
  NativeToolAfterHookPayloadSchema,
  NativePromptSubmitHookPayloadSchema,
  NativePermissionRequestHookPayloadSchema,
  NativeSessionStartHookPayloadSchema,
  NativeSessionEndHookPayloadSchema,
  NativeToolFailureHookPayloadSchema,
  NativeStopHookPayloadSchema,
  NativeSubagentStartHookPayloadSchema,
  NativeSubagentStopHookPayloadSchema,
  NativeCompactBeforeHookPayloadSchema,
  NativeCompactAfterHookPayloadSchema,
  NativeNotificationHookPayloadSchema,
);
export type NativeHookPayload = typeof NativeHookPayloadSchema.Type;

export const ToolBeforeHookResultSchema = Schema.Union(
  Schema.Struct({
    decision: Schema.Literal("continue"),
    updatedInput: Schema.optional(Schema.Unknown),
    systemMessage: Schema.optional(Schema.String),
    additionalContext: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    decision: Schema.Literal("block"),
    message: Schema.String,
    systemMessage: Schema.optional(Schema.String),
  }),
);
export type ToolBeforeHookResult = typeof ToolBeforeHookResultSchema.Type;

export const ContinueHookResultSchema = Schema.Struct({
  decision: Schema.Literal("continue"),
  systemMessage: Schema.optional(Schema.String),
  additionalContext: Schema.optional(Schema.String),
});
export type ContinueHookResult = typeof ContinueHookResultSchema.Type;

export const ObservationalHookResultSchema = ContinueHookResultSchema;
export type ObservationalHookResult = ContinueHookResult;

export const ToolAfterHookResultSchema = Schema.Struct({
  decision: Schema.Literal("continue"),
  updatedOutput: Schema.optional(Schema.Unknown),
  systemMessage: Schema.optional(Schema.String),
  additionalContext: Schema.optional(Schema.String),
});
export type ToolAfterHookResult = typeof ToolAfterHookResultSchema.Type;

export const PermissionAllowHookResultSchema = Schema.Struct({
  decision: Schema.Literal("allow"),
  updatedInput: Schema.optional(Schema.Unknown),
  systemMessage: Schema.optional(Schema.String),
});
export type PermissionAllowHookResult = typeof PermissionAllowHookResultSchema.Type;

export const PermissionRequestHookResultSchema = Schema.Union(
  ContinueHookResultSchema,
  PermissionAllowHookResultSchema,
  Schema.Struct({
    decision: Schema.Literal("ask"),
    systemMessage: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    decision: Schema.Literal("block"),
    message: Schema.String,
  }),
);
export type PermissionRequestHookResult = typeof PermissionRequestHookResultSchema.Type;

export const StopHookResultSchema = Schema.Union(
  Schema.Struct({
    decision: Schema.Literal("continue"),
    systemMessage: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    decision: Schema.Literal("block"),
    message: Schema.String,
  }),
);
export type StopHookResult = typeof StopHookResultSchema.Type;

export const BlockableHookResultSchema = Schema.Union(
  ContinueHookResultSchema,
  Schema.Struct({
    decision: Schema.Literal("block"),
    message: Schema.String,
  }),
);
export type BlockableHookResult = typeof BlockableHookResultSchema.Type;

export const PromptSubmitHookResultSchema = BlockableHookResultSchema;
export type PromptSubmitHookResult = BlockableHookResult;

export const NotificationHookResultSchema = Schema.Struct({
  decision: Schema.Literal("continue"),
  systemMessage: Schema.optional(Schema.String),
});
export type NotificationHookResult = typeof NotificationHookResultSchema.Type;

export const HookEventResultSchema = Schema.Union(
  Schema.Struct({
    event: Schema.Literal("tool.before"),
    result: ToolBeforeHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("tool.after"),
    result: ToolAfterHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("tool.failure"),
    result: ObservationalHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("prompt.submit"),
    result: PromptSubmitHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("permission.request"),
    result: PermissionRequestHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("session.start"),
    result: ObservationalHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("session.end"),
    result: ObservationalHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("stop"),
    result: StopHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("subagent.start"),
    result: ObservationalHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("subagent.stop"),
    result: BlockableHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("compact.before"),
    result: BlockableHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("compact.after"),
    result: ObservationalHookResultSchema,
  }),
  Schema.Struct({
    event: Schema.Literal("notification"),
    result: NotificationHookResultSchema,
  }),
);
export type HookEventResult = typeof HookEventResultSchema.Type;

export const HookResultSchema = Schema.Union(
  ToolBeforeHookResultSchema,
  ToolAfterHookResultSchema,
  BlockableHookResultSchema,
  PermissionRequestHookResultSchema,
  ObservationalHookResultSchema,
  StopHookResultSchema,
  NotificationHookResultSchema,
);
export type HookResult = typeof HookResultSchema.Type;

export const hookResultSchemaForEvent = (
  event: HookEvent,
): Schema.Schema.AnyNoContext => {
  switch (event) {
    case "tool.before":
      return ToolBeforeHookResultSchema;
    case "tool.after":
      return ToolAfterHookResultSchema;
    case "tool.failure":
      return ObservationalHookResultSchema;
    case "prompt.submit":
      return PromptSubmitHookResultSchema;
    case "permission.request":
      return PermissionRequestHookResultSchema;
    case "session.start":
      return ObservationalHookResultSchema;
    case "session.end":
      return ObservationalHookResultSchema;
    case "stop":
      return StopHookResultSchema;
    case "subagent.start":
      return ObservationalHookResultSchema;
    case "subagent.stop":
      return BlockableHookResultSchema;
    case "compact.before":
      return BlockableHookResultSchema;
    case "compact.after":
      return ObservationalHookResultSchema;
    case "notification":
      return NotificationHookResultSchema;
  }
};

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
    case "prompt.submit":
      return NativePromptSubmitHookPayloadSchema;
    case "permission.request":
      return NativePermissionRequestHookPayloadSchema;
    case "session.start":
      return NativeSessionStartHookPayloadSchema;
    case "session.end":
      return NativeSessionEndHookPayloadSchema;
    case "tool.failure":
      return NativeToolFailureHookPayloadSchema;
    case "stop":
      return NativeStopHookPayloadSchema;
    case "subagent.start":
      return NativeSubagentStartHookPayloadSchema;
    case "subagent.stop":
      return NativeSubagentStopHookPayloadSchema;
    case "compact.before":
      return NativeCompactBeforeHookPayloadSchema;
    case "compact.after":
      return NativeCompactAfterHookPayloadSchema;
    case "notification":
      return NativeNotificationHookPayloadSchema;
  }
};

export const decodeNativeHookPayloadForEvent = (event: HookEvent, payload: unknown) =>
  Schema.decodeUnknownEither(nativeHookPayloadSchemaForEvent(event))(payload);

export class Hook extends Schema.Class<Hook>("Hook")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.optional(Schema.String),
  event: HookEventSchema,
  targets: Schema.Array(Schema.String),
  match: NormalizedHookMatchSchema,
  handle: Schema.Any,
  onDegraded: Schema.optional(Schema.Literal("fail", "degrade", "skip")),
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

const normalizeDirectNamedRefInput = (
  field: string,
  value: string | typeof NamedRefObjectSchema.Type,
): string | RefNormalizationError =>
  typeof value === "string"
    ? normalizeNamedRefParts(field, value)
    : normalizeNamedRefParts(field, { plugin: value.plugin, name: value.name });

export const normalizeAgentRefInput = (
  field: string,
  value: AgentRefInput,
): string | RefNormalizationError => normalizeDirectNamedRefInput(field, value);

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
export const OpenCodeModelPoolTarget = Schema.Struct({
  strategy: Schema.Literal("any-of", "round-robin", "ordered"),
  models: Schema.Array(OpenCodeModelTarget),
});
export const OpenCodeModelTargetBlock = Schema.Union(
  OpenCodeModelTarget,
  OpenCodeModelPoolTarget,
);
export type OpenCodeModelTarget = typeof OpenCodeModelTargetBlock.Type;

export const ClaudeCodeModelTarget = Schema.Struct({
  model: Schema.optional(Schema.String),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
});
export type ClaudeCodeModelTarget = typeof ClaudeCodeModelTarget.Type;

// ---------------------------------------------------------------------------
// Tool slot declarations (canonical tool contract surface)
// ---------------------------------------------------------------------------

export const ToolSchemaSlotSchema = Schema.Struct({
  kind: Schema.Literal("schema"),
  description: Schema.optional(Schema.String),
});
export type ToolSchemaSlot = typeof ToolSchemaSlotSchema.Type;

export const ToolSlotSchema = ToolSchemaSlotSchema;
export type ToolSlot = typeof ToolSlotSchema.Type;

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
  // PQ-075: side-effect authority (readOnly | mutatesExternalState |
  // mutatesHarnessConfig | startsDaemon | requiresHumanApproval). Optional
  // during the default-then-require migration — see ToolAuthoritySchema.
  authority: Schema.optional(ToolAuthoritySchema),
});
export type CanonicalToolInput = typeof CanonicalToolSchema.Type;
export const ToolSourceSchema = CanonicalToolSchema;
export type ToolSource = typeof ToolSourceSchema.Type;

export class CanonicalTool extends Schema.Class<CanonicalTool>("CanonicalTool")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.String,
  input: Schema.Unknown,
  output: Schema.Unknown,
  slots: Schema.Record({ key: Schema.String, value: ToolSlotSchema }),
  handle: Schema.Any,
  authority: Schema.optional(ToolAuthoritySchema),
}) {}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const AgentSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  identity: Schema.String,
  personality: Schema.optional(Schema.String),
  model: Schema.optional(ModelProfileRefInputSchema),
  skills: Schema.optional(Schema.Array(SkillRefInputSchema)),
  color: Schema.optional(Schema.String),
  targets: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Object }),
  ),
});
export const AgentSourceSchema = AgentSchema;
export type AgentSource = typeof AgentSourceSchema.Type;

export class Agent extends Schema.Class<Agent>("Agent")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.String,
  identity: Schema.String,
  personality: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
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
export const ModelspaceSourceSchema = ModelspaceSchema;
export type ModelspaceSource = typeof ModelspaceSourceSchema.Type;

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
export const SkillspaceSourceSchema = SkillspaceSchema;
export type SkillspaceSource = typeof SkillspaceSourceSchema.Type;

export class Skillspace extends Schema.Class<Skillspace>("Skillspace")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.optional(Schema.String),
  skills: Schema.Record({ key: Schema.String, value: SkillDefinitionSchema }),
}) {}

// ---------------------------------------------------------------------------
// Sop
// ---------------------------------------------------------------------------

/**
 * A SOP is a type-safe procedure: phases with a purpose, optional typed I/O
 * contracts, judge-level acceptance criteria, an escalation rule, and prose.
 * A SOP may say what must be true; it never names who executes it, with what
 * tool, or in what runtime.
 */
export const SopPhaseSchema = Schema.Struct({
  name: Schema.String,
  purpose: Schema.String,
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  acceptance_criteria: Schema.optional(Schema.Array(Schema.String)),
  escalation: Schema.optional(Schema.String),
  body: Schema.String,
});
export type SopPhase = typeof SopPhaseSchema.Type;

export const SopDefinitionSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  phases: Schema.Array(SopPhaseSchema),
  body: Schema.optional(Schema.String),
});
export type SopDefinition = typeof SopDefinitionSchema.Type;
export const SopSourceSchema = SopDefinitionSchema;
export type SopSource = typeof SopSourceSchema.Type;

export const NormalizedSopPhaseSchema = Schema.Struct({
  name: Schema.String,
  purpose: Schema.String,
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  acceptanceCriteria: Schema.Array(Schema.String),
  escalation: Schema.optional(Schema.String),
  body: Schema.String,
});
export type NormalizedSopPhase = typeof NormalizedSopPhaseSchema.Type;

export const NormalizedSopDefinitionSchema = Schema.Struct({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.String,
  phases: Schema.Array(NormalizedSopPhaseSchema),
  body: Schema.String,
});
export type NormalizedSopDefinition = typeof NormalizedSopDefinitionSchema.Type;

export class Sop extends Schema.Class<Sop>("Sop")({
  name: Schema.String,
  sourcePath: Schema.String,
  description: Schema.String,
  phases: Schema.Array(NormalizedSopPhaseSchema),
  body: Schema.String,
}) {}
