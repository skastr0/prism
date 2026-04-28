/**
 * Public authoring API for structured compile-language artifacts.
 *
 * The canonical structured source model is TypeScript-first:
 * - agents/*.agent.ts
 * - traits/*.trait.ts
 * - lifecycles/*.lifecycle.ts
 * - toolspaces/*.toolspace.ts
 * - modelspaces/*.modelspace.ts
 *
 * These helpers are identity constructors for authoring ergonomics.
 */

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

export interface LifecycleRefDefinition extends NamedRefDefinition {
  readonly kind: "lifecycle-ref";
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

export type TraitRefInput = string | TraitRefDefinition;
export type AgentRefInput = string | AgentRefDefinition;
export type LifecycleRefInput = string | LifecycleRefDefinition;
export type ToolRefInput = string | ToolRefDefinition;
export type ToolGroupRefInput = string | ToolGroupRefDefinition;
export type ModelProfileRefInput = string | ModelProfileRefDefinition;
export type EffectSchemaValue = import("effect").Schema.Schema.AnyNoContext;

export interface AccessDefinition {
  readonly tools?: ReadonlyArray<ToolRefInput>;
  readonly toolGroups?: ReadonlyArray<ToolGroupRefInput>;
}

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly identity: string;
  readonly personality?: string;
  readonly model?: ModelProfileRefInput;
  readonly traits?: ReadonlyArray<TraitRefInput | TraitBindingDefinition>;
  readonly access?: AccessDefinition;
  readonly skills?: ReadonlyArray<string>;
  readonly color?: string;
  readonly targets?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface CanonicalToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input: EffectSchemaValue;
  readonly output: EffectSchemaValue;
  readonly slots?: Readonly<Record<string, ToolSlotDefinition>>;
  readonly handle: (input: unknown, context: import("./compile/runtime/schema-bridge").ToolRuntimeContext) => Promise<unknown>;
}

export interface TraitDefinition {
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string | ReadonlyArray<string>;
  readonly access?: AccessDefinition;
  readonly tools?: Readonly<Record<string, TraitToolAttachmentDefinition>>;
  readonly inject?: {
    readonly skills?: ReadonlyArray<string>;
  };
  readonly require?: {
    readonly tools?: ReadonlyArray<string>;
    readonly skills?: ReadonlyArray<string>;
  };
}

export interface TraitBindingDefinition {
  readonly kind: "trait-binding";
  readonly trait: TraitRefInput;
  readonly tools?: Readonly<Record<string, TraitBindingToolDefinition>>;
}

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

export interface LifecycleParameterDefinition {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface LifecycleBindingDefinition {
  readonly lifecycle: LifecycleRefInput;
  readonly bindings?: Readonly<Record<string, string>>;
}

export interface LifecycleTraitRequirementDefinition {
  readonly all: ReadonlyArray<TraitRefInput>;
  readonly min?: number;
}

export type LifecycleToolPermissionToolDefinition =
  | string
  | {
      readonly ref: string;
      readonly as?: string;
    };

export interface LifecycleToolPermissionDefinition {
  readonly agents: ReadonlyArray<AgentRefInput>;
  readonly tools: ReadonlyArray<LifecycleToolPermissionToolDefinition>;
}

export interface LifecyclePhaseDefinition {
  readonly name: string;
  readonly lifecycle?: LifecycleRefInput;
  readonly lifecycle_binding?: LifecycleBindingDefinition;
  readonly agents?: ReadonlyArray<AgentRefInput>;
  readonly agent?: AgentRefInput;
  readonly requires?: ReadonlyArray<LifecycleTraitRequirementDefinition>;
  readonly notes?: Readonly<Record<string, string>>;
}

export interface LifecycleTasteCheckpointDefinition {
  readonly after?: string;
  readonly before?: string;
  readonly note?: string;
}

export interface LifecycleDefinition {
  readonly name: string;
  readonly description: string;
  readonly produces?: string;
  readonly parameters?: ReadonlyArray<LifecycleParameterDefinition>;
  readonly phases: ReadonlyArray<LifecyclePhaseDefinition>;
  readonly tool_permissions?: ReadonlyArray<LifecycleToolPermissionDefinition>;
  readonly taste_checkpoints?: ReadonlyArray<LifecycleTasteCheckpointDefinition>;
  readonly evolution?: string;
  readonly body?: string;
}

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

export interface ModelProfileDefinition {
  readonly description?: string;
  readonly targets: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface ModelspaceDefinition {
  readonly name: string;
  readonly description?: string;
  readonly profiles: Readonly<Record<string, ModelProfileDefinition>>;
}

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

export function lifecycleRef(name: string): LifecycleRefDefinition;
export function lifecycleRef(plugin: string, name: string): LifecycleRefDefinition;
export function lifecycleRef(first: string, second?: string): LifecycleRefDefinition {
  return withNamedRef("lifecycle-ref", first, second);
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

export const defineAgent = <T extends AgentDefinition>(agent: T): T => agent;
export const defineTrait = <T extends TraitDefinition>(trait: T): T => trait;
export const defineLifecycle = <T extends LifecycleDefinition>(lifecycle: T): T =>
  lifecycle;
export const defineTool = <T extends CanonicalToolDefinition>(tool: T): T => tool;
export const defineToolspace = <T extends ToolspaceDefinition>(toolspace: T): T =>
  toolspace;
export const defineModelspace = <T extends ModelspaceDefinition>(modelspace: T): T =>
  modelspace;

export type { ToolRuntimeContext, ToolRuntimeCost } from "./compile/runtime/schema-bridge";
