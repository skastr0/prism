/** Codex CLI lowerer. */

import { mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import {
  renderDerivedOrbitPhaseReferences,
  renderDerivedOrbitSkillBody,
} from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import {
  generateMcpServerBundle,
  mcpToolNameForBinding,
} from "../mcp-bundle.js";
import type { ResolvedContractBinding } from "../resolve.js";
import { effectBundleImportPath } from "../runtime-deps.js";
import { GENERATED_HOOK_RUNTIME } from "../hook-runtime-bundle.js";
import { buildHookWrapperWithBun } from "../hook-wrapper-build.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import {
  backupFile,
  exists,
  readFile,
  removeDir,
  removeFile,
  writeFile,
} from "../../fs.js";
import type { HarnessScope, PluginArtifactType, PluginTargetId } from "../../types.js";
import type { LowerOperation } from "./opencode.js";

const TARGET_ID = "codex-cli" as const;
const GENERATED_SERVER_PREFIX = "prism-generated";

export interface CodexCliLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
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

type Reason = "new" | "changed" | "unchanged";
type WriteOperationKind = "write-md" | "write-plugin-file";

interface PlannedHook {
  readonly hook: Hook;
  readonly nativeEvent: string;
  readonly matcher?: string;
  readonly relativePath: string;
}

interface AgentMcpServerConfig {
  readonly name: string;
  readonly bundlePath: string;
  readonly root: string;
}

const quote = (value: string): string => JSON.stringify(value);

const tomlArray = (values: ReadonlyArray<string>): string =>
  `[${values.map((value) => quote(value)).join(", ")}]`;

const normalizeBundleSegment = (value: string, fallback = "plugin"): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

const generatedServerName = (pluginName: string): string =>
  `${GENERATED_SERVER_PREFIX}-${normalizeBundleSegment(pluginName)}`;

const tomlDottedTable = (segments: ReadonlyArray<string>): string =>
  `[${segments.map((segment) => quote(segment)).join(".")}]`;

const tomlDottedArrayTable = (segments: ReadonlyArray<string>): string =>
  `[[${segments.map((segment) => quote(segment)).join(".")}]]`;

const uniqueSorted = (values: ReadonlyArray<string>): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const isTomlTableHeader = (line: string): boolean => /^\s*\[.*\]\s*(?:#.*)?$/u.test(line);

const isFeaturesTableHeader = (line: string): boolean => /^\s*\[features\]\s*(?:#.*)?$/u.test(line);

const isCodexHooksFeature = (line: string): boolean => /^\s*codex_hooks\s*=/u.test(line);

const isHooksFeature = (line: string): boolean => /^\s*hooks\s*=/u.test(line);

const managedBlockBegin = (pluginName: string): string =>
  `# --- prism codex-cli begin: ${pluginName} ---`;

const managedBlockEnd = (pluginName: string): string =>
  `# --- prism codex-cli end: ${pluginName} ---`;

const manifestTargetsCodex = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsCodex = (
  registry: PluginRegistry | undefined,
  artifact: PluginArtifactType,
): boolean => manifestTargetsCodex(registry?.targets[artifact]);

const writeReason = async (target: string, content: string): Promise<Reason> => {
  if (!(await exists(target))) return "new";
  return (await readFile(target)) === content ? "unchanged" : "changed";
};

const pushWrite = async (
  operations: LowerOperation[],
  target: string,
  content: string,
  kind: WriteOperationKind = "write-plugin-file",
): Promise<void> => {
  operations.push({
    kind,
    target,
    content,
    reason: await writeReason(target, content),
  });
};

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

const bindingFromToolSource = (
  pluginName: string,
  sourcePath: string,
): ResolvedContractBinding => {
  const toolName = basename(sourcePath, ".tool.ts");
  return {
    kind: "permission",
    logicalName: toolName,
    toolPluginName: pluginName,
    toolName,
    toolSourcePath: sourcePath,
  };
};

const bindingsFromCanonicalTools = (
  pluginName: string,
  tools: ReadonlyArray<CanonicalTool>,
): ReadonlyArray<ResolvedContractBinding> =>
  tools
    .map((tool) => bindingFromToolSource(pluginName, tool.sourcePath))
    .sort((left, right) => left.toolName.localeCompare(right.toolName));

const mcpBindingsForInput = (input: LowerInput): ReadonlyArray<ResolvedContractBinding> => [
  ...bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools),
  ...input.agents.flatMap((agent) => agent.toolBindings),
];

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
      tomlDottedTable(["mcp_servers", mcpServer.name]),
      'command = "bun"',
      `args = ${tomlArray([mcpServer.bundlePath])}`,
      `cwd = ${quote(mcpServer.root)}`,
      "enabled = true",
      "required = false",
      'default_tools_approval_mode = "approve"',
      `enabled_tools = ${tomlArray(mcpToolNames)}`,
    );
  }

  return `${lines.join("\n")}\n`;
};

const orbitSkillOwnerMarker = (sourcePluginName: string): string =>
  `<!-- prism:orbit-skill owner=${quote(sourcePluginName)} -->`;

const renderOrbitSkill = (
  orbit: Orbit,
  sourcePluginName: string,
  registry: PluginRegistry | undefined,
): string => {
  const lines: string[] = [
    "---",
    `name: ${quote(orbit.name)}`,
    `description: ${quote(orbit.description)}`,
    "---",
    "",
    orbitSkillOwnerMarker(sourcePluginName),
    "",
  ];
  if (registry) {
    lines.push(renderDerivedOrbitSkillBody(orbit, registry));
  } else {
    lines.push(`# ${orbit.name}`, "", orbit.description, "");
    if (orbit.body.trim().length > 0) {
      lines.push(orbit.body.trim(), "");
    }
  }
  return lines.join("\n");
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

const codexNativeHookEvent = (event: Hook["event"]): string => {
  switch (event) {
    case "tool.before":
      return "PreToolUse";
    case "tool.after":
      return "PostToolUse";
    case "session.start":
      return "SessionStart";
    case "session.end":
      return "Stop";
  }
};

const collectCanonicalToolNames = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): Map<string, string> => {
  const names = new Map<string, string>();

  for (const binding of bindings) {
    const mcpName = mcpToolNameForBinding(sourcePluginName, binding);
    names.set(binding.logicalName, mcpName);
    names.set(binding.toolName, mcpName);
    names.set(`${binding.toolPluginName}:${binding.toolName}`, mcpName);
    if (binding.contract) names.set(binding.contract.name, mcpName);
  }

  return names;
};

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

const regexEscape = (value: string): string => value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");

const renderHookWrapperEntry = (hook: Hook, nativeEvent: string, hookRuntimePath: string): string => `import { Effect } from ${quote(effectBundleImportPath())};
import hook from ${quote(hook.sourcePath.replace(/\\/g, "/"))};
import { decodeNativeHookPayloadForEvent, decodeHookResultForEvent } from ${quote(hookRuntimePath.replace(/\\/g, "/"))};

const parseInput = async () => {
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  return source.trim().length > 0 ? JSON.parse(source) : {};
};

const nativeToolName = (input) =>
  input?.tool?.name ?? input?.toolName ?? input?.tool_name ?? input?.name ?? "";

const nativeToolInput = (input) =>
  input?.tool?.input ?? input?.toolInput ?? input?.tool_input ?? input?.input ?? input?.args ?? input?.arguments ?? {};

const nativeSession = (input) => {
  const id = input?.session?.id ?? input?.sessionId ?? input?.session_id;
  const transcriptPath = input?.session?.transcriptPath ?? input?.transcriptPath ?? input?.transcript_path;
  if (id === undefined && transcriptPath === undefined) return undefined;
  return {
    id: id === undefined ? undefined : String(id),
    transcriptPath: transcriptPath === undefined ? undefined : String(transcriptPath),
  };
};

const normalizePayload = (input) => {
  const target = { harness: "codex-cli", nativeEvent: ${quote(nativeEvent)} };

  switch (${quote(hook.event)}) {
    case "tool.before":
      return { target, tool: { name: String(nativeToolName(input)), input: nativeToolInput(input) }, cwd: input?.cwd, session: nativeSession(input) };
    case "tool.after":
      return {
        target,
        tool: {
          name: String(nativeToolName(input)),
          input: nativeToolInput(input),
          output: input?.tool?.output ?? input?.tool_response ?? input?.toolResponse ?? input?.toolOutput ?? input?.tool_output ?? input?.output ?? input?.result,
          success: input?.tool?.success ?? input?.success,
        },
        cwd: input?.cwd,
        session: nativeSession(input),
      };
    case "session.start":
      return { target, cwd: input?.cwd, session: nativeSession(input) ?? { id: "codex-cli" } };
    case "session.end":
      return { target, cwd: input?.cwd, session: nativeSession(input) ?? { id: "codex-cli" }, reason: input?.reason };
  }
};

const unwrapDecode = (decoded, label) => {
  if (decoded && decoded._tag === "Right") return decoded.right;
  throw new Error("prism hook " + label + " validation failed");
};

const toPromise = (value) => Effect.isEffect(value) ? Effect.runPromise(value) : Promise.resolve(value);

const payload = unwrapDecode(
  decodeNativeHookPayloadForEvent(${quote(hook.event)}, normalizePayload(await parseInput())),
  "native payload",
);
const rawResult = await toPromise(hook.handle(payload));
const result = unwrapDecode(
  decodeHookResultForEvent(${quote(hook.event)}, rawResult ?? { decision: "continue" }),
  "result",
);

if (${quote(hook.event)} === "tool.before" && result.decision === "block") {
  console.error(result.message);
  process.exit(2);
}
`;

const bundleHookWrapper = async (hook: Hook, nativeEvent: string): Promise<string> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-codex-hook-"));

  try {
    const entry = join(tempRoot, "hook-entry.ts");
    const hookRuntimePath = join(tempRoot, "hook-runtime.mjs");
    await nodeWriteFile(hookRuntimePath, GENERATED_HOOK_RUNTIME);
    await nodeWriteFile(entry, renderHookWrapperEntry(hook, nativeEvent, hookRuntimePath));

    const outdir = join(tempRoot, "dist");
    await buildHookWrapperWithBun(entry, outdir, `Codex '${hook.name}'`);

    const built = await readFile(join(outdir, "wrapper.mjs"));
    return built.startsWith("#!") ? built : `#!/usr/bin/env node\n${built}`;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const planHooks = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<PlannedHook[]> => {
  const hooks = [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  if (!input.registry) return [];

  const canonicalToolNames = collectCanonicalToolNames(
    input.target.sourcePluginName,
    mcpBindingsForInput(input),
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
  readonly mcpServerName?: string;
  readonly mcpBundlePath?: string;
  readonly enabledTools: ReadonlyArray<string>;
  readonly root: string;
  readonly hooks: ReadonlyArray<PlannedHook>;
}): string => {
  const lines: string[] = [];

  if (options.mcpServerName && options.mcpBundlePath) {
    lines.push(
      tomlDottedTable(["mcp_servers", options.mcpServerName]),
      'command = "bun"',
      `args = ${tomlArray([options.mcpBundlePath])}`,
      `cwd = ${quote(options.root)}`,
      "enabled = true",
      "required = false",
      'default_tools_approval_mode = "approve"',
      `enabled_tools = ${tomlArray(options.enabledTools)}`,
      "",
    );
  }

  lines.push(...renderHooksConfig(options.root, options.hooks));
  return lines.join("\n");
};

const planMcpServer = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<{ mcpServerName?: string; mcpBundlePath?: string; toolNames: string[] }> => {
  const bindings = mcpBindingsForInput(input);
  if (bindings.length === 0) return { toolNames: [] };

  const mcpServerName = generatedServerName(input.target.sourcePluginName);
  const bundle = await generateMcpServerBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath,
    serverName: mcpServerName,
    version: input.target.sourcePluginVersion,
    bundleId: mcpServerName,
    bindings,
  });

  await pushWrite(
    operations,
    join(input.target.root, ...bundle.relativePath.split("/")),
    bundle.content,
  );

  return {
    mcpServerName,
    mcpBundlePath: bundle.relativePath,
    toolNames: uniqueSorted(bundle.toolNames),
  };
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const mcp = await planMcpServer(input, operations);
  const agentMcpServer = mcp.mcpServerName && mcp.mcpBundlePath
    ? {
        name: mcp.mcpServerName,
        bundlePath: mcp.mcpBundlePath,
        root: input.target.root,
      }
    : undefined;

  for (const agent of input.agents) {
    await pushWrite(
      operations,
      join(input.target.root, "agents", `${agent.name}.toml`),
      renderAgentToml(agent, input.target, agentMcpServer),
      "write-md",
    );
  }

  if (artifactTargetsCodex(input.registry, "skills")) {
    for (const skill of input.skills ?? []) {
      await pushWrite(
        operations,
        join(input.target.root, "skills", skill.name, "SKILL.md"),
        await readFile(skill.sourcePath),
        "write-md",
      );
    }
  }

  for (const orbit of input.orbits) {
    await pushWrite(
      operations,
      join(input.target.root, "skills", orbit.name, "SKILL.md"),
      renderOrbitSkill(orbit, input.target.sourcePluginName, input.registry),
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

  const rules = await renderRules(input);
  if (rules) {
    await pushWrite(operations, join(input.target.root, "AGENTS.md"), rules, "write-md");
  }

  const hooks = await planHooks(input, operations);
  const configTarget = join(input.target.root, "config.toml");
  const currentConfig = (await exists(configTarget)) ? await readFile(configTarget) : "";
  const migratedConfig = renderConfigWithHookFeature(currentConfig, hooks.length > 0);
  const managedBlock = renderManagedConfigBlock({
    mcpServerName: mcp.mcpServerName,
    mcpBundlePath: mcp.mcpBundlePath,
    enabledTools: mcp.toolNames,
    root: input.target.root,
    hooks,
  });

  await pushWrite(
    operations,
    configTarget,
    replaceManagedBlock(migratedConfig, input.target.sourcePluginName, managedBlock),
    "write-plugin-file",
  );

  return operations;
};

export const executeLowering = async (
  operations: LowerOperation[],
  options: { backup: boolean; dryRun: boolean },
): Promise<{ backups: string[] }> => {
  const backups: string[] = [];
  if (options.dryRun) return { backups };

  for (const operation of operations) {
    if (operation.reason === "unchanged") continue;

    if (operation.kind === "write-md" || operation.kind === "write-plugin-file") {
      if (options.backup && operation.kind === "write-md") {
        const backup = await backupFile(operation.target);
        if (backup) backups.push(backup);
      }
      await writeFile(operation.target, operation.content);
      continue;
    }

    if (operation.kind === "prune-plugin-path") {
      if (operation.targetType === "dir") await removeDir(operation.target);
      else await removeFile(operation.target);
    }
  }

  return { backups };
};
