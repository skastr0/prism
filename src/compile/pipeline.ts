/**
 * Compile pipeline orchestration.
 *
 * Flow: Load (+deps) → Resolve → Compose → Validate lifecycles → Instantiate
 * concrete lifecycle skills → Lower → Emit.
 */

import { Effect } from "effect";
import { basename, dirname } from "node:path";
import { getHarness, harnessSupportsProjectScope, resolveHarnessRoot } from "../harnesses.js";
import type { HarnessId, HarnessScope } from "../types.js";
import { loadPlugin } from "./load.js";
import {
  instantiateLifecycle,
  resolveAgent,
  resolveLifecycleToolGrants,
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
  InvalidTargetScopeError,
  UnknownTargetError,
  type CompileError,
} from "./errors.js";
import type { Lifecycle } from "./sources.js";
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
    readonly target: {
      readonly scope: HarnessScope;
      readonly root: string;
      readonly sourcePluginName: string;
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

const SUPPORTED_TARGETS = ["opencode", "claude-code"] as const;

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

const applyLifecycleToolGrants = (
  agents: ReadonlyArray<ComposedAgent>,
  grants: ReadonlyMap<string, ReadonlyArray<ComposedAgent["toolBindings"][number]>>,
): ComposedAgent[] =>
  agents.map((agent) => {
    const granted = grants.get(agent.name) ?? [];
    if (granted.length === 0) return agent;

    const existing = new Set(agent.toolBindings.map((binding) => binding.logicalName));
    const merged = [...agent.toolBindings];
    for (const binding of granted) {
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

    const composed: ComposedAgent[] = [];
    const built: string[] = [];
    const fromCache: string[] = [];
    const cacheDescriptors = new Map<string, AgentCacheDescriptor>();

    for (const [, agent] of [...registry.agents.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
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
      yield* validateLifecycle(lifecycle, registry);
      if (lifecycle.parameters.length > 0) continue;
      lifecycles.push(yield* instantiateLifecycle(lifecycle));
    }

    const lifecycleToolGrants = yield* resolveLifecycleToolGrants(lifecycles, registry);
    const composedForLowering = applyLifecycleToolGrants(composed, lifecycleToolGrants);

    const allOps = yield* Effect.promise(() =>
      lowerer.planLowering({
        agents: composedForLowering,
        lifecycles,
        target: {
          scope: options.scope,
          root: outputRoot,
          sourcePluginName: registry.pluginName,
        },
      })
    );

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
