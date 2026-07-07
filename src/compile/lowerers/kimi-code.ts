/** Kimi Code plugin and hook lowerer. */

import { join } from "node:path";
import { Effect } from "effect";
import type { ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget } from "../hooks.js";
import {
  mcpToolNameForBinding,
} from "../mcp-bundle.js";
import {
  pluginServerKey,
  renderPluginAllowlist,
  renderPluginWire,
  stableHash8,
} from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  bindingsOwnedByPlugin,
  collectBindingNameMap,
  groupAgentToolBindingsByOwner,
  mcpBindingsForAgentsAndTools,
  ownerPluginForBinding,
} from "../tool-bindings.js";
import { generatedPluginIdForOwner } from "../generated-plugin.js";
import { shimCommandForCompile } from "../shim-command.js";
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

// Mirrors Kimi Code's packages/agent-core/src/mcp/tool-naming.ts contract for
// the qualified tool name Kimi itself reports at hook/native-tool-call time.
// Under the per-plugin server scheme every owner's `pluginServerKey` is
// globally unique, so (unlike the retired aggregated `prism-mcp-shim` scheme)
// no `plugin-<id>:` runtime-disambiguation prefix is needed here anymore.
const sanitizeKimiMcpNamePart = (part: string): string =>
  part.replace(/[^a-zA-Z0-9_-]/gu, "_").replace(/_+/gu, "_");

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

/**
 * The fully-qualified name Kimi reports for `binding` (owned by
 * `ownerPluginName`) at hook/native-tool-call time: the per-plugin server key
 * plus the bare wire name that server's own `enabledTools` advertises for it.
 */
const kimiMcpToolName = (
  ownerPluginName: string,
  binding: ResolvedContractBinding,
): string =>
  qualifyKimiMcpToolName(
    pluginServerKey(ownerPluginName),
    renderPluginWire("kimi-code", ownerPluginName, mcpToolNameForBinding(ownerPluginName, binding)),
  );

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
    for (const binding of bindings) {
      generatedTools.push(kimiMcpToolName(ownerPlugin, binding));
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

/**
 * `enabledTools` is the load-bearing gate: it filters incoming `tools/call`
 * requests by the exact wire name this per-plugin server advertises, so
 * every entry here must come from `renderPluginAllowlist("kimi-code", ...)`,
 * never a bare or `qualifyKimiMcpToolName`-display name (that cosmetic form
 * is only ever shown in the per-role skill markdown, never fed into a config
 * gate) -- the Kimi law: allowlist == advertised wire names.
 */
const renderKimiMcpServerEntry = (options: {
  readonly plugins: ReadonlyArray<string>;
  readonly exposureProfile?: string;
  readonly toolNames: ReadonlyArray<string>;
}): Record<string, unknown> => {
  const env: Record<string, string> = {
    PRISM_SHIM_PLUGINS: options.plugins.join(","),
    PRISM_SHIM_HARNESS: TARGET_ID,
    // Per-plugin-manifest law: this server always fronts exactly one owner
    // plugin, so it must tell the shim to advertise (and gate `enabledTools`
    // against) the bare per-plugin wire names -- never the shim's default
    // `aggregated` `p_<hash>_<tool>` shape (see `shim-main.ts#parseNaming`).
    // Without this, the running shim's real `tools/list` diverges from what
    // `enabledTools` below expects and every tool call 404s.
    PRISM_SHIM_NAMING: "per-plugin",
  };
  if (options.exposureProfile) {
    env.PRISM_SHIM_EXPOSURE = options.exposureProfile;
  }
  return {
    enabled: true,
    command: shimCommandForCompile(),
    args: ["mcp", "shim"],
    env,
    enabledTools: options.toolNames,
  };
};

/**
 * Per-plugin-manifest law: this compile's `kimi.plugin.json` carries an MCP
 * server entry ONLY when the compiling plugin itself owns generated tools
 * (own canonical tools, plus its own synthetic trait/orbit dispatch tools) --
 * one server, keyed by `pluginServerKey(sourcePluginName)`, scoped to that
 * plugin's own bindings alone. A plugin whose agents merely reference a
 * foreign owner's tools is a consumer and gets NO server entry here: the
 * foreign owner's own compile carries its own server (reachable once that
 * owner's generated plugin is installed too), so this compile does not
 * duplicate it.
 */
const planMcpServer = (input: LowerInput): ReadonlyMap<string, Record<string, unknown>> => {
  const sourcePluginName = input.target.sourcePluginName;
  const servers = new Map<string, Record<string, unknown>>();

  const ownedBindings = bindingsOwnedByPlugin(sourcePluginName, input.tools, input.agents);
  if (ownedBindings.length === 0) return servers;

  const toolNames = uniqueSorted(
    ownedBindings.map((binding) =>
      renderPluginAllowlist("kimi-code", sourcePluginName, mcpToolNameForBinding(sourcePluginName, binding)),
    ),
  );
  servers.set(
    pluginServerKey(sourcePluginName),
    renderKimiMcpServerEntry({
      plugins: [sourcePluginName],
      ...(input.target.mcpExposureProfile ? { exposureProfile: input.target.mcpExposureProfile } : {}),
      toolNames,
    }),
  );

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
    return kimiMcpToolName(owner, binding);
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
  mcp: ReadonlyMap<string, Record<string, unknown>>,
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
      mcpServers[serverName] = entry;
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
