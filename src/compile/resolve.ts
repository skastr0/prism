/**
 * Resolve phase: materialize referenced parts for each agent and validate
 * orbit wiring against the loaded registry graph.
 */

import { Effect, Schema } from "effect";
import {
  Agent,
  ClaudeCodeModelTarget,
  Contract,
  Identity,
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
  UnknownDependencyError,
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

interface ParsedNamedRef {
  readonly pluginPrefix: string | undefined;
  readonly name: string;
}

interface ParsedSpaceItemRef {
  readonly pluginPrefix: string | undefined;
  readonly space: string;
  readonly name: string;
}

type BindingMap = Readonly<Record<string, string>>;

const TEMPLATE_PARAMETER_PATTERN = /\$\{([^}]+)\}/g;

const parseNamedRef = (ref: string): ParsedNamedRef => {
  const colon = ref.indexOf(":");
  if (colon === -1) return { pluginPrefix: undefined, name: ref };
  return {
    pluginPrefix: ref.slice(0, colon),
    name: ref.slice(colon + 1),
  };
};

const parseSpaceItemRef = (
  ref: string,
  separator: "/" | "#",
): ParsedSpaceItemRef | undefined => {
  const parsed = parseNamedRef(ref);
  const split = parsed.name.indexOf(separator);
  if (split === -1) return undefined;
  const space = parsed.name.slice(0, split);
  const name = parsed.name.slice(split + 1);
  if (space.length === 0 || name.length === 0) return undefined;
  return { pluginPrefix: parsed.pluginPrefix, space, name };
};

const resolveRefToRegistry = (
  ref: string,
  currentRegistry: PluginRegistry,
  sourcePath: string,
): Effect.Effect<PluginRegistry, CompileError> =>
  Effect.gen(function* () {
    const parsed = parseNamedRef(ref);
    if (!parsed.pluginPrefix) return currentRegistry;
    const dep = currentRegistry.deps.get(parsed.pluginPrefix);
    if (!dep) {
      return yield* Effect.fail(
        new UnknownDependencyError({
          sourcePath,
          referenceName: ref,
          depPrefix: parsed.pluginPrefix,
          declaredDeps: [...currentRegistry.deps.keys()],
        }),
      );
    }
    return dep;
  });

const decodeResolvedTargetBlock = <A>(
  sourcePath: string,
  target: string,
  schema: Schema.Schema<A, any, never>,
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

export const resolveAgentCapabilities = (
  agent: Agent,
  registry: PluginRegistry,
): Effect.Effect<ResolvedAgentCapabilities, CompileError> =>
  Effect.gen(function* () {
    const resolvedTraits: ResolvedTrait[] = [];
    const canonicalTraitIds = new Set<string>();

    for (const [index, binding] of agent.traits.entries()) {
      const resolvedTrait = yield* resolveTraitReference(agent, binding, registry);
      if (canonicalTraitIds.has(resolvedTrait.canonicalId)) {
        return yield* Effect.fail(
          agentError(
            agent,
            `traits[${index}]`,
            `declares duplicate trait '${resolvedTrait.canonicalId}'`,
          ),
        );
      }
      canonicalTraitIds.add(resolvedTrait.canonicalId);
      resolvedTraits.push(resolvedTrait);
    }

    const finalToolRefs = new Map<string, MaterializedTraitTool & { traitId: string }>();
    const accessTools = new Set(agent.access.tools);
    const accessToolGroups = new Set(agent.access.toolGroups);
    const accessSkills = new Set(agent.access.skills);

    for (const resolvedTrait of resolvedTraits) {
      for (const skill of resolvedTrait.trait.inject.skills) {
        accessSkills.add(skill);
      }

      for (const toolRef of resolvedTrait.trait.access.tools) {
        accessTools.add(toolRef);
      }
      for (const toolGroupRef of resolvedTrait.trait.access.toolGroups) {
        accessToolGroups.add(toolGroupRef);
      }
      for (const skill of resolvedTrait.trait.access.skills) {
        accessSkills.add(skill);
      }

      const materializedTraitTools = materializeTraitTools({
        agentName: agent.name,
        ownerPluginName: registry.pluginName,
        canonicalTraitId: resolvedTrait.canonicalId,
        trait: resolvedTrait.trait,
        binding: resolvedTrait.binding,
        registry,
      });
      if (!(materializedTraitTools instanceof Array)) {
        return yield* Effect.fail(
          agentError(
            agent,
            "traits",
            `trait '${resolvedTrait.canonicalId}' ${materializedTraitTools.message}`,
          ),
        );
      }

      for (const materialized of materializedTraitTools) {
        const {
          logicalName,
          kind,
          contract,
          toolPluginName,
          toolName,
        } = materialized;
        const existing = finalToolRefs.get(logicalName);
        if (!existing) {
          finalToolRefs.set(logicalName, {
            ...materialized,
            traitId: resolvedTrait.canonicalId,
          });
          continue;
        }

        if (
          existing.kind !== kind ||
          existing.toolPluginName !== toolPluginName ||
          existing.toolName !== toolName ||
          existing.contract?.pluginName !== contract?.pluginName ||
          existing.contract?.name !== contract?.name
        ) {
          return yield* Effect.fail(
            agentError(
              agent,
              "traits",
              `traits '${existing.traitId}' and '${resolvedTrait.canonicalId}' define conflicting tool bindings for '${logicalName}'`,
            ),
          );
        }
      }
    }

    const availableToolNames = new Set(finalToolRefs.keys());
    for (const resolvedTrait of resolvedTraits) {
      const missingTools = resolvedTrait.trait.require.tools.filter(
        (logicalName) => !availableToolNames.has(logicalName),
      );
      if (missingTools.length === 0) continue;

      const missingParts = [
        missingTools.length > 0 ? `tools: ${missingTools.join(", ")}` : undefined,
      ].filter((part): part is string => part !== undefined);

      return yield* Effect.fail(
        agentError(
          agent,
          "traits",
          `trait '${resolvedTrait.canonicalId}' requires missing ${missingParts.join("; ")}`,
        ),
      );
    }

    return {
      agent,
      traits: resolvedTraits,
      canonicalTraitIds: [...canonicalTraitIds].sort((left, right) =>
        left.localeCompare(right),
      ),
      skills: [...agent.skills],
      toolRefs: [...finalToolRefs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([logicalName, resolved]) => ({
          logicalName,
          kind: resolved.kind,
          contract: resolved.contract,
          toolPluginName: resolved.toolPluginName,
          toolName: resolved.toolName,
          toolSourcePath: resolved.toolSourcePath,
        })),
      access: {
        tools: [...accessTools].sort((left, right) => left.localeCompare(right)),
        toolGroups: [...accessToolGroups].sort((left, right) => left.localeCompare(right)),
        skills: [...accessSkills].sort((left, right) => left.localeCompare(right)),
      },
    };
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

const resolveSkillRefForTarget = (
  agent: Agent,
  skillRef: string,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<string, CompileError> =>
  Effect.gen(function* () {
    const parsed = parseSpaceItemRef(skillRef, "/");
    if (parsed) {
      const reg = yield* resolveRefToRegistry(skillRef, registry, agent.sourcePath);
      const skillspace = reg.skillspaces.get(parsed.space);
      if (!skillspace) {
        return yield* Effect.fail(
          new UnknownReferenceError({
            agentName: agent.name,
            sourcePath: agent.sourcePath,
            field: "skill",
            referenceName: skillRef,
          }),
        );
      }

      const skill = skillspace.skills[parsed.name];
      if (!skill) {
        return yield* Effect.fail(
          new UnknownReferenceError({
            agentName: agent.name,
            sourcePath: agent.sourcePath,
            field: "skill",
            referenceName: skillRef,
          }),
        );
      }

      const concrete = skill.targets[target];
      if (!concrete) {
        return yield* Effect.fail(
          new MissingTargetResolutionError({
            agentName: agent.name,
            referenceKind: "skill",
            referenceName: skillRef,
            target,
          }),
        );
      }

      const invalidSkillName = validateConcreteSkillName(
        agent,
        skillRef,
        target,
        concrete.name,
      );
      if (invalidSkillName) {
        return yield* Effect.fail(invalidSkillName);
      }

      return concrete.name;
    }

    const reg = yield* resolveRefToRegistry(skillRef, registry, agent.sourcePath);
    const name = parseNamedRef(skillRef).name;
    if (!reg.skills.has(name)) {
      return yield* Effect.fail(
        new UnknownReferenceError({
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          field: "skill",
          referenceName: skillRef,
        }),
      );
    }

    if (!registryTargetsSkillForHarness(reg, target)) {
      return yield* Effect.fail(
        new MissingTargetResolutionError({
          agentName: agent.name,
          referenceKind: "skill",
          referenceName: skillRef,
          target,
        }),
      );
    }

    const invalidSkillName = validateConcreteSkillName(agent, skillRef, target, name);
    if (invalidSkillName) {
      return yield* Effect.fail(invalidSkillName);
    }

    return name;
  });

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

const resolveModelProfile = (
  agent: Agent,
  modelProfileRef: string,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<Record<string, unknown>, CompileError> =>
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
      modelspace.sourcePath,
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

const hasBinding = (bindings: BindingMap, name: string): boolean =>
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

const visitOrbitStrings = (
  orbit: Orbit,
  visit: (field: string, value: string) => OrbitValidationError | undefined,
): OrbitValidationError | undefined => {
  const topLevelFields: Array<[string, string | undefined]> = [
    ["description", orbit.description],
    ["produces", orbit.produces],
    ["evolution", orbit.evolution],
    ["body", orbit.body],
  ];

  for (const [field, value] of topLevelFields) {
    if (!value) continue;
    const error = visit(field, value);
    if (error) return error;
  }

  if (orbit.definitions) {
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
  }

  for (const [index, phase] of orbit.phases.entries()) {
    const phaseFields: Array<[string, string | undefined]> = [
      [`phases[${index}].name`, phase.name],
      [`phases[${index}].orbit`, phase.orbit],
      [
        `phases[${index}].orbit_binding.orbit`,
        phase.orbit_binding?.orbit,
      ],
      [`phases[${index}].agent`, phase.agent],
      [`phases[${index}].telos`, phase.telos],
      [`phases[${index}].real_world_change`, phase.real_world_change],
      [`phases[${index}].cold_pickup_test`, phase.cold_pickup_test],
      [`phases[${index}].body`, phase.body],
    ];

    for (const [field, value] of phaseFields) {
      if (!value) continue;
      const error = visit(field, value);
      if (error) return error;
    }

    if (phase.orbit_binding?.bindings) {
      for (const [bindingName, bindingValue] of Object.entries(
        phase.orbit_binding.bindings,
      )) {
        const error = visit(
          `phases[${index}].orbit_binding.bindings.${bindingName}`,
          bindingValue,
        );
        if (error) return error;
      }
    }

    if (phase.notes) {
      for (const [noteName, noteValue] of Object.entries(phase.notes)) {
        const error = visit(`phases[${index}].notes.${noteName}`, noteValue);
        if (error) return error;
      }
    }

    for (const [agentIndex, agentRef] of phase.agents.entries()) {
      const error = visit(`phases[${index}].agents[${agentIndex}]`, agentRef);
      if (error) return error;
    }

    for (const [requirementIndex, requirement] of phase.requires.entries()) {
      for (const [traitIndex, traitRef] of requirement.all.entries()) {
        const error = visit(
          `phases[${index}].requires[${requirementIndex}].all[${traitIndex}]`,
          traitRef,
        );
        if (error) return error;
      }
    }
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
    if (!hasBinding(bindings, name)) {
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

const instantiateOrbitPhase = (
  orbit: Orbit,
  phase: OrbitPhase,
  index: number,
  bindings: BindingMap,
): OrbitPhase | OrbitValidationError => {
  const instantiate = (field: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    return instantiateTemplateString(orbit, field, value, bindings);
  };

  const nextName = instantiate(`phases[${index}].name`, phase.name);
  if (nextName instanceof OrbitValidationError) return nextName;

  const nextOrbit = instantiate(`phases[${index}].orbit`, phase.orbit);
  if (nextOrbit instanceof OrbitValidationError) return nextOrbit;

  let orbitBinding = phase.orbit_binding;
  if (phase.orbit_binding?.bindings) {
    const nextBindings: Record<string, string> = {};
    for (const [bindingName, bindingValue] of Object.entries(phase.orbit_binding.bindings)) {
      const nextValue = instantiate(
        `phases[${index}].orbit_binding.bindings.${bindingName}`,
        bindingValue,
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

  const nextNotes: Record<string, string> = {};
  if (phase.notes) {
    for (const [noteName, noteValue] of Object.entries(phase.notes)) {
      const nextValue = instantiate(`phases[${index}].notes.${noteName}`, noteValue);
      if (nextValue instanceof OrbitValidationError) return nextValue;
      if (nextValue !== undefined) {
        nextNotes[noteName] = nextValue;
      }
    }
  }

  const nextTelos = instantiate(`phases[${index}].telos`, phase.telos);
  if (nextTelos instanceof OrbitValidationError) return nextTelos;

  const nextRealWorldChange = instantiate(
    `phases[${index}].real_world_change`,
    phase.real_world_change,
  );
  if (nextRealWorldChange instanceof OrbitValidationError) return nextRealWorldChange;

  const nextColdPickupTest = instantiate(
    `phases[${index}].cold_pickup_test`,
    phase.cold_pickup_test,
  );
  if (nextColdPickupTest instanceof OrbitValidationError) return nextColdPickupTest;

  const nextBody = instantiate(`phases[${index}].body`, phase.body);
  if (nextBody instanceof OrbitValidationError) return nextBody;

  return {
    name: nextName!,
    ...(nextOrbit ? { orbit: nextOrbit } : {}),
    ...(orbitBinding ? { orbit_binding: orbitBinding } : {}),
    ...(phase.agent ? { agent: phase.agent } : {}),
    agents: [...phase.agents],
    requires: phase.requires.map((requirement) => ({
      all: [...requirement.all],
      ...(requirement.min !== undefined ? { min: requirement.min } : {}),
    })),
    ...(Object.keys(nextNotes).length > 0 ? { notes: nextNotes } : {}),
    ...(nextTelos !== undefined ? { telos: nextTelos } : {}),
    ...(nextRealWorldChange !== undefined
      ? { real_world_change: nextRealWorldChange }
      : {}),
    ...(nextColdPickupTest !== undefined
      ? { cold_pickup_test: nextColdPickupTest }
      : {}),
    ...(nextBody !== undefined ? { body: nextBody } : {}),
  };
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
  const instantiate = (field: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    return instantiateTemplateString(orbit, field, value, bindings);
  };

  const after = instantiate(`pulsar_checkpoints[${index}].after`, checkpoint.after);
  if (after instanceof OrbitValidationError) return after;

  const before = instantiate(`pulsar_checkpoints[${index}].before`, checkpoint.before);
  if (before instanceof OrbitValidationError) return before;

  const note = instantiate(`pulsar_checkpoints[${index}].note`, checkpoint.note);
  if (note instanceof OrbitValidationError) return note;

  return { after, before, note };
};

const instantiateOrbitDefinitionEntry = (
  orbit: Orbit,
  definitionName: string,
  role: OrbitDefinitionEntry,
  bindings: BindingMap,
): OrbitDefinitionEntry | OrbitValidationError => {
  const instantiate = (field: string, value: string) =>
    instantiateTemplateString(orbit, field, value, bindings);

  const purpose = instantiate(`definitions.${definitionName}.purpose`, role.purpose);
  if (purpose instanceof OrbitValidationError) return purpose;

  const lists: Partial<Record<"contains" | "boundaries" | "avoid", string[]>> = {};
  for (const listName of ["contains", "boundaries", "avoid"] as const) {
    const values = role[listName];
    if (!values) continue;
    const nextValues: string[] = [];
    for (const [index, value] of values.entries()) {
      const nextValue = instantiate(
        `definitions.${definitionName}.${listName}[${index}]`,
        value,
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

export const resolveAgent = (
  agent: Agent,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ResolvedAgent, CompileError> =>
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

    let personality: Personality | undefined;
    if (agent.personality) {
      const reg = yield* resolveRefToRegistry(agent.personality, registry, agent.sourcePath);
      const name = parseNamedRef(agent.personality).name;
      personality = reg.personalities.get(name);
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
    }

    let resolvedModel: Record<string, unknown> | undefined;
    if (agent.model) {
      resolvedModel = yield* resolveModelProfile(agent, agent.model, registry, target);
    }

    const capabilities = yield* resolveAgentCapabilities(agent, registry);
    const resolvedDependencySkills = yield* resolveSkillsForTarget(
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
      ...resolvedDependencySkills,
      ...resolvedAccessSkills,
    ])].sort((left, right) => left.localeCompare(right));

    const toolBindings: ResolvedContractBinding[] = capabilities.toolRefs.map(
      ({ kind, logicalName, contract, toolPluginName, toolName, toolSourcePath }) => ({
        kind,
        logicalName,
        contract,
        toolPluginName,
        toolName,
        toolSourcePath,
      }),
    );

    const allowedTools = yield* resolveAccessToolsForTarget(
      agent,
      capabilities.access,
      registry,
      target,
    );

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

    return {
      agent,
      identity,
      personality,
      resolvedModel,
      traits: capabilities.traits,
      canonicalTraitIds: capabilities.canonicalTraitIds,
      skills: resolvedDependencySkills,
      allowedSkills,
      toolBindings,
      allowedTools,
    };
  });

export const instantiateOrbit = (
  orbit: Orbit,
  bindings: BindingMap = {},
): Effect.Effect<Orbit, CompileError> =>
  Effect.gen(function* () {
    const parameters = orbitParameterMap(orbit);
    const unknownBindings = Object.keys(bindings).filter((name) => !parameters.has(name));
    if (unknownBindings.length > 0) {
      return yield* Effect.fail(
        orbitError(
          orbit,
          "bindings",
          `received unknown binding(s): ${unknownBindings.join(", ")}`,
        ),
      );
    }

    const missingRequired = orbit.parameters
      .filter((parameter) => parameterIsRequired(parameter))
      .map((parameter) => parameter.name)
      .filter((name) => !hasBinding(bindings, name));
    if (missingRequired.length > 0) {
      return yield* Effect.fail(
        orbitError(
          orbit,
          "bindings",
          `missing required binding(s): ${missingRequired.join(", ")}`,
        ),
      );
    }

    const description = instantiateTemplateString(
      orbit,
      "description",
      orbit.description,
      bindings,
    );
    if (description instanceof OrbitValidationError) {
      return yield* Effect.fail(description);
    }

    const produces = orbit.produces
      ? instantiateTemplateString(orbit, "produces", orbit.produces, bindings)
      : undefined;
    if (produces instanceof OrbitValidationError) {
      return yield* Effect.fail(produces);
    }

    const definitions = instantiateOrbitDefinitions(orbit, bindings);
    if (definitions instanceof OrbitValidationError) {
      return yield* Effect.fail(definitions);
    }

    const phases: OrbitPhase[] = [];
    for (const [index, phase] of orbit.phases.entries()) {
      const nextPhase = instantiateOrbitPhase(orbit, phase, index, bindings);
      if (nextPhase instanceof OrbitValidationError) {
        return yield* Effect.fail(nextPhase);
      }
      phases.push(nextPhase);
    }

    const tasteCheckpoints: OrbitPulsarCheckpoint[] = [];
    for (const [index, checkpoint] of orbit.pulsar_checkpoints.entries()) {
      const nextCheckpoint = instantiateOrbitCheckpoint(
        orbit,
        checkpoint,
        index,
        bindings,
      );
      if (nextCheckpoint instanceof OrbitValidationError) {
        return yield* Effect.fail(nextCheckpoint);
      }
      tasteCheckpoints.push(nextCheckpoint);
    }

    const evolution = orbit.evolution
      ? instantiateTemplateString(orbit, "evolution", orbit.evolution, bindings)
      : undefined;
    if (evolution instanceof OrbitValidationError) {
      return yield* Effect.fail(evolution);
    }

    const body = instantiateTemplateString(orbit, "body", orbit.body, bindings);
    if (body instanceof OrbitValidationError) {
      return yield* Effect.fail(body);
    }

    const clonedOrchestrator = cloneOrbitOrchestrator(orbit);

    return new Orbit({
      name: orbit.name,
      sourcePath: orbit.sourcePath,
      description,
      produces,
      ...(definitions ? { definitions } : {}),
      parameters: [],
      phases,
      ...(clonedOrchestrator ? { orchestrator: clonedOrchestrator } : {}),
      tool_permissions: cloneOrbitToolPermissions(orbit),
      pulsar_checkpoints: tasteCheckpoints,
      evolution,
      body,
    });
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
      const referenceKinds = [
        phase.orbit ? "orbit" : undefined,
        phase.orbit_binding ? "orbit_binding" : undefined,
        phase.agents.length > 0 ? "agents" : undefined,
      ].filter((kind): kind is string => kind !== undefined);

      if (referenceKinds.length > 1) {
        return yield* Effect.fail(
          orbitError(
            orbit,
            `phases[${index}]`,
            `phase '${phase.name}' declares multiple references (${referenceKinds.join(", ")}); use only one of orbit, orbit_binding, or agents`,
          ),
        );
      }

      if (phase.orbit) {
        const reg = yield* resolveRefToRegistry(phase.orbit, registry, orbit.sourcePath);
        const name = parseNamedRef(phase.orbit).name;
        const referencedOrbit = reg.orbits.get(name);

        if (referencedOrbit) {
          if (referencedOrbit.parameters.length > 0) {
            return yield* Effect.fail(
              orbitError(
                orbit,
                `phases[${index}].orbit`,
                `phase '${phase.name}' references parameterized orbit '${phase.orbit}' without bindings; use orbit_binding instead`,
              ),
            );
          }
          continue;
        }

        if (!reg.agents.has(name)) {
          return yield* Effect.fail(
            orbitError(
              orbit,
              `phases[${index}].orbit`,
              `phase '${phase.name}' references unknown orbit or agent '${phase.orbit}'`,
            ),
          );
        }
      }

      if (phase.orbit_binding) {
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
              `phases[${index}].orbit_binding`,
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
              `phases[${index}].orbit_binding.bindings`,
              `phase '${phase.name}' passes unknown binding(s) to '${phase.orbit_binding.orbit}': ${unknownBindings.join(", ")}`,
            ),
          );
        }

        const missingRequired = referencedOrbit.parameters
          .filter((parameter) => parameterIsRequired(parameter))
          .map((parameter) => parameter.name)
          .filter((bindingName) => !hasBinding(providedBindings, bindingName));
        if (missingRequired.length > 0) {
          return yield* Effect.fail(
            orbitError(
              orbit,
              `phases[${index}].orbit_binding.bindings`,
              `phase '${phase.name}' is missing required binding(s) for '${phase.orbit_binding.orbit}': ${missingRequired.join(", ")}`,
            ),
          );
        }
      }

      if (phase.requires.length > 0 && phase.agents.length === 0) {
        return yield* Effect.fail(
          orbitError(
            orbit,
            `phases[${index}].requires`,
            `phase '${phase.name}' declares trait requirements but assigns no agents`,
          ),
        );
      }

      if (phase.agents.length > 0) {
        const assignedAgentCapabilities: ResolvedAgentCapabilities[] = [];
        const assignedAgentIds = new Set<string>();

        for (const [agentIndex, agentRef] of phase.agents.entries()) {
          const agentCapabilities = yield* resolveOrbitAssignedAgent(
            orbit,
            index,
            agentIndex,
            agentRef,
            registry,
          );
          const agentId = `${agentCapabilities.agent.name}:${agentCapabilities.agent.sourcePath}`;
          if (assignedAgentIds.has(agentId)) {
            return yield* Effect.fail(
              orbitError(
                orbit,
                `phases[${index}].agents[${agentIndex}]`,
                `phase '${phase.name}' assigns duplicate agent '${agentRef}'`,
              ),
            );
          }
          assignedAgentIds.add(agentId);
          assignedAgentCapabilities.push(agentCapabilities);
        }

        for (const [requirementIndex, requirement] of phase.requires.entries()) {
          const min = requirement.min ?? 1;
          if (!Number.isInteger(min) || min < 1) {
            return yield* Effect.fail(
              orbitError(
                orbit,
                `phases[${index}].requires[${requirementIndex}].min`,
                "min must be an integer greater than or equal to 1",
              ),
            );
          }

          if (requirement.all.length === 0) {
            return yield* Effect.fail(
              orbitError(
                orbit,
                `phases[${index}].requires[${requirementIndex}].all`,
                "trait requirement must include at least one trait",
              ),
            );
          }

          const requiredTraitIds = new Set<string>();
          for (const [traitIndex, traitRef] of requirement.all.entries()) {
            const traitId = yield* resolveOrbitRequiredTraitId(
              orbit,
              `phases[${index}].requires[${requirementIndex}].all[${traitIndex}]`,
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
                `phases[${index}].requires[${requirementIndex}]`,
                `phase '${phase.name}' requires at least ${min} assigned agent(s) with all traits [${[...requiredTraitIds].join(", ")}], but only ${satisfiedCount} match`,
              ),
            );
          }
        }
      }
    }
  });
