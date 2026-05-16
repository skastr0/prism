/**
 * Core installation logic for plugin distribution
 */

import { basename, join } from "node:path";
import { getHarness } from "./harnesses.js";
import {
  appendFile,
  backupFile,
  copyFile,
  exists,
  expandPath,
  readFile,
  writeFile,
  ensureDir,
} from "./fs.js";
import {
  type ArtifactSourceFile,
  collectArtifactSourceFiles,
  getHarnessFrontmatter,
  manifestTargetsArtifact,
  parseMarkdownFile,
  readManifest,
  reconstructMarkdown,
  validateSkill,
} from "./manifest.js";
import type {
  HarnessConfig,
  HarnessId,
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

  for (const harnessId of options.harnesses) {
    const harness = getHarness(harnessId);

    // Plan rules installation when the harness has a managed rules surface
    if (harness.rulesFile && manifestTargetsArtifact(manifest, "rules", harnessId)) {
      const rulesOps = await planRulesInstallation(
        pluginPath,
        harness,
        options.projectPath
      );
      operations.push(...rulesOps);
    }

    // Plan commands installation
    if (
      harness.supportsCommands &&
      harness.commandsDir &&
      manifestTargetsArtifact(manifest, "commands", harnessId)
    ) {
      const commandOps = await planCommandsInstallation(pluginPath, harness);
      operations.push(...commandOps);
    }

    // Plan agents installation
    if (
      harness.supportsAgents &&
      harness.agentsDir &&
      manifestTargetsArtifact(manifest, "agents", harnessId)
    ) {
      const agentOps = await planAgentsInstallation(pluginPath, harness);
      operations.push(...agentOps);
    }

    // Plan skills installation
    if (
      harness.supportsSkills &&
      harness.skillsDir &&
      manifestTargetsArtifact(manifest, "skills", harnessId)
    ) {
      const skillOps = await planSkillsInstallation(pluginPath, harness);
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
  harnessId: HarnessId
): Promise<"new" | "identical" | "changed"> {
  if (!(await exists(targetPath))) {
    return "new";
  }

  const { frontmatter, content } = await parseMarkdownFile(sourcePath);
  const harnessFrontmatter = getHarnessFrontmatter(frontmatter, harnessId);
  const finalContent = reconstructMarkdown(harnessFrontmatter, content);
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

async function getSharedSkillValidation(
  pluginPath: string
): Promise<Map<string, { valid: boolean; reason?: string }>> {
  const sharedSkillsDir = join(pluginPath, "skills");
  const validations = new Map<string, { valid: boolean; reason?: string }>();

  if (!(await exists(sharedSkillsDir))) {
    return validations;
  }

  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(sharedSkillsDir, { withFileTypes: true });

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }

    const validation = await validateSkill(join(sharedSkillsDir, entry.name), entry.name);
    validations.set(
      entry.name,
      validation.valid
        ? { valid: true }
        : {
            valid: false,
            reason: `Validation failed: ${validation.errors.join("; ")}`,
          }
    );
  }

  return validations;
}

async function getSelectedSkillValidation(
  pluginPath: string,
  harnessId: HarnessId,
  selectedFiles: Awaited<ReturnType<typeof collectArtifactSourceFiles>>
): Promise<Map<string, { valid: boolean; reason?: string }>> {
  const sharedValidation = await getSharedSkillValidation(pluginPath);
  const groupedFiles = new Map<string, Awaited<ReturnType<typeof collectArtifactSourceFiles>>>();

  for (const file of selectedFiles) {
    const [skillDirName, nestedPath] = file.relativePath.split("/", 2);
    if (!skillDirName || !nestedPath) {
      continue;
    }

    const group = groupedFiles.get(skillDirName) ?? [];
    group.push(file);
    groupedFiles.set(skillDirName, group);
  }

  const validations = new Map<string, { valid: boolean; reason?: string }>();

  for (const [skillDirName, files] of [...groupedFiles.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const selectedSkillMd = files.find(
      (file) => file.relativePath === `${skillDirName}/SKILL.md`
    );

    if (!selectedSkillMd) {
      validations.set(skillDirName, {
        valid: false,
        reason: "Validation failed: SKILL.md not found",
      });
      continue;
    }

    if (selectedSkillMd.scope === "shared") {
      validations.set(
        skillDirName,
        sharedValidation.get(skillDirName) ?? {
          valid: false,
          reason: "Validation failed: SKILL.md not found",
        }
      );
      continue;
    }

    const overlaySkillPath = join(
      pluginPath,
      "harness",
      harnessId,
      "skills",
      skillDirName
    );
    const validation = await validateSkill(overlaySkillPath, skillDirName);
    validations.set(
      skillDirName,
      validation.valid
        ? { valid: true }
        : {
            valid: false,
            reason: `Validation failed: ${validation.errors.join("; ")}`,
          }
    );
  }

  return validations;
}

type RuleSourceGroups = {
  readonly globalFiles: ArtifactSourceFile[];
  readonly projectFiles: ArtifactSourceFile[];
};

const isRuleSourceFile = (
  file: ArtifactSourceFile,
  root: "global" | "project"
): boolean =>
  file.relativePath.startsWith(`${root}/`) && file.relativePath.endsWith(".md");

async function collectRuleSourceGroups(
  pluginPath: string,
  harnessId: HarnessId
): Promise<RuleSourceGroups> {
  const files = await collectArtifactSourceFiles(pluginPath, "rules", harnessId);
  return {
    globalFiles: files.filter((file) => isRuleSourceFile(file, "global")),
    projectFiles: files.filter((file) => isRuleSourceFile(file, "project")),
  };
}

async function planAppendRuleOperation(
  file: ArtifactSourceFile,
  targetPath: string,
  harnessId: HarnessId
): Promise<FileOperation> {
  const appendStatus = await checkAppendStatus(file.sourcePath, targetPath, harnessId);
  if (appendStatus === "identical") {
    return {
      type: "skip",
      source: file.sourcePath,
      target: targetPath,
      harness: harnessId,
      artifact: "rules",
      reason: "Content already exists and is identical",
    };
  }

  return {
    type: "append",
    source: file.sourcePath,
    target: targetPath,
    harness: harnessId,
    artifact: "rules",
    reason: appendStatus === "changed" ? "Updating existing section" : undefined,
  };
}

function getProjectRuleTargetPath(
  harness: HarnessConfig,
  rulesFile: string,
  expandedProjectPath: string,
  relativeFile: string
): string {
  if (harness.rulesDir && harness.projectConfigPath) {
    return join(
      expandedProjectPath,
      harness.projectConfigPath,
      harness.rulesDir,
      relativeFile.replace(
        ".md",
        harness.configFormat === "mdc" ? ".mdc" : ".md"
      )
    );
  }

  if (harness.projectConfigPath) {
    return join(expandedProjectPath, rulesFile);
  }

  return join(expandPath(harness.globalConfigPath), rulesFile);
}

async function planProjectRuleOperation(
  file: ArtifactSourceFile,
  harness: HarnessConfig,
  rulesFile: string,
  expandedProjectPath: string
): Promise<FileOperation> {
  const relativeFile = file.relativePath.slice("project/".length);
  const targetPath = getProjectRuleTargetPath(
    harness,
    rulesFile,
    expandedProjectPath,
    relativeFile
  );

  if (harness.rulesDir) {
    return {
      type: "copy",
      source: file.sourcePath,
      target: targetPath,
      harness: harness.id,
      artifact: "rules",
    };
  }

  return planAppendRuleOperation(file, targetPath, harness.id);
}

/**
 * Plan rules file installation
 */
async function planRulesInstallation(
  pluginPath: string,
  harness: HarnessConfig,
  projectPath?: string
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];

  if (!harness.rulesFile) {
    return operations;
  }

  const rulesFile = harness.rulesFile;
  const { globalFiles, projectFiles } = await collectRuleSourceGroups(
    pluginPath,
    harness.id
  );

  const globalTargetPath = join(expandPath(harness.globalConfigPath), rulesFile);
  for (const file of globalFiles) {
    operations.push(await planAppendRuleOperation(file, globalTargetPath, harness.id));
  }

  if (projectPath) {
    const expandedProjectPath = expandPath(projectPath);

    for (const file of projectFiles) {
      operations.push(
        await planProjectRuleOperation(file, harness, rulesFile, expandedProjectPath)
      );
    }
  }

  return operations;
}

/**
 * Plan commands installation
 */
async function planCommandsInstallation(
  pluginPath: string,
  harness: HarnessConfig
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];
  const files = await collectArtifactSourceFiles(pluginPath, "commands", harness.id);
  const mdFiles = files.filter((file) => file.relativePath.endsWith(".md"));

  for (const file of mdFiles) {
    const targetDir = join(expandPath(harness.globalConfigPath), harness.commandsDir!);

    let targetFile = file.relativePath;
    if (harness.id === "gemini-cli") {
      targetFile = file.relativePath.replace(".md", ".toml");
    }

    const targetPath = join(targetDir, targetFile);

    operations.push({
      type: "copy",
      source: file.sourcePath,
      target: targetPath,
      harness: harness.id,
      artifact: "command",
    });
  }

  return operations;
}

/**
 * Plan agents installation
 *
 * Source markdown agents are no longer an install-phase artifact. Agents must
 * be authored as `agents/*.agent.ts`; compile lowerers generate the harness
 * markdown files.
 */
async function planAgentsInstallation(
  pluginPath: string,
  harness: HarnessConfig
): Promise<FileOperation[]> {
  void pluginPath;
  void harness;
  return [];
}

/**
 * Plan skills installation
 * Includes validation of skill structure
 */
async function planSkillsInstallation(
  pluginPath: string,
  harness: HarnessConfig
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];
  const selectedFiles = await collectArtifactSourceFiles(pluginPath, "skills", harness.id);

  if (selectedFiles.length === 0) {
    return operations;
  }

  const validatedSkills = await getSelectedSkillValidation(pluginPath, harness.id, selectedFiles);
  const targetDir = join(expandPath(harness.globalConfigPath), harness.skillsDir!);

  for (const [skillDirName, validation] of [...validatedSkills.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    if (!validation.valid) {
      operations.push({
        type: "skip",
        source: join(targetDir, skillDirName),
        target: join(targetDir, skillDirName),
        harness: harness.id,
        artifact: "skill",
        reason: validation.reason,
      });
    }
  }

  for (const file of selectedFiles) {
    const [skillDirName, nestedPath] = file.relativePath.split("/", 2);
    if (skillDirName && nestedPath && validatedSkills.get(skillDirName)?.valid === false) {
      continue;
    }

    operations.push({
      type: "copy",
      source: file.sourcePath,
      target: join(targetDir, file.relativePath),
      harness: harness.id,
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
  const harness = getHarness(op.harness);

  if (op.source.endsWith(".md")) {
    // Transform markdown with frontmatter
    const { frontmatter, content } = await parseMarkdownFile(op.source);
    const harnessFrontmatter = getHarnessFrontmatter(frontmatter, op.harness);

    // Ensure name is set for agent definitions (derived from filename)
    if (op.artifact === "agent" && !harnessFrontmatter.name) {
      harnessFrontmatter.name = basename(op.source, ".md");
    }

    // Handle special transformations per harness
    let finalContent: string;

    if (harness.id === "gemini-cli" && op.artifact === "command") {
      // Convert to TOML format for Gemini
      finalContent = convertCommandToToml(harnessFrontmatter, content);
    } else if (harness.id === "codex-cli" && op.artifact === "agent") {
      // Convert to TOML config file for Codex agent role
      finalContent = convertAgentToCodexToml(harnessFrontmatter, content);
      await writeFile(op.target, finalContent);
      // Also register this agent role in config.toml
      await mergeCodexAgentConfig(harness, harnessFrontmatter);
      return;
    } else if (harness.id === "cursor" && op.artifact === "rules") {
      // Convert to MDC format for Cursor
      finalContent = convertToMdc(harnessFrontmatter, content);
    } else {
      finalContent = reconstructMarkdown(harnessFrontmatter, content);
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
  const harnessFrontmatter = getHarnessFrontmatter(frontmatter, op.harness);

  const sourceName = basename(op.source, ".md");
  const beginMarker = `<!-- BEGIN: ${sourceName} -->`;
  const endMarker = `<!-- END: ${sourceName} -->`;

  const finalContent = reconstructMarkdown(harnessFrontmatter, content);

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

  // Replace prism argument placeholders with Gemini CLI format
  const promptContent = content.replace(/\$ARGUMENTS/g, "{{args}}");

  // The content becomes the prompt
  lines.push("");
  lines.push(`prompt = """${promptContent}"""`);

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
 * Convert agent markdown to TOML config file (for Codex CLI agent roles)
 * Produces a file like ~/.codex/agents/<name>.toml
 */
function convertAgentToCodexToml(
  frontmatter: Record<string, unknown>,
  content: string
): string {
  const lines: string[] = [];

  if (frontmatter.model && typeof frontmatter.model === "string") {
    lines.push(`model = "${frontmatter.model}"`);
  }

  if (frontmatter.model_reasoning_effort && typeof frontmatter.model_reasoning_effort === "string") {
    lines.push(`model_reasoning_effort = "${frontmatter.model_reasoning_effort}"`);
  }

  if (frontmatter.sandbox_mode && typeof frontmatter.sandbox_mode === "string") {
    lines.push(`sandbox_mode = "${frontmatter.sandbox_mode}"`);
  }

  // The markdown body becomes developer_instructions
  if (content.trim()) {
    if (lines.length > 0) lines.push("");
    lines.push(`developer_instructions = """\n${content.trim()}\n"""`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Merge agent role registration into Codex config.toml
 * Uses # BEGIN/END markers for idempotent updates (same pattern as rules)
 */
async function mergeCodexAgentConfig(
  harness: HarnessConfig,
  frontmatter: Record<string, unknown>
): Promise<void> {
  const agentName = typeof frontmatter.name === "string"
    ? frontmatter.name
    : "unknown";

  const configPath = join(expandPath(harness.globalConfigPath), harness.configFile!);
  const beginMarker = `# BEGIN: prism:${agentName}`;
  const endMarker = `# END: prism:${agentName}`;

  const description = typeof frontmatter.description === "string"
    ? frontmatter.description.replace(/"/g, '\\"')
    : "";

  const newSection = [
    beginMarker,
    `[agents.${agentName}]`,
    `description = "${description}"`,
    `config_file = "agents/${agentName}.toml"`,
    endMarker,
  ].join("\n");

  if (await exists(configPath)) {
    const existingContent = await readFile(configPath);

    if (existingContent.includes(beginMarker)) {
      const beginIndex = existingContent.indexOf(beginMarker);
      const endIndex = existingContent.indexOf(endMarker);

      if (endIndex > beginIndex) {
        const existingSection = existingContent.slice(
          beginIndex,
          endIndex + endMarker.length
        );

        if (existingSection === newSection) {
          return; // Already identical, skip
        }

        // Replace existing section in-place
        const before = existingContent.slice(0, beginIndex);
        const after = existingContent.slice(endIndex + endMarker.length);
        await writeFile(configPath, before + newSection + after);
        return;
      }
    }

    // Append new section
    const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
    await writeFile(configPath, existingContent + separator + newSection + "\n");
  } else {
    // Create config file (unlikely since codex config usually exists)
    await ensureDir(expandPath(harness.globalConfigPath));
    await writeFile(configPath, newSection + "\n");
  }
}

/**
 * Main installation function
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  const operations = await planInstallation(options);
  return executeInstallation(operations, options);
}
