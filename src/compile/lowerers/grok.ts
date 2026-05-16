/**
 * Grok plugin-bundle lowerer.
 *
 * Produces one compiler-owned Grok plugin bundle under
 * <grok-root>/plugins/prism-generated-<source-plugin>/.
 */

import { join } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget } from "../hooks.js";
import {
  generateMcpServerBundle,
  mcpToolNameForBinding,
} from "../mcp-bundle.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { bindingsFromCanonicalTools } from "../tool-bindings.js";
import { listDirRecursive, readFile } from "../../fs.js";
import type { HarnessScope } from "../../types.js";
import { effectBundleImportPath } from "../runtime-deps.js";
import type { LowerOperation } from "./opencode.js";
import {
  bundleGeneratedHookWrapper,
  createGeneratedPluginWritePusher,
  executeStandardLowering,
  matcherForResolvedToolHook,
  normalizeBundleSegment,
  planGeneratedPluginHooks,
  planGeneratedPluginFilePruning,
  renderStandardOrbitSkill,
  yamlScalar,
} from "./shared.js";

const TARGET_ID = "grok" as const;
const GENERATED_PLUGIN_PREFIX = "prism-generated";

export interface GrokLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
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
  readonly target: GrokLowerTarget;
}

const generatedPluginId = (target: GrokLowerTarget): string =>
  `${GENERATED_PLUGIN_PREFIX}-${normalizeBundleSegment(target.sourcePluginName)}`;

const generatedPluginRoot = (target: GrokLowerTarget): string =>
  join(target.root, "plugins", generatedPluginId(target));

const generatedPath = (target: GrokLowerTarget, relativePath: string): string =>
  join(generatedPluginRoot(target), ...relativePath.split("/"));

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

const uniqueSorted = (values: ReadonlyArray<string>): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const mcpBindingsForInput = (input: LowerInput): ReadonlyArray<ResolvedContractBinding> => [
  ...bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools ?? []),
  ...input.agents.flatMap((agent) => agent.toolBindings),
];

const serializeFrontmatter = (values: Record<string, unknown>): string => {
  const lines = ["---"];
  const orderedKeys = [
    "name",
    "description",
    "model",
    "prompt_mode",
    "permission_mode",
    "agents_md",
    "effort",
    "reasoning_effort",
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

const composeAgentFrontmatter = (agent: ComposedAgent): Record<string, unknown> => {
  const override = agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;
  const model = agent.model ?? {};
  const tools = uniqueSorted([
    ...stringArray(override?.tools),
    ...stringArray(override?.["allowed-tools"]),
    ...agent.allowedTools,
  ]);

  return {
    name: agent.name,
    description: typeof override?.description === "string" ? override.description : agent.description,
    model:
      typeof override?.model === "string"
        ? override.model
        : typeof model.model === "string"
          ? model.model
          : undefined,
    prompt_mode:
      typeof override?.prompt_mode === "string" ? override.prompt_mode : undefined,
    permission_mode:
      typeof override?.permission_mode === "string"
        ? override.permission_mode
        : typeof override?.permissionMode === "string"
          ? override.permissionMode
          : undefined,
    agents_md: typeof override?.agents_md === "boolean" ? override.agents_md : undefined,
    effort:
      typeof override?.effort === "string"
        ? override.effort
        : typeof model.effort === "string"
          ? model.effort
          : typeof model.variant === "string"
            ? model.variant
            : undefined,
    reasoning_effort:
      typeof override?.reasoning_effort === "string"
        ? override.reasoning_effort
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
): string => {
  return `${serializeFrontmatter(composeAgentFrontmatter(agent))}\n\n${agent.body}\n`;
};

const grokNativeHookEvent = (event: Hook["event"]): string => {
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

const grokMcpToolNameForBinding = (
  sourcePluginName: string,
  pluginId: string,
  binding: ResolvedContractBinding,
): string => `${pluginId}__${mcpToolNameForBinding(sourcePluginName, binding)}`;

const collectHookBindings = (
  sourcePluginName: string,
  pluginId: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyMap<string, string> => {
  const byRef = new Map<string, string>();
  for (const binding of bindings) {
    const mcpName = grokMcpToolNameForBinding(sourcePluginName, pluginId, binding);
    byRef.set(binding.logicalName, mcpName);
    byRef.set(binding.toolName, mcpName);
    byRef.set(`${binding.toolPluginName}:${binding.toolName}`, mcpName);
    if (binding.contract) byRef.set(binding.contract.name, mcpName);
  }
  return byRef;
};

const renderHooksJson = async (
  hooks: ReadonlyArray<Hook>,
  registry: PluginRegistry | undefined,
  target: GrokLowerTarget,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): Promise<string> => {
  const groupedHooks: Record<string, unknown[]> = {};
  const canonicalToolNames = collectHookBindings(
    target.sourcePluginName,
    generatedPluginId(target),
    bindings,
  );

  for (const hook of hooks) {
    const event = grokNativeHookEvent(hook.event);
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: "command",
          command: `node ${JSON.stringify(generatedPath(target, `hooks/${hook.name}.mjs`))}`,
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

const renderHookWrapperEntry = (hook: Hook, hookRuntimePath: string): string => `import { Effect } from ${JSON.stringify(effectBundleImportPath())};
import hook from ${JSON.stringify(hook.sourcePath.replace(/\\/g, "/"))};
import { decodeNativeHookPayloadForEvent, decodeHookResultForEvent } from ${JSON.stringify(hookRuntimePath.replace(/\\/g, "/"))};

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
  const target = { harness: "grok", nativeEvent: ${JSON.stringify(grokNativeHookEvent(hook.event))} };
  const cwd = input?.cwd ?? input?.workspaceRoot ?? input?.workspace?.cwd;

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
      return { target, cwd, session: nativeSession(input) ?? { id: "grok" } };
    case "session.end":
      return { target, cwd, session: nativeSession(input) ?? { id: "grok" }, reason: input?.reason };
  }
};

const unwrapDecode = (decoded, label) => {
  if (decoded && decoded._tag === "Right") return decoded.right;
  throw new Error("prism hook " + label + " validation failed");
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
  console.log(JSON.stringify({ decision: "deny", reason: result.message ?? "blocked" }));
  process.exit(2);
}
`;

const bundleHookWrapper = async (hook: Hook): Promise<string> => {
  return bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-grok-hook-",
    buildLabel: `Grok '${hook.name}'`,
    renderEntry: renderHookWrapperEntry,
  });
};

const pushWrite = createGeneratedPluginWritePusher(generatedPath);

const planMcpServer = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
  const bindings = mcpBindingsForInput(input);
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
    sourcePluginRoot: input.target.sourcePluginPath,
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
          command: "bun",
          args: [generatedPath(input.target, bundle.relativePath)],
        },
      },
    }),
  );
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
      description: `Generated by prism from ${input.target.sourcePluginName}.`,
    }),
  );

  for (const agent of input.agents) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `agents/${agent.name}.md`,
      renderAgentMarkdown(agent),
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

  await planMcpServer(input, operations, desiredRelativePaths);
  const resolveTarget = (relativePath: string): string =>
    generatedPath(input.target, relativePath);
  await planGeneratedPluginHooks({
    operations,
    desiredRelativePaths,
    hooks: input.hooks ?? [],
    hooksJson: await renderHooksJson(
      input.hooks ?? [],
      input.registry,
      input.target,
      mcpBindingsForInput(input),
    ),
    bundleHookWrapper,
    resolveTarget,
  });
  operations.push(
    ...(await planGeneratedPluginFilePruning({
      root: generatedPluginRoot(input.target),
      desiredRelativePaths,
      resolveTarget,
    })),
  );

  return operations;
};

export const executeLowering = executeStandardLowering;
