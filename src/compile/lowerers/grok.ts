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
import { shimCommandForCompile } from "../shim-command.js";
import {
  type GrokCollisionGuard,
  createGrokCollisionGuard,
  pluginServerKey,
  renderPluginAllowlist,
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
import type { DesiredFile, DesiredRegion } from "../../sync/desired.js";
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
import { toolsMcpHarnessEmitEnabled } from "../../tools-cli/flags.js";

const TARGET_ID = "grok" as const;

/**
 * The plugin's `p_<hash8>` HTTP-mode wire server name. Retained only for
 * external consumers still on the (deleted) HTTP-mode assertion path — the
 * lowerer's own naming now goes entirely through `@skastr0/prism-sdk/mcp/
 * wire-naming`'s `renderPluginAllowlist`/`renderPluginWire`, which registers
 * one config.toml server per MCP-owning plugin (`pluginServerKey`) and
 * advertises that plugin's bare, Grok-capped tool names under it.
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
    // Never emit skills into Grok agent frontmatter. Grok non-interactive sessions
    // preload FULL skill bodies for every frontmatter skill entry (2026-07-11:
    // 115 skills → ~353k fixed tokens → compaction doom). Empty array is omitted
    // by serializeFrontmatter. Runtime skill discovery is unaffected.
    skills: [],
  };
};

const renderAgentMarkdown = (
  agent: ComposedAgent,
  target: GrokLowerTarget,
  namer: GrokToolNamer,
): string => {
  return `${serializeFrontmatter(composeAgentFrontmatter(agent, target, namer))}\n\n${agent.body}\n`;
};

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

interface GrokToolNamer {
  readonly name: (ownerPlugin: string, binding: ResolvedContractBinding) => string;
}

/**
 * Renders every tool name this compile emits through the shared
 * `renderPluginAllowlist("grok", ownerPlugin, ...)` — the owner plugin's own
 * bare wire name (redundant own-namespace prefix stripped), Grok-capped at
 * <=64 chars for the fully-qualified `<pluginServerKey(owner)>__<bare>` name,
 * prefixed by that owner's own per-plugin server key (never a shared shim
 * key). Capping collisions can only occur between two tools on the SAME
 * owner's server (different owners never share a wire namespace), so the
 * `GrokCollisionGuard` is scoped per owner plugin, not globally across the
 * whole compile.
 */
const createGrokToolNamer = (): GrokToolNamer => {
  const guards = new Map<string, GrokCollisionGuard>();
  const guardFor = (ownerPlugin: string): GrokCollisionGuard => {
    const existing = guards.get(ownerPlugin);
    if (existing) return existing;
    const guard = createGrokCollisionGuard();
    guards.set(ownerPlugin, guard);
    return guard;
  };
  return {
    name: (ownerPlugin, binding) =>
      renderPluginAllowlist(
        "grok",
        ownerPlugin,
        mcpToolNameForBinding(ownerPlugin, binding),
        guardFor(ownerPlugin),
      ),
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

const quote = (value: string): string => JSON.stringify(value);

const tomlArray = (values: ReadonlyArray<string>): string =>
  `[${values.map((value) => quote(value)).join(", ")}]`;

const tomlDottedTable = (segments: ReadonlyArray<string>): string =>
  `[${segments.map((segment) => quote(segment)).join(".")}]`;

/**
 * One `[mcp_servers.<pluginServerKey(owner)>]` entry per MCP-owning plugin
 * (the operator-locked shape: one server keyed by the plugin's own name,
 * never a shared shim key). `PRISM_SHIM_NAMING = "per-plugin"` selects the
 * shim's single-plugin naming mode (bare wire tool names — see
 * `@skastr0/prism-sdk/mcp/shim.ts`'s `ShimNamingMode`), matching the bare,
 * per-owner names `renderPluginAllowlist` renders into agent frontmatter.
 * `PRISM_SHIM_EXPOSURE` is deliberately omitted: absent, the shim derives
 * the per-owner daemon profile itself (`prism-generated-<owner>:grok`).
 */
const renderGrokPerPluginShimServerToml = (owner: string): string => {
  const serverName = pluginServerKey(owner);
  return [
    tomlDottedTable(["mcp_servers", serverName]),
    `command = ${quote(shimCommandForCompile())}`,
    `args = ${tomlArray(["mcp", "shim"])}`,
    "enabled = true",
    tomlDottedTable(["mcp_servers", serverName, "env"]),
    `PRISM_SHIM_PLUGINS = ${quote(owner)}`,
    `PRISM_SHIM_HARNESS = ${quote(TARGET_ID)}`,
    `PRISM_SHIM_NAMING = ${quote("per-plugin")}`,
  ].join("\n");
};

/**
 * Registers one stdio-shim entry per MCP-owning plugin in
 * `<grok-root>/config.toml`, each its own Prism-managed marker region keyed
 * `grok.mcp.<pluginServerKey(owner)>`.
 *
 * Why config.toml and not a plugin-bundle `.mcp.json`: Grok resolves MCP
 * servers only from its config sources (`~/.grok/config.toml`, project
 * `.grok/config.toml`, the project-root `.mcp.json`, and the Claude/Cursor
 * compat imports — see `grok mcp doctor`'s "Config sources"). A `.mcp.json`
 * inside an installed plugin bundle is counted by `grok inspect` but never
 * becomes a live server in an agent run, so every tool name the lowerer
 * advertised in agent frontmatter resolved to "Tool not found" via
 * CallMcpTool.
 *
 * Consumer plugins referencing a foreign owner's tools never get their own
 * server entry — only the owner does. This compile already knows every
 * owner it needs a region for (itself, plus any owner its own agents
 * reference), computed directly from its own resolved bindings — no
 * cross-plugin state required: the owner's own compile (or any other
 * compile that references it) renders the byte-identical region
 * independently, region-owned by that plugin, and the sync engine prunes it
 * the moment no compiling plugin references that owner anymore. There is no
 * tool allowlist in the server table (agent frontmatter `tools:` gates
 * exposure), so only owner plugins are tracked here.
 */
const planMcpServerRegion = (input: LowerInput, regions: DesiredRegion[]): void => {
  if (!toolsMcpHarnessEmitEnabled()) return;
  const bindingsByOwner = allReferencedBindingsByOwner(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  for (const owner of uniqueSorted([...bindingsByOwner.keys()])) {
    regions.push({
      kind: "marker",
      targetPath: join(input.target.root, "config.toml"),
      regionKey: `grok.mcp.${pluginServerKey(owner)}`,
      commentPrefix: "#",
      content: renderGrokPerPluginShimServerToml(owner),
      plugin: owner,
    });
  }
};

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const state = createGeneratedPluginPlanState();
  const regions: DesiredRegion[] = [];
  const namer = createGrokToolNamer();
  const resolveTarget = (relativePath: string): string =>
    generatedPath(input.target, relativePath);

  // An artifact-less compile must not plant an empty generated plugin
  // bundle — only the MCP server region (if any owner is referenced)
  // participates then.
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
  }
  planMcpServerRegion(input, regions);
  if (hasBundleArtifacts) {
    await planGeneratedPluginHookWrites({
      input,
      state,
      renderHooksJson: (hooks, registry, target, bindings) =>
        renderHooksJson(hooks, registry, target, bindings, namer),
      bundleHookWrapper,
      resolveTarget,
    });
  }

  return { files: state.files, regions };
};
