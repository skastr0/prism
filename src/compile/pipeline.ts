/**
 * Compile pipeline orchestration.
 *
 * Flow: Load (+deps) → Resolve → Compose → Validate orbits → Instantiate
 * concrete orbit skills → Lower → Emit.
 */

import { Effect } from "effect";
import { basename, dirname } from "node:path";
import { getHarness, harnessSupportsProjectScope, resolveHarnessRoot } from "../harnesses.js";
import { expandPath } from "../fs.js";
import type { HarnessId, HarnessScope, PluginTargetId } from "../types.js";
import { loadPlugin } from "./load.js";
import {
  instantiateOrbit,
  resolveAgent,
  resolveOrbitSkillPermissions,
  resolveOrbitToolPermissions,
  validateOrbit,
} from "./resolve.js";
import { composeAgent, type ComposedAgent } from "./compose.js";
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
import type { LowerOutput } from "./lowerers/shared.js";
import type { DesiredFile, DesiredRegion, DesiredRoot } from "../sync/desired.js";
import type { SyncOp } from "../sync/plan.js";
import type { SyncOpFailure } from "../sync/apply.js";
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
import { getCompileTargetCapabilities } from "./target-capabilities.js";
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
import { getMcpStatus, serveMcp } from "../mcp/lifecycle.js";
import { sha256Hex } from "../mcp/runtime-metadata.js";
import {
  generatedMcpServerName,
  isStreamableHttpMcpRuntime,
  mcpRuntimeUsesBearerTokenEnvConfig,
  resolveMcpRuntime,
} from "./mcp-runtime.js";
import {
  prismMcpServerPath,
  writePrismMcpServerBundle,
} from "./mcp-runtime-path.js";
import {
  generateMcpServerBundle,
  mcpServerArtifactRelativePath,
} from "./mcp-bundle.js";
import { join as joinPath } from "node:path";
import type { ResolvedContractBinding } from "./resolve.js";
import { mcpBindingsForAgentsAndTools } from "./tool-bindings.js";
import {
  ensureMcpToken,
  normalizePreferredMcpBearerToken,
  readMcpToken,
} from "../mcp/token-store.js";
import { getFreePort } from "../mcp/ports.js";

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
      readonly mcpServerPath?: string;
      readonly mcpBearerToken?: string;
      readonly mcpRuntimePort?: number;
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

const assertTargetSupportsHooks = (
  target: string,
  hasTargetedHooks: boolean,
): Effect.Effect<void, CompileError> => {
  const capabilities = getCompileTargetCapabilities(target);
  if (!hasTargetedHooks || capabilities.hooks === "supported") {
    return Effect.void;
  }

  return Effect.fail(
    new UnsupportedTargetCapabilityError({
      target,
      capability: "hooks",
      message:
        `${target} does not support Prism hook lowering. ` +
        `Use a native ${target} plugin for hook callbacks or choose a compile target with hook support.`,
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

    const outputRoot = resolveHarnessRoot(
      harness,
      options.scope,
      options.projectPath
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

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:=@+-]+$/u.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;

const renderMcpServeCommand = (options: {
  readonly pluginPath: string;
  readonly targetId: HarnessId;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly registry: PluginRegistry;
}): string => {
  const configured = resolveMcpRuntime(options.registry, options.targetId);
  return [
    "prism",
    "mcp",
    "serve",
    shellQuote(options.pluginPath),
    "--harness",
    options.targetId,
    "--scope",
    options.scope,
    ...(options.projectPath ? ["--project", shellQuote(options.projectPath)] : []),
    ...(configured?.port ? ["--port", String(configured.port)] : []),
    ...(configured?.tokenEnv ? ["--token-env", shellQuote(configured.tokenEnv)] : []),
  ].join(" ");
};

const mcpBindingsForTarget = (options: {
  readonly registry: PluginRegistry;
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly artifacts: TargetArtifacts;
}): ReturnType<typeof mcpBindingsForAgentsAndTools> =>
  mcpBindingsForAgentsAndTools(
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

const resolveCompileMcpRuntimePort = (options: {
  readonly compileOptions: CompileOptions;
  readonly registry: PluginRegistry;
  readonly targetId: HarnessId;
  readonly prismHome: string;
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly artifacts: TargetArtifacts;
}): Effect.Effect<number | undefined, CompileError> => {
  const bindings = mcpBindingsForTarget({
    registry: options.registry,
    agents: options.agents,
    artifacts: options.artifacts,
  });
  const runtime = resolveMcpRuntime(options.registry, options.targetId);
  if (runtime.transport !== "streamable-http" || bindings.length === 0) {
    return Effect.succeed(undefined);
  }
  if (runtime.port !== undefined) {
    return Effect.succeed(undefined);
  }

  const mode = options.compileOptions.mcpLifecycle ?? "serve";
  const serveCommand = renderMcpServeCommand({
    pluginPath: options.compileOptions.pluginPath,
    targetId: options.targetId,
    scope: options.compileOptions.scope,
    projectPath: options.compileOptions.projectPath,
    registry: options.registry,
  });

  return Effect.tryPromise({
    try: async () => {
      if (options.compileOptions.dryRun) {
        return getFreePort(runtime.host);
      }

      if (mode === "serve") {
        const served = await serveMcp({
          pluginPath: options.compileOptions.pluginPath,
          harness: options.targetId,
          scope: options.compileOptions.scope,
          projectPath: options.compileOptions.projectPath,
          prismHome: options.prismHome,
        });
        const port = portFromMcpMetadata(served.metadata);
        if (port !== undefined) return port;
        throw new Error(
          `${options.targetId} Streamable HTTP MCP daemon started without recording a runtime port.`,
        );
      }

      const status = await getMcpStatus({
        pluginPath: options.compileOptions.pluginPath,
        harness: options.targetId,
        scope: options.compileOptions.scope,
        projectPath: options.compileOptions.projectPath,
        prismHome: options.prismHome,
      });
      const port = status.state === "running" ? portFromMcpMetadata(status.metadata) : undefined;
      if (port !== undefined) return port;

      throw new Error(
        `${options.targetId} Streamable HTTP MCP runtime has no configured port and no running metadata; ` +
          `refusing to write url config that may point to nothing. ` +
          `Run: ${serveCommand}` +
          (mode === "none" ? `\nOr rerun compile/install with --mcp-lifecycle serve.` : ""),
      );
    },
    catch: (error) =>
      PluginManifestError.forPlugin(options.compileOptions.pluginPath, error instanceof Error ? error.message : String(error)),
  });
};

const assertHttpMcpLifecycleGate = (options: {
  readonly compileOptions: CompileOptions;
  readonly registry: PluginRegistry;
  readonly targetId: HarnessId;
  readonly outputRoot: string;
  readonly prismHome: string;
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly artifacts: TargetArtifacts;
  readonly expectedServerSha256?: string;
}): Effect.Effect<void, CompileError> => {
  const bindings = mcpBindingsForTarget({
    registry: options.registry,
    agents: options.agents,
    artifacts: options.artifacts,
  });
  if (
    options.compileOptions.dryRun ||
    !isStreamableHttpMcpRuntime(options.registry, options.targetId) ||
    bindings.length === 0
  ) {
    return Effect.void;
  }

  const mode = options.compileOptions.mcpLifecycle ?? "serve";
  const serveCommand = renderMcpServeCommand({
    pluginPath: options.compileOptions.pluginPath,
    targetId: options.targetId,
    scope: options.compileOptions.scope,
    projectPath: options.compileOptions.projectPath,
    registry: options.registry,
  });
  const expectedServerSha256 = options.expectedServerSha256;

  return Effect.tryPromise({
    try: async () => {
      if (mode === "serve") {
        await serveMcp({
          pluginPath: options.compileOptions.pluginPath,
          harness: options.targetId,
          scope: options.compileOptions.scope,
          projectPath: options.compileOptions.projectPath,
          prismHome: options.prismHome,
        });
      }

      const status = await getMcpStatus({
        pluginPath: options.compileOptions.pluginPath,
        harness: options.targetId,
        scope: options.compileOptions.scope,
        projectPath: options.compileOptions.projectPath,
        prismHome: options.prismHome,
        expectedServerSha256,
      });
      if (status.state === "running") return;

      throw new Error(
        `${options.targetId} Streamable HTTP MCP daemon '${status.descriptor.serverName}' is ${status.state}; ` +
          `refusing to write url config that may point to nothing. ` +
          `Run: ${serveCommand}` +
          (mode === "none" ? `\nOr rerun compile/install with --mcp-lifecycle serve.` : ""),
      );
    },
    catch: (error) =>
      PluginManifestError.forPlugin(options.compileOptions.pluginPath, error instanceof Error ? error.message : String(error)),
  });
};

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

const resolveCompileMcpBearerToken = (options: {
  readonly registry: PluginRegistry;
  readonly targetId: HarnessId;
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly artifacts: TargetArtifacts;
  readonly prismHome: string;
  readonly dryRun: boolean;
}): Effect.Effect<string | undefined, CompileError> => {
  const bindings = mcpBindingsForAgentsAndTools(
    options.registry.pluginName,
    options.artifacts.tools,
    options.agents,
  );
  if (
    options.dryRun ||
    !isStreamableHttpMcpRuntime(options.registry, options.targetId) ||
    bindings.length === 0
  ) {
    return Effect.succeed(undefined);
  }

  return Effect.tryPromise({
    try: async () => {
      const runtime = resolveMcpRuntime(options.registry, options.targetId);
      const preferredToken = process.env[runtime.tokenEnv];
      if (mcpRuntimeUsesBearerTokenEnvConfig(options.targetId)) {
        const envToken = normalizePreferredMcpBearerToken({
          preferredToken,
          preferredTokenEnv: runtime.tokenEnv,
        });
        if (!envToken) {
          throw new Error(
            `MCP token env '${runtime.tokenEnv}' must be set to a usable bearer token before compiling '${options.targetId}' Streamable HTTP config.`,
          );
        }

        const serverName = generatedMcpServerName(options.registry.pluginName);
        const existing = await readMcpToken(options.prismHome, serverName);
        const usableExisting = normalizePreferredMcpBearerToken({
          preferredToken: existing,
          preferredTokenEnv: runtime.tokenEnv,
        });
        if (usableExisting && usableExisting !== envToken) {
          throw new Error(
            `Stored MCP token for '${serverName}' differs from env '${runtime.tokenEnv}'. Run 'prism mcp rotate-token ${options.registry.pluginPath} --harness ${options.targetId} --token-env ${runtime.tokenEnv}' to rotate explicitly.`,
          );
        }

        return ensureMcpToken(options.prismHome, serverName, {
          preferredToken: envToken,
          preferredTokenEnv: runtime.tokenEnv,
        });
      }
      return ensureMcpToken(
        options.prismHome,
        generatedMcpServerName(options.registry.pluginName),
        {
          ...(preferredToken ? { preferredToken } : {}),
          preferredTokenEnv: runtime.tokenEnv,
        },
      );
    },
    catch: (error) =>
      PluginManifestError.forPlugin(options.registry.pluginPath, error instanceof Error ? error.message : String(error)),
  });
};

// ---------------------------------------------------------------------------
// Union MCP bundle (overhaul WS3): ONE bundle per plugin, merging the canonical
// tool bindings of every harness the plugin targets. Per-harness exposure
// stays client-side (enabled_tools / tools.include / enabledTools /
// PRISM_MCP_ENABLED_TOOLS) in the lowered configs.
// ---------------------------------------------------------------------------

const MCP_UNION_NOUNS = ["tools", "agents", "orbits"] as const;

const unionMcpTargetHarnesses = (registry: PluginRegistry): HarnessId[] => {
  const harnesses = new Set<HarnessId>();
  for (const noun of MCP_UNION_NOUNS) {
    for (const target of resolveManifestTargetsForSourceNoun(
      (registry.targets[noun] ?? []) as readonly PluginTargetId[],
      noun,
    )) {
      harnesses.add(target);
    }
  }
  return [...harnesses].sort((left, right) => left.localeCompare(right));
};

const resolveUnionMcpBindings = (
  registry: PluginRegistry,
  scope: HarnessScope,
): Effect.Effect<ReadonlyArray<ResolvedContractBinding>, CompileError> =>
  Effect.gen(function* () {
    const bindings: ResolvedContractBinding[] = [];
    for (const harness of unionMcpTargetHarnesses(registry)) {
      const surfaces = selectTargetSurfaces(registry, harness, scope);
      const tools = surfaces.tools
        ? [...registry.tools.values()].sort((left, right) => left.name.localeCompare(right.name))
        : [];
      const agents: ComposedAgent[] = [];
      if (surfaces.agents) {
        for (const [, agent] of [...registry.agents.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          agents.push(composeAgent(yield* resolveAgent(agent, registry, harness)));
        }
      }
      const orbits = yield* prepareTargetOrbits(registry, surfaces.orbits);
      const orbitToolPermissions = yield* resolveOrbitToolPermissions(orbits, registry);
      const agentsWithOrbitTools = applyOrbitToolPermissions(agents, orbitToolPermissions);
      bindings.push(
        ...mcpBindingsForAgentsAndTools(registry.pluginName, tools, agentsWithOrbitTools),
      );
    }
    return bindings;
  });

interface PreparedMcpServer {
  /** Absolute path harness configs reference (canonical PRISM_HOME path). */
  readonly serverPath: string;
  readonly serverSha256: string;
  /** Package mode only: bundle bytes emitted as a plan operation instead. */
  readonly packagedBundleContent?: string;
}

const prepareUnionMcpServer = (options: {
  readonly compileOptions: CompileOptions;
  readonly context: CompileTargetContext;
  readonly registry: PluginRegistry;
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly artifacts: TargetArtifacts;
}): Effect.Effect<PreparedMcpServer | undefined, CompileError> =>
  Effect.gen(function* () {
    const targetBindings = mcpBindingsForAgentsAndTools(
      options.registry.pluginName,
      options.artifacts.tools,
      options.agents,
    );
    if (targetBindings.length === 0) return undefined;

    const unionBindings = yield* resolveUnionMcpBindings(
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
        bindings: unionBindings,
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
  readonly mcpServer?: PreparedMcpServer;
  readonly mcpBearerToken?: string;
  readonly mcpRuntimePort?: number;
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
        ...(options.mcpServer ? { mcpServerPath: options.mcpServer.serverPath } : {}),
        ...(options.mcpBearerToken ? { mcpBearerToken: options.mcpBearerToken } : {}),
        ...(options.mcpRuntimePort ? { mcpRuntimePort: options.mcpRuntimePort } : {}),
        sourcePluginName: options.registry.pluginName,
        sourcePluginVersion: options.registry.pluginVersion,
        sourcePluginPath: options.registry.pluginPath,
      },
    });

    // Package mode ships the bundle inside the package payload as a desired
    // file (live compiles write the canonical PRISM_HOME bundle instead).
    if (options.mcpServer?.packagedBundleContent !== undefined) {
      return {
        files: [
          {
            targetPath: options.mcpServer.serverPath,
            content: options.mcpServer.packagedBundleContent,
            plugin: options.registry.pluginName,
          },
          ...lowered.files,
        ],
        regions: lowered.regions,
      };
    }
    return lowered;
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
  readonly mcpRuntimePort?: number;
  readonly mcpBearerToken?: string;
}, CompileError> =>
  Effect.gen(function* () {
    const context = yield* resolveCompileTargetContext(options);
    const loadedRegistry = yield* loadPlugin(options.pluginPath);
    // Config repos must stay durable: no per-run HTTP ports or bearer tokens
    // are serialized into tracked Codex/Claude config. Use stdio against the
    // canonical PRISM_HOME bundle for those targets.
    const configRepoStdioTarget =
      context.targetId === "codex-cli" || context.targetId === "claude-code";
    const registry = options.packageMode === true || configRepoStdioTarget
      ? registryWithStdioMcpRuntime(loadedRegistry)
      : loadedRegistry;
    const surfaces = selectTargetSurfaces(registry, context.targetId, options.scope);
    yield* assertTargetSupportsAgents(options.target, surfaces.agents);
    yield* assertTargetSupportsHooks(options.target, surfaces.hooks);

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
    // Build (and write) the canonical union bundle BEFORE any daemon
    // lifecycle interaction so `prism mcp serve` reads compiled bytes.
    const mcpServer = yield* prepareUnionMcpServer({
      compileOptions: options,
      context,
      registry,
      agents: composedForLowering,
      artifacts,
    });
    const mcpRuntimePort = yield* resolveCompileMcpRuntimePort({
      compileOptions: options,
      registry,
      targetId: context.targetId,
      prismHome: context.prismHome,
      agents: composedForLowering,
      artifacts,
    });
    const mcpBearerToken = yield* resolveCompileMcpBearerToken({
      registry,
      targetId: context.targetId,
      agents: composedForLowering,
      artifacts,
      prismHome: context.prismHome,
      dryRun: options.dryRun,
    });

    return {
      context,
      registry,
      surfaces,
      agentResult,
      orbits,
      composedForLowering,
      artifacts,
      ...(mcpServer ? { mcpServer } : {}),
      ...(mcpRuntimePort ? { mcpRuntimePort } : {}),
      ...(mcpBearerToken ? { mcpBearerToken } : {}),
    };
  });

const registryWithStdioMcpRuntime = (registry: PluginRegistry): PluginRegistry => ({
  ...registry,
  runtime: {
    ...registry.runtime,
    mcp: Object.fromEntries(
      Object.entries(registry.runtime.mcp ?? {}).map(([target, config]) => [
        target,
        { ...config, transport: "stdio" as const },
      ]),
    ),
  },
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
      mcpRuntimePort,
      mcpBearerToken,
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
      ...(mcpServer ? { mcpServer } : {}),
      ...(mcpBearerToken ? { mcpBearerToken } : {}),
      ...(mcpRuntimePort ? { mcpRuntimePort } : {}),
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
      mcpRuntimePort,
      mcpBearerToken,
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
      ...(mcpServer ? { mcpServer } : {}),
      ...(mcpBearerToken ? { mcpBearerToken } : {}),
      ...(mcpRuntimePort ? { mcpRuntimePort } : {}),
    });
    yield* assertHttpMcpLifecycleGate({
      compileOptions: options,
      registry,
      targetId: context.targetId,
      outputRoot: context.outputRoot,
      prismHome: context.prismHome,
      agents: composedForLowering,
      artifacts,
      ...(mcpServer ? { expectedServerSha256: mcpServer.serverSha256 } : {}),
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
      }),
    );
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
      operations: report.ops,
      failures: report.failures,
      blocked: blockedTargetErrors(report),
      backups: report.backups,
      converged: report.converged,
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
