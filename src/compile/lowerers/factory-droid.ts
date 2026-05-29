/**
 * Factory Droid plugin-bundle lowerer.
 *
 * Produces one compiler-owned Factory plugin bundle under
 * <factory-root>/plugins/prism-generated-<source-plugin>/.
 */

import { join } from "node:path";
import { Effect } from "effect";
import { exists } from "../../fs.js";
import { type ComposedAgent } from "../compose.js";
import { resolveHookMatchForTarget } from "../hooks.js";
import {
  generateMcpServerBundle,
  mcpToolNameForBinding,
} from "../mcp-bundle.js";
import {
  mcpServerBundleRuntimeOptions,
  renderMcpBearerAuthorization,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  runtimeMcpServerDescriptor,
} from "../mcp-runtime.js";
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
  createGeneratedPluginPlanState,
  createGeneratedPluginWritePusher,
  executeStandardLowering,
  matcherForResolvedToolHook,
  normalizeBundleSegment,
  planGeneratedPluginHookWrites,
  planGeneratedPluginManifest,
  planGeneratedPluginPruning,
  planGeneratedPluginSkillWrites,
  planStandardGeneratedPluginOrbitSkillWrites,
  prePostSessionNativeHookEvent,
  pushWriteOperation as pushRawWrite,
  renderPrePostSessionHookWrapperEntry,
  stringArray,
  uniqueSorted,
  yamlScalar,
} from "./shared.js";

const TARGET_ID = "factory-droid" as const;
const GENERATED_PLUGIN_PREFIX = "prism-generated";

export interface FactoryDroidLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly mcpRuntimeRoot?: string;
  readonly mcpBearerToken?: string;
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
  readonly target: FactoryDroidLowerTarget;
}

const generatedPluginId = (target: FactoryDroidLowerTarget): string =>
  `${GENERATED_PLUGIN_PREFIX}-${normalizeBundleSegment(target.sourcePluginName)}`;

const generatedPluginRoot = (target: FactoryDroidLowerTarget): string =>
  join(target.root, "plugins", generatedPluginId(target));

const generatedPath = (target: FactoryDroidLowerTarget, relativePath: string): string =>
  join(generatedPluginRoot(target), ...relativePath.split("/"));

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const serializeFrontmatter = (values: Record<string, unknown>): string => {
  const lines = ["---"];
  const orderedKeys = [
    "name",
    "description",
    "model",
    "reasoningEffort",
    "tools",
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
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const firstDefined = <T>(...values: Array<T | undefined>): T | undefined =>
  values.find((value) => value !== undefined);

const FACTORY_REASONING_EFFORTS = new Set(["low", "medium", "high"]);

const reasoningEffortValue = (...values: unknown[]): string | undefined =>
  values
    .map(stringValue)
    .find((value): value is string =>
      value !== undefined && FACTORY_REASONING_EFFORTS.has(value),
    );

const FACTORY_TOOL_CATEGORIES = new Set(["read-only", "edit", "execute", "web", "mcp"]);

const factoryOverrideForAgent = (agent: ComposedAgent): Record<string, unknown> | undefined =>
  agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;

const factoryMcpToolNameForBinding = (
  sourcePluginName: string,
  pluginId: string,
  binding: ResolvedContractBinding,
): string => `mcp__${pluginId}__${mcpToolNameForBinding(sourcePluginName, binding)}`;

const composeFactoryTools = (
  agent: ComposedAgent,
  target: FactoryDroidLowerTarget,
  override: Record<string, unknown> | undefined,
): string | string[] | undefined => {
  const pluginId = generatedPluginId(target);
  const explicitArrayTools = [
    ...stringArray(override?.tools),
    ...stringArray(override?.["allowed-tools"]),
  ];
  const generatedTools = agent.toolBindings.map((binding) =>
    factoryMcpToolNameForBinding(target.sourcePluginName, pluginId, binding),
  );
  const category = stringValue(override?.tools);
  const merged = uniqueSorted(
    [...explicitArrayTools, ...agent.allowedTools, ...generatedTools],
    { dropEmpty: true },
  );

  if (category && !FACTORY_TOOL_CATEGORIES.has(category)) {
    throw new Error(
      `Factory Droid agent '${agent.name}' uses unknown Factory tools category '${category}'. Use one of read-only, edit, execute, web, mcp, or provide an explicit Factory tool array.`,
    );
  }

  if (category && merged.length > 0) {
    throw new Error(
      `Factory Droid agent '${agent.name}' cannot combine tools category '${category}' with explicit, resolved, or generated tools. Use a Factory tool array when mixing native and MCP tool names.`,
    );
  }

  if (category) return category;

  return merged.length > 0 ? merged : undefined;
};

const composeAgentFrontmatter = (
  agent: ComposedAgent,
  target: FactoryDroidLowerTarget,
): Record<string, unknown> => {
  const override = factoryOverrideForAgent(agent);
  const model = agent.model ?? {};

  return {
    name: agent.name,
    description: stringValue(override?.description) ?? agent.description,
    model: firstDefined(stringValue(override?.model), stringValue(model.model), "inherit"),
    reasoningEffort: reasoningEffortValue(
      override?.reasoningEffort,
      override?.reasoning_effort,
      model.reasoningEffort,
      model.reasoning_effort,
      model.effort,
      model.variant,
    ),
    tools: composeFactoryTools(agent, target, override),
  };
};

const renderDroidMarkdown = (
  agent: ComposedAgent,
  target: FactoryDroidLowerTarget,
): string => `${serializeFrontmatter(composeAgentFrontmatter(agent, target))}\n\n${agent.body}\n`;

const pushWrite = createGeneratedPluginWritePusher(generatedPath);

const planDroidWrites = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
  for (const agent of input.agents) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `droids/${agent.name}.md`,
      renderDroidMarkdown(agent, input.target),
      "write-md",
    );
  }
};

const factoryNativeHookEvent = prePostSessionNativeHookEvent;

const renderHooksJson = async (
  hooks: ReadonlyArray<Hook>,
  registry: PluginRegistry | undefined,
  target: FactoryDroidLowerTarget,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): Promise<string> => {
  const groupedHooks: Record<string, unknown[]> = {};
  const pluginId = generatedPluginId(target);
  const canonicalToolNames = collectBindingNameMap(
    bindings,
    (binding) => factoryMcpToolNameForBinding(target.sourcePluginName, pluginId, binding),
  );

  for (const hook of hooks) {
    const event = factoryNativeHookEvent(hook.event);
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: "command",
          command: `node "\${DROID_PLUGIN_ROOT}/hooks/${hook.name}.mjs"`,
        },
      ],
    };
    if (registry && (hook.event === "tool.before" || hook.event === "tool.after")) {
      const resolved = await Effect.runPromise(resolveHookMatchForTarget(hook, registry, TARGET_ID));
      const matcher = matcherForResolvedToolHook(resolved, canonicalToolNames);
      if (matcher) entry.matcher = matcher;
    }
    (groupedHooks[event] ??= []).push(entry);
  }

  return json(groupedHooks);
};

const FACTORY_TOOL_AFTER_OUTPUT_EXPRESSION =
  "input?.tool_response ?? input?.tool?.output ?? input?.toolOutput ?? input?.tool_output ?? input?.output";

const renderHookWrapperEntry = (hook: Hook, hookRuntimePath: string): string =>
  renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    harness: TARGET_ID,
    nativeEvent: factoryNativeHookEvent(hook.event),
    cwdExpression: "input?.cwd ?? input?.workspace?.cwd",
    fallbackSessionId: TARGET_ID,
    toolAfterOutputExpression: FACTORY_TOOL_AFTER_OUTPUT_EXPRESSION,
    blockDecisionSource: `  console.error(result.message);
  process.exit(2);`,
  });

const bundleHookWrapper = async (hook: Hook): Promise<string> =>
  bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-factory-hook-",
    buildLabel: `Factory Droid '${hook.name}'`,
    renderEntry: renderHookWrapperEntry,
  });

const hasFactoryOutput = (input: LowerInput): boolean =>
  input.agents.length > 0 ||
  input.orbits.length > 0 ||
  (input.tools?.length ?? 0) > 0 ||
  (input.hooks?.length ?? 0) > 0;

const factoryBundleOwnsPluginSkills = (input: LowerInput): boolean =>
  input.agents.length > 0 ||
  (input.tools?.length ?? 0) > 0 ||
  (input.hooks?.length ?? 0) > 0;

const sharedMcpServerPath = (target: FactoryDroidLowerTarget): string =>
  runtimeMcpServerDescriptor(
    target.mcpRuntimeRoot ?? target.root,
    target.sourcePluginName,
  ).absolutePath;

const planSharedMcpServerPrune = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<void> => {
  const target = sharedMcpServerPath(input.target);
  if (!(await exists(target))) return;
  operations.push({
    kind: "prune-plugin-path",
    target,
    targetType: "file",
    shared: true,
    reason: "stale",
  } as LowerOperation);
};

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
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, { requirePort: true });
  const pluginId = generatedPluginId(input.target);

  if (runtime.transport !== "streamable-http" || bindings.length === 0) {
    await planSharedMcpServerPrune(input, operations);
  }

  if (bindings.length === 0) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      "mcp.json",
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
    ...mcpServerBundleRuntimeOptions(runtime),
    bindings,
  });

  if (runtime.transport === "streamable-http") {
    await pushRawWrite(
      operations,
      sharedMcpServerPath(input.target),
      bundle.content,
    );
  } else {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      bundle.relativePath,
      bundle.content,
    );
  }

  await pushWrite(
    operations,
    desiredRelativePaths,
    input.target,
    "mcp.json",
    json({
      mcpServers: {
        [pluginId]: runtime.transport === "streamable-http"
          ? {
              type: "http",
              url: renderMcpHttpUrl(runtime),
              headers: {
                Authorization: renderMcpBearerAuthorization({
                  tokenEnv: runtime.tokenEnv,
                  token: input.target.mcpBearerToken,
                }),
              },
            }
          : {
              type: "stdio",
              command: "bun",
              args: [`\${DROID_PLUGIN_ROOT}/${bundle.relativePath}`],
            },
      },
    }),
    "write-plugin-file",
    {
      mode: runtime.transport === "streamable-http" && input.target.mcpBearerToken
        ? 0o600
        : undefined,
    },
  );
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const state = createGeneratedPluginPlanState();
  const resolveTarget = (relativePath: string): string =>
    generatedPath(input.target, relativePath);

  if (!hasFactoryOutput(input)) {
    await planSharedMcpServerPrune(input, state.operations);
    await planGeneratedPluginPruning({
      state,
      root: generatedPluginRoot(input.target),
      resolveTarget,
    });
    return state.operations;
  }

  await planGeneratedPluginManifest({
    input,
    state,
    pushWrite,
    pluginId: generatedPluginId(input.target),
    json,
    relativePath: ".factory-plugin/plugin.json",
  });
  await planDroidWrites(input, state.operations, state.desiredRelativePaths);
  if (factoryBundleOwnsPluginSkills(input)) {
    await planGeneratedPluginSkillWrites({ input, state, pushWrite });
  }
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
