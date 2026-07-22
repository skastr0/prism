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
import { mcpToolNameForBinding } from "../mcp-bundle.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  collectBindingNameMap,
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
  _target: ClaudeCodeLowerTarget,
): Record<string, unknown> => {
  const override = agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;
  const model = agent.model ?? {};
  // Claude Code treats a subagent's `tools:` frontmatter as an EXCLUSIVE allowlist.
  // Emitting only declared tools strips built-ins (Read/Write/Edit/Bash/…), so generated
  // agents omit `tools:` and inherit built-ins. Canonical tools are invoked via
  // `prism tools invoke` (CLI), not harness MCP wire names. An explicit author
  // `tools:`/`allowed-tools:` override still emits an allowlist (opt-in).
  const explicitTools = uniqueSorted([
    ...stringArray(override?.tools),
    ...stringArray(override?.["allowed-tools"]),
  ]);
  const tools = explicitTools.length > 0
    ? uniqueSorted([...explicitTools, ...agent.allowedTools])
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

const claudeNativeHookEvent = (event: Hook["event"]): string => {
  switch (event) {
    case "tool.before":
      return "PreToolUse";
    case "tool.after":
      return "PostToolUse";
    case "tool.failure":
      return "PostToolUseFailure";
    case "prompt.submit":
      return "UserPromptSubmit";
    case "permission.request":
      return "PermissionRequest";
    case "stop":
      return "Stop";
    case "subagent.start":
      return "SubagentStart";
    case "subagent.stop":
      return "SubagentStop";
    case "compact.before":
      return "PreCompact";
    case "compact.after":
      return "PostCompact";
    case "notification":
      return "Notification";
    case "session.start":
      return "SessionStart";
    case "session.end":
      return "SessionEnd";
    default:
      throw new Error(`Unsupported event: ${event}`);
  }
};

/** Logical generated tool name for hook matchers (CLI tool surface, not MCP wire). */
const claudeToolNameForBinding = (
  ownerPluginName: string,
  binding: ResolvedContractBinding,
): string => mcpToolNameForBinding(ownerPluginName, binding);

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
      return claudeToolNameForBinding(owner, binding);
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
    if (
      registry &&
      (hook.event === "tool.before" ||
        hook.event === "tool.after" ||
        hook.event === "tool.failure" ||
        hook.event === "permission.request")
    ) {
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
): string => {
  const nativeEvent = claudeNativeHookEvent(hook.event);
  const supportsAdditionalContext =
    nativeEvent === "PreToolUse" ||
    nativeEvent === "PostToolUse" ||
    nativeEvent === "UserPromptSubmit" ||
    nativeEvent === "SessionStart" ||
    nativeEvent === "SubagentStart";

  return renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    hookSourcePath,
    harness: TARGET_ID,
    nativeEvent,
    cwdExpression: "input?.cwd ?? input?.workspace?.cwd",
    fallbackSessionId: TARGET_ID,
    toolAfterOutputExpression:
      "input?.tool?.output ?? input?.toolOutput ?? input?.tool_output ?? input?.output",
    resultHandlingSource: `const writeHookJson = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const output = {};
if (result.systemMessage) output.systemMessage = result.systemMessage;

if (result.decision === "block") {
  if (${JSON.stringify(nativeEvent)} === "PreToolUse") {
    output.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: result.message,
    };
  } else if (${JSON.stringify(nativeEvent)} === "PermissionRequest") {
    output.hookSpecificOutput = {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: result.message,
      },
    };
  } else if (
    ${JSON.stringify(nativeEvent)} === "UserPromptSubmit" ||
    ${JSON.stringify(nativeEvent)} === "Stop" ||
    ${JSON.stringify(nativeEvent)} === "SubagentStop" ||
    ${JSON.stringify(nativeEvent)} === "PreCompact"
  ) {
    output.decision = "block";
    output.reason = result.message;
  }
} else if (result.decision === "allow" && ${JSON.stringify(nativeEvent)} === "PermissionRequest") {
  output.hookSpecificOutput = {
    hookEventName: "PermissionRequest",
    decision: {
      behavior: "allow",
      ...(result.updatedInput !== undefined ? { updatedInput: result.updatedInput } : {}),
    },
  };
} else if (result.decision === "ask" && ${JSON.stringify(nativeEvent)} === "PermissionRequest") {
  // ask degrades to continue decision-wise (continue) - Claude's own dialog proceeds; still emit systemMessage if present.
} else {
  if (${JSON.stringify(nativeEvent)} === "PreToolUse") {
    const specific = {};
    if (result.updatedInput !== undefined) {
      specific.permissionDecision = "allow";
      specific.updatedInput = result.updatedInput;
    }
    if (result.additionalContext !== undefined) {
      specific.additionalContext = result.additionalContext;
    }
    if (Object.keys(specific).length > 0) {
      output.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        ...specific
      };
    }
  } else if (${JSON.stringify(nativeEvent)} === "PostToolUse") {
    const specific = {};
    if (result.updatedOutput !== undefined) {
      specific.updatedToolOutput = result.updatedOutput;
    }
    if (result.additionalContext !== undefined) {
      specific.additionalContext = result.additionalContext;
    }
    if (Object.keys(specific).length > 0) {
      output.hookSpecificOutput = {
        hookEventName: "PostToolUse",
        ...specific
      };
    }
  } else if (${JSON.stringify(supportsAdditionalContext)} && result.additionalContext !== undefined) {
    output.hookSpecificOutput = {
      hookEventName: ${JSON.stringify(nativeEvent)},
      additionalContext: result.additionalContext,
    };
  }
}

if (Object.keys(output).length > 0) {
  writeHookJson(output);
}`,
  });
};

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
  await planGeneratedPluginHookWrites({
    input,
    state,
    renderHooksJson,
    bundleHookWrapper,
    resolveTarget,
  });

  return { files: state.files, regions: [] };
};
