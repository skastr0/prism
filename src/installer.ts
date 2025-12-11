/**
 * Core installation logic for plugin distribution
 */

import { basename, join } from "node:path";
import { getAgent } from "./agents.js";
import {
  appendFile,
  backupFile,
  copyFile,
  exists,
  expandPath,
  listDirRecursive,
  readFile,
  writeFile,
} from "./fs.js";
import {
  frontmatterTargetsAgent,
  getAgentFrontmatter,
  manifestTargetsAgent,
  parseMarkdownFile,
  readManifest,
  reconstructMarkdown,
  validateSkill,
} from "./manifest.js";
import type {
  AgentConfig,
  AgentId,
  FileOperation,
  InstallOptions,
  InstallResult,
} from "./types.js";

/**
 * Plan installation operations without executing them
 */
export async function planInstallation(
  options: InstallOptions
): Promise<FileOperation[]> {
  const pluginPath = expandPath(options.pluginPath);
  const manifest = await readManifest(pluginPath);
  const operations: FileOperation[] = [];

  for (const agentId of options.agents) {
    if (!manifestTargetsAgent(manifest, agentId)) {
      continue;
    }

    const agent = getAgent(agentId);

    // Plan rules installation
    const rulesOps = await planRulesInstallation(
      pluginPath,
      agent,
      options.projectPath
    );
    operations.push(...rulesOps);

    // Plan commands installation
    if (agent.supportsCommands && agent.commandsDir) {
      const commandOps = await planCommandsInstallation(pluginPath, agent);
      operations.push(...commandOps);
    }

    // Plan agents installation
    if (agent.supportsAgents && agent.agentsDir) {
      const agentOps = await planAgentsInstallation(pluginPath, agent);
      operations.push(...agentOps);
    }

    // Plan skills installation
    if (agent.supportsSkills && agent.skillsDir) {
      const skillOps = await planSkillsInstallation(pluginPath, agent);
      operations.push(...skillOps);
    }
  }

  return operations;
}

/**
 * Check if an append operation would result in duplicate content
 * Returns: "new" if section doesn't exist, "identical" if any existing section matches, "changed" if sections exist but none match
 * Note: Handles multiple sections with the same marker (checks all of them)
 */
async function checkAppendStatus(
  sourcePath: string,
  targetPath: string,
  agentId: AgentId
): Promise<"new" | "identical" | "changed"> {
  if (!(await exists(targetPath))) {
    return "new";
  }

  const { frontmatter, content } = await parseMarkdownFile(sourcePath);
  const agentFrontmatter = getAgentFrontmatter(frontmatter, agentId);
  const finalContent = reconstructMarkdown(agentFrontmatter, content);
  const newContentTrimmed = finalContent.trim();

  const sourceName = basename(sourcePath, ".md");
  const beginMarker = `<!-- BEGIN: ${sourceName} -->`;
  const endMarker = `<!-- END: ${sourceName} -->`;

  const existingContent = await readFile(targetPath);

  if (!existingContent.includes(beginMarker)) {
    return "new";
  }

  // Find all sections with this marker and check if any match
  let searchStart = 0;
  let foundAnySection = false;

  while (true) {
    const beginIndex = existingContent.indexOf(beginMarker, searchStart);
    if (beginIndex === -1) break;

    const endIndex = existingContent.indexOf(endMarker, beginIndex);
    if (endIndex === -1) break;

    foundAnySection = true;

    const existingSection = existingContent.slice(
      beginIndex + beginMarker.length,
      endIndex
    );

    if (existingSection.trim() === newContentTrimmed) {
      return "identical";
    }

    // Move past this section for next iteration
    searchStart = endIndex + endMarker.length;
  }

  return foundAnySection ? "changed" : "new";
}

/**
 * Plan rules file installation
 */
async function planRulesInstallation(
  pluginPath: string,
  agent: AgentConfig,
  projectPath?: string
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];
  const globalRulesDir = join(pluginPath, "rules", "global");
  const projectRulesDir = join(pluginPath, "rules", "project");

  // Global rules - append to agent's global rules file
  if (await exists(globalRulesDir)) {
    const files = await listDirRecursive(globalRulesDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    for (const file of mdFiles) {
      const sourcePath = join(globalRulesDir, file);
      const targetPath = join(
        expandPath(agent.globalConfigPath),
        agent.rulesFile
      );

      // Check if file targets this agent
      const { frontmatter } = await parseMarkdownFile(sourcePath);
      if (!frontmatterTargetsAgent(frontmatter, agent.id)) {
        operations.push({
          type: "skip",
          source: sourcePath,
          target: targetPath,
          agent: agent.id,
          artifact: "rules",
          reason: `File does not target ${agent.name}`,
        });
        continue;
      }

      // Check if content already exists in target
      const appendStatus = await checkAppendStatus(sourcePath, targetPath, agent.id);
      if (appendStatus === "identical") {
        operations.push({
          type: "skip",
          source: sourcePath,
          target: targetPath,
          agent: agent.id,
          artifact: "rules",
          reason: "Content already exists and is identical",
        });
        continue;
      }

      operations.push({
        type: "append",
        source: sourcePath,
        target: targetPath,
        agent: agent.id,
        artifact: "rules",
        reason: appendStatus === "changed" ? "Updating existing section" : undefined,
      });
    }
  }

  // Project rules - copy to project directory (if projectPath provided)
  if (projectPath && (await exists(projectRulesDir))) {
    const expandedProjectPath = expandPath(projectPath);
    const files = await listDirRecursive(projectRulesDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    for (const file of mdFiles) {
      const sourcePath = join(projectRulesDir, file);

      // Determine target based on agent configuration
      let targetPath: string;
      if (agent.rulesDir && agent.projectConfigPath) {
        // Agents with rules directories (like Cursor)
        targetPath = join(
          expandedProjectPath,
          agent.projectConfigPath,
          agent.rulesDir,
          file.replace(".md", agent.configFormat === "mdc" ? ".mdc" : ".md")
        );
      } else if (agent.projectConfigPath) {
        // Agents with project config path
        targetPath = join(expandedProjectPath, agent.rulesFile);
      } else {
        // Agents without project config - use global
        targetPath = join(expandPath(agent.globalConfigPath), agent.rulesFile);
      }

      // Check if file targets this agent
      const { frontmatter } = await parseMarkdownFile(sourcePath);
      if (!frontmatterTargetsAgent(frontmatter, agent.id)) {
        operations.push({
          type: "skip",
          source: sourcePath,
          target: targetPath,
          agent: agent.id,
          artifact: "rules",
          reason: `File does not target ${agent.name}`,
        });
        continue;
      }

      // For single-file agents, append; for directory-based, copy
      if (agent.rulesDir) {
        operations.push({
          type: "copy",
          source: sourcePath,
          target: targetPath,
          agent: agent.id,
          artifact: "rules",
        });
      } else {
        // Check if content already exists in target
        const appendStatus = await checkAppendStatus(sourcePath, targetPath, agent.id);
        if (appendStatus === "identical") {
          operations.push({
            type: "skip",
            source: sourcePath,
            target: targetPath,
            agent: agent.id,
            artifact: "rules",
            reason: "Content already exists and is identical",
          });
          continue;
        }

        operations.push({
          type: "append",
          source: sourcePath,
          target: targetPath,
          agent: agent.id,
          artifact: "rules",
          reason: appendStatus === "changed" ? "Updating existing section" : undefined,
        });
      }
    }
  }

  return operations;
}

/**
 * Plan commands installation
 */
async function planCommandsInstallation(
  pluginPath: string,
  agent: AgentConfig
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];
  const commandsDir = join(pluginPath, "commands");

  if (!(await exists(commandsDir))) {
    return operations;
  }

  const files = await listDirRecursive(commandsDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));

  for (const file of mdFiles) {
    const sourcePath = join(commandsDir, file);
    const targetDir = join(
      expandPath(agent.globalConfigPath),
      agent.commandsDir!
    );

    // Determine target extension based on agent
    let targetFile = file;
    if (agent.id === "gemini-cli") {
      // Gemini uses TOML for commands
      targetFile = file.replace(".md", ".toml");
    }

    const targetPath = join(targetDir, targetFile);

    // Check if command targets this agent
    const { frontmatter } = await parseMarkdownFile(sourcePath);
    if (!frontmatterTargetsAgent(frontmatter, agent.id)) {
      operations.push({
        type: "skip",
        source: sourcePath,
        target: targetPath,
        agent: agent.id,
        artifact: "command",
        reason: `Command does not target ${agent.name}`,
      });
      continue;
    }

    operations.push({
      type: "copy",
      source: sourcePath,
      target: targetPath,
      agent: agent.id,
      artifact: "command",
    });
  }

  return operations;
}

/**
 * Plan agents installation
 */
async function planAgentsInstallation(
  pluginPath: string,
  agent: AgentConfig
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];
  const agentsDir = join(pluginPath, "agents");

  if (!(await exists(agentsDir))) {
    return operations;
  }

  const files = await listDirRecursive(agentsDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));

  for (const file of mdFiles) {
    const sourcePath = join(agentsDir, file);
    const targetDir = join(
      expandPath(agent.globalConfigPath),
      agent.agentsDir!
    );
    const targetPath = join(targetDir, file);

    // Check if agent definition targets this agent
    const { frontmatter } = await parseMarkdownFile(sourcePath);
    if (!frontmatterTargetsAgent(frontmatter, agent.id)) {
      operations.push({
        type: "skip",
        source: sourcePath,
        target: targetPath,
        agent: agent.id,
        artifact: "agent",
        reason: `Agent definition does not target ${agent.name}`,
      });
      continue;
    }

    operations.push({
      type: "copy",
      source: sourcePath,
      target: targetPath,
      agent: agent.id,
      artifact: "agent",
    });
  }

  return operations;
}

/**
 * Plan skills installation (Claude Code native, OpenCode via opencode-skills plugin)
 * Includes validation of skill structure and frontmatter
 */
async function planSkillsInstallation(
  pluginPath: string,
  agent: AgentConfig
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];
  const skillsDir = join(pluginPath, "skills");

  if (!(await exists(skillsDir))) {
    return operations;
  }

  // Get skill directories first to validate each skill
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // Track validated skills to skip invalid ones entirely
  const validatedSkills = new Map<string, boolean>();

  // Validate each skill directory
  for (const skillDirName of skillDirs) {
    const skillPath = join(skillsDir, skillDirName);
    const validation = await validateSkill(skillPath, skillDirName);

    if (!validation.valid) {
      // Add skip operation with validation errors
      const targetDir = join(
        expandPath(agent.globalConfigPath),
        agent.skillsDir!
      );
      operations.push({
        type: "skip",
        source: skillPath,
        target: join(targetDir, skillDirName),
        agent: agent.id,
        artifact: "skill",
        reason: `Validation failed: ${validation.errors.join("; ")}`,
      });
      validatedSkills.set(skillDirName, false);
      continue;
    }

    validatedSkills.set(skillDirName, true);
  }

  // Skills are directories containing a SKILL.md and supporting files
  const files = await listDirRecursive(skillsDir);

  for (const file of files) {
    const sourcePath = join(skillsDir, file);
    const targetDir = join(
      expandPath(agent.globalConfigPath),
      agent.skillsDir!
    );
    const targetPath = join(targetDir, file);

    // Get the skill directory name from the file path
    const skillDirName = file.split("/")[0];

    // Skip files from invalid skills
    if (skillDirName && validatedSkills.get(skillDirName) === false) {
      continue; // Already added skip operation for the skill
    }

    // For SKILL.md files, check if they target this agent
    if (file.endsWith("SKILL.md")) {
      const { frontmatter } = await parseMarkdownFile(sourcePath);
      if (!frontmatterTargetsAgent(frontmatter, agent.id)) {
        // Skip the entire skill directory
        operations.push({
          type: "skip",
          source: sourcePath,
          target: targetPath,
          agent: agent.id,
          artifact: "skill",
          reason: `Skill does not target ${agent.name}`,
        });
        continue;
      }
    }

    operations.push({
      type: "copy",
      source: sourcePath,
      target: targetPath,
      agent: agent.id,
      artifact: "skill",
    });
  }

  return operations;
}

/**
 * Execute installation plan
 */
export async function executeInstallation(
  operations: FileOperation[],
  options: Pick<InstallOptions, "overwrite" | "backup" | "dryRun">
): Promise<InstallResult> {
  const result: InstallResult = {
    success: true,
    operations: [],
    errors: [],
    backups: [],
  };

  if (options.dryRun) {
    result.operations = operations;
    return result;
  }

  for (const op of operations) {
    try {
      if (op.type === "skip") {
        result.operations.push(op);
        continue;
      }

      // Check if target exists
      const targetExists = await exists(op.target);

      if (targetExists && !options.overwrite && op.type !== "append") {
        result.operations.push({
          ...op,
          type: "skip",
          reason: "Target exists and overwrite is disabled",
        });
        continue;
      }

      // Backup if needed
      if (targetExists && options.backup) {
        const backupPath = await backupFile(op.target);
        if (backupPath) {
          result.backups.push(backupPath);
        }
      }

      // Execute operation
      switch (op.type) {
        case "copy":
          await executeCopyOperation(op);
          break;
        case "append":
          await executeAppendOperation(op);
          break;
        case "merge":
          await executeMergeOperation(op);
          break;
      }

      result.operations.push(op);
    } catch (error) {
      result.success = false;
      result.errors.push({
        operation: op,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Execute a copy operation with content transformation
 */
async function executeCopyOperation(op: FileOperation): Promise<void> {
  const agent = getAgent(op.agent);

  if (op.source.endsWith(".md")) {
    // Transform markdown with frontmatter
    const { frontmatter, content } = await parseMarkdownFile(op.source);
    const agentFrontmatter = getAgentFrontmatter(frontmatter, op.agent);

    // Handle special transformations per agent
    let finalContent: string;

    if (agent.id === "gemini-cli" && op.artifact === "command") {
      // Convert to TOML format for Gemini
      finalContent = convertCommandToToml(agentFrontmatter, content);
    } else if (agent.id === "cursor" && op.artifact === "rules") {
      // Convert to MDC format for Cursor
      finalContent = convertToMdc(agentFrontmatter, content);
    } else {
      finalContent = reconstructMarkdown(agentFrontmatter, content);
    }

    await writeFile(op.target, finalContent);
  } else {
    // Binary copy
    await copyFile(op.source, op.target);
  }
}

/**
 * Execute an append operation
 * Appends content with BEGIN/END markers, or updates existing section if markers exist
 */
async function executeAppendOperation(op: FileOperation): Promise<void> {
  const { frontmatter, content } = await parseMarkdownFile(op.source);
  const agentFrontmatter = getAgentFrontmatter(frontmatter, op.agent);

  const sourceName = basename(op.source, ".md");
  const beginMarker = `<!-- BEGIN: ${sourceName} -->`;
  const endMarker = `<!-- END: ${sourceName} -->`;

  const finalContent = reconstructMarkdown(agentFrontmatter, content);

  // Check if we need to update an existing section
  if (await exists(op.target)) {
    const existingContent = await readFile(op.target);

    if (existingContent.includes(beginMarker)) {
      const beginIndex = existingContent.indexOf(beginMarker);
      const endIndex = existingContent.indexOf(endMarker);

      if (endIndex > beginIndex) {
        // Replace existing section
        const before = existingContent.slice(0, beginIndex);
        const after = existingContent.slice(endIndex + endMarker.length);
        const newSection = `${beginMarker}\n${finalContent}\n${endMarker}`;
        await writeFile(op.target, before + newSection + after);
        return;
      }
    }
  }

  // Append new section
  const header = `\n\n${beginMarker}\n`;
  const footer = `\n${endMarker}\n`;
  await appendFile(op.target, header + finalContent + footer);
}

/**
 * Execute a merge operation (for JSON/TOML configs)
 */
async function executeMergeOperation(op: FileOperation): Promise<void> {
  // For now, just copy - merge logic can be added later
  await copyFile(op.source, op.target);
}

/**
 * Convert command markdown to TOML format (for Gemini CLI)
 */
function convertCommandToToml(
  frontmatter: Record<string, unknown>,
  content: string
): string {
  const lines: string[] = [];

  if (frontmatter.description) {
    lines.push(`description = "${frontmatter.description}"`);
  }

  // The content becomes the prompt
  lines.push("");
  lines.push(`prompt = """${content}"""`);

  return lines.join("\n");
}

/**
 * Convert rules markdown to MDC format (for Cursor)
 */
function convertToMdc(
  frontmatter: Record<string, unknown>,
  content: string
): string {
  const mdcFrontmatter: Record<string, unknown> = {};

  // Map common frontmatter to Cursor MDC format
  if (frontmatter.description) {
    mdcFrontmatter.description = frontmatter.description;
  }
  if (frontmatter.globs) {
    mdcFrontmatter.globs = frontmatter.globs;
  }
  if (frontmatter.alwaysApply !== undefined) {
    mdcFrontmatter.alwaysApply = frontmatter.alwaysApply;
  }

  return reconstructMarkdown(mdcFrontmatter, content);
}

/**
 * Main installation function
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  const operations = await planInstallation(options);
  return executeInstallation(operations, options);
}
