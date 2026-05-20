/** Codex CLI lowerer. */

import { join } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import {
  generateMcpServerBundle,
  mcpToolNameForBinding,
} from "../mcp-bundle.js";
import {
  generatedMcpServerName,
  mcpServerBundleRuntimeOptions,
  renderMcpBearerAuthorization,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  runtimeMcpServerDescriptor,
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
import {
  exists,
  readFile,
} from "../../fs.js";
import type { HarnessScope, PluginArtifactType, PluginTargetId } from "../../types.js";
import type { LowerOperation } from "./opencode.js";
import {
  bundleGeneratedHookWrapper,
  executeStandardLowering,
  nativeHookEventName,
  normalizeBundleSegment,
  pushWriteOperation as pushWrite,
  regexEscape,
  renderPrePostSessionHookWrapperEntry,
  renderStandardOrbitSkill,
  uniqueSorted,
} from "./shared.js";

const TARGET_ID = "codex-cli" as const;

export interface CodexCliLowerTarget {
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
  readonly bearerToken?: string;
  readonly bundlePath?: string;
  readonly root: string;
}

const quote = (value: string): string => JSON.stringify(value);

const tomlArray = (values: ReadonlyArray<string>): string =>
  `[${values.map((value) => quote(value)).join(", ")}]`;

const tomlDottedTable = (segments: ReadonlyArray<string>): string =>
  `[${segments.map((segment) => quote(segment)).join(".")}]`;

const tomlDottedArrayTable = (segments: ReadonlyArray<string>): string =>
  `[[${segments.map((segment) => quote(segment)).join(".")}]]`;

const isTomlTableHeader = (line: string): boolean => /^\s*\[.*\]\s*(?:#.*)?$/u.test(line);

const isFeaturesTableHeader = (line: string): boolean => /^\s*\[features\]\s*(?:#.*)?$/u.test(line);

const isCodexHooksFeature = (line: string): boolean => /^\s*codex_hooks\s*=/u.test(line);

const isHooksFeature = (line: string): boolean => /^\s*hooks\s*=/u.test(line);

const managedBlockBegin = (pluginName: string): string =>
  `# --- prism codex-cli begin: ${pluginName} ---`;

const managedBlockEnd = (pluginName: string): string =>
  `# --- prism codex-cli end: ${pluginName} ---`;

/**
 * Name-based removal of any `["mcp_servers"."prism-generated-..."]` dotted table.
 * Used as the deletion half of our structural ownership strategy.
 */
export const removeMcpServerTable = (current: string, serverName: string): string => {
  if (!serverName) return current;

  const header = new RegExp(
    `^\\s*\\["mcp_servers"\\s*\\.\\s*["']${regexEscape(serverName)}["']\\s*\\]\\s*(?:#.*)?$`,
    "u",
  );

  const lines = current.split(/\r?\n/u);
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (header.test(line)) {
      i += 1;
      while (i < lines.length) {
        const nextLine = lines[i] ?? "";
        const trimmed = nextLine.trim();
        if (!trimmed) { i += 1; continue; }
        if (isTomlTableHeader(nextLine)) break;
        if (/^[A-Za-z0-9_.-]+\s*=/u.test(trimmed)) break;
        i += 1;
      }
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
};

/**
 * Structural mcp_servers update for Codex config.toml using Bun.TOML.parse
 * for reliable understanding of the document + name-based delete + controlled insert.
 *
 * This is the "proper TOML" ownership path. The generated table lives as a normal
 * top-level TOML entry (not inside a Prism comment marker block).
 */
export const countMcpServerTableOccurrences = (content: string, serverName: string): number => {
  if (!serverName) return 0;
  const header = new RegExp(
    `^\\s*\\["mcp_servers"\\s*\\.\\s*["']${regexEscape(serverName)}["']\\s*\\]`,
    "gmu",
  );
  return (content.match(header) ?? []).length;
};

export const applyCodexMcpServerUpdate = (
  current: string,
  serverName: string | undefined,
  renderedTable: string | undefined, // the full ["mcp_servers"."name"]... block text, or undefined = delete only
): string => {
  if (!serverName) return current;

  // Deletion is always safe and name-driven.
  let text = removeMcpServerTable(current, serverName);

  if (!renderedTable) return text;

  // Insertion point: before the first Prism hook marker block if present,
  // otherwise at end of file. This keeps mcp entries in the natural TOML area.
  const hookBlock = text.indexOf("# --- prism codex-cli begin:");
  if (hookBlock >= 0) {
    const prefix = text.slice(0, hookBlock).trimEnd();
    const suffix = text.slice(hookBlock);
    return `${prefix}\n\n${renderedTable.trimEnd()}\n\n${suffix}`;
  }

  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n\n${renderedTable.trimEnd()}\n` : `${renderedTable.trimEnd()}\n`;
};

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
  readonly bearerToken?: string;
  readonly bundlePath?: string;
  readonly root: string;
  readonly enabledTools: ReadonlyArray<string>;
}): string[] => {
  const transportLines = options.runtime.transport === "streamable-http"
    ? [
        `url = ${quote(renderMcpHttpUrl(options.runtime))}`,
        ...(options.bearerToken
          ? [
              `http_headers = { Authorization = ${quote(renderMcpBearerAuthorization({
                tokenEnv: options.runtime.tokenEnv,
                token: options.bearerToken,
              }))} }`,
            ]
          : [`bearer_token_env_var = ${quote(options.runtime.tokenEnv)}`]),
      ]
    : [
        'command = "bun"',
        `args = ${tomlArray([options.bundlePath ?? missingCodexMcpBundlePath()])}`,
        `cwd = ${quote(options.root)}`,
      ];

  return [
    tomlDottedTable(["mcp_servers", options.name]),
    ...transportLines,
    "enabled = true",
    "required = false",
    'default_tools_approval_mode = "approve"',
    `enabled_tools = ${tomlArray(options.enabledTools)}`,
  ];
};

const missingCodexMcpBundlePath = (): never => {
  throw new Error("Codex stdio MCP config requires a generated bundle path.");
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
  if (nativeEvent === "Stop" || !tool) return undefined;
  if (tool.kind === "any") return "*";
  if (tool.kind === "canonical-tool") return canonicalToolNames.get(tool.ref) ?? tool.ref;
  if (tool.names.length === 1) return regexEscape(tool.names[0]!);
  return tool.names.map(regexEscape).join("|");
};

const renderHookWrapperEntry = (
  hook: Hook,
  nativeEvent: string,
  hookRuntimePath: string,
): string =>
  renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    harness: TARGET_ID,
    nativeEvent,
    cwdExpression: "input?.cwd",
    fallbackSessionId: TARGET_ID,
    toolAfterOutputExpression:
      "input?.tool?.output ?? input?.tool_response ?? input?.toolResponse ?? input?.toolOutput ?? input?.tool_output ?? input?.output ?? input?.result",
    blockDecisionSource: `  console.error(result.message);
  process.exit(2);`,
  });

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
  operations: LowerOperation[],
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

    await pushWrite(
      operations,
      join(input.target.root, ...relativePath.split("/")),
      await bundleHookWrapper(hook, nativeEvent),
    );

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

export const replaceManagedBlock = (current: string, pluginName: string, block: string): string => {
  const begin = managedBlockBegin(pluginName);
  const end = managedBlockEnd(pluginName);
  const start = current.indexOf(begin);
  let base = current;

  if (start >= 0) {
    const finish = current.indexOf(end, start);
    if (finish >= 0) {
      base = current.slice(0, start) + current.slice(finish + end.length);
    }
  }

  const trimmedBase = base.trimEnd();
  return `${trimmedBase}${trimmedBase ? "\n\n" : ""}${begin}\n${block.trimEnd()}\n${end}\n`;
};

const renderConfigWithHookFeature = (current: string, enableHooks: boolean): string => {
  const lines = current.split(/\r?\n/u);
  const featuresStart = lines.findIndex(isFeaturesTableHeader);

  if (featuresStart < 0) {
    if (!enableHooks) {
      return lines.filter((line) => !isCodexHooksFeature(line)).join("\n");
    }

    const trimmed = current.trimEnd();
    return `${trimmed}${trimmed ? "\n\n" : ""}[features]\nhooks = true\n`;
  }

  let featuresEnd = lines.length;
  for (let index = featuresStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && isTomlTableHeader(line)) {
      featuresEnd = index;
      break;
    }
  }

  const before = lines.slice(0, featuresStart);
  const featureLines = lines.slice(featuresStart, featuresEnd).filter((line) => !isCodexHooksFeature(line));
  const after = lines.slice(featuresEnd);
  const hooksLine = featureLines.findIndex(isHooksFeature);

  if (enableHooks) {
    if (hooksLine >= 0) {
      featureLines[hooksLine] = "hooks = true";
    } else {
      featureLines.splice(1, 0, "hooks = true");
    }
  }

  return [...before, ...featureLines, ...after].join("\n");
};

const renderManagedConfigBlock = (options: {
  readonly root: string;
  readonly hooks: ReadonlyArray<PlannedHook>;
}): string => {
  // mcp_servers tables are now emitted structurally via applyCodexMcpServerUpdate
  // (Bun.TOML.parse for understanding + name-based delete/insert).
  // The marker block is kept only for hook registrations.
  const lines: string[] = [];
  lines.push(...renderHooksConfig(options.root, options.hooks));
  return lines.join("\n");
};

const planMcpServer = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<{
  mcpServerName?: string;
  mcpBundlePath?: string;
  mcpRuntime?: ResolvedMcpRuntime;
  mcpBearerToken?: string;
  toolNames: string[];
  globalToolNames: string[];
}> => {
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, { requirePort: true });
  const bindings = mcpBindingsForAgentsAndTools(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  if (bindings.length === 0) return { toolNames: [], globalToolNames: [] };

  const mcpServerName = generatedMcpServerName(input.target.sourcePluginName);
  const bundle = await generateMcpServerBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath,
    serverName: mcpServerName,
    version: input.target.sourcePluginVersion,
    bundleId: mcpServerName,
    ...mcpServerBundleRuntimeOptions(runtime),
    bindings,
  });

  const serverTarget = runtime.transport === "streamable-http"
    ? runtimeMcpServerDescriptor(
        input.target.mcpRuntimeRoot ?? input.target.root,
        input.target.sourcePluginName,
      ).absolutePath
    : join(input.target.root, ...bundle.relativePath.split("/"));

  await pushWrite(
    operations,
    serverTarget,
    bundle.content,
  );

  return {
    mcpServerName,
    ...(runtime.transport === "stdio" ? { mcpBundlePath: bundle.relativePath } : {}),
    mcpRuntime: runtime,
    ...(input.target.mcpBearerToken ? { mcpBearerToken: input.target.mcpBearerToken } : {}),
    toolNames: uniqueSorted(bundle.toolNames),
    globalToolNames: uniqueSorted(
      bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools ?? []).map((binding) =>
        mcpToolNameForBinding(input.target.sourcePluginName, binding),
      ),
    ),
  };
};

type PlannedMcpServer = Awaited<ReturnType<typeof planMcpServer>>;

const agentMcpServerConfig = (
  input: LowerInput,
  mcp: PlannedMcpServer,
): AgentMcpServerConfig | undefined =>
  mcp.mcpServerName && mcp.mcpRuntime
    ? {
        name: mcp.mcpServerName,
        runtime: mcp.mcpRuntime,
        ...(mcp.mcpBearerToken ? { bearerToken: mcp.mcpBearerToken } : {}),
        ...(mcp.mcpBundlePath ? { bundlePath: mcp.mcpBundlePath } : {}),
        root: input.target.root,
      }
    : undefined;

const planAgentWrites = async (
  input: LowerInput,
  operations: LowerOperation[],
  agentMcpServer?: AgentMcpServerConfig,
): Promise<void> => {
  for (const agent of input.agents) {
    await pushWrite(
      operations,
      join(input.target.root, "agents", `${agent.name}.toml`),
      renderAgentToml(agent, input.target, agentMcpServer),
      "write-md",
      { mode: agentMcpServer?.bearerToken ? 0o600 : undefined },
    );
  }
};

const planManagedSkillWrites = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<void> => {
  if (!artifactTargetsCodex(input.registry, "skills")) return;

  for (const skill of input.skills ?? []) {
    await pushWrite(
      operations,
      join(input.target.root, "skills", skill.name, "SKILL.md"),
      await readFile(skill.sourcePath),
      "write-md",
    );
  }
};

const planOrbitWrites = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<void> => {
  for (const orbit of input.orbits) {
    await pushWrite(
      operations,
      join(input.target.root, "skills", orbit.name, "SKILL.md"),
      renderStandardOrbitSkill(orbit, input.target.sourcePluginName, input.registry),
      "write-md",
    );

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      await pushWrite(
        operations,
        join(
          input.target.root,
          "skills",
          orbit.name,
          "references",
          reference.filename,
        ),
        reference.content,
        "write-md",
      );
    }
  }
};

const planRulesWrite = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<void> => {
  const rules = await renderRules(input);
  if (rules) {
    await pushWrite(operations, join(input.target.root, "AGENTS.md"), rules, "write-md");
  }
};

const planConfigWrite = async (
  input: LowerInput,
  operations: LowerOperation[],
  mcp: PlannedMcpServer,
  hooks: ReadonlyArray<PlannedHook>,
): Promise<void> => {
  const configTarget = join(input.target.root, "config.toml");
  const currentConfig = (await exists(configTarget)) ? await readFile(configTarget) : "";
  const migratedConfig = renderConfigWithHookFeature(currentConfig, hooks.length > 0);

  // Structural mcp_servers handling (Bun.TOML.parse for understanding the document,
  // name-based delete via removeMcpServerTable, controlled insert outside markers).
  let afterMcpUpdate: string;
  if (mcp.mcpServerName && mcp.mcpRuntime && mcp.globalToolNames.length > 0) {
    const tableLines = renderCodexMcpServerToml({
      name: mcp.mcpServerName,
      runtime: mcp.mcpRuntime,
      ...(mcp.mcpBearerToken ? { bearerToken: mcp.mcpBearerToken } : {}),
      bundlePath: mcp.mcpBundlePath,
      root: input.target.root,
      enabledTools: mcp.globalToolNames,
    });
    afterMcpUpdate = applyCodexMcpServerUpdate(migratedConfig, mcp.mcpServerName, tableLines.join("\n"));
  } else if (mcp.mcpServerName) {
    // Delete any stale entry we may have left in a previous run.
    afterMcpUpdate = applyCodexMcpServerUpdate(migratedConfig, mcp.mcpServerName, undefined);
  } else {
    afterMcpUpdate = migratedConfig;
  }

  // The marker block is now hooks-only.
  const hookBlock = renderManagedConfigBlock({ root: input.target.root, hooks });

  await pushWrite(
    operations,
    configTarget,
    replaceManagedBlock(afterMcpUpdate, input.target.sourcePluginName, hookBlock),
    "write-plugin-file",
    { mode: mcp.globalToolNames.length > 0 && mcp.mcpBearerToken ? 0o600 : undefined },
  );
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const mcp = await planMcpServer(input, operations);

  await planAgentWrites(input, operations, agentMcpServerConfig(input, mcp));
  await planManagedSkillWrites(input, operations);
  await planOrbitWrites(input, operations);
  await planRulesWrite(input, operations);
  const hooks = await planHooks(input, operations);
  await planConfigWrite(input, operations, mcp, hooks);

  return operations;
};

export const executeLowering = executeStandardLowering;
