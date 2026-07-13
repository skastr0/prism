/** Oh My Pi native-surface lowerer. */

import { Effect } from "effect";
import { join } from "node:path";
import type { ComposedAgent } from "../compose.js";
import { resolveHookMatchForTarget } from "../hooks.js";
import {
  generatePiExtensionBundle,
  mcpToolNameForBinding,
  type PiExtensionBundle,
} from "../mcp-bundle.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  bindingsFromCanonicalTools,
  bindingsOwnedByPlugin,
  collectBindingNameMap,
  groupAgentToolBindingsByOwner,
  ownerPluginForBinding,
} from "../tool-bindings.js";
import type { HarnessScope } from "../../types.js";
import type { DesiredFile } from "../../sync/desired.js";
import {
  bundleGeneratedHookWrapper,
  createGeneratedPluginPlanState,
  createGeneratedPluginWritePusher,
  matcherForResolvedToolHook,
  nativeHookEventName,
  normalizeBundleSegment,
  planGeneratedPluginAgentWrites,
  planGeneratedPluginOrbitSkillWrites,
  planGeneratedPluginSkillWrites,
  renderGeneratedOrbitSkill,
  renderPrePostSessionHookWrapperEntry,
  serializeSimpleFrontmatter as serializeFrontmatter,
  stringArray,
  uniqueSorted,
  type LowerOutput,
} from "./shared.js";

const TARGET_ID = "omp" as const;
const GENERATED_EXTENSION_PREFIX = "prism-generated";

export interface OmpLowerTarget {
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
  readonly target: OmpLowerTarget;
}

interface PlannedHook {
  readonly hook: Hook;
  readonly nativeEvent: string;
  readonly matcher?: string;
  readonly relativePath: string;
}

const rootPath = (target: OmpLowerTarget, relativePath: string): string =>
  join(target.root, ...relativePath.split("/"));

const extensionRoot = (target: OmpLowerTarget): string =>
  join(
    target.root,
    "extensions",
    `${GENERATED_EXTENSION_PREFIX}-${normalizeBundleSegment(target.sourcePluginName)}`,
  );

const extensionPath = (target: OmpLowerTarget, relativePath: string): string =>
  join(extensionRoot(target), ...relativePath.split("/"));

const pushRootWrite = createGeneratedPluginWritePusher(rootPath);
const pushExtensionWrite = createGeneratedPluginWritePusher(extensionPath);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;


const composeAgentTools = (
  agent: ComposedAgent,
  target: OmpLowerTarget,
  override: Record<string, unknown> | undefined,
): string[] => {
  const generatedTools: string[] = [];
  for (const [ownerPlugin, bindings] of groupAgentToolBindingsByOwner(
    target.sourcePluginName,
    agent,
  )) {
    for (const binding of bindings) {
      generatedTools.push(mcpToolNameForBinding(ownerPlugin, binding));
    }
  }
  return uniqueSorted([
    ...stringArray(override?.tools),
    ...stringArray(override?.["allowed-tools"]),
    ...agent.allowedTools,
    ...generatedTools,
  ], { dropEmpty: true });
};

const OMP_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
]);

const thinkingLevel = (...values: unknown[]): string | undefined =>
  values
    .map(nonEmptyString)
    .find((value): value is string =>
      value !== undefined && OMP_THINKING_LEVELS.has(value),
    );

const composeAgentFrontmatter = (
  agent: ComposedAgent,
  target: OmpLowerTarget,
): Record<string, unknown> => {
  const override = agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;
  const model = agent.model ?? {};
  const tools = composeAgentTools(agent, target, override);
  const spawns = override?.spawns === "*" ? "*" : stringArray(override?.spawns);
  const overrideModels = stringArray(override?.model);
  const configuredModel =
    overrideModels.length > 0
      ? overrideModels.length === 1 ? overrideModels[0] : overrideModels
      : nonEmptyString(model.model);
  const autoloadSkills = uniqueSorted([
    ...agent.skills,
    ...stringArray(override?.autoloadSkills),
  ], { dropEmpty: true });
  return {
    name: nonEmptyString(override?.name) ?? agent.name,
    description: nonEmptyString(override?.description) ?? agent.description,
    model: configuredModel,
    thinkingLevel: thinkingLevel(
      override?.thinkingLevel,
      override?.thinking,
      override?.reasoningEffort,
      override?.reasoning_effort,
      model.thinking,
      model.reasoningEffort,
      model.reasoning_effort,
      model.effort,
      model.variant,
    ),
    tools: tools.length > 0 ? tools : undefined,
    spawns: spawns === "*" || spawns.length > 0 ? spawns : undefined,
    output: override?.output,
    blocking: typeof override?.blocking === "boolean" ? override.blocking : undefined,
    autoloadSkills: autoloadSkills.length > 0 ? autoloadSkills : undefined,
    readSummarize:
      typeof override?.readSummarize === "boolean" ? override.readSummarize : undefined,
  };
};

const renderAgentMarkdown = (agent: ComposedAgent, target: OmpLowerTarget): string => {
  const lines = [serializeFrontmatter(composeAgentFrontmatter(agent, target)), "", agent.body];
  return `${lines.join("\n").trimEnd()}\n`;
};

const uniqueBindings = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyArray<ResolvedContractBinding> => {
  const byToolName = new Map<string, ResolvedContractBinding>();
  for (const binding of bindings) {
    const toolName = mcpToolNameForBinding(sourcePluginName, binding);
    const existing = byToolName.get(toolName);
    if (existing === undefined) {
      byToolName.set(toolName, binding);
      continue;
    }

    const sameBinding =
      existing.kind === binding.kind &&
      existing.toolPluginName === binding.toolPluginName &&
      existing.toolName === binding.toolName &&
      existing.toolSourcePath === binding.toolSourcePath &&
      existing.contract?.pluginName === binding.contract?.pluginName &&
      existing.contract?.name === binding.contract?.name;
    if (!sameBinding) throw new Error(`OMP tool name collision for '${toolName}'`);
  }
  return [...byToolName.values()].sort((left, right) =>
    mcpToolNameForBinding(sourcePluginName, left).localeCompare(
      mcpToolNameForBinding(sourcePluginName, right),
    ),
  );
};

const ompNativeHookEvent = (event: Hook["event"]): string =>
  nativeHookEventName(event, {
    toolBefore: "tool_call",
    toolAfter: "tool_result",
    sessionStart: "session_start",
    sessionEnd: "session_shutdown",
  });

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
    nativeEvent: ompNativeHookEvent(hook.event),
    cwdExpression: "input?.cwd",
    fallbackSessionId: TARGET_ID,
    nativeToolInputExpression:
      "input?.tool_input ?? input?.toolInput ?? input?.input ?? input?.args ?? input?.arguments ?? {}",
    toolAfterOutputExpression:
      "input?.tool_output ?? input?.toolOutput ?? input?.output ?? input?.content ?? input?.details",
    nativeSessionEndReasonExpression: "input?.reason",
    resultHandlingSource: "process.stdout.write(JSON.stringify(result));",
  });

const bundleHookWrapper = async (hook: Hook): Promise<string> =>
  bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-omp-hook-",
    buildLabel: `OMP '${hook.name}'`,
    renderEntry: renderHookWrapperEntry,
  });

const planHookWrappers = async (
  input: LowerInput,
  files: DesiredFile[],
  desiredRelativePaths: Set<string>,
): Promise<PlannedHook[]> => {
  const hooks = [...(input.hooks ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const bindings = uniqueBindings(input.target.sourcePluginName, [
    ...bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools ?? []),
    ...input.agents.flatMap((agent) => agent.toolBindings),
  ]);
  const canonicalToolNames = collectBindingNameMap(bindings, (binding) => {
    const owner = ownerPluginForBinding(input.target.sourcePluginName, binding);
    return mcpToolNameForBinding(owner, binding);
  });
  const planned: PlannedHook[] = [];

  for (const hook of hooks) {
    const relativePath = `hooks/${normalizeBundleSegment(hook.name, "hook")}.mjs`;
    let matcher: string | undefined;
    if (input.registry !== undefined && (hook.event === "tool.before" || hook.event === "tool.after")) {
      const resolved = await Effect.runPromise(
        resolveHookMatchForTarget(hook, input.registry, TARGET_ID),
      );
      matcher = matcherForResolvedToolHook(resolved, canonicalToolNames);
    }
    pushExtensionWrite(
      files,
      desiredRelativePaths,
      input.target,
      relativePath,
      await bundleHookWrapper(hook),
      { mode: 0o755 },
    );
    planned.push({
      hook,
      nativeEvent: ompNativeHookEvent(hook.event),
      matcher,
      relativePath: `./${relativePath}`,
    });
  }

  return planned;
};

const renderExtensionSetupImports = (plannedHooks: ReadonlyArray<PlannedHook>): string =>
  plannedHooks.length === 0
    ? ""
    : [
        `import { spawn } from "node:child_process";`,
        `import { dirname, join } from "node:path";`,
        `import { fileURLToPath } from "node:url";`,
      ].join("\n");

const renderHookSetup = (plannedHooks: ReadonlyArray<PlannedHook>): string => {
  if (plannedHooks.length === 0) return "";
  return `
const prismExtensionDir = dirname(fileURLToPath(import.meta.url));
const prismHooks = ${JSON.stringify(plannedHooks.map((hook) => ({
    sourceEvent: hook.hook.event,
    nativeEvent: hook.nativeEvent,
    matcher: hook.matcher,
    path: hook.relativePath,
  })))};

const prismRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const prismMatches = (matcher: string | undefined, value: string): boolean => {
  if (matcher === undefined) return true;
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
};

const runPrismHook = async (hook: { readonly path: string }, payload: unknown): Promise<unknown> => {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const child = spawn(process.execPath, [join(prismExtensionDir, hook.path)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Uint8Array) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk: Uint8Array) => { stderr += String(chunk); });
  child.on("error", reject);
  child.on("close", (code: number | null) => {
    if (code !== 0) {
      reject(new Error(stderr.trim() || "Prism OMP hook failed with exit " + String(code)));
      return;
    }
    const trimmed = stdout.trim();
    resolve(trimmed.length > 0 ? JSON.parse(trimmed) : { decision: "continue" });
  });
  child.stdin.end(JSON.stringify(payload));
  return await promise;
};

const prismEventValue = (event: unknown, key: string): unknown => prismRecord(event)?.[key];
const prismContextValue = (context: unknown, key: string): unknown => prismRecord(context)?.[key];
const prismSessionId = (context: unknown): string | undefined => {
  const manager = prismRecord(prismContextValue(context, "sessionManager"));
  const getSessionFile = manager?.getSessionFile;
  return typeof getSessionFile === "function"
    ? String(Reflect.apply(getSessionFile, manager, []))
    : undefined;
};

const prismHookPayload = (nativeEvent: string, event: unknown, context: unknown): Record<string, unknown> => ({
  hook_event_name: nativeEvent,
  session_id: prismSessionId(context),
  cwd: typeof prismContextValue(context, "cwd") === "string"
    ? prismContextValue(context, "cwd")
    : process.cwd(),
  tool_name: prismEventValue(event, "toolName"),
  tool_input: prismEventValue(event, "input"),
  tool_output: prismEventValue(event, "content") ?? prismEventValue(event, "details"),
  reason: prismEventValue(event, "reason"),
  native: event,
});

const hooksForEvent = (nativeEvent: string, toolName = "") =>
  prismHooks.filter((hook) =>
    hook.nativeEvent === nativeEvent && prismMatches(hook.matcher, toolName),
  );

if (typeof pi.on === "function") {
  pi.on("tool_call", async (event: unknown, context: unknown) => {
    for (const hook of hooksForEvent("tool_call", String(prismEventValue(event, "toolName") ?? ""))) {
      const result = prismRecord(await runPrismHook(hook, prismHookPayload("tool_call", event, context)));
      if (result?.decision === "block") {
        return {
          block: true,
          reason: typeof result.message === "string" ? result.message : "Blocked by Prism hook",
        };
      }
    }
  });

  pi.on("tool_result", async (event: unknown, context: unknown) => {
    for (const hook of hooksForEvent("tool_result", String(prismEventValue(event, "toolName") ?? ""))) {
      await runPrismHook(hook, prismHookPayload("tool_result", event, context));
    }
  });

  pi.on("session_start", async (event: unknown, context: unknown) => {
    for (const hook of hooksForEvent("session_start")) {
      await runPrismHook(hook, prismHookPayload("session_start", event, context));
    }
  });

  pi.on("session_shutdown", async (event: unknown, context: unknown) => {
    for (const hook of hooksForEvent("session_shutdown")) {
      await runPrismHook(hook, prismHookPayload("session_shutdown", event, context));
    }
  });
}`;
};

const planExtension = async (options: {
  readonly input: LowerInput;
  readonly files: DesiredFile[];
  readonly desiredRelativePaths: Set<string>;
  readonly plannedHooks: ReadonlyArray<PlannedHook>;
}): Promise<void> => {
  const bindings = uniqueBindings(options.input.target.sourcePluginName, [
    ...bindingsOwnedByPlugin(
      options.input.target.sourcePluginName,
      options.input.tools ?? [],
      options.input.agents,
    ),
  ]);
  const setupSource = renderHookSetup(options.plannedHooks);
  if (bindings.length === 0 && setupSource.trim().length === 0) return;

  const bundle: PiExtensionBundle = await generatePiExtensionBundle({
    sourcePluginName: options.input.target.sourcePluginName,
    sourcePluginRoot:
      options.input.target.sourcePluginPath ?? options.input.registry?.pluginPath,
    dependencyPluginRoots: options.input.registry
      ? Object.entries(options.input.registry.dependencyPaths)
      : undefined,
    version: options.input.target.sourcePluginVersion,
    bindings,
    setupImports: renderExtensionSetupImports(options.plannedHooks),
    setupSource,
    runtimeAgent: TARGET_ID,
    harnessLabel: "OMP",
  });

  pushExtensionWrite(
    options.files,
    options.desiredRelativePaths,
    options.input.target,
    "index.ts",
    bundle.content,
  );
};

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const rootState = createGeneratedPluginPlanState();
  const extensionState = createGeneratedPluginPlanState();

  await planGeneratedPluginAgentWrites({
    input,
    state: rootState,
    pushWrite: pushRootWrite,
    renderAgentMarkdown: (agent) => renderAgentMarkdown(agent, input.target),
  });
  await planGeneratedPluginSkillWrites({ input, state: rootState, pushWrite: pushRootWrite });
  await planGeneratedPluginOrbitSkillWrites({
    input,
    state: rootState,
    pushWrite: pushRootWrite,
    renderOrbitSkill: (orbit) =>
      renderGeneratedOrbitSkill({
        orbit,
        registry: input.registry,
        trailingNewline: true,
      }),
  });

  const plannedHooks = await planHookWrappers(
    input,
    extensionState.files,
    extensionState.desiredRelativePaths,
  );
  await planExtension({
    input,
    files: extensionState.files,
    desiredRelativePaths: extensionState.desiredRelativePaths,
    plannedHooks,
  });

  return {
    files: [...rootState.files, ...extensionState.files],
    regions: [],
  };
};
