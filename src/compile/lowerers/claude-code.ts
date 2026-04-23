/**
 * Claude Code lowerer.
 *
 * Produces per-agent markdown at <claude-root>/agents/<name>.md with
 * Claude-style frontmatter and lowers concrete lifecycle instances into
 * skills/<name>/SKILL.md. Claude Code has no per-agent JSON sidecar and no
 * generated plugin system for synthetic contract tools.
 */

import { dirname, join } from "node:path";
import {
  composeLifecyclePhaseReference,
  type ComposedAgent,
} from "../compose.js";
import type { Lifecycle } from "../sources.js";
import type { HarnessScope } from "../../types.js";
import {
  backupFile,
  exists,
  listDirRecursive,
  readFile,
  removeDir,
  removeFile,
  writeFile,
} from "../../fs.js";
import type { LowerOperation } from "./opencode.js";

export interface ClaudeCodeLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly sourcePluginName: string;
}

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly lifecycles: ReadonlyArray<Lifecycle>;
  readonly target: ClaudeCodeLowerTarget;
}

type ClaudeFrontmatter = {
  readonly name?: string;
  readonly description?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly "allowed-tools"?: readonly string[];
};

const CLAUDE_FRONTMATTER_ORDER = [
  "name",
  "description",
  "model",
  "temperature",
  "top_p",
  "allowed-tools",
] as const satisfies ReadonlyArray<keyof ClaudeFrontmatter>;

const agentMdPath = (target: ClaudeCodeLowerTarget, name: string): string =>
  join(target.root, "agents", `${name}.md`);

const lifecycleSkillMdPath = (
  target: ClaudeCodeLowerTarget,
  name: string,
): string => join(target.root, "skills", name, "SKILL.md");

const lifecycleSkillRelativePath = (name: string): string =>
  `skills/${name}/SKILL.md`;

const lifecycleSkillOwnerMarker = (sourcePluginName: string): string =>
  `<!-- agentpkg:lifecycle-skill owner=${JSON.stringify(sourcePluginName)} -->`;

const isOwnedLifecycleSkill = (
  content: string,
  sourcePluginName: string,
): boolean => content.includes(lifecycleSkillOwnerMarker(sourcePluginName));

const normalizeAllowedTools = (value: unknown): string[] | undefined => {
  if (!(value instanceof Array)) return undefined;

  const tools = value.filter((tool): tool is string => typeof tool === "string");
  return tools.length > 0 ? tools : undefined;
};

const serializeClaudeFrontmatter = (frontmatter: ClaudeFrontmatter): string => {
  const lines = ["---"];

  for (const key of CLAUDE_FRONTMATTER_ORDER) {
    const value = frontmatter[key];
    if (value === undefined) continue;

    if (key === "allowed-tools") {
      const allowedTools = value as readonly string[];
      if (allowedTools.length === 0) continue;
      lines.push("allowed-tools:");
      for (const tool of allowedTools) {
        lines.push(`  - ${JSON.stringify(tool)}`);
      }
      continue;
    }

    if (typeof value === "string") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }

    lines.push(`${key}: ${String(value)}`);
  }

  lines.push("---");
  return lines.join("\n");
};

const composeClaudeFrontmatter = (agent: ComposedAgent): ClaudeFrontmatter => {
  const frontmatter: {
    name?: string;
    description?: string;
    model?: string;
    temperature?: number;
    top_p?: number;
    "allowed-tools"?: string[];
  } = {
    description: agent.description,
  };

  if (agent.model) {
    if (typeof agent.model.model === "string") {
      frontmatter.model = agent.model.model;
    }
    if (typeof agent.model.temperature === "number") {
      frontmatter.temperature = agent.model.temperature;
    }
    if (typeof agent.model.top_p === "number") {
      frontmatter.top_p = agent.model.top_p;
    }
  }

  const override = agent.targetOverride["claude-code"] as
    | Record<string, unknown>
    | undefined;
  if (override) {
    if (typeof override.description === "string") {
      frontmatter.description = override.description;
    }
    if (typeof override.model === "string") {
      frontmatter.model = override.model;
    }
    if (typeof override.temperature === "number") {
      frontmatter.temperature = override.temperature;
    }
    if (typeof override.top_p === "number") {
      frontmatter.top_p = override.top_p;
    }
    const allowedTools = normalizeAllowedTools(override["allowed-tools"]);
    if (allowedTools) {
      frontmatter["allowed-tools"] = allowedTools;
    }
  }

  if (agent.allowedTools.length > 0) {
    frontmatter["allowed-tools"] = [
      ...(frontmatter["allowed-tools"] ?? []),
      ...agent.allowedTools,
    ].filter((tool, index, array) => array.indexOf(tool) === index);
  }

  if (!frontmatter.model) {
    frontmatter.model = "sonnet";
  }

  return frontmatter;
};

const renderClaudeAgentMarkdown = (agent: ComposedAgent): string => {
  const frontmatter = serializeClaudeFrontmatter(composeClaudeFrontmatter(agent));
  return `${frontmatter}\n\n${agent.body}\n`;
};

const renderClaudeSkillMarkdown = (
  lifecycle: Lifecycle,
  sourcePluginName: string,
): string => {
  const lines: string[] = [];
  lines.push(
    serializeClaudeFrontmatter({
      name: lifecycle.name,
      description: lifecycle.description,
    }),
  );
  lines.push("");
  lines.push(lifecycleSkillOwnerMarker(sourcePluginName));
  lines.push("");
  lines.push(`# ${lifecycle.name}`);
  lines.push("");
  lines.push(lifecycle.description);
  lines.push("");
  lines.push(
    "_Runtime-facing lowering of a concrete lifecycle instance. Parameterized lifecycle templates remain source-only until another lifecycle binds them._",
  );
  lines.push("");

  if (lifecycle.produces) {
    lines.push("## Produces");
    lines.push("");
    lines.push(lifecycle.produces);
    lines.push("");
  }

  lines.push("## Phases");
  lines.push("");
  let index = 1;
  for (const phase of lifecycle.phases) {
    const reference = composeLifecyclePhaseReference(phase);
    lines.push(`### ${index}. ${phase.name} — ${reference.label}`);
    lines.push("");
    for (const detail of reference.detailLines) {
      lines.push(detail);
    }
    if (phase.signal_in) lines.push(`- **Signal in**: ${phase.signal_in}`);
    if (phase.termination) {
      lines.push(`- **Termination**: ${phase.termination}`);
    }
    if (phase.skip_if) lines.push(`- **Skip if**: ${phase.skip_if}`);
    lines.push("");
    index++;
  }

  if (lifecycle.taste_checkpoints.length > 0) {
    lines.push("## Taste Checkpoints");
    lines.push("");
    for (const checkpoint of lifecycle.taste_checkpoints) {
      const parts: string[] = [];
      if (checkpoint.after) parts.push(`after: ${checkpoint.after}`);
      if (checkpoint.before) parts.push(`before: ${checkpoint.before}`);
      if (checkpoint.note) parts.push(`note: ${checkpoint.note}`);
      lines.push(`- ${parts.join(" — ")}`);
    }
    lines.push("");
  }

  if (lifecycle.evolution) {
    lines.push("## Evolution");
    lines.push("");
    lines.push(lifecycle.evolution.trim());
    lines.push("");
  }

  const body = lifecycle.body.trim();
  if (body.length > 0) {
    lines.push(body);
    lines.push("");
  }

  return lines.join("\n");
};

const planLifecycleSkillPruning = async (
  target: ClaudeCodeLowerTarget,
  desiredSkillFiles: ReadonlySet<string>,
): Promise<LowerOperation[]> => {
  const skillsRoot = join(target.root, "skills");
  const existingSkillFiles = (await listDirRecursive(skillsRoot))
    .filter((relativePath) => relativePath.endsWith("/SKILL.md"))
    .sort((a, b) => a.localeCompare(b));
  const operations: LowerOperation[] = [];

  for (const relativePath of existingSkillFiles) {
    const rootRelativePath = `skills/${relativePath}`;
    if (desiredSkillFiles.has(rootRelativePath)) continue;

    const absolutePath = join(skillsRoot, relativePath);
    const current = await readFile(absolutePath);
    if (!isOwnedLifecycleSkill(current, target.sourcePluginName)) continue;

    operations.push({
      kind: "prune-plugin-path",
      target: absolutePath,
      targetType: "file",
      reason: "stale",
    });

    const skillDir = dirname(absolutePath);
    const remainingFiles = await listDirRecursive(skillDir);
    if (remainingFiles.length === 1 && remainingFiles[0] === "SKILL.md") {
      operations.push({
        kind: "prune-plugin-path",
        target: skillDir,
        targetType: "dir",
        reason: "stale",
      });
    }
  }

  return operations;
};

export const planLowering = async (
  input: LowerInput,
): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const desiredLifecycleSkillFiles = new Set<string>();

  for (const agent of input.agents) {
    const target = agentMdPath(input.target, agent.name);
    const content = renderClaudeAgentMarkdown(agent);
    let reason: "new" | "changed" | "unchanged";

    if (await exists(target)) {
      const current = await readFile(target);
      reason = current === content ? "unchanged" : "changed";
    } else {
      reason = "new";
    }

    operations.push({
      kind: "write-md",
      target,
      content,
      reason,
    });
  }

  for (const lifecycle of input.lifecycles) {
    const target = lifecycleSkillMdPath(input.target, lifecycle.name);
    desiredLifecycleSkillFiles.add(lifecycleSkillRelativePath(lifecycle.name));
    const content = renderClaudeSkillMarkdown(
      lifecycle,
      input.target.sourcePluginName,
    );
    let reason: "new" | "changed" | "unchanged";

    if (await exists(target)) {
      const current = await readFile(target);
      reason = current === content ? "unchanged" : "changed";
    } else {
      reason = "new";
    }

    operations.push({
      kind: "write-md",
      target,
      content,
      reason,
    });
  }

  operations.push(
    ...(await planLifecycleSkillPruning(input.target, desiredLifecycleSkillFiles)),
  );

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

    if (operation.kind === "write-md") {
      if (options.backup) {
        const backup = await backupFile(operation.target);
        if (backup) backups.push(backup);
      }
      await writeFile(operation.target, operation.content);
      continue;
    }

    if (operation.kind === "prune-plugin-path") {
      if (operation.targetType === "dir") {
        await removeDir(operation.target);
      } else {
        await removeFile(operation.target);
      }
    }
  }

  return { backups };
};
