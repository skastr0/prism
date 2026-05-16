/**
 * Gemini CLI extension lowerer.
 *
 * Produces one compiler-owned extension bundle under
 * <gemini-root>/extensions/prism-generated-<source-plugin>/.
 */

import { mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { Effect } from "effect";
import matter from "gray-matter";
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
import { effectBundleImportPath } from "../runtime-deps.js";
import { GENERATED_HOOK_RUNTIME } from "../hook-runtime-bundle.js";
import { buildHookWrapperWithBun } from "../hook-wrapper-build.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit } from "../sources.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import {
  exists,
  listDirRecursive,
  readFile,
} from "../../fs.js";
import type { LowerOperation } from "./opencode.js";
import {
  executeStandardLowering,
  serializeSimpleFrontmatter as serializeFrontmatter,
} from "./shared.js";

const TARGET_ID = "gemini-cli" as const;
const EXTENSION_PREFIX = "prism-generated";

export interface GeminiCliLowerTarget {
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
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: GeminiCliLowerTarget;
}

type Reason = "new" | "changed" | "unchanged";

const normalizeBundleSegment = (value: string, fallback = "plugin"): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

const extensionIdForPlugin = (pluginName: string): string =>
  `${EXTENSION_PREFIX}-${normalizeBundleSegment(pluginName)}`;

const extensionRoot = (target: GeminiCliLowerTarget): string =>
  join(target.root, "extensions", extensionIdForPlugin(target.sourcePluginName));

const extensionRelativePath = (target: GeminiCliLowerTarget, path: string): string =>
  relative(extensionRoot(target), path).replace(/\\/g, "/");

const orbitSkillOwnerMarker = (sourcePluginName: string): string =>
  `<!-- prism:orbit-skill owner=${JSON.stringify(sourcePluginName)} -->`;

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

const uniqueSorted = (values: ReadonlyArray<string>): string[] =>
  [...new Set(values.filter((value) => value.length > 0))].sort((left, right) => left.localeCompare(right));

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

const writeReason = async (target: string, content: string): Promise<Reason> => {
  if (!(await exists(target))) return "new";
  return (await readFile(target)) === content ? "unchanged" : "changed";
};

const pushWrite = async (
  operations: LowerOperation[],
  target: string,
  content: string,
  kind: "write-md" | "write-plugin-file" = "write-plugin-file",
): Promise<void> => {
  operations.push({
    kind,
    target,
    content,
    reason: await writeReason(target, content),
  });
};

const composeGeminiAgentFrontmatter = (agent: ComposedAgent, target: GeminiCliLowerTarget): Record<string, unknown> => {
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

  const serverName = extensionIdForPlugin(target.sourcePluginName);
  const tools = uniqueSorted([
    ...(Array.isArray(override?.tools) && override.tools.every((tool) => typeof tool === "string")
      ? override.tools
      : []),
    ...agent.allowedTools,
    ...agent.toolBindings.map((binding) =>
      geminiMcpToolNameForBinding(target.sourcePluginName, serverName, binding),
    ),
  ]);
  if (tools.length > 0) frontmatter.tools = tools;

  const skills = uniqueSorted(agent.allowedSkills);
  if (skills.length > 0) frontmatter.skills = skills;

  return frontmatter;
};

const renderGeminiAgentMarkdown = (agent: ComposedAgent, target: GeminiCliLowerTarget): string =>
  `${serializeFrontmatter(composeGeminiAgentFrontmatter(agent, target))}\n\n${agent.body}\n`;

const renderGeminiOrbitSkillMarkdown = (
  orbit: Orbit,
  sourcePluginName: string,
  registry: PluginRegistry | undefined,
): string => {
  const lines: string[] = [];
  lines.push(serializeFrontmatter({ name: orbit.name, description: orbit.description }));
  lines.push("");
  lines.push(orbitSkillOwnerMarker(sourcePluginName));
  lines.push("");
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

const targetIncludesGemini = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsGemini = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesGemini(registry?.targets[artifact]);

const copyTargetedSkillArtifacts = async (
  input: LowerInput,
  operations: LowerOperation[],
  desired: Set<string>,
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsGemini(input.registry, "skills")) return;

  const files = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of files) {
    const target = join(extensionRoot(input.target), "skills", file.relativePath);
    const content = await readFile(file.sourcePath);
    desired.add(extensionRelativePath(input.target, target));
    await pushWrite(operations, target, content, file.relativePath.endsWith(".md") ? "write-md" : "write-plugin-file");
  }
};

const collectContextFiles = async (input: LowerInput): Promise<ReadonlyArray<{ label: string; content: string }>> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsGemini(input.registry, "rules")) return [];

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

const tomlString = (value: string): string => JSON.stringify(value);

const tomlMultilineString = (value: string): string => {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
  return `"""${escaped}"""`;
};

const markdownCommandToToml = (source: string): string => {
  const parsed = matter(source);
  const lines: string[] = [];
  const description = parsed.data.description;
  if (typeof description === "string" && description.trim().length > 0) {
    lines.push(`description = ${tomlString(description.trim())}`);
  }
  lines.push(`prompt = ${tomlMultilineString(parsed.content.trim())}`);
  return `${lines.join("\n")}\n`;
};

const copyTargetedCommandArtifacts = async (
  input: LowerInput,
  operations: LowerOperation[],
  desired: Set<string>,
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsGemini(input.registry, "commands")) return;

  const files = await collectArtifactSourceFiles(pluginPath, "commands", TARGET_ID);
  for (const file of files) {
    if (!file.relativePath.endsWith(".toml") && !file.relativePath.endsWith(".md")) continue;
    const relativeTarget = file.relativePath.endsWith(".md")
      ? file.relativePath.replace(/\.md$/u, ".toml")
      : file.relativePath;
    const target = join(extensionRoot(input.target), "commands", relativeTarget);
    const source = await readFile(file.sourcePath);
    const content = file.relativePath.endsWith(".md") ? markdownCommandToToml(source) : source;
    desired.add(extensionRelativePath(input.target, target));
    await pushWrite(operations, target, content);
  }
};

const collectHookBindings = (
  sourcePluginName: string,
  serverName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyMap<string, string> => {
  const byRef = new Map<string, string>();
  for (const binding of bindings) {
    const mcpName = geminiMcpToolNameForBinding(sourcePluginName, serverName, binding);
    byRef.set(binding.logicalName, mcpName);
    byRef.set(binding.toolName, mcpName);
    byRef.set(`${binding.toolPluginName}:${binding.toolName}`, mcpName);
    if (binding.contract) byRef.set(binding.contract.name, mcpName);
  }
  return byRef;
};

const regexEscape = (value: string): string => value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");

const geminiMcpToolNameForBinding = (
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

const geminiHookEvent = (event: Hook["event"]): string => {
  switch (event) {
    case "tool.before":
      return "BeforeTool";
    case "tool.after":
      return "AfterTool";
    case "session.start":
      return "SessionStart";
    case "session.end":
      return "SessionEnd";
  }
};

const renderHookWrapperEntry = (hookSourcePath: string, event: Hook["event"], nativeEvent: string, hookRuntimePath: string): string => `
import { Effect } from ${JSON.stringify(effectBundleImportPath())};
import hook from ${JSON.stringify(hookSourcePath.replace(/\\/g, "/"))};
import { decodeNativeHookPayloadForEvent, decodeHookResultForEvent } from ${JSON.stringify(hookRuntimePath.replace(/\\/g, "/"))};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const parseInput = async () => {
  const raw = (await readStdin()).trim();
  if (!raw) return {};
  return JSON.parse(raw);
};

const nativeToolName = (input) =>
  input?.tool?.name ?? input?.toolName ?? input?.tool_name ?? input?.name ?? "";

const nativeToolInput = (input) =>
  input?.tool?.input ?? input?.toolInput ?? input?.tool_input ?? input?.args ?? input?.arguments ?? {};

const session = (input) => {
  const id = input?.session?.id ?? input?.sessionId ?? input?.session_id;
  return id === undefined ? undefined : { id: String(id) };
};

const normalizePayload = (input) => {
  const target = { harness: "gemini-cli", nativeEvent: ${JSON.stringify(nativeEvent)} };
  const cwd = input?.cwd ?? input?.workspace?.cwd;
  switch (${JSON.stringify(event)}) {
    case "tool.before":
      return { target, tool: { name: String(nativeToolName(input)), input: nativeToolInput(input) }, cwd, session: session(input) };
    case "tool.after":
      return { target, tool: { name: String(nativeToolName(input)), input: nativeToolInput(input), output: input?.tool?.output ?? input?.tool_response ?? input?.toolResponse ?? input?.toolOutput ?? input?.tool_output ?? input?.output, success: input?.tool?.success ?? input?.success }, cwd, session: session(input) };
    case "session.start":
      return { target, cwd, session: session(input) ?? { id: "gemini-cli" } };
    case "session.end":
      return { target, cwd, session: session(input) ?? { id: "gemini-cli" }, reason: input?.reason };
  }
};

const unwrapDecode = (decoded, label) => {
  if (decoded && decoded._tag === "Right") return decoded.right;
  throw new Error("prism hook " + label + " validation failed");
};

const toGeminiHookOutput = (nativeEvent, result) => {
  if (result.decision === "block") {
    return {
      decision: "deny",
      reason: result.message,
      hookSpecificOutput: { hookEventName: nativeEvent },
    };
  }

  return {
    continue: true,
    decision: nativeEvent === "BeforeTool" ? "approve" : "allow",
    hookSpecificOutput: { hookEventName: nativeEvent },
  };
};

const toPromise = (value) => Effect.isEffect(value) ? Effect.runPromise(value) : Promise.resolve(value);

const payload = unwrapDecode(decodeNativeHookPayloadForEvent(${JSON.stringify(event)}, normalizePayload(await parseInput())), "native payload");
const rawResult = await toPromise(hook.handle(payload));
const result = unwrapDecode(decodeHookResultForEvent(${JSON.stringify(event)}, rawResult ?? { decision: "continue" }), "result");
process.stdout.write(JSON.stringify(toGeminiHookOutput(${JSON.stringify(nativeEvent)}, result)));
`;

const bundleHookWrapper = async (hook: Hook, nativeEvent: string): Promise<string> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-gemini-hook-"));
  try {
    const entry = join(tempRoot, "hook-entry.ts");
    const hookRuntimePath = join(tempRoot, "hook-runtime.mjs");
    await nodeWriteFile(hookRuntimePath, GENERATED_HOOK_RUNTIME);
    await nodeWriteFile(entry, renderHookWrapperEntry(hook.sourcePath, hook.event, nativeEvent, hookRuntimePath));
    const outdir = join(tempRoot, "dist");
    await buildHookWrapperWithBun(entry, outdir, `Gemini '${hook.name}'`);
    const built = await readFile(join(outdir, "wrapper.mjs"));
    return built.startsWith("#!") ? built : `#!/usr/bin/env node\n${built}`;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const planHooks = async (
  input: LowerInput,
  operations: LowerOperation[],
  desired: Set<string>,
): Promise<void> => {
  const hooks = [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  if (hooks.length === 0 || !input.registry || !artifactTargetsGemini(input.registry, "hooks")) return;

  const serverName = extensionIdForPlugin(input.target.sourcePluginName);
  const canonicalToolNames = collectHookBindings(
    input.target.sourcePluginName,
    serverName,
    mcpBindingsForInput(input),
  );
  const byEvent: Record<string, unknown[]> = {};
  for (const hook of hooks) {
    const nativeEvent = geminiHookEvent(hook.event);
    const resolved = await Effect.runPromise(resolveHookMatchForTarget(hook, input.registry, TARGET_ID));
    const wrapperRelativePath = `hooks/${normalizeBundleSegment(hook.name, "hook")}.mjs`;
    const wrapperTarget = join(extensionRoot(input.target), wrapperRelativePath);
    desired.add(wrapperRelativePath);
    await pushWrite(operations, wrapperTarget, await bundleHookWrapper(hook, nativeEvent));

    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: "command",
          command: `node \"\${extensionPath}/${wrapperRelativePath}\"`,
        },
      ],
    };
    const matcher = matcherForHook(resolved, canonicalToolNames);
    if (matcher) entry.matcher = matcher;
    (byEvent[nativeEvent] ??= []).push(entry);
  }

  const configTarget = join(extensionRoot(input.target), "hooks", "hooks.json");
  desired.add("hooks/hooks.json");
  await pushWrite(operations, configTarget, json({ hooks: byEvent }));
};

const planMcpBundle = async (
  input: LowerInput,
  operations: LowerOperation[],
  desired: Set<string>,
): Promise<Record<string, unknown>> => {
  const bindings = mcpBindingsForInput(input);
  if (bindings.length === 0) return {};

  const extensionId = extensionIdForPlugin(input.target.sourcePluginName);
  const bundle = await generateMcpServerBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath,
    serverName: extensionId,
    version: input.target.sourcePluginVersion,
    bundleId: extensionId,
    bindings,
  });
  const target = join(extensionRoot(input.target), bundle.relativePath);
  desired.add(bundle.relativePath);
  await pushWrite(operations, target, bundle.content);

  return {
    [extensionId]: {
      command: "bun",
      args: [`\${extensionPath}/${bundle.relativePath}`],
    },
  };
};

const planExtensionPruning = async (
  target: GeminiCliLowerTarget,
  desired: ReadonlySet<string>,
): Promise<LowerOperation[]> => {
  const root = extensionRoot(target);
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

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const desired = new Set<string>();
  const root = extensionRoot(input.target);

  const contextFiles = await collectContextFiles(input);
  if (contextFiles.length > 0) {
    const target = join(root, "GEMINI.md");
    desired.add("GEMINI.md");
    await pushWrite(operations, target, renderContext(contextFiles), "write-md");
  }

  for (const agent of input.agents) {
    const target = join(root, "agents", `${agent.name}.md`);
    desired.add(extensionRelativePath(input.target, target));
    await pushWrite(operations, target, renderGeminiAgentMarkdown(agent, input.target), "write-md");
  }

  await copyTargetedSkillArtifacts(input, operations, desired);

  for (const orbit of input.orbits) {
    const target = join(root, "skills", orbit.name, "SKILL.md");
    desired.add(extensionRelativePath(input.target, target));
    await pushWrite(
      operations,
      target,
      renderGeminiOrbitSkillMarkdown(orbit, input.target.sourcePluginName, input.registry),
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
      desired.add(extensionRelativePath(input.target, referenceTarget));
      await pushWrite(operations, referenceTarget, reference.content, "write-md");
    }
  }

  await copyTargetedCommandArtifacts(input, operations, desired);
  const mcpServers = await planMcpBundle(input, operations, desired);
  await planHooks(input, operations, desired);

  const manifest: Record<string, unknown> = {
    name: extensionIdForPlugin(input.target.sourcePluginName),
    version: input.target.sourcePluginVersion ?? "0.1.0",
  };
  if (contextFiles.length > 0) manifest.contextFileName = "GEMINI.md";
  if (Object.keys(mcpServers).length > 0) manifest.mcpServers = mcpServers;

  const manifestTarget = join(root, "gemini-extension.json");
  desired.add("gemini-extension.json");
  await pushWrite(operations, manifestTarget, json(manifest));

  operations.push(...await planExtensionPruning(input.target, desired));
  return operations;
};

export const executeLowering = executeStandardLowering;
