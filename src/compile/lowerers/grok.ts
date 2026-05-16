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

const composeAgentFrontmatter = (agent: ComposedAgent): Record<string, unknown> => {
  const override = agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;
  const model = agent.model ?? {};
  const tools = uniqueSorted([
    ...stringArray(override?.tools),
    ...stringArray(override?.["allowed-tools"]),
    ...agent.allowedTools,
  ]);

  return {
    name: agent.name,
    description: typeof override?.description === "string" ? override.description : agent.description,
    model:
      typeof override?.model === "string"
        ? override.model
        : typeof model.model === "string"
          ? model.model
          : undefined,
    prompt_mode:
      typeof override?.prompt_mode === "string" ? override.prompt_mode : undefined,
    permission_mode:
      typeof override?.permission_mode === "string"
        ? override.permission_mode
        : typeof override?.permissionMode === "string"
          ? override.permissionMode
          : undefined,
    agents_md: typeof override?.agents_md === "boolean" ? override.agents_md : undefined,
    effort:
      typeof override?.effort === "string"
        ? override.effort
        : typeof model.effort === "string"
          ? model.effort
          : typeof model.variant === "string"
            ? model.variant
            : undefined,
    reasoning_effort:
      typeof override?.reasoning_effort === "string"
        ? override.reasoning_effort
        : undefined,
    temperature:
      typeof override?.temperature === "number"
        ? override.temperature
        : typeof model.temperature === "number"
          ? model.temperature
          : undefined,
    top_p:
      typeof override?.top_p === "number"
        ? override.top_p
        : typeof model.top_p === "number"
          ? model.top_p
          : undefined,
    tools,
    disallowedTools: [
      ...stringArray(override?.disallowedTools),
      ...stringArray(override?.["disallowed-tools"]),
    ],
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
    serverName: pluginId,
    version: input.target.sourcePluginVersion ?? "0.1.0",
    bundleId: pluginId,
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
  });

  return state.operations;
};

export const executeLowering = executeStandardLowering;
