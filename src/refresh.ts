import { basename, join, resolve } from "node:path";
import { getHarness, resolveHarnessRoot } from "./harnesses.js";
import type { HarnessRootsEnv } from "./services/prism-env.js";
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
  HarnessScope,
  PluginManifest,
  PluginTargetId,
} from "./types.js";
import { expandPath, readFile } from "./fs.js";
import { normalizeGeneratedPluginName } from "./compile/generated-plugin.js";
import type { DesiredFile, DesiredRegion, DesiredRoot } from "./sync/desired.js";
import type { SyncOpFailure, SyncOpListener, SyncReport } from "./sync/apply.js";
import { blockedTargetErrors, syncDesiredRoot } from "./sync/run.js";
import type { BlockedTargetError } from "./errors.js";

type ResolvedPluginManifest = Awaited<ReturnType<typeof readManifest>>;
type DirectArtifact = "rules" | "command" | "skill" | "config";

export interface RefreshOptions {
  readonly pluginPath: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly projectPath?: string;
  readonly prismHome: string;
  readonly overwrite: boolean;
  readonly dryRun: boolean;
  /** Optional harness-root resolver; when provided, global roots come from here instead of HOME. */
  readonly roots?: HarnessRootsEnv;
  /** Optional per-op progress listener (fires only on real apply, not dry-run). */
  readonly onOp?: SyncOpListener;
}

export interface RefreshWarning {
  readonly harness: HarnessId;
  readonly targetPath: string;
  readonly reason: string;
}

export interface PlannedRefresh {
  readonly pluginName: string;
  readonly pluginVersion?: string;
  readonly desiredRoots: ReadonlyArray<DesiredRoot>;
  readonly scopePlugin: string;
  readonly warnings: ReadonlyArray<RefreshWarning>;
}

export interface RefreshResult extends PlannedRefresh {
  readonly reports: ReadonlyArray<SyncReport>;
  readonly failures: ReadonlyArray<SyncOpFailure>;
  readonly blocked: ReadonlyArray<BlockedTargetError>;
  readonly backups: ReadonlyArray<string>;
  readonly converged: boolean;
  readonly success: boolean;
}

const resolveGlobalHarnessRoot = (
  harness: HarnessConfig,
  roots?: HarnessRootsEnv,
): string => (roots ? roots.resolve(harness.id) : expandPath(harness.globalConfigPath));

const FILE_ROUTER_SCOPE_SUFFIX = "#file-router";

const fileRouterScopePlugin = (pluginName: string): string =>
  `${pluginName}${FILE_ROUTER_SCOPE_SUFFIX}`;

const COMPILE_MANAGED_RULE_HARNESSES = new Set<HarnessId>(["antigravity-cli", "pi", "omp", "kimi-code"]);

const rulesAreCompileManaged = (harnessId: HarnessId): boolean =>
  COMPILE_MANAGED_RULE_HARNESSES.has(harnessId);

const COMPILE_MANAGED_COMMAND_HARNESSES = new Set<HarnessId>([
  "amp-code",
  "claude-code",
  "pi",
  "omp",
  "kimi-code",
]);

const commandsAreCompileManaged = (harnessId: HarnessId): boolean =>
  COMPILE_MANAGED_COMMAND_HARNESSES.has(harnessId);

const COMPILE_COPIES_TARGETED_SKILL_HARNESSES = new Set<HarnessId>([
  "amp-code",
  "antigravity-cli",
  "claude-code",
  "codex-cli",
  "devin",
  "grok",
  "hermes",
  "kimi-code",
  "pi",
  "omp",
]);

const manifestTargetsAnyArtifact = (
  manifest: ResolvedPluginManifest,
  artifact: string,
  harnessId: HarnessId,
): boolean => {
  const targets = (manifest.targets as Record<string, readonly PluginTargetId[] | undefined>)[artifact];
  return new Set(resolveManifestTargets(targets ?? [])).has(harnessId);
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
      manifestTargetsAnyArtifact(manifest, artifact, harnessId),
    )
  );
};

const shouldPlanFileRouterRules = (
  manifest: ResolvedPluginManifest,
  harness: HarnessConfig,
): boolean =>
  (harness.rulesFile !== null || harness.rulesDir !== null) &&
  !rulesAreCompileManaged(harness.id) &&
  manifestTargetsArtifact(manifest, "rules", harness.id);

const shouldPlanFileRouterCommands = (
  manifest: ResolvedPluginManifest,
  harness: HarnessConfig,
): boolean =>
  harness.supportsCommands &&
  !commandsAreCompileManaged(harness.id) &&
  manifestTargetsArtifact(manifest, "commands", harness.id) &&
  (harness.id === "cursor" || harness.commandsDir !== null);

const shouldPlanFileRouterSkills = (
  manifest: ResolvedPluginManifest,
  harness: HarnessConfig,
): boolean =>
  harness.supportsSkills &&
  harness.skillsDir !== null &&
  manifestTargetsArtifact(manifest, "skills", harness.id) &&
  !compileOwnsTargetedPluginSkills(manifest, harness.id);

const stableRegionPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.:/-]+/g, "_");

const directRegionKey = (input: {
  readonly pluginName: string;
  readonly harness: HarnessId;
  readonly scope: HarnessScope;
  readonly sourcePath: string;
}): string =>
  [
    "file-router.rules",
    stableRegionPart(input.pluginName),
    input.harness,
    input.scope,
    stableRegionPart(input.sourcePath),
  ].join(".");

class DesiredRootBuilder {
  readonly roots = new Map<string, DesiredRoot>();

  rootFor(harness: HarnessId, root: string): DesiredRoot {
    const resolvedRoot = resolve(expandPath(root));
    const key = `${harness}\0${resolvedRoot}`;
    const existing = this.roots.get(key);
    if (existing) return existing;
    const created: DesiredRoot = {
      harness,
      root: resolvedRoot,
      files: [],
      regions: [],
    };
    this.roots.set(key, created);
    return created;
  }

  addFile(harness: HarnessId, root: string, file: DesiredFile): void {
    const current = this.rootFor(harness, root);
    (current.files as DesiredFile[]).push(file);
  }

  addRegion(harness: HarnessId, root: string, region: DesiredRegion): void {
    const current = this.rootFor(harness, root);
    (current.regions as DesiredRegion[]).push(region);
  }

  values(): DesiredRoot[] {
    return [...this.roots.values()]
      .map((root) => ({
        ...root,
        files: [...root.files].sort((left, right) => left.targetPath.localeCompare(right.targetPath)),
        regions: [...root.regions].sort((left, right) =>
          left.targetPath === right.targetPath
            ? left.regionKey.localeCompare(right.regionKey)
            : left.targetPath.localeCompare(right.targetPath),
        ),
      }))
      .sort((left, right) =>
        left.harness === right.harness
          ? left.root.localeCompare(right.root)
          : left.harness.localeCompare(right.harness),
      );
  }
}

const convertToMdc = (
  frontmatter: Record<string, unknown>,
  content: string,
): string => {
  const mdcFrontmatter: Record<string, unknown> = {};
  if (frontmatter.description) mdcFrontmatter.description = frontmatter.description;
  if (frontmatter.globs) mdcFrontmatter.globs = frontmatter.globs;
  if (frontmatter.alwaysApply !== undefined) {
    mdcFrontmatter.alwaysApply = frontmatter.alwaysApply;
  }
  return reconstructMarkdown(mdcFrontmatter, content);
};

const renderMarkdownArtifact = async (
  file: ArtifactSourceFile,
  harness: HarnessConfig,
  artifact: DirectArtifact,
  transformMarkdown?: (frontmatter: Record<string, unknown>, content: string) => string,
): Promise<string> => {
  const { frontmatter, content } = await parseMarkdownFile(file.sourcePath);
  if (transformMarkdown) return transformMarkdown({ ...frontmatter }, content);

  const harnessFrontmatter = getHarnessFrontmatter(frontmatter, harness.id);
  if (artifact === "config") return reconstructMarkdown(harnessFrontmatter, content);
  if (!harnessFrontmatter.name && artifact === "command") {
    harnessFrontmatter.name = basename(file.sourcePath, ".md");
  }
  if (harness.id === "cursor" && artifact === "rules") {
    return convertToMdc(harnessFrontmatter, content);
  }
  return reconstructMarkdown(harnessFrontmatter, content);
};

const renderArtifactContent = async (options: {
  readonly file: ArtifactSourceFile;
  readonly harness: HarnessConfig;
  readonly artifact: DirectArtifact;
  readonly transformMarkdown?: (frontmatter: Record<string, unknown>, content: string) => string;
}): Promise<string> =>
  options.file.sourcePath.endsWith(".md")
    ? renderMarkdownArtifact(
        options.file,
        options.harness,
        options.artifact,
        options.transformMarkdown,
      )
    : readFile(options.file.sourcePath);

const addManagedFile = async (options: {
  readonly builder: DesiredRootBuilder;
  readonly plugin: string;
  readonly file: ArtifactSourceFile;
  readonly harness: HarnessConfig;
  readonly root: string;
  readonly targetPath: string;
  readonly artifact: DirectArtifact;
  readonly transformMarkdown?: (frontmatter: Record<string, unknown>, content: string) => string;
}): Promise<void> => {
  options.builder.addFile(options.harness.id, options.root, {
    targetPath: options.targetPath,
    content: await renderArtifactContent({
      file: options.file,
      harness: options.harness,
      artifact: options.artifact,
      ...(options.transformMarkdown ? { transformMarkdown: options.transformMarkdown } : {}),
    }),
    plugin: options.plugin,
  });
};

const collectRuleSourceGroups = async (
  pluginPath: string,
  harnessId: HarnessId,
): Promise<{
  readonly globalFiles: ArtifactSourceFile[];
  readonly projectFiles: ArtifactSourceFile[];
}> => {
  const files = await collectArtifactSourceFiles(pluginPath, "rules", harnessId);
  return {
    globalFiles: files.filter(
      (file) => file.relativePath.startsWith("global/") && file.relativePath.endsWith(".md"),
    ),
    projectFiles: files.filter(
      (file) => file.relativePath.startsWith("project/") && file.relativePath.endsWith(".md"),
    ),
  };
};

const getRulesDirTargetPath = (
  harness: HarnessConfig,
  root: string,
  relativeFile: string,
): string => {
  if (!harness.rulesDir) throw new Error(`${harness.id} has no rules directory`);
  return join(
    root,
    harness.rulesDir,
    relativeFile.replace(".md", harness.configFormat === "mdc" ? ".mdc" : ".md"),
  );
};

const getProjectRuleTargetPath = (
  harness: HarnessConfig,
  rulesFile: string | null,
  expandedProjectPath: string,
  relativeFile: string,
  roots?: HarnessRootsEnv,
): string => {
  if (harness.rulesDir && harness.projectConfigPath) {
    return join(
      expandedProjectPath,
      harness.projectConfigPath,
      harness.rulesDir,
      relativeFile.replace(".md", harness.configFormat === "mdc" ? ".mdc" : ".md"),
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
  return join(resolveGlobalHarnessRoot(harness, roots), rulesFile);
};

const addRuleRegion = async (options: {
  readonly builder: DesiredRootBuilder;
  readonly manifest: PluginManifest;
  readonly plugin: string;
  readonly file: ArtifactSourceFile;
  readonly harness: HarnessConfig;
  readonly root: string;
  readonly targetPath: string;
  readonly scope: HarnessScope;
}): Promise<void> => {
  const { frontmatter, content } = await parseMarkdownFile(options.file.sourcePath);
  options.builder.addRegion(options.harness.id, options.root, {
    kind: "marker",
    targetPath: options.targetPath,
    regionKey: directRegionKey({
      pluginName: options.manifest.name,
      harness: options.harness.id,
      scope: options.scope,
      sourcePath: options.file.relativePath,
    }),
    commentPrefix: "<!--",
    commentSuffix: " -->",
    content: reconstructMarkdown(getHarnessFrontmatter(frontmatter, options.harness.id), content),
    plugin: options.plugin,
  });
};

const addRulesForHarness = async (options: {
  readonly builder: DesiredRootBuilder;
  readonly warnings: RefreshWarning[];
  readonly manifest: PluginManifest;
  readonly pluginPath: string;
  readonly plugin: string;
  readonly harness: HarnessConfig;
  readonly projectPath?: string;
  readonly roots?: HarnessRootsEnv;
}): Promise<void> => {
  if (!shouldPlanFileRouterRules(options.manifest, options.harness)) return;

  const rulesFile = options.harness.rulesFile;
  const { globalFiles, projectFiles } = await collectRuleSourceGroups(
    options.pluginPath,
    options.harness.id,
  );
  const globalRoot = resolveGlobalHarnessRoot(options.harness, options.roots);

  for (const file of globalFiles) {
    if (rulesFile) {
      await addRuleRegion({
        builder: options.builder,
        manifest: options.manifest,
        plugin: options.plugin,
        file,
        harness: options.harness,
        root: globalRoot,
        targetPath: join(globalRoot, rulesFile),
        scope: "global",
      });
      continue;
    }

    await addManagedFile({
      builder: options.builder,
      plugin: options.plugin,
      file,
      harness: options.harness,
      root: globalRoot,
      targetPath: getRulesDirTargetPath(
        options.harness,
        globalRoot,
        file.relativePath.slice("global/".length),
      ),
      artifact: "rules",
      transformMarkdown: (frontmatter, content) =>
        options.harness.id === "cursor"
          ? convertToMdc(getHarnessFrontmatter(frontmatter, options.harness.id), content)
          : reconstructMarkdown(getHarnessFrontmatter(frontmatter, options.harness.id), content),
    });
  }

  if (!options.projectPath) return;
  const expandedProjectPath = expandPath(options.projectPath);
  for (const file of projectFiles) {
    const relativeFile = file.relativePath.slice("project/".length);
    const targetPath = getProjectRuleTargetPath(
      options.harness,
      rulesFile,
      expandedProjectPath,
      relativeFile,
      options.roots,
    );
    if (options.harness.rulesDir) {
      await addManagedFile({
        builder: options.builder,
        plugin: options.plugin,
        file,
        harness: options.harness,
        root: expandedProjectPath,
        targetPath,
        artifact: "rules",
        transformMarkdown: (frontmatter, content) =>
          options.harness.id === "cursor"
            ? convertToMdc(getHarnessFrontmatter(frontmatter, options.harness.id), content)
            : reconstructMarkdown(getHarnessFrontmatter(frontmatter, options.harness.id), content),
      });
      continue;
    }

    await addRuleRegion({
      builder: options.builder,
      manifest: options.manifest,
      plugin: options.plugin,
      file,
      harness: options.harness,
      root: expandedProjectPath,
      targetPath,
      scope: "project",
    });
  }
};

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
  manifest: PluginManifest,
): string => `${JSON.stringify(
  {
    name: cursorGeneratedPluginName(manifest.name),
    version: manifest.version,
    description: `Prism-generated Cursor commands for ${manifest.name}.`,
    commands: "commands/",
  },
  null,
  2,
)}\n`;

const addCommandsForHarness = async (options: {
  readonly builder: DesiredRootBuilder;
  readonly manifest: PluginManifest;
  readonly pluginPath: string;
  readonly plugin: string;
  readonly harness: HarnessConfig;
  readonly roots?: HarnessRootsEnv;
}): Promise<void> => {
  if (!shouldPlanFileRouterCommands(options.manifest, options.harness)) return;

  const files = await collectArtifactSourceFiles(options.pluginPath, "commands", options.harness.id);
  const commandFiles = files.filter((file) => file.relativePath.endsWith(".md"));
  if (commandFiles.length === 0) return;

  const root = resolveGlobalHarnessRoot(options.harness, options.roots);
  if (options.harness.id === "cursor") {
    const pluginRoot = cursorGeneratedCommandPluginRoot(root, options.manifest.name);
    options.builder.addFile(options.harness.id, root, {
      targetPath: join(pluginRoot, ".cursor-plugin", "plugin.json"),
      content: renderCursorGeneratedCommandPluginManifest(options.manifest),
      plugin: options.plugin,
    });
    for (const file of commandFiles) {
      await addManagedFile({
        builder: options.builder,
        plugin: options.plugin,
        file,
        harness: options.harness,
        root,
        targetPath: join(pluginRoot, "commands", file.relativePath),
        artifact: "command",
      });
    }
    return;
  }

  for (const file of commandFiles) {
    await addManagedFile({
      builder: options.builder,
      plugin: options.plugin,
      file,
      harness: options.harness,
      root,
      targetPath: join(root, options.harness.commandsDir!, file.relativePath),
      artifact: "command",
    });
  }
};

const getSharedSkillValidation = async (
  pluginPath: string,
): Promise<Map<string, { readonly valid: boolean; readonly reason?: string }>> => {
  const sharedSkillsDir = join(pluginPath, "skills");
  const validations = new Map<string, { readonly valid: boolean; readonly reason?: string }>();

  const { readdir } = await import("node:fs/promises");
  let entries: Array<{ readonly name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(sharedSkillsDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return validations;
    }
    throw error;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const validation = await validateSkill(join(sharedSkillsDir, entry.name), entry.name);
    validations.set(
      entry.name,
      validation.valid
        ? { valid: true }
        : { valid: false, reason: `Validation failed: ${validation.errors.join("; ")}` },
    );
  }

  return validations;
};

const getSelectedSkillValidation = async (
  pluginPath: string,
  harnessId: HarnessId,
  selectedFiles: ReadonlyArray<ArtifactSourceFile>,
): Promise<Map<string, { readonly valid: boolean; readonly reason?: string }>> => {
  const sharedValidation = await getSharedSkillValidation(pluginPath);
  const groupedFiles = new Map<string, ArtifactSourceFile[]>();

  for (const file of selectedFiles) {
    const [skillDirName, nestedPath] = file.relativePath.split("/", 2);
    if (!skillDirName || !nestedPath) continue;
    const group = groupedFiles.get(skillDirName) ?? [];
    group.push(file);
    groupedFiles.set(skillDirName, group);
  }

  const validations = new Map<string, { readonly valid: boolean; readonly reason?: string }>();
  for (const [skillDirName, files] of [...groupedFiles.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const selectedSkillMd = files.find((file) => file.relativePath === `${skillDirName}/SKILL.md`);
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
        },
      );
      continue;
    }

    const validation = await validateSkill(
      join(pluginPath, "harness", harnessId, "skills", skillDirName),
      skillDirName,
    );
    validations.set(
      skillDirName,
      validation.valid
        ? { valid: true }
        : { valid: false, reason: `Validation failed: ${validation.errors.join("; ")}` },
    );
  }
  return validations;
};

const addSkillsForHarness = async (options: {
  readonly builder: DesiredRootBuilder;
  readonly warnings: RefreshWarning[];
  readonly manifest: PluginManifest;
  readonly pluginPath: string;
  readonly plugin: string;
  readonly harness: HarnessConfig;
  readonly roots?: HarnessRootsEnv;
}): Promise<void> => {
  if (!shouldPlanFileRouterSkills(options.manifest, options.harness)) return;

  const selectedFiles = await collectArtifactSourceFiles(options.pluginPath, "skills", options.harness.id);
  if (selectedFiles.length === 0) return;

  const validatedSkills = await getSelectedSkillValidation(
    options.pluginPath,
    options.harness.id,
    selectedFiles,
  );
  const root = resolveGlobalHarnessRoot(options.harness, options.roots);
  const targetDir = join(root, options.harness.skillsDir!);

  for (const [skillDirName, validation] of [...validatedSkills.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (validation.valid) continue;
    options.warnings.push({
      harness: options.harness.id,
      targetPath: join(targetDir, skillDirName),
      reason: validation.reason ?? "Validation failed",
    });
  }

  for (const file of selectedFiles) {
    const [skillDirName, nestedPath] = file.relativePath.split("/", 2);
    if (skillDirName && nestedPath && validatedSkills.get(skillDirName)?.valid === false) {
      continue;
    }

    await addManagedFile({
      builder: options.builder,
      plugin: options.plugin,
      file,
      harness: options.harness,
      root,
      targetPath: join(targetDir, file.relativePath),
      artifact: "skill",
    });
  }
};

export const planPluginRefresh = async (options: RefreshOptions): Promise<PlannedRefresh> => {
  const pluginPath = expandPath(options.pluginPath);
  const manifest = await readManifest(pluginPath);
  const builder = new DesiredRootBuilder();
  const warnings: RefreshWarning[] = [];
  const plugin = fileRouterScopePlugin(manifest.name);

  for (const harnessId of options.harnesses) {
    const harness = getHarness(harnessId);
    builder.rootFor(harness.id, resolveGlobalHarnessRoot(harness, options.roots));
    if (options.projectPath) {
      builder.rootFor(harness.id, expandPath(options.projectPath));
      const projectHarnessRoot = resolveHarnessRoot(
        harness,
        "project",
        options.projectPath,
        options.roots,
      );
      if (projectHarnessRoot) builder.rootFor(harness.id, projectHarnessRoot);
    }

    await addRulesForHarness({
      builder,
      warnings,
      manifest,
      pluginPath,
      plugin,
      harness,
      ...(options.projectPath ? { projectPath: options.projectPath } : {}),
      roots: options.roots,
    });
    await addCommandsForHarness({ builder, manifest, pluginPath, plugin, harness, roots: options.roots });
    await addSkillsForHarness({
      builder,
      warnings,
      manifest,
      pluginPath,
      plugin,
      harness,
      roots: options.roots,
    });
  }

  return {
    pluginName: manifest.name,
    pluginVersion: manifest.version,
    desiredRoots: builder.values(),
    scopePlugin: plugin,
    warnings,
  };
};

export const refreshPlugin = async (options: RefreshOptions): Promise<RefreshResult> => {
  const planned = await planPluginRefresh(options);
  const reports: SyncReport[] = [];
  for (const desired of planned.desiredRoots) {
    reports.push(
      await syncDesiredRoot({
        prismHome: expandPath(options.prismHome),
        desired,
        scopePlugins: new Set([planned.scopePlugin]),
        dryRun: options.dryRun,
        overwrite: options.overwrite,
        ...(options.onOp ? { onOp: options.onOp } : {}),
      }),
    );
  }

  const failures = reports.flatMap((report) => report.failures);
  const blocked = reports.flatMap(blockedTargetErrors);
  const backups = reports.flatMap((report) => report.backups);
  return {
    ...planned,
    reports,
    failures,
    blocked,
    backups,
    converged: reports.every((report) => report.converged),
    success: failures.length === 0 && blocked.length === 0,
  };
};

export const refreshTargetedHarnesses = (options: {
  readonly manifest: PluginManifest;
  readonly harnesses: ReadonlyArray<HarnessId>;
}): HarnessId[] =>
  options.harnesses.filter((id) =>
    manifestTargetsArtifact(options.manifest, "rules", id) ||
    manifestTargetsArtifact(options.manifest, "commands", id) ||
    manifestTargetsArtifact(options.manifest, "skills", id),
  );

export const formatRefreshRootPlan = (reports: ReadonlyArray<SyncReport>): string => {
  const lines: string[] = [];
  for (const report of reports) {
    const counts = new Map<string, number>();
    for (const op of report.ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);
    const summary = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ");
    lines.push(`${report.harness} ${report.root}: ${summary || "converged"}`);
    for (const op of report.ops) {
      const reason =
        "reason" in op ? ` (${op.reason})` :
        op.kind === "blocked" ? ` (${op.hint})` :
        "";
      lines.push(`  ${op.kind.padEnd(13)} ${op.targetPath}${reason}`);
    }
  }
  return lines.join("\n");
};

export const refreshPlanJsonEnvelope = (result: RefreshResult): unknown => ({
  schema: "prism.plan.v1",
  plugin: {
    name: result.pluginName,
    ...(result.pluginVersion ? { version: result.pluginVersion } : {}),
  },
  converged: result.converged,
  success: result.success,
  roots: result.reports.map((report) => ({
    harness: report.harness,
    root: report.root,
    converged: report.converged,
    counts: report.ops.reduce<Record<string, number>>((acc, op) => {
      acc[op.kind] = (acc[op.kind] ?? 0) + 1;
      return acc;
    }, {}),
    operations: report.ops.map((op) => ({
      kind: op.kind,
      targetPath: op.targetPath,
      ...("reason" in op ? { reason: op.reason } : {}),
      ...(op.kind === "blocked" ? { hint: op.hint } : {}),
      ...(op.kind === "patch-regions"
        ? { changedRegions: op.changedRegions, removedRegions: op.removedRegions }
        : {}),
      ...(op.kind === "skip-regions" ? { regionKeys: op.regionKeys } : {}),
    })),
  })),
  warnings: result.warnings,
  failures: result.failures.map((failure) => ({
    kind: failure.op.kind,
    targetPath: failure.op.targetPath,
    message: failure.message,
  })),
  blocked: result.blocked.map((blocked) => ({
    targetPath: blocked.targetPath,
    message: blocked.message,
    hint: blocked.hint,
  })),
});
