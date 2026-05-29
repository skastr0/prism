/**
 * Core installation logic for plugin distribution
 */

import { basename, join } from "node:path";
import { getHarness } from "./harnesses.js";
import {
  copyFile,
  exists,
  expandPath,
  readFile,
  writeFile,
  ensureDir,
  removeDir,
  removeFile,
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
  ManagedFileOperationMetadata,
  HarnessScope,
} from "./types.js";
import { computeContentHash } from "./content-hash.js";
import {
  type HarnessLedger,
  type ManagedLedgerEntry,
  managedEntryId,
  readHarnessLedger,
  removeLedgerEntries,
  upsertLedgerEntries,
  writeHarnessLedger,
} from "./managed-ledger.js";
import { backupManagedTarget } from "./managed-backups.js";

type InstallArtifact = FileOperation["artifact"];

interface InstallPlanningContext {
  readonly pluginPath: string;
  readonly pluginName: string;
  readonly pluginVersion?: string;
  readonly harness: HarnessConfig;
  readonly ledger: HarnessLedger;
  readonly desiredEntryIds: Set<string>;
  readonly targetRoots: Set<string>;
  readonly overwrite: boolean;
}

interface ManagedOutputInput {
  readonly artifact: InstallArtifact;
  readonly scope: HarnessScope;
  readonly root: string;
  readonly targetPath: string;
  readonly kind: ManagedFileOperationMetadata["kind"];
  readonly sourcePath?: string;
  readonly contentHash: string;
}

const managedOperationMetadata = (
  context: InstallPlanningContext,
  input: ManagedOutputInput,
): ManagedFileOperationMetadata => {
  const entryId = managedEntryId({
    harness: context.harness.id,
    scope: input.scope,
    root: input.root,
    pluginName: context.pluginName,
    artifact: input.artifact,
    targetPath: input.targetPath,
    kind: input.kind,
    sourcePath: input.sourcePath,
  });
  context.desiredEntryIds.add(entryId);

  return {
    entryId,
    pluginName: context.pluginName,
    ...(context.pluginVersion ? { pluginVersion: context.pluginVersion } : {}),
    pluginPath: context.pluginPath,
    scope: input.scope,
    root: input.root,
    kind: input.kind,
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    contentHash: input.contentHash,
  };
};

const ledgerEntryForOperation = (
  op: FileOperation,
  now = new Date().toISOString(),
): ManagedLedgerEntry | undefined => {
  if (!op.managed) return undefined;
  return {
    id: op.managed.entryId,
    pluginName: op.managed.pluginName,
    ...(op.managed.pluginVersion ? { pluginVersion: op.managed.pluginVersion } : {}),
    pluginPath: op.managed.pluginPath,
    harness: op.harness,
    scope: op.managed.scope,
    root: op.managed.root,
    artifact: op.artifact,
    ...(op.managed.sourcePath ? { sourcePath: op.managed.sourcePath } : {}),
    targetPath: op.target,
    kind: op.managed.kind,
    contentHash: op.managed.contentHash,
    updatedAt: now,
  };
};

const findLedgerEntry = (
  context: InstallPlanningContext,
  entryId: string,
): ManagedLedgerEntry | undefined =>
  context.ledger.entries.find((entry) => entry.id === entryId);

const readTargetHash = async (targetPath: string): Promise<string | undefined> => {
  if (!(await exists(targetPath))) return undefined;
  const bytes = new Uint8Array(await Bun.file(targetPath).arrayBuffer());
  return computeContentHash(bytes);
};

const unmanagedTargetConflict = (op: FileOperation): FileOperation => ({
  ...op,
  type: "drift",
  reason: "Target exists but is not owned by Prism; use --overwrite to take ownership",
});

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
    const ledger = await readHarnessLedger(harnessId);
    const desiredEntryIds = new Set<string>();
    const context: InstallPlanningContext = {
      pluginPath,
      pluginName: manifest.name,
      pluginVersion: manifest.version,
      harness,
      ledger,
      desiredEntryIds,
      targetRoots: new Set([
        expandPath(harness.globalConfigPath),
        ...(options.projectPath ? [expandPath(options.projectPath)] : []),
      ]),
      overwrite: options.overwrite,
    };

    // Plan rules installation when the harness has a managed rules surface
    if (harness.rulesFile && manifestTargetsArtifact(manifest, "rules", harnessId)) {
      const rulesOps = await planRulesInstallation(
        pluginPath,
        harness,
        options.projectPath,
        context
      );
      operations.push(...rulesOps);
    }

    // Plan commands installation
    if (
      harness.supportsCommands &&
      harness.commandsDir &&
      manifestTargetsArtifact(manifest, "commands", harnessId)
    ) {
      const commandOps = await planCommandsInstallation(pluginPath, harness, context);
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
      const skillOps = await planSkillsInstallation(pluginPath, harness, context);
      operations.push(...skillOps);
    }

    operations.push(...(await planStaleManagedOperations(context)));
  }

  return operations;
}

const sectionMarker = (
  boundary: "begin" | "end",
  harnessId: HarnessId,
  metadata: ManagedFileOperationMetadata,
): string =>
  `<!-- prism:managed-section ${boundary} plugin=${JSON.stringify(metadata.pluginName)} artifact=${JSON.stringify("rules")} harness=${JSON.stringify(harnessId)} scope=${JSON.stringify(metadata.scope)} source=${JSON.stringify(metadata.sourcePath ?? "")} -->`;

const renderManagedSection = (
  harnessId: HarnessId,
  metadata: ManagedFileOperationMetadata,
  content: string,
): string =>
  `${sectionMarker("begin", harnessId, metadata)}\n${content}\n${sectionMarker("end", harnessId, metadata)}`;

const extractManagedSection = (
  existingContent: string,
  harnessId: HarnessId,
  metadata: ManagedFileOperationMetadata,
): string | undefined => {
  const beginMarker = sectionMarker("begin", harnessId, metadata);
  const endMarker = sectionMarker("end", harnessId, metadata);
  const beginIndex = existingContent.indexOf(beginMarker);
  if (beginIndex === -1) return undefined;
  const contentStart = beginIndex + beginMarker.length;
  const endIndex = existingContent.indexOf(endMarker, contentStart);
  if (endIndex === -1) return undefined;

  let section = existingContent.slice(contentStart, endIndex);
  if (section.startsWith("\n")) section = section.slice(1);
  if (section.endsWith("\n")) section = section.slice(0, -1);
  return section;
};

const replaceOrAppendManagedSection = (
  existingContent: string,
  harnessId: HarnessId,
  metadata: ManagedFileOperationMetadata,
  content: string,
): string => {
  const beginMarker = sectionMarker("begin", harnessId, metadata);
  const endMarker = sectionMarker("end", harnessId, metadata);
  const newSection = renderManagedSection(harnessId, metadata, content);
  const beginIndex = existingContent.indexOf(beginMarker);
  if (beginIndex !== -1) {
    const endIndex = existingContent.indexOf(endMarker, beginIndex + beginMarker.length);
    if (endIndex !== -1) {
      const before = existingContent.slice(0, beginIndex).trimEnd();
      const after = existingContent.slice(endIndex + endMarker.length).trimStart();
      return [before, newSection, after].filter((part) => part.length > 0).join("\n\n") + "\n";
    }
  }

  const base = existingContent.trimEnd();
  return `${base}${base.length > 0 ? "\n\n" : ""}${newSection}\n`;
};

const removeManagedSection = (
  existingContent: string,
  harnessId: HarnessId,
  metadata: ManagedFileOperationMetadata,
): string => {
  const beginMarker = sectionMarker("begin", harnessId, metadata);
  const endMarker = sectionMarker("end", harnessId, metadata);
  const beginIndex = existingContent.indexOf(beginMarker);
  if (beginIndex === -1) return existingContent;
  const endIndex = existingContent.indexOf(endMarker, beginIndex + beginMarker.length);
  if (endIndex === -1) return existingContent;

  const before = existingContent.slice(0, beginIndex).trimEnd();
  const after = existingContent.slice(endIndex + endMarker.length).trimStart();
  const next = [before, after].filter((part) => part.length > 0).join("\n\n");
  return next.length > 0 ? `${next}\n` : "";
};

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
  context: InstallPlanningContext,
  scope: HarnessScope,
  root: string
): Promise<FileOperation> {
  const { frontmatter, content } = await parseMarkdownFile(file.sourcePath);
  const harnessFrontmatter = getHarnessFrontmatter(frontmatter, context.harness.id);
  const finalContent = reconstructMarkdown(harnessFrontmatter, content);
  const managed = managedOperationMetadata(context, {
    artifact: "rules",
    scope,
    root,
    targetPath,
    kind: "section",
    sourcePath: file.relativePath,
    contentHash: computeContentHash(finalContent),
  });
  const baseOperation: FileOperation = {
    type: "append",
    source: file.sourcePath,
    target: targetPath,
    harness: context.harness.id,
    artifact: "rules",
    managed,
  };

  if (!(await exists(targetPath))) return baseOperation;

  const existingContent = await readFile(targetPath);
  const existingSection = extractManagedSection(existingContent, context.harness.id, managed);
  if (existingSection === undefined) return baseOperation;

  const currentHash = computeContentHash(existingSection);
  const ledgerEntry = findLedgerEntry(context, managed.entryId);
  if (!ledgerEntry && !context.overwrite) {
    return unmanagedTargetConflict(baseOperation);
  }
  if (
    ledgerEntry &&
    currentHash !== ledgerEntry.contentHash &&
    currentHash !== managed.contentHash
  ) {
    return {
      ...baseOperation,
      type: "drift",
      reason: "Managed rules section changed outside Prism",
    };
  }

  if (currentHash === managed.contentHash) {
    return {
      type: "skip",
      source: file.sourcePath,
      target: targetPath,
      harness: context.harness.id,
      artifact: "rules",
      reason: "Content already exists and is identical",
      managed,
    };
  }

  return {
    ...baseOperation,
    reason: "Updating existing section",
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
  expandedProjectPath: string,
  context: InstallPlanningContext
): Promise<FileOperation> {
  const relativeFile = file.relativePath.slice("project/".length);
  const targetPath = getProjectRuleTargetPath(
    harness,
    rulesFile,
    expandedProjectPath,
    relativeFile
  );

  if (harness.rulesDir) {
    return planManagedCopyOperation({
      file,
      targetPath,
      context,
      artifact: "rules",
      scope: "project",
      root: expandedProjectPath,
      transformMarkdown: (frontmatter, content) =>
        harness.id === "cursor"
          ? convertToMdc(getHarnessFrontmatter(frontmatter, harness.id), content)
          : reconstructMarkdown(getHarnessFrontmatter(frontmatter, harness.id), content),
    });
  }

  return planAppendRuleOperation(file, targetPath, context, "project", expandedProjectPath);
}

/**
 * Plan rules file installation
 */
async function planRulesInstallation(
  pluginPath: string,
  harness: HarnessConfig,
  projectPath: string | undefined,
  context: InstallPlanningContext
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

  const globalRoot = expandPath(harness.globalConfigPath);
  const globalTargetPath = join(globalRoot, rulesFile);
  for (const file of globalFiles) {
    operations.push(await planAppendRuleOperation(file, globalTargetPath, context, "global", globalRoot));
  }

  if (projectPath) {
    const expandedProjectPath = expandPath(projectPath);

    for (const file of projectFiles) {
      operations.push(
        await planProjectRuleOperation(file, harness, rulesFile, expandedProjectPath, context)
      );
    }
  }

  return operations;
}

async function renderManagedCopyContent(
  file: ArtifactSourceFile,
  harness: HarnessConfig,
  artifact: InstallArtifact,
  transformMarkdown?: (
    frontmatter: Record<string, unknown>,
    content: string,
  ) => string,
): Promise<string | Uint8Array> {
  if (!file.sourcePath.endsWith(".md")) {
    return new Uint8Array(await Bun.file(file.sourcePath).arrayBuffer());
  }

  const { frontmatter, content } = await parseMarkdownFile(file.sourcePath);
  if (transformMarkdown) return transformMarkdown({ ...frontmatter }, content);

  const harnessFrontmatter = getHarnessFrontmatter(frontmatter, harness.id);
  if (artifact === "agent" && !harnessFrontmatter.name) {
    harnessFrontmatter.name = basename(file.sourcePath, ".md");
  }

  if (harness.id === "gemini-cli" && artifact === "command") {
    return convertCommandToToml(harnessFrontmatter, content);
  }

  if (harness.id === "cursor" && artifact === "rules") {
    return convertToMdc(harnessFrontmatter, content);
  }

  return reconstructMarkdown(harnessFrontmatter, content);
}

async function planManagedCopyOperation(options: {
  readonly file: ArtifactSourceFile;
  readonly targetPath: string;
  readonly context: InstallPlanningContext;
  readonly artifact: InstallArtifact;
  readonly scope: HarnessScope;
  readonly root: string;
  readonly transformMarkdown?: (
    frontmatter: Record<string, unknown>,
    content: string,
  ) => string;
}): Promise<FileOperation> {
  const content = await renderManagedCopyContent(
    options.file,
    options.context.harness,
    options.artifact,
    options.transformMarkdown,
  );
  const contentHash = computeContentHash(content);
  const managed = managedOperationMetadata(options.context, {
    artifact: options.artifact,
    scope: options.scope,
    root: options.root,
    targetPath: options.targetPath,
    kind: "file",
    sourcePath: options.file.relativePath,
    contentHash,
  });
  const baseOperation: FileOperation = {
      type: "copy",
      source: options.file.sourcePath,
      target: options.targetPath,
      harness: options.context.harness.id,
      artifact: options.artifact,
      managed,
    };

  const currentHash = await readTargetHash(options.targetPath);
  if (!currentHash) return baseOperation;

  const ledgerEntry = findLedgerEntry(options.context, managed.entryId);
  if (!ledgerEntry && !options.context.overwrite) {
    return unmanagedTargetConflict(baseOperation);
  }

  if (
    ledgerEntry &&
    currentHash !== ledgerEntry.contentHash &&
    currentHash !== managed.contentHash
  ) {
    return {
      ...baseOperation,
      type: "drift",
      reason: "Managed target changed outside Prism",
    };
  }

  if (currentHash === managed.contentHash) {
    return {
      ...baseOperation,
      type: "skip",
      reason: "Content already exists and is identical",
    };
  }

  return { ...baseOperation, reason: "Updating changed target" };
}

/**
 * Plan commands installation
 */
async function planCommandsInstallation(
  pluginPath: string,
  harness: HarnessConfig,
  context: InstallPlanningContext
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];
  const files = await collectArtifactSourceFiles(pluginPath, "commands", harness.id);
  const mdFiles = files.filter((file) => file.relativePath.endsWith(".md"));
  const root = expandPath(harness.globalConfigPath);

  for (const file of mdFiles) {
    const targetDir = join(root, harness.commandsDir!);

    let targetFile = file.relativePath;
    if (harness.id === "gemini-cli") {
      targetFile = file.relativePath.replace(".md", ".toml");
    }

    const targetPath = join(targetDir, targetFile);

    operations.push(
      await planManagedCopyOperation({
        file,
        targetPath,
        context,
        artifact: "command",
        scope: "global",
        root,
      }),
    );
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
  harness: HarnessConfig,
  context: InstallPlanningContext
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];
  const selectedFiles = await collectArtifactSourceFiles(pluginPath, "skills", harness.id);

  if (selectedFiles.length === 0) {
    return operations;
  }

  const validatedSkills = await getSelectedSkillValidation(pluginPath, harness.id, selectedFiles);
  const root = expandPath(harness.globalConfigPath);
  const targetDir = join(root, harness.skillsDir!);

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

    operations.push(
      await planManagedCopyOperation({
        file,
        targetPath: join(targetDir, file.relativePath),
        context,
        artifact: "skill",
        scope: "global",
        root,
      }),
    );
  }

  return operations;
}

const installArtifacts = new Set(["rules", "command", "skill", "config"]);

const metadataFromLedgerEntry = (
  entry: ManagedLedgerEntry,
): ManagedFileOperationMetadata => ({
  entryId: entry.id,
  pluginName: entry.pluginName,
  ...(entry.pluginVersion ? { pluginVersion: entry.pluginVersion } : {}),
  pluginPath: entry.pluginPath,
  scope: entry.scope,
  root: entry.root,
  kind: entry.kind,
  ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
  contentHash: entry.contentHash,
});

async function planStaleManagedOperations(
  context: InstallPlanningContext,
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];

  for (const entry of context.ledger.entries) {
    if (entry.pluginName !== context.pluginName) continue;
    if (!context.targetRoots.has(entry.root)) continue;
    if (!installArtifacts.has(entry.artifact)) continue;
    if (context.desiredEntryIds.has(entry.id)) continue;

    const managed = metadataFromLedgerEntry(entry);
    const baseOperation: FileOperation = {
      type: "prune",
      source: entry.sourcePath ?? entry.targetPath,
      target: entry.targetPath,
      harness: context.harness.id,
      artifact: entry.artifact as FileOperation["artifact"],
      reason: "Stale managed output",
      managed,
    };

    if (entry.kind === "section") {
      if (!(await exists(entry.targetPath))) {
        operations.push({ ...baseOperation, reason: "Stale ledger entry; target missing" });
        continue;
      }
      const existingContent = await readFile(entry.targetPath);
      const existingSection = extractManagedSection(existingContent, context.harness.id, managed);
      if (existingSection === undefined) {
        operations.push({ ...baseOperation, reason: "Stale ledger entry; section missing" });
        continue;
      }
      const currentHash = computeContentHash(existingSection);
      if (currentHash !== entry.contentHash) {
        operations.push({
          ...baseOperation,
          type: "drift",
          reason: "Stale managed section changed outside Prism",
        });
        continue;
      }
      operations.push(baseOperation);
      continue;
    }

    const currentHash = await readTargetHash(entry.targetPath);
    if (!currentHash) {
      operations.push({ ...baseOperation, reason: "Stale ledger entry; target missing" });
      continue;
    }
    if (entry.kind === "file" && currentHash !== entry.contentHash) {
      operations.push({
        ...baseOperation,
        type: "drift",
        reason: "Stale managed target changed outside Prism",
      });
      continue;
    }
    operations.push(baseOperation);
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
  void options.backup;
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

  const ledgers = createLedgerWriteCache();

  for (const op of operations) {
    try {
      const backupPath = await executePlannedOperation(op, ledgers);
      if (backupPath) result.backups.push(backupPath);
      result.operations.push(op);
    } catch (error) {
      result.success = false;
      result.errors.push({
        operation: op,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [harness, ledger] of ledgers.entries()) {
    try {
      await writeHarnessLedger(ledger);
    } catch (error) {
      result.success = false;
      result.errors.push({
        operation: {
          type: "merge",
          source: "managed-ledger",
          target: harness,
          harness,
          artifact: "config",
        },
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

const createLedgerWriteCache = (): {
  readonly entries: () => IterableIterator<[HarnessId, HarnessLedger]>;
  readonly updateForOperation: (op: FileOperation) => Promise<void>;
} => {
  const ledgers = new Map<HarnessId, HarnessLedger>();

  const ledgerForHarness = async (harness: HarnessId): Promise<HarnessLedger> => {
    const existing = ledgers.get(harness);
    if (existing) return existing;
    const ledger = await readHarnessLedger(harness);
    ledgers.set(harness, ledger);
    return ledger;
  };

  return {
    entries: () => ledgers.entries(),
    updateForOperation: async (op) => {
      ledgers.set(op.harness, applyOperationToLedger(await ledgerForHarness(op.harness), op));
    },
  };
};

const executePlannedOperation = async (
  op: FileOperation,
  ledgers: ReturnType<typeof createLedgerWriteCache>,
): Promise<string | null> => {
  if (op.type === "skip") return null;
  if (op.type === "drift") {
    throw new Error(op.reason ?? "Managed target drift detected");
  }

  const backupPath = await backupBeforeManagedMutation(op);
  await executeWriteOrPrune(op);
  await ledgers.updateForOperation(op);
  return backupPath;
};

const executeWriteOrPrune = async (op: FileOperation): Promise<void> => {
  switch (op.type) {
    case "copy":
      await executeCopyOperation(op);
      return;
    case "append":
      await executeAppendOperation(op);
      return;
    case "merge":
      await executeMergeOperation(op);
      return;
    case "prune":
      await executePruneOperation(op);
      return;
    case "skip":
    case "drift":
      return;
  }
};

const backupBeforeManagedMutation = async (op: FileOperation): Promise<string | null> => {
  if (!op.managed) return null;
  if (!(await exists(op.target))) return null;
  return backupManagedTarget({
    harness: op.harness,
    scope: op.managed.scope,
    targetPath: op.target,
    operation: op.type === "prune" ? "prune" : op.type === "merge" ? "patch" : "write",
  });
};

const applyOperationToLedger = (
  ledger: HarnessLedger,
  op: FileOperation,
): HarnessLedger => {
  if (!op.managed) return ledger;
  if (op.type === "prune") {
    return removeLedgerEntries(ledger, new Set([op.managed.entryId]));
  }

  const entry = ledgerEntryForOperation(op);
  return entry ? upsertLedgerEntries(ledger, [entry]) : ledger;
};

/**
 * Execute a copy operation with content transformation
 */
async function executeCopyOperation(op: FileOperation): Promise<void> {
  const harness = getHarness(op.harness);
  const rendered = await renderManagedCopyContent(
    {
      sourcePath: op.source,
      relativePath: op.managed?.sourcePath ?? basename(op.source),
      scope: "shared",
    },
    harness,
    op.artifact,
  );

  if (typeof rendered === "string") {
    await writeFile(op.target, rendered);
  } else {
    await copyFile(op.source, op.target);
  }
}

/**
 * Execute an append operation
 * Appends content with BEGIN/END markers, or updates existing section if markers exist
 */
async function executeAppendOperation(op: FileOperation): Promise<void> {
  if (!op.managed) {
    throw new Error("Managed metadata is required for append operations");
  }
  const { frontmatter, content } = await parseMarkdownFile(op.source);
  const harnessFrontmatter = getHarnessFrontmatter(frontmatter, op.harness);
  const finalContent = reconstructMarkdown(harnessFrontmatter, content);
  const existingContent = (await exists(op.target)) ? await readFile(op.target) : "";
  await writeFile(
    op.target,
    replaceOrAppendManagedSection(existingContent, op.harness, op.managed, finalContent),
  );
}

async function executePruneOperation(op: FileOperation): Promise<void> {
  if (op.managed?.kind === "section") {
    if (!(await exists(op.target))) return;
    await writeFile(
      op.target,
      removeManagedSection(await readFile(op.target), op.harness, op.managed),
    );
    return;
  }

  if (op.managed?.kind === "directory") await removeDir(op.target);
  else await removeFile(op.target);
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
