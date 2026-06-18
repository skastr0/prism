/**
 * Public authoring API for structured compile-language artifacts.
 *
 * The canonical structured source model is TypeScript-first:
 * - agents/*.agent.ts
 * - traits/*.trait.ts
 * - orbits/*.orbit.ts
 * - toolspaces/*.toolspace.ts
 * - modelspaces/*.modelspace.ts
 * - skillspaces/*.skillspace.ts
 * - hooks/*.hook.ts
 *
 * These helpers are identity constructors for authoring ergonomics.
 */

export * from "./workflow-errors.js";
export * from "./workflows.js";
export * from "./workflow-tsconfig.js";
export * from "./workflow-antigravity-worker.js";
export * from "./workflow-amp-worker.js";
export * from "./workflow-claude-worker.js";
export * from "./workflow-codex-worker.js";
export * from "./workflow-loader.js";
export * from "./workflow-opencode-worker.js";
export * from "./workflow-runner.js";
export * from "./workflow-store.js";
export * from "./workflow-worker-contract.js";
export * from "./workflow-worker-metadata.js";
export * from "./workflow-workers.js";

export interface NamedRefDefinition {
  readonly plugin?: string;
  readonly name: string;
}

export interface TraitRefDefinition extends NamedRefDefinition {
  readonly kind: "trait-ref";
}

export interface AgentRefDefinition extends NamedRefDefinition {
  readonly kind: "agent-ref";
}

export interface OrbitRefDefinition extends NamedRefDefinition {
  readonly kind: "orbit-ref";
}

export interface ToolRefDefinition {
  readonly kind: "tool-ref";
  readonly plugin?: string;
  readonly toolspace: string;
  readonly name: string;
}

export interface ToolGroupRefDefinition {
  readonly kind: "tool-group-ref";
  readonly plugin?: string;
  readonly toolspace: string;
  readonly name: string;
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

export type TraitRefInput = string | TraitRefDefinition;
export type AgentRefInput = string | AgentRefDefinition;
export type OrbitRefInput = string | OrbitRefDefinition;
export type ToolRefInput = string | ToolRefDefinition;
export type ToolGroupRefInput = string | ToolGroupRefDefinition;
export type ModelProfileRefInput = string | ModelProfileRefDefinition;
export type SkillRefInput = SkillRefDefinition | SkillspaceRefDefinition;
export type EffectSchemaValue = import("effect").Schema.Schema.AnyNoContext;

export interface AccessDefinition {
  readonly tools?: ReadonlyArray<ToolRefInput>;
  readonly toolGroups?: ReadonlyArray<ToolGroupRefInput>;
  readonly skills?: ReadonlyArray<SkillRefInput>;
}

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly identity: string;
  readonly personality?: string;
  readonly model?: ModelProfileRefInput;
  readonly traits?: ReadonlyArray<TraitRefInput | TraitBindingSource>;
  readonly access?: AccessDefinition;
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

export interface TraitDefinition {
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string | ReadonlyArray<string>;
  readonly access?: AccessDefinition;
  readonly tools?: Readonly<Record<string, TraitToolAttachmentDefinition>>;
  readonly inject?: {
    readonly skills?: ReadonlyArray<SkillRefInput>;
  };
  readonly require?: {
    readonly tools?: ReadonlyArray<string>;
    readonly skills?: ReadonlyArray<SkillRefInput>;
  };
}

export type TraitSource = TraitDefinition;

export interface TraitBindingDefinition {
  readonly kind: "trait-binding";
  readonly trait: TraitRefInput;
  readonly tools?: Readonly<Record<string, TraitBindingToolDefinition>>;
}

export interface PlainTraitBindingDefinition {
  readonly trait: TraitRefInput;
  readonly tools?: Readonly<Record<string, TraitBindingToolDefinition>>;
}

export type TraitBindingSource = TraitBindingDefinition | PlainTraitBindingDefinition;

export interface ToolSchemaSlotDefinition {
  readonly kind: "schema";
  readonly description?: string;
}

export type ToolSlotDefinition = ToolSchemaSlotDefinition;

export interface TraitBindingToolDefinition {
  readonly slots?: Readonly<Record<string, EffectSchemaValue>>;
}

export interface TraitToolAttachmentDefinition {
  readonly ref: string;
}

export interface OrbitParameterDefinition {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface OrbitBindingDefinition {
  readonly orbit: OrbitRefInput;
  readonly bindings?: Readonly<Record<string, string>>;
}

export interface OrbitTraitRequirementDefinition {
  readonly all: ReadonlyArray<TraitRefInput>;
  readonly min?: number;
}

export type OrbitToolPermissionToolDefinition =
  | string
  | {
      readonly ref: string;
      readonly as?: string;
    };

export interface OrbitOrchestratorDefinition {
  readonly agent: AgentRefInput;
  readonly tools: ReadonlyArray<OrbitToolPermissionToolDefinition>;
}

export interface OrbitPhaseWorkflowDefinition {
  readonly when?: string;
  readonly inputs?: ReadonlyArray<string>;
  readonly outputs?: ReadonlyArray<string>;
  readonly sequence?: ReadonlyArray<string>;
  readonly coordination?: string;
  readonly finish_criteria?: ReadonlyArray<string>;
  readonly escalation?: string;
}

export interface OrbitPhaseDefinition {
  readonly name: string;
  readonly orbit?: OrbitRefInput;
  readonly orbit_binding?: OrbitBindingDefinition;
  readonly agents?: ReadonlyArray<AgentRefInput>;
  readonly agent?: AgentRefInput;
  readonly requires?: ReadonlyArray<OrbitTraitRequirementDefinition>;
  readonly notes?: Readonly<Record<string, string>>;
  /**
   * Short structured fields rendered into the root orbit SKILL.md per-phase
   * block. Use these to describe the phase at a glance; deep content belongs
   * in `body` (which lowers to `references/<phase>.md`).
   */
  readonly telos?: string;
  readonly real_world_change?: string;
  readonly cold_pickup_test?: string;
  /**
   * Generic workflow-authoring guidance for this phase. Prism renders this
   * into generated orbit skills, but does not attach runtime semantics to it.
   */
  readonly workflow?: OrbitPhaseWorkflowDefinition;
  /**
   * Long-form markdown for this phase. When present, lowerers write it to
   * `references/<phase-name>.md` next to the orbit SKILL.md. Treat this as
   * the full phase download — telos, procrastination shapes, per-agent
   * focus, links to deeper modules.
   */
  readonly body?: string;
}

export interface OrbitPulsarCheckpointDefinition {
  readonly after?: string;
  readonly before?: string;
  readonly note?: string;
}

export type OrbitSignalEmitterPriority = "low" | "normal" | "high" | "urgent";

export interface OrbitSignalEmitterDestinationDefinition {
  readonly project_key: string;
  readonly orbit: string;
  readonly default_priority?: OrbitSignalEmitterPriority;
  readonly note?: string;
}

export interface OrbitSignalEmitterDefinition {
  /**
   * Known destinations this orbit may emit signals to. Each entry is a
   * `project_key`/`orbit` pair, optionally with a default priority and a
   * note describing what the destination handles. Used as structural
   * documentation, as input for delegation-map validation, and as the
   * basis for tighter bound trait surfaces (e.g., per-destination
   * delegate wrappers) when wanted.
   *
   * Leaving this empty marks the orbit as an emitter without constraining
   * destinations — appropriate when the routing table is fluid or
   * authored entirely in agent doctrine. Filled destinations make the
   * permission surface explicit and reviewable.
   */
  readonly destinations?: ReadonlyArray<OrbitSignalEmitterDestinationDefinition>;
}

export interface OrbitDefinitionEntryDefinition {
  readonly purpose: string;
  readonly contains?: ReadonlyArray<string>;
  readonly boundaries?: ReadonlyArray<string>;
  readonly avoid?: ReadonlyArray<string>;
}

export interface OrbitDefinitionsDefinition {
  readonly glyphs?: OrbitDefinitionEntryDefinition;
  readonly dispatches?: OrbitDefinitionEntryDefinition;
  readonly chatter?: OrbitDefinitionEntryDefinition;
  readonly signals?: OrbitDefinitionEntryDefinition;
}

export interface OrbitDefinition {
  readonly name: string;
  readonly description: string;
  readonly produces?: string;
  readonly definitions?: OrbitDefinitionsDefinition;
  readonly parameters?: ReadonlyArray<OrbitParameterDefinition>;
  readonly phases: ReadonlyArray<OrbitPhaseDefinition>;
  readonly orchestrator?: OrbitOrchestratorDefinition;
  readonly tool_permissions?: ReadonlyArray<OrbitToolPermissionToolDefinition>;
  readonly pulsar_checkpoints?: ReadonlyArray<OrbitPulsarCheckpointDefinition>;
  readonly evolution?: string;
  readonly body?: string;
  /**
   * When present, declares this orbit emits signals to other orbits — the
   * routing/delegation surface that is privileged separately from the
   * receive-side signal tools. Authors should attach the `signal-emitter`
   * trait (from the `oracle` plugin) to the orchestrator agent (and to
   * any other phase agent that authentically owns inter-orbit
   * delegation). Declared `destinations` make the routing surface
   * explicit and auditable.
   */
  readonly signal_emitter?: OrbitSignalEmitterDefinition;
}

export type OrbitSource = OrbitDefinition;

export interface ToolTargetBindingDefinition {
  readonly name: string;
}

export interface ToolDefinition {
  readonly description?: string;
  readonly targets: Readonly<Record<string, ToolTargetBindingDefinition>>;
}

export interface ToolGroupDefinition {
  readonly description?: string;
  readonly tools: ReadonlyArray<ToolRefInput>;
}

export interface ToolspaceDefinition {
  readonly name: string;
  readonly description?: string;
  readonly tools: Readonly<Record<string, ToolDefinition>>;
  readonly groups?: Readonly<Record<string, ToolGroupDefinition>>;
}

export type ToolspaceSource = ToolspaceDefinition;

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

export type HookEventPayloadDefinition =
  | ToolBeforeHookEventDefinition
  | ToolAfterHookEventDefinition
  | PromptSubmitHookEventDefinition
  | PermissionRequestHookEventDefinition
  | SessionStartHookEventDefinition
  | SessionEndHookEventDefinition;

export type HookEventPayloadFor<E extends HookEvent> = Extract<
  HookEventPayloadDefinition,
  { readonly event: E }
>;

export interface ContinueHookResultDefinition {
  readonly decision: "continue";
  readonly systemMessage?: string;
  readonly additionalContext?: string;
}

export interface BlockHookResultDefinition {
  readonly decision: "block";
  readonly message: string;
}

export interface AllowHookResultDefinition {
  readonly decision: "allow";
  readonly systemMessage?: string;
}

export type ToolBeforeHookResultDefinition =
  | ContinueHookResultDefinition
  | BlockHookResultDefinition;

export type PermissionRequestHookResultDefinition =
  | ContinueHookResultDefinition
  | AllowHookResultDefinition
  | BlockHookResultDefinition;

export type HookResultFor<E extends HookEvent> = E extends typeof hookEvent.toolBefore
  ? ToolBeforeHookResultDefinition
  : E extends typeof hookEvent.permissionRequest
    ? PermissionRequestHookResultDefinition
    : ContinueHookResultDefinition;

export type HookHandlerDefinition<E extends HookEvent> = (
  event: HookEventPayloadFor<E>,
) => import("effect").Effect.Effect<HookResultFor<E>, unknown, never>;

export interface HookAnyToolMatcherDefinition {
  readonly kind: "hook-any-tool";
}

export interface HookToolspaceToolMatcherDefinition {
  readonly kind: "hook-toolspace-tool";
  readonly tool: ToolRefInput;
}

export interface HookToolspaceGroupMatcherDefinition {
  readonly kind: "hook-toolspace-group";
  readonly group: ToolGroupRefInput;
}

export interface HookCanonicalToolMatcherDefinition {
  readonly kind: "hook-canonical-tool";
  readonly ref: string;
}

export type HookToolMatcherDefinition =
  | HookAnyToolMatcherDefinition
  | HookToolspaceToolMatcherDefinition
  | HookToolspaceGroupMatcherDefinition
  | HookCanonicalToolMatcherDefinition;

export interface ToolHookMatchDefinition {
  readonly tool?: HookToolMatcherDefinition;
}

export type HookMatchDefinition<E extends HookEvent> = E extends
  | typeof hookEvent.toolBefore
  | typeof hookEvent.toolAfter
  | typeof hookEvent.permissionRequest
  ? ToolHookMatchDefinition
  : never;

export interface HookDefinition<E extends HookEvent = HookEvent> {
  readonly name: string;
  readonly description?: string;
  readonly event: E;
  readonly targets?: readonly string[];
  readonly match?: HookMatchDefinition<E>;
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

export function traitRef(name: string): TraitRefDefinition;
export function traitRef(plugin: string, name: string): TraitRefDefinition;
export function traitRef(first: string, second?: string): TraitRefDefinition {
  return withNamedRef("trait-ref", first, second);
}

export function agentRef(name: string): AgentRefDefinition;
export function agentRef(plugin: string, name: string): AgentRefDefinition;
export function agentRef(first: string, second?: string): AgentRefDefinition {
  return withNamedRef("agent-ref", first, second);
}

export function orbitRef(name: string): OrbitRefDefinition;
export function orbitRef(plugin: string, name: string): OrbitRefDefinition;
export function orbitRef(first: string, second?: string): OrbitRefDefinition {
  return withNamedRef("orbit-ref", first, second);
}

export function toolRef(toolspace: string, name: string): ToolRefDefinition;
export function toolRef(
  plugin: string,
  toolspace: string,
  name: string,
): ToolRefDefinition;
export function toolRef(
  first: string,
  second: string,
  third?: string,
): ToolRefDefinition {
  return third === undefined
    ? { kind: "tool-ref", toolspace: first, name: second }
    : { kind: "tool-ref", plugin: first, toolspace: second, name: third };
}

export function toolGroupRef(
  toolspace: string,
  name: string,
): ToolGroupRefDefinition;
export function toolGroupRef(
  plugin: string,
  toolspace: string,
  name: string,
): ToolGroupRefDefinition;
export function toolGroupRef(
  first: string,
  second: string,
  third?: string,
): ToolGroupRefDefinition {
  return third === undefined
    ? { kind: "tool-group-ref", toolspace: first, name: second }
    : { kind: "tool-group-ref", plugin: first, toolspace: second, name: third };
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

export const bindTrait = (
  trait: TraitRefInput,
  options: { readonly tools?: Readonly<Record<string, TraitBindingToolDefinition>> } = {},
): TraitBindingDefinition => ({
  kind: "trait-binding",
  trait,
  ...(options.tools ? { tools: options.tools } : {}),
});

export const hookTool = {
  any: (): HookAnyToolMatcherDefinition => ({ kind: "hook-any-tool" }),
  tool: (tool: ToolRefInput): HookToolspaceToolMatcherDefinition => ({
    kind: "hook-toolspace-tool",
    tool,
  }),
  group: (group: ToolGroupRefInput): HookToolspaceGroupMatcherDefinition => ({
    kind: "hook-toolspace-group",
    group,
  }),
  canonical: (ref: string): HookCanonicalToolMatcherDefinition => ({
    kind: "hook-canonical-tool",
    ref,
  }),
} as const;

export const hookMatcher = {
  tool: hookTool,
} as const;

/** Transitional identity wrapper. The canonical public source type is `AgentSource`. */
export const defineAgent = <T extends AgentSource>(agent: T): T => agent;
/** Transitional identity wrapper. The canonical public source type is `TraitSource`. */
export const defineTrait = <T extends TraitSource>(trait: T): T => trait;
/** Transitional identity wrapper. The canonical public source type is `OrbitSource`. */
export const defineOrbit = <T extends OrbitSource>(orbit: T): T =>
  orbit;
/** Transitional identity wrapper. The canonical public source type is `ToolSource`. */
export const defineTool = <T extends ToolSource>(tool: T): T => tool;
/** Transitional identity wrapper. The canonical public source type is `ToolspaceSource`. */
export const defineToolspace = <T extends ToolspaceSource>(toolspace: T): T =>
  toolspace;
/** Transitional identity wrapper. The canonical public source type is `ModelspaceSource`. */
export const defineModelspace = <T extends ModelspaceSource>(modelspace: T): T =>
  modelspace;
/** Transitional identity wrapper. The canonical public source type is `SkillspaceSource`. */
export const defineSkillspace = <T extends SkillspaceSource>(skillspace: T): T =>
  skillspace;
/** Transitional identity wrapper. The canonical public source type is `HookSource`. */
export const defineHook = <E extends HookEvent, T extends HookSource<E>>(
  hook: T,
): T => hook;

export type { ToolRuntimeContext, ToolRuntimeCost } from "./compile/runtime/schema-bridge";
