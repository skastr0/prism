/**
 * Claude Code plugin-bundle lowerer.
 *
 * Produces one compiler-owned Claude skills-directory plugin bundle under
 * <claude-root>/skills/prism-generated-<source-plugin>/.
 */

import { join } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { resolveHookMatchForTarget } from "../hooks.js";
import {
  mcpToolNameForBinding,
} from "../mcp-bundle.js";
import {
  MCP_EXPOSURE_HEADER,
  generatedMcpServerName,
  generatedMcpWireServerName,
  mcpExposureProfileForTarget,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  resolveOwnerMcpRuntime,
  type McpHarnessTransportMode,
} from "../mcp-runtime.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  collectBindingNameMap,
  allReferencedBindingsByOwner,
  groupAgentToolBindingsByOwner,
  mcpBindingsForAgentsAndTools,
  ownerPluginForBinding,
} from "../tool-bindings.js";
import { listDirRecursive, readFile } from "../../fs.js";
import { resolveManifestTargets } from "../../manifest.js";
import type { HarnessScope, PluginTargetId } from "../../types.js";
import type { DesiredFile } from "../../sync/desired.js";
import {
  bundleGeneratedHookWrapper,
  createGeneratedPluginWritePusher,
  createGeneratedPluginPlanState,
  matcherForResolvedToolHook,
  normalizeBundleSegment,
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

const TARGET_ID = "claude-code" as const;
const GENERATED_PLUGIN_PREFIX = "prism-generated";

export interface ClaudeCodeLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly mcpExposureProfile?: string;
  readonly mcpRuntimePort?: number;
  /** Per-harness MCP transport rollout flag; defaults to `"http"` when absent. */
  readonly mcpTransport?: McpHarnessTransportMode;
  readonly prismHome?: string;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
  readonly sourcePluginPath?: string;
}

/**
 * `.mcp.json` server key for the aggregated stdio shim entry (`mcpTransport
 * === "stdio-shim"`). Fixed and singular — unlike http mode's one `p_<hash8>`
 * key per owner plugin, one shim process fronts every owner this generated
 * plugin references, so there is exactly one key to choose. Claude Code
 * builds each visible tool's permission string as `mcp__<this key>__<tool
 * name the server returns>`; the shim's own `tools/list` already returns
 * `p_<hash8>__<tool>` per owner (see `pluginWireNamespace` in
 * `@skastr0/prism-core/mcp/shim`), so that inner segment survives unchanged
 * regardless of what this outer key is named.
 */
const STDIO_SHIM_WIRE_NAME = "prism-mcp-shim";

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly tools?: ReadonlyArray<CanonicalTool>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: ClaudeCodeLowerTarget;
}

const generatedPluginId = (target: ClaudeCodeLowerTarget): string =>
  `${GENERATED_PLUGIN_PREFIX}-${normalizeBundleSegment(target.sourcePluginName)}`;

const generatedPluginRoot = (target: ClaudeCodeLowerTarget): string =>
  join(target.root, "skills", generatedPluginId(target));

const generatedPath = (target: ClaudeCodeLowerTarget, relativePath: string): string =>
  join(generatedPluginRoot(target), ...relativePath.split("/"));

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

const serializeFrontmatter = (values: Record<string, unknown>): string => {
  const lines = ["---"];
  const orderedKeys = [
    "name",
    "description",
    "model",
    "effort",
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

const unsupportedPluginAgentOverrideFields = (override: Record<string, unknown> | undefined): string[] => {
  if (!override) return [];
  return ["mcpServers", "hooks", "permissionMode"].filter((field) =>
    Object.prototype.hasOwnProperty.call(override, field),
  );
};

const renderUnsupportedOverrideDiagnostics = (
  unsupportedFields: ReadonlyArray<string>,
): string => {
  if (unsupportedFields.length === 0) return "";

  const bullets = unsupportedFields.map(
    (field) =>
      `- \`${field}\` is not supported on Claude plugin agents; prism kept a single plugin-bundle lower and did not emit a direct .claude fallback.`,
  );

  return `\n\n## Prism Claude Plugin Diagnostics\n\n${bullets.join("\n")}`;
};

const composeAgentFrontmatter = (
  agent: ComposedAgent,
  target: ClaudeCodeLowerTarget,
): Record<string, unknown> => {
  const override = agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;
  const model = agent.model ?? {};
  const generatedTools: string[] = [];
  for (const [ownerPlugin, bindings] of groupAgentToolBindingsByOwner(
    target.sourcePluginName,
    agent,
  )) {
    const ownerServerName = generatedMcpWireServerName(ownerPlugin);
    for (const binding of bindings) {
      generatedTools.push(
        claudeMcpPermissionNameForBinding(ownerPlugin, ownerServerName, binding),
      );
    }
  }
  // Claude Code treats a subagent's `tools:` frontmatter as an EXCLUSIVE allowlist
  // (docs: code.claude.com/docs/en/sub-agents — "exclusively allow"). Emitting a generated list
  // of only the agent's declared MCP/native tools therefore silently strips the built-in
  // Read/Write/Edit/Bash/Glob/Grep set, leaving the agent unable to do file or shell work —
  // unlike every other harness, where Prism's declared tools sit on top of the built-ins. Claude
  // has no "defaults + these" syntax without hardcoding the (version-drifting) built-in list, so
  // for generated agents we omit `tools:` entirely: the subagent inherits all built-ins plus the
  // MCP tools wired by `--mcp-config`/`--strict-mcp-config`. Per-agent fine-grained tool scoping
  // degrades to inherit-all on Claude. An explicit author `tools:`/`allowed-tools:` override still
  // emits an allowlist (opt-in; the author then owns including built-ins) and keeps the agent's
  // MCP/native bindings so they remain callable.
  const explicitTools = uniqueSorted([
    ...stringArray(override?.tools),
    ...stringArray(override?.["allowed-tools"]),
  ]);
  const tools = explicitTools.length > 0
    ? uniqueSorted([...explicitTools, ...agent.allowedTools, ...generatedTools])
    : [];

  return {
    name: agent.name,
    description: typeof override?.description === "string" ? override.description : agent.description,
    model:
      typeof override?.model === "string"
        ? override.model
        : typeof model.model === "string"
          ? model.model
          : "sonnet",
    effort:
      typeof override?.effort === "string"
        ? override.effort
        : typeof model.effort === "string"
          ? model.effort
          : typeof model.variant === "string"
            ? model.variant
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
  target: ClaudeCodeLowerTarget,
): string => {
  const override = agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;
  const diagnostics = renderUnsupportedOverrideDiagnostics(
    unsupportedPluginAgentOverrideFields(override),
  );

  return `${serializeFrontmatter(composeAgentFrontmatter(agent, target))}\n\n${agent.body}${diagnostics}\n`;
};

const claudeNativeHookEvent = prePostSessionNativeHookEvent;

const claudeMcpPermissionNameForBinding = (
  sourcePluginName: string,
  pluginId: string,
  binding: ResolvedContractBinding,
): string => `mcp__${pluginId}__${mcpToolNameForBinding(sourcePluginName, binding)}`;

const renderHooksJson = async (
  hooks: ReadonlyArray<Hook>,
  registry: PluginRegistry | undefined,
  target: ClaudeCodeLowerTarget,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): Promise<string> => {
  const groupedHooks: Record<string, unknown[]> = {};
  const canonicalToolNames = collectBindingNameMap(
    bindings,
    (binding) => {
      const owner = ownerPluginForBinding(target.sourcePluginName, binding);
      return claudeMcpPermissionNameForBinding(owner, generatedMcpWireServerName(owner), binding);
    },
  );

  for (const hook of hooks) {
    const event = claudeNativeHookEvent(hook.event);
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: "command",
          command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${hook.name}.mjs"`,
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
    nativeEvent: claudeNativeHookEvent(hook.event),
    cwdExpression: "input?.cwd ?? input?.workspace?.cwd",
    fallbackSessionId: TARGET_ID,
    blockDecisionSource: `  console.error(result.message);
  process.exit(2);`,
  });

const bundleHookWrapper = async (hook: Hook): Promise<string> => {
  return bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-claude-hook-",
    buildLabel: `Claude '${hook.name}'`,
    renderEntry: renderHookWrapperEntry,
  });
};

const pushWrite = createGeneratedPluginWritePusher(generatedPath);

const planCommands = async (
  input: LowerInput,
  files: DesiredFile[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
  const pluginRoot = input.target.sourcePluginPath;
  const commandTargets = input.registry?.targets.commands ?? [];
  const commandsTargetClaude = resolveManifestTargets(commandTargets as readonly PluginTargetId[]).includes(TARGET_ID);
  if (!pluginRoot || !commandsTargetClaude) return;

  const commandsRoot = join(pluginRoot, "commands");
  const commandFiles = (await listDirRecursive(commandsRoot))
    .filter((relativePath) => relativePath.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right));

  for (const relativePath of commandFiles) {
    pushWrite(
      files,
      desiredRelativePaths,
      input.target,
      `commands/${relativePath}`,
      await readFile(join(commandsRoot, ...relativePath.split("/"))),
    );
  }
};

const planMcpServer = async (
  input: LowerInput,
  files: DesiredFile[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
  const bindingsByOwner = allReferencedBindingsByOwner(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  if (bindingsByOwner.size === 0) return;

  if (input.target.mcpTransport === "stdio-shim") {
    // One shim process fans out to every owner plugin's daemon over UDS, so
    // there is exactly one entry here — no per-owner runtime/port resolution
    // needed at compile time; the shim resolves live daemons on demand.
    const env: Record<string, string> = {
      PRISM_SHIM_PLUGINS: [...bindingsByOwner.keys()].join(","),
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
          [STDIO_SHIM_WIRE_NAME]: {
            command: "prism",
            args: ["mcp", "shim"],
            env,
          },
        },
      }),
    );
    return;
  }

  const mcpServers: Record<string, unknown> = {};
  for (const [ownerPluginName, bindings] of bindingsByOwner) {
    const isSelf = ownerPluginName === input.target.sourcePluginName;
    const runtime = isSelf
      ? resolveMcpRuntime(input.registry, TARGET_ID, {
          requirePort: bindings.length > 0,
          resolvedPort: input.target.mcpRuntimePort,
        })
      : input.target.prismHome && input.registry
        ? await resolveOwnerMcpRuntime({
            prismHome: input.target.prismHome,
            registry: input.registry,
            targetId: TARGET_ID,
            ownerPluginName,
          })
        : undefined;
    if (!runtime) continue;

    const serverName = generatedMcpWireServerName(ownerPluginName);
    const exposureServerName = generatedMcpServerName(ownerPluginName);
    mcpServers[serverName] = {
      type: "http",
      url: renderMcpHttpUrl(runtime),
      headers: {
        [MCP_EXPOSURE_HEADER]: mcpExposureProfileForTarget(exposureServerName, TARGET_ID),
      },
    };
  }

  if (Object.keys(mcpServers).length === 0) return;

  pushWrite(
    files,
    desiredRelativePaths,
    input.target,
    ".mcp.json",
    json({ mcpServers }),
  );
};

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
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
    renderAgentMarkdown: (agent) => renderAgentMarkdown(agent, input.target),
  });
  await planGeneratedPluginSkillWrites({ input, state, pushWrite });
  await planStandardGeneratedPluginOrbitSkillWrites({
    input,
    state,
    pushWrite,
  });
  await planCommands(input, state.files, state.desiredRelativePaths);
  await planMcpServer(input, state.files, state.desiredRelativePaths);
  await planGeneratedPluginHookWrites({
    input,
    state,
    renderHooksJson,
    bundleHookWrapper,
    resolveTarget,
  });

  return { files: state.files, regions: [] };
};
