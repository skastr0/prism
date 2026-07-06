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
import { mcpToolNameForBinding } from "../mcp-bundle.js";
import { generatedMcpWireServerName } from "../mcp-runtime.js";
import {
  type GrokCollisionGuard,
  createGrokCollisionGuard,
  renderAllowlist,
  shimServerKey,
} from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  allReferencedBindingsByOwner,
  collectBindingNameMap,
  groupAgentToolBindingsByOwner,
  mcpBindingsForAgentsAndTools,
  ownerPluginForBinding,
} from "../tool-bindings.js";
import type { HarnessScope } from "../../types.js";
import type { DesiredFile } from "../../sync/desired.js";
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
  prePostSessionNativeHookEvent,
  renderPrePostSessionHookWrapperEntry,
  stringArray,
  uniqueSorted,
  yamlScalar,
  type LowerOutput,
} from "./shared.js";

const TARGET_ID = "grok" as const;

/**
 * The plugin's `p_<hash8>` HTTP-mode wire server name. Retained only for
 * external consumers still on the (deleted) HTTP-mode assertion path — the
 * lowerer's own naming now goes entirely through `@skastr0/prism-sdk/mcp/
 * wire-naming`'s `renderAllowlist`/`renderWire`, which caps and namespaces
 * per the shim's single "prism" server key, not per owner plugin.
 */
export const grokMcpServerNameForPlugin = (sourcePluginName: string): string =>
  generatedMcpWireServerName(sourcePluginName);

export interface GrokLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly mcpExposureProfile?: string;
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
  target: GrokLowerTarget,
  override: Record<string, unknown> | undefined,
  namer: GrokToolNamer,
): string[] => {
  const generatedTools: string[] = [];
  for (const [ownerPlugin, bindings] of groupAgentToolBindingsByOwner(
    target.sourcePluginName,
    agent,
  )) {
    for (const binding of bindings) {
      generatedTools.push(namer.name(ownerPlugin, binding));
    }
  }
  return uniqueSorted([
    ...stringArray(override?.tools),
    ...stringArray(override?.["allowed-tools"]),
    ...agent.allowedTools,
    ...generatedTools,
  ]);
};

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
  target: GrokLowerTarget,
  namer: GrokToolNamer,
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
    tools: composeGrokTools(agent, target, override, namer),
    disallowedTools: composeGrokDisallowedTools(override),
    skills: uniqueSorted(agent.allowedSkills),
  };
};

const renderAgentMarkdown = (
  agent: ComposedAgent,
  target: GrokLowerTarget,
  namer: GrokToolNamer,
): string => {
  return `${serializeFrontmatter(composeAgentFrontmatter(agent, target, namer))}\n\n${agent.body}\n`;
};

const grokNativeHookEvent = prePostSessionNativeHookEvent;

interface GrokToolNamer {
  readonly name: (ownerPlugin: string, binding: ResolvedContractBinding) => string;
}

/**
 * Renders every tool name this compile emits through the shared
 * `renderAllowlist("grok", ...)` — canonical wire name, Grok-capped at
 * <=64 chars, prefixed `<shim server key>__`. One `GrokCollisionGuard` per
 * lowering pass: since every owner plugin's tools now funnel through the
 * same single "prism" shim server (not one server per owner, as HTTP mode
 * had), the collision guard is correctly scoped globally across the whole
 * compile, not per owner.
 */
const createGrokToolNamer = (): GrokToolNamer => {
  const guard: GrokCollisionGuard = createGrokCollisionGuard();
  return {
    name: (ownerPlugin, binding) =>
      renderAllowlist("grok", ownerPlugin, mcpToolNameForBinding(ownerPlugin, binding), guard),
  };
};

const renderHooksJson = async (
  hooks: ReadonlyArray<Hook>,
  registry: PluginRegistry | undefined,
  target: GrokLowerTarget,
  bindings: ReadonlyArray<ResolvedContractBinding>,
  namer: GrokToolNamer,
): Promise<string> => {
  const groupedHooks: Record<string, unknown[]> = {};
  const canonicalToolNames = collectBindingNameMap(
    bindings,
    (binding) => {
      const owner = ownerPluginForBinding(target.sourcePluginName, binding);
      return namer.name(owner, binding);
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
    if (registry) {
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

const planMcpServer = (
  input: LowerInput,
  files: DesiredFile[],
  desiredRelativePaths: Set<string>,
): void => {
  const bindingsByOwner = allReferencedBindingsByOwner(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  if (bindingsByOwner.size === 0) return;

  // One shim process fans out to every owner plugin's daemon over UDS, so
  // there is exactly one entry here — no per-owner runtime/port resolution
  // needed at compile time; the shim resolves live daemons on demand.
  const env: Record<string, string> = {
    PRISM_SHIM_PLUGINS: [...bindingsByOwner.keys()].join(","),
    PRISM_SHIM_HARNESS: TARGET_ID,
  };
  if (input.target.mcpExposureProfile) {
    env.PRISM_SHIM_EXPOSURE = input.target.mcpExposureProfile;
  }

  pushWrite(
    files,
    desiredRelativePaths,
    input.target,
    ".mcp.json",
    json({
      mcpServers: {
        [shimServerKey("grok")]: {
          command: "prism",
          args: ["mcp", "shim"],
          env,
        },
      },
    }),
  );
};

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const state = createGeneratedPluginPlanState();
  const namer = createGrokToolNamer();
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
    renderAgentMarkdown: (agent) => renderAgentMarkdown(agent, input.target, namer),
  });
  await planGeneratedPluginSkillWrites({ input, state, pushWrite });
  await planStandardGeneratedPluginOrbitSkillWrites({
    input,
    state,
    pushWrite,
  });
  await planMcpServer(input, state.files, state.desiredRelativePaths);
  await planGeneratedPluginHookWrites({
    input,
    state,
    renderHooksJson: (hooks, registry, target, bindings) =>
      renderHooksJson(hooks, registry, target, bindings, namer),
    bundleHookWrapper,
    resolveTarget,
  });

  return { files: state.files, regions: [] };
};
