/** Amp Code lowerer. */

import { basename, dirname, join } from "node:path";
import { type ComposedAgent } from "../compose.js";
import {
  renderDerivedOrbitPhaseReferences,
  renderDerivedOrbitSkillBody,
} from "../derived-orbit-skill.js";
import {
  ampPluginToolNameForBinding,
  generateAmpPluginBundle,
} from "../mcp-bundle.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import {
  backupFile,
  exists,
  listDirRecursive,
  readFile,
  removeDir,
  removeFile,
  writeFile,
} from "../../fs.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { LowerOperation } from "./opencode.js";

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

type Reason = "new" | "changed" | "unchanged";

const normalizeBundleSegment = (value: string, fallback = "plugin"): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

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
  `<!-- prism:amp-orbit-skill owner=${JSON.stringify(sourcePluginName)} -->`;

const yamlScalar = (value: string | number | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const serializeFrontmatter = (values: Record<string, unknown>): string => {
  const lines = ["---"];
  for (const [key, value] of Object.entries(values)) {
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

const targetIncludesAmp = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsAmp = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesAmp(registry?.targets[artifact]);

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
): string => {
  const lines: string[] = [];
  lines.push(
    serializeFrontmatter({ name: orbit.name, description: orbit.description }),
    "",
    orbitSkillOwnerMarker(sourcePluginName),
    "",
  );
  if (registry) {
    lines.push(renderDerivedOrbitSkillBody(orbit, registry));
  } else {
    lines.push(`# ${orbit.name}`, "", orbit.description, "");
    if (orbit.body.trim().length > 0) lines.push(orbit.body.trim(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

const copyTargetedSkillArtifacts = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsAmp(input.registry, "skills")) return;

  const files = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of files) {
    const target = join(ampSkillsRoot(input.target), file.relativePath);
    const content = await readFile(file.sourcePath);
    await pushWrite(
      operations,
      target,
      content,
      file.relativePath.endsWith(".md") ? "write-md" : "write-plugin-file",
    );
  }
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
  const bindings = uniqueBindings(input.target.sourcePluginName, [
    ...bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools),
    ...input.agents.flatMap((agent) => agent.toolBindings),
  ]);
  const target = generatedPluginPath(input.target);
  if (bindings.length === 0) {
    if (await exists(target)) {
      operations.push({
        kind: "prune-plugin-path",
        target,
        targetType: "file",
        reason: "stale",
      });
    }
    return;
  }

  const bundle = await generateAmpPluginBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath ?? input.registry?.pluginPath,
    version: input.target.sourcePluginVersion,
    bindings,
  });
  await pushWrite(operations, target, bundle.content);
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const desiredGeneratedSkillFiles = new Set<string>();

  if ((input.hooks?.length ?? 0) > 0) {
    throw new Error(
      "Amp hook lowering is not implemented yet; Amp SDK supports lifecycle/tool events, but Prism currently lowers Amp tools and skills only.",
    );
  }

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

  await copyTargetedSkillArtifacts(input, operations);

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
  await planAmpPlugin(input, operations);
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
