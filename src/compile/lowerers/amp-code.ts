/** Amp Code lowerer. */

import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { type ComposedAgent } from "../compose.js";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { resolveHookMatchForTarget } from "../hooks.js";
import {
  ampPluginToolNameForBinding,
  generateAmpPluginBundle,
} from "../mcp-bundle.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import { effectBundleImportPath } from "../runtime-deps.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  bindingsFromCanonicalTools,
  collectBindingNameMap,
} from "../tool-bindings.js";
import {
  collectArtifactSourceFiles,
  getHarnessFrontmatter,
  parseMarkdownFile,
  resolveManifestTargets,
} from "../../manifest.js";
import {
  exists,
  listDirRecursive,
  readFile,
} from "../../fs.js";
import { computeContentHash } from "../../content-hash.js";
import { readHarnessLedger } from "../../managed-ledger.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { LowerOperation } from "./opencode.js";
import {
  executeStandardLowering,
  matcherForResolvedToolHook,
  planCompileOwnedTargetedSkillPruning,
  prismOwnerMarker,
  pushWriteOperation as pushWrite,
  renderGeneratedOrbitSkill,
  normalizeBundleSegment,
  serializeSimpleFrontmatter as serializeFrontmatter,
} from "./shared.js";

const TARGET_ID = "amp-code" as const;
const GENERATED_PLUGIN_PREFIX = "prism-generated";

export interface AmpCodeLowerTarget {
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
  readonly target: AmpCodeLowerTarget;
}

const generatedPluginId = (pluginName: string): string =>
  `${GENERATED_PLUGIN_PREFIX}-${normalizeBundleSegment(pluginName)}`;

const ampProjectRoot = (target: AmpCodeLowerTarget): string =>
  target.scope === "project" ? dirname(target.root) : target.root;

const ampPluginsRoot = (target: AmpCodeLowerTarget): string =>
  target.scope === "project"
    ? join(ampProjectRoot(target), ".amp", "plugins")
    : join(target.root, "plugins");

const ampSkillsRoot = (target: AmpCodeLowerTarget): string =>
  join(target.root, "skills");

const generatedPluginPath = (target: AmpCodeLowerTarget): string =>
  join(ampPluginsRoot(target), `${generatedPluginId(target.sourcePluginName)}.ts`);

const generatedAgentSkillName = (agentName: string): string =>
  `prism-agent-${agentName}`;

const generatedAgentSkillRelativePath = (agentName: string): string =>
  `${generatedAgentSkillName(agentName)}/SKILL.md`;

const generatedOrbitSkillRelativePath = (orbitName: string): string =>
  `${orbitName}/SKILL.md`;

const agentSkillOwnerMarker = (sourcePluginName: string): string =>
  `<!-- prism:amp-agent-skill owner=${JSON.stringify(sourcePluginName)} -->`;

const orbitSkillOwnerMarker = (sourcePluginName: string): string =>
  prismOwnerMarker("amp-orbit-skill", sourcePluginName);

const targetIncludesAmp = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsAmp = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesAmp(registry?.targets[artifact]);

const uniqueBindings = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyArray<ResolvedContractBinding> => {
  const byToolName = new Map<string, ResolvedContractBinding>();
  for (const binding of bindings) {
    const toolName = ampPluginToolNameForBinding(sourcePluginName, binding);
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
    if (!same) {
      throw new Error(`Amp tool name collision for '${toolName}'`);
    }
  }
  return [...byToolName.values()].sort((left, right) =>
    ampPluginToolNameForBinding(sourcePluginName, left).localeCompare(
      ampPluginToolNameForBinding(sourcePluginName, right),
    ),
  );
};

interface PlannedAmpHook {
  readonly hook: Hook;
  readonly importName: string;
  readonly nativeEvent: "tool.call" | "tool.result" | "session.start";
  readonly matcher?: string;
}

interface PlannedAmpCommand {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly description?: string;
  readonly prompt: string;
}

const collectAmpBindings = (input: LowerInput): ReadonlyArray<ResolvedContractBinding> =>
  uniqueBindings(input.target.sourcePluginName, [
    ...bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools),
    ...input.agents.flatMap((agent) => agent.toolBindings),
  ]);

const stringField = (record: Record<string, unknown>, field: string): string | undefined => {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const commandStem = (relativePath: string): string =>
  relativePath.replace(/\.md$/u, "");

const commandId = (sourcePluginName: string, relativePath: string): string =>
  `${generatedPluginId(sourcePluginName)}-${normalizeBundleSegment(commandStem(relativePath), "command")}`;

const titleFromCommandPath = (relativePath: string): string => {
  const stem = commandStem(relativePath).split("/").at(-1) ?? commandStem(relativePath);
  return stem
    .replace(/[-_]+/gu, " ")
    .replace(/\b[a-z]/gu, (letter) => letter.toUpperCase());
};

const collectAmpCommands = async (input: LowerInput): Promise<PlannedAmpCommand[]> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsAmp(input.registry, "commands")) return [];

  const commands: PlannedAmpCommand[] = [];
  const seenIds = new Set<string>();
  const files = await collectArtifactSourceFiles(pluginPath, "commands", TARGET_ID);
  for (const file of files.filter((entry) => entry.relativePath.endsWith(".md"))) {
    const parsed = await parseMarkdownFile(file.sourcePath);
    const frontmatter = getHarnessFrontmatter(parsed.frontmatter, TARGET_ID);
    const prompt = parsed.content.trim();
    if (prompt.length === 0) continue;
    const id = commandId(input.target.sourcePluginName, file.relativePath);
    if (seenIds.has(id)) throw new Error(`Amp command id collision for '${id}'`);
    seenIds.add(id);
    const description = stringField(frontmatter, "description");
    commands.push({
      id,
      title:
        stringField(frontmatter, "title") ??
        stringField(frontmatter, "name") ??
        titleFromCommandPath(file.relativePath),
      category: stringField(frontmatter, "category") ?? `Prism: ${input.target.sourcePluginName}`,
      ...(description ? { description } : {}),
      prompt,
    });
  }
  return commands.sort((left, right) => left.id.localeCompare(right.id));
};

const ampNativeHookEvent = (hook: Hook): PlannedAmpHook["nativeEvent"] => {
  switch (hook.event) {
    case "tool.before":
      return "tool.call";
    case "tool.after":
      return "tool.result";
    case "session.start":
      return "session.start";
    case "session.end":
      throw new Error(
        `Amp does not expose a native session.end plugin event; cannot lower Prism hook '${hook.name}'.`,
      );
  }
};

const planAmpHooks = async (
  input: LowerInput,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): Promise<PlannedAmpHook[]> => {
  const canonicalToolNames = collectBindingNameMap(
    bindings,
    (binding) => ampPluginToolNameForBinding(input.target.sourcePluginName, binding),
  );
  const planned: PlannedAmpHook[] = [];
  for (const [index, hook] of [...(input.hooks ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .entries()) {
    const nativeEvent = ampNativeHookEvent(hook);
    let matcher: string | undefined;
    if (hook.event === "tool.before" || hook.event === "tool.after") {
      if (!input.registry) throw new Error("Amp hook lowering requires a plugin registry");
      const resolved = await Effect.runPromise(resolveHookMatchForTarget(hook, input.registry, TARGET_ID));
      matcher = matcherForResolvedToolHook(resolved, canonicalToolNames);
    }
    planned.push({
      hook,
      nativeEvent,
      importName: `prismAmpHook${index}`,
      matcher,
    });
  }
  return planned;
};

const renderAmpHookImports = (hooks: ReadonlyArray<PlannedAmpHook>): string =>
  hooks.length === 0
    ? ""
    : [
        `import { Effect } from ${JSON.stringify(effectBundleImportPath())};`,
        ...hooks.map((hook) =>
          `import ${hook.importName} from ${JSON.stringify(hook.hook.sourcePath.replace(/\\/g, "/"))};`
        ),
      ].join("\n");

const hookEntry = (hook: PlannedAmpHook): string =>
  `{ name: ${JSON.stringify(hook.hook.name)}, event: ${JSON.stringify(hook.hook.event)}, matcher: ${JSON.stringify(hook.matcher)}, handle: ${hook.importName}.handle }`;

const AMP_HOOK_SETUP_RUNTIME = `
const prismAmpToPromise = (value: any): Promise<any> =>
  Effect.isEffect(value) ? Effect.runPromise(value) : Promise.resolve(value);

const prismAmpValidateHookResult = (event: string, result: any): any => {
  const value = result ?? { decision: "continue" };
  if (event === "tool.before") {
    if (value?.decision === "continue") return { decision: "continue" };
    if (value?.decision === "block" && typeof value.message === "string") return value;
    throw new Error("Invalid Prism Amp hook result for " + event);
  }
  if (value?.decision === "continue") return { decision: "continue" };
  throw new Error("Invalid Prism Amp hook result for " + event);
};

const prismAmpRunHook = async (entry: any, payload: any): Promise<any> =>
  prismAmpValidateHookResult(entry.event, await prismAmpToPromise(entry.handle(payload)));

const prismAmpMatchesTool = (matcher: string | undefined, toolName: string): boolean => {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
};

const prismAmpSession = (event: any, ctx: any): { id?: string } | undefined => {
  const id = event?.thread?.id ?? ctx?.thread?.id;
  return id === undefined ? undefined : { id: String(id) };
};

const prismAmpRequiredSession = (event: any, ctx: any): { id?: string } =>
  prismAmpSession(event, ctx) ?? { id: "amp-code" };`.trim();

const renderAmpHookArray = (
  variableName: string,
  hooks: ReadonlyArray<PlannedAmpHook>,
): string => `const ${variableName} = [
${hooks.map((hook) => `  ${hookEntry(hook)},`).join("\n")}
];`;

const AMP_TOOL_BEFORE_HANDLER = `
if (prismAmpToolBeforeHooks.length > 0) {
  amp.on?.("tool.call", async (event: any, ctx: any) => {
    const toolName = String(event?.tool ?? "");
    for (const entry of prismAmpToolBeforeHooks) {
      if (!prismAmpMatchesTool(entry.matcher, toolName)) continue;
      const result = await prismAmpRunHook(entry, {
        event: "tool.before",
        target: { harness: "amp-code", nativeEvent: "tool.call" },
        tool: { nativeName: toolName, input: event?.input ?? {} },
        cwd: process.cwd(),
        session: prismAmpSession(event, ctx),
        native: event ?? {},
      });
      if (result.decision === "block") {
        return { action: "reject-and-continue", message: result.message };
      }
    }
    return { action: "allow" };
  });
}`.trim();

const AMP_TOOL_AFTER_HANDLER = `
if (prismAmpToolAfterHooks.length > 0) {
  amp.on?.("tool.result", async (event: any, ctx: any) => {
    const toolName = String(event?.tool ?? "");
    for (const entry of prismAmpToolAfterHooks) {
      if (!prismAmpMatchesTool(entry.matcher, toolName)) continue;
      await prismAmpRunHook(entry, {
        event: "tool.after",
        target: { harness: "amp-code", nativeEvent: "tool.result" },
        tool: {
          nativeName: toolName,
          input: event?.input ?? {},
          output: event?.output ?? event?.error,
          success: event?.status === "done",
        },
        cwd: process.cwd(),
        session: prismAmpSession(event, ctx),
        native: event ?? {},
      });
    }
  });
}`.trim();

const AMP_SESSION_START_HANDLER = `
if (prismAmpSessionStartHooks.length > 0) {
  amp.on?.("session.start", async (event: any, ctx: any) => {
    for (const entry of prismAmpSessionStartHooks) {
      await prismAmpRunHook(entry, {
        event: "session.start",
        target: { harness: "amp-code", nativeEvent: "session.start" },
        cwd: process.cwd(),
        session: prismAmpRequiredSession(event, ctx),
        native: event ?? {},
      });
    }
  });
}`.trim();

const renderAmpHookSetup = (hooks: ReadonlyArray<PlannedAmpHook>): string => {
  if (hooks.length === 0) return "";
  return [
    AMP_HOOK_SETUP_RUNTIME,
    renderAmpHookArray("prismAmpToolBeforeHooks", hooks.filter((hook) => hook.hook.event === "tool.before")),
    renderAmpHookArray("prismAmpToolAfterHooks", hooks.filter((hook) => hook.hook.event === "tool.after")),
    renderAmpHookArray("prismAmpSessionStartHooks", hooks.filter((hook) => hook.hook.event === "session.start")),
    AMP_TOOL_BEFORE_HANDLER,
    AMP_TOOL_AFTER_HANDLER,
    AMP_SESSION_START_HANDLER,
  ].join("\n\n");
};

const renderAmpCommandSetup = (commands: ReadonlyArray<PlannedAmpCommand>): string => {
  if (commands.length === 0) return "";
  return `
const prismAmpCommands = ${JSON.stringify(commands, null, 2)};

if (typeof amp.registerCommand !== "function") {
  throw new Error("Prism Amp command lowering requires amp.registerCommand");
}

for (const command of prismAmpCommands) {
  amp.registerCommand(
    command.id,
    {
      title: command.title,
      category: command.category,
      ...(command.description ? { description: command.description } : {}),
    },
    async (ctx: any) => {
      if (typeof ctx?.thread?.append !== "function") {
        throw new Error("Prism Amp command requires an active Amp thread");
      }
      await ctx.thread.append([
        { type: "user-message", content: command.prompt },
      ]);
    },
  );
}`.trim();
};

const joinAmpSetupSections = (
  commands: ReadonlyArray<PlannedAmpCommand>,
  hooks: ReadonlyArray<PlannedAmpHook>,
): string =>
  [renderAmpCommandSetup(commands), renderAmpHookSetup(hooks)]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

const renderAmpAgentSkillMarkdown = (
  agent: ComposedAgent,
  target: AmpCodeLowerTarget,
): string => {
  const name = generatedAgentSkillName(agent.name);
  const toolNames = agent.toolBindings.map((binding) =>
    ampPluginToolNameForBinding(target.sourcePluginName, binding),
  );
  const skillNames = [...new Set([...agent.skills, ...agent.allowedSkills])]
    .sort((left, right) => left.localeCompare(right));
  const lines: string[] = [];
  lines.push(
    serializeFrontmatter({
      name,
      description: `Use when you need the compiled Prism agent role '${agent.name}': ${agent.description}`,
    }),
    "",
    agentSkillOwnerMarker(target.sourcePluginName),
    "",
    `# ${agent.name}`,
    "",
    "Amp does not expose a native custom-agent surface through the plugin SDK, so Prism lowers this compiled agent into a role skill. Treat this as role guidance, not an isolated subagent sandbox.",
    "",
    agent.body,
  );

  if (toolNames.length > 0) {
    lines.push(
      "",
      "## Generated Amp Tools",
      "",
      "These tools are registered by the generated Prism Amp plugin and are available globally in this Amp workspace:",
      "",
    );
    for (const toolName of [...new Set(toolNames)].sort((left, right) => left.localeCompare(right))) {
      lines.push(`- \`${toolName}\``);
    }
  }

  if (skillNames.length > 0) {
    lines.push(
      "",
      "## Role Skills",
      "",
      "When acting in this role, load these skills when the work calls for them:",
      "",
    );
    for (const skillName of skillNames) {
      lines.push(`- \`${skillName}\``);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
};

const renderAmpOrbitSkillMarkdown = (
  orbit: Orbit,
  sourcePluginName: string,
  registry: PluginRegistry | undefined,
): string =>
  renderGeneratedOrbitSkill({
    orbit,
    sourcePluginName,
    registry,
    ownerKind: "amp-orbit-skill",
    trailingNewline: true,
  });

const copyTargetedSkillArtifacts = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<ReadonlySet<string>> => {
  const desired = new Set<string>();
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsAmp(input.registry, "skills")) return desired;

  const files = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of files) {
    const target = join(ampSkillsRoot(input.target), file.relativePath);
    const content = await readFile(file.sourcePath);
    desired.add(file.relativePath);
    await pushWrite(
      operations,
      target,
      content,
      file.relativePath.endsWith(".md") ? "write-md" : "write-plugin-file",
    );
  }
  return desired;
};

const planGeneratedSkillPruning = async (
  target: AmpCodeLowerTarget,
  desiredRelativeSkillFiles: ReadonlySet<string>,
): Promise<LowerOperation[]> => {
  const root = ampSkillsRoot(target);
  if (!(await exists(root))) return [];

  const operations: LowerOperation[] = [];
  const ownerMarkers = [
    agentSkillOwnerMarker(target.sourcePluginName),
    orbitSkillOwnerMarker(target.sourcePluginName),
  ];
  for (const relativeFile of await listDirRecursive(root)) {
    if (!relativeFile.endsWith("SKILL.md")) continue;
    if (desiredRelativeSkillFiles.has(relativeFile)) continue;

    const absoluteFile = join(root, relativeFile);
    const content = await readFile(absoluteFile);
    if (!ownerMarkers.some((marker) => content.includes(marker))) continue;
    operations.push({
      kind: "prune-plugin-path",
      target: dirname(absoluteFile),
      targetType: "dir",
      reason: "stale",
    });
  }
  return operations;
};

const planAmpPlugin = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<void> => {
  const bindings = collectAmpBindings(input);
  const hooks = await planAmpHooks(input, bindings);
  const commands = await collectAmpCommands(input);
  const target = generatedPluginPath(input.target);
  if (bindings.length === 0 && hooks.length === 0 && commands.length === 0) {
    await planGeneratedPluginFilePrune(input, operations, target);
    return;
  }

  const bundle = await generateAmpPluginBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath ?? input.registry?.pluginPath,
    dependencyPluginRoots: input.registry ? Object.entries(input.registry.dependencyPaths) : undefined,
    version: input.target.sourcePluginVersion,
    bindings,
    setupImports: renderAmpHookImports(hooks),
    setupSource: joinAmpSetupSections(commands, hooks),
  });
  await pushWrite(operations, target, bundle.content);
};

const planGeneratedPluginFilePrune = async (
  input: LowerInput,
  operations: LowerOperation[],
  target: string,
): Promise<void> => {
  const ledger = await readHarnessLedger(TARGET_ID);
  const entry = ledger.entries.find((candidate) =>
    candidate.pluginName === input.target.sourcePluginName &&
    candidate.scope === input.target.scope &&
    resolve(candidate.root) === resolve(input.target.root) &&
    candidate.artifact === "compile" &&
    candidate.kind === "file" &&
    resolve(candidate.targetPath) === resolve(target)
  );
  if (!entry) return;

  if (await exists(target)) {
    const currentHash = computeContentHash(await readFile(target));
    if (currentHash !== entry.contentHash) {
      throw new Error(
        `Refusing to prune drifted Amp generated plugin '${target}'; target changed outside Prism.`,
      );
    }
  }

  operations.push({
    kind: "prune-plugin-path",
    target,
    targetType: "file",
    reason: "stale",
  });
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const desiredGeneratedSkillFiles = new Set<string>();

  for (const agent of input.agents) {
    const relativeSkill = generatedAgentSkillRelativePath(agent.name);
    desiredGeneratedSkillFiles.add(relativeSkill);
    await pushWrite(
      operations,
      join(ampSkillsRoot(input.target), relativeSkill),
      renderAmpAgentSkillMarkdown(agent, input.target),
      "write-md",
    );
  }

  const desiredTargetedSkillFiles = await copyTargetedSkillArtifacts(input, operations);

  for (const orbit of input.orbits) {
    const relativeSkill = generatedOrbitSkillRelativePath(orbit.name);
    desiredGeneratedSkillFiles.add(relativeSkill);
    await pushWrite(
      operations,
      join(ampSkillsRoot(input.target), relativeSkill),
      renderAmpOrbitSkillMarkdown(orbit, input.target.sourcePluginName, input.registry),
      "write-md",
    );

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      const relativeReference = `${orbit.name}/references/${reference.filename}`;
      desiredGeneratedSkillFiles.add(relativeReference);
      await pushWrite(
        operations,
        join(ampSkillsRoot(input.target), relativeReference),
        reference.content,
        "write-md",
      );
    }
  }

  operations.push(...await planGeneratedSkillPruning(input.target, desiredGeneratedSkillFiles));
  operations.push(...await planCompileOwnedTargetedSkillPruning({
    target: { ...input.target, harness: TARGET_ID },
    skillsRoot: ampSkillsRoot(input.target),
    desiredRelativePaths: desiredTargetedSkillFiles,
  }));
  await planAmpPlugin(input, operations);
  return operations;
};

export const executeLowering = executeStandardLowering;
