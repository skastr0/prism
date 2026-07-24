/**
 * Factory Droid plugin-bundle lowerer.
 *
 * Produces one compiler-owned Factory plugin bundle under
 * <factory-root>/plugins/prism-generated-<source-plugin>/.
 */

import { join } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { resolveHookMatchForTarget } from "../hooks.js";
import { cliToolNameForBinding } from "../tool-runtime-bundle.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  collectBindingNameMap,
  ownerPluginForBinding,
} from "../tool-bindings.js";
import type { HarnessScope } from "../../types.js";
import type { DesiredFile } from "../../sync/desired.js";
import {
  bundleGeneratedHookWrapper,
  createGeneratedPluginPlanState,
  createGeneratedPluginWritePusher,
  matcherForResolvedToolHook,
  normalizeBundleSegment,
  planGeneratedPluginHookWrites,
  planGeneratedPluginManifest,
  planGeneratedPluginSkillWrites,
  planStandardGeneratedPluginOrbitSkillWrites,
  prePostSessionNativeHookEvent,
  renderPrePostSessionHookWrapperEntry,
  stringArray,
  uniqueSorted,
  yamlScalar,
  type LowerOutput,
} from "./shared.js";

const TARGET_ID = "factory-droid" as const;
const GENERATED_PLUGIN_PREFIX = "prism-generated";

export interface FactoryDroidLowerTarget {
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

/** Native Factory tool categories (including Factory's own "mcp" category name). */
const FACTORY_TOOL_CATEGORIES = new Set(["read-only", "edit", "execute", "web", "mcp"]);

const factoryOverrideForAgent = (agent: ComposedAgent): Record<string, unknown> | undefined =>
  agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;

const composeFactoryTools = (
  agent: ComposedAgent,
  override: Record<string, unknown> | undefined,
): string | string[] | undefined => {
  const explicitArrayTools = [
    ...stringArray(override?.tools),
    ...stringArray(override?.["allowed-tools"]),
  ];
  const category = stringValue(override?.tools);
  const merged = uniqueSorted(
    [...explicitArrayTools, ...agent.allowedTools],
    { dropEmpty: true },
  );

  if (category && !FACTORY_TOOL_CATEGORIES.has(category)) {
    throw new Error(
      `Factory Droid agent '${agent.name}' uses unknown Factory tools category '${category}'. Use one of read-only, edit, execute, web, mcp, or provide an explicit Factory tool array.`,
    );
  }

  if (category && merged.length > 0) {
    throw new Error(
      `Factory Droid agent '${agent.name}' cannot combine tools category '${category}' with explicit or resolved native tools. Use a Factory tool array when mixing category and native tool names.`,
    );
  }

  if (category) return category;

  return merged.length > 0 ? merged : undefined;
};

const composeAgentFrontmatter = (
  agent: ComposedAgent,
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
    tools: composeFactoryTools(agent, override),
  };
};

const renderDroidMarkdown = (agent: ComposedAgent): string =>
  `${serializeFrontmatter(composeAgentFrontmatter(agent))}\n\n${agent.body}\n`;

const pushWrite = createGeneratedPluginWritePusher(generatedPath);

const planDroidWrites = async (
  input: LowerInput,
  files: DesiredFile[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
  for (const agent of input.agents) {
    pushWrite(
      files,
      desiredRelativePaths,
      input.target,
      `droids/${agent.name}.md`,
      renderDroidMarkdown(agent),
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
  const canonicalToolNames = collectBindingNameMap(
    bindings,
    (binding) => {
      const owner = ownerPluginForBinding(target.sourcePluginName, binding);
      return cliToolNameForBinding(owner, binding);
    },
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

const renderHookWrapperEntry = (
  hook: Hook,
  hookRuntimePath: string,
  hookSourcePath: string,
): string =>
  renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    hookSourcePath,
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

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const state = createGeneratedPluginPlanState();
  const resolveTarget = (relativePath: string): string =>
    generatedPath(input.target, relativePath);

  if (!hasFactoryOutput(input)) {
    // No desired output: the sync engine prunes any previously managed files.
    return { files: [], regions: [] };
  }

  await planGeneratedPluginManifest({
    input,
    state,
    pushWrite,
    pluginId: generatedPluginId(input.target),
    json,
    relativePath: ".factory-plugin/plugin.json",
  });
  await planDroidWrites(input, state.files, state.desiredRelativePaths);
  if (factoryBundleOwnsPluginSkills(input)) {
    await planGeneratedPluginSkillWrites({ input, state, pushWrite });
  }
  await planStandardGeneratedPluginOrbitSkillWrites({
    input,
    state,
    pushWrite,
  });
  await planGeneratedPluginHookWrites({
    input,
    state,
    renderHooksJson,
    bundleHookWrapper,
    resolveTarget,
  });

  return { files: state.files, regions: [] };
};
