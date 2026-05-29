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
  executeLowering as executeAmpCodeLowering,
  planLowering as planAmpCodeLowering,
} from "./lowerers/amp-code.js";
import {
  executeLowering as executeHermesLowering,
  planLowering as planHermesLowering,
} from "./lowerers/hermes.js";
import {
  executeLowering as executeGrokLowering,
  planLowering as planGrokLowering,
} from "./lowerers/grok.js";
import type { ExecuteLoweringOptions } from "./lowerers/shared.js";
import {
  InvalidTargetScopeError,
  UnsupportedTargetCapabilityError,
  UnknownTargetError,
  AgentValidationError,
  PluginManifestError,
  type CompileError,
} from "./errors.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "./sources.js";
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
import { getMcpStatus, serveMcp } from "../mcp/lifecycle.js";
import { sha256Hex } from "../mcp/runtime-metadata.js";
import {
  defaultMcpRuntimeRoot,
  generatedMcpServerName,
  isStreamableHttpMcpRuntime,
  resolveMcpRuntime,
} from "./mcp-runtime.js";
import { ensureMcpToken } from "../mcp/token-store.js";

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
      readonly mcpRuntimeRoot?: string;
      readonly mcpBearerToken?: string;
      readonly sourcePluginName: string;
      readonly sourcePluginVersion?: string;
      readonly sourcePluginPath?: string;
    };
  }) => Promise<LowerOperation[]>;
  readonly executeLowering: (
    operations: LowerOperation[],
    options: ExecuteLoweringOptions,
  ) => Promise<{ backups: string[] }>;
}

interface CompileTargetContext {
  readonly targetId: HarnessId;
  readonly lowerer: LowererModule;
  readonly outputRoot: string;
  readonly mcpRuntimeRoot: string;
  readonly cacheDir: string;
  readonly useCache: boolean;
}

interface TargetSurfaceSelection {
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
  readonly mcpRoot?: string;
  readonly dryRun: boolean;
  readonly mcpLifecycle?: CompileMcpLifecycleMode;
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
  readonly operations: ReadonlyArray<LowerOperation>;
  readonly backups: ReadonlyArray<string>;
  readonly built: ReadonlyArray<string>;
  readonly fromCache: ReadonlyArray<string>;
}

const SUPPORTED_TARGETS = [
  "opencode",
  "claude-code",
  "gemini-cli",
  "codex-cli",
  "amp-code",
  "hermes",
  "grok",
] as const;

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
    case "amp-code":
      return {
        planLowering: planAmpCodeLowering,
        executeLowering: executeAmpCodeLowering,
      };
    case "hermes":
      return {
        planLowering: planHermesLowering,
        executeLowering: executeHermesLowering,
      };
    case "grok":
      return {
        planLowering: planGrokLowering,
        executeLowering: executeGrokLowering,
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
      const root = expandPath(options.root);
      const mcpRuntimeRoot = options.mcpRoot ? expandPath(options.mcpRoot) : root;
      return {
        targetId: options.target as HarnessId,
        lowerer,
        outputRoot: root,
        mcpRuntimeRoot,
        cacheDir: getCacheDir(options.pluginPath),
        useCache: !options.dryRun,
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
      mcpRuntimeRoot: options.mcpRoot ? expandPath(options.mcpRoot) : defaultMcpRuntimeRoot(),
      cacheDir: getCacheDir(options.pluginPath),
      useCache: !options.dryRun,
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
  readonly root?: string;
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
    ...(options.root ? ["--root", shellQuote(options.root)] : []),
    ...(configured?.port ? ["--port", String(configured.port)] : []),
    ...(configured?.tokenEnv ? ["--token-env", shellQuote(configured.tokenEnv)] : []),
  ].join(" ");
};

const findMcpServerSha256 = (
  operations: ReadonlyArray<LowerOperation>,
): string | undefined => {
  const serverWrite = operations.find((operation) =>
    operation.kind === "write-plugin-file" &&
    /[/\\]prism[/\\]mcp[/\\][^/\\]+[/\\]server\.mjs$/u.test(operation.target)
  );
  return serverWrite?.kind === "write-plugin-file" ? sha256Hex(serverWrite.content) : undefined;
};

const assertHttpMcpLifecycleGate = (options: {
  readonly compileOptions: CompileOptions;
  readonly registry: PluginRegistry;
  readonly targetId: HarnessId;
  readonly outputRoot: string;
  readonly mcpRuntimeRoot: string;
  readonly artifacts: TargetArtifacts;
  readonly operations: ReadonlyArray<LowerOperation>;
}): Effect.Effect<void, CompileError> => {
  if (
    options.compileOptions.dryRun ||
    !isStreamableHttpMcpRuntime(options.registry, options.targetId) ||
    options.artifacts.tools.length === 0
  ) {
    return Effect.void;
  }

  const mode = options.compileOptions.mcpLifecycle ?? "serve";
  const serveCommand = renderMcpServeCommand({
    pluginPath: options.compileOptions.pluginPath,
    targetId: options.targetId,
    scope: options.compileOptions.scope,
    projectPath: options.compileOptions.projectPath,
    root: options.mcpRuntimeRoot,
    registry: options.registry,
  });
  const expectedServerSha256 = findMcpServerSha256(options.operations);

  return Effect.tryPromise({
    try: async () => {
      if (mode === "serve") {
        await serveMcp({
          pluginPath: options.compileOptions.pluginPath,
          harness: options.targetId,
          scope: options.compileOptions.scope,
          projectPath: options.compileOptions.projectPath,
          root: options.mcpRuntimeRoot,
        });
      }

      const status = await getMcpStatus({
        pluginPath: options.compileOptions.pluginPath,
        harness: options.targetId,
        scope: options.compileOptions.scope,
        projectPath: options.compileOptions.projectPath,
        root: options.mcpRuntimeRoot,
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
      new PluginManifestError({
        pluginPath: options.compileOptions.pluginPath,
        message: error instanceof Error ? error.message : String(error),
      }),
  });
};

const selectTargetSurfaces = (
  registry: PluginRegistry,
  targetId: HarnessId,
): TargetSurfaceSelection => {
  const agents = registryTargetsHarness(registry, "agents", targetId);
  const orbits = registryTargetsHarness(registry, "orbits", targetId);
  const tools = registryTargetsHarness(registry, "tools", targetId);
  const skills = registryTargetsHarness(registry, "skills", targetId);
  const hooks = registryTargetsHarness(registry, "hooks", targetId);
  const rules = registryTargetsHarness(registry, "rules", targetId);
  const commands = registryTargetsHarness(registry, "commands", targetId);

  return {
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
): TargetArtifacts => ({
  tools: surfaces.tools
    ? [...registry.tools.values()].sort((left, right) => left.name.localeCompare(right.name))
    : [],
  skills: surfaces.skills
    ? [...registry.skills.values()].sort((left, right) => left.name.localeCompare(right.name))
    : [],
  hooks: surfaces.hooks
    ? [...registry.hooks.values()].sort((left, right) => left.name.localeCompare(right.name))
    : [],
});

const resolveCompileMcpBearerToken = (options: {
  readonly registry: PluginRegistry;
  readonly targetId: HarnessId;
  readonly runtimeRoot: string;
  readonly dryRun: boolean;
}): Effect.Effect<string | undefined, CompileError> => {
  if (
    options.dryRun ||
    !isStreamableHttpMcpRuntime(options.registry, options.targetId) ||
    options.registry.tools.size === 0
  ) {
    return Effect.succeed(undefined);
  }

  return Effect.tryPromise({
    try: async () => {
      const runtime = resolveMcpRuntime(options.registry, options.targetId);
      const preferredToken = process.env[runtime.tokenEnv];
      return ensureMcpToken(
        options.runtimeRoot,
        generatedMcpServerName(options.registry.pluginName),
        {
          ...(preferredToken ? { preferredToken } : {}),
          preferredTokenEnv: runtime.tokenEnv,
        },
      );
    },
    catch: (error) =>
      new PluginManifestError({
        pluginPath: options.registry.pluginPath,
        message: error instanceof Error ? error.message : String(error),
      }),
  });
};

const planTargetLowering = (options: {
  readonly lowerer: LowererModule;
  readonly surfaces: TargetSurfaceSelection;
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly artifacts: TargetArtifacts;
  readonly registry: PluginRegistry;
  readonly scope: HarnessScope;
  readonly outputRoot: string;
  readonly mcpRuntimeRoot: string;
  readonly mcpBearerToken?: string;
}): Effect.Effect<LowerOperation[], CompileError> => {
  if (!options.surfaces.hasLowerableArtifacts) {
    return Effect.succeed([]);
  }

  return Effect.promise(() =>
    options.lowerer.planLowering({
      agents: options.agents,
      orbits: options.orbits,
      tools: options.artifacts.tools,
      skills: options.artifacts.skills,
      hooks: options.artifacts.hooks,
      registry: options.registry,
      target: {
        scope: options.scope,
        root: options.outputRoot,
        mcpRuntimeRoot: options.mcpRuntimeRoot,
        ...(options.mcpBearerToken ? { mcpBearerToken: options.mcpBearerToken } : {}),
        sourcePluginName: options.registry.pluginName,
        sourcePluginVersion: options.registry.pluginVersion,
        sourcePluginPath: options.registry.pluginPath,
      },
    })
  );
};

const executeTargetLowering = (
  lowerer: LowererModule,
  operations: ReadonlyArray<LowerOperation>,
  options: Pick<CompileOptions, "dryRun" | "scope"> & {
    readonly context: CompileTargetContext;
    readonly registry: PluginRegistry;
  },
): Effect.Effect<string[], CompileError> => {
  if (options.dryRun) return Effect.succeed([]);

  return Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      lowerer.executeLowering([...operations], {
        dryRun: false,
        target: {
          harness: options.context.targetId,
          scope: options.scope,
          root: options.context.outputRoot,
          sourcePluginName: options.registry.pluginName,
          sourcePluginVersion: options.registry.pluginVersion,
          sourcePluginPath: options.registry.pluginPath,
        },
      })
    );
    return result.backups;
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
  readonly operations: ReadonlyArray<LowerOperation>;
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
          outputs: collectCacheOutputs(agent.name, options.operations),
          timestamp: new Date().toISOString(),
        })
      );
    }

    return yield* Effect.promise(() =>
      writeLockfile(options.pluginPath, options.registry)
    );
  });

export const compilePluginForTarget = (
  options: CompileOptions
): Effect.Effect<CompileResult, CompileError> =>
  Effect.gen(function* () {
    const context = yield* resolveCompileTargetContext(options);
    const registry = yield* loadPlugin(options.pluginPath);
    const surfaces = selectTargetSurfaces(registry, context.targetId);
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
    const artifacts = selectTargetArtifacts(registry, surfaces);
    const mcpBearerToken = yield* resolveCompileMcpBearerToken({
      registry,
      targetId: context.targetId,
      runtimeRoot: context.mcpRuntimeRoot,
      dryRun: options.dryRun,
    });
    const allOps = yield* planTargetLowering({
      lowerer: context.lowerer,
      surfaces,
      agents: composedForLowering,
      orbits,
      artifacts,
      registry,
      scope: options.scope,
      outputRoot: context.outputRoot,
      mcpRuntimeRoot: context.mcpRuntimeRoot,
      ...(mcpBearerToken ? { mcpBearerToken } : {}),
    });
    yield* assertHttpMcpLifecycleGate({
      compileOptions: options,
      registry,
      targetId: context.targetId,
      outputRoot: context.outputRoot,
      mcpRuntimeRoot: context.mcpRuntimeRoot,
      artifacts,
      operations: allOps,
    });
    const backups = yield* executeTargetLowering(context.lowerer, allOps, {
      dryRun: options.dryRun,
      scope: options.scope,
      context,
      registry,
    });
    const lockfilePath = yield* persistCompileOutputs({
      pluginPath: options.pluginPath,
      registry,
      useCache: context.useCache,
      cacheDir: context.cacheDir,
      composed: agentResult.composed,
      built: agentResult.built,
      cacheDescriptors: agentResult.cacheDescriptors,
      operations: allOps,
    });

    return {
      target: options.target,
      scope: options.scope,
      outputRoot: context.outputRoot,
      cacheDir: context.cacheDir,
      lockfilePath,
      composed: composedForLowering,
      orbits,
      operations: allOps,
      backups,
      built: agentResult.built,
      fromCache: agentResult.fromCache,
    };
  });

export const formatOperations = (
  operations: ReadonlyArray<LowerOperation>
): string => operations.map(describeOperation).join("\n");
