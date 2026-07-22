/**
 * Grok plugin-bundle lowerer.
 *
 * Produces one compiler-owned Grok plugin bundle under
 * <grok-root>/plugins/prism-generated-<source-plugin>/.
 */

import { join } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { generatedPluginIdForOwner } from "../generated-plugin.js";
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
import {
  bundleGeneratedHookWrapper,
  createGeneratedPluginWritePusher,
  createGeneratedPluginPlanState,
  matcherForResolvedToolHook,
  planGeneratedPluginAgentWrites,
  planGeneratedPluginHookWrites,
  planGeneratedPluginManifest,
  planGeneratedPluginSkillWrites,
  planStandardGeneratedPluginOrbitSkillWrites,
  renderPrePostSessionHookWrapperEntry,
  stringArray,
  uniqueSorted,
  yamlScalar,
  type LowerOutput,
} from "./shared.js";

const TARGET_ID = "grok" as const;

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
  generatedPluginIdForOwner(target.sourcePluginName);

const generatedPluginRoot = (target: GrokLowerTarget): string =>
  join(target.root, "plugins", generatedPluginId(target));

const generatedPath = (target: GrokLowerTarget, relativePath: string): string =>
  join(generatedPluginRoot(target), ...relativePath.split("/"));

const directPath = (target: GrokLowerTarget, relativePath: string): string =>
  join(target.root, ...relativePath.split("/"));

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

const composeAgentFrontmatter = (
  agent: ComposedAgent,
): Record<string, unknown> => {
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
    // Never emit skills into Grok agent frontmatter. Grok non-interactive sessions
    // preload FULL skill bodies for every frontmatter skill entry (2026-07-11:
    // 115 skills → ~353k fixed tokens → compaction doom). Empty array is omitted
    // by serializeFrontmatter. Runtime skill discovery is unaffected.
    skills: [],
  };
};

const renderAgentMarkdown = (agent: ComposedAgent): string =>
  `${serializeFrontmatter(composeAgentFrontmatter(agent))}\n\n${agent.body}\n`;

const grokNativeHookEvent = (event: Hook["event"]): string => {
  switch (event) {
    case "tool.before":
      return "PreToolUse";
    case "tool.after":
      return "PostToolUse";
    case "session.start":
      return "SessionStart";
    case "session.end":
      return "SessionEnd";
    case "prompt.submit":
      return "UserPromptSubmit";
    case "tool.failure":
      return "PostToolUseFailure";
    case "stop":
      return "Stop";
    case "subagent.start":
      return "SubagentStart";
    case "subagent.stop":
      return "SubagentStop";
    case "compact.before":
      return "PreCompact";
    case "compact.after":
      return "PostCompact";
    case "notification":
      return "Notification";
    default:
      throw new Error(`Unsupported event: ${event}`);
  }
};

const renderHooksJson = async (
  hooks: ReadonlyArray<Hook>,
  registry: PluginRegistry | undefined,
  target: GrokLowerTarget,
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
    const event = grokNativeHookEvent(hook.event);
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: "command",
          command: `node ${JSON.stringify(generatedPath(target, `hooks/${hook.name}.mjs`))}`,
        },
      ],
    };
    if (
      registry &&
      (hook.event === "tool.before" ||
        hook.event === "tool.after" ||
        hook.event === "tool.failure")
    ) {
      const resolved = await Effect.runPromise(resolveHookMatchForTarget(hook, registry, TARGET_ID));
      const matcher = matcherForResolvedToolHook(resolved, canonicalToolNames);
      if (matcher) entry.matcher = matcher;
    }
    (groupedHooks[event] ??= []).push(entry);
  }

  return json({ hooks: groupedHooks });
};

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
const pushDirectWrite = createGeneratedPluginWritePusher(directPath);

const assertProjectHooksSupported = (input: LowerInput): void => {
  const hooks = input.hooks ?? [];
  if (input.target.scope !== "project" || hooks.length === 0) return;

  const sources = hooks
    .map((hook) => `${hook.name} (${hook.sourcePath})`)
    .sort((left, right) => left.localeCompare(right));
  throw new Error(
    `Grok project-scope hooks are unsupported until Prism can prove exactly-once hook loading. ` +
      `Compile Grok with '--scope global', or remove 'grok' from plugin.json -> targets.hooks. ` +
      `Project hooks: ${sources.join(", ")}`,
  );
};

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const state = createGeneratedPluginPlanState();
  const resolveTarget = (relativePath: string): string =>
    generatedPath(input.target, relativePath);
  const planAgentWrites = (write: typeof pushWrite): Promise<void> =>
    planGeneratedPluginAgentWrites({
      input,
      state,
      pushWrite: write,
      renderAgentMarkdown,
    });

  assertProjectHooksSupported(input);

  if (input.target.scope === "project") {
    await planAgentWrites(pushDirectWrite);
    await planGeneratedPluginSkillWrites({ input, state, pushWrite: pushDirectWrite });
    await planStandardGeneratedPluginOrbitSkillWrites({
      input,
      state,
      pushWrite: pushDirectWrite,
    });
    return { files: state.files, regions: [] };
  }

  // An artifact-less compile must not plant an empty generated plugin bundle.
  const hasBundleArtifacts =
    input.agents.length > 0 ||
    input.orbits.length > 0 ||
    (input.tools?.length ?? 0) > 0 ||
    (input.skills?.length ?? 0) > 0 ||
    (input.hooks?.length ?? 0) > 0;

  if (hasBundleArtifacts) {
    await planGeneratedPluginManifest({
      input,
      state,
      pushWrite,
      pluginId: generatedPluginId(input.target),
      json,
    });
    await planAgentWrites(pushWrite);
    await planGeneratedPluginSkillWrites({ input, state, pushWrite });
    await planStandardGeneratedPluginOrbitSkillWrites({
      input,
      state,
      pushWrite,
    });
  }
  if ((input.hooks?.length ?? 0) > 0) {
    await planGeneratedPluginHookWrites({
      input,
      state,
      renderHooksJson,
      bundleHookWrapper,
      resolveTarget,
    });
  }

  return { files: state.files, regions: [] };
};
