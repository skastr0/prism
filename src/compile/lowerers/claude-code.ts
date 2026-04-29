/**
 * Claude Code plugin-bundle lowerer.
 *
 * Produces one compiler-owned Claude plugin bundle under
 * <claude-root>/plugins/agentpkg-generated-<source-plugin>/.
 */

import { mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
  composeLifecyclePhaseReference,
  type ComposedAgent,
} from "../compose.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import {
  generateMcpServerBundle,
  mcpToolNameForBinding,
} from "../mcp-bundle.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { Hook, Lifecycle, Skill } from "../sources.js";
import {
  backupFile,
  exists,
  listDirRecursive,
  readFile,
  removeDir,
  removeFile,
  writeFile,
} from "../../fs.js";
import { resolveManifestTargets } from "../../manifest.js";
import type { HarnessScope, PluginTargetId } from "../../types.js";
import { effectBundleImportPath } from "../runtime-deps.js";
import type { LowerOperation } from "./opencode.js";

const TARGET_ID = "claude-code" as const;
const GENERATED_PLUGIN_PREFIX = "agentpkg-generated";

export interface ClaudeCodeLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
  readonly sourcePluginPath?: string;
}

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly lifecycles: ReadonlyArray<Lifecycle>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: ClaudeCodeLowerTarget;
}

type Reason = "new" | "changed" | "unchanged";
type WriteOperationKind = "write-md" | "write-plugin-file";

const normalizeBundleSegment = (value: string, fallback = "plugin"): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

const generatedPluginId = (target: ClaudeCodeLowerTarget): string =>
  `${GENERATED_PLUGIN_PREFIX}-${normalizeBundleSegment(target.sourcePluginName)}`;

const generatedPluginRoot = (target: ClaudeCodeLowerTarget): string =>
  join(target.root, "plugins", generatedPluginId(target));

const generatedPath = (target: ClaudeCodeLowerTarget, relativePath: string): string =>
  join(generatedPluginRoot(target), ...relativePath.split("/"));

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

const uniqueSorted = (values: ReadonlyArray<string>): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const yamlScalar = (value: string | number | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

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
      `- \`${field}\` is not supported on Claude plugin agents; agentpkg kept a single plugin-bundle lower and did not emit a direct .claude fallback.`,
  );

  return `\n\n## Agentpkg Claude Plugin Diagnostics\n\n${bullets.join("\n")}`;
};

const composeAgentFrontmatter = (
  agent: ComposedAgent,
  target: ClaudeCodeLowerTarget,
): Record<string, unknown> => {
  const override = agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;
  const model = agent.model ?? {};
  const pluginId = generatedPluginId(target);
  const tools = uniqueSorted([
    ...stringArray(override?.tools),
    ...stringArray(override?.["allowed-tools"]),
    ...agent.allowedTools,
    ...agent.toolBindings.map((binding) =>
      claudeMcpPermissionNameForBinding(target.sourcePluginName, pluginId, binding),
    ),
  ]);

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

const lifecycleSkillOwnerMarker = (sourcePluginName: string): string =>
  `<!-- agentpkg:lifecycle-skill owner=${JSON.stringify(sourcePluginName)} -->`;

const renderLifecycleSkill = (lifecycle: Lifecycle, sourcePluginName: string): string => {
  const lines = [
    serializeFrontmatter({ name: lifecycle.name, description: lifecycle.description }),
    "",
    lifecycleSkillOwnerMarker(sourcePluginName),
    "",
    `# ${lifecycle.name}`,
    "",
    lifecycle.description,
    "",
    "_Runtime-facing lowering of a concrete lifecycle instance. Parameterized lifecycle templates remain source-only until another lifecycle binds them._",
    "",
    "## Phases",
    "",
  ];

  lifecycle.phases.forEach((phase, index) => {
    const reference = composeLifecyclePhaseReference(phase);
    lines.push(`### ${index + 1}. ${phase.name} — ${reference.label}`, "", ...reference.detailLines);

    if (phase.notes) {
      for (const [key, value] of Object.entries(phase.notes)) {
        lines.push(`- **${key}**: ${value}`);
      }
    }

    lines.push("");
  });

  if (lifecycle.body.trim().length > 0) {
    lines.push(lifecycle.body.trim(), "");
  }

  return lines.join("\n");
};

const claudeNativeHookEvent = (event: Hook["event"]): string => {
  switch (event) {
    case "tool.before":
      return "PreToolUse";
    case "tool.after":
      return "PostToolUse";
    case "session.start":
      return "SessionStart";
    case "session.end":
      return "SessionEnd";
  }
};

const regexEscape = (value: string): string => value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");

const claudeMcpPermissionNameForBinding = (
  sourcePluginName: string,
  pluginId: string,
  binding: ResolvedContractBinding,
): string => `mcp__${pluginId}__${mcpToolNameForBinding(sourcePluginName, binding)}`;

const collectHookBindings = (
  sourcePluginName: string,
  pluginId: string,
  agents: ReadonlyArray<ComposedAgent>,
): ReadonlyMap<string, string> => {
  const byRef = new Map<string, string>();
  for (const binding of agents.flatMap((agent) => agent.toolBindings)) {
    const mcpName = claudeMcpPermissionNameForBinding(sourcePluginName, pluginId, binding);
    byRef.set(binding.logicalName, mcpName);
    byRef.set(binding.toolName, mcpName);
    byRef.set(`${binding.toolPluginName}:${binding.toolName}`, mcpName);
    if (binding.contract) byRef.set(binding.contract.name, mcpName);
  }
  return byRef;
};

const matcherForHook = (
  match: ResolvedHookMatch,
  canonicalToolNames: ReadonlyMap<string, string>,
): string | undefined => {
  const tool = match.tool;
  if (!tool) return undefined;
  if (tool.kind === "any") return ".*";
  if (tool.kind === "native-tools") {
    if (tool.names.length === 0) return undefined;
    if (tool.names.length === 1) return tool.names[0]!;
    return `^(?:${tool.names.map(regexEscape).join("|")})$`;
  }
  return canonicalToolNames.get(tool.ref) ?? tool.ref;
};

const renderHooksJson = async (
  hooks: ReadonlyArray<Hook>,
  registry: PluginRegistry | undefined,
  target: ClaudeCodeLowerTarget,
  agents: ReadonlyArray<ComposedAgent>,
): Promise<string> => {
  const groupedHooks: Record<string, unknown[]> = {};
  const canonicalToolNames = collectHookBindings(
    target.sourcePluginName,
    generatedPluginId(target),
    agents,
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
      const matcher = matcherForHook(resolved, canonicalToolNames);
      if (matcher) entry.matcher = matcher;
    }
    (groupedHooks[event] ??= []).push(entry);
  }

  return json({ hooks: groupedHooks });
};

const hookSourcesImportPath = (): string =>
  fileURLToPath(new URL("../sources.ts", import.meta.url)).replace(/\\/g, "/");

const renderHookWrapperEntry = (hook: Hook): string => `import { Effect } from ${JSON.stringify(effectBundleImportPath())};
import hook from ${JSON.stringify(hook.sourcePath.replace(/\\/g, "/"))};
import { decodeNativeHookPayloadForEvent, decodeHookResultForEvent } from ${JSON.stringify(hookSourcesImportPath())};

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
  const target = { harness: "claude-code", nativeEvent: ${JSON.stringify(claudeNativeHookEvent(hook.event))} };
  const cwd = input?.cwd ?? input?.workspace?.cwd;

  switch (${JSON.stringify(hook.event)}) {
    case "tool.before":
      return { target, tool: { name: String(nativeToolName(input)), input: nativeToolInput(input) }, cwd, session: nativeSession(input) };
    case "tool.after":
      return {
        target,
        tool: {
          name: String(nativeToolName(input)),
          input: nativeToolInput(input),
          output: input?.tool?.output ?? input?.toolOutput ?? input?.tool_output ?? input?.output,
          success: input?.tool?.success ?? input?.success,
        },
        cwd,
        session: nativeSession(input),
      };
    case "session.start":
      return { target, cwd, session: nativeSession(input) ?? { id: "claude-code" } };
    case "session.end":
      return { target, cwd, session: nativeSession(input) ?? { id: "claude-code" }, reason: input?.reason };
  }
};

const unwrapDecode = (decoded, label) => {
  if (decoded && decoded._tag === "Right") return decoded.right;
  throw new Error("agentpkg hook " + label + " validation failed");
};

const toPromise = (value) => Effect.isEffect(value) ? Effect.runPromise(value) : Promise.resolve(value);

const payload = unwrapDecode(
  decodeNativeHookPayloadForEvent(${JSON.stringify(hook.event)}, normalizePayload(await parseInput())),
  "native payload",
);
const rawResult = await toPromise(hook.handle(payload));
const result = unwrapDecode(
  decodeHookResultForEvent(${JSON.stringify(hook.event)}, rawResult ?? { decision: "continue" }),
  "result",
);

if (${JSON.stringify(hook.event)} === "tool.before" && result.decision === "block") {
  console.error(result.message);
  process.exit(2);
}
`;

const bundleHookWrapper = async (hook: Hook): Promise<string> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "agentpkg-claude-hook-"));

  try {
    const entry = join(tempRoot, "hook-entry.ts");
    await nodeWriteFile(entry, renderHookWrapperEntry(hook));

    const outdir = join(tempRoot, "dist");
    const build = await Bun.build({
      entrypoints: [entry],
      outdir,
      target: "node",
      format: "esm",
      packages: "bundle",
      naming: "wrapper.mjs",
      sourcemap: "none",
      minify: false,
    });

    if (!build.success) {
      const diagnostics = build.logs.map((log) => log.message).join("\n");
      throw new Error(`failed to build Claude hook wrapper '${hook.name}': ${diagnostics}`);
    }

    const built = await readFile(join(outdir, "wrapper.mjs"));
    return built.startsWith("#!") ? built : `#!/usr/bin/env node\n${built}`;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const writeReason = async (target: string, content: string): Promise<Reason> => {
  if (!(await exists(target))) return "new";
  return (await readFile(target)) === content ? "unchanged" : "changed";
};

const pushWrite = async (
  operations: LowerOperation[],
  desiredRelativePaths: Set<string>,
  target: ClaudeCodeLowerTarget,
  relativePath: string,
  content: string,
  kind: WriteOperationKind = "write-plugin-file",
): Promise<void> => {
  desiredRelativePaths.add(relativePath);

  const absolutePath = generatedPath(target, relativePath);
  operations.push({
    kind,
    target: absolutePath,
    content,
    reason: await writeReason(absolutePath, content),
  });
};

const planCommands = async (
  input: LowerInput,
  operations: LowerOperation[],
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
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `commands/${relativePath}`,
      await readFile(join(commandsRoot, ...relativePath.split("/"))),
      "write-md",
    );
  }
};

const planMcpServer = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
  const bindings = input.agents.flatMap((agent) => agent.toolBindings);
  const pluginId = generatedPluginId(input.target);

  if (bindings.length === 0) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      ".mcp.json",
      json({ mcpServers: {} }),
    );
    return;
  }

  const bundle = await generateMcpServerBundle({
    sourcePluginName: input.target.sourcePluginName,
    serverName: pluginId,
    version: input.target.sourcePluginVersion ?? "0.1.0",
    bundleId: pluginId,
    bindings,
  });

  await pushWrite(
    operations,
    desiredRelativePaths,
    input.target,
    bundle.relativePath,
    bundle.content,
  );
  await pushWrite(
    operations,
    desiredRelativePaths,
    input.target,
    ".mcp.json",
    json({
      mcpServers: {
        [pluginId]: {
          command: "node",
          args: [`\${CLAUDE_PLUGIN_ROOT}/${bundle.relativePath}`],
        },
      },
    }),
  );
};

const planHooks = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
  const hooks = input.hooks ?? [];

  await pushWrite(
    operations,
    desiredRelativePaths,
    input.target,
    "hooks/hooks.json",
    await renderHooksJson(hooks, input.registry, input.target, input.agents),
  );

  for (const hook of hooks) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `hooks/${hook.name}.mjs`,
      await bundleHookWrapper(hook),
    );
  }
};

const planPruning = async (
  target: ClaudeCodeLowerTarget,
  desiredRelativePaths: ReadonlySet<string>,
): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const existingFiles = await listDirRecursive(generatedPluginRoot(target));

  for (const relativePath of existingFiles.sort((left, right) => left.localeCompare(right))) {
    if (desiredRelativePaths.has(relativePath)) continue;
    operations.push({
      kind: "prune-plugin-path",
      target: generatedPath(target, relativePath),
      targetType: "file",
      reason: "stale",
    });
  }

  return operations;
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const desiredRelativePaths = new Set<string>();

  await pushWrite(
    operations,
    desiredRelativePaths,
    input.target,
    ".claude-plugin/plugin.json",
    json({
      name: generatedPluginId(input.target),
      version: input.target.sourcePluginVersion ?? "0.1.0",
      description: `Generated by agentpkg from ${input.target.sourcePluginName}.`,
    }),
  );

  for (const agent of input.agents) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `agents/${agent.name}.md`,
      renderAgentMarkdown(agent, input.target),
      "write-md",
    );
  }

  for (const skill of input.skills ?? []) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `skills/${skill.name}/SKILL.md`,
      await readFile(skill.sourcePath),
      "write-md",
    );
  }

  for (const lifecycle of input.lifecycles) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `skills/${lifecycle.name}/SKILL.md`,
      renderLifecycleSkill(lifecycle, input.target.sourcePluginName),
      "write-md",
    );
  }

  await planCommands(input, operations, desiredRelativePaths);
  await planMcpServer(input, operations, desiredRelativePaths);
  await planHooks(input, operations, desiredRelativePaths);
  operations.push(...(await planPruning(input.target, desiredRelativePaths)));

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
