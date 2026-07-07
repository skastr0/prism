/**
 * Antigravity CLI plugin lowerer.
 *
 * Produces one compiler-owned plugin bundle under
 * <antigravity-root>/plugins/prism-generated-<source-plugin>/.
 */

import { join, relative } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import { mcpToolNameForBinding } from "../mcp-bundle.js";
import { pluginServerKey, renderPluginWire } from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit } from "../sources.js";
import {
  collectBindingNameMap,
  bindingsOwnedByPlugin,
  groupAgentToolBindingsByOwner,
  mcpBindingsForAgentsAndTools,
  ownerPluginForBinding,
} from "../tool-bindings.js";

import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import { readFile } from "../../fs.js";
import type { DesiredFile } from "../../sync/desired.js";
import {
  bundleGeneratedHookWrapper,
  nativeHookEventName,
  pushDesiredFile,
  renderPrePostSessionHookWrapperEntry,
  regexEscape,
  renderStandardOrbitSkill,
  serializeSimpleFrontmatter as serializeFrontmatter,
  uniqueSorted,
  type LowerOutput,
} from "./shared.js";

const TARGET_ID = "antigravity-cli" as const;
const PLUGIN_PREFIX = "prism-generated";

export interface AntigravityCliLowerTarget {
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
  readonly tools: ReadonlyArray<CanonicalTool>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: AntigravityCliLowerTarget;
}

const normalizeBundleSegment = (value: string, fallback = "plugin"): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

const pluginIdForPlugin = (pluginName: string): string =>
  `${PLUGIN_PREFIX}-${normalizeBundleSegment(pluginName)}`;

const pluginRoot = (target: AntigravityCliLowerTarget): string =>
  join(target.root, "plugins", pluginIdForPlugin(target.sourcePluginName));

const pluginRelativePath = (target: AntigravityCliLowerTarget, path: string): string =>
  relative(pluginRoot(target), path).replace(/\\/g, "/");

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

const composeAntigravityAgentFrontmatter = (agent: ComposedAgent, target: AntigravityCliLowerTarget): Record<string, unknown> => {
  const frontmatter: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
  };

  const override = agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;
  if (override) {
    if (typeof override.description === "string") frontmatter.description = override.description;
    if (typeof override.name === "string") frontmatter.name = override.name;
    if (typeof override.model === "string") frontmatter.model = override.model;
  }

  const generatedTools: string[] = [];
  for (const [ownerPlugin, bindings] of groupAgentToolBindingsByOwner(
    target.sourcePluginName,
    agent,
  )) {
    for (const binding of bindings) {
      generatedTools.push(antigravityMcpToolNameForBinding(ownerPlugin, binding));
    }
  }
  const tools = uniqueSorted([
    ...(Array.isArray(override?.tools) && override.tools.every((tool) => typeof tool === "string")
      ? override.tools
      : []),
    ...agent.allowedTools,
    ...generatedTools,
  ], { dropEmpty: true });
  if (tools.length > 0) frontmatter.tools = tools;

  const skills = uniqueSorted(agent.allowedSkills, { dropEmpty: true });
  if (skills.length > 0) frontmatter.skills = skills;

  return frontmatter;
};

const renderAntigravityAgentMarkdown = (agent: ComposedAgent, target: AntigravityCliLowerTarget): string =>
  `${serializeFrontmatter(composeAntigravityAgentFrontmatter(agent, target))}\n\n${agent.body}\n`;

const targetIncludesAntigravity = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsAntigravity = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesAntigravity(registry?.targets[artifact]);

const copyTargetedSkillArtifacts = async (
  input: LowerInput,
  files: DesiredFile[],
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsAntigravity(input.registry, "skills")) return;

  const sourceFiles = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of sourceFiles) {
    const target = join(pluginRoot(input.target), "skills", file.relativePath);
    pushDesiredFile(files, {
      targetPath: target,
      content: await readFile(file.sourcePath),
      plugin: input.target.sourcePluginName,
    });
  }
};

const collectContextFiles = async (input: LowerInput): Promise<ReadonlyArray<{ label: string; content: string }>> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsAntigravity(input.registry, "rules")) return [];

  const files = await collectArtifactSourceFiles(pluginPath, "rules", TARGET_ID);
  const selected = files
    .filter((file) => file.relativePath.endsWith(".md"))
    .filter((file) => file.relativePath.startsWith("global/") || file.relativePath.startsWith("project/"))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const contexts: Array<{ label: string; content: string }> = [];
  for (const file of selected) {
    contexts.push({ label: file.relativePath, content: (await readFile(file.sourcePath)).trim() });
  }
  return contexts;
};

const renderContext = (contexts: ReadonlyArray<{ label: string; content: string }>): string => {
  if (contexts.length === 1) return `${contexts[0]!.content}\n`;
  const lines: string[] = [];
  for (const context of contexts) {
    lines.push(`<!-- prism:context-source ${context.label} -->`, "", context.content, "");
  }
  return lines.join("\n");
};

/**
 * Antigravity's per-agent `tools:` frontmatter is a flat, cross-server
 * identifier space requiring a `mcp_<server>_<tool>` prefix (single
 * underscore, `mcp_` literal) to disambiguate which configured MCP server a
 * permission targets — this is Antigravity's own established convention
 * (predates the shim), not the generic `mcp__<server>__<tool>` shape the
 * per-plugin scheme's `renderPluginAllowlist` renders for Claude/Grok, so
 * this composes the prefix locally around the shared wire-name primitive
 * rather than calling `renderPluginAllowlist` directly.
 *
 * Per-plugin server scheme (operator-locked): the server segment is the
 * OWNER plugin's own `pluginServerKey` — never the aggregated
 * `prism-mcp-shim` key — and the tool segment is the owner's bare wire name
 * (the redundant own-plugin namespace stripped), byte-identical to what that
 * owner's own generated plugin bundle's per-plugin shim advertises for the
 * same binding.
 */
const antigravityMcpToolNameForBinding = (
  ownerPluginName: string,
  binding: ResolvedContractBinding,
): string =>
  `mcp_${pluginServerKey(ownerPluginName)}_${renderPluginWire("antigravity-cli", ownerPluginName, mcpToolNameForBinding(ownerPluginName, binding))}`;

const matcherForHook = (
  match: ResolvedHookMatch,
  canonicalToolNames: ReadonlyMap<string, string>,
): string | undefined => {
  const tool = match.tool;
  if (!tool) return undefined;
  if (tool.kind === "any") return ".*";
  if (tool.kind === "native-tools") {
    if (tool.names.length === 0) return undefined;
    if (tool.names.length === 1) return tool.names[0];
    return `^(?:${tool.names.map(regexEscape).join("|")})$`;
  }
  return canonicalToolNames.get(tool.ref) ?? tool.ref;
};

const antigravityHookEvent = (event: Hook["event"]): string =>
  nativeHookEventName(event, {
    toolBefore: "PreToolUse",
    toolAfter: "PostToolUse",
    sessionStart: "PreInvocation",
    sessionEnd: "Stop",
  });

const ANTIGRAVITY_HOOK_TOOL_INPUT_EXPRESSION =
  "input?.toolCall?.args ?? input?.tool?.input ?? input?.toolInput ?? input?.tool_input ?? input?.args ?? input?.arguments ?? {}";

const ANTIGRAVITY_HOOK_TOOL_AFTER_OUTPUT_EXPRESSION =
  "input?.tool?.output ?? input?.toolCall?.output ?? input?.tool_response ?? input?.toolResponse ?? input?.toolOutput ?? input?.tool_output ?? input?.output ?? input?.error";

const ANTIGRAVITY_HOOK_SESSION_SOURCE = `const nativeSession = (input) => {
  const id = input?.conversationId ?? input?.conversation_id ?? input?.session?.id ?? input?.sessionId ?? input?.session_id;
  const transcriptPath = input?.transcriptPath ?? input?.transcript_path;
  if (id === undefined && transcriptPath === undefined) return undefined;
  return {
    id: id === undefined ? undefined : String(id),
    transcriptPath: transcriptPath === undefined ? undefined : String(transcriptPath),
  };
};`;

const renderAntigravityHookResultHandling = (nativeEvent: string): string => `
const toAntigravityHookOutput = (nativeEvent, result) => {
  if (result.decision === "block") {
    return {
      decision: "deny",
      reason: result.message,
    };
  }

  if (nativeEvent === "PreToolUse") return { decision: "allow" };
  if (nativeEvent === "Stop") return { decision: "continue" };
  return {};
};

process.stdout.write(JSON.stringify(toAntigravityHookOutput(${JSON.stringify(nativeEvent)}, result)));`;

const renderAntigravityHookWrapperEntry = (
  hook: Hook,
  nativeEvent: string,
  hookRuntimePath: string,
  hookSourcePath: string,
): string =>
  renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    hookSourcePath,
    harness: TARGET_ID,
    nativeEvent,
    cwdExpression: "input?.cwd ?? input?.workspace?.cwd ?? input?.workspacePaths?.[0]",
    fallbackSessionId: TARGET_ID,
    nativeToolInputExpression: ANTIGRAVITY_HOOK_TOOL_INPUT_EXPRESSION,
    nativeSessionSource: ANTIGRAVITY_HOOK_SESSION_SOURCE,
    nativeSessionEndReasonExpression: "input?.terminationReason ?? input?.reason",
    toolAfterOutputExpression: ANTIGRAVITY_HOOK_TOOL_AFTER_OUTPUT_EXPRESSION,
    resultHandlingSource: renderAntigravityHookResultHandling(nativeEvent),
  });

const bundleHookWrapper = (hook: Hook, nativeEvent: string): Promise<string> =>
  bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-ag-hook-",
    buildLabel: `Antigravity '${hook.name}'`,
    renderEntry: (entryHook, hookRuntimePath, hookSourcePath) =>
      renderAntigravityHookWrapperEntry(entryHook, nativeEvent, hookRuntimePath, hookSourcePath),
  });

const planHooks = async (
  input: LowerInput,
  files: DesiredFile[],
): Promise<void> => {
  const hooks = [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  if (hooks.length === 0 || !input.registry || !artifactTargetsAntigravity(input.registry, "hooks")) return;

  const canonicalToolNames = collectBindingNameMap(
    mcpBindingsForAgentsAndTools(
      input.target.sourcePluginName,
      input.tools,
      input.agents,
    ),
    (binding) => {
      const owner = ownerPluginForBinding(input.target.sourcePluginName, binding);
      return antigravityMcpToolNameForBinding(owner, binding);
    },
  );
  const config: Record<string, Record<string, unknown>> = {};
  for (const hook of hooks) {
    const nativeEvent = antigravityHookEvent(hook.event);
    const resolved = await Effect.runPromise(resolveHookMatchForTarget(hook, input.registry, TARGET_ID));
    const wrapperRelativePath = `hooks/${normalizeBundleSegment(hook.name, "hook")}.mjs`;
    const wrapperTarget = join(pluginRoot(input.target), wrapperRelativePath);
    pushDesiredFile(files, {
      targetPath: wrapperTarget,
      content: await bundleHookWrapper(hook, nativeEvent),
      plugin: input.target.sourcePluginName,
    });

    const command = {
      type: "command",
      command: `node \"./${wrapperRelativePath}\"`,
    };
    const hookConfig = (config[hook.name] ??= {});
    if (nativeEvent === "PreToolUse" || nativeEvent === "PostToolUse") {
      const entry: Record<string, unknown> = { hooks: [command] };
      const matcher = matcherForHook(resolved, canonicalToolNames);
      if (matcher) entry.matcher = matcher;
      ((hookConfig[nativeEvent] as unknown[] | undefined) ??= []).push(entry);
    } else {
      ((hookConfig[nativeEvent] as unknown[] | undefined) ??= []).push(command);
    }
  }

  pushDesiredFile(files, {
    targetPath: join(pluginRoot(input.target), "hooks.json"),
    content: json(config),
    plugin: input.target.sourcePluginName,
  });
};

/**
 * Per-plugin server scheme (operator-locked): a generated plugin bundle
 * registers exactly ONE MCP server — its own, keyed by `pluginServerKey` —
 * and only when the source plugin OWNS generated tools. A consumer plugin
 * (agents referencing foreign owners' tools only) emits no server entry and
 * no `mcp_config.json` at all: the owner's own bundle registers the server,
 * and the consumer's agents name it via `mcp_<owner>_<tool>` frontmatter
 * entries (`antigravityMcpToolNameForBinding`).
 */
const planMcpServers = (input: LowerInput): Record<string, unknown> => {
  const ownedBindings = bindingsOwnedByPlugin(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  if (ownedBindings.length === 0) return {};

  const env: Record<string, string> = {
    PRISM_SHIM_PLUGINS: input.target.sourcePluginName,
    PRISM_SHIM_HARNESS: TARGET_ID,
    PRISM_SHIM_NAMING: "per-plugin",
  };
  if (input.target.mcpExposureProfile) {
    env.PRISM_SHIM_EXPOSURE = input.target.mcpExposureProfile;
  }
  return {
    [pluginServerKey(input.target.sourcePluginName)]: {
      command: "prism",
      args: ["mcp", "shim"],
      env,
    },
  };
};

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const files: DesiredFile[] = [];
  const plugin = input.target.sourcePluginName;
  const root = pluginRoot(input.target);

  const contextFiles = await collectContextFiles(input);
  if (contextFiles.length > 0) {
    pushDesiredFile(files, {
      targetPath: join(root, "rules", "context.md"),
      content: renderContext(contextFiles),
      plugin,
    });
  }

  for (const agent of input.agents) {
    pushDesiredFile(files, {
      targetPath: join(root, "agents", `${agent.name}.md`),
      content: renderAntigravityAgentMarkdown(agent, input.target),
      plugin,
    });
  }

  await copyTargetedSkillArtifacts(input, files);

  for (const orbit of input.orbits) {
    pushDesiredFile(files, {
      targetPath: join(root, "skills", orbit.name, "SKILL.md"),
      content: renderStandardOrbitSkill(orbit, input.registry),
      plugin,
    });

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      pushDesiredFile(files, {
        targetPath: join(root, "skills", orbit.name, "references", reference.filename),
        content: reference.content,
        plugin,
      });
    }
  }

  const mcpServers = await planMcpServers(input);
  await planHooks(input, files);

  const manifest: Record<string, unknown> = {
    name: pluginIdForPlugin(input.target.sourcePluginName),
    version: input.target.sourcePluginVersion ?? "0.1.0",
  };
  pushDesiredFile(files, {
    targetPath: join(root, "plugin.json"),
    content: json(manifest),
    plugin,
  });

  if (Object.keys(mcpServers).length > 0) {
    pushDesiredFile(files, {
      targetPath: join(root, "mcp_config.json"),
      content: json({ mcpServers }),
      plugin,
    });
  }

  return { files, regions: [] };
};
