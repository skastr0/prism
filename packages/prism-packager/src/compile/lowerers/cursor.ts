/**
 * Cursor plugin-bundle lowerer.
 *
 * Cursor plugin hooks are Claude-shaped command scripts (`hooks/hooks.json` +
 * `hooks/*.mjs`), not an in-process SDK. Compiled agents lower as plugin
 * `agents/*.md` subagents (name/description/model). The workflow worker still
 * prompt-injects identity because `agent` has no `--agent` selector.
 */

import { join } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import {
  generatedCursorPluginId,
  renderCursorGeneratedPluginManifest,
} from "../generated-plugin.js";
import { resolveHookMatchForTarget } from "../hooks.js";
import { cliToolNameForBinding } from "../tool-runtime-bundle.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill, Sop } from "../sources.js";
import {
  collectBindingNameMap,
  ownerPluginForBinding,
} from "../tool-bindings.js";
import type { HarnessScope } from "../../types.js";
import {
  bundleGeneratedHookWrapper,
  createGeneratedPluginWritePusher,
  createGeneratedPluginPlanState,
  matcherForResolvedToolHook,
  planGeneratedPluginAgentWrites,
  planGeneratedPluginHookWrites,
  planGeneratedPluginSkillWrites,
  planStandardGeneratedPluginOrbitSkillWrites,
  renderPrePostSessionHookWrapperEntry,
  serializeSimpleFrontmatter,
  type LowerOutput,
} from "./shared.js";

const TARGET_ID = "cursor" as const;

export interface CursorLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
  readonly sourcePluginPath?: string;
}

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly sops: ReadonlyArray<Sop>;
  readonly tools?: ReadonlyArray<CanonicalTool>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: CursorLowerTarget;
}

const generatedPluginId = (target: CursorLowerTarget): string =>
  generatedCursorPluginId(target.sourcePluginName);

const generatedPluginRoot = (target: CursorLowerTarget): string =>
  join(target.root, "plugins", "local", generatedPluginId(target));

const generatedPath = (target: CursorLowerTarget, relativePath: string): string =>
  join(generatedPluginRoot(target), ...relativePath.split("/"));

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const firstDefined = <T>(...values: Array<T | undefined>): T | undefined =>
  values.find((value) => value !== undefined);

const cursorOverrideForAgent = (agent: ComposedAgent): Record<string, unknown> | undefined =>
  agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;

const composeAgentFrontmatter = (agent: ComposedAgent): Record<string, unknown> => {
  const override = cursorOverrideForAgent(agent);
  const model = agent.model ?? {};

  return {
    name: agent.name,
    description: firstDefined(stringValue(override?.description), agent.description),
    model: firstDefined(stringValue(override?.model), stringValue(model.model)),
    readonly: booleanValue(override?.readonly),
    is_background: firstDefined(
      booleanValue(override?.is_background),
      booleanValue(override?.isBackground),
    ),
  };
};

const renderAgentMarkdown = (agent: ComposedAgent): string =>
  `${serializeSimpleFrontmatter(composeAgentFrontmatter(agent))}\n\n${agent.body}\n`;

export const cursorNativeHookEvent = (event: Hook["event"]): string => {
  switch (event) {
    case "tool.before":
      return "preToolUse";
    case "tool.after":
      return "postToolUse";
    case "tool.failure":
      return "postToolUseFailure";
    case "prompt.submit":
      return "beforeSubmitPrompt";
    case "session.start":
      return "sessionStart";
    case "session.end":
      return "sessionEnd";
    case "stop":
      return "stop";
    case "subagent.start":
      return "subagentStart";
    case "subagent.stop":
      return "subagentStop";
    case "compact.before":
      return "preCompact";
    case "permission.request":
    case "compact.after":
    case "notification":
      throw new Error(`Unsupported Cursor hook event: ${event}`);
    default:
      throw new Error(`Unsupported event: ${event}`);
  }
};

const renderHooksJson = async (
  hooks: ReadonlyArray<Hook>,
  registry: PluginRegistry | undefined,
  target: CursorLowerTarget,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): Promise<string> => {
  const groupedHooks: Record<string, unknown[]> = {};
  const canonicalToolNames = collectBindingNameMap(
    bindings,
    (binding) => cliToolNameForBinding(binding),
  );

  for (const hook of hooks) {
    const event = cursorNativeHookEvent(hook.event);
    const entry: Record<string, unknown> = {
      command: `node ${JSON.stringify(generatedPath(target, `hooks/${hook.name}.mjs`))}`,
    };
    if (
      registry &&
      (hook.event === "tool.before" ||
        hook.event === "tool.after" ||
        hook.event === "tool.failure")
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
): string =>
  renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    hookSourcePath,
    harness: TARGET_ID,
    nativeEvent: cursorNativeHookEvent(hook.event),
    cwdExpression: "input?.cwd ?? input?.workspace?.cwd ?? input?.workspace_root",
    fallbackSessionId: TARGET_ID,
    blockDecisionSource: `  console.log(JSON.stringify({
    permission: "deny",
    user_message: result.message ?? "blocked",
  }));
  process.exit(2);`,
  });

const bundleHookWrapper = async (hook: Hook): Promise<string> =>
  bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-cursor-hook-",
    buildLabel: `Cursor '${hook.name}'`,
    renderEntry: renderHookWrapperEntry,
  });

const pushWrite = createGeneratedPluginWritePusher(generatedPath);

const hasCursorBundleArtifacts = (input: LowerInput): boolean =>
  input.agents.length > 0 ||
  input.orbits.length > 0 ||
  (input.skills?.length ?? 0) > 0 ||
  (input.hooks?.length ?? 0) > 0;

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  if (!hasCursorBundleArtifacts(input)) {
    return { files: [], regions: [] };
  }

  const state = createGeneratedPluginPlanState();
  const resolveTarget = (relativePath: string): string =>
    generatedPath(input.target, relativePath);

  pushWrite(
    state.files,
    state.desiredRelativePaths,
    input.target,
    ".cursor-plugin/plugin.json",
    renderCursorGeneratedPluginManifest({
      pluginId: generatedPluginId(input.target),
      version: input.target.sourcePluginVersion ?? "0.1.0",
      sourcePluginName: input.target.sourcePluginName,
    }),
  );
  await planGeneratedPluginAgentWrites({
    input,
    state,
    pushWrite,
    renderAgentMarkdown,
  });
  await planGeneratedPluginSkillWrites({ input, state, pushWrite });
  await planStandardGeneratedPluginOrbitSkillWrites({
    input,
    state,
    pushWrite,
  });
  if ((input.hooks?.length ?? 0) > 0) {
    await planGeneratedPluginHookWrites({
      input,
      state,
      renderHooksJson,
      bundleHookWrapper,
      resolveTarget,
    });
  }

  return { files: state.files, regions: [] };
};
