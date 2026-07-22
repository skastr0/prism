/**
 * Devin CLI lowerer (PR1).
 *
 * Skills + orbit skills + Claude-compatible hooks.v1.json. No agents, no MCP,
 * no plugins install. Never whole-file owns config.json.
 */

import { join } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  collectBindingNameMap,
  mcpBindingsForAgentsAndTools,
  ownerPluginForBinding,
} from "../tool-bindings.js";
import { cliToolNameForBinding } from "../tool-runtime-bundle.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import { readFile } from "../../fs.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { DesiredFile, DesiredRegion } from "../../sync/desired.js";
import {
  bundleGeneratedHookWrapper,
  normalizeBundleSegment,
  pushDesiredFile,
  regexEscape,
  renderGeneratedOrbitSkill,
  renderPrePostSessionHookWrapperEntry,
  uniqueSorted,
  type LowerOutput,
} from "./shared.js";
import type { ResolvedContractBinding } from "../resolve.js";

const TARGET_ID = "devin" as const;

export interface DevinLowerTarget {
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
  readonly target: DevinLowerTarget;
}

interface PlannedHook {
  readonly hook: Hook;
  readonly nativeEvent: string;
  readonly matcher?: string;
  readonly relativePath: string;
}

const targetIncludesDevin = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsDevin = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesDevin(registry?.targets[artifact]);

const skillsRoot = (target: DevinLowerTarget): string => join(target.root, "skills");

const hooksConfigPath = (target: DevinLowerTarget): string => join(target.root, "hooks.v1.json");

const userConfigPath = (target: DevinLowerTarget): string => join(target.root, "config.json");

const assertDevinLoweringInput = (input: LowerInput): void => {
  if (input.agents.length > 0) {
    throw new Error(
      "Devin lowerer received agents after target capability validation; this indicates a compiler planning bug.",
    );
  }
};

const copyTargetedSkillArtifacts = async (
  input: LowerInput,
  files: DesiredFile[],
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsDevin(input.registry, "skills")) return;

  const sourceFiles = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of sourceFiles) {
    pushDesiredFile(files, {
      targetPath: join(skillsRoot(input.target), file.relativePath),
      content: await readFile(file.sourcePath),
      plugin: input.target.sourcePluginName,
    });
  }
};

const devinNativeHookEvent = (event: Hook["event"]): string => {
  switch (event) {
    case "tool.before":
      return "PreToolUse";
    case "tool.after":
      return "PostToolUse";
    case "prompt.submit":
      return "UserPromptSubmit";
    case "permission.request":
      return "PermissionRequest";
    case "session.start":
      return "SessionStart";
    case "session.end":
      return "SessionEnd";
    case "stop":
      return "Stop";
    case "compact.after":
      return "PostCompaction";
    default:
      throw new Error(`Unsupported Devin hook event: ${event}`);
  }
};

const collectCanonicalToolNames = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyMap<string, string> =>
  collectBindingNameMap(bindings, (binding) => {
    const owner = ownerPluginForBinding(sourcePluginName, binding);
    // PR1 has no MCP wire names; fall back to logical binding id for matchers.
    return cliToolNameForBinding(owner, binding);
  });

const hookMatcher = (
  nativeEvent: string,
  resolved: ResolvedHookMatch,
  canonicalToolNames: ReadonlyMap<string, string>,
): string | undefined => {
  const nonToolEvents = new Set([
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "Stop",
    "PostCompaction",
  ]);
  if (nonToolEvents.has(nativeEvent)) return undefined;
  const tool = resolved.tool;
  if (!tool) return undefined;
  if (tool.kind === "any") return "";
  if (tool.kind === "canonical-tool") {
    return regexEscape(canonicalToolNames.get(tool.ref) ?? tool.ref);
  }
  if (tool.names.length === 1) return regexEscape(tool.names[0]!);
  return tool.names.map(regexEscape).join("|");
};

const renderDevinHookWrapperEntry = (
  hook: Hook,
  nativeEvent: string,
  hookRuntimePath: string,
  hookSourcePath: string,
): string => {
  const supportsAdditionalContext =
    nativeEvent === "SessionStart" ||
    nativeEvent === "UserPromptSubmit" ||
    nativeEvent === "PostToolUse";

  return renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    hookSourcePath,
    harness: TARGET_ID,
    nativeEvent,
    cwdExpression: "input?.cwd",
    fallbackSessionId: TARGET_ID,
    toolAfterOutputExpression:
      "input?.tool_response ?? input?.toolResponse ?? input?.tool_output ?? input?.output ?? input?.result",
    resultHandlingSource: `const writeHookJson = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const output = {};
if (result.systemMessage) output.systemMessage = result.systemMessage;
if (${JSON.stringify(supportsAdditionalContext)} && result.additionalContext) {
  output.hookSpecificOutput = {
    hookEventName: ${JSON.stringify(nativeEvent)},
    additionalContext: result.additionalContext,
  };
}
if (result.decision === "block") {
  if (${JSON.stringify(hook.event)} === "tool.before") {
    // Devin PreToolUse: non-zero exit blocks (exit 2).
    process.exitCode = 2;
    output.reason = result.message;
  } else if (${JSON.stringify(hook.event)} === "permission.request") {
    // Devin PermissionRequest decisions: approve | block
    output.decision = "block";
    output.reason = result.message;
  } else if (${JSON.stringify(hook.event)} === "stop") {
    output.decision = "block";
    output.reason = result.message;
  }
}
if (${JSON.stringify(hook.event)} === "permission.request" && result.decision === "allow") {
  output.decision = "approve";
}
if (Object.keys(output).length > 0) writeHookJson(output);`,
  });
};

const bundleDevinHookWrapper = async (hook: Hook, nativeEvent: string): Promise<string> =>
  bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-devin-hook-",
    buildLabel: `Devin '${hook.name}'`,
    renderEntry: (currentHook, hookRuntimePath, hookSourcePath) =>
      renderDevinHookWrapperEntry(currentHook, nativeEvent, hookRuntimePath, hookSourcePath),
  });

const planHooks = async (input: LowerInput, files: DesiredFile[]): Promise<PlannedHook[]> => {
  const hooks = [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  if (!input.registry || hooks.length === 0) return [];

  const canonicalToolNames = collectCanonicalToolNames(
    input.target.sourcePluginName,
    mcpBindingsForAgentsAndTools(
      input.target.sourcePluginName,
      input.tools ?? [],
      input.agents,
    ),
  );
  const planned: PlannedHook[] = [];
  const pluginSegment = normalizeBundleSegment(input.target.sourcePluginName, "plugin");

  for (const hook of hooks) {
    const nativeEvent = devinNativeHookEvent(hook.event);
    const resolved = await Effect.runPromise(
      resolveHookMatchForTarget(hook, input.registry, TARGET_ID),
    );
    const relativePath = join(
      "hooks",
      `prism-generated-${pluginSegment}`,
      `${normalizeBundleSegment(hook.name, "hook")}.mjs`,
    );

    pushDesiredFile(files, {
      targetPath: join(input.target.root, ...relativePath.split("/")),
      content: await bundleDevinHookWrapper(hook, nativeEvent),
      plugin: input.target.sourcePluginName,
      mode: 0o755,
    });

    planned.push({
      hook,
      nativeEvent,
      matcher: hookMatcher(nativeEvent, resolved, canonicalToolNames),
      relativePath,
    });
  }

  return planned;
};

const renderHooksV1Json = (
  root: string,
  planned: ReadonlyArray<PlannedHook>,
): string => {
  type HookEntry = {
    matcher?: string;
    hooks: Array<{ type: "command"; command: string; timeout: number }>;
  };
  const byEvent = new Map<string, HookEntry[]>();

  for (const item of planned) {
    const command = `node ${JSON.stringify(join(root, ...item.relativePath.split("/")))}`;
    const entry: HookEntry = {
      hooks: [{ type: "command", command, timeout: 60 }],
    };
    if (item.matcher !== undefined && item.matcher.length > 0) {
      entry.matcher = item.matcher;
    }
    const list = byEvent.get(item.nativeEvent);
    if (list) list.push(entry);
    else byEvent.set(item.nativeEvent, [entry]);
  }

  const ordered: Record<string, HookEntry[]> = {};
  for (const event of uniqueSorted([...byEvent.keys()])) {
    ordered[event] = byEvent.get(event)!;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
};

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const files: DesiredFile[] = [];
  const regions: DesiredRegion[] = [];
  const plugin = input.target.sourcePluginName;

  assertDevinLoweringInput(input);

  await copyTargetedSkillArtifacts(input, files);

  for (const orbit of input.orbits) {
    pushDesiredFile(files, {
      targetPath: join(skillsRoot(input.target), `${orbit.name}/SKILL.md`),
      content: renderGeneratedOrbitSkill({
        orbit,
        registry: input.registry,
        trailingNewline: true,
      }),
      plugin,
    });

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      pushDesiredFile(files, {
        targetPath: join(
          skillsRoot(input.target),
          `${orbit.name}/references/${reference.filename}`,
        ),
        content: reference.content,
        plugin,
      });
    }
  }

  const plannedHooks = await planHooks(input, files);
  if (plannedHooks.length > 0) {
    const pluginSegment = normalizeBundleSegment(plugin, "plugin");
    // Always keep a Prism-owned per-plugin inventory of the planned hooks
    // (not a Devin load path — diagnostic / future merge input).
    pushDesiredFile(files, {
      targetPath: join(
        input.target.root,
        "hooks",
        `prism-generated-${pluginSegment}.hooks.v1.json`,
      ),
      content: renderHooksV1Json(input.target.root, plannedHooks),
      plugin,
    });

    if (input.target.scope === "project") {
      // Project Devin root is `.devin/`; documented load path is hooks.v1.json.
      // Multi-plugin: second plugin claiming the same whole-file path fails
      // closed via sync ownership (no silent last-writer-wins).
      pushDesiredFile(files, {
        targetPath: hooksConfigPath(input.target),
        content: renderHooksV1Json(input.target.root, plannedHooks),
        plugin,
      });
    } else {
      // Global: Devin loads hooks from config.json, not hooks.v1.json.
      // Use json-array-member so herdr/user entries stay untouched.
      for (const item of plannedHooks) {
        const command = `node ${JSON.stringify(join(input.target.root, ...item.relativePath.split("/")))}`;
        const entry: Record<string, unknown> = {
          hooks: [{ type: "command", command, timeout: 60 }],
        };
        if (item.matcher !== undefined && item.matcher.length > 0) {
          entry.matcher = item.matcher;
        }
        regions.push({
          kind: "json-array-member",
          targetPath: userConfigPath(input.target),
          regionKey: `devin.hooks.${pluginSegment}.${normalizeBundleSegment(item.hook.name, "hook")}`,
          jsonPath: ["hooks", item.nativeEvent],
          // Whole-value equality: each Prism entry is unique by command path +
          // matcher. Foreign members (e.g. herdr) stay untouched.
          value: entry,
          plugin,
        });
      }
    }
  }

  return { files, regions };
};
