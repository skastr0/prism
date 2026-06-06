/**
 * Grok plugin-bundle lowerer.
 *
 * Produces one compiler-owned Grok plugin bundle under
 * <grok-root>/plugins/prism-generated-<source-plugin>/.
 */

import { join } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { resolveHookMatchForTarget } from "../hooks.js";
import {
  generateMcpServerBundle,
  mcpToolNameForBinding,
} from "../mcp-bundle.js";
import { mcpServerBundleRuntimeOptions, resolveMcpRuntime } from "../mcp-runtime.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  collectBindingNameMap,
  mcpBindingsForAgentsAndTools,
} from "../tool-bindings.js";
import type { HarnessScope } from "../../types.js";
import type { LowerOperation } from "./opencode.js";
import {
  bundleGeneratedHookWrapper,
  createGeneratedPluginWritePusher,
  createGeneratedPluginPlanState,
  executeStandardLowering,
  matcherForResolvedToolHook,
  normalizeBundleSegment,
  planGeneratedPluginAgentWrites,
  planGeneratedPluginHookWrites,
  planGeneratedPluginManifest,
  planGeneratedPluginPruning,
  planGeneratedPluginSkillWrites,
  planStandardGeneratedPluginOrbitSkillWrites,
  prePostSessionNativeHookEvent,
  renderPrePostSessionHookWrapperEntry,
  stringArray,
  uniqueSorted,
  yamlScalar,
} from "./shared.js";

const TARGET_ID = "grok" as const;
const GENERATED_PLUGIN_PREFIX = "prism-generated";

export interface GrokLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
  readonly sourcePluginPath?: string;
}

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly tools?: ReadonlyArray<CanonicalTool>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: GrokLowerTarget;
}

const generatedPluginId = (target: GrokLowerTarget): string =>
  `${GENERATED_PLUGIN_PREFIX}-${normalizeBundleSegment(target.sourcePluginName)}`;

const generatedPluginRoot = (target: GrokLowerTarget): string =>
  join(target.root, "plugins", generatedPluginId(target));

const generatedPath = (target: GrokLowerTarget, relativePath: string): string =>
  join(generatedPluginRoot(target), ...relativePath.split("/"));

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

const serializeFrontmatter = (values: Record<string, unknown>): string => {
  const lines = ["---"];
  const orderedKeys = [
    "name",
    "description",
    "model",
    "prompt_mode",
    "permission_mode",
    "agents_md",
    "effort",
    "reasoning_effort",
    "temperature",
    "top_p",
    "tools",
    "disallowedTools",
    "skills",
  ];

  for (const key of orderedKeys) {
    const value = values[key];
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(String(item))}`);
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }

  lines.push("---");
  return lines.join("\n");
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const firstDefined = <T>(...values: Array<T | undefined>): T | undefined =>
  values.find((value) => value !== undefined);

const grokOverrideForAgent = (agent: ComposedAgent): Record<string, unknown> | undefined =>
  agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;

const composeGrokTools = (
  agent: ComposedAgent,
  override: Record<string, unknown> | undefined,
): string[] =>
  uniqueSorted([
    ...stringArray(override?.tools),
    ...stringArray(override?.["allowed-tools"]),
    ...agent.allowedTools,
  ]);

const composeGrokDisallowedTools = (
  override: Record<string, unknown> | undefined,
): string[] => [
  ...stringArray(override?.disallowedTools),
  ...stringArray(override?.["disallowed-tools"]),
];

const composeGrokPermissionMode = (
  override: Record<string, unknown> | undefined,
): string | undefined =>
  firstDefined(
    stringValue(override?.permission_mode),
    stringValue(override?.permissionMode),
  );

const composeGrokEffort = (
  override: Record<string, unknown> | undefined,
  model: Record<string, unknown>,
): string | undefined =>
  firstDefined(
    stringValue(override?.effort),
    stringValue(model.effort),
    stringValue(model.variant),
  );

const composeAgentFrontmatter = (agent: ComposedAgent): Record<string, unknown> => {
  const override = grokOverrideForAgent(agent);
  const model = agent.model ?? {};

  return {
    name: agent.name,
    description: stringValue(override?.description) ?? agent.description,
    model: firstDefined(stringValue(override?.model), stringValue(model.model)),
    prompt_mode: stringValue(override?.prompt_mode),
    permission_mode: composeGrokPermissionMode(override),
    agents_md: booleanValue(override?.agents_md),
    effort: composeGrokEffort(override, model),
    reasoning_effort: stringValue(override?.reasoning_effort),
    temperature: firstDefined(numberValue(override?.temperature), numberValue(model.temperature)),
    top_p: firstDefined(numberValue(override?.top_p), numberValue(model.top_p)),
    tools: composeGrokTools(agent, override),
    disallowedTools: composeGrokDisallowedTools(override),
    skills: uniqueSorted(agent.allowedSkills),
  };
};

const renderAgentMarkdown = (
  agent: ComposedAgent,
): string => {
  return `${serializeFrontmatter(composeAgentFrontmatter(agent))}\n\n${agent.body}\n`;
};

const grokNativeHookEvent = prePostSessionNativeHookEvent;

const grokMcpToolNameForBinding = (
  sourcePluginName: string,
  pluginId: string,
  binding: ResolvedContractBinding,
): string => `${pluginId}__${mcpToolNameForBinding(sourcePluginName, binding)}`;

const renderHooksJson = async (
  hooks: ReadonlyArray<Hook>,
  registry: PluginRegistry | undefined,
  target: GrokLowerTarget,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): Promise<string> => {
  const groupedHooks: Record<string, unknown[]> = {};
  const pluginId = generatedPluginId(target);
  const canonicalToolNames = collectBindingNameMap(
    bindings,
    (binding) => grokMcpToolNameForBinding(target.sourcePluginName, pluginId, binding),
  );

  for (const hook of hooks) {
    const event = grokNativeHookEvent(hook.event);
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: "command",
          command: `node ${JSON.stringify(generatedPath(target, `hooks/${hook.name}.mjs`))}`,
        },
      ],
    };
    if (registry) {
      const resolved = await Effect.runPromise(resolveHookMatchForTarget(hook, registry, TARGET_ID));
      const matcher = matcherForResolvedToolHook(resolved, canonicalToolNames);
      if (matcher) entry.matcher = matcher;
    }
    (groupedHooks[event] ??= []).push(entry);
  }

  return json({ hooks: groupedHooks });
};

const renderHookWrapperEntry = (hook: Hook, hookRuntimePath: string): string =>
  renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    harness: TARGET_ID,
    nativeEvent: grokNativeHookEvent(hook.event),
    cwdExpression: "input?.cwd ?? input?.workspaceRoot ?? input?.workspace?.cwd",
    fallbackSessionId: TARGET_ID,
    blockDecisionSource: `  console.log(JSON.stringify({ decision: "deny", reason: result.message ?? "blocked" }));
  process.exit(2);`,
  });

const bundleHookWrapper = async (hook: Hook): Promise<string> => {
  return bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-grok-hook-",
    buildLabel: `Grok '${hook.name}'`,
    renderEntry: renderHookWrapperEntry,
  });
};

const pushWrite = createGeneratedPluginWritePusher(generatedPath);

const planMcpServer = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, { requirePort: true });
  const bindings = mcpBindingsForAgentsAndTools(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  const pluginId = generatedPluginId(input.target);

  if (bindings.length === 0) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      ".mcp.json",
      json({ mcpServers: {} }),
    );
    return;
  }

  const bundle = await generateMcpServerBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath,
    dependencyPluginRoots: input.registry ? Object.entries(input.registry.dependencyPaths) : undefined,
    serverName: pluginId,
    version: input.target.sourcePluginVersion ?? "0.1.0",
    bundleId: pluginId,
    ...mcpServerBundleRuntimeOptions(runtime),
    bindings,
  });

  await pushWrite(
    operations,
    desiredRelativePaths,
    input.target,
    bundle.relativePath,
    bundle.content,
  );
  await pushWrite(
    operations,
    desiredRelativePaths,
    input.target,
    ".mcp.json",
    json({
      mcpServers: {
        [pluginId]: {
          command: "bun",
          args: [generatedPath(input.target, bundle.relativePath)],
        },
      },
    }),
  );
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const state = createGeneratedPluginPlanState();
  const resolveTarget = (relativePath: string): string =>
    generatedPath(input.target, relativePath);

  await planGeneratedPluginManifest({
    input,
    state,
    pushWrite,
    pluginId: generatedPluginId(input.target),
    json,
  });
  await planGeneratedPluginAgentWrites({
    input,
    state,
    pushWrite,
    renderAgentMarkdown,
  });
  await planGeneratedPluginSkillWrites({ input, state, pushWrite });
  await planStandardGeneratedPluginOrbitSkillWrites({
    input,
    state,
    pushWrite,
  });
  await planMcpServer(input, state.operations, state.desiredRelativePaths);
  await planGeneratedPluginHookWrites({
    input,
    state,
    renderHooksJson,
    bundleHookWrapper,
    resolveTarget,
  });
  await planGeneratedPluginPruning({
    state,
    root: generatedPluginRoot(input.target),
    resolveTarget,
    owner: {
      harness: TARGET_ID,
      scope: input.target.scope,
      root: input.target.root,
      sourcePluginName: input.target.sourcePluginName,
    },
  });

  return state.operations;
};

export const executeLowering = executeStandardLowering;
