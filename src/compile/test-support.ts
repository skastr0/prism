/**
 * Pure, in-memory builders for compile-phase contract tests.
 *
 * These helpers intentionally avoid filesystem access and produce minimal
 * valid instances of the compile-language source and resolved types.
 */

import { Schema } from "effect";
import { emptyRegistry } from "./registry.js";
import type { PluginRegistry } from "./registry.js";
import type { ResolvedAgent } from "./resolve.js";
import {
  Agent,
  CanonicalTool,
  Identity,
  Modelspace,
  Orbit,
  Personality,
  Skill,
  Skillspace,
  type NormalizedOrbitPhase,
  type ToolAuthority,
} from "./sources.js";

export interface RegistryOptions {
  readonly pluginPath?: string;
  readonly pluginName?: string;
  readonly pluginVersion?: string;
  readonly dependencyPaths?: Record<string, string>;
  readonly targets?: Parameters<typeof emptyRegistry>[4];
  readonly runtime?: Parameters<typeof emptyRegistry>[5];
}

export const makeRegistry = (options: RegistryOptions = {}): PluginRegistry =>
  emptyRegistry(
    options.pluginPath ?? "/test/plugin",
    options.pluginName ?? "test-plugin",
    options.pluginVersion ?? "0.1.0",
    options.dependencyPaths ?? {},
    options.targets ?? {},
    options.runtime ?? {},
  );

export interface IdentityOptions {
  readonly name?: string;
  readonly sourcePath?: string;
  readonly description?: string;
  readonly body?: string;
}

export const makeIdentity = (options: IdentityOptions = {}): Identity =>
  new Identity({
    name: options.name ?? "builder",
    sourcePath: options.sourcePath ?? "/test/plugin/identities/builder.identity.md",
    description: options.description ?? "Builder identity.",
    body: options.body ?? "# Builder\n\nBuilds scoped changes.",
  });

export interface PersonalityOptions {
  readonly name?: string;
  readonly sourcePath?: string;
  readonly description?: string;
  readonly body?: string;
  readonly temperament?: string;
  readonly communication?: string;
}

export const makePersonality = (options: PersonalityOptions = {}): Personality =>
  new Personality({
    name: options.name ?? "focused",
    sourcePath: options.sourcePath ?? "/test/plugin/personalities/focused.personality.md",
    description: options.description ?? "Focused personality.",
    body: options.body ?? "Stay focused.",
    temperament: options.temperament,
    communication: options.communication,
  });

export interface ToolOptions {
  readonly name?: string;
  readonly sourcePath?: string;
  readonly description?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly slots?: Record<string, { kind: "schema"; description?: string }>;
  readonly handle?: (...args: Array<unknown>) => unknown;
  readonly authority?: ToolAuthority;
}

export const makeTool = (options: ToolOptions = {}): CanonicalTool =>
  new CanonicalTool({
    name: options.name ?? "submit_review",
    sourcePath: options.sourcePath ?? "/test/plugin/tools/submit_review.tool.ts",
    description: options.description ?? "Submit review findings.",
    input: options.input ?? Schema.Struct({ summary: Schema.String }),
    output: options.output ?? Schema.Struct({ acknowledged: Schema.Boolean }),
    slots: options.slots ?? {},
    handle: options.handle ?? (async () => ({ acknowledged: true })),
    authority: options.authority,
  });

export interface ModelspaceOptions {
  readonly name?: string;
  readonly sourcePath?: string;
  readonly description?: string;
  readonly profiles?: Record<string, { description?: string; targets: Record<string, object> }>;
}

export const makeModelspace = (options: ModelspaceOptions = {}): Modelspace =>
  new Modelspace({
    name: options.name ?? "models",
    sourcePath: options.sourcePath ?? "/test/plugin/modelspaces/models.modelspace.ts",
    description: options.description,
    profiles: options.profiles ?? {},
  });

export interface SkillspaceOptions {
  readonly name?: string;
  readonly sourcePath?: string;
  readonly description?: string;
  readonly skills?: Record<string, { description?: string; targets: Record<string, { name: string }> }>;
}

export const makeSkillspace = (options: SkillspaceOptions = {}): Skillspace =>
  new Skillspace({
    name: options.name ?? "global",
    sourcePath: options.sourcePath ?? "/test/plugin/skillspaces/global.skillspace.ts",
    description: options.description,
    skills: options.skills ?? {},
  });

export interface SkillOptions {
  readonly name?: string;
  readonly sourcePath?: string;
}

export const makeSkill = (options: SkillOptions = {}): Skill =>
  new Skill({
    name: options.name ?? "testing",
    sourcePath: options.sourcePath ?? "/test/plugin/skills/testing/SKILL.md",
  });

export interface AgentOptions {
  readonly name?: string;
  readonly sourcePath?: string;
  readonly description?: string;
  readonly identity?: string;
  readonly personality?: string;
  readonly model?: string;
  readonly skills?: ReadonlyArray<string>;
  readonly color?: string;
  readonly targets?: Record<string, Record<string, unknown>>;
}

export const makeAgent = (options: AgentOptions = {}): Agent =>
  new Agent({
    name: options.name ?? "builder",
    sourcePath: options.sourcePath ?? "/test/plugin/agents/builder.agent.ts",
    description: options.description ?? "Builds scoped changes.",
    identity: options.identity ?? "builder",
    personality: options.personality,
    model: options.model,
    skills: options.skills ?? [],
    color: options.color,
    targets: options.targets ?? {},
  });

export interface OrbitOptions {
  readonly name?: string;
  readonly sourcePath?: string;
  readonly description?: string;
  readonly produces?: string;
  readonly parameters?: ReadonlyArray<{ name: string; description?: string; required?: boolean }>;
  readonly phases?: ReadonlyArray<Partial<NormalizedOrbitPhase> & Pick<NormalizedOrbitPhase, "name">>;
  readonly body?: string;
  readonly evolution?: string;
}

export const makeOrbit = (options: OrbitOptions = {}): Orbit =>
  new Orbit({
    name: options.name ?? "delivery",
    sourcePath: options.sourcePath ?? "/test/plugin/orbits/delivery.orbit.ts",
    description: options.description ?? "Delivery orbit.",
    produces: options.produces,
    parameters: options.parameters ?? [],
    phases: options.phases?.map((phase) => ({
      name: phase.name,
      orbit: phase.orbit,
      orbit_binding: phase.orbit_binding,
      agent: phase.agent,
      agents: phase.agents ?? [],
      notes: phase.notes,
      telos: phase.telos,
      real_world_change: phase.real_world_change,
      cold_pickup_test: phase.cold_pickup_test,
      workflow: phase.workflow,
      contract: phase.contract,
      body: phase.body,
    })) ?? [],
    orchestrator: undefined,
    pulsar_checkpoints: [],
    evolution: options.evolution,
    body: options.body ?? "",
  });

export interface ResolvedAgentOptions {
  readonly agent?: Agent;
  readonly identity?: Identity;
  readonly personality?: Personality;
  readonly resolvedModel?: Record<string, unknown>;
  readonly skills?: ReadonlyArray<string>;
}

export const makeResolvedAgent = (options: ResolvedAgentOptions = {}): ResolvedAgent => ({
  agent: options.agent ?? makeAgent(),
  identity: options.identity ?? makeIdentity(),
  personality: options.personality,
  resolvedModel: options.resolvedModel,
  skills: options.skills ?? [],
});

export const addToRegistry = (registry: PluginRegistry, entities: {
  readonly identities?: ReadonlyArray<Identity>;
  readonly personalities?: ReadonlyArray<Personality>;
  readonly tools?: ReadonlyArray<CanonicalTool>;
  readonly modelspaces?: ReadonlyArray<Modelspace>;
  readonly skillspaces?: ReadonlyArray<Skillspace>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly agents?: ReadonlyArray<Agent>;
  readonly orbits?: ReadonlyArray<Orbit>;
  readonly deps?: ReadonlyArray<PluginRegistry>;
}): PluginRegistry => {
  for (const identity of entities.identities ?? []) {
    registry.identities.set(identity.name, identity);
  }
  for (const personality of entities.personalities ?? []) {
    registry.personalities.set(personality.name, personality);
  }
  for (const tool of entities.tools ?? []) {
    registry.tools.set(tool.name, tool);
  }
  for (const modelspace of entities.modelspaces ?? []) {
    registry.modelspaces.set(modelspace.name, modelspace);
  }
  for (const skillspace of entities.skillspaces ?? []) {
    registry.skillspaces.set(skillspace.name, skillspace);
  }
  for (const skill of entities.skills ?? []) {
    registry.skills.set(skill.name, skill);
  }
  for (const agent of entities.agents ?? []) {
    registry.agents.set(agent.name, agent);
  }
  for (const orbit of entities.orbits ?? []) {
    registry.orbits.set(orbit.name, orbit);
  }
  for (const dep of entities.deps ?? []) {
    registry.deps.set(dep.pluginName, dep);
  }
  return registry;
};
