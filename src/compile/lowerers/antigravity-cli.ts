/**
 * Antigravity CLI plugin lowerer.
 *
 * Produces one compiler-owned plugin bundle under
 * <antigravity-root>/plugins/prism-generated-<source-plugin>/.
 */

import { basename, dirname, join, relative } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
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
import type { CanonicalTool, Hook, Orbit } from "../sources.js";
import {
  collectBindingNameMap,
  mcpBindingsForAgentsAndTools,
} from "../tool-bindings.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import {
  exists,
  listDirRecursive,
  readFile,
} from "../../fs.js";
import type { LowerOperation } from "./opencode.js";
import {
  bundleGeneratedHookWrapper,
  executeStandardLowering,
  nativeHookEventName,
  pushWriteOperation as pushWrite,
  renderPrePostSessionHookWrapperEntry,
  regexEscape,
  renderStandardOrbitSkill,
  serializeSimpleFrontmatter as serializeFrontmatter,
  uniqueSorted,
} from "./shared.js";

const TARGET_ID = "antigravity-cli" as const;
const PLUGIN_PREFIX = "prism-generated";

export interface AntigravityCliLowerTarget {
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

  const serverName = pluginIdForPlugin(target.sourcePluginName);
  const tools = uniqueSorted([
    ...(Array.isArray(override?.tools) && override.tools.every((tool) => typeof tool === "string")
      ? override.tools
      : []),
    ...agent.allowedTools,
    ...agent.toolBindings.map((binding) =>
      antigravityMcpToolNameForBinding(target.sourcePluginName, serverName, binding),
    ),
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
  operations: LowerOperation[],
  desired: Set<string>,
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsAntigravity(input.registry, "skills")) return;

  const files = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of files) {
    const target = join(pluginRoot(input.target), "skills", file.relativePath);
    const content = await readFile(file.sourcePath);
    desired.add(pluginRelativePath(input.target, target));
    await pushWrite(operations, target, content, file.relativePath.endsWith(".md") ? "write-md" : "write-plugin-file");
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

const antigravityMcpToolNameForBinding = (
  sourcePluginName: string,
  serverName: string,
  binding: ResolvedContractBinding,
): string => `mcp_${serverName}_${mcpToolNameForBinding(sourcePluginName, binding)}`;

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
): string =>
  renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
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
    renderEntry: (entryHook, hookRuntimePath) =>
      renderAntigravityHookWrapperEntry(entryHook, nativeEvent, hookRuntimePath),
  });

const planHooks = async (
  input: LowerInput,
  operations: LowerOperation[],
  desired: Set<string>,
): Promise<void> => {
  const hooks = [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  if (hooks.length === 0 || !input.registry || !artifactTargetsAntigravity(input.registry, "hooks")) return;

  const serverName = pluginIdForPlugin(input.target.sourcePluginName);
  const canonicalToolNames = collectBindingNameMap(
    mcpBindingsForAgentsAndTools(
      input.target.sourcePluginName,
      input.tools,
      input.agents,
    ),
    (binding) =>
      antigravityMcpToolNameForBinding(input.target.sourcePluginName, serverName, binding),
  );
  const config: Record<string, Record<string, unknown>> = {};
  for (const hook of hooks) {
    const nativeEvent = antigravityHookEvent(hook.event);
    const resolved = await Effect.runPromise(resolveHookMatchForTarget(hook, input.registry, TARGET_ID));
    const wrapperRelativePath = `hooks/${normalizeBundleSegment(hook.name, "hook")}.mjs`;
    const wrapperTarget = join(pluginRoot(input.target), wrapperRelativePath);
    desired.add(wrapperRelativePath);
    await pushWrite(operations, wrapperTarget, await bundleHookWrapper(hook, nativeEvent));

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

  const configTarget = join(pluginRoot(input.target), "hooks.json");
  desired.add("hooks.json");
  await pushWrite(operations, configTarget, json(config));
};

const planMcpBundle = async (
  input: LowerInput,
  operations: LowerOperation[],
  desired: Set<string>,
): Promise<Record<string, unknown>> => {
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, { requirePort: true });
  const bindings = mcpBindingsForAgentsAndTools(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  if (bindings.length === 0) return {};

  const pluginId = pluginIdForPlugin(input.target.sourcePluginName);
  const bundle = await generateMcpServerBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath,
    serverName: pluginId,
    version: input.target.sourcePluginVersion,
    bundleId: pluginId,
    ...mcpServerBundleRuntimeOptions(runtime),
    bindings,
  });

  const target = runtime.transport === "streamable-http"
    ? runtimeMcpServerDescriptor(
        input.target.mcpRuntimeRoot ?? input.target.root,
        input.target.sourcePluginName,
      ).absolutePath
    : join(pluginRoot(input.target), bundle.relativePath);
  if (runtime.transport === "stdio") desired.add(bundle.relativePath);
  await pushWrite(operations, target, bundle.content);

  return {
    [pluginId]: runtime.transport === "streamable-http"
      ? {
          serverUrl: renderMcpHttpUrl(runtime),
          headers: {
            Authorization: renderMcpBearerAuthorization({
              tokenEnv: runtime.tokenEnv,
              token: input.target.mcpBearerToken,
            }),
          },
        }
      : {
          command: "bun",
          args: [join(pluginRoot(input.target), bundle.relativePath)],
        },
  };
};

const planPluginPruning = async (
  target: AntigravityCliLowerTarget,
  desired: ReadonlySet<string>,
): Promise<LowerOperation[]> => {
  const root = pluginRoot(target);
  if (!(await exists(root))) return [];
  const existingFiles = (await listDirRecursive(root)).sort((left, right) => left.localeCompare(right));
  const operations: LowerOperation[] = [];
  for (const file of existingFiles) {
    if (desired.has(file)) continue;
    operations.push({
      kind: "prune-plugin-path",
      target: join(root, file),
      targetType: "file",
      reason: "stale",
    });
  }
  return operations;
};

const legacyGeminiExtensionRoot = (target: AntigravityCliLowerTarget): string | undefined => {
  const pluginId = pluginIdForPlugin(target.sourcePluginName);
  if (basename(target.root) === "antigravity-cli" && basename(dirname(target.root)) === ".gemini") {
    return join(dirname(target.root), "extensions", pluginId);
  }
  if (basename(target.root) === ".agents") {
    return join(dirname(target.root), ".gemini", "extensions", pluginId);
  }
  return undefined;
};

const planLegacyGeminiPruning = async (
  target: AntigravityCliLowerTarget,
): Promise<LowerOperation[]> => {
  const legacyRoot = legacyGeminiExtensionRoot(target);
  if (!legacyRoot || !(await exists(legacyRoot))) return [];
  return [{
    kind: "prune-plugin-path",
    target: legacyRoot,
    targetType: "dir",
    reason: "stale",
  }];
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const desired = new Set<string>();
  const root = pluginRoot(input.target);

  const contextFiles = await collectContextFiles(input);
  if (contextFiles.length > 0) {
    const target = join(root, "rules", "context.md");
    desired.add("rules/context.md");
    await pushWrite(operations, target, renderContext(contextFiles), "write-md");
  }

  for (const agent of input.agents) {
    const target = join(root, "agents", `${agent.name}.md`);
    desired.add(pluginRelativePath(input.target, target));
    await pushWrite(operations, target, renderAntigravityAgentMarkdown(agent, input.target), "write-md");
  }

  await copyTargetedSkillArtifacts(input, operations, desired);

  for (const orbit of input.orbits) {
    const target = join(root, "skills", orbit.name, "SKILL.md");
    desired.add(pluginRelativePath(input.target, target));
    await pushWrite(
      operations,
      target,
      renderStandardOrbitSkill(orbit, input.target.sourcePluginName, input.registry),
      "write-md",
    );

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      const referenceTarget = join(
        root,
        "skills",
        orbit.name,
        "references",
        reference.filename,
      );
      desired.add(pluginRelativePath(input.target, referenceTarget));
      await pushWrite(operations, referenceTarget, reference.content, "write-md");
    }
  }

  const mcpServers = await planMcpBundle(input, operations, desired);
  await planHooks(input, operations, desired);

  const manifest: Record<string, unknown> = {
    name: pluginIdForPlugin(input.target.sourcePluginName),
    version: input.target.sourcePluginVersion ?? "0.1.0",
  };

  const manifestTarget = join(root, "plugin.json");
  desired.add("plugin.json");
  await pushWrite(operations, manifestTarget, json(manifest));

  if (Object.keys(mcpServers).length > 0) {
    const mcpConfigTarget = join(root, "mcp_config.json");
    desired.add("mcp_config.json");
    await pushWrite(operations, mcpConfigTarget, json({ mcpServers }), "write-plugin-file", {
      mode: input.target.mcpBearerToken ? 0o600 : undefined,
    });
  }

  operations.push(...await planPluginPruning(input.target, desired));
  operations.push(...await planLegacyGeminiPruning(input.target));
  return operations;
};

export const executeLowering = executeStandardLowering;
