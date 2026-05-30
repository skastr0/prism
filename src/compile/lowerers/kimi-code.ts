/** Kimi Code plugin and hook lowerer. */

import { join } from "node:path";
import { Effect } from "effect";
import type { ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget } from "../hooks.js";
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
} from "../mcp-runtime.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  collectBindingNameMap,
  mcpBindingsForAgentsAndTools,
} from "../tool-bindings.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import { exists, readFile } from "../../fs.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { LowerOperation } from "./opencode.js";
import {
  bundleGeneratedHookWrapper,
  createGeneratedPluginPlanState,
  createGeneratedPluginWritePusher,
  executeStandardLowering,
  nativeHookEventName,
  normalizeBundleSegment,
  planGeneratedPluginPruning,
  pushConfigPatchOperation as pushConfigPatch,
  pushWriteOperation,
  regexEscape,
  renderPrePostSessionHookWrapperEntry,
  renderStandardOrbitSkill,
  serializeSimpleFrontmatter as serializeFrontmatter,
  uniqueSorted,
} from "./shared.js";

const TARGET_ID = "kimi-code" as const;
const GENERATED_PLUGIN_PREFIX = "prism-generated";

export interface KimiCodeLowerTarget {
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
  readonly serverName?: string;
  readonly toolNames: ReadonlyArray<string>;
  readonly runtimeServerPath?: string;
  readonly manifestEntry?: Record<string, unknown>;
}

interface InstalledPluginRecord {
  readonly id: string;
  readonly root: string;
  readonly source: "local-path" | "zip-url" | "github";
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly originalSource?: string;
  readonly capabilities?: {
    readonly mcpServers?: Record<string, { readonly enabled: boolean }>;
  };
}

interface InstalledPluginsFile {
  readonly version: 1;
  readonly plugins: ReadonlyArray<Record<string, unknown>>;
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

const managedBlockBegin = (pluginName: string): string =>
  `# --- prism kimi-code begin: ${pluginName} ---`;

const managedBlockEnd = (pluginName: string): string =>
  `# --- prism kimi-code end: ${pluginName} ---`;

const replaceManagedBlock = (current: string, pluginName: string, block: string): string => {
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
  const trimmedBlock = block.trimEnd();
  if (!trimmedBlock) return trimmedBase ? `${trimmedBase}\n` : "";
  return `${trimmedBase}${trimmedBase ? "\n\n" : ""}${begin}\n${trimmedBlock}\n${end}\n`;
};

const installedPluginsPath = (target: KimiCodeLowerTarget): string =>
  join(target.root, "plugins", "installed.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readInstalledPlugins = async (
  target: KimiCodeLowerTarget,
): Promise<InstalledPluginsFile> => {
  const targetPath = installedPluginsPath(target);
  if (!(await exists(targetPath))) return { version: 1, plugins: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(targetPath));
  } catch (error) {
    throw new Error(`Failed to parse ${targetPath}: ${(error as Error).message}`, { cause: error });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    throw new Error(`${targetPath} is not a valid Kimi installed.json file`);
  }
  if (!parsed.plugins.every(isRecord)) {
    throw new Error(`${targetPath} contains an invalid plugin record`);
  }
  return {
    version: 1,
    plugins: parsed.plugins,
  };
};

const stringField = (record: Record<string, unknown>, field: string): string | undefined =>
  typeof record[field] === "string" ? record[field] : undefined;

const booleanField = (record: Record<string, unknown>, field: string): boolean | undefined =>
  typeof record[field] === "boolean" ? record[field] : undefined;

const currentMcpState = (
  current: Record<string, unknown> | undefined,
  serverName: string,
): { readonly enabled: boolean } | undefined => {
  if (!current || !isRecord(current.capabilities)) return undefined;
  if (!isRecord(current.capabilities.mcpServers)) return undefined;
  const server = current.capabilities.mcpServers[serverName];
  if (!isRecord(server) || typeof server.enabled !== "boolean") return undefined;
  return { enabled: server.enabled };
};

const installedPluginRecord = (
  input: LowerInput,
  current: Record<string, unknown> | undefined,
  serverNames: ReadonlyArray<string>,
): InstalledPluginRecord => {
  const now = new Date().toISOString();
  const capabilitiesMcpServers: Record<string, { readonly enabled: boolean }> = {};
  for (const serverName of serverNames) {
    const serverState = currentMcpState(current, serverName);
    if (serverState) capabilitiesMcpServers[serverName] = serverState;
  }
  const capabilities =
    Object.keys(capabilitiesMcpServers).length > 0
      ? { mcpServers: capabilitiesMcpServers }
      : undefined;
  const originalSource = input.target.sourcePluginPath ?? input.registry?.pluginPath;

  return {
    id: generatedPluginId(input.target),
    root: generatedPluginRoot(input.target),
    source: "local-path",
    enabled: booleanField(current ?? {}, "enabled") ?? true,
    installedAt: stringField(current ?? {}, "installedAt") ?? now,
    updatedAt:
      stringField(current ?? {}, "updatedAt") ??
      stringField(current ?? {}, "installedAt") ??
      now,
    ...(originalSource ? { originalSource } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
};

const planInstalledPluginRegistration = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredPresent: boolean,
  serverNames: ReadonlyArray<string> = [],
): Promise<void> => {
  const installedPath = installedPluginsPath(input.target);
  const current = await readInstalledPlugins(input.target);
  const pluginId = generatedPluginId(input.target);
  const currentRecord = current.plugins.find((record) => record.id === pluginId);

  if (!desiredPresent) {
    if (!currentRecord) return;
    await pushConfigPatch(operations, installedPath, json({
      version: 1,
      plugins: current.plugins.filter((record) => record.id !== pluginId),
    }));
    return;
  }

  const nextRecord = installedPluginRecord(input, currentRecord, serverNames);
  let replaced = false;
  const plugins = current.plugins.map((record) => {
    if (record.id !== pluginId) return record;
    replaced = true;
    return nextRecord;
  });
  if (!replaced) plugins.push(nextRecord);

  await pushConfigPatch(operations, installedPath, json({ version: 1, plugins }));
};

const renderSkill = (frontmatter: Record<string, unknown>, body: string): string =>
  `${serializeFrontmatter(frontmatter)}\n\n${body.trimEnd()}\n`;

const renderKimiAgentRoleSkill = (
  agent: ComposedAgent,
  target: KimiCodeLowerTarget,
  mcpServerName?: string,
): string => {
  const tools = mcpServerName
    ? agent.toolBindings.map((binding) =>
        kimiMcpToolName(mcpServerName, target.sourcePluginName, binding),
      )
    : [];
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
      for (const tool of uniqueSorted(tools)) sections.push(`- \`${tool}\``);
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
  operations: LowerOperation[],
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsKimi(input.registry, "skills")) return;

  const files = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of files) {
    const relativePath = `skills/${file.relativePath}`;
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      relativePath,
      await readFile(file.sourcePath),
      file.relativePath.endsWith(".md") ? "write-md" : "write-plugin-file",
    );
  }
};

const planAgentRoleSkills = async (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  operations: LowerOperation[],
  mcpServerName?: string,
): Promise<void> => {
  for (const agent of input.agents) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `skills/${roleSkillName(agent.name)}/SKILL.md`,
      renderKimiAgentRoleSkill(agent, input.target, mcpServerName),
      "write-md",
    );
  }
};

const planOrbitSkillWrites = async (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  operations: LowerOperation[],
): Promise<void> => {
  for (const orbit of input.orbits) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `skills/${orbit.name}/SKILL.md`,
      renderStandardOrbitSkill(orbit, input.target.sourcePluginName, input.registry),
      "write-md",
    );

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      await pushWrite(
        operations,
        desiredRelativePaths,
        input.target,
        `skills/${orbit.name}/references/${reference.filename}`,
        reference.content,
        "write-md",
      );
    }
  }
};

const planCommandSkillWrites = async (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  operations: LowerOperation[],
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsKimi(input.registry, "commands")) return;

  const files = await collectArtifactSourceFiles(pluginPath, "commands", TARGET_ID);
  for (const file of files.filter((entry) => entry.relativePath.endsWith(".md"))) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `skills/${commandSkillName(file.relativePath)}/SKILL.md`,
      renderCommandSkill(file.relativePath, await readFile(file.sourcePath)),
      "write-md",
    );
  }
};

const planContextSkillWrite = async (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  operations: LowerOperation[],
  contexts: ReadonlyArray<{ label: string; content: string }>,
): Promise<void> => {
  if (contexts.length === 0) return;
  await pushWrite(
    operations,
    desiredRelativePaths,
    input.target,
    "skills/prism-context/SKILL.md",
    renderContextSkill(contexts),
    "write-md",
  );
};

const renderKimiMcpServerEntry = (options: {
  readonly runtime: ReturnType<typeof resolveMcpRuntime>;
  readonly bundleRelativePath?: string;
  readonly runtimeServerPath?: string;
  readonly bearerToken?: string;
  readonly toolNames: ReadonlyArray<string>;
}): Record<string, unknown> => {
  const base = {
    enabled: true,
    enabledTools: options.toolNames,
    startupTimeoutMs: options.runtime.connectTimeoutMs,
    toolTimeoutMs: options.runtime.toolTimeoutMs,
  };

  if (options.runtime.transport === "streamable-http") {
    return {
      ...base,
      url: renderMcpHttpUrl(options.runtime),
      ...(options.bearerToken
        ? {
            headers: {
              Authorization: renderMcpBearerAuthorization({
                tokenEnv: options.runtime.tokenEnv,
                token: options.bearerToken,
              }),
            },
          }
        : { bearerTokenEnvVar: options.runtime.tokenEnv }),
    };
  }

  if (!options.bundleRelativePath) {
    throw new Error("Kimi stdio MCP config requires a generated bundle path.");
  }

  return {
    ...base,
    command: "bun",
    args: [`./${options.bundleRelativePath}`],
    cwd: "./",
  };
};

const planMcpServer = async (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  operations: LowerOperation[],
): Promise<PlannedMcpServer> => {
  const bindings = mcpBindingsForAgentsAndTools(
    input.target.sourcePluginName,
    input.tools ?? [],
    input.agents,
  );
  if (bindings.length === 0) return { toolNames: [] };

  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, { requirePort: true });
  const serverName = generatedMcpServerName(input.target.sourcePluginName);
  const bundle = await generateMcpServerBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath,
    serverName,
    version: input.target.sourcePluginVersion,
    bundleId: serverName,
    ...mcpServerBundleRuntimeOptions(runtime),
    bindings,
  });

  const runtimeServerPath = runtime.transport === "streamable-http"
    ? runtimeMcpServerDescriptor(
        input.target.mcpRuntimeRoot ?? input.target.root,
        input.target.sourcePluginName,
      ).absolutePath
    : undefined;
  const targetPath = runtimeServerPath ?? generatedPath(input.target, bundle.relativePath);
  await pushWriteOperation(operations, targetPath, bundle.content);
  if (!runtimeServerPath) desiredRelativePaths.add(bundle.relativePath);

  return {
    serverName,
    toolNames: uniqueSorted(bundle.toolNames),
    ...(runtimeServerPath ? { runtimeServerPath } : {}),
    manifestEntry: renderKimiMcpServerEntry({
      runtime,
      ...(runtime.transport === "stdio" ? { bundleRelativePath: bundle.relativePath } : {}),
      ...(runtimeServerPath ? { runtimeServerPath } : {}),
      ...(input.target.mcpBearerToken ? { bearerToken: input.target.mcpBearerToken } : {}),
      toolNames: uniqueSorted(bundle.toolNames),
    }),
  };
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
): string =>
  renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
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
    renderEntry: (currentHook, hookRuntimePath) =>
      renderKimiHookWrapperEntry(currentHook, nativeEvent, hookRuntimePath),
  });

const planHooks = async (
  input: LowerInput,
  desiredRelativePaths: Set<string>,
  operations: LowerOperation[],
  mcpServerName?: string,
): Promise<PlannedHook[]> => {
  const bindings = mcpBindingsForAgentsAndTools(
    input.target.sourcePluginName,
    input.tools ?? [],
    input.agents,
  );
  const canonicalToolNames = collectBindingNameMap(bindings, (binding) =>
    mcpServerName
      ? kimiMcpToolName(mcpServerName, input.target.sourcePluginName, binding)
      : mcpToolNameForBinding(input.target.sourcePluginName, binding),
  );

  const planned: PlannedHook[] = [];
  for (const hook of [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name))) {
    const nativeEvent = kimiNativeHookEvent(hook.event);
    const relativePath = `hooks/${normalizeBundleSegment(hook.name, "hook")}.mjs`;
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      relativePath,
      await bundleHookWrapper(hook, nativeEvent),
      "write-plugin-file",
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

const planConfigPatch = async (
  input: LowerInput,
  operations: LowerOperation[],
  hooks: ReadonlyArray<PlannedHook>,
): Promise<void> => {
  const configTarget = join(input.target.root, "config.toml");
  const current = (await exists(configTarget)) ? await readFile(configTarget) : "";
  await pushConfigPatch(
    operations,
    configTarget,
    replaceManagedBlock(
      current,
      input.target.sourcePluginName,
      renderHooksConfig(input.target, hooks),
    ),
  );
};

const renderManifest = (
  input: LowerInput,
  desiredRelativePaths: ReadonlySet<string>,
  contexts: ReadonlyArray<{ label: string; content: string }>,
  mcp: PlannedMcpServer,
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
  if (mcp.serverName && mcp.manifestEntry) {
    manifest.mcpServers = { [mcp.serverName]: mcp.manifestEntry };
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

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const state = createGeneratedPluginPlanState();
  const resolveTarget = (relativePath: string): string => generatedPath(input.target, relativePath);
  const contexts = await collectContextFiles(input);

  if (!hasPluginOutput(input, contexts)) {
    await planConfigPatch(input, state.operations, []);
    await planInstalledPluginRegistration(input, state.operations, false);
    await planGeneratedPluginPruning({
      state,
      root: generatedPluginRoot(input.target),
      resolveTarget,
    });
    return state.operations;
  }

  const mcp = await planMcpServer(input, state.desiredRelativePaths, state.operations);
  await planTargetedSkillWrites(input, state.desiredRelativePaths, state.operations);
  await planAgentRoleSkills(input, state.desiredRelativePaths, state.operations, mcp.serverName);
  await planOrbitSkillWrites(input, state.desiredRelativePaths, state.operations);
  await planCommandSkillWrites(input, state.desiredRelativePaths, state.operations);
  await planContextSkillWrite(input, state.desiredRelativePaths, state.operations, contexts);
  const hooks = await planHooks(input, state.desiredRelativePaths, state.operations, mcp.serverName);

  await pushWrite(
    state.operations,
    state.desiredRelativePaths,
    input.target,
    "kimi.plugin.json",
    renderManifest(input, state.desiredRelativePaths, contexts, mcp),
  );
  await planInstalledPluginRegistration(
    input,
    state.operations,
    true,
    mcp.serverName ? [mcp.serverName] : [],
  );
  await planConfigPatch(input, state.operations, hooks);
  await planGeneratedPluginPruning({
    state,
    root: generatedPluginRoot(input.target),
    resolveTarget,
  });

  return state.operations;
};

export const executeLowering = executeStandardLowering;
