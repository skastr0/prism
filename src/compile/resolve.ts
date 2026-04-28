/**
 * Resolve phase: materialize referenced parts for each agent and validate
 * lifecycle wiring against the loaded registry graph.
 */

import { Effect, Schema } from "effect";
import {
  Agent,
  ClaudeCodeModelTarget,
  Contract,
  Identity,
  Lifecycle,
  OpenCodeModelTarget,
  Personality,
  Trait,
  type LifecycleParameter,
  type LifecycleTasteCheckpoint,
  type NormalizedLifecyclePhase as LifecyclePhase,
  type NormalizedTraitBinding,
} from "./sources.js";
import {
  AgentValidationError,
  LifecycleValidationError,
  MissingTargetResolutionError,
  SourceParseError,
  UnknownDependencyError,
  UnknownReferenceError,
  type CompileError,
} from "./errors.js";
import {
  materializeLifecycleToolPermission,
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

const decodeResolvedTargetBlock = (
  sourcePath: string,
  target: string,
  schema: Schema.Schema.AnyNoContext,
  value: unknown,
): Record<string, unknown> | SourceParseError => {
  const result = Schema.decodeUnknownEither(schema)(value);
  if (result._tag === "Left") {
    return new SourceParseError({
      sourcePath,
      kind: "modelspace",
      message: `invalid '${target}' target block: ${result.left.message}`,
    });
  }

  return result.right as Record<string, unknown>;
};

const resolveModelTargetBlock = (
  sourcePath: string,
  target: string,
  targetBlock: unknown,
): Record<string, unknown> | SourceParseError => {
  switch (target) {
    case "opencode":
      return decodeResolvedTargetBlock(
        sourcePath,
        target,
        OpenCodeModelTarget,
        targetBlock,
      );
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
        ownerPluginName: resolvedTrait.owner.pluginName,
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

    const decoded = resolveModelTargetBlock(modelspace.sourcePath, target, targetBlock);
    if (decoded instanceof SourceParseError) {
      return yield* Effect.fail(decoded);
    }

    return decoded;
  });

const lifecycleError = (
  lifecycle: Lifecycle,
  field: string,
  message: string,
): LifecycleValidationError =>
  new LifecycleValidationError({
    sourcePath: lifecycle.sourcePath,
    lifecycleName: lifecycle.name,
    field,
    message,
  });

const parameterIsRequired = (parameter: LifecycleParameter): boolean =>
  parameter.required !== false;

const lifecycleParameterMap = (
  lifecycle: Lifecycle,
): ReadonlyMap<string, LifecycleParameter> =>
  new Map(lifecycle.parameters.map((parameter) => [parameter.name, parameter]));

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

const visitLifecycleStrings = (
  lifecycle: Lifecycle,
  visit: (field: string, value: string) => LifecycleValidationError | undefined,
): LifecycleValidationError | undefined => {
  const topLevelFields: Array<[string, string | undefined]> = [
    ["description", lifecycle.description],
    ["produces", lifecycle.produces],
    ["evolution", lifecycle.evolution],
    ["body", lifecycle.body],
  ];

  for (const [field, value] of topLevelFields) {
    if (!value) continue;
    const error = visit(field, value);
    if (error) return error;
  }

  for (const [index, phase] of lifecycle.phases.entries()) {
    const phaseFields: Array<[string, string | undefined]> = [
      [`phases[${index}].name`, phase.name],
      [`phases[${index}].lifecycle`, phase.lifecycle],
      [
        `phases[${index}].lifecycle_binding.lifecycle`,
        phase.lifecycle_binding?.lifecycle,
      ],
      [`phases[${index}].agent`, phase.agent],
    ];

    for (const [field, value] of phaseFields) {
      if (!value) continue;
      const error = visit(field, value);
      if (error) return error;
    }

    if (phase.lifecycle_binding?.bindings) {
      for (const [bindingName, bindingValue] of Object.entries(
        phase.lifecycle_binding.bindings,
      )) {
        const error = visit(
          `phases[${index}].lifecycle_binding.bindings.${bindingName}`,
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

const validateLifecycleTemplateUsage = (
  lifecycle: Lifecycle,
): LifecycleValidationError | undefined => {
  const parameters = lifecycleParameterMap(lifecycle);
  const seen = new Set<string>();

  for (const parameter of lifecycle.parameters) {
    if (seen.has(parameter.name)) {
      return lifecycleError(
        lifecycle,
        "parameters",
        `duplicate parameter '${parameter.name}'`,
      );
    }
    seen.add(parameter.name);
  }

  return visitLifecycleStrings(lifecycle, (field, value) => {
    const names = collectTemplateParameters(value);
    if (names.length === 0) return undefined;

    if (
      field.endsWith(".lifecycle") ||
      field.endsWith(".lifecycle_binding.lifecycle") ||
      field.endsWith(".agent") ||
      field.includes(".agents[") ||
      field.includes(".requires[")
    ) {
      return lifecycleError(lifecycle, field, "reference names cannot contain template placeholders");
    }

    const unknown = names.filter((name) => !parameters.has(name));
    if (unknown.length === 0) return undefined;

    return lifecycleError(
      lifecycle,
      field,
      `uses unknown template parameter(s): ${unknown.join(", ")}`,
    );
  });
};

const instantiateTemplateString = (
  lifecycle: Lifecycle,
  field: string,
  value: string,
  bindings: BindingMap,
): string | LifecycleValidationError => {
  let error: LifecycleValidationError | undefined;
  const next = value.replace(TEMPLATE_PARAMETER_PATTERN, (_, rawName: string) => {
    const name = rawName.trim();
    if (!hasBinding(bindings, name)) {
      error = lifecycleError(
        lifecycle,
        field,
        `missing binding '${name}' required by template string`,
      );
      return "";
    }
    return bindings[name]!;
  });

  return error ?? next;
};

const instantiateLifecyclePhase = (
  lifecycle: Lifecycle,
  phase: LifecyclePhase,
  index: number,
  bindings: BindingMap,
): LifecyclePhase | LifecycleValidationError => {
  const instantiate = (field: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    return instantiateTemplateString(lifecycle, field, value, bindings);
  };

  const nextName = instantiate(`phases[${index}].name`, phase.name);
  if (nextName instanceof LifecycleValidationError) return nextName;

  const nextLifecycle = instantiate(`phases[${index}].lifecycle`, phase.lifecycle);
  if (nextLifecycle instanceof LifecycleValidationError) return nextLifecycle;

  let lifecycleBinding = phase.lifecycle_binding;
  if (phase.lifecycle_binding?.bindings) {
    const nextBindings: Record<string, string> = {};
    for (const [bindingName, bindingValue] of Object.entries(phase.lifecycle_binding.bindings)) {
      const nextValue = instantiate(
        `phases[${index}].lifecycle_binding.bindings.${bindingName}`,
        bindingValue,
      );
      if (nextValue instanceof LifecycleValidationError) return nextValue;
      if (nextValue !== undefined) {
        nextBindings[bindingName] = nextValue;
      }
    }

    lifecycleBinding = {
      lifecycle: phase.lifecycle_binding.lifecycle,
      ...(Object.keys(nextBindings).length > 0 ? { bindings: nextBindings } : {}),
    };
  }

  const nextNotes: Record<string, string> = {};
  if (phase.notes) {
    for (const [noteName, noteValue] of Object.entries(phase.notes)) {
      const nextValue = instantiate(`phases[${index}].notes.${noteName}`, noteValue);
      if (nextValue instanceof LifecycleValidationError) return nextValue;
      if (nextValue !== undefined) {
        nextNotes[noteName] = nextValue;
      }
    }
  }

  return {
    name: nextName!,
    ...(nextLifecycle ? { lifecycle: nextLifecycle } : {}),
    ...(lifecycleBinding ? { lifecycle_binding: lifecycleBinding } : {}),
    ...(phase.agent ? { agent: phase.agent } : {}),
    agents: [...phase.agents],
    requires: phase.requires.map((requirement) => ({
      all: [...requirement.all],
      ...(requirement.min !== undefined ? { min: requirement.min } : {}),
    })),
    ...(Object.keys(nextNotes).length > 0 ? { notes: nextNotes } : {}),
  };
};

const cloneLifecycleToolPermissions = (lifecycle: Lifecycle): Lifecycle["tool_permissions"] =>
  lifecycle.tool_permissions.map((permission) => ({
    agents: [...permission.agents],
    tools: permission.tools.map((tool) => ({
      ref: tool.ref,
      logicalName: tool.logicalName,
    })),
  }));

const instantiateLifecycleCheckpoint = (
  lifecycle: Lifecycle,
  checkpoint: LifecycleTasteCheckpoint,
  index: number,
  bindings: BindingMap,
): LifecycleTasteCheckpoint | LifecycleValidationError => {
  const instantiate = (field: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    return instantiateTemplateString(lifecycle, field, value, bindings);
  };

  const after = instantiate(`taste_checkpoints[${index}].after`, checkpoint.after);
  if (after instanceof LifecycleValidationError) return after;

  const before = instantiate(`taste_checkpoints[${index}].before`, checkpoint.before);
  if (before instanceof LifecycleValidationError) return before;

  const note = instantiate(`taste_checkpoints[${index}].note`, checkpoint.note);
  if (note instanceof LifecycleValidationError) return note;

  return { after, before, note };
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

export const instantiateLifecycle = (
  lifecycle: Lifecycle,
  bindings: BindingMap = {},
): Effect.Effect<Lifecycle, CompileError> =>
  Effect.gen(function* () {
    const parameters = lifecycleParameterMap(lifecycle);
    const unknownBindings = Object.keys(bindings).filter((name) => !parameters.has(name));
    if (unknownBindings.length > 0) {
      return yield* Effect.fail(
        lifecycleError(
          lifecycle,
          "bindings",
          `received unknown binding(s): ${unknownBindings.join(", ")}`,
        ),
      );
    }

    const missingRequired = lifecycle.parameters
      .filter((parameter) => parameterIsRequired(parameter))
      .map((parameter) => parameter.name)
      .filter((name) => !hasBinding(bindings, name));
    if (missingRequired.length > 0) {
      return yield* Effect.fail(
        lifecycleError(
          lifecycle,
          "bindings",
          `missing required binding(s): ${missingRequired.join(", ")}`,
        ),
      );
    }

    const description = instantiateTemplateString(
      lifecycle,
      "description",
      lifecycle.description,
      bindings,
    );
    if (description instanceof LifecycleValidationError) {
      return yield* Effect.fail(description);
    }

    const produces = lifecycle.produces
      ? instantiateTemplateString(lifecycle, "produces", lifecycle.produces, bindings)
      : undefined;
    if (produces instanceof LifecycleValidationError) {
      return yield* Effect.fail(produces);
    }

    const phases: LifecyclePhase[] = [];
    for (const [index, phase] of lifecycle.phases.entries()) {
      const nextPhase = instantiateLifecyclePhase(lifecycle, phase, index, bindings);
      if (nextPhase instanceof LifecycleValidationError) {
        return yield* Effect.fail(nextPhase);
      }
      phases.push(nextPhase);
    }

    const tasteCheckpoints: LifecycleTasteCheckpoint[] = [];
    for (const [index, checkpoint] of lifecycle.taste_checkpoints.entries()) {
      const nextCheckpoint = instantiateLifecycleCheckpoint(
        lifecycle,
        checkpoint,
        index,
        bindings,
      );
      if (nextCheckpoint instanceof LifecycleValidationError) {
        return yield* Effect.fail(nextCheckpoint);
      }
      tasteCheckpoints.push(nextCheckpoint);
    }

    const evolution = lifecycle.evolution
      ? instantiateTemplateString(lifecycle, "evolution", lifecycle.evolution, bindings)
      : undefined;
    if (evolution instanceof LifecycleValidationError) {
      return yield* Effect.fail(evolution);
    }

    const body = instantiateTemplateString(lifecycle, "body", lifecycle.body, bindings);
    if (body instanceof LifecycleValidationError) {
      return yield* Effect.fail(body);
    }

    return new Lifecycle({
      name: lifecycle.name,
      sourcePath: lifecycle.sourcePath,
      description,
      produces,
      parameters: [],
      phases,
      tool_permissions: cloneLifecycleToolPermissions(lifecycle),
      taste_checkpoints: tasteCheckpoints,
      evolution,
      body,
    });
  });

const resolveLifecycleRequiredTraitId = (
  lifecycle: Lifecycle,
  field: string,
  traitRef: string,
  registry: PluginRegistry,
): Effect.Effect<string, CompileError> =>
  Effect.gen(function* () {
    const reg = yield* resolveRefToRegistry(traitRef, registry, lifecycle.sourcePath);
    const name = parseNamedRef(traitRef).name;
    const trait = reg.traits.get(name);
    if (!trait) {
      return yield* Effect.fail(
        lifecycleError(lifecycle, field, `references unknown trait '${traitRef}'`),
      );
    }

    return canonicalTraitId(reg, trait);
  });

const resolveLifecycleAssignedAgent = (
  lifecycle: Lifecycle,
  phaseIndex: number,
  agentIndex: number,
  agentRef: string,
  registry: PluginRegistry,
): Effect.Effect<ResolvedAgentCapabilities, CompileError> =>
  Effect.gen(function* () {
    const reg = yield* resolveRefToRegistry(agentRef, registry, lifecycle.sourcePath);
    const name = parseNamedRef(agentRef).name;
    const agent = reg.agents.get(name);
    if (!agent) {
      return yield* Effect.fail(
        lifecycleError(
          lifecycle,
          `phases[${phaseIndex}].agents[${agentIndex}]`,
          `references unknown agent '${agentRef}'`,
        ),
      );
    }

    return yield* resolveAgentCapabilities(agent, reg);
  });

const assignedLocalAgentsForLifecycle = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
): Set<string> => {
  const assigned = new Set<string>();
  for (const phase of lifecycle.phases) {
    for (const agentRef of phase.agents) {
      const parsed = parseNamedRef(agentRef);
      if (parsed.pluginPrefix) continue;
      if (!registry.agents.has(parsed.name)) continue;
      assigned.add(parsed.name);
    }
  }
  return assigned;
};

export const resolveLifecycleToolPermissions = (
  lifecycles: ReadonlyArray<Lifecycle>,
  registry: PluginRegistry,
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<ResolvedContractBinding>>, CompileError> =>
  Effect.gen(function* () {
    const byAgent = new Map<string, ResolvedContractBinding[]>();

    for (const lifecycle of lifecycles) {
      const assignedLocalAgents = assignedLocalAgentsForLifecycle(lifecycle, registry);

      for (const [permissionIndex, permission] of lifecycle.tool_permissions.entries()) {
        for (const [agentIndex, agentRef] of permission.agents.entries()) {
          const parsed = parseNamedRef(agentRef);
          if (parsed.pluginPrefix) {
            return yield* Effect.fail(
              lifecycleError(
                lifecycle,
                `tool_permissions[${permissionIndex}].agents[${agentIndex}]`,
                `lifecycle tool permissions can only target local agents compiled by '${registry.pluginName}', got '${agentRef}'`,
              ),
            );
          }

          const agent = registry.agents.get(parsed.name);
          if (!agent) {
            return yield* Effect.fail(
              lifecycleError(
                lifecycle,
                `tool_permissions[${permissionIndex}].agents[${agentIndex}]`,
                `references unknown agent '${agentRef}'`,
              ),
            );
          }

          if (!assignedLocalAgents.has(parsed.name)) {
            return yield* Effect.fail(
              lifecycleError(
                lifecycle,
                `tool_permissions[${permissionIndex}].agents[${agentIndex}]`,
                `agent '${agentRef}' is not assigned to any phase in lifecycle '${lifecycle.name}'`,
              ),
            );
          }

          const agentBindings = byAgent.get(agent.name) ?? [];
          const existingLogicalNames = new Set(agentBindings.map((binding) => binding.logicalName));

          for (const [toolIndex, tool] of permission.tools.entries()) {
            if (existingLogicalNames.has(tool.logicalName)) {
              return yield* Effect.fail(
                lifecycleError(
                  lifecycle,
                  `tool_permissions[${permissionIndex}].tools[${toolIndex}]`,
                  `duplicate lifecycle-permitted tool '${tool.logicalName}' for agent '${agent.name}'`,
                ),
              );
            }

            const materialized = materializeLifecycleToolPermission({
              logicalName: tool.logicalName,
              toolRef: tool.ref,
              registry,
            });
            if (!(materialized instanceof Object) || "message" in materialized) {
              return yield* Effect.fail(
                lifecycleError(
                  lifecycle,
                  `tool_permissions[${permissionIndex}].tools[${toolIndex}]`,
                  materialized.message,
                ),
              );
            }

            agentBindings.push({
              kind: materialized.kind,
              logicalName: materialized.logicalName,
              contract: materialized.contract,
              toolPluginName: materialized.toolPluginName,
              toolName: materialized.toolName,
              toolSourcePath: materialized.toolSourcePath,
            });
            existingLogicalNames.add(tool.logicalName);
          }

          byAgent.set(agent.name, agentBindings);
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

export const validateLifecycle = (
  lifecycle: Lifecycle,
  registry: PluginRegistry,
): Effect.Effect<void, CompileError> =>
  Effect.gen(function* () {
    const templateUsageError = validateLifecycleTemplateUsage(lifecycle);
    if (templateUsageError) {
      return yield* Effect.fail(templateUsageError);
    }

    for (const [index, phase] of lifecycle.phases.entries()) {
      const referenceKinds = [
        phase.lifecycle ? "lifecycle" : undefined,
        phase.lifecycle_binding ? "lifecycle_binding" : undefined,
        phase.agents.length > 0 ? "agents" : undefined,
      ].filter((kind): kind is string => kind !== undefined);

      if (referenceKinds.length > 1) {
        return yield* Effect.fail(
          lifecycleError(
            lifecycle,
            `phases[${index}]`,
            `phase '${phase.name}' declares multiple references (${referenceKinds.join(", ")}); use only one of lifecycle, lifecycle_binding, or agents`,
          ),
        );
      }

      if (phase.lifecycle) {
        const reg = yield* resolveRefToRegistry(phase.lifecycle, registry, lifecycle.sourcePath);
        const name = parseNamedRef(phase.lifecycle).name;
        const referencedLifecycle = reg.lifecycles.get(name);

        if (referencedLifecycle) {
          if (referencedLifecycle.parameters.length > 0) {
            return yield* Effect.fail(
              lifecycleError(
                lifecycle,
                `phases[${index}].lifecycle`,
                `phase '${phase.name}' references parameterized lifecycle '${phase.lifecycle}' without bindings; use lifecycle_binding instead`,
              ),
            );
          }
          continue;
        }

        if (!reg.agents.has(name)) {
          return yield* Effect.fail(
            lifecycleError(
              lifecycle,
              `phases[${index}].lifecycle`,
              `phase '${phase.name}' references unknown lifecycle or agent '${phase.lifecycle}'`,
            ),
          );
        }
      }

      if (phase.lifecycle_binding) {
        const reg = yield* resolveRefToRegistry(
          phase.lifecycle_binding.lifecycle,
          registry,
          lifecycle.sourcePath,
        );
        const name = parseNamedRef(phase.lifecycle_binding.lifecycle).name;
        const referencedLifecycle = reg.lifecycles.get(name);

        if (!referencedLifecycle) {
          const message = reg.agents.has(name)
            ? `phase '${phase.name}' uses lifecycle_binding for '${phase.lifecycle_binding.lifecycle}', but that reference resolves to an agent`
            : `phase '${phase.name}' references unknown lifecycle '${phase.lifecycle_binding.lifecycle}'`;
          return yield* Effect.fail(
            lifecycleError(
              lifecycle,
              `phases[${index}].lifecycle_binding`,
              message,
            ),
          );
        }

        const providedBindings = phase.lifecycle_binding.bindings ?? {};
        const targetParameters = lifecycleParameterMap(referencedLifecycle);

        const unknownBindings = Object.keys(providedBindings).filter(
          (bindingName) => !targetParameters.has(bindingName),
        );
        if (unknownBindings.length > 0) {
          return yield* Effect.fail(
            lifecycleError(
              lifecycle,
              `phases[${index}].lifecycle_binding.bindings`,
              `phase '${phase.name}' passes unknown binding(s) to '${phase.lifecycle_binding.lifecycle}': ${unknownBindings.join(", ")}`,
            ),
          );
        }

        const missingRequired = referencedLifecycle.parameters
          .filter((parameter) => parameterIsRequired(parameter))
          .map((parameter) => parameter.name)
          .filter((bindingName) => !hasBinding(providedBindings, bindingName));
        if (missingRequired.length > 0) {
          return yield* Effect.fail(
            lifecycleError(
              lifecycle,
              `phases[${index}].lifecycle_binding.bindings`,
              `phase '${phase.name}' is missing required binding(s) for '${phase.lifecycle_binding.lifecycle}': ${missingRequired.join(", ")}`,
            ),
          );
        }
      }

      if (phase.requires.length > 0 && phase.agents.length === 0) {
        return yield* Effect.fail(
          lifecycleError(
            lifecycle,
            `phases[${index}].requires`,
            `phase '${phase.name}' declares trait requirements but assigns no agents`,
          ),
        );
      }

      if (phase.agents.length > 0) {
        const assignedAgentCapabilities: ResolvedAgentCapabilities[] = [];
        const assignedAgentIds = new Set<string>();

        for (const [agentIndex, agentRef] of phase.agents.entries()) {
          const agentCapabilities = yield* resolveLifecycleAssignedAgent(
            lifecycle,
            index,
            agentIndex,
            agentRef,
            registry,
          );
          const agentId = `${agentCapabilities.agent.name}:${agentCapabilities.agent.sourcePath}`;
          if (assignedAgentIds.has(agentId)) {
            return yield* Effect.fail(
              lifecycleError(
                lifecycle,
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
              lifecycleError(
                lifecycle,
                `phases[${index}].requires[${requirementIndex}].min`,
                "min must be an integer greater than or equal to 1",
              ),
            );
          }

          if (requirement.all.length === 0) {
            return yield* Effect.fail(
              lifecycleError(
                lifecycle,
                `phases[${index}].requires[${requirementIndex}].all`,
                "trait requirement must include at least one trait",
              ),
            );
          }

          const requiredTraitIds = new Set<string>();
          for (const [traitIndex, traitRef] of requirement.all.entries()) {
            const traitId = yield* resolveLifecycleRequiredTraitId(
              lifecycle,
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
              lifecycleError(
                lifecycle,
                `phases[${index}].requires[${requirementIndex}]`,
                `phase '${phase.name}' requires at least ${min} assigned agent(s) with all traits [${[...requiredTraitIds].join(", ")}], but only ${satisfiedCount} match`,
              ),
            );
          }
        }
      }
    }
  });
