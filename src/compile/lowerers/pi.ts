/** Pi package/extension lowerer. */

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
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
  collectBindingNameMap,
} from "../tool-bindings.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import { exists, readFile } from "../../fs.js";
import { readHarnessLedger } from "../../managed-ledger.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { LowerOperation } from "./opencode.js";
import {
  bundleGeneratedHookWrapper,
  createGeneratedPluginPlanState,
  createGeneratedPluginWritePusher,
  executeStandardLowering,
  matcherForResolvedToolHook,
  nativeHookEventName,
  normalizeBundleSegment,
  planGeneratedPluginOrbitSkillWrites,
  planGeneratedPluginPruning,
  pushConfigPatchOperation as pushConfigPatch,
  pushWriteOperation,
  renderGeneratedOrbitSkill,
  renderPrePostSessionHookWrapperEntry,
  serializeSimpleFrontmatter as serializeFrontmatter,
  stringArray,
  uniqueSorted,
} from "./shared.js";

const TARGET_ID = "pi" as const;
const GENERATED_PACKAGE_PREFIX = "prism-generated";

export interface PiLowerTarget {
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
  readonly target: PiLowerTarget;
}

interface ContextFile {
  readonly label: string;
  readonly content: string;
}

interface PlannedHook {
  readonly hook: Hook;
  readonly nativeEvent: string;
  readonly matcher?: string;
  readonly relativePath: string;
}

const generatedPackageId = (target: PiLowerTarget): string =>
  `${GENERATED_PACKAGE_PREFIX}-${normalizeBundleSegment(target.sourcePluginName)}`;

const generatedPackageRoot = (target: PiLowerTarget): string =>
  join(target.root, "packages", generatedPackageId(target));

const generatedPath = (target: PiLowerTarget, relativePath: string): string =>
  join(generatedPackageRoot(target), ...relativePath.split("/"));

const settingsPath = (target: PiLowerTarget): string =>
  join(target.root, "settings.json");

const agentsRoot = (target: PiLowerTarget): string =>
  target.scope === "global"
    ? join(dirname(resolve(target.root)), "agents")
    : join(target.root, "agents");

const agentPath = (target: PiLowerTarget, agentName: string): string =>
  join(agentsRoot(target), `${agentName}.md`);

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const targetIncludesPi = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsPi = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesPi(registry?.targets[artifact]);

const agentOwnerMarker = (sourcePluginName: string): string =>
  `<!-- prism:pi-agent owner=${JSON.stringify(sourcePluginName)} -->`;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const firstDefined = <T>(...values: Array<T | undefined>): T | undefined =>
  values.find((value) => value !== undefined);

const piOverrideForAgent = (agent: ComposedAgent): Record<string, unknown> | undefined =>
  agent.targetOverride[TARGET_ID] as Record<string, unknown> | undefined;

const composeAgentTools = (
  agent: ComposedAgent,
  target: PiLowerTarget,
  override: Record<string, unknown> | undefined,
): string[] => uniqueSorted([
  ...stringArray(override?.tools),
  ...stringArray(override?.["allowed-tools"]),
  ...agent.allowedTools,
  ...agent.toolBindings.map((binding) => mcpToolNameForBinding(target.sourcePluginName, binding)),
], { dropEmpty: true });

const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const thinkingValue = (...values: unknown[]): string | undefined =>
  values
    .map(stringValue)
    .find((value): value is string =>
      value !== undefined && PI_THINKING_LEVELS.has(value),
    );

const composePiAgentFrontmatter = (
  agent: ComposedAgent,
  target: PiLowerTarget,
): Record<string, unknown> => {
  const override = piOverrideForAgent(agent);
  const model = agent.model ?? {};
  const tools = composeAgentTools(agent, target, override);
  const skills = uniqueSorted([...agent.skills, ...agent.allowedSkills], { dropEmpty: true });

  return {
    name: stringValue(override?.name) ?? agent.name,
    description: stringValue(override?.description) ?? agent.description,
    model: firstDefined(stringValue(override?.model), stringValue(model.model)),
    thinking: thinkingValue(
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
    skills: skills.length > 0 ? skills : undefined,
  };
};

const renderPiAgentMarkdown = (
  agent: ComposedAgent,
  target: PiLowerTarget,
): string => {
  const lines: string[] = [
    serializeFrontmatter(composePiAgentFrontmatter(agent, target)),
    "",
    agentOwnerMarker(target.sourcePluginName),
    "",
    agent.body,
  ];
  return `${lines.join("\n").trimEnd()}\n`;
};

const renderPiOrbitSkillMarkdown = (
  orbit: Orbit,
  sourcePluginName: string,
  registry: PluginRegistry | undefined,
): string =>
  renderGeneratedOrbitSkill({
    orbit,
    sourcePluginName,
    registry,
    ownerKind: "pi-orbit-skill",
    trailingNewline: true,
  });

const pushWrite = createGeneratedPluginWritePusher(generatedPath);

const uniqueBindings = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyArray<ResolvedContractBinding> => {
  const byToolName = new Map<string, ResolvedContractBinding>();
  for (const binding of bindings) {
    const toolName = mcpToolNameForBinding(sourcePluginName, binding);
    const existing = byToolName.get(toolName);
    if (!existing) {
      byToolName.set(toolName, binding);
      continue;
    }

    const same =
      existing.kind === binding.kind &&
      existing.toolPluginName === binding.toolPluginName &&
      existing.toolName === binding.toolName &&
      existing.toolSourcePath === binding.toolSourcePath &&
      existing.contract?.pluginName === binding.contract?.pluginName &&
      existing.contract?.name === binding.contract?.name;
    if (!same) throw new Error(`Pi tool name collision for '${toolName}'`);
  }
  return [...byToolName.values()].sort((left, right) =>
    mcpToolNameForBinding(sourcePluginName, left).localeCompare(
      mcpToolNameForBinding(sourcePluginName, right),
    ),
  );
};

const collectContextFiles = async (input: LowerInput): Promise<ContextFile[]> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsPi(input.registry, "rules")) return [];

  const files = await collectArtifactSourceFiles(pluginPath, "rules", TARGET_ID);
  const contexts: ContextFile[] = [];
  for (const file of files.filter((entry) => entry.relativePath.endsWith(".md"))) {
    contexts.push({
      label: file.relativePath,
      content: (await readFile(file.sourcePath)).trim(),
    });
  }
  return contexts.sort((left, right) => left.label.localeCompare(right.label));
};

const planAgentWrites = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
  for (const agent of input.agents) {
    const relativePath = `${agent.name}.md`;
    desiredRelativePaths.add(relativePath);
    await pushWriteOperation(
      operations,
      agentPath(input.target, agent.name),
      renderPiAgentMarkdown(agent, input.target),
      "write-md",
    );
  }
};

const relativePathInsideRoot = (root: string, targetPath: string): string | undefined => {
  const relativePath = relative(resolve(root), resolve(targetPath));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath.split(sep).join("/");
};

const planAgentPruning = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredRelativePaths: ReadonlySet<string>,
): Promise<void> => {
  const ledger = await readHarnessLedger(TARGET_ID);
  const currentRoot = agentsRoot(input.target);
  for (const entry of ledger.entries) {
    if (entry.pluginName !== input.target.sourcePluginName) continue;
    if (entry.scope !== input.target.scope) continue;
    if (resolve(entry.root) !== resolve(input.target.root)) continue;
    if (entry.artifact !== "compile" || entry.kind !== "file") continue;

    const relativePath = relativePathInsideRoot(currentRoot, entry.targetPath);
    if (!relativePath || desiredRelativePaths.has(relativePath)) continue;
    operations.push({
      kind: "prune-plugin-path",
      target: entry.targetPath,
      targetType: "file",
      reason: "stale",
    });
  }
};

const planTargetedSkillWrites = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
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
};

const planCommandPromptWrites = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredRelativePaths: Set<string>,
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsPi(input.registry, "commands")) return;

  const files = await collectArtifactSourceFiles(pluginPath, "commands", TARGET_ID);
  for (const file of files.filter((entry) => entry.relativePath.endsWith(".md"))) {
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      `prompts/${file.relativePath}`,
      await readFile(file.sourcePath),
      "write-md",
    );
  }
};

const piNativeHookEvent = (event: Hook["event"]): string =>
  nativeHookEventName(event, {
    toolBefore: "tool_call",
    toolAfter: "tool_result",
    sessionStart: "session_start",
    sessionEnd: "session_shutdown",
  });

const PI_HOOK_TOOL_INPUT_EXPRESSION =
  "input?.tool_input ?? input?.toolInput ?? input?.input ?? input?.args ?? input?.arguments ?? {}";

const PI_HOOK_TOOL_AFTER_OUTPUT_EXPRESSION =
  "input?.tool_output ?? input?.toolOutput ?? input?.output ?? input?.content ?? input?.details";

const renderPiHookResultHandling = (): string =>
  "process.stdout.write(JSON.stringify(result));";

const renderHookWrapperEntry = (
  hook: Hook,
  hookRuntimePath: string,
): string =>
  renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    harness: TARGET_ID,
    nativeEvent: piNativeHookEvent(hook.event),
    cwdExpression: "input?.cwd",
    fallbackSessionId: TARGET_ID,
    nativeToolInputExpression: PI_HOOK_TOOL_INPUT_EXPRESSION,
    toolAfterOutputExpression: PI_HOOK_TOOL_AFTER_OUTPUT_EXPRESSION,
    nativeSessionEndReasonExpression: "input?.reason",
    resultHandlingSource: renderPiHookResultHandling(),
  });

const bundleHookWrapper = async (hook: Hook): Promise<string> =>
  bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-pi-hook-",
    buildLabel: `Pi '${hook.name}'`,
    renderEntry: renderHookWrapperEntry,
  });

const planHookWrappers = async (
  input: LowerInput,
  operations: LowerOperation[],
  desiredRelativePaths: Set<string>,
): Promise<PlannedHook[]> => {
  const hooks = [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  const bindings = uniqueBindings(input.target.sourcePluginName, [
    ...bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools ?? []),
    ...input.agents.flatMap((agent) => agent.toolBindings),
  ]);
  const canonicalToolNames = collectBindingNameMap(
    bindings,
    (binding) => mcpToolNameForBinding(input.target.sourcePluginName, binding),
  );
  const planned: PlannedHook[] = [];

  for (const hook of hooks) {
    const relativePath = `hooks/${normalizeBundleSegment(hook.name, "hook")}.mjs`;
    let matcher: string | undefined;
    if (input.registry && (hook.event === "tool.before" || hook.event === "tool.after")) {
      const resolved = await Effect.runPromise(resolveHookMatchForTarget(hook, input.registry, TARGET_ID));
      matcher = matcherForResolvedToolHook(resolved, canonicalToolNames);
    }
    await pushWrite(
      operations,
      desiredRelativePaths,
      input.target,
      relativePath,
      await bundleHookWrapper(hook),
      "write-plugin-file",
      { mode: 0o755 },
    );
    planned.push({
      hook,
      nativeEvent: piNativeHookEvent(hook.event),
      matcher,
      relativePath: `../${relativePath}`,
    });
  }

  return planned;
};

const renderPiSetupImports = (plannedHooks: ReadonlyArray<PlannedHook>): string =>
  plannedHooks.length === 0
    ? ""
    : [
        `import { spawn } from "node:child_process";`,
        `import { dirname, join } from "node:path";`,
        `import { fileURLToPath } from "node:url";`,
      ].join("\n");

const renderContextSetup = (contexts: ReadonlyArray<ContextFile>): string => {
  if (contexts.length === 0) return "";
  const renderedContext = contexts
    .map((context) => `<!-- prism:context-source ${context.label} -->\n\n${context.content}`)
    .join("\n\n");
  return `
const prismContext = ${JSON.stringify(renderedContext)};
if (typeof pi.on === "function") {
  pi.on("before_agent_start", async (event: any) => ({
    systemPrompt: [event.systemPrompt, prismContext].filter(Boolean).join("\\n\\n"),
  }));
}`;
};

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

const prismMatches = (matcher: string | undefined, value: string): boolean => {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
};

const runPrismHook = async (hook: any, payload: unknown): Promise<any> =>
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(prismExtensionDir, hook.path)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "Prism Pi hook failed with exit " + code));
        return;
      }
      const trimmed = stdout.trim();
      resolve(trimmed.length > 0 ? JSON.parse(trimmed) : { decision: "continue" });
    });
    child.stdin.end(JSON.stringify(payload));
  });

const piSessionId = (ctx: any): string | undefined =>
  typeof ctx?.sessionManager?.getSessionFile === "function"
    ? ctx.sessionManager.getSessionFile()
    : undefined;

const piHookPayload = (nativeEvent: string, event: any, ctx: any): Record<string, unknown> => ({
  hook_event_name: nativeEvent,
  session_id: piSessionId(ctx),
  cwd: typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd(),
  tool_name: event?.toolName,
  tool_input: event?.input,
  tool_output: event?.content ?? event?.details,
  reason: event?.reason,
  native: event,
});

const hooksForEvent = (nativeEvent: string, toolName = "") =>
  prismHooks.filter((hook: any) =>
    hook.nativeEvent === nativeEvent && prismMatches(hook.matcher, toolName),
  );

if (typeof pi.on === "function") {
  pi.on("tool_call", async (event: any, ctx: any) => {
    for (const hook of hooksForEvent("tool_call", String(event?.toolName ?? ""))) {
      const result = await runPrismHook(hook, piHookPayload("tool_call", event, ctx));
      if (result?.decision === "block") {
        return { block: true, reason: result.message ?? "Blocked by Prism hook" };
      }
    }
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    for (const hook of hooksForEvent("tool_result", String(event?.toolName ?? ""))) {
      await runPrismHook(hook, piHookPayload("tool_result", event, ctx));
    }
  });

  pi.on("session_start", async (event: any, ctx: any) => {
    for (const hook of hooksForEvent("session_start")) {
      await runPrismHook(hook, piHookPayload("session_start", event, ctx));
    }
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    for (const hook of hooksForEvent("session_shutdown")) {
      await runPrismHook(hook, piHookPayload("session_shutdown", event, ctx));
    }
  });
}`;
};

const renderPiSetupSource = (options: {
  readonly contexts: ReadonlyArray<ContextFile>;
  readonly plannedHooks: ReadonlyArray<PlannedHook>;
}): string =>
  [renderContextSetup(options.contexts), renderHookSetup(options.plannedHooks)]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

const planExtension = async (options: {
  readonly input: LowerInput;
  readonly operations: LowerOperation[];
  readonly desiredRelativePaths: Set<string>;
  readonly contexts: ReadonlyArray<ContextFile>;
  readonly plannedHooks: ReadonlyArray<PlannedHook>;
}): Promise<void> => {
  const bindings = uniqueBindings(options.input.target.sourcePluginName, [
    ...bindingsFromCanonicalTools(options.input.target.sourcePluginName, options.input.tools ?? []),
    ...options.input.agents.flatMap((agent) => agent.toolBindings),
  ]);
  const setupSource = renderPiSetupSource({
    contexts: options.contexts,
    plannedHooks: options.plannedHooks,
  });
  if (bindings.length === 0 && setupSource.trim().length === 0) return;

  const bundle: PiExtensionBundle = await generatePiExtensionBundle({
    sourcePluginName: options.input.target.sourcePluginName,
    sourcePluginRoot: options.input.target.sourcePluginPath ?? options.input.registry?.pluginPath,
    dependencyPluginRoots: options.input.registry
      ? Object.entries(options.input.registry.dependencyPaths)
      : undefined,
    version: options.input.target.sourcePluginVersion,
    bindings,
    setupImports: renderPiSetupImports(options.plannedHooks),
    setupSource,
  });

  await pushWrite(
    options.operations,
    options.desiredRelativePaths,
    options.input.target,
    "extensions/prism-extension.js",
    bundle.content,
  );
};

const hasPackageOutput = (
  input: LowerInput,
  contexts: ReadonlyArray<ContextFile>,
): boolean =>
  input.agents.some((agent) => agent.toolBindings.length > 0) ||
  input.orbits.length > 0 ||
  (input.tools?.length ?? 0) > 0 ||
  (input.skills?.length ?? 0) > 0 ||
  (input.hooks?.length ?? 0) > 0 ||
  contexts.length > 0 ||
  artifactTargetsPi(input.registry, "commands");

const packageSettingsEntry = (target: PiLowerTarget): string =>
  `./packages/${generatedPackageId(target)}`;

const readSettingsJson = async (target: PiLowerTarget): Promise<Record<string, unknown>> => {
  if (!(await exists(settingsPath(target)))) return {};
  const raw = await readFile(settingsPath(target));
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    throw new Error(`Pi settings file is not valid JSON: ${settingsPath(target)}`, { cause: error });
  }
  throw new Error(`Pi settings file must contain a JSON object: ${settingsPath(target)}`);
};

const packageSource = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = (value as { readonly source?: unknown }).source;
    return typeof source === "string" ? source : undefined;
  }
  return undefined;
};

const renderSettingsJson = async (
  target: PiLowerTarget,
  shouldIncludePackage: boolean,
): Promise<string> => {
  const settings = await readSettingsJson(target);
  const currentPackages = settings.packages;
  if (currentPackages !== undefined && !Array.isArray(currentPackages)) {
    throw new Error(`Pi settings field 'packages' must be an array: ${settingsPath(target)}`);
  }

  const entry = packageSettingsEntry(target);
  const packages = (currentPackages ?? []).filter(
    (item: unknown) => packageSource(item) !== entry,
  );
  if (shouldIncludePackage) packages.push(entry);
  return json({ ...settings, packages });
};

const planSettingsPatch = async (
  target: PiLowerTarget,
  operations: LowerOperation[],
  shouldIncludePackage: boolean,
): Promise<void> => {
  if (!shouldIncludePackage && !(await exists(settingsPath(target)))) return;
  await pushConfigPatch(
    operations,
    settingsPath(target),
    await renderSettingsJson(target, shouldIncludePackage),
  );
};

const renderPackageManifest = (input: LowerInput, desired: ReadonlySet<string>): string => {
  const pi: Record<string, string[]> = {};
  if ([...desired].some((path) => path.startsWith("extensions/"))) {
    pi.extensions = ["./extensions"];
  }
  if ([...desired].some((path) => path.startsWith("skills/"))) {
    pi.skills = ["./skills"];
  }
  if ([...desired].some((path) => path.startsWith("prompts/"))) {
    pi.prompts = ["./prompts"];
  }

  return json({
    name: generatedPackageId(input.target),
    version: input.target.sourcePluginVersion ?? "0.1.0",
    type: "module",
    description: `Generated by prism from ${input.target.sourcePluginName}.`,
    keywords: ["pi-package"],
    pi,
  });
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const state = createGeneratedPluginPlanState();
  const resolveTarget = (relativePath: string): string => generatedPath(input.target, relativePath);
  const contexts = await collectContextFiles(input);
  const desiredAgentRelativePaths = new Set<string>();

  await planAgentWrites(input, state.operations, desiredAgentRelativePaths);

  if (!hasPackageOutput(input, contexts)) {
    await planSettingsPatch(input.target, state.operations, false);
    await planGeneratedPluginPruning({
      state,
      root: generatedPackageRoot(input.target),
      resolveTarget,
      owner: {
        harness: TARGET_ID,
        scope: input.target.scope,
        root: input.target.root,
        sourcePluginName: input.target.sourcePluginName,
      },
    });
    await planAgentPruning(input, state.operations, desiredAgentRelativePaths);
    return state.operations;
  }

  await planTargetedSkillWrites(input, state.operations, state.desiredRelativePaths);
  await planGeneratedPluginOrbitSkillWrites({
    input,
    state,
    pushWrite,
    renderOrbitSkill: (orbit) =>
      renderPiOrbitSkillMarkdown(orbit, input.target.sourcePluginName, input.registry),
  });
  await planCommandPromptWrites(input, state.operations, state.desiredRelativePaths);
  const plannedHooks = await planHookWrappers(input, state.operations, state.desiredRelativePaths);
  await planExtension({
    input,
    operations: state.operations,
    desiredRelativePaths: state.desiredRelativePaths,
    contexts,
    plannedHooks,
  });

  await pushWrite(
    state.operations,
    state.desiredRelativePaths,
    input.target,
    "package.json",
    renderPackageManifest(input, state.desiredRelativePaths),
  );
  await planSettingsPatch(input.target, state.operations, true);
  await planGeneratedPluginPruning({
    state,
    root: generatedPackageRoot(input.target),
    resolveTarget,
    owner: {
      harness: TARGET_ID,
      scope: input.target.scope,
      root: input.target.root,
      sourcePluginName: input.target.sourcePluginName,
    },
  });
  await planAgentPruning(input, state.operations, desiredAgentRelativePaths);

  return state.operations;
};

export const executeLowering = executeStandardLowering;
