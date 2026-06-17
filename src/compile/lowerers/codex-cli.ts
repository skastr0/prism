/** Codex CLI lowerer. */

import { join } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import {
  mcpToolNameForBinding,
  mcpToolNamesForBindings,
} from "../mcp-bundle.js";
import {
  generatedMcpServerName,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  type ResolvedMcpRuntime,
} from "../mcp-runtime.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  bindingsFromCanonicalTools,
  collectBindingNameMap,
  mcpBindingsForAgentsAndTools,
} from "../tool-bindings.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import { readFile } from "../../fs.js";
import type { HarnessScope, PluginArtifactType, PluginTargetId } from "../../types.js";
import type { DesiredFile, DesiredRegion } from "../../sync/desired.js";
import {
  bundleGeneratedHookWrapper,
  nativeHookEventName,
  normalizeBundleSegment,
  pushDesiredFile,
  regexEscape,
  renderPrePostSessionHookWrapperEntry,
  renderStandardOrbitSkill,
  uniqueSorted,
  type LowerOutput,
} from "./shared.js";

const TARGET_ID = "codex-cli" as const;

export interface CodexCliLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly mcpRuntimePort?: number;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
  readonly sourcePluginPath?: string;
}

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly tools: ReadonlyArray<CanonicalTool>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: CodexCliLowerTarget;
}

interface PlannedHook {
  readonly hook: Hook;
  readonly nativeEvent: string;
  readonly matcher?: string;
  readonly relativePath: string;
}

interface AgentMcpServerConfig {
  readonly name: string;
  readonly runtime: ResolvedMcpRuntime;
}

const quote = (value: string): string => JSON.stringify(value);

const tomlArray = (values: ReadonlyArray<string>): string =>
  `[${values.map((value) => quote(value)).join(", ")}]`;

const tomlDottedTable = (segments: ReadonlyArray<string>): string =>
  `[${segments.map((segment) => quote(segment)).join(".")}]`;

const tomlDottedArrayTable = (segments: ReadonlyArray<string>): string =>
  `[[${segments.map((segment) => quote(segment)).join(".")}]]`;

const manifestTargetsCodex = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsCodex = (
  registry: PluginRegistry | undefined,
  artifact: PluginArtifactType,
): boolean => manifestTargetsCodex(registry?.targets[artifact]);

const renderTomlScalar = (key: string, value: unknown): string | undefined => {
  if (typeof value === "string") return `${key} = ${quote(value)}`;
  if (typeof value === "number" && Number.isFinite(value)) return `${key} = ${value}`;
  if (typeof value === "boolean") return `${key} = ${value}`;
  return undefined;
};

const CODEX_MODEL_KEYS = new Set([
  "model",
  "model_provider",
  "profile",
  "model_reasoning_effort",
  "model_verbosity",
]);

const CODEX_MODEL_ALIASES: Record<string, string> = {
  effort: "model_reasoning_effort",
  variant: "model_reasoning_effort",
};

const setCodexModelValue = (
  output: Record<string, unknown>,
  source: string,
  key: string,
  value: unknown,
  agentName: string,
): void => {
  if (value === undefined) return;

  const translated = CODEX_MODEL_ALIASES[key] ?? key;
  if (!CODEX_MODEL_KEYS.has(translated)) {
    throw new Error(
      `unsupported Codex model config key '${key}' on agent '${agentName}' from ${source}; supported keys: model, effort, variant, model_provider, profile, model_reasoning_effort, model_verbosity`,
    );
  }

  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(
      `unsupported Codex model config value for key '${key}' on agent '${agentName}'; expected string, number, or boolean`,
    );
  }

  output[translated] = value;
};

const composeModelConfig = (agent: ComposedAgent): Record<string, unknown> => {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(agent.model ?? {})) {
    setCodexModelValue(output, "model", key, value, agent.name);
  }

  const override = agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(override ?? {})) {
    setCodexModelValue(output, "codex-cli override", key, value, agent.name);
  }

  return output;
};

const mcpToolNamesForAgent = (sourcePluginName: string, agent: ComposedAgent): string[] =>
  uniqueSorted(
    agent.toolBindings.map((binding) => mcpToolNameForBinding(sourcePluginName, binding)),
  );

const renderCodexMcpServerToml = (options: {
  readonly name: string;
  readonly runtime: ResolvedMcpRuntime;
  readonly enabledTools: ReadonlyArray<string>;
}): string[] => {
  return [
    tomlDottedTable(["mcp_servers", options.name]),
    `url = ${quote(renderMcpHttpUrl(options.runtime))}`,
    "enabled = true",
    "required = false",
    'default_tools_approval_mode = "approve"',
    `enabled_tools = ${tomlArray(options.enabledTools)}`,
  ];
};

const renderAgentToml = (
  agent: ComposedAgent,
  target: CodexCliLowerTarget,
  mcpServer?: AgentMcpServerConfig,
): string => {
  const developerInstructions = agent.allowedSkills.length > 0
    ? `${agent.body}\n\n## Prism Skills\nUse these installed skills when they match the task: ${uniqueSorted(agent.allowedSkills).join(", ")}.`
    : agent.body;
  const lines = [
    `name = ${quote(agent.name)}`,
    `description = ${quote(agent.description)}`,
    `developer_instructions = ${quote(developerInstructions)}`,
  ];

  for (const [key, value] of Object.entries(composeModelConfig(agent)).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const scalar = renderTomlScalar(key, value);
    if (scalar) lines.push(scalar);
  }

  if (agent.allowedTools.length > 0) {
    lines.push(
      "",
      "# prism diagnostic: Codex has no direct equivalent for harness-native per-role tool allowlists.",
      `# Native tool bindings requested by source traits: ${agent.allowedTools.join(", ")}`,
    );
  }

  const mcpToolNames = mcpToolNamesForAgent(target.sourcePluginName, agent);
  if (mcpServer && mcpToolNames.length > 0) {
    lines.push(
      "",
      ...renderCodexMcpServerToml({
        ...mcpServer,
        enabledTools: mcpToolNames,
      }),
    );
  }

  return `${lines.join("\n")}\n`;
};

const renderRules = async (input: LowerInput): Promise<string | undefined> => {
  const pluginRoot = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginRoot || !artifactTargetsCodex(input.registry, "rules")) return undefined;

  const files = (await collectArtifactSourceFiles(pluginRoot, "rules", TARGET_ID))
    .filter((file) => file.relativePath.endsWith(".md"))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  if (files.length === 0) return undefined;

  const chunks: string[] = [];
  for (const file of files) {
    chunks.push(
      `<!-- prism:rules source=${quote(file.relativePath)} -->`,
      (await readFile(file.sourcePath)).trimEnd(),
    );
  }

  return `${chunks.join("\n\n")}\n`;
};

const codexNativeHookEvent = (event: Hook["event"]): string =>
  nativeHookEventName(event, {
    toolBefore: "PreToolUse",
    toolAfter: "PostToolUse",
    promptSubmit: "UserPromptSubmit",
    permissionRequest: "PermissionRequest",
    sessionStart: "SessionStart",
    sessionEnd: "Stop",
  });

const collectCanonicalToolNames = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyMap<string, string> =>
  collectBindingNameMap(bindings, (binding) =>
    mcpToolNameForBinding(sourcePluginName, binding),
  );

const hookMatcher = (
  nativeEvent: string,
  resolved: ResolvedHookMatch,
  canonicalToolNames: ReadonlyMap<string, string>,
): string | undefined => {
  const tool = resolved.tool;
  if (nativeEvent === "Stop" || nativeEvent === "SessionStart" || nativeEvent === "UserPromptSubmit" || !tool) return undefined;
  if (tool.kind === "any") return "*";
  if (tool.kind === "canonical-tool") return canonicalToolNames.get(tool.ref) ?? tool.ref;
  if (tool.names.length === 1) return regexEscape(tool.names[0]!);
  return tool.names.map(regexEscape).join("|");
};

const renderHookWrapperEntry = (
  hook: Hook,
  nativeEvent: string,
  hookRuntimePath: string,
): string => {
  const supportsAdditionalContext =
    nativeEvent === "SessionStart" ||
    nativeEvent === "PostToolUse" ||
    nativeEvent === "UserPromptSubmit";

  return renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    harness: TARGET_ID,
    nativeEvent,
    cwdExpression: "input?.cwd",
    fallbackSessionId: TARGET_ID,
    toolAfterOutputExpression:
      "input?.tool?.output ?? input?.tool_response ?? input?.toolResponse ?? input?.toolOutput ?? input?.tool_output ?? input?.output ?? input?.result",
    resultHandlingSource: `const writeHookJson = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const output = {};
if (result.systemMessage) output.systemMessage = result.systemMessage;
if (${JSON.stringify(supportsAdditionalContext)} && result.additionalContext) {
  output.hookSpecificOutput = {
    hookEventName: ${JSON.stringify(nativeEvent)},
    additionalContext: result.additionalContext,
  };
}
if (${JSON.stringify(hook.event)} === "tool.before" && result.decision === "block") {
  output.hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: result.message,
  };
}
if (${JSON.stringify(hook.event)} === "permission.request" && result.decision === "block") {
  output.hookSpecificOutput = {
    hookEventName: "PermissionRequest",
    decision: {
      behavior: "deny",
      message: result.message,
    },
  };
}
if (${JSON.stringify(hook.event)} === "permission.request" && result.decision === "allow") {
  output.hookSpecificOutput = {
    hookEventName: "PermissionRequest",
    decision: {
      behavior: "allow",
    },
  };
}
if (Object.keys(output).length > 0) writeHookJson(output);`,
  });
};

const bundleHookWrapper = async (hook: Hook, nativeEvent: string): Promise<string> => {
  return bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-codex-hook-",
    buildLabel: `Codex '${hook.name}'`,
    renderEntry: (currentHook, hookRuntimePath) =>
      renderHookWrapperEntry(currentHook, nativeEvent, hookRuntimePath),
  });
};

const planHooks = async (
  input: LowerInput,
  files: DesiredFile[],
): Promise<PlannedHook[]> => {
  const hooks = [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  if (!input.registry) return [];

  const canonicalToolNames = collectCanonicalToolNames(
    input.target.sourcePluginName,
    mcpBindingsForAgentsAndTools(
      input.target.sourcePluginName,
      input.tools,
      input.agents,
    ),
  );
  const plannedHooks: PlannedHook[] = [];

  for (const hook of hooks) {
    const nativeEvent = codexNativeHookEvent(hook.event);
    const resolved = await Effect.runPromise(resolveHookMatchForTarget(hook, input.registry, TARGET_ID));
    const relativePath = `hooks/${normalizeBundleSegment(hook.name, "hook")}.mjs`;

    pushDesiredFile(files, {
      targetPath: join(input.target.root, ...relativePath.split("/")),
      content: await bundleHookWrapper(hook, nativeEvent),
      plugin: input.target.sourcePluginName,
    });

    plannedHooks.push({
      hook,
      nativeEvent,
      matcher: hookMatcher(nativeEvent, resolved, canonicalToolNames),
      relativePath,
    });
  }

  return plannedHooks;
};

const renderHooksConfig = (
  root: string,
  hooks: ReadonlyArray<PlannedHook>,
): string[] =>
  hooks.flatMap((hook) => [
    tomlDottedArrayTable(["hooks", hook.nativeEvent]),
    ...(hook.matcher ? [`matcher = ${quote(hook.matcher)}`] : []),
    tomlDottedArrayTable(["hooks", hook.nativeEvent, "hooks"]),
    'type = "command"',
    `command = ${quote(`node ${quote(join(root, ...hook.relativePath.split("/")))}`)}`,
    "timeout = 600",
    `statusMessage = ${quote(`prism hook ${hook.hook.name}`)}`,
    "",
  ]);

const planMcpServer = (
  input: LowerInput,
): {
  mcpServerName?: string;
  mcpRuntime?: ResolvedMcpRuntime;
  toolNames: string[];
  globalToolNames: string[];
} => {
  const bindings = mcpBindingsForAgentsAndTools(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, {
    requirePort: bindings.length > 0,
    resolvedPort: input.target.mcpRuntimePort,
  });
  if (bindings.length === 0) return { toolNames: [], globalToolNames: [] };

  const mcpServerName = generatedMcpServerName(input.target.sourcePluginName);
  return {
    mcpServerName,
    mcpRuntime: runtime,
    toolNames: uniqueSorted(
      mcpToolNamesForBindings(input.target.sourcePluginName, bindings),
    ),
    globalToolNames: uniqueSorted(
      bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools ?? []).map((binding) =>
        mcpToolNameForBinding(input.target.sourcePluginName, binding),
      ),
    ),
  };
};

type PlannedMcpServer = ReturnType<typeof planMcpServer>;

const agentMcpServerConfig = (mcp: PlannedMcpServer): AgentMcpServerConfig | undefined =>
  mcp.mcpServerName && mcp.mcpRuntime
    ? {
        name: mcp.mcpServerName,
        runtime: mcp.mcpRuntime,
      }
    : undefined;

const planAgentWrites = (
  input: LowerInput,
  files: DesiredFile[],
  agentMcpServer?: AgentMcpServerConfig,
): void => {
  for (const agent of input.agents) {
    pushDesiredFile(files, {
      targetPath: join(input.target.root, "agents", `${agent.name}.toml`),
      content: renderAgentToml(agent, input.target, agentMcpServer),
      plugin: input.target.sourcePluginName,
    });
  }
};

const planManagedSkillWrites = async (
  input: LowerInput,
  files: DesiredFile[],
): Promise<void> => {
  if (!artifactTargetsCodex(input.registry, "skills")) return;

  for (const skill of input.skills ?? []) {
    pushDesiredFile(files, {
      targetPath: join(input.target.root, "skills", skill.name, "SKILL.md"),
      content: await readFile(skill.sourcePath),
      plugin: input.target.sourcePluginName,
    });
  }
};

const planOrbitWrites = (
  input: LowerInput,
  files: DesiredFile[],
): void => {
  for (const orbit of input.orbits) {
    pushDesiredFile(files, {
      targetPath: join(input.target.root, "skills", `${orbit.name}/SKILL.md`),
      content: renderStandardOrbitSkill(orbit, input.registry),
      plugin: input.target.sourcePluginName,
    });

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      pushDesiredFile(files, {
        targetPath: join(
          input.target.root,
          "skills",
          `${orbit.name}/references/${reference.filename}`,
        ),
        content: reference.content,
        plugin: input.target.sourcePluginName,
      });
    }
  }
};

const planRulesWrite = async (
  input: LowerInput,
  files: DesiredFile[],
): Promise<void> => {
  const rules = await renderRules(input);
  if (rules) {
    pushDesiredFile(files, {
      targetPath: join(input.target.root, "AGENTS.md"),
      content: rules,
      plugin: input.target.sourcePluginName,
    });
  }
};

/**
 * config.toml is user-shared; Prism owns only fenced fragments inside it
 * (one region per concern per plugin, sync-engine marker grammar):
 *  - the plugin's `["mcp_servers"."<name>"]` table (enabled_tools inside),
 *  - the plugin's hook registrations (`[[hooks.<Event>]]` array tables),
 *  - `hooks = true` inside the user's `[features]` table, anchored to the
 *    `[features]` header so a duplicate table is never created. The region
 *    key is shared across plugins (the flag is a single TOML key — per-plugin
 *    fences would emit duplicate `hooks` keys, which is invalid TOML).
 */
const planConfigRegions = (
  input: LowerInput,
  mcp: PlannedMcpServer,
  hooks: ReadonlyArray<PlannedHook>,
): DesiredRegion[] => {
  const configTarget = join(input.target.root, "config.toml");
  const plugin = input.target.sourcePluginName;
  const regions: DesiredRegion[] = [];

  if (mcp.mcpServerName && mcp.mcpRuntime && mcp.globalToolNames.length > 0) {
    regions.push({
      kind: "marker",
      targetPath: configTarget,
      regionKey: `codex.mcp.${mcp.mcpServerName}`,
      commentPrefix: "#",
      content: renderCodexMcpServerToml({
        name: mcp.mcpServerName,
        runtime: mcp.mcpRuntime,
        enabledTools: mcp.globalToolNames,
      }).join("\n"),
      plugin,
    });
  }

  if (hooks.length > 0) {
    regions.push({
      kind: "marker",
      targetPath: configTarget,
      regionKey: `codex.hooks.${normalizeBundleSegment(plugin)}`,
      commentPrefix: "#",
      content: renderHooksConfig(input.target.root, hooks).join("\n").trimEnd(),
      plugin,
    });
    regions.push({
      kind: "marker",
      targetPath: configTarget,
      regionKey: "codex.features.hooks",
      commentPrefix: "#",
      anchor: "[features]",
      content: "hooks = true",
      skipIfTomlScalarExists: { table: "features", key: "hooks", value: true },
      plugin,
    });
  }

  return regions;
};

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const files: DesiredFile[] = [];
  const mcp = planMcpServer(input);

  planAgentWrites(input, files, agentMcpServerConfig(mcp));
  await planManagedSkillWrites(input, files);
  planOrbitWrites(input, files);
  await planRulesWrite(input, files);
  const hooks = await planHooks(input, files);
  const regions = planConfigRegions(input, mcp, hooks);

  return { files, regions };
};
