/**
 * Public authoring API for structured compile-language artifacts.
 *
 * The canonical structured source model is TypeScript-first:
 * - agents/*.agent.ts
 * - sops/*.sop.ts
 * - modelspaces/*.modelspace.ts
 * - skillspaces/*.skillspace.ts
 * - hooks/*.hook.ts
 *
 * These helpers are identity constructors for authoring ergonomics.
 */

export * from "./jev.js";
export * from "./workflow-errors.js";
export * from "./workflow-harness-detection.js";
export * from "./workflows.js";
export * from "./workflow-runner.js";
export * from "./workflow-worker-contract.js";
export * from "./workflow-worker-metadata.js";

export interface NamedRefDefinition {
  readonly plugin?: string;
  readonly name: string;
}

export interface AgentRefDefinition extends NamedRefDefinition {
  readonly kind: "agent-ref";
}

export interface ModelProfileRefDefinition {
  readonly kind: "model-profile-ref";
  readonly plugin?: string;
  readonly modelspace: string;
  readonly name: string;
}

export interface SkillRefDefinition {
  readonly kind: "skill-ref";
  readonly plugin?: string;
  readonly name: string;
}

export interface SkillspaceRefDefinition {
  readonly kind: "skillspace-ref";
  readonly plugin?: string;
  readonly skillspace: string;
  readonly name: string;
}

export type AgentRefInput = string | AgentRefDefinition;
export type ModelProfileRefInput = string | ModelProfileRefDefinition;
export type SkillRefInput = SkillRefDefinition | SkillspaceRefDefinition;
export type EffectSchemaValue = import("effect").Schema.Top;

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly identity: string;
  readonly personality?: string;
  readonly model?: ModelProfileRefInput;
  readonly skills?: ReadonlyArray<SkillRefInput>;
  readonly color?: string;
  readonly targets?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export type AgentSource = AgentDefinition;

export interface CanonicalToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input: EffectSchemaValue;
  readonly output: EffectSchemaValue;
  readonly slots?: Readonly<Record<string, ToolSlotDefinition>>;
  readonly handle: (input: unknown, context: import("./compile/runtime/schema-bridge").ToolRuntimeContext) => Promise<unknown>;
}

export type ToolSource = CanonicalToolDefinition;

export interface ToolSchemaSlotDefinition {
  readonly kind: "schema";
  readonly description?: string;
}

export type ToolSlotDefinition = ToolSchemaSlotDefinition;

export interface SopPhaseDefinition {
  readonly name: string;
  readonly purpose: string;
  /** Optional typed phase input contract (Effect Schema). */
  readonly input?: EffectSchemaValue;
  /** Optional typed phase output contract (Effect Schema). */
  readonly output?: EffectSchemaValue;
  /** Judge-level bars a schema cannot express. */
  readonly acceptance_criteria?: ReadonlyArray<string>;
  /** When to stop and ask a human. */
  readonly escalation?: string;
  /** Full procedure prose for this phase — steps, failure modes, examples. */
  readonly body: string;
}

/**
 * A SOP is a type-safe procedure. It may say what must be true; it never
 * names who executes it, with what tool, or in what runtime.
 */
export interface SopDefinition {
  readonly name: string;
  readonly description: string;
  readonly phases: ReadonlyArray<SopPhaseDefinition>;
  /** Cross-phase frame for the whole procedure. */
  readonly body?: string;
}

export type SopSource = SopDefinition;
export interface ModelTargetDefinition {
  readonly model: string;
  readonly variant?: string;
  readonly temperature?: number;
  readonly top_p?: number;
}

export interface ModelPoolTargetDefinition {
  readonly strategy: "any-of" | "round-robin" | "ordered";
  readonly models: readonly ModelTargetDefinition[];
}

export type ModelTargetBlockDefinition =
  | ModelTargetDefinition
  | ModelPoolTargetDefinition
  | Readonly<Record<string, unknown>>;

export interface ModelProfileDefinition {
  readonly description?: string;
  readonly targets: Readonly<Record<string, ModelTargetBlockDefinition>>;
}

export interface ModelspaceDefinition {
  readonly name: string;
  readonly description?: string;
  readonly profiles: Readonly<Record<string, ModelProfileDefinition>>;
}

export type ModelspaceSource = ModelspaceDefinition;

export interface SkillTargetBindingDefinition {
  readonly name: string;
}

export interface SkillDefinition {
  readonly description?: string;
  readonly targets: Readonly<Record<string, SkillTargetBindingDefinition>>;
}

export interface SkillspaceDefinition {
  readonly name: string;
  readonly description?: string;
  readonly skills: Readonly<Record<string, SkillDefinition>>;
}

export type SkillspaceSource = SkillspaceDefinition;

export const hookEvent = {
  toolBefore: "tool.before",
  toolAfter: "tool.after",
  promptSubmit: "prompt.submit",
  permissionRequest: "permission.request",
  sessionStart: "session.start",
  sessionEnd: "session.end",
  toolFailure: "tool.failure",
  stop: "stop",
  subagentStart: "subagent.start",
  subagentStop: "subagent.stop",
  compactBefore: "compact.before",
  compactAfter: "compact.after",
  notification: "notification",
} as const;

export type HookEvent = (typeof hookEvent)[keyof typeof hookEvent];

export interface HookTargetContextDefinition {
  readonly harness: string;
  readonly nativeEvent: string;
}

export interface HookSessionContextDefinition {
  readonly id?: string;
  readonly transcriptPath?: string;
}

export interface HookToolContextDefinition {
  readonly logical?: string;
  readonly nativeName: string;
  readonly input: unknown;
}

export interface ToolBeforeHookEventDefinition {
  readonly event: typeof hookEvent.toolBefore;
  readonly target: HookTargetContextDefinition;
  readonly tool: HookToolContextDefinition;
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly native?: Record<string, unknown>;
}

export interface ToolAfterHookEventDefinition {
  readonly event: typeof hookEvent.toolAfter;
  readonly target: HookTargetContextDefinition;
  readonly tool: HookToolContextDefinition & {
    readonly output: unknown;
    readonly success?: boolean;
  };
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly native?: Record<string, unknown>;
}

export interface SessionStartHookEventDefinition {
  readonly event: typeof hookEvent.sessionStart;
  readonly target: HookTargetContextDefinition;
  readonly cwd?: string;
  readonly session: HookSessionContextDefinition;
  readonly native?: Record<string, unknown>;
}

export interface PromptSubmitHookEventDefinition {
  readonly event: typeof hookEvent.promptSubmit;
  readonly target: HookTargetContextDefinition;
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly prompt: string;
  readonly native?: Record<string, unknown>;
}

export interface PermissionRequestHookEventDefinition {
  readonly event: typeof hookEvent.permissionRequest;
  readonly target: HookTargetContextDefinition;
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly tool?: HookToolContextDefinition;
  readonly native?: Record<string, unknown>;
}

export interface SessionEndHookEventDefinition {
  readonly event: typeof hookEvent.sessionEnd;
  readonly target: HookTargetContextDefinition;
  readonly cwd?: string;
  readonly session: HookSessionContextDefinition;
  readonly reason?: string;
  readonly native?: Record<string, unknown>;
}

export interface ToolFailureHookEventDefinition {
  readonly event: typeof hookEvent.toolFailure;
  readonly target: HookTargetContextDefinition;
  readonly tool: HookToolContextDefinition & { readonly error: unknown };
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly native?: Record<string, unknown>;
}

export interface StopHookEventDefinition {
  readonly event: typeof hookEvent.stop;
  readonly target: HookTargetContextDefinition;
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly stopHookActive?: boolean;
  readonly native?: Record<string, unknown>;
}

export interface SubagentContextDefinition {
  readonly id?: string;
  readonly type?: string;
}

export interface SubagentStartHookEventDefinition {
  readonly event: typeof hookEvent.subagentStart;
  readonly target: HookTargetContextDefinition;
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly subagent?: SubagentContextDefinition;
  readonly native?: Record<string, unknown>;
}

export interface SubagentStopHookEventDefinition {
  readonly event: typeof hookEvent.subagentStop;
  readonly target: HookTargetContextDefinition;
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly subagent?: SubagentContextDefinition;
  readonly native?: Record<string, unknown>;
}

export interface CompactBeforeHookEventDefinition {
  readonly event: typeof hookEvent.compactBefore;
  readonly target: HookTargetContextDefinition;
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly trigger?: string;
  readonly native?: Record<string, unknown>;
}

export interface CompactAfterHookEventDefinition {
  readonly event: typeof hookEvent.compactAfter;
  readonly target: HookTargetContextDefinition;
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly trigger?: string;
  readonly native?: Record<string, unknown>;
}

export interface NotificationHookEventDefinition {
  readonly event: typeof hookEvent.notification;
  readonly target: HookTargetContextDefinition;
  readonly cwd?: string;
  readonly session?: HookSessionContextDefinition;
  readonly message?: string;
  readonly kind?: string;
  readonly native?: Record<string, unknown>;
}

export type HookEventPayloadDefinition =
  | ToolBeforeHookEventDefinition
  | ToolAfterHookEventDefinition
  | PromptSubmitHookEventDefinition
  | PermissionRequestHookEventDefinition
  | SessionStartHookEventDefinition
  | SessionEndHookEventDefinition
  | ToolFailureHookEventDefinition
  | StopHookEventDefinition
  | SubagentStartHookEventDefinition
  | SubagentStopHookEventDefinition
  | CompactBeforeHookEventDefinition
  | CompactAfterHookEventDefinition
  | NotificationHookEventDefinition;

export type HookEventPayloadFor<E extends HookEvent> = Extract<
  HookEventPayloadDefinition,
  { readonly event: E }
>;

export interface ContinueHookResultDefinition {
  readonly decision: "continue";
  readonly systemMessage?: string;
  readonly additionalContext?: string;
  /** tool.before: replace the tool arguments before execution. */
  readonly updatedInput?: unknown;
  /** tool.after: replace the tool result before the model sees it. */
  readonly updatedOutput?: unknown;
}

export interface BlockHookResultDefinition {
  readonly decision: "block";
  readonly message: string;
  readonly systemMessage?: string;
}

export interface AllowHookResultDefinition {
  readonly decision: "allow";
  readonly systemMessage?: string;
  readonly updatedInput?: unknown;
}

export interface AskHookResultDefinition {
  readonly decision: "ask";
  readonly systemMessage?: string;
}

export type ToolBeforeHookResultDefinition =
  | ContinueHookResultDefinition
  | BlockHookResultDefinition;

export type PermissionRequestHookResultDefinition =
  | ContinueHookResultDefinition
  | AllowHookResultDefinition
  | AskHookResultDefinition
  | BlockHookResultDefinition;

/** prompt.submit, stop, subagent.stop, compact.before — continue or block. */
export type BlockableHookResultDefinition =
  | ContinueHookResultDefinition
  | BlockHookResultDefinition;

export type HookResultFor<E extends HookEvent> = E extends typeof hookEvent.toolBefore
  ? ToolBeforeHookResultDefinition
  : E extends typeof hookEvent.permissionRequest
    ? PermissionRequestHookResultDefinition
    : E extends
          | typeof hookEvent.promptSubmit
          | typeof hookEvent.stop
          | typeof hookEvent.subagentStop
          | typeof hookEvent.compactBefore
      ? BlockableHookResultDefinition
      : ContinueHookResultDefinition;

export type HookHandlerDefinition<E extends HookEvent> = (
  event: HookEventPayloadFor<E>,
) => import("effect").Effect.Effect<HookResultFor<E>, unknown, never>;

export interface HookAnyToolMatcherDefinition {
  readonly kind: "hook-any-tool";
}

export interface HookNativeToolMatcherDefinition {
  readonly kind: "hook-native-tool";
  readonly name: string;
}

export interface HookCanonicalToolMatcherDefinition {
  readonly kind: "hook-canonical-tool";
  readonly ref: string;
}

export type HookToolMatcherDefinition =
  | HookAnyToolMatcherDefinition
  | HookNativeToolMatcherDefinition
  | HookCanonicalToolMatcherDefinition;

export interface ToolHookMatchDefinition {
  readonly tool?: HookToolMatcherDefinition;
}

export type HookMatchDefinition<E extends HookEvent> = E extends
  | typeof hookEvent.toolBefore
  | typeof hookEvent.toolAfter
  | typeof hookEvent.toolFailure
  | typeof hookEvent.permissionRequest
  ? ToolHookMatchDefinition
  : never;

export interface HookDefinition<E extends HookEvent = HookEvent> {
  readonly name: string;
  readonly description?: string;
  readonly event: E;
  readonly targets?: readonly string[];
  readonly match?: HookMatchDefinition<E>;
  /** How to lower this hook on a target that cannot deliver every control it
   * declares: "degrade" (default) omits with a fidelity note, "skip" omits
   * silently, "fail" makes it a compile error. */
  readonly onDegraded?: "fail" | "degrade" | "skip";
  readonly handle: HookHandlerDefinition<E>;
}

export type HookSource<E extends HookEvent = HookEvent> = HookDefinition<E>;

export const withNamedRef = <TKind extends string>(
  kind: TKind,
  first: string,
  second?: string,
): { readonly kind: TKind; readonly plugin?: string; readonly name: string } =>
  second === undefined
    ? { kind, name: first }
    : { kind, plugin: first, name: second };

export function agentRef(name: string): AgentRefDefinition;
export function agentRef(plugin: string, name: string): AgentRefDefinition;
export function agentRef(first: string, second?: string): AgentRefDefinition {
  return withNamedRef("agent-ref", first, second);
}

export function modelProfileRef(
  modelspace: string,
  name: string,
): ModelProfileRefDefinition;
export function modelProfileRef(
  plugin: string,
  modelspace: string,
  name: string,
): ModelProfileRefDefinition;
export function modelProfileRef(
  first: string,
  second: string,
  third?: string,
): ModelProfileRefDefinition {
  return third === undefined
    ? { kind: "model-profile-ref", modelspace: first, name: second }
    : {
        kind: "model-profile-ref",
        plugin: first,
        modelspace: second,
        name: third,
      };
}

export function skillRef(name: string): SkillRefDefinition;
export function skillRef(plugin: string, name: string): SkillRefDefinition;
export function skillRef(first: string, second?: string): SkillRefDefinition {
  return withNamedRef("skill-ref", first, second);
}

export function skillspaceRef(
  skillspace: string,
  name: string,
): SkillspaceRefDefinition;
export function skillspaceRef(
  plugin: string,
  skillspace: string,
  name: string,
): SkillspaceRefDefinition;
export function skillspaceRef(
  first: string,
  second: string,
  third?: string,
): SkillspaceRefDefinition {
  return third === undefined
    ? { kind: "skillspace-ref", skillspace: first, name: second }
    : {
        kind: "skillspace-ref",
        plugin: first,
        skillspace: second,
        name: third,
      };
}

export const schemaSlot = (
  options: Omit<ToolSchemaSlotDefinition, "kind"> = {},
): ToolSchemaSlotDefinition => ({
  kind: "schema",
  ...options,
});

export const hookTool = {
  any: (): HookAnyToolMatcherDefinition => ({ kind: "hook-any-tool" }),
  native: (name: string): HookNativeToolMatcherDefinition => ({
    kind: "hook-native-tool",
    name,
  }),
  canonical: (ref: string): HookCanonicalToolMatcherDefinition => ({
    kind: "hook-canonical-tool",
    ref,
  }),
} as const;

export const hookMatcher = {
  tool: hookTool,
} as const;

export type { ToolRuntimeContext, ToolRuntimeCost } from "./compile/runtime/schema-bridge";
