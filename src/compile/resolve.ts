/**
 * Resolve phase: materialize referenced parts for each agent and validate
 * orbit wiring against the loaded registry graph.
 */

import { Effect, Schema } from "effect";
import type {
  CompileManifestOrbitPhase,
  CompileManifestOrbitPhaseContract,
} from "@skastr0/prism-sdk/compile-manifest";
import type { CompileManifestOrbitProjectionInput } from "./compile-manifest.js";
import {
  workflowJsonSchemaFromEffectSchema,
  WorkflowOutputSchemaError,
} from "../workflow-output-schema.js";
import {
  Agent,
  ClaudeCodeModelTarget,
  Contract,
  Identity,
  type ModelProfile,
  Orbit,
  OpenCodeModelTargetBlock,
  Personality,
  Trait,
  type OrbitParameter,
  type OrbitDefinitions,
  type OrbitDefinitionEntry,
  type OrbitPulsarCheckpoint,
  type NormalizedOrbitPhase as OrbitPhase,
  type NormalizedTraitBinding,
} from "./sources.js";
import {
  AgentValidationError,
  OrbitValidationError,
  MissingTargetResolutionError,
  SourceParseError,
  UnknownReferenceError,
  type CompileError,
} from "./errors.js";
import {
  materializeOrbitToolPermission,
  materializeTraitTools,
  validateTraitBindingSlots,
  type MaterializedTraitTool,
} from "./protocol-tools.js";
import type { PluginRegistry } from "./registry.js";
import { resolveManifestTargets } from "../manifest.js";
import { getCompileTargetCapabilities } from "./target-capabilities.js";
import { parseNamedRef, parseSpaceItemRef, resolveRefToRegistry } from "./refs.js";

export interface ResolvedContractBinding {
  readonly kind: "permission" | "synthetic";
  readonly logicalName: string;
  readonly contract?: Contract;
  readonly toolPluginName: string;
  readonly toolName: string;
  readonly toolSourcePath: string;
}

export interface ResolvedToolReference {
  readonly kind: "permission" | "synthetic";
  readonly logicalName: string;
  readonly contract?: Contract;
  readonly toolPluginName: string;
  readonly toolName: string;
  readonly toolSourcePath: string;
}

export interface ResolvedTrait {
  readonly ref: string;
  readonly canonicalId: string;
  readonly trait: Trait;
  readonly owner: PluginRegistry;
  readonly binding: NormalizedTraitBinding;
}

export interface ResolvedAgentCapabilities {
  readonly agent: Agent;
  readonly traits: ReadonlyArray<ResolvedTrait>;
  readonly canonicalTraitIds: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly toolRefs: ReadonlyArray<ResolvedToolReference>;
  readonly access: {
    readonly tools: ReadonlyArray<string>;
    readonly toolGroups: ReadonlyArray<string>;
    readonly skills: ReadonlyArray<string>;
  };
}

export interface ResolvedAgent {
  readonly agent: Agent;
  readonly identity: Identity;
  readonly personality: Personality | undefined;
  readonly resolvedModel: Record<string, unknown> | undefined;
  readonly traits: ReadonlyArray<ResolvedTrait>;
  readonly canonicalTraitIds: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly allowedSkills: ReadonlyArray<string>;
  readonly toolBindings: ReadonlyArray<ResolvedContractBinding>;
  readonly allowedTools: ReadonlyArray<string>;
}

type BindingMap = Readonly<Record<string, string>>;

const TEMPLATE_PARAMETER_PATTERN = /\$\{([^}]+)\}/g;

const decodeResolvedTargetBlock = <A>(
  sourcePath: string,
  target: string,
  schema: Schema.Schema<A, A, never>,
  value: unknown,
): A | SourceParseError => {
  const result = Schema.decodeUnknownEither(schema)(value);
  if (result._tag === "Left") {
    return new SourceParseError({
      sourcePath,
      kind: "modelspace",
      message: `invalid '${target}' target block: ${result.left.message}`,
    });
  }

  return result.right;
};

const stableModelPeerKey = (agent: Agent): string =>
  `${agent.name}:${agent.sourcePath}`;

const stableModelPeers = (
  agent: Agent,
  registry: PluginRegistry,
): readonly Agent[] => {
  if (!agent.model) return [agent];

  return [...registry.agents.values()]
    .filter((candidate) => candidate.model === agent.model)
    .sort((left, right) => stableModelPeerKey(left).localeCompare(stableModelPeerKey(right)));
};

const selectOpenCodeModelTarget = (
  agent: Agent,
  registry: PluginRegistry,
  sourcePath: string,
  targetBlock: typeof OpenCodeModelTargetBlock.Type,
): Record<string, unknown> | SourceParseError => {
  if (!("strategy" in targetBlock)) {
    return targetBlock;
  }

  if (targetBlock.models.length === 0) {
    return new SourceParseError({
      sourcePath,
      kind: "modelspace",
      message: "invalid 'opencode' target block: model pool must include at least one model",
    });
  }

  if (targetBlock.strategy === "ordered") {
    return targetBlock.models[0] as Record<string, unknown>;
  }

  const peers = stableModelPeers(agent, registry);
  const peerIndex = Math.max(
    0,
    peers.findIndex((peer) => peer.name === agent.name && peer.sourcePath === agent.sourcePath),
  );
  return targetBlock.models[peerIndex % targetBlock.models.length] as Record<string, unknown>;
};

const resolveModelTargetBlock = (
  agent: Agent,
  registry: PluginRegistry,
  sourcePath: string,
  target: string,
  targetBlock: unknown,
): Record<string, unknown> | SourceParseError => {
  switch (target) {
    case "opencode": {
      const decoded = decodeResolvedTargetBlock(
        sourcePath,
        target,
        OpenCodeModelTargetBlock,
        targetBlock,
      );
      if (decoded instanceof SourceParseError) return decoded;
      return selectOpenCodeModelTarget(agent, registry, sourcePath, decoded);
    }
    case "claude-code":
      return decodeResolvedTargetBlock(
        sourcePath,
        target,
        ClaudeCodeModelTarget,
        targetBlock,
      );
    default:
      return targetBlock as Record<string, unknown>;
  }
};

const agentError = (
  agent: Agent,
  field: string,
  message: string,
): AgentValidationError =>
  new AgentValidationError({
    sourcePath: agent.sourcePath,
    agentName: agent.name,
    field,
    message,
  });

const canonicalTraitId = (owner: PluginRegistry, trait: Trait): string =>
  `${owner.pluginName}:${trait.name}`;

const resolveTraitReference = (
  agent: Agent,
  binding: NormalizedTraitBinding,
  registry: PluginRegistry,
): Effect.Effect<ResolvedTrait, CompileError> =>
  Effect.gen(function* () {
    const reg = yield* resolveRefToRegistry(binding.ref, registry, agent.sourcePath);
    const name = parseNamedRef(binding.ref).name;
    const trait = reg.traits.get(name);
    if (!trait) {
      return yield* Effect.fail(
        new UnknownReferenceError({
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          field: "trait",
          referenceName: binding.ref,
        }),
      );
    }

    const slotValidation = validateTraitBindingSlots(trait, binding);
    if (!slotValidation.ok) {
      return yield* Effect.fail(
        agentError(
          agent,
          "traits",
          `trait '${canonicalTraitId(reg, trait)}' ${slotValidation.error.message}`,
        ),
      );
    }

    return {
      ref: binding.ref,
      canonicalId: canonicalTraitId(reg, trait),
      trait,
      owner: reg,
      binding,
    };
  });

type ResolvedTraitSet = {
  readonly traits: ResolvedTrait[];
  readonly canonicalIds: Set<string>;
};

type MaterializedTraitToolWithOwner = MaterializedTraitTool & {
  readonly traitId: string;
};

type AgentAccessAccumulator = {
  readonly tools: Set<string>;
  readonly toolGroups: Set<string>;
  readonly skills: Set<string>;
};

const resolveAgentTraits = (
  agent: Agent,
  registry: PluginRegistry,
): Effect.Effect<ResolvedTraitSet, CompileError> =>
  Effect.gen(function* () {
    const traits: ResolvedTrait[] = [];
    const canonicalIds = new Set<string>();

    for (const [index, binding] of agent.traits.entries()) {
      const resolvedTrait = yield* resolveTraitReference(agent, binding, registry);
      if (canonicalIds.has(resolvedTrait.canonicalId)) {
        return yield* Effect.fail(
          agentError(
            agent,
            `traits[${index}]`,
            `declares duplicate trait '${resolvedTrait.canonicalId}'`,
          ),
        );
      }
      canonicalIds.add(resolvedTrait.canonicalId);
      traits.push(resolvedTrait);
    }

    return { traits, canonicalIds };
  });

const createAccessAccumulator = (agent: Agent): AgentAccessAccumulator => ({
  tools: new Set(agent.access.tools),
  toolGroups: new Set(agent.access.toolGroups),
  skills: new Set(agent.access.skills),
});

const mergeTraitAccess = (
  access: AgentAccessAccumulator,
  trait: Trait,
): void => {
  for (const skill of trait.inject.skills) {
    access.skills.add(skill);
  }
  for (const toolRef of trait.access.tools) {
    access.tools.add(toolRef);
  }
  for (const toolGroupRef of trait.access.toolGroups) {
    access.toolGroups.add(toolGroupRef);
  }
  for (const skill of trait.access.skills) {
    access.skills.add(skill);
  }
};

const traitToolBindingsMatch = (
  existing: MaterializedTraitToolWithOwner,
  next: MaterializedTraitTool,
): boolean =>
  existing.kind === next.kind &&
  existing.toolPluginName === next.toolPluginName &&
  existing.toolName === next.toolName &&
  existing.contract?.pluginName === next.contract?.pluginName &&
  existing.contract?.name === next.contract?.name;

const addTraitToolBinding = (
  agent: Agent,
  finalToolRefs: Map<string, MaterializedTraitToolWithOwner>,
  resolvedTrait: ResolvedTrait,
  materialized: MaterializedTraitTool,
): AgentValidationError | undefined => {
  const existing = finalToolRefs.get(materialized.logicalName);
  if (!existing) {
    finalToolRefs.set(materialized.logicalName, {
      ...materialized,
      traitId: resolvedTrait.canonicalId,
    });
    return undefined;
  }

  if (traitToolBindingsMatch(existing, materialized)) {
    return undefined;
  }

  return agentError(
    agent,
    "traits",
    `traits '${existing.traitId}' and '${resolvedTrait.canonicalId}' define conflicting tool bindings for '${materialized.logicalName}'`,
  );
};

const mergeTraitTools = (
  agent: Agent,
  registry: PluginRegistry,
  finalToolRefs: Map<string, MaterializedTraitToolWithOwner>,
  resolvedTrait: ResolvedTrait,
): AgentValidationError | undefined => {
  const materializedTraitTools = materializeTraitTools({
    agentName: agent.name,
    ownerPluginName: registry.pluginName,
    canonicalTraitId: resolvedTrait.canonicalId,
    trait: resolvedTrait.trait,
    binding: resolvedTrait.binding,
    registry,
    refRegistry: resolvedTrait.owner,
  });
  if (!(materializedTraitTools instanceof Array)) {
    return agentError(
      agent,
      "traits",
      `trait '${resolvedTrait.canonicalId}' ${materializedTraitTools.message}`,
    );
  }

  for (const materialized of materializedTraitTools) {
    const error = addTraitToolBinding(
      agent,
      finalToolRefs,
      resolvedTrait,
      materialized,
    );
    if (error) return error;
  }

  return undefined;
};

const collectTraitAccessGrants = (
  agent: Agent,
  resolvedTraits: ReadonlyArray<ResolvedTrait>,
): AgentAccessAccumulator => {
  const access = createAccessAccumulator(agent);
  for (const resolvedTrait of resolvedTraits) {
    mergeTraitAccess(access, resolvedTrait.trait);
  }

  return access;
};

const materializeAndMergeTraitTools = (
  agent: Agent,
  registry: PluginRegistry,
  resolvedTraits: ReadonlyArray<ResolvedTrait>,
): Map<string, MaterializedTraitToolWithOwner> | AgentValidationError => {
  const toolRefs = new Map<string, MaterializedTraitToolWithOwner>();

  for (const resolvedTrait of resolvedTraits) {
    const error = mergeTraitTools(agent, registry, toolRefs, resolvedTrait);
    if (error) return error;
  }

  return toolRefs;
};

const validateRequiredTraitTools = (
  agent: Agent,
  resolvedTraits: ReadonlyArray<ResolvedTrait>,
  finalToolRefs: ReadonlyMap<string, MaterializedTraitToolWithOwner>,
): AgentValidationError | undefined => {
  const availableToolNames = new Set(finalToolRefs.keys());
  for (const resolvedTrait of resolvedTraits) {
    const missingTools = resolvedTrait.trait.require.tools.filter(
      (logicalName) => !availableToolNames.has(logicalName),
    );
    if (missingTools.length === 0) continue;

    const missingParts = [
      missingTools.length > 0 ? `tools: ${missingTools.join(", ")}` : undefined,
    ].filter((part): part is string => part !== undefined);

    return agentError(
      agent,
      "traits",
      `trait '${resolvedTrait.canonicalId}' requires missing ${missingParts.join("; ")}`,
    );
  }

  return undefined;
};

const sortedToolRefs = (
  finalToolRefs: ReadonlyMap<string, MaterializedTraitToolWithOwner>,
): ResolvedToolReference[] =>
  [...finalToolRefs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([logicalName, resolved]) => ({
      logicalName,
      kind: resolved.kind,
      contract: resolved.contract,
      toolPluginName: resolved.toolPluginName,
      toolName: resolved.toolName,
      toolSourcePath: resolved.toolSourcePath,
    }));

const buildResolvedAgentCapabilities = (
  agent: Agent,
  resolvedTraits: ResolvedTraitSet,
  grants: {
    readonly access: AgentAccessAccumulator;
    readonly toolRefs: ReadonlyMap<string, MaterializedTraitToolWithOwner>;
  },
): ResolvedAgentCapabilities => ({
  agent,
  traits: resolvedTraits.traits,
  canonicalTraitIds: [...resolvedTraits.canonicalIds].sort((left, right) =>
    left.localeCompare(right),
  ),
  skills: [...agent.skills],
  toolRefs: sortedToolRefs(grants.toolRefs),
  access: {
    tools: [...grants.access.tools].sort((left, right) => left.localeCompare(right)),
    toolGroups: [...grants.access.toolGroups].sort((left, right) =>
      left.localeCompare(right),
    ),
    skills: [...grants.access.skills].sort((left, right) =>
      left.localeCompare(right),
    ),
  },
});

export const resolveAgentCapabilities = (
  agent: Agent,
  registry: PluginRegistry,
): Effect.Effect<ResolvedAgentCapabilities, CompileError> =>
  Effect.gen(function* () {
    const resolvedTraits = yield* resolveAgentTraits(agent, registry);

    const access = collectTraitAccessGrants(agent, resolvedTraits.traits);
    const toolRefs = materializeAndMergeTraitTools(
      agent,
      registry,
      resolvedTraits.traits,
    );
    if (toolRefs instanceof AgentValidationError) {
      return yield* Effect.fail(toolRefs);
    }

    const requirementError = validateRequiredTraitTools(
      agent,
      resolvedTraits.traits,
      toolRefs,
    );
    if (requirementError) return yield* Effect.fail(requirementError);

    return buildResolvedAgentCapabilities(agent, resolvedTraits, { access, toolRefs });
  });

const resolveToolRefForTarget = (
  agent: Agent,
  toolRef: string,
  registry: PluginRegistry,
  target: string,
  currentRegistry: PluginRegistry = registry,
): Effect.Effect<string, CompileError> =>
  Effect.gen(function* () {
    const parsed = parseSpaceItemRef(toolRef, "/");
    if (!parsed) {
      return yield* Effect.fail(
        agentError(agent, "access.tools", `invalid tool ref '${toolRef}'`),
      );
    }

    const reg = yield* resolveRefToRegistry(toolRef, currentRegistry, agent.sourcePath);
    const toolspace = reg.toolspaces.get(parsed.space);
    if (!toolspace) {
      return yield* Effect.fail(
        new UnknownReferenceError({
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          field: "tool",
          referenceName: toolRef,
        }),
      );
    }

    const tool = toolspace.tools[parsed.name];
    if (!tool) {
      return yield* Effect.fail(
        new UnknownReferenceError({
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          field: "tool",
          referenceName: toolRef,
        }),
      );
    }

    const concrete = tool.targets[target];
    if (!concrete) {
      return yield* Effect.fail(
        new MissingTargetResolutionError({
          agentName: agent.name,
          referenceKind: "tool",
          referenceName: toolRef,
          target,
        }),
      );
    }

    return concrete;
  });

const resolveToolGroupRefForTarget = (
  agent: Agent,
  toolGroupRef: string,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ReadonlyArray<string>, CompileError> =>
  Effect.gen(function* () {
    const parsed = parseSpaceItemRef(toolGroupRef, "#");
    if (!parsed) {
      return yield* Effect.fail(
        agentError(agent, "access.toolGroups", `invalid tool group ref '${toolGroupRef}'`),
      );
    }

    const reg = yield* resolveRefToRegistry(toolGroupRef, registry, agent.sourcePath);
    const toolspace = reg.toolspaces.get(parsed.space);
    if (!toolspace) {
      return yield* Effect.fail(
        new UnknownReferenceError({
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          field: "tool-group",
          referenceName: toolGroupRef,
        }),
      );
    }

    const group = toolspace.groups[parsed.name];
    if (!group) {
      return yield* Effect.fail(
        new UnknownReferenceError({
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          field: "tool-group",
          referenceName: toolGroupRef,
        }),
      );
    }

    const concrete = new Set<string>();
    for (const nestedToolRef of group.tools) {
      concrete.add(
        yield* resolveToolRefForTarget(agent, nestedToolRef, registry, target, reg),
      );
    }

    return [...concrete].sort((left, right) => left.localeCompare(right));
  });

const resolveAccessToolsForTarget = (
  agent: Agent,
  access: { readonly tools: ReadonlyArray<string>; readonly toolGroups: ReadonlyArray<string> },
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ReadonlyArray<string>, CompileError> =>
  Effect.gen(function* () {
    const concrete = new Set<string>();

    for (const toolRef of access.tools) {
      concrete.add(yield* resolveToolRefForTarget(agent, toolRef, registry, target));
    }

    for (const toolGroupRef of access.toolGroups) {
      for (const nested of yield* resolveToolGroupRefForTarget(
        agent,
        toolGroupRef,
        registry,
        target,
      )) {
        concrete.add(nested);
      }
    }

    return [...concrete].sort((left, right) => left.localeCompare(right));
  });

const unknownSkillReference = (
  agent: Agent,
  referenceName: string,
): UnknownReferenceError =>
  new UnknownReferenceError({
    agentName: agent.name,
    sourcePath: agent.sourcePath,
    field: "skill",
    referenceName,
  });

const missingSkillTarget = (
  agent: Agent,
  referenceName: string,
  target: string,
): MissingTargetResolutionError =>
  new MissingTargetResolutionError({
    agentName: agent.name,
    referenceKind: "skill",
    referenceName,
    target,
  });

const resolveValidatedSkillName = (
  agent: Agent,
  referenceName: string,
  target: string,
  concreteName: string,
): Effect.Effect<string, CompileError> =>
  Effect.gen(function* () {
    const invalidSkillName = validateConcreteSkillName(
      agent,
      referenceName,
      target,
      concreteName,
    );
    if (invalidSkillName) {
      return yield* Effect.fail(invalidSkillName);
    }

    return concreteName;
  });

const resolveSkillspaceSkillRefForTarget = (
  agent: Agent,
  skillRef: string,
  parsed: NonNullable<ReturnType<typeof parseSpaceItemRef>>,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<string, CompileError> =>
  Effect.gen(function* () {
    const reg = yield* resolveRefToRegistry(skillRef, registry, agent.sourcePath);
    const skillspace = reg.skillspaces.get(parsed.space);
    if (!skillspace) {
      return yield* Effect.fail(unknownSkillReference(agent, skillRef));
    }

    const skill = skillspace.skills[parsed.name];
    if (!skill) {
      return yield* Effect.fail(unknownSkillReference(agent, skillRef));
    }

    const concrete = skill.targets[target];
    if (!concrete) {
      return yield* Effect.fail(missingSkillTarget(agent, skillRef, target));
    }

    return yield* resolveValidatedSkillName(
      agent,
      skillRef,
      target,
      concrete.name,
    );
  });

const resolveManagedSkillRefForTarget = (
  agent: Agent,
  skillRef: string,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<string, CompileError> =>
  Effect.gen(function* () {
    const reg = yield* resolveRefToRegistry(skillRef, registry, agent.sourcePath);
    const name = parseNamedRef(skillRef).name;
    if (!reg.skills.has(name)) {
      return yield* Effect.fail(unknownSkillReference(agent, skillRef));
    }

    if (!registryTargetsSkillForHarness(reg, target)) {
      return yield* Effect.fail(missingSkillTarget(agent, skillRef, target));
    }

    return yield* resolveValidatedSkillName(agent, skillRef, target, name);
  });

const resolveSkillRefForTarget = (
  agent: Agent,
  skillRef: string,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<string, CompileError> => {
  const parsed = parseSpaceItemRef(skillRef, "/");
  return parsed
    ? resolveSkillspaceSkillRefForTarget(agent, skillRef, parsed, registry, target)
    : resolveManagedSkillRefForTarget(agent, skillRef, registry, target);
};

const resolveSkillsForTarget = (
  agent: Agent,
  skillRefs: ReadonlyArray<string>,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ReadonlyArray<string>, CompileError> =>
  Effect.gen(function* () {
    const concrete = new Set<string>();

    for (const skillRef of skillRefs) {
      concrete.add(yield* resolveSkillRefForTarget(agent, skillRef, registry, target));
    }

    return [...concrete].sort((left, right) => left.localeCompare(right));
  });

const registryTargetsSkillForHarness = (
  registry: PluginRegistry,
  target: string,
): boolean => {
  const targets = registry.targets.skills ?? [];
  return resolveManifestTargets(targets).some((harnessId) => harnessId === target);
};

const OPENCODE_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const validateConcreteSkillName = (
  agent: Agent,
  referenceName: string,
  target: string,
  concreteName: string,
): AgentValidationError | undefined => {
  if (target !== "opencode") return undefined;
  if (OPENCODE_SKILL_NAME_PATTERN.test(concreteName)) return undefined;

  return agentError(
    agent,
    "skill",
    `skill '${referenceName}' resolves to invalid OpenCode skill name '${concreteName}'`,
  );
};

interface ResolvedModelProfileReference {
  readonly sourcePath: string;
  readonly profile: ModelProfile;
}

const resolveModelProfileReference = (
  agent: Agent,
  modelProfileRef: string,
  registry: PluginRegistry,
): Effect.Effect<ResolvedModelProfileReference, CompileError> =>
  Effect.gen(function* () {
    const parsed = parseSpaceItemRef(modelProfileRef, "/");
    if (!parsed) {
      return yield* Effect.fail(
        agentError(agent, "model", `invalid model profile ref '${modelProfileRef}'`),
      );
    }

    const reg = yield* resolveRefToRegistry(modelProfileRef, registry, agent.sourcePath);
    const modelspace = reg.modelspaces.get(parsed.space);
    if (!modelspace) {
      return yield* Effect.fail(
        new UnknownReferenceError({
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          field: "model",
          referenceName: modelProfileRef,
        }),
      );
    }

    const profile = modelspace.profiles[parsed.name];
    if (!profile) {
      return yield* Effect.fail(
        new UnknownReferenceError({
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          field: "model",
          referenceName: modelProfileRef,
        }),
      );
    }

    return { sourcePath: modelspace.sourcePath, profile };
  });

const targetConsumesAgentModelBindings = (target: string): boolean =>
  getCompileTargetCapabilities(target).agentModelBindings === "consumed";

const resolveModelProfile = (
  agent: Agent,
  modelProfileRef: string,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<Record<string, unknown>, CompileError> =>
  Effect.gen(function* () {
    const { sourcePath, profile } = yield* resolveModelProfileReference(
      agent,
      modelProfileRef,
      registry,
    );

    const targetBlock = profile.targets[target];
    if (!targetBlock) {
      return yield* Effect.fail(
        new MissingTargetResolutionError({
          agentName: agent.name,
          referenceKind: "model-profile",
          referenceName: modelProfileRef,
          target,
        }),
      );
    }

    const decoded = resolveModelTargetBlock(
      agent,
      registry,
      sourcePath,
      target,
      targetBlock,
    );
    if (decoded instanceof SourceParseError) {
      return yield* Effect.fail(decoded);
    }

    return decoded;
  });

const orbitError = (
  orbit: Orbit,
  field: string,
  message: string,
): OrbitValidationError =>
  new OrbitValidationError({
    sourcePath: orbit.sourcePath,
    orbitName: orbit.name,
    field,
    message,
  });

const parameterIsRequired = (parameter: OrbitParameter): boolean =>
  parameter.required !== false;

const orbitParameterMap = (
  orbit: Orbit,
): ReadonlyMap<string, OrbitParameter> =>
  new Map(orbit.parameters.map((parameter) => [parameter.name, parameter]));

const bindingKeyExists = (bindings: BindingMap, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(bindings, name);

const collectTemplateParameters = (value: string): ReadonlyArray<string> => {
  const seen = new Set<string>();
  for (const match of value.matchAll(TEMPLATE_PARAMETER_PATTERN)) {
    const name = match[1]?.trim();
    if (!name) continue;
    seen.add(name);
  }
  return [...seen];
};

type OrbitStringVisitor = (
  field: string,
  value: string,
) => OrbitValidationError | undefined;

type OrbitStringField = readonly [field: string, value: string | undefined];

const visitStringFields = (
  fields: ReadonlyArray<OrbitStringField>,
  visit: OrbitStringVisitor,
): OrbitValidationError | undefined => {
  for (const [field, value] of fields) {
    if (!value) continue;
    const error = visit(field, value);
    if (error) return error;
  }
  return undefined;
};

const visitOrbitTopLevelStrings = (
  orbit: Orbit,
  visit: OrbitStringVisitor,
): OrbitValidationError | undefined =>
  visitStringFields(
    [
      ["description", orbit.description],
      ["produces", orbit.produces],
      ["evolution", orbit.evolution],
      ["body", orbit.body],
    ],
    visit,
  );

const visitOrbitDefinitionStrings = (
  orbit: Orbit,
  visit: OrbitStringVisitor,
): OrbitValidationError | undefined => {
  if (!orbit.definitions) return undefined;

  for (const [definitionName, role] of Object.entries(orbit.definitions)) {
    if (!role) continue;
    const purposeError = visit(`definitions.${definitionName}.purpose`, role.purpose);
    if (purposeError) return purposeError;

    for (const listName of ["contains", "boundaries", "avoid"] as const) {
      const values = role[listName] ?? [];
      for (const [index, value] of values.entries()) {
        const error = visit(`definitions.${definitionName}.${listName}[${index}]`, value);
        if (error) return error;
      }
    }
  }

  return undefined;
};

const orbitPhaseStringFields = (
  phase: Orbit["phases"][number],
  index: number,
): ReadonlyArray<OrbitStringField> => [
  [`phases[${index}].name`, phase.name],
  [`phases[${index}].orbit`, phase.orbit],
  [`phases[${index}].orbit_binding.orbit`, phase.orbit_binding?.orbit],
  [`phases[${index}].agent`, phase.agent],
  [`phases[${index}].telos`, phase.telos],
  [`phases[${index}].real_world_change`, phase.real_world_change],
  [`phases[${index}].cold_pickup_test`, phase.cold_pickup_test],
  [`phases[${index}].body`, phase.body],
];

const visitOrbitPhaseWorkflow = (
  phase: Orbit["phases"][number],
  index: number,
  visit: OrbitStringVisitor,
): OrbitValidationError | undefined => {
  if (!phase.workflow) return undefined;

  const directError = visitStringFields(
    [
      [`phases[${index}].workflow.when`, phase.workflow.when],
      [`phases[${index}].workflow.coordination`, phase.workflow.coordination],
      [`phases[${index}].workflow.escalation`, phase.workflow.escalation],
    ],
    visit,
  );
  if (directError) return directError;

  for (const listName of ["inputs", "outputs", "sequence", "finish_criteria"] as const) {
    const values = phase.workflow[listName] ?? [];
    for (const [itemIndex, value] of values.entries()) {
      const error = visit(`phases[${index}].workflow.${listName}[${itemIndex}]`, value);
      if (error) return error;
    }
  }

  return undefined;
};

const visitOrbitPhaseBindingStrings = (
  phase: Orbit["phases"][number],
  index: number,
  visit: OrbitStringVisitor,
): OrbitValidationError | undefined => {
  if (!phase.orbit_binding?.bindings) return undefined;

  for (const [bindingName, bindingValue] of Object.entries(
    phase.orbit_binding.bindings,
  )) {
    const error = visit(
      `phases[${index}].orbit_binding.bindings.${bindingName}`,
      bindingValue,
    );
    if (error) return error;
  }

  return undefined;
};

const visitOrbitPhaseNotes = (
  phase: Orbit["phases"][number],
  index: number,
  visit: OrbitStringVisitor,
): OrbitValidationError | undefined => {
  if (!phase.notes) return undefined;

  for (const [noteName, noteValue] of Object.entries(phase.notes)) {
    const error = visit(`phases[${index}].notes.${noteName}`, noteValue);
    if (error) return error;
  }

  return undefined;
};

const visitOrbitPhaseAgentRefs = (
  phase: Orbit["phases"][number],
  index: number,
  visit: OrbitStringVisitor,
): OrbitValidationError | undefined => {
  for (const [agentIndex, agentRef] of phase.agents.entries()) {
    const error = visit(`phases[${index}].agents[${agentIndex}]`, agentRef);
    if (error) return error;
  }
  return undefined;
};

const visitOrbitPhaseRequirementRefs = (
  phase: Orbit["phases"][number],
  index: number,
  visit: OrbitStringVisitor,
): OrbitValidationError | undefined => {
  for (const [requirementIndex, requirement] of phase.requires.entries()) {
    for (const [traitIndex, traitRef] of requirement.all.entries()) {
      const error = visit(
        `phases[${index}].requires[${requirementIndex}].all[${traitIndex}]`,
        traitRef,
      );
      if (error) return error;
    }
  }
  return undefined;
};

const visitOrbitPhaseStrings = (
  phase: Orbit["phases"][number],
  index: number,
  visit: OrbitStringVisitor,
): OrbitValidationError | undefined => {
  return (
    visitStringFields(orbitPhaseStringFields(phase, index), visit) ??
    visitOrbitPhaseWorkflow(phase, index, visit) ??
    visitOrbitPhaseBindingStrings(phase, index, visit) ??
    visitOrbitPhaseNotes(phase, index, visit) ??
    visitOrbitPhaseAgentRefs(phase, index, visit) ??
    visitOrbitPhaseRequirementRefs(phase, index, visit)
  );
};

const visitOrbitStrings = (
  orbit: Orbit,
  visit: OrbitStringVisitor,
): OrbitValidationError | undefined => {
  const headerError =
    visitOrbitTopLevelStrings(orbit, visit) ??
    visitOrbitDefinitionStrings(orbit, visit);
  if (headerError) return headerError;

  for (const [index, phase] of orbit.phases.entries()) {
    const error = visitOrbitPhaseStrings(phase, index, visit);
    if (error) return error;
  }

  return undefined;
};

const validateOrbitTemplateUsage = (
  orbit: Orbit,
): OrbitValidationError | undefined => {
  const parameters = orbitParameterMap(orbit);
  const seen = new Set<string>();

  for (const parameter of orbit.parameters) {
    if (seen.has(parameter.name)) {
      return orbitError(
        orbit,
        "parameters",
        `duplicate parameter '${parameter.name}'`,
      );
    }
    seen.add(parameter.name);
  }

  return visitOrbitStrings(orbit, (field, value) => {
    const names = collectTemplateParameters(value);
    if (names.length === 0) return undefined;

    if (
      field.endsWith(".orbit") ||
      field.endsWith(".orbit_binding.orbit") ||
      field.endsWith(".agent") ||
      field.includes(".agents[") ||
      field.includes(".requires[")
    ) {
      return orbitError(orbit, field, "reference names cannot contain template placeholders");
    }

    const unknown = names.filter((name) => !parameters.has(name));
    if (unknown.length === 0) return undefined;

    return orbitError(
      orbit,
      field,
      `uses unknown template parameter(s): ${unknown.join(", ")}`,
    );
  });
};

const instantiateTemplateString = (
  orbit: Orbit,
  field: string,
  value: string,
  bindings: BindingMap,
): string | OrbitValidationError => {
  let error: OrbitValidationError | undefined;
  const next = value.replace(TEMPLATE_PARAMETER_PATTERN, (_, rawName: string) => {
    const name = rawName.trim();
    if (!bindingKeyExists(bindings, name)) {
      error = orbitError(
        orbit,
        field,
        `missing binding '${name}' required by template string`,
      );
      return "";
    }
    return bindings[name]!;
  });

  return error ?? next;
};

const instantiateOptionalTemplateString = (
  orbit: Orbit,
  field: string,
  value: string | undefined,
  bindings: BindingMap,
): string | undefined | OrbitValidationError =>
  value === undefined
    ? undefined
    : instantiateTemplateString(orbit, field, value, bindings);

type InstantiatedPhaseReferences = {
  readonly name: string;
  readonly orbit?: string;
};

type InstantiatedPhaseDetails = {
  readonly telos?: string;
  readonly real_world_change?: string;
  readonly cold_pickup_test?: string;
  readonly workflow?: OrbitPhase["workflow"];
  readonly body?: string;
};

type ClonedPhaseAssignments = {
  readonly agent?: OrbitPhase["agent"];
  readonly agents: OrbitPhase["agents"];
  readonly requires: OrbitPhase["requires"];
};

const instantiatePhaseReferences = (
  orbit: Orbit,
  phase: OrbitPhase,
  index: number,
  bindings: BindingMap,
): InstantiatedPhaseReferences | OrbitValidationError => {
  const nextName = instantiateOptionalTemplateString(
    orbit,
    `phases[${index}].name`,
    phase.name,
    bindings,
  );
  if (nextName instanceof OrbitValidationError) return nextName;

  const nextOrbit = instantiateOptionalTemplateString(
    orbit,
    `phases[${index}].orbit`,
    phase.orbit,
    bindings,
  );
  if (nextOrbit instanceof OrbitValidationError) return nextOrbit;

  return {
    name: nextName!,
    ...(nextOrbit ? { orbit: nextOrbit } : {}),
  };
};

const instantiatePhaseOrbitBinding = (
  orbit: Orbit,
  phase: OrbitPhase,
  index: number,
  bindings: BindingMap,
): OrbitPhase["orbit_binding"] | OrbitValidationError => {
  let orbitBinding = phase.orbit_binding;
  if (phase.orbit_binding?.bindings) {
    const nextBindings: Record<string, string> = {};
    for (const [bindingName, bindingValue] of Object.entries(phase.orbit_binding.bindings)) {
      const nextValue = instantiateOptionalTemplateString(
        orbit,
        `phases[${index}].orbit_binding.bindings.${bindingName}`,
        bindingValue,
        bindings,
      );
      if (nextValue instanceof OrbitValidationError) return nextValue;
      if (nextValue !== undefined) {
        nextBindings[bindingName] = nextValue;
      }
    }

    orbitBinding = {
      orbit: phase.orbit_binding.orbit,
      ...(Object.keys(nextBindings).length > 0 ? { bindings: nextBindings } : {}),
    };
  }

  return orbitBinding;
};

const instantiatePhaseNotes = (
  orbit: Orbit,
  phase: OrbitPhase,
  index: number,
  bindings: BindingMap,
): Record<string, string> | OrbitValidationError => {
  const nextNotes: Record<string, string> = {};
  if (phase.notes) {
    for (const [noteName, noteValue] of Object.entries(phase.notes)) {
      const nextValue = instantiateOptionalTemplateString(
        orbit,
        `phases[${index}].notes.${noteName}`,
        noteValue,
        bindings,
      );
      if (nextValue instanceof OrbitValidationError) return nextValue;
      if (nextValue !== undefined) {
        nextNotes[noteName] = nextValue;
      }
    }
  }

  return nextNotes;
};

const instantiateOptionalTemplateStringList = (
  orbit: Orbit,
  field: string,
  values: ReadonlyArray<string> | undefined,
  bindings: BindingMap,
): string[] | undefined | OrbitValidationError => {
  if (!values) return undefined;

  const nextValues: string[] = [];
  for (const [itemIndex, value] of values.entries()) {
    const nextValue = instantiateTemplateString(
      orbit,
      `${field}[${itemIndex}]`,
      value,
      bindings,
    );
    if (nextValue instanceof OrbitValidationError) return nextValue;
    nextValues.push(nextValue);
  }

  return nextValues;
};

const instantiatePhaseWorkflow = (
  orbit: Orbit,
  phase: OrbitPhase,
  index: number,
  bindings: BindingMap,
): OrbitPhase["workflow"] | undefined | OrbitValidationError => {
  if (!phase.workflow) return undefined;

  const when = instantiateOptionalTemplateString(
    orbit,
    `phases[${index}].workflow.when`,
    phase.workflow.when,
    bindings,
  );
  if (when instanceof OrbitValidationError) return when;

  const coordination = instantiateOptionalTemplateString(
    orbit,
    `phases[${index}].workflow.coordination`,
    phase.workflow.coordination,
    bindings,
  );
  if (coordination instanceof OrbitValidationError) return coordination;

  const escalation = instantiateOptionalTemplateString(
    orbit,
    `phases[${index}].workflow.escalation`,
    phase.workflow.escalation,
    bindings,
  );
  if (escalation instanceof OrbitValidationError) return escalation;

  const inputs = instantiateOptionalTemplateStringList(
    orbit,
    `phases[${index}].workflow.inputs`,
    phase.workflow.inputs,
    bindings,
  );
  if (inputs instanceof OrbitValidationError) return inputs;

  const outputs = instantiateOptionalTemplateStringList(
    orbit,
    `phases[${index}].workflow.outputs`,
    phase.workflow.outputs,
    bindings,
  );
  if (outputs instanceof OrbitValidationError) return outputs;

  const sequence = instantiateOptionalTemplateStringList(
    orbit,
    `phases[${index}].workflow.sequence`,
    phase.workflow.sequence,
    bindings,
  );
  if (sequence instanceof OrbitValidationError) return sequence;

  const finishCriteria = instantiateOptionalTemplateStringList(
    orbit,
    `phases[${index}].workflow.finish_criteria`,
    phase.workflow.finish_criteria,
    bindings,
  );
  if (finishCriteria instanceof OrbitValidationError) return finishCriteria;

  return {
    ...(when !== undefined ? { when } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    ...(outputs !== undefined ? { outputs } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(coordination !== undefined ? { coordination } : {}),
    ...(finishCriteria !== undefined ? { finish_criteria: finishCriteria } : {}),
    ...(escalation !== undefined ? { escalation } : {}),
  };
};

const instantiatePhaseDetails = (
  orbit: Orbit,
  phase: OrbitPhase,
  index: number,
  bindings: BindingMap,
): InstantiatedPhaseDetails | OrbitValidationError => {
  const nextTelos = instantiateOptionalTemplateString(
    orbit,
    `phases[${index}].telos`,
    phase.telos,
    bindings,
  );
  if (nextTelos instanceof OrbitValidationError) return nextTelos;

  const nextRealWorldChange = instantiateOptionalTemplateString(
    orbit,
    `phases[${index}].real_world_change`,
    phase.real_world_change,
    bindings,
  );
  if (nextRealWorldChange instanceof OrbitValidationError) return nextRealWorldChange;

  const nextColdPickupTest = instantiateOptionalTemplateString(
    orbit,
    `phases[${index}].cold_pickup_test`,
    phase.cold_pickup_test,
    bindings,
  );
  if (nextColdPickupTest instanceof OrbitValidationError) return nextColdPickupTest;

  const nextWorkflow = instantiatePhaseWorkflow(orbit, phase, index, bindings);
  if (nextWorkflow instanceof OrbitValidationError) return nextWorkflow;

  const nextBody = instantiateOptionalTemplateString(
    orbit,
    `phases[${index}].body`,
    phase.body,
    bindings,
  );
  if (nextBody instanceof OrbitValidationError) return nextBody;

  return {
    ...(nextTelos !== undefined ? { telos: nextTelos } : {}),
    ...(nextRealWorldChange !== undefined
      ? { real_world_change: nextRealWorldChange }
      : {}),
    ...(nextColdPickupTest !== undefined
      ? { cold_pickup_test: nextColdPickupTest }
      : {}),
    ...(nextWorkflow !== undefined ? { workflow: nextWorkflow } : {}),
    ...(nextBody !== undefined ? { body: nextBody } : {}),
    ...(phase.contract !== undefined ? { contract: phase.contract } : {}),
  };
};

const clonePhaseAssignments = (phase: OrbitPhase): ClonedPhaseAssignments => ({
  ...(phase.agent ? { agent: phase.agent } : {}),
  agents: [...phase.agents],
  requires: phase.requires.map((requirement) => ({
    all: [...requirement.all],
    ...(requirement.min !== undefined ? { min: requirement.min } : {}),
  })),
});

const buildInstantiatedOrbitPhase = (options: {
  readonly references: InstantiatedPhaseReferences;
  readonly orbitBinding: OrbitPhase["orbit_binding"];
  readonly assignments: ClonedPhaseAssignments;
  readonly notes: Record<string, string>;
  readonly details: InstantiatedPhaseDetails;
}): OrbitPhase => ({
  name: options.references.name,
  ...(options.references.orbit ? { orbit: options.references.orbit } : {}),
  ...(options.orbitBinding ? { orbit_binding: options.orbitBinding } : {}),
  ...(options.assignments.agent ? { agent: options.assignments.agent } : {}),
  agents: options.assignments.agents,
  requires: options.assignments.requires,
  ...(Object.keys(options.notes).length > 0 ? { notes: options.notes } : {}),
  ...options.details,
});

const instantiateOrbitPhase = (
  orbit: Orbit,
  phase: OrbitPhase,
  index: number,
  bindings: BindingMap,
): OrbitPhase | OrbitValidationError => {
  const references = instantiatePhaseReferences(orbit, phase, index, bindings);
  if (references instanceof OrbitValidationError) return references;

  const orbitBinding = instantiatePhaseOrbitBinding(orbit, phase, index, bindings);
  if (orbitBinding instanceof OrbitValidationError) return orbitBinding;

  const notes = instantiatePhaseNotes(orbit, phase, index, bindings);
  if (notes instanceof OrbitValidationError) return notes;

  const details = instantiatePhaseDetails(orbit, phase, index, bindings);
  if (details instanceof OrbitValidationError) return details;

  return buildInstantiatedOrbitPhase({
    references,
    orbitBinding,
    assignments: clonePhaseAssignments(phase),
    notes,
    details,
  });
};

const cloneOrbitToolPermissions = (orbit: Orbit): Orbit["tool_permissions"] =>
  orbit.tool_permissions.map((tool) => ({
    ref: tool.ref,
    logicalName: tool.logicalName,
  }));

const cloneOrbitOrchestrator = (
  orbit: Orbit,
): Orbit["orchestrator"] | undefined =>
  orbit.orchestrator
    ? {
        agent: orbit.orchestrator.agent,
        tools: orbit.orchestrator.tools.map((tool) => ({
          ref: tool.ref,
          logicalName: tool.logicalName,
        })),
      }
    : undefined;

const instantiateOrbitCheckpoint = (
  orbit: Orbit,
  checkpoint: OrbitPulsarCheckpoint,
  index: number,
  bindings: BindingMap,
): OrbitPulsarCheckpoint | OrbitValidationError => {
  const after = instantiateOptionalTemplateString(
    orbit,
    `pulsar_checkpoints[${index}].after`,
    checkpoint.after,
    bindings,
  );
  if (after instanceof OrbitValidationError) return after;

  const before = instantiateOptionalTemplateString(
    orbit,
    `pulsar_checkpoints[${index}].before`,
    checkpoint.before,
    bindings,
  );
  if (before instanceof OrbitValidationError) return before;

  const note = instantiateOptionalTemplateString(
    orbit,
    `pulsar_checkpoints[${index}].note`,
    checkpoint.note,
    bindings,
  );
  if (note instanceof OrbitValidationError) return note;

  return { after, before, note };
};

const instantiateOrbitDefinitionEntry = (
  orbit: Orbit,
  definitionName: string,
  role: OrbitDefinitionEntry,
  bindings: BindingMap,
): OrbitDefinitionEntry | OrbitValidationError => {
  const purpose = instantiateTemplateString(
    orbit,
    `definitions.${definitionName}.purpose`,
    role.purpose,
    bindings,
  );
  if (purpose instanceof OrbitValidationError) return purpose;

  const lists: Partial<Record<"contains" | "boundaries" | "avoid", string[]>> = {};
  for (const listName of ["contains", "boundaries", "avoid"] as const) {
    const values = role[listName];
    if (!values) continue;
    const nextValues: string[] = [];
    for (const [index, value] of values.entries()) {
      const nextValue = instantiateTemplateString(
        orbit,
        `definitions.${definitionName}.${listName}[${index}]`,
        value,
        bindings,
      );
      if (nextValue instanceof OrbitValidationError) return nextValue;
      nextValues.push(nextValue);
    }
    lists[listName] = nextValues;
  }
  return {
    purpose,
    ...(lists.contains ? { contains: lists.contains } : {}),
    ...(lists.boundaries ? { boundaries: lists.boundaries } : {}),
    ...(lists.avoid ? { avoid: lists.avoid } : {}),
  };
};

const instantiateOrbitDefinitions = (
  orbit: Orbit,
  bindings: BindingMap,
): OrbitDefinitions | OrbitValidationError | undefined => {
  if (!orbit.definitions) return undefined;
  const roles: Partial<Record<"glyphs" | "dispatches" | "chatter" | "signals", OrbitDefinitionEntry>> = {};
  for (const definitionName of ["glyphs", "dispatches", "chatter", "signals"] as const) {
    const role = orbit.definitions[definitionName];
    if (!role) continue;
    const nextRole = instantiateOrbitDefinitionEntry(orbit, definitionName, role, bindings);
    if (nextRole instanceof OrbitValidationError) return nextRole;
    roles[definitionName] = nextRole;
  }
  return {
    ...(roles.glyphs ? { glyphs: roles.glyphs } : {}),
    ...(roles.dispatches ? { dispatches: roles.dispatches } : {}),
    ...(roles.chatter ? { chatter: roles.chatter } : {}),
    ...(roles.signals ? { signals: roles.signals } : {}),
  };
};

type ResolvedAgentSkillSurface = {
  readonly skills: ReadonlyArray<string>;
  readonly allowedSkills: ReadonlyArray<string>;
};

type ResolvedAgentTargetSurface = ResolvedAgentSkillSurface & {
  readonly toolBindings: ReadonlyArray<ResolvedContractBinding>;
  readonly allowedTools: ReadonlyArray<string>;
};

const resolveAgentIdentity = (
  agent: Agent,
  registry: PluginRegistry,
): Effect.Effect<Identity, CompileError> =>
  Effect.gen(function* () {
    const identityReg = yield* resolveRefToRegistry(agent.identity, registry, agent.sourcePath);
    const identityName = parseNamedRef(agent.identity).name;
    const identity = identityReg.identities.get(identityName);
    if (!identity) {
      return yield* Effect.fail(
        new UnknownReferenceError({
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          field: "identity",
          referenceName: agent.identity,
        }),
      );
    }

    return identity;
  });

const resolveAgentPersonality = (
  agent: Agent,
  registry: PluginRegistry,
): Effect.Effect<Personality | undefined, CompileError> =>
  Effect.gen(function* () {
    if (!agent.personality) return undefined;

    const reg = yield* resolveRefToRegistry(agent.personality, registry, agent.sourcePath);
    const name = parseNamedRef(agent.personality).name;
    const personality = reg.personalities.get(name);
    if (!personality) {
      return yield* Effect.fail(
        new UnknownReferenceError({
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          field: "personality",
          referenceName: agent.personality,
        }),
      );
    }

    return personality;
  });

const resolveAgentModel = (
  agent: Agent,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<Record<string, unknown> | undefined, CompileError> =>
  Effect.gen(function* () {
    if (!agent.model) return undefined;
    if (targetConsumesAgentModelBindings(target)) {
      return yield* resolveModelProfile(agent, agent.model, registry, target);
    }

    yield* resolveModelProfileReference(agent, agent.model, registry);
    return undefined;
  });

const resolveAgentSkillSurface = (
  agent: Agent,
  capabilities: ResolvedAgentCapabilities,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ResolvedAgentSkillSurface, CompileError> =>
  Effect.gen(function* () {
    const skills = yield* resolveSkillsForTarget(
      agent,
      capabilities.skills,
      registry,
      target,
    );
    const resolvedAccessSkills = yield* resolveSkillsForTarget(
      agent,
      capabilities.access.skills,
      registry,
      target,
    );
    const allowedSkills = [...new Set([
      ...skills,
      ...resolvedAccessSkills,
    ])].sort((left, right) => left.localeCompare(right));

    return { skills, allowedSkills };
  });

const materializeResolvedContractBindings = (
  toolRefs: ReadonlyArray<ResolvedToolReference>,
): ResolvedContractBinding[] =>
  toolRefs.map(
    ({ kind, logicalName, contract, toolPluginName, toolName, toolSourcePath }) => ({
      kind,
      logicalName,
      contract,
      toolPluginName,
      toolName,
      toolSourcePath,
    }),
  );

const validateTraitRequiredSkillsForTarget = (
  agent: Agent,
  capabilities: ResolvedAgentCapabilities,
  allowedSkills: ReadonlyArray<string>,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<void, CompileError> =>
  Effect.gen(function* () {
    const availableSkillNames = new Set(allowedSkills);
    for (const resolvedTrait of capabilities.traits) {
      const requiredSkills = yield* resolveSkillsForTarget(
        agent,
        resolvedTrait.trait.require.skills,
        registry,
        target,
      );
      const missingSkills = requiredSkills.filter(
        (skillName) => !availableSkillNames.has(skillName),
      );
      if (missingSkills.length === 0) continue;

      return yield* Effect.fail(
        agentError(
          agent,
          "traits",
          `trait '${resolvedTrait.canonicalId}' requires missing skills: ${missingSkills.join(", ")}`,
        ),
      );
    }
  });

const resolveAgentTargetSurface = (
  agent: Agent,
  capabilities: ResolvedAgentCapabilities,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ResolvedAgentTargetSurface, CompileError> =>
  Effect.gen(function* () {
    const skillSurface = yield* resolveAgentSkillSurface(
      agent,
      capabilities,
      registry,
      target,
    );
    const toolBindings = materializeResolvedContractBindings(capabilities.toolRefs);
    const allowedTools = yield* resolveAccessToolsForTarget(
      agent,
      capabilities.access,
      registry,
      target,
    );

    yield* validateTraitRequiredSkillsForTarget(
      agent,
      capabilities,
      skillSurface.allowedSkills,
      registry,
      target,
    );

    return {
      ...skillSurface,
      toolBindings,
      allowedTools,
    };
  });

const buildResolvedAgent = (
  agent: Agent,
  identity: Identity,
  personality: Personality | undefined,
  resolvedModel: Record<string, unknown> | undefined,
  capabilities: ResolvedAgentCapabilities,
  targetSurface: ResolvedAgentTargetSurface,
): ResolvedAgent => ({
  agent,
  identity,
  personality,
  resolvedModel,
  traits: capabilities.traits,
  canonicalTraitIds: capabilities.canonicalTraitIds,
  skills: targetSurface.skills,
  allowedSkills: targetSurface.allowedSkills,
  toolBindings: targetSurface.toolBindings,
  allowedTools: targetSurface.allowedTools,
});

export const resolveAgent = (
  agent: Agent,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ResolvedAgent, CompileError> =>
  Effect.gen(function* () {
    const identity = yield* resolveAgentIdentity(agent, registry);
    const personality = yield* resolveAgentPersonality(agent, registry);
    const resolvedModel = yield* resolveAgentModel(agent, registry, target);
    const capabilities = yield* resolveAgentCapabilities(agent, registry);
    const targetSurface = yield* resolveAgentTargetSurface(
      agent,
      capabilities,
      registry,
      target,
    );

    return buildResolvedAgent(
      agent,
      identity,
      personality,
      resolvedModel,
      capabilities,
      targetSurface,
    );
  });

type InstantiatedOrbitHeader = {
  readonly description: string;
  readonly produces: string | undefined;
  readonly definitions: OrbitDefinitions | undefined;
};

type InstantiatedOrbitTail = {
  readonly evolution: string | undefined;
  readonly body: string;
};

const validateOrbitInstantiationBindings = (
  orbit: Orbit,
  bindings: BindingMap,
): OrbitValidationError | undefined => {
  const parameters = orbitParameterMap(orbit);
  const unknownBindings = Object.keys(bindings).filter((name) => !parameters.has(name));
  if (unknownBindings.length > 0) {
    return orbitError(
      orbit,
      "bindings",
      `received unknown binding(s): ${unknownBindings.join(", ")}`,
    );
  }

  const missingRequired = orbit.parameters
    .filter((parameter) => parameterIsRequired(parameter))
    .map((parameter) => parameter.name)
    .filter((name) => !bindingKeyExists(bindings, name));
  if (missingRequired.length > 0) {
    return orbitError(
      orbit,
      "bindings",
      `missing required binding(s): ${missingRequired.join(", ")}`,
    );
  }

  return undefined;
};

const instantiateOrbitHeader = (
  orbit: Orbit,
  bindings: BindingMap,
): InstantiatedOrbitHeader | OrbitValidationError => {
  const description = instantiateTemplateString(
    orbit,
    "description",
    orbit.description,
    bindings,
  );
  if (description instanceof OrbitValidationError) return description;

  const produces = orbit.produces
    ? instantiateTemplateString(orbit, "produces", orbit.produces, bindings)
    : undefined;
  if (produces instanceof OrbitValidationError) return produces;

  const definitions = instantiateOrbitDefinitions(orbit, bindings);
  if (definitions instanceof OrbitValidationError) return definitions;

  return { description, produces, definitions };
};

const instantiateOrbitPhases = (
  orbit: Orbit,
  bindings: BindingMap,
): OrbitPhase[] | OrbitValidationError => {
  const phases: OrbitPhase[] = [];
  for (const [index, phase] of orbit.phases.entries()) {
    const nextPhase = instantiateOrbitPhase(orbit, phase, index, bindings);
    if (nextPhase instanceof OrbitValidationError) return nextPhase;
    phases.push(nextPhase);
  }
  return phases;
};

const instantiateOrbitCheckpoints = (
  orbit: Orbit,
  bindings: BindingMap,
): OrbitPulsarCheckpoint[] | OrbitValidationError => {
  const checkpoints: OrbitPulsarCheckpoint[] = [];
  for (const [index, checkpoint] of orbit.pulsar_checkpoints.entries()) {
    const nextCheckpoint = instantiateOrbitCheckpoint(
      orbit,
      checkpoint,
      index,
      bindings,
    );
    if (nextCheckpoint instanceof OrbitValidationError) return nextCheckpoint;
    checkpoints.push(nextCheckpoint);
  }
  return checkpoints;
};

const instantiateOrbitTail = (
  orbit: Orbit,
  bindings: BindingMap,
): InstantiatedOrbitTail | OrbitValidationError => {
  const evolution = orbit.evolution
    ? instantiateTemplateString(orbit, "evolution", orbit.evolution, bindings)
    : undefined;
  if (evolution instanceof OrbitValidationError) return evolution;

  const body = instantiateTemplateString(orbit, "body", orbit.body, bindings);
  if (body instanceof OrbitValidationError) return body;

  return { evolution, body };
};

const buildInstantiatedOrbit = (
  orbit: Orbit,
  header: InstantiatedOrbitHeader,
  phases: OrbitPhase[],
  checkpoints: OrbitPulsarCheckpoint[],
  tail: InstantiatedOrbitTail,
): Orbit => {
  const clonedOrchestrator = cloneOrbitOrchestrator(orbit);

  return new Orbit({
    name: orbit.name,
    sourcePath: orbit.sourcePath,
    description: header.description,
    produces: header.produces,
    ...(header.definitions ? { definitions: header.definitions } : {}),
    parameters: [],
    phases,
    ...(clonedOrchestrator ? { orchestrator: clonedOrchestrator } : {}),
    tool_permissions: cloneOrbitToolPermissions(orbit),
    pulsar_checkpoints: checkpoints,
    evolution: tail.evolution,
    body: tail.body,
    ...(orbit.signal_emitter ? { signal_emitter: orbit.signal_emitter } : {}),
  });
};

export const instantiateOrbit = (
  orbit: Orbit,
  bindings: BindingMap = {},
): Effect.Effect<Orbit, CompileError> =>
  Effect.gen(function* () {
    const bindingError = validateOrbitInstantiationBindings(orbit, bindings);
    if (bindingError) return yield* Effect.fail(bindingError);

    const header = instantiateOrbitHeader(orbit, bindings);
    if (header instanceof OrbitValidationError) return yield* Effect.fail(header);

    const phases = instantiateOrbitPhases(orbit, bindings);
    if (phases instanceof OrbitValidationError) return yield* Effect.fail(phases);

    const checkpoints = instantiateOrbitCheckpoints(orbit, bindings);
    if (checkpoints instanceof OrbitValidationError) {
      return yield* Effect.fail(checkpoints);
    }

    const tail = instantiateOrbitTail(orbit, bindings);
    if (tail instanceof OrbitValidationError) return yield* Effect.fail(tail);

    return buildInstantiatedOrbit(orbit, header, phases, checkpoints, tail);
  });

const resolveOrbitRequiredTraitId = (
  orbit: Orbit,
  field: string,
  traitRef: string,
  registry: PluginRegistry,
): Effect.Effect<string, CompileError> =>
  Effect.gen(function* () {
    const reg = yield* resolveRefToRegistry(traitRef, registry, orbit.sourcePath);
    const name = parseNamedRef(traitRef).name;
    const trait = reg.traits.get(name);
    if (!trait) {
      return yield* Effect.fail(
        orbitError(orbit, field, `references unknown trait '${traitRef}'`),
      );
    }

    return canonicalTraitId(reg, trait);
  });

const resolveOrbitAssignedAgent = (
  orbit: Orbit,
  phaseIndex: number,
  agentIndex: number,
  agentRef: string,
  registry: PluginRegistry,
): Effect.Effect<ResolvedAgentCapabilities, CompileError> =>
  Effect.gen(function* () {
    const reg = yield* resolveRefToRegistry(agentRef, registry, orbit.sourcePath);
    const name = parseNamedRef(agentRef).name;
    const agent = reg.agents.get(name);
    if (!agent) {
      return yield* Effect.fail(
        orbitError(
          orbit,
          `phases[${phaseIndex}].agents[${agentIndex}]`,
          `references unknown agent '${agentRef}'`,
        ),
      );
    }

    return yield* resolveAgentCapabilities(agent, reg);
  });

type PhaseOrbitReferenceResolution = "orbit" | "agent" | undefined;

const phaseReferenceKinds = (phase: OrbitPhase): string[] =>
  [
    phase.orbit ? "orbit" : undefined,
    phase.orbit_binding ? "orbit_binding" : undefined,
    phase.agents.length > 0 ? "agents" : undefined,
  ].filter((kind): kind is string => kind !== undefined);

const validatePhaseReferenceShape = (
  orbit: Orbit,
  phase: OrbitPhase,
  phaseIndex: number,
): OrbitValidationError | undefined => {
  const referenceKinds = phaseReferenceKinds(phase);
  if (referenceKinds.length <= 1) return undefined;

  return orbitError(
    orbit,
    `phases[${phaseIndex}]`,
    `phase '${phase.name}' declares multiple references (${referenceKinds.join(", ")}); use only one of orbit, orbit_binding, or agents`,
  );
};

const resolvePhaseOrbitReference = (
  orbit: Orbit,
  phase: OrbitPhase,
  phaseIndex: number,
  registry: PluginRegistry,
): Effect.Effect<PhaseOrbitReferenceResolution, CompileError> =>
  Effect.gen(function* () {
    if (!phase.orbit) return undefined;

    const reg = yield* resolveRefToRegistry(phase.orbit, registry, orbit.sourcePath);
    const name = parseNamedRef(phase.orbit).name;
    const referencedOrbit = reg.orbits.get(name);

    if (referencedOrbit) {
      if (referencedOrbit.parameters.length > 0) {
        return yield* Effect.fail(
          orbitError(
            orbit,
            `phases[${phaseIndex}].orbit`,
            `phase '${phase.name}' references parameterized orbit '${phase.orbit}' without bindings; use orbit_binding instead`,
          ),
        );
      }
      return "orbit";
    }

    if (!reg.agents.has(name)) {
      return yield* Effect.fail(
        orbitError(
          orbit,
          `phases[${phaseIndex}].orbit`,
          `phase '${phase.name}' references unknown orbit or agent '${phase.orbit}'`,
        ),
      );
    }

    return "agent";
  });

const validatePhaseOrbitBinding = (
  orbit: Orbit,
  phase: OrbitPhase,
  phaseIndex: number,
  registry: PluginRegistry,
): Effect.Effect<void, CompileError> =>
  Effect.gen(function* () {
    if (!phase.orbit_binding) return;

    const reg = yield* resolveRefToRegistry(
      phase.orbit_binding.orbit,
      registry,
      orbit.sourcePath,
    );
    const name = parseNamedRef(phase.orbit_binding.orbit).name;
    const referencedOrbit = reg.orbits.get(name);

    if (!referencedOrbit) {
      const message = reg.agents.has(name)
        ? `phase '${phase.name}' uses orbit_binding for '${phase.orbit_binding.orbit}', but that reference resolves to an agent`
        : `phase '${phase.name}' references unknown orbit '${phase.orbit_binding.orbit}'`;
      return yield* Effect.fail(
        orbitError(
          orbit,
          `phases[${phaseIndex}].orbit_binding`,
          message,
        ),
      );
    }

    const providedBindings = phase.orbit_binding.bindings ?? {};
    const targetParameters = orbitParameterMap(referencedOrbit);

    const unknownBindings = Object.keys(providedBindings).filter(
      (bindingName) => !targetParameters.has(bindingName),
    );
    if (unknownBindings.length > 0) {
      return yield* Effect.fail(
        orbitError(
          orbit,
          `phases[${phaseIndex}].orbit_binding.bindings`,
          `phase '${phase.name}' passes unknown binding(s) to '${phase.orbit_binding.orbit}': ${unknownBindings.join(", ")}`,
        ),
      );
    }

    const missingRequired = referencedOrbit.parameters
      .filter((parameter) => parameterIsRequired(parameter))
      .map((parameter) => parameter.name)
      .filter((bindingName) => !bindingKeyExists(providedBindings, bindingName));
    if (missingRequired.length > 0) {
      return yield* Effect.fail(
        orbitError(
          orbit,
          `phases[${phaseIndex}].orbit_binding.bindings`,
          `phase '${phase.name}' is missing required binding(s) for '${phase.orbit_binding.orbit}': ${missingRequired.join(", ")}`,
        ),
      );
    }
  });

const resolvePhaseAssignedAgents = (
  orbit: Orbit,
  phase: OrbitPhase,
  phaseIndex: number,
  registry: PluginRegistry,
): Effect.Effect<ResolvedAgentCapabilities[], CompileError> =>
  Effect.gen(function* () {
    const assignedAgentCapabilities: ResolvedAgentCapabilities[] = [];
    const assignedAgentIds = new Set<string>();

    for (const [agentIndex, agentRef] of phase.agents.entries()) {
      const agentCapabilities = yield* resolveOrbitAssignedAgent(
        orbit,
        phaseIndex,
        agentIndex,
        agentRef,
        registry,
      );
      const agentId = `${agentCapabilities.agent.name}:${agentCapabilities.agent.sourcePath}`;
      if (assignedAgentIds.has(agentId)) {
        return yield* Effect.fail(
          orbitError(
            orbit,
            `phases[${phaseIndex}].agents[${agentIndex}]`,
            `phase '${phase.name}' assigns duplicate agent '${agentRef}'`,
          ),
        );
      }
      assignedAgentIds.add(agentId);
      assignedAgentCapabilities.push(agentCapabilities);
    }

    return assignedAgentCapabilities;
  });

const validatePhaseRequiresAssignedAgents = (
  orbit: Orbit,
  phase: OrbitPhase,
  phaseIndex: number,
): OrbitValidationError | undefined => {
  if (phase.requires.length === 0 || phase.agents.length > 0) return undefined;

  return orbitError(
    orbit,
    `phases[${phaseIndex}].requires`,
    `phase '${phase.name}' declares trait requirements but assigns no agents`,
  );
};

const validatePhaseRequirement = (
  orbit: Orbit,
  phase: OrbitPhase,
  phaseIndex: number,
  requirementIndex: number,
  assignedAgentCapabilities: ReadonlyArray<ResolvedAgentCapabilities>,
  registry: PluginRegistry,
): Effect.Effect<void, CompileError> =>
  Effect.gen(function* () {
    const requirement = phase.requires[requirementIndex]!;
    const min = requirement.min ?? 1;
    if (!Number.isInteger(min) || min < 1) {
      return yield* Effect.fail(
        orbitError(
          orbit,
          `phases[${phaseIndex}].requires[${requirementIndex}].min`,
          "min must be an integer greater than or equal to 1",
        ),
      );
    }

    if (requirement.all.length === 0) {
      return yield* Effect.fail(
        orbitError(
          orbit,
          `phases[${phaseIndex}].requires[${requirementIndex}].all`,
          "trait requirement must include at least one trait",
        ),
      );
    }

    const requiredTraitIds = new Set<string>();
    for (const [traitIndex, traitRef] of requirement.all.entries()) {
      const traitId = yield* resolveOrbitRequiredTraitId(
        orbit,
        `phases[${phaseIndex}].requires[${requirementIndex}].all[${traitIndex}]`,
        traitRef,
        registry,
      );
      requiredTraitIds.add(traitId);
    }

    const satisfiedCount = assignedAgentCapabilities.filter((agentCapabilities) =>
      [...requiredTraitIds].every((traitId) =>
        agentCapabilities.canonicalTraitIds.includes(traitId),
      ),
    ).length;

    if (satisfiedCount < min) {
      return yield* Effect.fail(
        orbitError(
          orbit,
          `phases[${phaseIndex}].requires[${requirementIndex}]`,
          `phase '${phase.name}' requires at least ${min} assigned agent(s) with all traits [${[...requiredTraitIds].join(", ")}], but only ${satisfiedCount} match`,
        ),
      );
    }
  });

const validatePhaseRequirements = (
  orbit: Orbit,
  phase: OrbitPhase,
  phaseIndex: number,
  assignedAgentCapabilities: ReadonlyArray<ResolvedAgentCapabilities>,
  registry: PluginRegistry,
): Effect.Effect<void, CompileError> =>
  Effect.gen(function* () {
    for (const requirementIndex of phase.requires.keys()) {
      yield* validatePhaseRequirement(
        orbit,
        phase,
        phaseIndex,
        requirementIndex,
        assignedAgentCapabilities,
        registry,
      );
    }
  });

const serializePhaseContractSchema = (
  orbit: Orbit,
  phaseIndex: number,
  side: "input" | "output",
  schema: Schema.Schema.AnyNoContext,
): Effect.Effect<Record<string, unknown>, CompileError> =>
  Effect.try({
    try: () => workflowJsonSchemaFromEffectSchema(schema),
    catch: (error) => {
      if (error instanceof WorkflowOutputSchemaError) {
        return orbitError(
          orbit,
          `phases[${phaseIndex}].contract.${side}`,
          error.message,
        );
      }
      return orbitError(
        orbit,
        `phases[${phaseIndex}].contract.${side}`,
        String(error),
      );
    },
  });

const validatePhaseContractSchemas = (
  orbit: Orbit,
  phase: OrbitPhase,
  phaseIndex: number,
): Effect.Effect<void, CompileError> =>
  Effect.gen(function* () {
    if (!phase.contract) return;

    for (const side of ["input", "output"] as const) {
      const schema = phase.contract[side];
      if (!schema) continue;
      yield* serializePhaseContractSchema(orbit, phaseIndex, side, schema);
    }
  });

const validateOrbitPhase = (
  orbit: Orbit,
  phase: OrbitPhase,
  phaseIndex: number,
  registry: PluginRegistry,
): Effect.Effect<void, CompileError> =>
  Effect.gen(function* () {
    const referenceShapeError = validatePhaseReferenceShape(orbit, phase, phaseIndex);
    if (referenceShapeError) {
      return yield* Effect.fail(referenceShapeError);
    }

    yield* validatePhaseContractSchemas(orbit, phase, phaseIndex);

    const orbitReference = yield* resolvePhaseOrbitReference(
      orbit,
      phase,
      phaseIndex,
      registry,
    );
    if (orbitReference === "orbit") return;

    yield* validatePhaseOrbitBinding(orbit, phase, phaseIndex, registry);

    const missingAgentsError = validatePhaseRequiresAssignedAgents(
      orbit,
      phase,
      phaseIndex,
    );
    if (missingAgentsError) {
      return yield* Effect.fail(missingAgentsError);
    }

    if (phase.agents.length === 0) return;

    const assignedAgentCapabilities = yield* resolvePhaseAssignedAgents(
      orbit,
      phase,
      phaseIndex,
      registry,
    );
    yield* validatePhaseRequirements(
      orbit,
      phase,
      phaseIndex,
      assignedAgentCapabilities,
      registry,
    );
  });

const phaseAssignedLocalAgents = (
  orbit: Orbit,
  registry: PluginRegistry,
): Set<string> => {
  const assigned = new Set<string>();
  for (const phase of orbit.phases) {
    for (const agentRef of phase.agents) {
      const parsed = parseNamedRef(agentRef);
      if (parsed.pluginPrefix) continue;
      if (!registry.agents.has(parsed.name)) continue;
      assigned.add(parsed.name);
    }
  }
  return assigned;
};

const orchestratorLocalAgent = (
  orbit: Orbit,
  registry: PluginRegistry,
): string | undefined => {
  if (!orbit.orchestrator) return undefined;
  const parsed = parseNamedRef(orbit.orchestrator.agent);
  if (parsed.pluginPrefix) return undefined;
  if (!registry.agents.has(parsed.name)) return undefined;
  return parsed.name;
};

const orbitSkillRecipients = (
  orbit: Orbit,
  registry: PluginRegistry,
): Set<string> => {
  const recipients = phaseAssignedLocalAgents(orbit, registry);
  const orchestrator = orchestratorLocalAgent(orbit, registry);
  if (orchestrator) recipients.add(orchestrator);
  return recipients;
};

export const resolveOrbitSkillPermissions = (
  orbits: ReadonlyArray<Orbit>,
  registry: PluginRegistry,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const byAgent = new Map<string, Set<string>>();

  for (const orbit of orbits) {
    const recipients = orbitSkillRecipients(orbit, registry);

    for (const agentName of recipients) {
      const agentSkills = byAgent.get(agentName) ?? new Set<string>();
      agentSkills.add(orbit.name);
      byAgent.set(agentName, agentSkills);
    }
  }

  return new Map(
    [...byAgent.entries()].map(([agentName, skills]) => [
      agentName,
      [...skills].sort((left, right) => left.localeCompare(right)),
    ]),
  );
};

interface OrbitToolGrant {
  readonly logicalName: string;
  readonly ref: string;
  readonly field: string;
}

const grantOrbitTool = (
  orbit: Orbit,
  registry: PluginRegistry,
  agentName: string,
  grant: OrbitToolGrant,
  byAgent: Map<string, ResolvedContractBinding[]>,
): CompileError | undefined => {
  const bindings = byAgent.get(agentName) ?? [];
  const existing = new Set(bindings.map((binding) => binding.logicalName));
  if (existing.has(grant.logicalName)) {
    // Orbit-wide grant already added this logical name to this agent; idempotent skip.
    return undefined;
  }

  const materialized = materializeOrbitToolPermission({
    logicalName: grant.logicalName,
    toolRef: grant.ref,
    registry,
  });
  if (!(materialized instanceof Object) || "message" in materialized) {
    return orbitError(orbit, grant.field, materialized.message);
  }

  bindings.push({
    kind: materialized.kind,
    logicalName: materialized.logicalName,
    contract: materialized.contract,
    toolPluginName: materialized.toolPluginName,
    toolName: materialized.toolName,
    toolSourcePath: materialized.toolSourcePath,
  });
  byAgent.set(agentName, bindings);
  return undefined;
};

export const resolveOrbitToolPermissions = (
  orbits: ReadonlyArray<Orbit>,
  registry: PluginRegistry,
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<ResolvedContractBinding>>, CompileError> =>
  Effect.gen(function* () {
    const byAgent = new Map<string, ResolvedContractBinding[]>();

    for (const orbit of orbits) {
      const phaseAgents = phaseAssignedLocalAgents(orbit, registry);

      // Orbit-wide tool_permissions: materialize on every phase agent.
      for (const [toolIndex, tool] of orbit.tool_permissions.entries()) {
        const field = `tool_permissions[${toolIndex}]`;
        for (const agentName of phaseAgents) {
          const error = grantOrbitTool(
            orbit,
            registry,
            agentName,
            { logicalName: tool.logicalName, ref: tool.ref, field },
            byAgent,
          );
          if (error) return yield* Effect.fail(error);
        }
      }

      // Orchestrator-only tools: validate the orchestrator agent and materialize on it.
      if (orbit.orchestrator) {
        const parsed = parseNamedRef(orbit.orchestrator.agent);
        if (parsed.pluginPrefix) {
          return yield* Effect.fail(
            orbitError(
              orbit,
              "orchestrator.agent",
              `orbit orchestrator must be a local agent compiled by '${registry.pluginName}', got '${orbit.orchestrator.agent}'`,
            ),
          );
        }

        if (!registry.agents.has(parsed.name)) {
          return yield* Effect.fail(
            orbitError(
              orbit,
              "orchestrator.agent",
              `references unknown agent '${orbit.orchestrator.agent}'`,
            ),
          );
        }

        for (const [toolIndex, tool] of orbit.orchestrator.tools.entries()) {
          const field = `orchestrator.tools[${toolIndex}]`;
          const error = grantOrbitTool(
            orbit,
            registry,
            parsed.name,
            { logicalName: tool.logicalName, ref: tool.ref, field },
            byAgent,
          );
          if (error) return yield* Effect.fail(error);
        }
      }
    }

    return new Map(
      [...byAgent.entries()].map(([agentName, bindings]) => [
        agentName,
        bindings.sort((left, right) => left.logicalName.localeCompare(right.logicalName)),
      ]),
    );
  });

export const validateOrbit = (
  orbit: Orbit,
  registry: PluginRegistry,
): Effect.Effect<void, CompileError> =>
  Effect.gen(function* () {
    const templateUsageError = validateOrbitTemplateUsage(orbit);
    if (templateUsageError) {
      return yield* Effect.fail(templateUsageError);
    }

    for (const [index, phase] of orbit.phases.entries()) {
      yield* validateOrbitPhase(orbit, phase, index, registry);
    }
  });

const projectOrbitPhaseForManifest = (
  orbit: Orbit,
  phase: OrbitPhase,
  phaseIndex: number,
  registry: PluginRegistry,
): Effect.Effect<CompileManifestOrbitPhase, CompileError> =>
  Effect.gen(function* () {
    const agents: Array<{ plugin: string; name: string }> = [];
    for (const [agentIndex, agentRef] of phase.agents.entries()) {
      const capabilities = yield* resolveOrbitAssignedAgent(
        orbit,
        phaseIndex,
        agentIndex,
        agentRef,
        registry,
      );
      const reg = yield* resolveRefToRegistry(agentRef, registry, orbit.sourcePath);
      agents.push({ plugin: reg.pluginName, name: capabilities.agent.name });
    }

    const framing: CompileManifestOrbitPhase["framing"] = {
      ...(phase.telos !== undefined ? { telos: phase.telos } : {}),
      ...(phase.workflow?.when !== undefined ? { when: phase.workflow.when } : {}),
      ...(phase.workflow?.coordination !== undefined
        ? { coordination: phase.workflow.coordination }
        : {}),
      ...(phase.workflow?.escalation !== undefined
        ? { escalation: phase.workflow.escalation }
        : {}),
    };

    let contract: CompileManifestOrbitPhaseContract | undefined;
    if (phase.contract) {
      const serialized: {
        input?: Record<string, unknown>;
        output?: Record<string, unknown>;
      } = {};
      if (phase.contract.input) {
        serialized.input = yield* serializePhaseContractSchema(
          orbit,
          phaseIndex,
          "input",
          phase.contract.input,
        );
      }
      if (phase.contract.output) {
        serialized.output = yield* serializePhaseContractSchema(
          orbit,
          phaseIndex,
          "output",
          phase.contract.output,
        );
      }
      contract =
        serialized.input || serialized.output
          ? serialized
          : undefined;
    }

    return {
      name: phase.name,
      agents,
      criteria: [...(phase.workflow?.finish_criteria ?? [])],
      io: {
        inputs: [...(phase.workflow?.inputs ?? [])],
        outputs: [...(phase.workflow?.outputs ?? [])],
      },
      framing,
      ...(phase.notes ? { notes: { ...phase.notes } } : {}),
      ...(contract ? { contract } : {}),
    };
  });

const projectOrbitForManifest = (
  orbit: Orbit,
  registry: PluginRegistry,
): Effect.Effect<CompileManifestOrbitProjectionInput, CompileError> =>
  Effect.gen(function* () {
    const phases: CompileManifestOrbitPhase[] = [];
    for (const [index, phase] of orbit.phases.entries()) {
      phases.push(yield* projectOrbitPhaseForManifest(orbit, phase, index, registry));
    }
    return { name: orbit.name, phases };
  });

export const projectOrbitsForCompileManifest = (
  orbits: ReadonlyArray<Orbit>,
  registry: PluginRegistry,
): Effect.Effect<ReadonlyArray<CompileManifestOrbitProjectionInput>, CompileError> =>
  Effect.gen(function* () {
    const projected: CompileManifestOrbitProjectionInput[] = [];
    for (const orbit of orbits) {
      projected.push(yield* projectOrbitForManifest(orbit, registry));
    }
    return projected;
  });
