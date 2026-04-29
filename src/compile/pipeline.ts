/**
 * Compile pipeline orchestration.
 *
 * Flow: Load (+deps) → Resolve → Compose → Validate lifecycles → Instantiate
 * concrete lifecycle skills → Lower → Emit.
 */

import { Effect } from "effect";
import { basename, dirname } from "node:path";
import { getHarness, harnessSupportsProjectScope, resolveHarnessRoot } from "../harnesses.js";
import type { HarnessId, HarnessScope, PluginTargetId } from "../types.js";
import { loadPlugin } from "./load.js";
import {
  instantiateLifecycle,
  resolveAgent,
  resolveLifecycleSkillPermissions,
  resolveLifecycleToolPermissions,
  validateLifecycle,
} from "./resolve.js";
import { composeAgent, type ComposedAgent } from "./compose.js";
import {
  describeOperation,
  executeLowering as executeOpenCodeLowering,
  planLowering as planOpenCodeLowering,
  type LowerOperation,
} from "./lowerers/opencode.js";
import {
  executeLowering as executeClaudeCodeLowering,
  planLowering as planClaudeCodeLowering,
} from "./lowerers/claude-code.js";
import {
  executeLowering as executeGeminiCliLowering,
  planLowering as planGeminiCliLowering,
} from "./lowerers/gemini-cli.js";
import {
  executeLowering as executeCodexCliLowering,
  planLowering as planCodexCliLowering,
} from "./lowerers/codex-cli.js";
import {
  InvalidTargetScopeError,
  UnsupportedTargetCapabilityError,
  UnknownTargetError,
  AgentValidationError,
  type CompileError,
} from "./errors.js";
import type { CanonicalTool, Hook, Lifecycle, Skill } from "./sources.js";
import type { PluginRegistry } from "./registry.js";
import { resolveManifestTargets } from "../manifest.js";
import { getCompileTargetCapabilities } from "./target-capabilities.js";
import {
  computeAgentCacheDescriptor,
  computeContentHash,
  computeStableHash,
  getCacheDir,
  readCacheEntry,
  writeCacheEntry,
  type AgentCacheDescriptor,
} from "./cache.js";
import { writeLockfile } from "./lockfile.js";

interface LowererModule {
  readonly planLowering: (input: {
    readonly agents: ReadonlyArray<ComposedAgent>;
    readonly lifecycles: ReadonlyArray<Lifecycle>;
    readonly tools: ReadonlyArray<CanonicalTool>;
    readonly skills: ReadonlyArray<Skill>;
    readonly hooks: ReadonlyArray<Hook>;
    readonly registry: PluginRegistry;
    readonly target: {
      readonly scope: HarnessScope;
      readonly root: string;
      readonly sourcePluginName: string;
      readonly sourcePluginVersion?: string;
      readonly sourcePluginPath?: string;
    };
  }) => Promise<LowerOperation[]>;
  readonly executeLowering: (
    operations: LowerOperation[],
    options: { backup: boolean; dryRun: boolean },
  ) => Promise<{ backups: string[] }>;
}

export interface CompileOptions {
  readonly pluginPath: string;
  readonly target: string;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly dryRun: boolean;
  readonly backup: boolean;
}

export interface CompileResult {
  readonly target: string;
  readonly scope: HarnessScope;
  readonly outputRoot: string;
  readonly cacheDir: string;
  readonly lockfilePath: string | null;
  readonly composed: ReadonlyArray<ComposedAgent>;
  readonly lifecycles: ReadonlyArray<Lifecycle>;
  readonly operations: ReadonlyArray<LowerOperation>;
  readonly backups: ReadonlyArray<string>;
  readonly built: ReadonlyArray<string>;
  readonly fromCache: ReadonlyArray<string>;
}

const SUPPORTED_TARGETS = ["opencode", "claude-code", "gemini-cli", "codex-cli"] as const;

const getLowerer = (target: string): LowererModule => {
  switch (target) {
    case "opencode":
      return {
        planLowering: planOpenCodeLowering,
        executeLowering: executeOpenCodeLowering,
      };
    case "claude-code":
      return {
        planLowering: planClaudeCodeLowering,
        executeLowering: executeClaudeCodeLowering,
      };
    case "gemini-cli":
      return {
        planLowering: planGeminiCliLowering,
        executeLowering: executeGeminiCliLowering,
      };
    case "codex-cli":
      return {
        planLowering: planCodexCliLowering,
        executeLowering: executeCodexCliLowering,
      };
    default:
      throw new Error(`unsupported lowerer target '${target}'`);
  }
};

const pathSegments = (path: string): ReadonlyArray<string> =>
  path.split(/[\\/]+/g).filter((segment) => segment.length > 0);

const isAgentMarkdownTarget = (target: string, agentName: string): boolean =>
  basename(target) === `${agentName}.md` &&
  pathSegments(dirname(target)).includes("agents");

const collectCacheOutputs = (
  agentName: string,
  operations: ReadonlyArray<LowerOperation>,
): Record<string, string> => {
  const outputs: Record<string, string> = {};

  for (const operation of operations) {
    if (operation.kind === "write-md" && isAgentMarkdownTarget(operation.target, agentName)) {
      outputs[operation.target] = computeContentHash(operation.content);
      continue;
    }

    if (operation.kind === "patch-json" && operation.agentName === agentName) {
      outputs[`${operation.target}#agent.${agentName}`] = computeStableHash(
        operation.nextBlock,
      );
    }
  }

  return outputs;
};

const applyLifecycleToolPermissions = (
  agents: ReadonlyArray<ComposedAgent>,
  permissions: ReadonlyMap<string, ReadonlyArray<ComposedAgent["toolBindings"][number]>>,
): ComposedAgent[] =>
  agents.map((agent) => {
    const permitted = permissions.get(agent.name) ?? [];
    if (permitted.length === 0) return agent;

    const existing = new Set(agent.toolBindings.map((binding) => binding.logicalName));
    const merged = [...agent.toolBindings];
    for (const binding of permitted) {
      if (existing.has(binding.logicalName)) {
        continue;
      }
      merged.push(binding);
      existing.add(binding.logicalName);
    }

    return {
      ...agent,
      toolBindings: merged.sort((left, right) =>
        left.logicalName.localeCompare(right.logicalName),
      ),
    };
  });

const applyLifecycleSkillPermissions = (
  agents: ReadonlyArray<ComposedAgent>,
  permissions: ReadonlyMap<string, ReadonlyArray<string>>,
): ComposedAgent[] =>
  agents.map((agent) => {
    const permitted = permissions.get(agent.name) ?? [];
    if (permitted.length === 0) return agent;

    return {
      ...agent,
      allowedSkills: [...new Set([...agent.allowedSkills, ...permitted])].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  });

const registryTargetsHarness = (
  registry: PluginRegistry,
  artifact: string,
  target: HarnessId,
): boolean => {
  const targets = (registry.targets as Record<string, readonly PluginTargetId[] | undefined>)[artifact];
  return resolveManifestTargets(targets ?? []).includes(target);
};

const findRegistryByPluginName = (
  registry: PluginRegistry,
  pluginName: string,
): PluginRegistry | undefined => {
  if (registry.pluginName === pluginName) return registry;

  for (const dep of registry.deps.values()) {
    const found = findRegistryByPluginName(dep, pluginName);
    if (found) return found;
  }

  return undefined;
};

const bindingToolsTargetHarness = (
  registry: PluginRegistry,
  binding: ComposedAgent["toolBindings"][number],
  target: HarnessId,
): boolean => {
  const owner = findRegistryByPluginName(registry, binding.toolPluginName);
  return owner ? registryTargetsHarness(owner, "tools", target) : false;
};

const assertAgentToolBindingsAreTargeted = (
  agents: ReadonlyArray<ComposedAgent>,
  registry: PluginRegistry,
  target: HarnessId,
): Effect.Effect<void, CompileError> => {
  const leakingAgent = agents
    .map((agent) => ({
      agent,
      binding: agent.toolBindings.find((binding) => !bindingToolsTargetHarness(registry, binding, target)),
    }))
    .find(({ binding }) => binding !== undefined);

  if (!leakingAgent?.binding) return Effect.void;

  return Effect.fail(
    new AgentValidationError({
      sourcePath: "<composed-agent>",
      agentName: leakingAgent.agent.name,
      field: "tools",
      message:
        `agent '${leakingAgent.agent.name}' resolves canonical tool binding '${leakingAgent.binding.logicalName}' ` +
        `from plugin '${leakingAgent.binding.toolPluginName}' for target '${target}', but that plugin's ` +
        `targets.tools does not include '${target}'`,
    }),
  );
};

const assertTargetSupportsGeneratedCanonicalTools = (
  target: string,
  agents: ReadonlyArray<ComposedAgent>,
): Effect.Effect<void, CompileError> => {
  const capabilities = getCompileTargetCapabilities(target);
  if (capabilities.generatedCanonicalTools === "executable") {
    return Effect.void;
  }

  const agentsWithBindings = agents
    .filter((agent) => agent.toolBindings.length > 0)
    .map((agent) => `${agent.name} (${agent.toolBindings.length})`);

  if (agentsWithBindings.length === 0) {
    return Effect.void;
  }

  return Effect.fail(
    new UnsupportedTargetCapabilityError({
      target,
      capability: "generated-canonical-tools",
      message:
        `canonical tool bindings require an executable generated-tool runtime; ` +
        `${target} currently lowers native tool allowances and skills only. ` +
        `Agents with canonical tool bindings: ${agentsWithBindings.join(", ")}`,
    }),
  );
};

const assertTargetSupportsSkillPermissions = (
  target: string,
  agents: ReadonlyArray<ComposedAgent>,
): Effect.Effect<void, CompileError> => {
  const capabilities = getCompileTargetCapabilities(target);
  if (capabilities.skillPermissions === "supported") {
    return Effect.void;
  }

  const agentsWithPermissionOnlySkills = agents
    .map((agent) => {
      const dependencySkills = new Set(agent.skills);
      const permissionOnlySkills = agent.allowedSkills.filter(
        (skill) => !dependencySkills.has(skill),
      );
      return { agent, permissionOnlySkills };
    })
    .filter(({ permissionOnlySkills }) => permissionOnlySkills.length > 0)
    .map(({ agent, permissionOnlySkills }) =>
      `${agent.name} (${permissionOnlySkills.join(", ")})`,
    );

  if (agentsWithPermissionOnlySkills.length === 0) {
    return Effect.void;
  }

  return Effect.fail(
    new UnsupportedTargetCapabilityError({
      target,
      capability: "skill-permissions",
      message:
        `${target} does not support per-agent skill permission visibility. ` +
        `Use direct agent skill dependencies for this target or compile a target ` +
        `with skill permission support. Agents with permission-only skills: ` +
        agentsWithPermissionOnlySkills.join(", "),
    }),
  );
};

export const compilePluginForTarget = (
  options: CompileOptions
): Effect.Effect<CompileResult, CompileError> =>
  Effect.gen(function* () {
    if (!(SUPPORTED_TARGETS as readonly string[]).includes(options.target)) {
      return yield* Effect.fail(
        new UnknownTargetError({
          target: options.target,
          supportedTargets: [...SUPPORTED_TARGETS],
        })
      );
    }

    const lowerer = getLowerer(options.target);
    const harness = getHarness(options.target as HarnessId);
    if (options.scope === "project" && !options.projectPath) {
      return yield* Effect.fail(
        new InvalidTargetScopeError({
          target: options.target,
          scope: options.scope,
          message: "project scope requires --project <path>",
        })
      );
    }
    if (options.scope === "project" && !harnessSupportsProjectScope(harness)) {
      return yield* Effect.fail(
        new InvalidTargetScopeError({
          target: options.target,
          scope: options.scope,
          message: "this harness has no project-local config root",
        })
      );
    }

    const outputRoot = resolveHarnessRoot(
      harness,
      options.scope,
      options.projectPath
    );
    if (!outputRoot) {
      return yield* Effect.fail(
        new InvalidTargetScopeError({
          target: options.target,
          scope: options.scope,
          message: "could not resolve the harness root for this scope",
        })
      );
    }

    const cacheDir = getCacheDir(options.pluginPath);
    const useCache = !options.dryRun;
    const registry = yield* loadPlugin(options.pluginPath);
    const targetId = options.target as HarnessId;
    const targetsAgents = registryTargetsHarness(registry, "agents", targetId);
    const targetsLifecycles = registryTargetsHarness(registry, "lifecycles", targetId);
    const targetsTools = registryTargetsHarness(registry, "tools", targetId);
    const targetsSkills = registryTargetsHarness(registry, "skills", targetId);
    const targetsHooks = registryTargetsHarness(registry, "hooks", targetId);
    const targetsRules = registryTargetsHarness(registry, "rules", targetId);
    const targetsCommands = registryTargetsHarness(registry, "commands", targetId);
    const hasLowerableArtifacts =
      targetsAgents ||
      targetsLifecycles ||
      targetsTools ||
      targetsSkills ||
      targetsHooks ||
      targetsRules ||
      targetsCommands;

    const composed: ComposedAgent[] = [];
    const built: string[] = [];
    const fromCache: string[] = [];
    const cacheDescriptors = new Map<string, AgentCacheDescriptor>();

    for (const [, agent] of [...registry.agents.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (!targetsAgents) break;
      const descriptor = yield* Effect.promise(() =>
        computeAgentCacheDescriptor(agent, registry, {
          target: options.target,
          scope: options.scope,
        })
      );
      cacheDescriptors.set(agent.name, descriptor);

      const cached = useCache
        ? yield* Effect.promise(() => readCacheEntry(cacheDir, descriptor.key))
        : null;

      if (
        cached &&
        cached.sourceHash === descriptor.sourceHash &&
        cached.contextHash === descriptor.contextHash
      ) {
        composed.push(cached.composed);
        fromCache.push(agent.name);
        continue;
      }

      const resolved = yield* resolveAgent(agent, registry, options.target);
      composed.push(composeAgent(resolved));
      built.push(agent.name);
    }

    // Validate lifecycle sources, then lower only concrete instances.
    const lifecycles: Lifecycle[] = [];
    for (const [, lifecycle] of [...registry.lifecycles.entries()].sort(
      ([a], [b]) => a.localeCompare(b)
    )) {
      if (!targetsLifecycles) break;
      yield* validateLifecycle(lifecycle, registry);
      if (lifecycle.parameters.length > 0) continue;
      lifecycles.push(yield* instantiateLifecycle(lifecycle));
    }

    const lifecycleToolPermissions = yield* resolveLifecycleToolPermissions(lifecycles, registry);
    const lifecycleSkillPermissions =
      getCompileTargetCapabilities(options.target).skillPermissions === "supported"
        ? resolveLifecycleSkillPermissions(lifecycles, registry)
        : new Map<string, ReadonlyArray<string>>();
    const composedWithLifecycleTools = applyLifecycleToolPermissions(
      composed,
      lifecycleToolPermissions,
    );
    yield* assertAgentToolBindingsAreTargeted(
      composedWithLifecycleTools,
      registry,
      targetId,
    );
    const composedForLowering = applyLifecycleSkillPermissions(
      composedWithLifecycleTools,
      lifecycleSkillPermissions,
    );
    yield* assertTargetSupportsGeneratedCanonicalTools(
      options.target,
      composedForLowering,
    );
    yield* assertTargetSupportsSkillPermissions(
      options.target,
      composedForLowering,
    );

    const targetTools = targetsTools
      ? [...registry.tools.values()].sort((left, right) => left.name.localeCompare(right.name))
      : [];
    const targetSkills = targetsSkills
      ? [...registry.skills.values()].sort((left, right) => left.name.localeCompare(right.name))
      : [];
    const targetHooks = targetsHooks
      ? [...registry.hooks.values()].sort((left, right) => left.name.localeCompare(right.name))
      : [];

    const allOps = hasLowerableArtifacts
      ? yield* Effect.promise(() =>
          lowerer.planLowering({
            agents: composedForLowering,
            lifecycles,
            tools: targetTools,
            skills: targetSkills,
            hooks: targetHooks,
            registry,
            target: {
              scope: options.scope,
              root: outputRoot,
              sourcePluginName: registry.pluginName,
              sourcePluginVersion: registry.pluginVersion,
              sourcePluginPath: registry.pluginPath,
            },
          })
        )
      : [];

    let backups: string[] = [];
    if (!options.dryRun) {
      const result = yield* Effect.promise(() =>
        lowerer.executeLowering(allOps, { backup: options.backup, dryRun: false })
      );
      backups = result.backups;
    }

    let lockfilePath: string | null = null;
    if (useCache) {
      const builtSet = new Set(built);

      for (const agent of composed) {
        if (!builtSet.has(agent.name)) continue;
        const descriptor = cacheDescriptors.get(agent.name);
        if (!descriptor) continue;

        yield* Effect.promise(() =>
          writeCacheEntry(cacheDir, {
            key: descriptor.key,
            sourceHash: descriptor.sourceHash,
            contextHash: descriptor.contextHash,
            composed: agent,
            outputs: collectCacheOutputs(agent.name, allOps),
            timestamp: new Date().toISOString(),
          })
        );
      }

      lockfilePath = yield* Effect.promise(() =>
        writeLockfile(options.pluginPath, registry)
      );
    }

    return {
      target: options.target,
      scope: options.scope,
      outputRoot,
      cacheDir,
      lockfilePath,
      composed: composedForLowering,
      lifecycles,
      operations: allOps,
      backups,
      built,
      fromCache,
    };
  });

export const formatOperations = (
  operations: ReadonlyArray<LowerOperation>
): string => operations.map(describeOperation).join("\n");
