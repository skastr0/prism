/** Kimi Code plugin and hook lowerer. */

import { join } from "node:path";
import { Effect } from "effect";
import type { ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget } from "../hooks.js";
import {
  mcpToolNameForBinding,
  mcpToolNamesForBindings,
} from "../mcp-bundle.js";
import {
  generatedMcpServerName,
  MCP_EXPOSURE_HEADER,
  renderMcpHttpUrl,
  resolveMcpRuntime,
} from "../mcp-runtime.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  collectBindingNameMap,
  bindingsOwnedByPlugin,
  groupAgentToolBindingsByOwner,
  mcpBindingsForAgentsAndTools,
  ownerPluginForBinding,
  referencedBindingsByOwner,
} from "../tool-bindings.js";
import { generatedPluginIdForOwner } from "../generated-plugin.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import { readFile } from "../../fs.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { DesiredFile, DesiredRegion } from "../../sync/desired.js";
import {
  bundleGeneratedHookWrapper,
  createGeneratedPluginPlanState,
  createGeneratedPluginWritePusher,
  nativeHookEventName,
  normalizeBundleSegment,
  regexEscape,
  renderPrePostSessionHookWrapperEntry,
  renderStandardOrbitSkill,
  serializeSimpleFrontmatter as serializeFrontmatter,
  uniqueSorted,
  type LowerOutput,
} from "./shared.js";

const TARGET_ID = "kimi-code" as const;
const GENERATED_PLUGIN_PREFIX = "prism-generated";

export interface KimiCodeLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly mcpExposureProfile?: string;
  readonly mcpRuntimePort?: number;
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
  readonly target: KimiCodeLowerTarget;
}

interface PlannedHook {
  readonly hook: Hook;
  readonly nativeEvent: string;
  readonly matcher?: string;
  readonly relativePath: string;
}

interface PlannedMcpServer {
  readonly toolNames: ReadonlyArray<string>;
  readonly manifestEntry: Record<string, unknown>;
}

type PlannedMcpServers = ReadonlyMap<string, PlannedMcpServer>;

interface InstalledPluginRecord {
  readonly id: string;
  readonly root: string;
  readonly source: "local-path" | "zip-url" | "github";
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly originalSource?: string;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const quote = (value: string): string => JSON.stringify(value);

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:=@+-]+$/u.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;

const generatedPluginId = (target: KimiCodeLowerTarget): string =>
  `${GENERATED_PLUGIN_PREFIX}-${normalizeBundleSegment(target.sourcePluginName)}`;

const generatedPluginRoot = (target: KimiCodeLowerTarget): string =>
  join(target.root, "plugins", "managed", generatedPluginId(target));

const generatedPath = (target: KimiCodeLowerTarget, relativePath: string): string =>
  join(generatedPluginRoot(target), ...relativePath.split("/"));

const targetIncludesKimi = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsKimi = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesKimi(registry?.targets[artifact]);

const pushWrite = createGeneratedPluginWritePusher(generatedPath);

const roleSkillName = (agentName: string): string =>
  `prism-agent-${normalizeBundleSegment(agentName, "agent")}`;

const commandSkillName = (relativePath: string): string =>
  `prism-command-${normalizeBundleSegment(relativePath.replace(/\.md$/u, ""), "command")}`;

const KIMI_MCP_NAME_PREFIX = "mcp__";
const KIMI_MCP_NAME_SEPARATOR = "__";
const KIMI_MCP_MAX_QUALIFIED_LENGTH = 64;

// Mirrors Kimi Code's packages/agent-core/src/mcp/tool-naming.ts contract.
const sanitizeKimiMcpNamePart = (part: string): string =>
  part.replace(/[^a-zA-Z0-9_-]/gu, "_").replace(/_+/gu, "_");

const stableHash8 = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.codePointAt(index)!;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  return hash.toString(16).padStart(8, "0");
};

const qualifyKimiMcpToolName = (serverName: string, toolName: string): string => {
  const full = [
    KIMI_MCP_NAME_PREFIX,
    sanitizeKimiMcpNamePart(serverName),
    KIMI_MCP_NAME_SEPARATOR,
    sanitizeKimiMcpNamePart(toolName),
  ].join("");
  if (full.length <= KIMI_MCP_MAX_QUALIFIED_LENGTH) return full;

  const hash = stableHash8(full);
  const head = full.slice(0, KIMI_MCP_MAX_QUALIFIED_LENGTH - hash.length - 1);
  return `${head}_${hash}`;
};

const kimiPluginMcpRuntimeName = (pluginId: string, serverName: string): string =>
  `plugin-${pluginId}:${serverName}`;

const kimiMcpToolName = (
  serverName: string,
  sourcePluginName: string,
  binding: ResolvedContractBinding,
): string => {
  const pluginId = `${GENERATED_PLUGIN_PREFIX}-${normalizeBundleSegment(sourcePluginName)}`;
  return qualifyKimiMcpToolName(
    kimiPluginMcpRuntimeName(pluginId, serverName),
    mcpToolNameForBinding(sourcePluginName, binding),
  );
};

const installedPluginsPath = (target: KimiCodeLowerTarget): string =>
  join(target.root, "plugins", "installed.json");

/**
 * Deterministic stand-in for the install timestamp Kimi's own installer
 * writes. Compile output is a pure function of source — minting wall-clock
 * timestamps would make converged runs dirty, so the generated registration
 * carries a fixed epoch instead.
 */
const GENERATED_INSTALLED_AT = "1970-01-01T00:00:00.000Z";

const installedPluginRecord = (input: LowerInput): InstalledPluginRecord => {
  const originalSource = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  return {
    id: generatedPluginId(input.target),
    root: generatedPluginRoot(input.target),
    source: "local-path",
    enabled: true,
    installedAt: GENERATED_INSTALLED_AT,
    ...(originalSource ? { originalSource } : {}),
  };
};

const installedPluginRegions = (input: LowerInput): DesiredRegion[] => [
  {
    kind: "json-key",
    targetPath: installedPluginsPath(input.target),
    regionKey: "installed.version",
    jsonPath: ["version"],
    value: 1,
    plugin: input.target.sourcePluginName,
  },
  {
    kind: "json-array-member",
    targetPath: installedPluginsPath(input.target),
    regionKey: `installed.${generatedPluginId(input.target)}`,
    jsonPath: ["plugins"],
    value: installedPluginRecord(input),
    memberKey: ["id"],
    plugin: input.target.sourcePluginName,
  },
];

const renderSkill = (frontmatter: Record<string, unknown>, body: string): string =>
  `${serializeFrontmatter(frontmatter)}\n\n${body.trimEnd()}\n`;

const renderKimiAgentRoleSkill = (
  agent: ComposedAgent,
  target: KimiCodeLowerTarget,
): string => {
  const generatedTools: string[] = [];
  for (const [ownerPlugin, bindings] of groupAgentToolBindingsByOwner(
    target.sourcePluginName,
    agent,
  )) {
    const serverName = generatedMcpServerName(ownerPlugin);
    for (const binding of bindings) {
      generatedTools.push(kimiMcpToolName(serverName, ownerPlugin, binding));
    }
  }
  const tools = uniqueSorted(generatedTools, { dropEmpty: true });
  const nativeTools = uniqueSorted(agent.allowedTools, { dropEmpty: true });
  const skills = uniqueSorted([...agent.skills, ...agent.allowedSkills], { dropEmpty: true });

  const sections: string[] = [
    `# ${agent.name}`,
    "",
    "<!-- prism:kimi-agent-role -->",
    "",
    agent.body.trimEnd(),
  ];

  if (nativeTools.length > 0 || tools.length > 0 || skills.length > 0) {
    sections.push("", "## Kimi Role Surface");
    if (nativeTools.length > 0) {
      sections.push("", `Native tools requested by this role: ${nativeTools.map((tool) => `\`${tool}\``).join(", ")}.`);
    }
    if (tools.length > 0) {
      sections.push("", "Generated MCP tools for this role:");
      for (const tool of tools) sections.push(`- \`${tool}\``);
    }
    if (skills.length > 0) {
      sections.push("", `Related Kimi skills: ${skills.map((skill) => `\`${skill}\``).join(", ")}.`);
    }
  }

  return renderSkill(
    {
      name: roleSkillName(agent.name),
      description: `Prism compiled role for ${agent.description}`,
      type: "prompt",
      whenToUse: `When the user asks for the ${agent.name} Prism role or this role is assigned by an orbit/workflow.`,
      disableModelInvocation: false,
    },
    sections.join("\n"),
  );
};

const renderCommandSkill = (relativePath: string, content: string): string =>
  renderSkill(
    {
      name: commandSkillName(relativePath),
      description: `Prism command workflow from ${relativePath}`,
      type: "flow",
      whenToUse: `When the user explicitly asks to run the Prism command workflow ${relativePath}.`,
      disableModelInvocation: true,
    },
    `<!-- prism:kimi-command source=${quote(relativePath)} -->\n\n${content.trimEnd()}`,
  );

const collectContextFiles = async (input: LowerInput): Promise<Array<{ label: string; content: string }>> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsKimi(input.registry, "rules")) return [];

  const files = await collectArtifactSourceFiles(pluginPath, "rules", TARGET_ID);
  const contexts: Array<{ label: string; content: string }> = [];
  for (const file of files.filter((entry) => entry.relativePath.endsWith(".md"))) {
    contexts.push({
      label: file.relativePath,
      content: (await readFile(file.sourcePath)).trim(),
    });
  }
  return contexts.sort((left, right) => left.label.localeCompare(right.label));
};

const renderContextSkill = (contexts: ReadonlyArray<{ label: string; content: string }>): string =>
  renderSkill(
    {
      name: "prism-context",
      description: "Prism generated session-start context for this Kimi plugin",
      type: "prompt",
      whenToUse: "Loaded automatically at session start for Prism generated plugin context.",
      disableModelInvocation: true,
    },
    [
      "# Prism Context",
      "",
      "<!-- prism:kimi-context -->",
      "",
      ...contexts.flatMap((context) => [
        `<!-- prism:context-source ${context.label} -->`,
        "",
        context.content,
        "",
      ]),
    ].join("\n"),
  );

const planTargetedSkillWrites = async (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  files: DesiredFile[],
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsKimi(input.registry, "skills")) return;

  const sourceFiles = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of sourceFiles) {
    pushWrite(
      files,
      desiredRelativePaths,
      input.target,
      `skills/${file.relativePath}`,
      await readFile(file.sourcePath),
    );
  }
};

const planAgentRoleSkills = (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  files: DesiredFile[],
): void => {
  for (const agent of input.agents) {
    pushWrite(
      files,
      desiredRelativePaths,
      input.target,
      `skills/${roleSkillName(agent.name)}/SKILL.md`,
      renderKimiAgentRoleSkill(agent, input.target),
    );
  }
};

const planOrbitSkillWrites = (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  files: DesiredFile[],
): void => {
  for (const orbit of input.orbits) {
    pushWrite(
      files,
      desiredRelativePaths,
      input.target,
      `skills/${orbit.name}/SKILL.md`,
      renderStandardOrbitSkill(orbit, input.registry),
    );

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      pushWrite(
        files,
        desiredRelativePaths,
        input.target,
        `skills/${orbit.name}/references/${reference.filename}`,
        reference.content,
      );
    }
  }
};

const planCommandSkillWrites = async (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  files: DesiredFile[],
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsKimi(input.registry, "commands")) return;

  const sourceFiles = await collectArtifactSourceFiles(pluginPath, "commands", TARGET_ID);
  for (const file of sourceFiles.filter((entry) => entry.relativePath.endsWith(".md"))) {
    pushWrite(
      files,
      desiredRelativePaths,
      input.target,
      `skills/${commandSkillName(file.relativePath)}/SKILL.md`,
      renderCommandSkill(file.relativePath, await readFile(file.sourcePath)),
    );
  }
};

const planContextSkillWrite = (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  files: DesiredFile[],
  contexts: ReadonlyArray<{ label: string; content: string }>,
): void => {
  if (contexts.length === 0) return;
  pushWrite(
    files,
    desiredRelativePaths,
    input.target,
    "skills/prism-context/SKILL.md",
    renderContextSkill(contexts),
  );
};

const renderKimiMcpServerEntry = (options: {
  readonly runtime: ReturnType<typeof resolveMcpRuntime>;
  readonly exposureProfile?: string;
  readonly toolNames: ReadonlyArray<string>;
}): Record<string, unknown> => {
  const base = {
    enabled: true,
    enabledTools: options.toolNames,
    startupTimeoutMs: options.runtime.connectTimeoutMs,
    toolTimeoutMs: options.runtime.toolTimeoutMs,
  };
  const headers = {
    ...(options.exposureProfile
      ? { [MCP_EXPOSURE_HEADER]: options.exposureProfile }
      : {}),
  };
  const hasHeaders = Object.keys(headers).length > 0;

  return {
    ...base,
    url: renderMcpHttpUrl(options.runtime),
    ...(hasHeaders ? { headers } : {}),
  };
};

const ownerKimiManifestPath = (target: KimiCodeLowerTarget, ownerPluginName: string): string =>
  join(
    target.root,
    "plugins",
    "managed",
    generatedPluginIdForOwner(ownerPluginName),
    "kimi.plugin.json",
  );

const readOwnerKimiMcpServers = async (
  target: KimiCodeLowerTarget,
  sourcePluginName: string,
  agents: ReadonlyArray<ComposedAgent>,
): Promise<PlannedMcpServers> => {
  const referencedByOwner = referencedBindingsByOwner(sourcePluginName, agents);
  if (referencedByOwner.size === 0) return new Map();

  const servers = new Map<string, PlannedMcpServer>();
  for (const [owner, bindings] of referencedByOwner) {
    const path = ownerKimiManifestPath(target, owner);
    let raw: string;
    try {
      raw = await readFile(path);
    } catch (cause) {
      throw new Error(
        `Cannot reference tools from owner plugin '${owner}' because its generated Kimi plugin manifest is missing at ${path}. ` +
          `Compile the owner plugin for Kimi Code first.`,
        { cause },
      );
    }
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    if (!parsed.mcpServers) {
      throw new Error(
        `Owner plugin '${owner}' Kimi manifest at ${path} does not declare any MCP servers.`,
      );
    }
    const referencedToolNames = new Set(
      bindings.map((binding) => mcpToolNameForBinding(owner, binding)),
    );
    for (const [serverName, entry] of Object.entries(parsed.mcpServers)) {
      const ownerEnabledTools = Array.isArray(entry.enabledTools)
        ? entry.enabledTools.filter(
            (tool): tool is string =>
              typeof tool === "string" && referencedToolNames.has(tool),
          )
        : [];
      servers.set(serverName, {
        toolNames: ownerEnabledTools,
        manifestEntry: { ...entry, enabledTools: ownerEnabledTools },
      });
    }
  }
  return servers;
};

const planMcpServer = async (input: LowerInput): Promise<PlannedMcpServers> => {
  const ownedBindings = bindingsOwnedByPlugin(
    input.target.sourcePluginName,
    input.tools ?? [],
    input.agents,
  );
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, {
    requirePort: ownedBindings.length > 0,
    resolvedPort: input.target.mcpRuntimePort,
  });

  const ownerServers = await readOwnerKimiMcpServers(
    input.target,
    input.target.sourcePluginName,
    input.agents,
  );

  const servers = new Map<string, PlannedMcpServer>(ownerServers);
  if (ownedBindings.length > 0) {
    const serverName = generatedMcpServerName(input.target.sourcePluginName);
    const toolNames = uniqueSorted(
      mcpToolNamesForBindings(input.target.sourcePluginName, ownedBindings),
    );
    servers.set(serverName, {
      toolNames,
      manifestEntry: renderKimiMcpServerEntry({
        runtime,
        ...(input.target.mcpExposureProfile ? { exposureProfile: input.target.mcpExposureProfile } : {}),
        toolNames,
      }),
    });
  }

  return servers;
};

const kimiNativeHookEvent = (event: Hook["event"]): string =>
  nativeHookEventName(event, {
    toolBefore: "PreToolUse",
    toolAfter: "PostToolUse",
    sessionStart: "SessionStart",
    sessionEnd: "SessionEnd",
  });

const hookMatcher = (
  hook: Hook,
  nativeEvent: string,
  canonicalToolNames: ReadonlyMap<string, string>,
  registry: PluginRegistry | undefined,
): Promise<string | undefined> => Effect.runPromise(Effect.gen(function* () {
  if (!registry || nativeEvent === "SessionStart" || nativeEvent === "SessionEnd") return undefined;
  const resolved = yield* resolveHookMatchForTarget(hook, registry, TARGET_ID);
  const tool = resolved.tool;
  if (!tool) return undefined;
  if (tool.kind === "any") return ".*";
  if (tool.kind === "canonical-tool") return canonicalToolNames.get(tool.ref) ?? tool.ref;
  if (tool.names.length === 1) return regexEscape(tool.names[0]!);
  return `^(?:${tool.names.map(regexEscape).join("|")})$`;
}));

const renderKimiHookWrapperEntry = (
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
    cwdExpression: "input?.cwd",
    fallbackSessionId: TARGET_ID,
    nativeSessionEndReasonExpression: "input?.reason",
    toolAfterOutputExpression:
      "input?.tool?.output ?? input?.tool_output ?? input?.toolOutput ?? input?.output ?? input?.error",
    blockDecisionSource: `  console.error(result.message);
  process.exit(2);`,
  });

const bundleHookWrapper = (hook: Hook, nativeEvent: string): Promise<string> =>
  bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-kimi-hook-",
    buildLabel: `Kimi '${hook.name}'`,
    renderEntry: (currentHook, hookRuntimePath, hookSourcePath) =>
      renderKimiHookWrapperEntry(currentHook, nativeEvent, hookRuntimePath, hookSourcePath),
  });

const planHooks = async (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  files: DesiredFile[],
): Promise<PlannedHook[]> => {
  const bindings = mcpBindingsForAgentsAndTools(
    input.target.sourcePluginName,
    input.tools ?? [],
    input.agents,
  );
  const canonicalToolNames = collectBindingNameMap(bindings, (binding) => {
    const owner = ownerPluginForBinding(input.target.sourcePluginName, binding);
    const serverName = generatedMcpServerName(owner);
    return kimiMcpToolName(serverName, owner, binding);
  });

  const planned: PlannedHook[] = [];
  for (const hook of [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name))) {
    const nativeEvent = kimiNativeHookEvent(hook.event);
    const relativePath = `hooks/${normalizeBundleSegment(hook.name, "hook")}.mjs`;
    pushWrite(
      files,
      desiredRelativePaths,
      input.target,
      relativePath,
      await bundleHookWrapper(hook, nativeEvent),
      { mode: 0o755 },
    );
    planned.push({
      hook,
      nativeEvent,
      matcher: await hookMatcher(hook, nativeEvent, canonicalToolNames, input.registry),
      relativePath,
    });
  }
  return planned;
};

const renderHooksConfig = (
  target: KimiCodeLowerTarget,
  hooks: ReadonlyArray<PlannedHook>,
): string => {
  const lines: string[] = [];
  for (const hook of hooks) {
    lines.push(
      "[[hooks]]",
      `event = ${quote(hook.nativeEvent)}`,
      ...(hook.matcher ? [`matcher = ${quote(hook.matcher)}`] : []),
      `command = ${quote(`node ${shellQuote(generatedPath(target, hook.relativePath))}`)}`,
      "timeout = 600",
      "",
    );
  }
  return lines.join("\n").trimEnd();
};

const hooksConfigRegion = (
  input: LowerInput,
  hooks: ReadonlyArray<PlannedHook>,
): DesiredRegion | undefined => {
  if (hooks.length === 0) return undefined;
  return {
    kind: "marker",
    targetPath: join(input.target.root, "config.toml"),
    regionKey: `kimi.hooks.${normalizeBundleSegment(input.target.sourcePluginName)}`,
    commentPrefix: "#",
    content: renderHooksConfig(input.target, hooks),
    plugin: input.target.sourcePluginName,
  };
};

const renderManifest = (
  input: LowerInput,
  desiredRelativePaths: ReadonlySet<string>,
  contexts: ReadonlyArray<{ label: string; content: string }>,
  mcp: PlannedMcpServers,
): string => {
  const manifest: Record<string, unknown> = {
    name: generatedPluginId(input.target),
    version: input.target.sourcePluginVersion ?? "0.1.0",
    description: `Generated by prism from ${input.target.sourcePluginName}.`,
    interface: {
      displayName: `Prism: ${input.target.sourcePluginName}`,
      shortDescription: "Generated Prism Kimi Code plugin.",
    },
  };

  if ([...desiredRelativePaths].some((path) => path.startsWith("skills/"))) {
    manifest.skills = "./skills/";
  }
  if (contexts.length > 0 && desiredRelativePaths.has("skills/prism-context/SKILL.md")) {
    manifest.sessionStart = { skill: "prism-context" };
  }
  if (mcp.size > 0) {
    const mcpServers: Record<string, unknown> = {};
    for (const [serverName, entry] of mcp) {
      mcpServers[serverName] = entry.manifestEntry;
    }
    manifest.mcpServers = mcpServers;
  }

  return json(manifest);
};

const hasPluginOutput = (
  input: LowerInput,
  contexts: ReadonlyArray<{ label: string; content: string }>,
): boolean =>
  input.agents.length > 0 ||
  input.orbits.length > 0 ||
  (input.skills?.length ?? 0) > 0 ||
  (input.tools?.length ?? 0) > 0 ||
  (input.hooks?.length ?? 0) > 0 ||
  artifactTargetsKimi(input.registry, "commands") ||
  contexts.length > 0;

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const state = createGeneratedPluginPlanState();
  const contexts = await collectContextFiles(input);

  if (!hasPluginOutput(input, contexts)) {
    // No plugin output: the sync engine prunes the previously managed plugin
    // files plus the orphaned installed.json and config.toml regions.
    return { files: [], regions: [] };
  }

  const mcp = await planMcpServer(input);
  await planTargetedSkillWrites(input, state.desiredRelativePaths, state.files);
  planAgentRoleSkills(input, state.desiredRelativePaths, state.files);
  planOrbitSkillWrites(input, state.desiredRelativePaths, state.files);
  await planCommandSkillWrites(input, state.desiredRelativePaths, state.files);
  planContextSkillWrite(input, state.desiredRelativePaths, state.files, contexts);
  const hooks = await planHooks(input, state.desiredRelativePaths, state.files);

  pushWrite(
    state.files,
    state.desiredRelativePaths,
    input.target,
    "kimi.plugin.json",
    renderManifest(input, state.desiredRelativePaths, contexts, mcp),
  );

  const regions: DesiredRegion[] = [...installedPluginRegions(input)];
  const hooksRegion = hooksConfigRegion(input, hooks);
  if (hooksRegion) regions.push(hooksRegion);

  return { files: state.files, regions };
};
