/**
 * Compile pipeline orchestration.
 *
 * Flow: Load (+deps) → Resolve → Compose → Validate orbits → Instantiate
 * concrete orbit skills → Lower → Emit.
 */

import { Effect, Option } from "effect";
import { basename, dirname } from "node:path";
import { getHarness, harnessSupportsProjectScope, resolveHarnessRoot } from "../harnesses.js";
import { HarnessRoots } from "../services/prism-env.js";
import { expandPath } from "../fs.js";
import { deriveProjectKey } from "../project-key.js";
import type { HarnessId, HarnessScope, PluginTargetId } from "../types.js";
import { loadPlugin } from "./load.js";
import {
  instantiateOrbit,
  resolveAgent,
  resolveOrbitSkillPermissions,
  resolveOrbitToolPermissions,
  validateOrbit,
} from "./resolve.js";
import {
  isCompileManifestHarnessId,
  readCompileManifest,
  updateCompileManifestForTarget,
} from "./compile-manifest.js";
import { composeAgent, type ComposedAgent } from "./compose.js";
import { planWorkflowRefsEmit, WORKFLOW_REFS_HARNESS } from "./workflow-refs-emitter.js";
import { planLowering as planOpenCodeLowering } from "./lowerers/opencode.js";
import { planLowering as planClaudeCodeLowering } from "./lowerers/claude-code.js";
import { planLowering as planAntigravityCliLowering } from "./lowerers/antigravity-cli.js";
import { planLowering as planCodexCliLowering } from "./lowerers/codex-cli.js";
import { planLowering as planAmpCodeLowering } from "./lowerers/amp-code.js";
import { planLowering as planHermesLowering } from "./lowerers/hermes.js";
import { planLowering as planGrokLowering } from "./lowerers/grok.js";
import { planLowering as planFactoryDroidLowering } from "./lowerers/factory-droid.js";
import { planLowering as planPiLowering } from "./lowerers/pi.js";
import { planLowering as planKimiCodeLowering } from "./lowerers/kimi-code.js";
import { planLowering as planCursorLowering } from "./lowerers/cursor.js";
import { type LowerOutput } from "./lowerers/shared.js";
import { injectSkillReferenceFiles } from "./skill-reference-files.js";
import type { DesiredFile, DesiredRegion, DesiredRoot } from "../sync/desired.js";
import type { SyncOp } from "../sync/plan.js";
import type { SyncOpFailure, SyncOpListener } from "../sync/apply.js";
import { blockedTargetErrors, syncDesiredRoot } from "../sync/run.js";
import {
  InvalidTargetScopeError,
  UnsupportedTargetCapabilityError,
  UnknownTargetError,
  AgentValidationError,
  type CompileError,
} from "./errors.js";
import { BlockedTargetError, PluginManifestError } from "../errors.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "./sources.js";
import type { PluginRegistry } from "./registry.js";
import { planHooksForTarget, type HookFidelityEntry } from "./hook-planning.js";
import {
  getCompileTargetCapabilities,
  targetHasGeneratedMcpConfig,
} from "./target-capabilities.js";
import {
  resolveManifestTargetsForSourceNoun,
  selectSourcesForTarget,
  sourceSelectionFromManifestTargets,
  type SourceNoun,
  type SourceRuntimeRequirements,
} from "../source-selection.js";
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
import { sha256Hex } from "../mcp/runtime-metadata.js";
import {
  generatedMcpServerName,
  mcpExposureProfileForTarget,
  resolveMcpRuntime,
} from "./mcp-runtime.js";
import {
  prismMcpServerPath,
  writePrismMcpServerBundle,
} from "./mcp-runtime-path.js";
import {
  generateMcpServerBundle,
  mcpServerArtifactRelativePath,
  mcpServerStdioArtifactRelativePath,
  mcpToolNamesForBindings,
  type McpServerExposureProfile,
} from "./mcp-bundle.js";
import { join as joinPath } from "node:path";
import type { ResolvedContractBinding } from "./resolve.js";
import { bindingsOwnedByPlugin } from "./tool-bindings.js";

interface LowererModule {
  readonly planLowering: (input: {
    readonly agents: ReadonlyArray<ComposedAgent>;
    readonly orbits: ReadonlyArray<Orbit>;
    readonly tools: ReadonlyArray<CanonicalTool>;
    readonly skills: ReadonlyArray<Skill>;
    readonly hooks: ReadonlyArray<Hook>;
    readonly registry: PluginRegistry;
    readonly target: {
      readonly scope: HarnessScope;
      readonly root: string;
      readonly mcpExposureProfile?: string;
      readonly prismHome?: string;
      readonly sourcePluginName: string;
      readonly sourcePluginVersion?: string;
      readonly sourcePluginPath?: string;
    };
  }) => Promise<LowerOutput>;
}

interface CompileTargetContext {
  readonly targetId: HarnessId;
  readonly lowerer: LowererModule;
  readonly outputRoot: string;
  readonly prismHome: string;
  readonly cacheDir: string;
  readonly useCache: boolean;
}

interface TargetSurfaceSelection {
  readonly target: HarnessId;
  readonly scope: HarnessScope;
  readonly runtime: SourceRuntimeRequirements;
  readonly agents: boolean;
  readonly orbits: boolean;
  readonly tools: boolean;
  readonly skills: boolean;
  readonly hooks: boolean;
  readonly rules: boolean;
  readonly commands: boolean;
  readonly hasLowerableArtifacts: boolean;
}

interface AgentCompositionResult {
  readonly composed: ComposedAgent[];
  readonly built: string[];
  readonly fromCache: string[];
  readonly cacheDescriptors: ReadonlyMap<string, AgentCacheDescriptor>;
}

interface TargetArtifacts {
  readonly tools: CanonicalTool[];
  readonly skills: Skill[];
  readonly hooks: Hook[];
}

export interface CompileOptions {
  readonly pluginPath: string;
  readonly target: string;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly root?: string;
  /** Prism home directory, threaded from the CLI edge (no env fallback). */
  readonly prismHome: string;
  readonly dryRun: boolean;
  readonly mcpLifecycle?: CompileMcpLifecycleMode;
  readonly packageMode?: boolean;
  readonly emitWorkflowRefs?: boolean;
  /** Optional per-op progress listener (fires only on real apply, not dry-run). */
  readonly onOp?: SyncOpListener;
}

export type CompileMcpLifecycleMode = "none" | "verify" | "serve";

export interface CompileResult {
  readonly target: string;
  readonly scope: HarnessScope;
  readonly outputRoot: string;
  readonly cacheDir: string;
  readonly lockfilePath: string | null;
  readonly composed: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  /** Desired state produced by the (pure) lowerer. */
  readonly files: ReadonlyArray<DesiredFile>;
  readonly regions: ReadonlyArray<DesiredRegion>;
  /** Sync plan classification (applied unless dry-run). */
  readonly operations: ReadonlyArray<SyncOp>;
  /** Per-op apply failures — collected, never thrown mid-batch. */
  readonly failures: ReadonlyArray<SyncOpFailure>;
  /** Foreign-file placements the engine refused (collect, don't throw). */
  readonly blocked: ReadonlyArray<BlockedTargetError>;
  readonly backups: ReadonlyArray<string>;
  /** True when the run wrote nothing — every op was a skip. */
  readonly converged: boolean;
  readonly built: ReadonlyArray<string>;
  readonly fromCache: ReadonlyArray<string>;
}

export interface PlannedCompileResult {
  readonly target: string;
  readonly scope: HarnessScope;
  readonly outputRoot: string;
  readonly cacheDir: string;
  readonly composed: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly files: ReadonlyArray<DesiredFile>;
  readonly regions: ReadonlyArray<DesiredRegion>;
  readonly built: ReadonlyArray<string>;
  readonly fromCache: ReadonlyArray<string>;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
}

const compileProjectKey = (projectPath?: string): string =>
  deriveProjectKey(projectPath ? expandPath(projectPath) : process.cwd()).key;

export const syncWorkflowRefsForProject = async (options: {
  readonly prismHome: string;
  readonly projectPath?: string;
  readonly dryRun?: boolean;
  readonly onOp?: SyncOpListener;
}): Promise<Awaited<ReturnType<typeof syncDesiredRoot>>> => {
  const projectKey = compileProjectKey(options.projectPath);
  const { manifest } = await readCompileManifest(options.prismHome, projectKey);
  return syncDesiredRoot({
    prismHome: options.prismHome,
    desired: planWorkflowRefsEmit({
      prismHome: options.prismHome,
      projectKey,
      manifest,
    }),
    scopePlugins: new Set([WORKFLOW_REFS_HARNESS]),
    dryRun: options.dryRun ?? false,
    ...(options.onOp ? { onOp: options.onOp } : {}),
  });
};

const SUPPORTED_TARGETS = [
  "opencode",
  "claude-code",
  "antigravity-cli",
  "codex-cli",
  "amp-code",
  "hermes",
  "grok",
  "factory-droid",
  "pi",
  "kimi-code",
  "cursor",
] as const;

const getLowerer = (target: string): LowererModule => {
  switch (target) {
    case "opencode":
      return { planLowering: planOpenCodeLowering };
    case "claude-code":
      return { planLowering: planClaudeCodeLowering };
    case "antigravity-cli":
      return { planLowering: planAntigravityCliLowering };
    case "codex-cli":
      return { planLowering: planCodexCliLowering };
    case "amp-code":
      return { planLowering: planAmpCodeLowering };
    case "hermes":
      return { planLowering: planHermesLowering };
    case "grok":
      return { planLowering: planGrokLowering };
    case "factory-droid":
      return { planLowering: planFactoryDroidLowering };
    case "pi":
      return { planLowering: planPiLowering };
    case "kimi-code":
      return { planLowering: planKimiCodeLowering };
    case "cursor":
      return { planLowering: planCursorLowering };
    default:
      throw new Error(`unsupported lowerer target '${target}'`);
  }
};

const pathSegments = (path: string): ReadonlyArray<string> =>
  path.split(/[\\/]+/g).filter((segment) => segment.length > 0);

const isAgentMarkdownTarget = (target: string, agentName: string): boolean =>
  basename(target) === `${agentName}.md` &&
  ["agents", "droids"].some((segment) =>
    pathSegments(dirname(target)).includes(segment),
  );

const collectCacheOutputs = (
  agentName: string,
  lowered: LowerOutput,
): Record<string, string> => {
  const outputs: Record<string, string> = {};

  for (const file of lowered.files) {
    if (isAgentMarkdownTarget(file.targetPath, agentName)) {
      outputs[file.targetPath] = computeContentHash(file.content);
    }
  }

  for (const region of lowered.regions) {
    if (region.kind === "json-key" && region.regionKey.startsWith(`agent.${agentName}.`)) {
      outputs[`${region.targetPath}#${region.regionKey}`] = computeStableHash(region.value);
    }
  }

  return outputs;
};

const applyOrbitToolPermissions = (
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

const applyOrbitSkillPermissions = (
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
  artifact: SourceNoun,
  target: HarnessId,
): boolean => {
  const selection = sourceSelectionFromManifestTargets(registry.targets, {
    runtime: registry.runtime,
  });
  return selectSourcesForTarget(selection, target).nouns[artifact];
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

const assertTargetSupportsAgents = (
  target: string,
  hasTargetedAgents: boolean,
): Effect.Effect<void, CompileError> => {
  const capabilities = getCompileTargetCapabilities(target);
  if (!hasTargetedAgents || capabilities.agents === "supported") {
    return Effect.void;
  }

  return Effect.fail(
    new UnsupportedTargetCapabilityError({
      target,
      capability: "compiled-agents",
      message:
        `${target} does not support compiled Prism agents. ` +
        `Use target-specific skills or another compile target with a generated agent surface.`,
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

const resolveCompileTargetContext = (
  options: CompileOptions,
): Effect.Effect<CompileTargetContext, CompileError> =>
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

    const rootsOption = yield* Effect.serviceOption(HarnessRoots);
    const outputRoot = resolveHarnessRoot(
      harness,
      options.scope,
      options.projectPath,
      Option.getOrUndefined(rootsOption),
    );
    if (options.root) {
      return {
        targetId: options.target as HarnessId,
        lowerer,
        outputRoot: expandPath(options.root),
        prismHome: expandPath(options.prismHome),
        cacheDir: getCacheDir(options.pluginPath),
        useCache: !options.dryRun && options.packageMode !== true,
      };
    }
    if (!outputRoot) {
      return yield* Effect.fail(
        new InvalidTargetScopeError({
          target: options.target,
          scope: options.scope,
          message: "could not resolve the harness root for this scope",
        })
      );
    }

    return {
      targetId: options.target as HarnessId,
      lowerer,
      outputRoot,
      prismHome: expandPath(options.prismHome),
      cacheDir: getCacheDir(options.pluginPath),
      useCache: !options.dryRun && options.packageMode !== true,
    };
  });

const mcpBindingsForTarget = (options: {
  readonly registry: PluginRegistry;
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly artifacts: TargetArtifacts;
}): ReturnType<typeof bindingsOwnedByPlugin> =>
  bindingsOwnedByPlugin(
    options.registry.pluginName,
    options.artifacts.tools,
    options.agents,
  );

const portFromMcpMetadata = (metadata: { readonly port?: number } | undefined): number | undefined =>
  metadata?.port !== undefined &&
  Number.isInteger(metadata.port) &&
  metadata.port > 0 &&
  metadata.port <= 65535
    ? metadata.port
    : undefined;

const selectTargetSurfaces = (
  registry: PluginRegistry,
  targetId: HarnessId,
  scope: HarnessScope,
): TargetSurfaceSelection => {
  const selected = selectSourcesForTarget(
    sourceSelectionFromManifestTargets(registry.targets, { runtime: registry.runtime }),
    targetId,
    { scope },
  );
  const agents = selected.nouns.agents;
  const orbits = selected.nouns.orbits;
  const tools = selected.nouns.tools;
  const skills = selected.nouns.skills;
  const hooks = selected.nouns.hooks;
  const rules = selected.nouns.rules;
  const commands = selected.nouns.commands;

  return {
    target: selected.target,
    scope,
    runtime: selected.runtime,
    agents,
    orbits,
    tools,
    skills,
    hooks,
    rules,
    commands,
    hasLowerableArtifacts:
      agents || orbits || tools || skills || hooks || rules || commands,
  };
};

const composeTargetAgents = (options: {
  readonly registry: PluginRegistry;
  readonly target: string;
  readonly scope: HarnessScope;
  readonly cacheDir: string;
  readonly useCache: boolean;
  readonly targetsAgents: boolean;
}): Effect.Effect<AgentCompositionResult, CompileError> =>
  Effect.gen(function* () {
    const composed: ComposedAgent[] = [];
    const built: string[] = [];
    const fromCache: string[] = [];
    const cacheDescriptors = new Map<string, AgentCacheDescriptor>();
    if (!options.targetsAgents) {
      return { composed, built, fromCache, cacheDescriptors };
    }

    for (const [, agent] of [...options.registry.agents.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      const descriptor = yield* Effect.promise(() =>
        computeAgentCacheDescriptor(agent, options.registry, {
          target: options.target,
          scope: options.scope,
        })
      );
      cacheDescriptors.set(agent.name, descriptor);

      const cached = options.useCache
        ? yield* Effect.promise(() => readCacheEntry(options.cacheDir, descriptor.key))
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

      const resolved = yield* resolveAgent(agent, options.registry, options.target);
      composed.push(composeAgent(resolved));
      built.push(agent.name);
    }

    return { composed, built, fromCache, cacheDescriptors };
  });

const prepareTargetOrbits = (
  registry: PluginRegistry,
  targetsOrbits: boolean,
): Effect.Effect<Orbit[], CompileError> =>
  Effect.gen(function* () {
    const orbits: Orbit[] = [];
    if (!targetsOrbits) return orbits;

    for (const [, orbit] of [...registry.orbits.entries()].sort(
      ([a], [b]) => a.localeCompare(b)
    )) {
      yield* validateOrbit(orbit, registry);
      if (orbit.parameters.length > 0) continue;
      orbits.push(yield* instantiateOrbit(orbit));
    }

    return orbits;
  });

const applyOrbitGrantsAndAssertCapabilities = (options: {
  readonly target: string;
  readonly targetId: HarnessId;
  readonly registry: PluginRegistry;
  readonly composed: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
}): Effect.Effect<ComposedAgent[], CompileError> =>
  Effect.gen(function* () {
    const orbitToolPermissions = yield* resolveOrbitToolPermissions(
      options.orbits,
      options.registry,
    );
    const orbitSkillPermissions =
      getCompileTargetCapabilities(options.target).skillPermissions === "supported"
        ? resolveOrbitSkillPermissions(options.orbits, options.registry)
        : new Map<string, ReadonlyArray<string>>();
    const composedWithOrbitTools = applyOrbitToolPermissions(
      options.composed,
      orbitToolPermissions,
    );
    yield* assertAgentToolBindingsAreTargeted(
      composedWithOrbitTools,
      options.registry,
      options.targetId,
    );
    const composedForLowering = applyOrbitSkillPermissions(
      composedWithOrbitTools,
      orbitSkillPermissions,
    );
    yield* assertTargetSupportsGeneratedCanonicalTools(
      options.target,
      composedForLowering,
    );
    yield* assertTargetSupportsSkillPermissions(
      options.target,
      composedForLowering,
    );

    return composedForLowering;
  });

const selectTargetArtifacts = (
  registry: PluginRegistry,
  surfaces: TargetSurfaceSelection,
  targetId: HarnessId,
): TargetArtifacts => {
  const compileOwnedSkills =
    targetId !== "cursor" &&
    targetId !== "openclaw" &&
    surfaces.skills;
  return {
    tools: surfaces.tools
      ? [...registry.tools.values()].sort((left, right) => left.name.localeCompare(right.name))
      : [],
    skills: compileOwnedSkills
      ? [...registry.skills.values()].sort((left, right) => left.name.localeCompare(right.name))
      : [],
    hooks: surfaces.hooks
      ? [...registry.hooks.values()]
          .filter((hook) =>
            hook.targets.length === 0 ||
            resolveManifestTargetsForSourceNoun(
              hook.targets as readonly PluginTargetId[],
              "hooks",
            ).includes(targetId)
          )
          .sort((left, right) => left.name.localeCompare(right.name))
      : [],
  };
};

// ---------------------------------------------------------------------------
// Union MCP bundle (overhaul WS3): ONE HTTP bundle per plugin, merging the
// canonical tool bindings of every generated-MCP-config harness the plugin
// targets. Per-harness exposure stays client-side where the harness has native
// filters, and server-side through the HTTP exposure profile header for shared
// daemons that cannot inherit per-client environment.
// ---------------------------------------------------------------------------

const MCP_UNION_NOUNS = ["tools", "agents", "orbits"] as const;

const unionMcpTargetHarnesses = (registry: PluginRegistry): HarnessId[] => {
  const harnesses = new Set<HarnessId>();
  for (const noun of MCP_UNION_NOUNS) {
    for (const target of resolveManifestTargetsForSourceNoun(
      (registry.targets[noun] ?? []) as readonly PluginTargetId[],
      noun,
    )) {
      if (!targetHasGeneratedMcpConfig(target)) continue;
      harnesses.add(target);
    }
  }
  return [...harnesses].sort((left, right) => left.localeCompare(right));
};

/**
 * The bindings a plugin owns for a single (target, scope) — its own
 * canonical tools plus any synthetic contract-dispatch bindings its agents'
 * traits materialize (`bindingsOwnedByPlugin`). This is the ONE compiler
 * predicate for "is this plugin an MCP owner here", reused by the union MCP
 * bundle below and by `mcp-topology-verify.ts`'s diagnostic-mode owner
 * detection — never re-derived, so both stay bit-for-bit aligned with what
 * the lowerers actually emit.
 */
export const resolveOwnedMcpBindingsForTarget = (
  registry: PluginRegistry,
  target: HarnessId,
  scope: HarnessScope,
): Effect.Effect<ReadonlyArray<ResolvedContractBinding>, CompileError> =>
  Effect.gen(function* () {
    const surfaces = selectTargetSurfaces(registry, target, scope);
    const tools = surfaces.tools
      ? [...registry.tools.values()].sort((left, right) => left.name.localeCompare(right.name))
      : [];
    const agents: ComposedAgent[] = [];
    if (surfaces.agents) {
      for (const [, agent] of [...registry.agents.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        agents.push(composeAgent(yield* resolveAgent(agent, registry, target)));
      }
    }
    const orbits = yield* prepareTargetOrbits(registry, surfaces.orbits);
    const orbitToolPermissions = yield* resolveOrbitToolPermissions(orbits, registry);
    const agentsWithOrbitTools = applyOrbitToolPermissions(agents, orbitToolPermissions);
    return bindingsOwnedByPlugin(registry.pluginName, tools, agentsWithOrbitTools);
  });

const resolveUnionMcpBundleInputs = (
  registry: PluginRegistry,
  scope: HarnessScope,
): Effect.Effect<{
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
  readonly exposureProfiles: ReadonlyArray<McpServerExposureProfile>;
}, CompileError> =>
  Effect.gen(function* () {
    const bindings: ResolvedContractBinding[] = [];
    const exposureProfiles: McpServerExposureProfile[] = [];
    const serverName = generatedMcpServerName(registry.pluginName);
    for (const harness of unionMcpTargetHarnesses(registry)) {
      const targetBindings = yield* resolveOwnedMcpBindingsForTarget(registry, harness, scope);
      bindings.push(...targetBindings);
      exposureProfiles.push({
        name: mcpExposureProfileForTarget(serverName, harness),
        toolNames: mcpToolNamesForBindings(registry.pluginName, targetBindings),
      });
    }
    return { bindings, exposureProfiles };
  });

interface PreparedMcpServer {
  /** Absolute path harness configs reference (canonical PRISM_HOME path). */
  readonly serverPath: string;
  readonly serverSha256: string;
  /** Package mode only: bundle bytes emitted as a plan operation instead. */
  readonly packagedBundleContent?: string;
  readonly packagedStdioBundleContent?: string;
}

const prepareUnionMcpServer = (options: {
  readonly compileOptions: CompileOptions;
  readonly context: CompileTargetContext;
  readonly registry: PluginRegistry;
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly artifacts: TargetArtifacts;
}): Effect.Effect<PreparedMcpServer | undefined, CompileError> =>
  Effect.gen(function* () {
    const targetBindings = bindingsOwnedByPlugin(
      options.registry.pluginName,
      options.artifacts.tools,
      options.agents,
    );
    if (targetBindings.length === 0) return undefined;

    const unionInputs = yield* resolveUnionMcpBundleInputs(
      options.registry,
      options.compileOptions.scope,
    );
    const serverName = generatedMcpServerName(options.registry.pluginName);
    const bundle = yield* Effect.promise(() =>
      generateMcpServerBundle({
        sourcePluginName: options.registry.pluginName,
        sourcePluginRoot: options.registry.pluginPath,
        dependencyPluginRoots: Object.entries(options.registry.dependencyPaths),
        serverName,
        version: options.registry.pluginVersion,
        bundleId: serverName,
        bindings: unionInputs.bindings,
        exposureProfiles: unionInputs.exposureProfiles,
      }),
    );

    if (options.compileOptions.packageMode === true) {
      // Packages stay self-contained: the bundle ships inside the package
      // payload (an inert distributable, not a live harness root).
      return {
        serverPath: joinPath(
          options.context.outputRoot,
          ...mcpServerArtifactRelativePath(serverName).split("/"),
        ),
        serverSha256: sha256Hex(bundle.content),
        packagedBundleContent: bundle.content,
        packagedStdioBundleContent: bundle.stdioContent,
      };
    }

    if (options.compileOptions.dryRun) {
      return {
        serverPath: prismMcpServerPath(options.context.prismHome, options.registry.pluginName),
        serverSha256: sha256Hex(bundle.content),
      };
    }

    const write = yield* Effect.promise(() =>
      writePrismMcpServerBundle(
        options.context.prismHome,
        options.registry.pluginName,
        bundle.content,
        bundle.stdioContent,
      ),
    );
    return { serverPath: write.path, serverSha256: write.sha256 };
  });

const planTargetLowering = (options: {
  readonly targetId: HarnessId;
  readonly lowerer: LowererModule;
  readonly surfaces: TargetSurfaceSelection;
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly artifacts: TargetArtifacts;
  readonly registry: PluginRegistry;
  readonly scope: HarnessScope;
  readonly outputRoot: string;
  readonly prismHome: string;
  readonly mcpServer?: PreparedMcpServer;
}): Effect.Effect<LowerOutput, CompileError> => {
  if (
    !options.surfaces.hasLowerableArtifacts &&
    options.targetId !== "amp-code" &&
    options.targetId !== "factory-droid" &&
    options.targetId !== "pi" &&
    options.targetId !== "kimi-code" &&
    options.targetId !== "cursor"
  ) {
    return Effect.succeed({ files: [], regions: [] });
  }

  return Effect.promise(async () => {
    const lowered = await options.lowerer.planLowering({
      agents: options.agents,
      orbits: options.orbits,
      tools: options.artifacts.tools,
      skills: options.artifacts.skills,
      hooks: options.artifacts.hooks,
      registry: options.registry,
      target: {
        scope: options.scope,
        root: options.outputRoot,
        ...(options.mcpServer && targetHasGeneratedMcpConfig(options.targetId)
          ? {
              mcpExposureProfile: mcpExposureProfileForTarget(
                generatedMcpServerName(options.registry.pluginName),
                options.targetId,
              ),
            }
          : {}),
        prismHome: options.prismHome,
        sourcePluginName: options.registry.pluginName,
        sourcePluginVersion: options.registry.pluginVersion,
        sourcePluginPath: options.registry.pluginPath,
      },
    });

    // Lowerers that plan a bare `skills/<name>/SKILL.md` file (rather than
    // copying the skill's whole source tree) silently drop sibling reference
    // markdown — patch the plan here rather than in the lowerers themselves
    // (see src/compile/skill-reference-files.ts for why).
    const loweredFiles = await injectSkillReferenceFiles(lowered.files, options.artifacts.skills);

    // Package mode ships the bundle inside the package payload as a desired
    // file (live compiles write the canonical PRISM_HOME bundle instead).
    if (options.mcpServer?.packagedBundleContent !== undefined) {
      const serverName = generatedMcpServerName(options.registry.pluginName);
      return {
        files: [
          {
            targetPath: options.mcpServer.serverPath,
            content: options.mcpServer.packagedBundleContent,
            plugin: options.registry.pluginName,
          },
          ...(options.mcpServer.packagedStdioBundleContent !== undefined
            ? [{
                targetPath: joinPath(
                  options.outputRoot,
                  ...mcpServerStdioArtifactRelativePath(serverName).split("/"),
                ),
                content: options.mcpServer.packagedStdioBundleContent,
                plugin: options.registry.pluginName,
              }]
            : []),
          ...loweredFiles,
        ],
        regions: lowered.regions,
      };
    }
    return {
      files: loweredFiles,
      regions: lowered.regions,
    };
  });
};

const persistCompileOutputs = (options: {
  readonly pluginPath: string;
  readonly registry: PluginRegistry;
  readonly useCache: boolean;
  readonly cacheDir: string;
  readonly composed: ReadonlyArray<ComposedAgent>;
  readonly built: ReadonlyArray<string>;
  readonly cacheDescriptors: ReadonlyMap<string, AgentCacheDescriptor>;
  readonly lowered: LowerOutput;
}): Effect.Effect<string | null, CompileError> =>
  Effect.gen(function* () {
    if (!options.useCache) return null;

    const builtSet = new Set(options.built);

    for (const agent of options.composed) {
      if (!builtSet.has(agent.name)) continue;
      const descriptor = options.cacheDescriptors.get(agent.name);
      if (!descriptor) continue;

      yield* Effect.promise(() =>
        writeCacheEntry(options.cacheDir, {
          key: descriptor.key,
          sourceHash: descriptor.sourceHash,
          contextHash: descriptor.contextHash,
          composed: agent,
          outputs: collectCacheOutputs(agent.name, options.lowered),
          timestamp: new Date().toISOString(),
        })
      );
    }

    return yield* Effect.promise(() =>
      writeLockfile(options.pluginPath, options.registry)
    );
  });

const prepareLoweringInputs = (
  options: CompileOptions,
): Effect.Effect<{
  readonly context: CompileTargetContext;
  readonly registry: PluginRegistry;
  readonly surfaces: TargetSurfaceSelection;
  readonly agentResult: AgentCompositionResult;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly composedForLowering: ReadonlyArray<ComposedAgent>;
  readonly artifacts: TargetArtifacts;
  readonly mcpServer?: PreparedMcpServer;
}, CompileError> =>
  Effect.gen(function* () {
    const context = yield* resolveCompileTargetContext(options);
    const registry = yield* loadPlugin(options.pluginPath);
    const surfaces = selectTargetSurfaces(registry, context.targetId, options.scope);
    yield* assertTargetSupportsAgents(options.target, surfaces.agents);

    const agentResult = yield* composeTargetAgents({
      registry,
      target: options.target,
      scope: options.scope,
      cacheDir: context.cacheDir,
      useCache: context.useCache,
      targetsAgents: surfaces.agents,
    });
    const orbits = yield* prepareTargetOrbits(registry, surfaces.orbits);
    const composedForLowering = yield* applyOrbitGrantsAndAssertCapabilities({
      target: options.target,
      targetId: context.targetId,
      registry,
      composed: agentResult.composed,
      orbits,
    });
    const artifacts = selectTargetArtifacts(registry, surfaces, context.targetId);
    const { accepted, fidelity } = yield* planHooksForTarget(artifacts.hooks, context.targetId);

    for (const entry of fidelity) {
      if (entry.outcome !== "native") {
        const droppedPart = entry.droppedControls && entry.droppedControls.length > 0
          ? ` (dropped: ${entry.droppedControls.join(", ")})`
          : "";
        console.log(`hook ${entry.hook} -> ${entry.target}: ${entry.outcome}${droppedPart}`);
      }
    }

    const finalArtifacts = {
      ...artifacts,
      hooks: [...accepted],
    };

    // Build (and write) the canonical union bundle BEFORE any daemon
    // lifecycle interaction so `prism mcp serve` reads compiled bytes.
    const mcpServer = yield* prepareUnionMcpServer({
      compileOptions: options,
      context,
      registry,
      agents: composedForLowering,
      artifacts: finalArtifacts,
    });
    return {
      context,
      registry,
      surfaces,
      agentResult,
      orbits,
      composedForLowering,
      artifacts: finalArtifacts,
      ...(mcpServer ? { mcpServer } : {}),
    };
  });

export const planPluginForTarget = (
  options: CompileOptions,
): Effect.Effect<PlannedCompileResult, CompileError> =>
  Effect.gen(function* () {
    const {
      context,
      registry,
      surfaces,
      agentResult,
      orbits,
      composedForLowering,
      artifacts,
      mcpServer,
    } = yield* prepareLoweringInputs(options);
    const lowered = yield* planTargetLowering({
      targetId: context.targetId,
      lowerer: context.lowerer,
      surfaces,
      agents: composedForLowering,
      orbits,
      artifacts,
      registry,
      scope: options.scope,
      outputRoot: context.outputRoot,
      prismHome: context.prismHome,
      ...(mcpServer ? { mcpServer } : {}),
    });

    return {
      target: options.target,
      scope: options.scope,
      outputRoot: context.outputRoot,
      cacheDir: context.cacheDir,
      composed: composedForLowering,
      orbits,
      files: lowered.files,
      regions: lowered.regions,
      built: agentResult.built,
      fromCache: agentResult.fromCache,
      sourcePluginName: registry.pluginName,
      sourcePluginVersion: registry.pluginVersion,
    };
  });

export const compilePluginForTarget = (
  options: CompileOptions
): Effect.Effect<CompileResult, CompileError> =>
  Effect.gen(function* () {
    const {
      context,
      registry,
      surfaces,
      agentResult,
      orbits,
      composedForLowering,
      artifacts,
      mcpServer,
    } = yield* prepareLoweringInputs(options);
    const lowered = yield* planTargetLowering({
      targetId: context.targetId,
      lowerer: context.lowerer,
      surfaces,
      agents: composedForLowering,
      orbits,
      artifacts,
      registry,
      scope: options.scope,
      outputRoot: context.outputRoot,
      prismHome: context.prismHome,
      ...(mcpServer ? { mcpServer } : {}),
    });
    const report = yield* Effect.promise(() =>
      syncDesiredRoot({
        prismHome: context.prismHome,
        desired: {
          harness: context.targetId,
          root: context.outputRoot,
          files: lowered.files,
          regions: lowered.regions,
        },
        scopePlugins: new Set([registry.pluginName]),
        dryRun: options.dryRun || options.packageMode === true,
        ...(options.onOp ? { onOp: options.onOp } : {}),
      }),
    );
    const blocked = blockedTargetErrors(report);
    const manifestTarget = context.targetId;
    let workflowRefsReport: Awaited<ReturnType<typeof syncDesiredRoot>> | null = null;
    if (
      !options.dryRun &&
      options.packageMode !== true &&
      report.failures.length === 0 &&
      blocked.length === 0 &&
      isCompileManifestHarnessId(manifestTarget)
    ) {
      // Per-project manifest partition: the project key is derived from the
      // compiled project (git root of --project, else of cwd), hashed to a
      // filesystem-safe dir name. This fixes the clobbering bug where two
      // projects with a same-named local plugin stomped each other in the old
      // single flat global manifest.
      const projectKey = compileProjectKey(options.projectPath);
      yield* Effect.promise(() =>
        updateCompileManifestForTarget({
          prismHome: context.prismHome,
          projectKey,
          registry,
          target: manifestTarget,
          scope: options.scope,
          composed: composedForLowering,
          cacheDescriptors: agentResult.cacheDescriptors,
          ...(surfaces.orbits ? { orbits } : {}),
        }),
      );
      if (options.emitWorkflowRefs !== false) {
        workflowRefsReport = yield* Effect.promise(() =>
          syncWorkflowRefsForProject({
            prismHome: context.prismHome,
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
            ...(options.onOp ? { onOp: options.onOp } : {}),
          }),
        );
      }
    }
    const lockfilePath = yield* persistCompileOutputs({
      pluginPath: options.pluginPath,
      registry,
      useCache: context.useCache,
      cacheDir: context.cacheDir,
      composed: agentResult.composed,
      built: agentResult.built,
      cacheDescriptors: agentResult.cacheDescriptors,
      lowered,
    });
    const workflowRefsBlocked = workflowRefsReport
      ? blockedTargetErrors(workflowRefsReport)
      : [];

    return {
      target: options.target,
      scope: options.scope,
      outputRoot: context.outputRoot,
      cacheDir: context.cacheDir,
      lockfilePath,
      composed: composedForLowering,
      orbits,
      files: lowered.files,
      regions: lowered.regions,
      operations: [...report.ops, ...(workflowRefsReport?.ops ?? [])],
      failures: [...report.failures, ...(workflowRefsReport?.failures ?? [])],
      blocked: [...blocked, ...workflowRefsBlocked],
      backups: [...report.backups, ...(workflowRefsReport?.backups ?? [])],
      converged: report.converged && (workflowRefsReport?.converged ?? true),
      built: agentResult.built,
      fromCache: agentResult.fromCache,
    };
  });

const describeSyncOp = (op: SyncOp): string => {
  switch (op.kind) {
    case "create":
      return `create    ${op.targetPath} (${op.reason})`;
    case "repair":
      return `repair    ${op.targetPath} (${op.reason})`;
    case "skip":
      return `skip      ${op.targetPath}`;
    case "chmod":
      return `chmod     ${op.targetPath} (${op.mode.toString(8)})`;
    case "patch-regions":
      return `patch     ${op.targetPath} [${[...op.changedRegions, ...op.removedRegions.map((key) => `-${key}`)].join(", ")}]`;
    case "skip-regions":
      return `skip      ${op.targetPath} [${op.regionKeys.join(", ")}]`;
    case "prune":
      return `prune     ${op.targetPath} (${op.reason})`;
    case "blocked":
      return `blocked   ${op.targetPath} — ${op.hint}`;
  }
};

export const formatOperations = (
  operations: ReadonlyArray<SyncOp>
): string => operations.map(describeSyncOp).join("\n");
