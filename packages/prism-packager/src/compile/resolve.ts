/**
 * Resolve phase: materialize referenced parts for each agent and validate
 * sop wiring against the loaded registry graph.
 */

import { Effect, Schema } from "effect";
import type {
  CompileManifestSopPhase,
} from "@skastr0/prism-sdk/compile-manifest";
import type {
  CompileManifestSopProjectionInput,
} from "./compile-manifest.js";
import {
  workflowJsonSchemaFromEffectSchema,
  WorkflowOutputSchemaError,
} from "../workflow-output-schema.js";
import {
  Agent,
  ClaudeCodeModelTarget,
  Identity,
  type ModelProfile,
  OpenCodeModelTargetBlock,
  Personality,
  type NormalizedSopPhase as SopPhase,
  Sop,
} from "./sources.js";
import {
  AgentValidationError,
  MissingTargetResolutionError,
  SourceParseError,
  UnknownReferenceError,
  type CompileError,
} from "./errors.js";
import type { PluginRegistry } from "./registry.js";
import { resolveManifestTargets } from "../manifest.js";
import { getCompileTargetCapabilities } from "./target-capabilities.js";
import { parseNamedRef, parseSpaceItemRef, resolveRefToRegistry } from "./refs.js";

export interface ResolvedContractBinding {
  readonly logicalName: string;
  readonly toolPluginName: string;
  readonly toolName: string;
  readonly toolSourcePath: string;
}

export interface ResolvedAgent {
  readonly agent: Agent;
  readonly identity: Identity;
  readonly personality: Personality | undefined;
  readonly resolvedModel: Record<string, unknown> | undefined;
  readonly skills: ReadonlyArray<string>;
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
    case "opencode":
    case "opencode2": {
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
  if (target !== "opencode" && target !== "opencode2") return undefined;
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

const resolveAgentSkillSurface = (
  agent: Agent,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ReadonlyArray<string>, CompileError> =>
  resolveSkillsForTarget(agent, agent.skills, registry, target);

const buildResolvedAgent = (
  agent: Agent,
  identity: Identity,
  personality: Personality | undefined,
  resolvedModel: Record<string, unknown> | undefined,
  skills: ReadonlyArray<string>,
): ResolvedAgent => ({
  agent,
  identity,
  personality,
  resolvedModel,
  skills,
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
    const skills = yield* resolveAgentSkillSurface(agent, registry, target);

    return buildResolvedAgent(agent, identity, personality, resolvedModel, skills);
  });

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

const sopSourceError = (sop: Sop, field: string, message: string): SourceParseError =>
  new SourceParseError({
    sourcePath: sop.sourcePath,
    kind: "sop",
    message: `${field}: ${message}`,
  });

const serializeSopPhaseContractSchema = (
  sop: Sop,
  phaseIndex: number,
  side: "input" | "output",
  schema: Schema.Schema.AnyNoContext,
): Effect.Effect<Record<string, unknown>, CompileError> =>
  Effect.try({
    try: () => workflowJsonSchemaFromEffectSchema(schema),
    catch: (error) => {
      if (error instanceof WorkflowOutputSchemaError) {
        return sopSourceError(sop, `phases[${phaseIndex}].${side}`, error.message);
      }
      return sopSourceError(sop, `phases[${phaseIndex}].${side}`, String(error));
    },
  });

const projectSopPhaseForManifest = (
  sop: Sop,
  phase: SopPhase,
  phaseIndex: number,
): Effect.Effect<CompileManifestSopPhase, CompileError> =>
  Effect.gen(function* () {
    const input = phase.input
      ? yield* serializeSopPhaseContractSchema(
          sop,
          phaseIndex,
          "input",
          phase.input as Schema.Schema.AnyNoContext,
        )
      : undefined;
    const output = phase.output
      ? yield* serializeSopPhaseContractSchema(
          sop,
          phaseIndex,
          "output",
          phase.output as Schema.Schema.AnyNoContext,
        )
      : undefined;

    return {
      name: phase.name,
      purpose: phase.purpose,
      acceptanceCriteria: [...phase.acceptanceCriteria],
      ...(phase.escalation !== undefined ? { escalation: phase.escalation } : {}),
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
    };
  });

const projectSopForManifest = (
  sop: Sop,
): Effect.Effect<CompileManifestSopProjectionInput, CompileError> =>
  Effect.gen(function* () {
    const phases: CompileManifestSopPhase[] = [];
    for (const [index, phase] of sop.phases.entries()) {
      phases.push(yield* projectSopPhaseForManifest(sop, phase, index));
    }
    return { name: sop.name, phases };
  });

export const projectSopsForCompileManifest = (
  sops: ReadonlyArray<Sop>,
): Effect.Effect<ReadonlyArray<CompileManifestSopProjectionInput>, CompileError> =>
  Effect.gen(function* () {
    const projected: CompileManifestSopProjectionInput[] = [];
    for (const sop of sops) {
      projected.push(yield* projectSopForManifest(sop));
    }
    return projected;
  });
