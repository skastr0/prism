/**
 * Core installation logic for plugin distribution
 */

import { basename, join, resolve } from "node:path";
import { getHarness, resolveHarnessRoot } from "./harnesses.js";
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
  manifestHasCompileTargets,
  manifestTargetsArtifact,
  parseMarkdownFile,
  readManifest,
  reconstructMarkdown,
  resolveManifestTargets,
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
  PluginTargetId,
} from "./types.js";
import { computeContentHash } from "./content-hash.js";
import { normalizeGeneratedPluginName } from "./compile/generated-plugin.js";
import {
  type HarnessLedger,
  type ManagedLedgerEntry,
  hasOtherManagedCompileOwners,
  isSharedMcpRuntimeServerPath,
  managedEntryId,
  readHarnessLedger,
  removeLedgerEntries,
  upsertLedgerEntries,
  writeHarnessLedger,
} from "./managed-ledger.js";
import { backupManagedTarget } from "./managed-backups.js";

type InstallArtifact = FileOperation["artifact"];
type ResolvedPluginManifest = Awaited<ReturnType<typeof readManifest>>;

interface InstallPlanningContext {
  readonly pluginPath: string;
  readonly pluginName: string;
  readonly pluginVersion?: string;
  readonly harness: HarnessConfig;
  readonly ledger: HarnessLedger;
  readonly desiredEntryIds: Set<string>;
  readonly targetRoots: Set<string>;
  readonly pruneCompileOutputs: boolean;
  readonly overwrite: boolean;
}

const COMPILE_MANAGED_RULE_HARNESSES = new Set<HarnessId>(["antigravity-cli", "pi", "kimi-code"]);

const rulesAreCompileManaged = (harnessId: HarnessId): boolean =>
  COMPILE_MANAGED_RULE_HARNESSES.has(harnessId);

const COMPILE_MANAGED_COMMAND_HARNESSES = new Set<HarnessId>([
  "amp-code",
  "claude-code",
  "pi",
  "kimi-code",
]);

const commandsAreCompileManaged = (harnessId: HarnessId): boolean =>
  COMPILE_MANAGED_COMMAND_HARNESSES.has(harnessId);

const COMPILE_COPIES_TARGETED_SKILL_HARNESSES = new Set<HarnessId>([
  "amp-code",
  "antigravity-cli",
  "claude-code",
  "codex-cli",
  "grok",
  "hermes",
  "kimi-code",
  "pi",
]);

const PI_COMPILE_MANAGED_PLUGIN_ARTIFACTS = ["rules", "commands", "skills"] as const;
const KIMI_COMPILE_MANAGED_PLUGIN_ARTIFACTS = ["rules", "commands", "skills"] as const;

const shouldPlanFileRouterRules = (
  manifest: ResolvedPluginManifest,
  harness: HarnessConfig,
): boolean =>
  (harness.rulesFile !== null || harness.rulesDir !== null) &&
  !rulesAreCompileManaged(harness.id) &&
  manifestTargetsArtifact(manifest, "rules", harness.id);

const shouldPlanFileRouterSkills = (
  manifest: ResolvedPluginManifest,
  harnessId: HarnessId,
): boolean =>
  manifestTargetsArtifact(manifest, "skills", harnessId) &&
  !compileOwnsTargetedPluginSkills(manifest, harnessId);

const normalizeTargetRoot = (root: string): string => resolve(expandPath(root));

const manifestTargetsAnyArtifact = (
  manifest: ResolvedPluginManifest,
  artifact: string,
  harnessId: HarnessId,
): boolean => {
  const targets = (manifest.targets as Record<string, readonly PluginTargetId[] | undefined>)[artifact];
  return new Set(resolveManifestTargets(targets ?? [])).has(harnessId);
};

const hasOutputProducingCompileTargets = (
  manifest: ResolvedPluginManifest,
  harnessId: HarnessId,
): boolean => {
  if (!manifestHasCompileTargets(manifest, harnessId)) return false;
  if (
    ["agents", "orbits", "tools", "hooks"].some((artifact) =>
      manifestTargetsAnyArtifact(manifest, artifact, harnessId)
    )
  ) {
    return true;
  }
  if (harnessId === "antigravity-cli" && manifestTargetsArtifact(manifest, "rules", harnessId)) {
    return true;
  }
  if (harnessId === "amp-code" && manifestTargetsArtifact(manifest, "commands", harnessId)) {
    return true;
  }
  if (harnessId === "claude-code" && manifestTargetsArtifact(manifest, "commands", harnessId)) {
    return true;
  }
  if (
    harnessId === "pi" &&
    PI_COMPILE_MANAGED_PLUGIN_ARTIFACTS.some((artifact) =>
      manifestTargetsArtifact(manifest, artifact, harnessId)
    )
  ) {
    return true;
  }
  if (
    harnessId === "kimi-code" &&
    KIMI_COMPILE_MANAGED_PLUGIN_ARTIFACTS.some((artifact) =>
      manifestTargetsArtifact(manifest, artifact, harnessId)
    )
  ) {
    return true;
  }
  return false;
};

const compileOwnsTargetedPluginSkills = (
  manifest: ResolvedPluginManifest,
  harnessId: HarnessId,
): boolean => {
  if (!manifestHasCompileTargets(manifest, harnessId)) return false;
  if (COMPILE_COPIES_TARGETED_SKILL_HARNESSES.has(harnessId)) return true;
  return (
    harnessId === "factory-droid" &&
    ["agents", "tools", "hooks"].some((artifact) =>
      manifestTargetsAnyArtifact(manifest, artifact, harnessId)
    )
  );
};

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

const planRulesIfTargeted = async (
  manifest: ResolvedPluginManifest,
  pluginPath: string,
  harness: HarnessConfig,
  projectPath: string | undefined,
  context: InstallPlanningContext,
): Promise<FileOperation[]> =>
  shouldPlanFileRouterRules(manifest, harness)
    ? planRulesInstallation(pluginPath, harness, projectPath, context)
    : [];

const planCommandsIfTargeted = async (
  manifest: ResolvedPluginManifest,
  pluginPath: string,
  harness: HarnessConfig,
  context: InstallPlanningContext,
): Promise<FileOperation[]> =>
  harness.supportsCommands &&
  !commandsAreCompileManaged(harness.id) &&
  manifestTargetsArtifact(manifest, "commands", harness.id)
    ? harness.id === "cursor"
      ? planCursorPluginCommandsInstallation(pluginPath, context)
      : harness.commandsDir
        ? planCommandsInstallation(pluginPath, harness, context)
        : []
    : [];

const planAgentsIfTargeted = async (
  manifest: ResolvedPluginManifest,
  pluginPath: string,
  harness: HarnessConfig,
): Promise<FileOperation[]> =>
  harness.supportsAgents &&
  harness.agentsDir &&
  manifestTargetsArtifact(manifest, "agents", harness.id)
    ? planAgentsInstallation(pluginPath, harness)
    : [];

const planSkillsIfTargeted = async (
  manifest: ResolvedPluginManifest,
  pluginPath: string,
  harness: HarnessConfig,
  context: InstallPlanningContext,
): Promise<FileOperation[]> =>
  harness.supportsSkills &&
  harness.skillsDir &&
  shouldPlanFileRouterSkills(manifest, harness.id)
    ? planSkillsInstallation(pluginPath, harness, context)
    : [];

const planHarnessInstallationOperations = async (options: {
  readonly manifest: ResolvedPluginManifest;
  readonly pluginPath: string;
  readonly harness: HarnessConfig;
  readonly projectPath?: string;
  readonly context: InstallPlanningContext;
}): Promise<FileOperation[]> => {
  const operations: FileOperation[] = [];
  operations.push(
    ...(await planRulesIfTargeted(
      options.manifest,
      options.pluginPath,
      options.harness,
      options.projectPath,
      options.context,
    )),
  );
  operations.push(
    ...(await planCommandsIfTargeted(
      options.manifest,
      options.pluginPath,
      options.harness,
      options.context,
    )),
  );
  operations.push(
    ...(await planAgentsIfTargeted(options.manifest, options.pluginPath, options.harness)),
  );
  operations.push(
    ...(await planSkillsIfTargeted(
      options.manifest,
      options.pluginPath,
      options.harness,
      options.context,
    )),
  );
  operations.push(...(await planStaleManagedOperations(options.context)));
  return operations;
};

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
    const projectRoot = options.projectPath ? expandPath(options.projectPath) : undefined;
    const projectHarnessRoot = options.projectPath
      ? resolveHarnessRoot(harness, "project", options.projectPath)
      : null;
    const context: InstallPlanningContext = {
      pluginPath,
      pluginName: manifest.name,
      pluginVersion: manifest.version,
      harness,
      ledger,
      desiredEntryIds,
      targetRoots: new Set([
        normalizeTargetRoot(harness.globalConfigPath),
        ...(projectRoot ? [normalizeTargetRoot(projectRoot)] : []),
        ...(projectHarnessRoot ? [normalizeTargetRoot(projectHarnessRoot)] : []),
      ]),
      pruneCompileOutputs: !hasOutputProducingCompileTargets(manifest, harnessId),
      overwrite: options.overwrite,
    };

    operations.push(
      ...(await planHarnessInstallationOperations({
        manifest,
        pluginPath,
        harness,
        projectPath: options.projectPath,
        context,
      })),
    );
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
  rulesFile: string | null,
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
    if (!rulesFile) {
      throw new Error(`${harness.id} has project rules without a rules file or rules directory`);
    }
    return join(expandedProjectPath, rulesFile);
  }

  if (!rulesFile) {
    throw new Error(`${harness.id} has global rules without a rules file or rules directory`);
  }
  return join(expandPath(harness.globalConfigPath), rulesFile);
}

function getRulesDirTargetPath(
  harness: HarnessConfig,
  root: string,
  relativeFile: string
): string {
  if (!harness.rulesDir) {
    throw new Error(`${harness.id} has no rules directory`);
  }
  return join(
    root,
    harness.rulesDir,
    relativeFile.replace(
      ".md",
      harness.configFormat === "mdc" ? ".mdc" : ".md"
    )
  );
}

async function planRulesDirCopyOperation(
  file: ArtifactSourceFile,
  harness: HarnessConfig,
  targetPath: string,
  scope: HarnessScope,
  root: string,
  context: InstallPlanningContext
): Promise<FileOperation> {
  return planManagedCopyOperation({
    file,
    targetPath,
    context,
    artifact: "rules",
    scope,
    root,
    transformMarkdown: (frontmatter, content) =>
      harness.id === "cursor"
        ? convertToMdc(getHarnessFrontmatter(frontmatter, harness.id), content)
        : reconstructMarkdown(getHarnessFrontmatter(frontmatter, harness.id), content),
  });
}

async function planProjectRuleOperation(
  file: ArtifactSourceFile,
  harness: HarnessConfig,
  rulesFile: string | null,
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
    return planRulesDirCopyOperation(
      file,
      harness,
      targetPath,
      "project",
      expandedProjectPath,
      context
    );
  }

  if (!rulesFile) {
    throw new Error(`${harness.id} has no project rules target`);
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

  if (!harness.rulesFile && !harness.rulesDir) {
    return operations;
  }

  const rulesFile = harness.rulesFile;
  const { globalFiles, projectFiles } = await collectRuleSourceGroups(
    pluginPath,
    harness.id
  );

  const globalRoot = expandPath(harness.globalConfigPath);
  for (const file of globalFiles) {
    if (rulesFile) {
      operations.push(
        await planAppendRuleOperation(file, join(globalRoot, rulesFile), context, "global", globalRoot)
      );
      continue;
    }

    operations.push(
      await planRulesDirCopyOperation(
        file,
        harness,
        getRulesDirTargetPath(harness, globalRoot, file.relativePath.slice("global/".length)),
        "global",
        globalRoot,
        context
      )
    );
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
  return planManagedFileOperation({
    source: options.file.sourcePath,
    sourcePath: options.file.relativePath,
    targetPath: options.targetPath,
    contentHash,
    context: options.context,
    artifact: options.artifact,
    scope: options.scope,
    root: options.root,
  });
}

async function planManagedGeneratedContentOperation(options: {
  readonly source: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly content: string;
  readonly context: InstallPlanningContext;
  readonly artifact: InstallArtifact;
  readonly scope: HarnessScope;
  readonly root: string;
}): Promise<FileOperation> {
  return planManagedFileOperation({
    source: options.source,
    sourcePath: options.sourcePath,
    targetPath: options.targetPath,
    contentHash: computeContentHash(options.content),
    content: options.content,
    context: options.context,
    artifact: options.artifact,
    scope: options.scope,
    root: options.root,
  });
}

async function planManagedFileOperation(options: {
  readonly source: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly contentHash: string;
  readonly content?: string;
  readonly context: InstallPlanningContext;
  readonly artifact: InstallArtifact;
  readonly scope: HarnessScope;
  readonly root: string;
}): Promise<FileOperation> {
  const managed = managedOperationMetadata(options.context, {
    artifact: options.artifact,
    scope: options.scope,
    root: options.root,
    targetPath: options.targetPath,
    kind: "file",
    sourcePath: options.sourcePath,
    contentHash: options.contentHash,
  });
  const baseOperation: FileOperation = {
    type: "copy",
    source: options.source,
    target: options.targetPath,
    harness: options.context.harness.id,
    artifact: options.artifact,
    ...(options.content !== undefined ? { content: options.content } : {}),
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

    const targetPath = join(targetDir, file.relativePath);

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

const normalizeCursorPluginNameSegment = (pluginName: string): string => {
  const normalized = normalizeGeneratedPluginName(pluginName)
    .replace(/_/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return normalized.length > 0 ? normalized : "plugin";
};

const cursorGeneratedPluginName = (pluginName: string): string =>
  `prism-generated-${normalizeCursorPluginNameSegment(pluginName)}`;

const cursorGeneratedCommandPluginRoot = (
  root: string,
  pluginName: string,
): string => join(root, "plugins", "local", cursorGeneratedPluginName(pluginName));

const renderCursorGeneratedCommandPluginManifest = (
  context: InstallPlanningContext,
): string => `${JSON.stringify(
  {
    name: cursorGeneratedPluginName(context.pluginName),
    ...(context.pluginVersion ? { version: context.pluginVersion } : {}),
    description: `Prism-generated Cursor commands for ${context.pluginName}.`,
    commands: "commands/",
  },
  null,
  2,
)}\n`;

async function planCursorPluginCommandsInstallation(
  pluginPath: string,
  context: InstallPlanningContext,
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];
  const files = await collectArtifactSourceFiles(pluginPath, "commands", context.harness.id);
  const commandFiles = files.filter((file) => file.relativePath.endsWith(".md"));
  if (commandFiles.length === 0) return operations;

  const root = expandPath(context.harness.globalConfigPath);
  const pluginRoot = cursorGeneratedCommandPluginRoot(root, context.pluginName);
  const manifestPath = join(pluginRoot, ".cursor-plugin", "plugin.json");
  operations.push(
    await planManagedGeneratedContentOperation({
      source: join(pluginPath, ".cursor-plugin", "plugin.json"),
      sourcePath: ".cursor-plugin/plugin.json",
      targetPath: manifestPath,
      content: renderCursorGeneratedCommandPluginManifest(context),
      context,
      artifact: "config",
      scope: "global",
      root,
    }),
  );

  for (const file of commandFiles) {
    operations.push(
      await planManagedCopyOperation({
        file,
        targetPath: join(pluginRoot, "commands", file.relativePath),
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

const shouldPlanStaleManagedOperation = (
  context: InstallPlanningContext,
  entry: ManagedLedgerEntry,
): boolean => {
  if (installArtifacts.has(entry.artifact)) return true;
  if (
    context.pruneCompileOutputs &&
    entry.artifact === "compile" &&
    (entry.kind === "file" || entry.kind === "directory") &&
    context.harness.id === "cursor" &&
    context.ledger.entries.some(
      (candidate) =>
        candidate.pluginName === entry.pluginName &&
        candidate.scope === entry.scope &&
        normalizeTargetRoot(candidate.root) === normalizeTargetRoot(entry.root) &&
        candidate.artifact === "compile" &&
        candidate.kind === "config",
    )
  ) {
    return false;
  }
  return (
    context.pruneCompileOutputs &&
    entry.artifact === "compile" &&
    (entry.kind === "file" || entry.kind === "directory")
  );
};

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

const shouldConsiderStaleEntry = (
  context: InstallPlanningContext,
  entry: ManagedLedgerEntry,
): boolean =>
  entry.pluginName === context.pluginName &&
  context.targetRoots.has(normalizeTargetRoot(entry.root)) &&
  shouldPlanStaleManagedOperation(context, entry) &&
  !context.desiredEntryIds.has(entry.id);

const staleBaseOperation = (
  context: InstallPlanningContext,
  entry: ManagedLedgerEntry,
): FileOperation => ({
  type: "prune",
  source: entry.sourcePath ?? entry.targetPath,
  target: entry.targetPath,
  harness: context.harness.id,
  artifact: entry.artifact as FileOperation["artifact"],
  reason: "Stale managed output",
  managed: metadataFromLedgerEntry(entry),
});

const planStaleSectionOperation = async (
  context: InstallPlanningContext,
  entry: ManagedLedgerEntry,
  baseOperation: FileOperation,
): Promise<FileOperation> => {
  if (!(await exists(entry.targetPath))) {
    return { ...baseOperation, reason: "Stale ledger entry; target missing" };
  }

  const existingContent = await readFile(entry.targetPath);
  const existingSection = extractManagedSection(
    existingContent,
    context.harness.id,
    baseOperation.managed!,
  );
  if (existingSection === undefined) {
    return { ...baseOperation, reason: "Stale ledger entry; section missing" };
  }

  return computeContentHash(existingSection) === entry.contentHash
    ? baseOperation
    : {
        ...baseOperation,
        type: "drift",
        reason: "Stale managed section changed outside Prism",
      };
};

const planStaleDirectoryOperation = async (
  entry: ManagedLedgerEntry,
  baseOperation: FileOperation,
): Promise<FileOperation> =>
  (await exists(entry.targetPath))
    ? baseOperation
    : { ...baseOperation, reason: "Stale ledger entry; target missing" };

const staleChangedFileOperation = async (
  context: InstallPlanningContext,
  entry: ManagedLedgerEntry,
  baseOperation: FileOperation,
): Promise<FileOperation> => {
  if (
    entry.artifact === "compile" &&
    isSharedMcpRuntimeServerPath(entry.targetPath) &&
    await hasOtherManagedCompileOwners({
      currentHarness: context.harness.id,
      currentEntryId: entry.id,
      pluginName: entry.pluginName,
      targetPath: entry.targetPath,
      kind: "file",
    })
  ) {
    return {
      ...baseOperation,
      reason: "Stale shared compile output still owned by another harness",
    };
  }

  return {
    ...baseOperation,
    type: "drift",
    reason: "Stale managed target changed outside Prism",
  };
};

const planStaleFileLikeOperation = async (
  context: InstallPlanningContext,
  entry: ManagedLedgerEntry,
  baseOperation: FileOperation,
): Promise<FileOperation> => {
  const currentHash = await readTargetHash(entry.targetPath);
  if (!currentHash) return { ...baseOperation, reason: "Stale ledger entry; target missing" };
  if (entry.kind === "file" && currentHash !== entry.contentHash) {
    return staleChangedFileOperation(context, entry, baseOperation);
  }
  return baseOperation;
};

const planStaleManagedOperation = async (
  context: InstallPlanningContext,
  entry: ManagedLedgerEntry,
): Promise<FileOperation> => {
  const baseOperation = staleBaseOperation(context, entry);
  if (entry.kind === "section") {
    return planStaleSectionOperation(context, entry, baseOperation);
  }
  if (entry.kind === "directory") {
    return planStaleDirectoryOperation(entry, baseOperation);
  }
  return planStaleFileLikeOperation(context, entry, baseOperation);
};

async function planStaleManagedOperations(
  context: InstallPlanningContext,
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];

  for (const entry of context.ledger.entries) {
    if (!shouldConsiderStaleEntry(context, entry)) continue;
    operations.push(await planStaleManagedOperation(context, entry));
  }

  return operations;
}

/**
 * Execute installation plan
 */
export async function executeInstallation(
  operations: FileOperation[],
  options: Pick<InstallOptions, "overwrite" | "dryRun">
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

  const ledgers = createLedgerWriteCache();

  for (const op of operations) {
    const outcome = await executePlannedOperationOutcome(op, ledgers);
    if (outcome.ok) {
      if (outcome.backupPath) result.backups.push(outcome.backupPath);
      result.operations.push(op);
    } else {
      result.success = false;
      result.errors.push({ operation: op, message: outcome.message });
    }
  }

  for (const [harness, ledger] of ledgers.entries()) {
    const outcome = await writeLedgerOutcome(harness, ledger);
    if (!outcome.ok) {
      result.success = false;
      result.errors.push({ operation: outcome.operation, message: outcome.message });
    }
  }

  return result;
}

type InstallExecutionOutcome =
  | { readonly ok: true; readonly backupPath: string | null }
  | { readonly ok: false; readonly message: string };

const executePlannedOperationOutcome = async (
  op: FileOperation,
  ledgers: ReturnType<typeof createLedgerWriteCache>,
): Promise<InstallExecutionOutcome> => {
  try {
    return { ok: true, backupPath: await executePlannedOperation(op, ledgers) };
  } catch (error) {
    return { ok: false, message: installFailureMessage(error) };
  }
};

type LedgerWriteOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly operation: FileOperation; readonly message: string };

const writeLedgerOutcome = async (
  harness: HarnessId,
  ledger: HarnessLedger,
): Promise<LedgerWriteOutcome> => {
  try {
    await writeHarnessLedger(ledger);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      operation: {
        type: "merge",
        source: "managed-ledger",
        target: harness,
        harness,
        artifact: "config",
      },
      message: installFailureMessage(error),
    };
  }
};

const installFailureMessage = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Non-Error thrown: ${String(error)}`;
};

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

  if (await shouldForgetSharedCompilePrune(op)) {
    await ledgers.updateForOperation(op);
    return null;
  }

  const backupPath = await backupBeforeManagedMutation(op);
  await executeWriteOrPrune(op);
  await ledgers.updateForOperation(op);
  return backupPath;
};

const shouldForgetSharedCompilePrune = async (op: FileOperation): Promise<boolean> => {
  if (op.type !== "prune" || op.artifact !== "compile" || !op.managed) return false;
  if (op.managed.kind !== "file" || !isSharedMcpRuntimeServerPath(op.target)) return false;
  return hasOtherManagedCompileOwners({
    currentHarness: op.harness,
    currentEntryId: op.managed.entryId,
    pluginName: op.managed.pluginName,
    targetPath: op.target,
    kind: "file",
  });
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
  if (op.content !== undefined) {
    await writeFile(op.target, op.content);
    return;
  }

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
