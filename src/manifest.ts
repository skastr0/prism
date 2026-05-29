/**
 * Plugin manifest parsing and validation
 */

import { basename, join } from "node:path";
import matter from "gray-matter";
import { exists, expandPath, listDirRecursive, readFile, readJson } from "./fs.js";
import type {
  HarnessId,
  AgentValidationResult,
  PluginArtifactType,
  PluginManifest,
  PluginTargetId,
  SkillFrontmatter,
  SkillValidationResult,
  TargetPresetId,
  UnifiedFrontmatter,
} from "./types.js";
import {
  AGENT_VALIDATION,
  COMPILE_ARTIFACT_TYPES,
  PLUGIN_ARTIFACT_TYPES,
  SKILL_VALIDATION,
  TARGET_PRESET_IDS,
} from "./types.js";
import type { CompileArtifactType } from "./types.js";
import { getAllHarnessIds, getHarness, isValidHarnessId } from "./harnesses.js";

const MANIFEST_FILE = "plugin.json";
const HARNESS_ROOT = "harness";

const TARGET_PRESETS = {
  "coding-harness": [
    "claude-code",
    "opencode",
    "codex-cli",
    "antigravity-cli",
    "amp-code",
    "cursor",
    "factory-droid",
    "grok",
  ],
  "claw-harness": ["openclaw", "hermes"],
} as const satisfies Record<TargetPresetId, readonly HarnessId[]>;

const COMPILE_SUPPORTED_HARNESSES = [
  "opencode",
  "claude-code",
  "antigravity-cli",
  "codex-cli",
  "amp-code",
  "hermes",
  "grok",
  "factory-droid",
] as const satisfies ReadonlyArray<HarnessId>;

const COMPILE_MANAGED_PLUGIN_ARTIFACT_TARGETS: Partial<Record<PluginArtifactType, readonly HarnessId[]>> = {
  rules: ["antigravity-cli"],
};

const getCompileManagedPluginArtifactTargets = (
  artifact: PluginArtifactType,
): readonly HarnessId[] => COMPILE_MANAGED_PLUGIN_ARTIFACT_TARGETS[artifact] ?? [];

const manifestHasStructuredCompileTargets = (
  manifest: PluginManifest,
  harnessId?: HarnessId,
): boolean => {
  const compileKeys = ["agents", ...COMPILE_ARTIFACT_TYPES] as const;
  for (const key of compileKeys) {
    const targets = (manifest.targets as Record<string, unknown>)[key];
    if (!Array.isArray(targets) || targets.length === 0) continue;
    if (!harnessId) return true;
    const resolved = resolveManifestTargets(targets as PluginTargetId[]);
    if (resolved.includes(harnessId)) return true;
  }
  return false;
};

const manifestHasCompileManagedPluginArtifactTargets = (
  manifest: PluginManifest,
  harnessId?: HarnessId,
): boolean => {
  for (const artifact of PLUGIN_ARTIFACT_TYPES) {
    const compileManagedTargets = getCompileManagedPluginArtifactTargets(artifact);
    if (compileManagedTargets.length === 0) continue;

    const targets = manifest.targets[artifact];
    if (!targets || targets.length === 0) continue;
    const resolved = resolveManifestTargetsForArtifact(targets, artifact);
    if (!harnessId) {
      return resolved.some((target) => compileManagedTargets.includes(target));
    }
    if (compileManagedTargets.includes(harnessId) && resolved.includes(harnessId)) {
      return true;
    }
  }
  return false;
};

function isTargetPresetId(value: string): value is TargetPresetId {
  return TARGET_PRESET_IDS.includes(value as TargetPresetId);
}

function isPluginTargetId(value: unknown): value is PluginTargetId {
  return typeof value === "string" && (isValidHarnessId(value) || isTargetPresetId(value));
}

function formatManifestErrors(errors: string[]): string {
  return errors.map((error) => `- ${error}`).join("\n");
}

function getManifestPluginName(manifest: unknown): string | undefined {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return undefined;
  }

  const name = (manifest as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

export class PluginManifestError extends Error {
  readonly pluginPath: string;
  readonly manifestPath: string;
  readonly pluginLabel: string;
  readonly summary: string;
  readonly details: string[];

  constructor(
    pluginPath: string,
    summary: string,
    details: string[] = [],
    options: { pluginName?: string; cause?: unknown } = {}
  ) {
    const expandedPluginPath = expandPath(pluginPath);
    const manifestPath = join(expandedPluginPath, MANIFEST_FILE);
    const pluginLabel = options.pluginName || basename(expandedPluginPath);
    const detailBlock = details.length > 0 ? `:\n${formatManifestErrors(details)}` : "";

    super(
      `${summary} for plugin '${pluginLabel}' (${manifestPath})${detailBlock}`,
      options.cause === undefined ? undefined : { cause: options.cause }
    );

    this.name = "PluginManifestError";
    this.pluginPath = expandedPluginPath;
    this.manifestPath = manifestPath;
    this.pluginLabel = pluginLabel;
    this.summary = summary;
    this.details = details;
  }
}

function isPluginArtifactType(value: string): value is PluginArtifactType {
  return PLUGIN_ARTIFACT_TYPES.includes(value as PluginArtifactType);
}

function getHarnessOverlayPath(
  pluginPath: string,
  harnessId: HarnessId,
  artifact: PluginArtifactType
): string {
  return join(pluginPath, HARNESS_ROOT, harnessId, artifact);
}

export interface ArtifactSourceFile {
  relativePath: string;
  sourcePath: string;
  scope: "shared" | "harness";
}

export async function collectArtifactSourceFiles(
  pluginPath: string,
  artifact: PluginArtifactType,
  harnessId?: HarnessId
): Promise<ArtifactSourceFile[]> {
  const selectedFiles = new Map<string, ArtifactSourceFile>();
  const layers = [
    {
      rootPath: join(pluginPath, artifact),
      scope: "shared" as const,
    },
    ...(harnessId
      ? [{
          rootPath: getHarnessOverlayPath(pluginPath, harnessId, artifact),
          scope: "harness" as const,
        }]
      : []),
  ];

  for (const layer of layers) {
    const files = (await listDirRecursive(layer.rootPath)).sort((a, b) =>
      a.localeCompare(b)
    );

    for (const relativePath of files) {
      selectedFiles.set(relativePath, {
        relativePath,
        sourcePath: join(layer.rootPath, relativePath),
        scope: layer.scope,
      });
    }
  }

  return [...selectedFiles.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
}

async function validateHarnessOverlays(
  pluginPath: string,
  manifest: PluginManifest
): Promise<string[]> {
  const harnessRoot = join(pluginPath, HARNESS_ROOT);

  if (!(await exists(harnessRoot))) {
    return [];
  }

  const { readdir } = await import("node:fs/promises");
  const errors: string[] = [];
  const harnessEntries = await readdir(harnessRoot, { withFileTypes: true });

  for (const harnessEntry of harnessEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!harnessEntry.isDirectory()) {
      errors.push(
        `Harness overlay root must contain directories named after supported harness IDs: ${HARNESS_ROOT}/${harnessEntry.name}`
      );
      continue;
    }

    const harnessId = harnessEntry.name;
    const harnessPath = join(harnessRoot, harnessId);
    const artifactEntries = await readdir(harnessPath, { withFileTypes: true });

    for (const artifactEntry of artifactEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      const overlayPath = `${HARNESS_ROOT}/${harnessId}/${artifactEntry.name}`;

      if (!artifactEntry.isDirectory()) {
        errors.push(
          `Harness overlay '${overlayPath}' must be a directory for one of: ${PLUGIN_ARTIFACT_TYPES.join(", ")}`
        );
        continue;
      }

      if (!isValidHarnessId(harnessId)) {
        errors.push(
          `Unknown harness overlay id '${harnessId}' in ${overlayPath}. Expected one of: ${getAllHarnessIds().join(", ")}`
        );
        continue;
      }

      if (!isPluginArtifactType(artifactEntry.name)) {
        errors.push(
          `Unknown harness overlay artifact '${artifactEntry.name}' in ${overlayPath}. Expected one of: ${PLUGIN_ARTIFACT_TYPES.join(", ")}`
        );
        continue;
      }

      if (!harnessSupportsArtifact(harnessId, artifactEntry.name)) {
        errors.push(
          `Harness '${harnessId}' does not support ${artifactEntry.name} overlays (found ${overlayPath})`
        );
        continue;
      }

      const declaredTargets = manifest.targets[artifactEntry.name];
      if (
        declaredTargets &&
        declaredTargets.length > 0 &&
        !manifestTargetsArtifact(manifest, artifactEntry.name, harnessId)
      ) {
        errors.push(
          `Harness overlay '${overlayPath}' contradicts plugin.json targets.${artifactEntry.name}; include '${harnessId}' directly or via a preset`
        );
      }
    }
  }

  return errors;
}

async function pluginHasArtifactFiles(
  pluginPath: string,
  artifact: PluginArtifactType
): Promise<boolean> {
  if ((await listDirRecursive(join(pluginPath, artifact))).length > 0) {
    return true;
  }

  const harnessRoot = join(pluginPath, HARNESS_ROOT);
  if (!(await exists(harnessRoot))) {
    return false;
  }

  const { readdir } = await import("node:fs/promises");
  const harnessEntries = await readdir(harnessRoot, { withFileTypes: true });

  for (const harnessEntry of harnessEntries) {
    if (!harnessEntry.isDirectory()) {
      continue;
    }

    if ((await listDirRecursive(join(harnessRoot, harnessEntry.name, artifact))).length > 0) {
      return true;
    }
  }

  return false;
}

async function validateNoFileLevelInstallTargets(pluginPath: string): Promise<string[]> {
  return [
    ...await validateSharedFileLevelInstallTargets(pluginPath),
    ...await validateHarnessFileLevelInstallTargets(pluginPath),
  ];
}

async function validateSharedFileLevelInstallTargets(pluginPath: string): Promise<string[]> {
  const errors: string[] = [];
  for (const artifact of ["rules", "commands", "agents"] as const) {
    const artifactRoot = join(pluginPath, artifact);
    const files = await listDirRecursive(artifactRoot);
    for (const relativePath of files) {
      if (!relativePath.endsWith(".md")) {
        continue;
      }

      await pushFileLevelInstallTargetError(
        errors,
        join(artifactRoot, relativePath),
        artifact,
        `${artifact}/${relativePath}`
      );
    }
  }

  const skillsRoot = join(pluginPath, "skills");
  const skillFiles = await listDirRecursive(skillsRoot);
  for (const relativePath of skillFiles) {
    if (!relativePath.endsWith("SKILL.md")) {
      continue;
    }

    await pushFileLevelInstallTargetError(
      errors,
      join(skillsRoot, relativePath),
      "skills",
      `skills/${relativePath}`
    );
  }

  return errors;
}

async function validateHarnessFileLevelInstallTargets(pluginPath: string): Promise<string[]> {
  const errors: string[] = [];
  const harnessRoot = join(pluginPath, HARNESS_ROOT);
  const harnessFiles = await listDirRecursive(harnessRoot);
  for (const relativePath of harnessFiles) {
    const candidate = harnessInstallTargetCandidate(relativePath);
    if (!candidate) continue;
    await pushFileLevelInstallTargetError(
      errors,
      join(harnessRoot, relativePath),
      candidate.artifact,
      candidate.displayPath
    );
  }

  return errors;
}

async function pushFileLevelInstallTargetError(
  errors: string[],
  filePath: string,
  artifact: PluginArtifactType,
  displayPath: string
): Promise<void> {
  if (!(await hasFileLevelInstallTargets(filePath))) return;
  errors.push(
    `File-level install targets are not supported in ${displayPath}. Move install scope to plugin.json targets.${artifact}`
  );
}

async function hasFileLevelInstallTargets(filePath: string): Promise<boolean> {
  const raw = await readFile(filePath);
  if (!raw.startsWith("---")) return false;

  const { data } = matter(raw);
  return data !== null && typeof data === "object" && !Array.isArray(data) && "targets" in data;
}

function harnessInstallTargetCandidate(
  relativePath: string
): { artifact: PluginArtifactType; displayPath: string } | undefined {
  const [harnessId, artifact, ...rest] = relativePath.split("/");
  if (!harnessId || !artifact || rest.length === 0 || !isPluginArtifactType(artifact)) {
    return undefined;
  }
  if (!isFileLevelInstallTargetEntry(artifact, relativePath)) return undefined;
  return { artifact, displayPath: `${HARNESS_ROOT}/${relativePath}` };
}

function isFileLevelInstallTargetEntry(
  artifact: PluginArtifactType,
  relativePath: string
): boolean {
  if (artifact === "skills") return relativePath.endsWith("SKILL.md");
  return (
    (artifact === "rules" || artifact === "commands" || artifact === "agents") &&
    relativePath.endsWith(".md")
  );
}

async function validateNoSourceMarkdownAgents(pluginPath: string): Promise<string[]> {
  const errors: string[] = [];

  const checkLayer = async (rootPath: string, displayPrefix: string): Promise<void> => {
    const files = await listDirRecursive(rootPath);
    for (const relativePath of files) {
      if (!relativePath.endsWith(".md")) continue;
      errors.push(
        `Source markdown agents are not supported at ${displayPrefix}/${relativePath}. Author agents as agents/*.agent.ts and let harness lowerers generate markdown output.`
      );
    }
  };

  await checkLayer(join(pluginPath, "agents"), "agents");

  const harnessRoot = join(pluginPath, HARNESS_ROOT);
  const harnessFiles = await listDirRecursive(harnessRoot);
  for (const relativePath of harnessFiles) {
    const [harnessId, artifact, ...rest] = relativePath.split("/");
    if (!harnessId || artifact !== "agents" || rest.length === 0) continue;
    if (!relativePath.endsWith(".md")) continue;
    errors.push(
      `Source markdown agents are not supported at ${HARNESS_ROOT}/${relativePath}. Author agents as agents/*.agent.ts and let harness lowerers generate markdown output.`
    );
  }

  return errors;
}

async function getPresentArtifacts(pluginPath: string): Promise<PluginArtifactType[]> {
  const presentArtifacts: PluginArtifactType[] = [];

  for (const artifact of PLUGIN_ARTIFACT_TYPES) {
    if (await pluginHasArtifactFiles(pluginPath, artifact)) {
      presentArtifacts.push(artifact);
    }
  }

  return presentArtifacts;
}

function harnessSupportsArtifact(harnessId: HarnessId, artifact: PluginArtifactType): boolean {
  const harness = getHarness(harnessId);

  switch (artifact) {
    case "rules":
      return harness.rulesFile !== null || harness.rulesDir !== null;
    case "commands":
      return harness.supportsCommands && harness.commandsDir !== null;
    case "agents":
      return harness.supportsAgents && harness.agentsDir !== null;
    case "skills":
      return harness.supportsSkills && harness.skillsDir !== null;
  }
}

function targetSupportsPluginArtifact(harnessId: HarnessId, artifact: PluginArtifactType): boolean {
  if (artifact === "agents") {
    return (COMPILE_SUPPORTED_HARNESSES as readonly HarnessId[]).includes(harnessId);
  }

  return harnessSupportsArtifact(harnessId, artifact);
}

/**
 * Read and validate plugin manifest
 */
export async function readManifest(pluginPath: string): Promise<PluginManifest> {
  const expandedPluginPath = expandPath(pluginPath);
  const manifestPath = join(expandedPluginPath, MANIFEST_FILE);

  if (!(await exists(manifestPath))) {
    throw new PluginManifestError(expandedPluginPath, "Plugin manifest not found");
  }

  let manifest: PluginManifest;

  try {
    manifest = await readJson<PluginManifest>(manifestPath);
  } catch (error) {
    throw new PluginManifestError(
      expandedPluginPath,
      error instanceof SyntaxError
        ? "Plugin manifest is not valid JSON"
        : "Plugin manifest could not be read",
      [error instanceof Error ? error.message : String(error)],
      { cause: error }
    );
  }

  const pluginName = getManifestPluginName(manifest);
  await validateManifest(manifest, expandedPluginPath, pluginName);
  return manifest;
}

const manifestTargetKeys = (): string[] => [
  ...PLUGIN_ARTIFACT_TYPES,
  ...COMPILE_ARTIFACT_TYPES,
];

const throwManifestValidationErrors = (
  pluginPath: string,
  pluginName: string | undefined,
  errors: string[]
): void => {
  if (errors.length === 0) return;
  throw new PluginManifestError(pluginPath, "Manifest validation failed", errors, {
    pluginName,
  });
};

function validateManifestStructure(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const validTargetKeys = manifestTargetKeys();
  const targetKeyList = validTargetKeys.join(", ");

  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    errors.push(`'name' is required`);
  }

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    errors.push(`'version' is required`);
  }

  if (!("targets" in manifest)) {
    errors.push(
      `'targets' is required and must be an object keyed by artifact type (${targetKeyList})`
    );
    return errors;
  }

  if (!manifest.targets || typeof manifest.targets !== "object" || Array.isArray(manifest.targets)) {
    errors.push(
      `'targets' must be an object keyed by artifact type (${targetKeyList})`
    );
    return errors;
  }

  errors.push(...validateTargetDeclarations(manifest.targets as Record<string, unknown>));
  return errors;
}

function validateTargetDeclarations(targets: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const validTargetKeys = manifestTargetKeys();
  const targetKeyList = validTargetKeys.join(", ");

  for (const key of Object.keys(targets)) {
    if (!validTargetKeys.includes(key)) {
      errors.push(`Unknown targets key '${key}'. Expected one of: ${targetKeyList}`);
    }
  }

  for (const artifact of PLUGIN_ARTIFACT_TYPES) {
    validateDeclaredTargetList(targets, artifact, errors);
  }

  for (const artifact of COMPILE_ARTIFACT_TYPES) {
    const declaredTargets = validateDeclaredTargetList(targets, artifact, errors);
    if (declaredTargets) {
      validateCompileTargetSupport(artifact, declaredTargets, errors);
    }
  }

  return errors;
}

function validateDeclaredTargetList(
  targets: Record<string, unknown>,
  artifact: PluginArtifactType | CompileArtifactType,
  errors: string[]
): unknown[] | undefined {
  const declaredTargets = targets[artifact];
  if (declaredTargets === undefined) return undefined;

  if (!Array.isArray(declaredTargets)) {
    errors.push(`targets.${artifact} must be an array of harness IDs and/or preset IDs`);
    return undefined;
  }

  if (declaredTargets.length === 0) {
    errors.push(`targets.${artifact} must not be empty`);
    return undefined;
  }

  for (const target of declaredTargets) {
    if (!isPluginTargetId(target)) {
      errors.push(`targets.${artifact} contains unknown target '${String(target)}'`);
    }
  }

  return declaredTargets;
}

function validateCompileTargetSupport(
  artifact: CompileArtifactType,
  declaredTargets: unknown[],
  errors: string[]
): void {
  const unsupportedCompileTargets = resolveManifestTargets(
    declaredTargets as PluginTargetId[]
  ).filter(
    (harnessId) =>
      !(COMPILE_SUPPORTED_HARNESSES as readonly HarnessId[]).includes(harnessId),
  );

  if (unsupportedCompileTargets.length > 0) {
    errors.push(
      `targets.${artifact} resolves to unsupported compile harnesses: ${unsupportedCompileTargets.join(", ")}`
    );
  }
}

async function validateManifestLayout(
  pluginPath: string,
  typedManifest: PluginManifest
): Promise<string[]> {
  const errors: string[] = [];
  const presentArtifacts = await getPresentArtifacts(pluginPath);
  errors.push(...await validateNoFileLevelInstallTargets(pluginPath));
  errors.push(...await validateNoSourceMarkdownAgents(pluginPath));
  errors.push(...await validateHarnessOverlays(pluginPath, typedManifest));
  errors.push(...validatePresentArtifactTargets(typedManifest, presentArtifacts));
  errors.push(...validatePluginArtifactTargetSupport(typedManifest));
  return errors;
}

function validatePresentArtifactTargets(
  manifest: PluginManifest,
  presentArtifacts: PluginArtifactType[]
): string[] {
  const errors: string[] = [];
  for (const artifact of presentArtifacts) {
    const declaredTargets = manifest.targets[artifact];
    if (!declaredTargets || declaredTargets.length === 0) {
      errors.push(
        `Plugin contains ${artifact} artifacts, but plugin.json targets.${artifact} is missing or empty`
      );
    }
  }
  return errors;
}

function validatePluginArtifactTargetSupport(manifest: PluginManifest): string[] {
  const errors: string[] = [];
  for (const artifact of PLUGIN_ARTIFACT_TYPES) {
    const declaredTargets = manifest.targets[artifact];
    if (!declaredTargets || declaredTargets.length === 0) {
      continue;
    }

    const unsupportedTargets = declaredTargets
      .filter((target): target is HarnessId => !isTargetPresetId(target))
      .filter((harnessId) => !targetSupportsPluginArtifact(harnessId, artifact));

    if (unsupportedTargets.length > 0) {
      const unsupportedList = unsupportedTargets
        .map((harnessId) => `${harnessId} (${getHarness(harnessId).name})`)
        .join(", ");
      errors.push(
        artifact === "agents"
          ? `targets.agents resolves to unsupported compile harnesses: ${unsupportedList}. Source agents must be authored as agents/*.agent.ts and can only target compile-supported harnesses.`
          : `targets.${artifact} resolves to unsupported harnesses for ${artifact}: ${unsupportedList}`
      );
    }
  }
  return errors;
}

/**
 * Validate manifest structure
 */
async function validateManifest(
  manifest: unknown,
  pluginPath: string,
  pluginName?: string
): Promise<void> {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new PluginManifestError(pluginPath, "Invalid manifest: must be an object", [], {
      pluginName,
    });
  }

  const structuralErrors = validateManifestStructure(manifest as Record<string, unknown>);
  throwManifestValidationErrors(pluginPath, pluginName, structuralErrors);

  const layoutErrors = await validateManifestLayout(pluginPath, manifest as PluginManifest);
  throwManifestValidationErrors(pluginPath, pluginName, layoutErrors);
}

export function resolveManifestTargets(targets: readonly PluginTargetId[]): HarnessId[] {
  const resolvedTargets = new Set<HarnessId>();

  for (const target of targets) {
    if (isTargetPresetId(target)) {
      for (const harnessId of TARGET_PRESETS[target]) {
        resolvedTargets.add(harnessId);
      }
      continue;
    }

    resolvedTargets.add(target);
  }

  return [...resolvedTargets];
}

export function resolveManifestTargetsForArtifact(
  targets: readonly PluginTargetId[],
  artifact: PluginArtifactType
): HarnessId[] {
  const resolvedTargets = new Set<HarnessId>();

  for (const target of targets) {
    if (isTargetPresetId(target)) {
      for (const harnessId of TARGET_PRESETS[target]) {
        if (targetSupportsPluginArtifact(harnessId, artifact)) {
          resolvedTargets.add(harnessId);
        }
      }
      continue;
    }

    resolvedTargets.add(target);
  }

  return [...resolvedTargets];
}

export function getManifestArtifactTargets(
  manifest: PluginManifest,
  artifact: PluginArtifactType
): HarnessId[] {
  return resolveManifestTargetsForArtifact(manifest.targets[artifact] ?? [], artifact);
}

/**
 * Check if manifest targets a specific harness for any artifact
 */
export function manifestTargetsHarness(
  manifest: PluginManifest,
  harnessId: HarnessId
): boolean {
  return (
    PLUGIN_ARTIFACT_TYPES.some((artifact) =>
      getManifestArtifactTargets(manifest, artifact).includes(harnessId)
    ) || manifestHasCompileTargets(manifest, harnessId)
  );
}

/**
 * Check if manifest targets a specific harness for one artifact type
 */
export function manifestTargetsArtifact(
  manifest: PluginManifest,
  artifact: PluginArtifactType,
  harnessId: HarnessId
): boolean {
  return getManifestArtifactTargets(manifest, artifact).includes(harnessId);
}

export function manifestHasCompileTargets(
  manifest: PluginManifest,
  harnessId?: HarnessId
): boolean {
  if (
    harnessId &&
    !(COMPILE_SUPPORTED_HARNESSES as readonly HarnessId[]).includes(harnessId)
  ) {
    return false;
  }

  return (
    manifestHasStructuredCompileTargets(manifest, harnessId) ||
    manifestHasCompileManagedPluginArtifactTargets(manifest, harnessId)
  );
}

export function formatManifestTargets(manifest: PluginManifest): string {
  const targetSummary = [...PLUGIN_ARTIFACT_TYPES, ...COMPILE_ARTIFACT_TYPES].flatMap(
    (artifact) => {
      const targets = manifest.targets[artifact];
      return targets && targets.length > 0
        ? [`${artifact}=[${targets.join(", ")}]`]
        : [];
    }
  );

  return targetSummary.length > 0 ? targetSummary.join("; ") : "(no artifact targets)";
}

/**
 * Parse markdown file with frontmatter
 */
export async function parseMarkdownFile(
  filePath: string
): Promise<{ frontmatter: UnifiedFrontmatter; content: string }> {
  const raw = await readFile(filePath);
  const { data, content } = matter(raw);
  return {
    frontmatter: data as UnifiedFrontmatter,
    content: content.trim(),
  };
}

/**
 * Extract harness-specific frontmatter, merging with base frontmatter
 */
export function getHarnessFrontmatter(
  frontmatter: UnifiedFrontmatter,
  harnessId: HarnessId
): Record<string, unknown> {
  const base = frontmatter as Record<string, unknown>;

  // Remove all harness-specific keys from base
  const harnessKeys: HarnessId[] = [
    "claude-code",
    "opencode",
    "openclaw",
    "hermes",
    "codex-cli",
    "antigravity-cli",
    "amp-code",
    "cursor",
    "factory-droid",
    "grok",
  ];

  const cleanBase: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!harnessKeys.includes(key as HarnessId)) {
      cleanBase[key] = value;
    }
  }

  // Merge with harness-specific overrides
  const harnessSpecific = frontmatter[harnessId] ?? {};
  return { ...cleanBase, ...harnessSpecific };
}

/**
 * Serialize frontmatter back to YAML format
 */
export function serializeFrontmatter(
  frontmatter: Record<string, unknown>
): string {
  if (Object.keys(frontmatter).length === 0) {
    return "";
  }

  const lines: string[] = ["---"];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;

    if (typeof value === "string") {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === "boolean" || typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (value.every((v) => typeof v === "string")) {
        lines.push(`${key}: [${value.join(", ")}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    } else if (typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) {
        lines.push(`  ${k}: ${v}`);
      }
    }
  }

  lines.push("---");
  return lines.join("\n");
}

/**
 * Reconstruct markdown file with new frontmatter
 */
export function reconstructMarkdown(
  frontmatter: Record<string, unknown>,
  content: string
): string {
  const fm = serializeFrontmatter(frontmatter);
  if (fm.length === 0) {
    return content;
  }
  return `${fm}\n\n${content}`;
}

// =============================================================================
// Skill Validation Functions
// =============================================================================

/**
 * Validate a skill name according to Anthropic's spec
 */
export function validateSkillName(name: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof name !== "string") {
    return {
      valid: false,
      error: `Name must be a string, got ${typeof name}`,
    };
  }

  const trimmed = name.trim();

  if (!trimmed) {
    return { valid: false, error: "Name cannot be empty" };
  }

  if (!SKILL_VALIDATION.NAME_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: `Name '${trimmed}' should be kebab-case (lowercase letters, digits, and hyphens only)`,
    };
  }

  if (
    trimmed.startsWith("-") ||
    trimmed.endsWith("-") ||
    trimmed.includes("--")
  ) {
    return {
      valid: false,
      error: `Name '${trimmed}' cannot start/end with hyphen or contain consecutive hyphens`,
    };
  }

  if (trimmed.length > SKILL_VALIDATION.NAME_MAX_LENGTH) {
    return {
      valid: false,
      error: `Name is too long (${trimmed.length} characters). Maximum is ${SKILL_VALIDATION.NAME_MAX_LENGTH} characters.`,
    };
  }

  return { valid: true };
}

/**
 * Validate a skill description according to Anthropic's spec
 */
export function validateSkillDescription(description: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof description !== "string") {
    return {
      valid: false,
      error: `Description must be a string, got ${typeof description}`,
    };
  }

  const trimmed = description.trim();

  if (!trimmed) {
    return { valid: false, error: "Description cannot be empty" };
  }

  if (trimmed.includes("<") || trimmed.includes(">")) {
    return {
      valid: false,
      error: "Description cannot contain angle brackets (< or >)",
    };
  }

  if (trimmed.length > SKILL_VALIDATION.DESCRIPTION_MAX_LENGTH) {
    return {
      valid: false,
      error: `Description is too long (${trimmed.length} characters). Maximum is ${SKILL_VALIDATION.DESCRIPTION_MAX_LENGTH} characters.`,
    };
  }

  return { valid: true };
}

/**
 * Validate skill frontmatter keys (whitelist check)
 */
export function validateSkillFrontmatterKeys(
  frontmatter: Record<string, unknown>
): { valid: boolean; error?: string } {
  const unexpectedKeys = Object.keys(frontmatter).filter(
    (key) => !SKILL_VALIDATION.ALLOWED_FRONTMATTER_KEYS.has(key)
  );

  if (unexpectedKeys.length > 0) {
    const allowed = [...SKILL_VALIDATION.ALLOWED_FRONTMATTER_KEYS]
      .sort()
      .join(", ");
    return {
      valid: false,
      error: `Unexpected key(s) in SKILL.md frontmatter: ${unexpectedKeys.sort().join(", ")}. Allowed properties are: ${allowed}`,
    };
  }

  return { valid: true };
}

/**
 * Validate optional skill fields (allowed-tools, metadata, license, compatibility)
 */
export function validateSkillOptionalFields(
  frontmatter: Record<string, unknown>
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (frontmatter.compatibility !== undefined) {
    const compatibility = frontmatter.compatibility;
    if (typeof compatibility !== "string") {
      errors.push(
        `'compatibility' must be a string, got ${typeof compatibility}`
      );
    } else if (
      compatibility.trim().length > SKILL_VALIDATION.COMPATIBILITY_MAX_LENGTH
    ) {
      errors.push(
        `Compatibility is too long (${compatibility.trim().length} characters). Maximum is ${SKILL_VALIDATION.COMPATIBILITY_MAX_LENGTH} characters.`
      );
    }
  }

  // Validate allowed-tools if present
  if (frontmatter["allowed-tools"] !== undefined) {
    const tools = frontmatter["allowed-tools"];
    if (!Array.isArray(tools)) {
      errors.push(
        `'allowed-tools' must be an array, got ${typeof tools}`
      );
    } else if (!tools.every((t) => typeof t === "string")) {
      errors.push("'allowed-tools' must be an array of strings");
    }
  }

  // Validate metadata if present
  if (frontmatter.metadata !== undefined) {
    const metadata = frontmatter.metadata;
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      errors.push("'metadata' must be an object");
    } else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== "string") {
          warnings.push(
            `metadata.${key} should be a string, got ${typeof value}`
          );
        }
      }
    }
  }

  // Validate license if present
  if (
    frontmatter.license !== undefined &&
    typeof frontmatter.license !== "string"
  ) {
    errors.push(`'license' must be a string, got ${typeof frontmatter.license}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Parse and validate a SKILL.md file
 */
export async function parseSkillFile(
  filePath: string
): Promise<{
  frontmatter: SkillFrontmatter;
  content: string;
  lineCount: number;
}> {
  const raw = await readFile(filePath);
  const { data, content } = matter(raw);
  const lineCount = content.split("\n").length;

  return {
    frontmatter: data as SkillFrontmatter,
    content: content.trim(),
    lineCount,
  };
}

/**
 * Comprehensive skill validation
 */
export async function validateSkill(
  skillPath: string,
  skillDirName?: string
): Promise<SkillValidationResult> {
  const expandedPath = expandPath(skillPath);
  const skillMdPath = join(expandedPath, "SKILL.md");

  const parsed = await loadSkillValidationSource(skillMdPath, expandedPath);
  if ("result" in parsed) return parsed.result;

  const diagnostics = collectSkillValidationDiagnostics(
    parsed.frontmatter,
    parsed.lineCount,
    skillDirName,
  );

  return buildSkillValidationResult(expandedPath, parsed.frontmatter, diagnostics);
}

type ParsedSkillValidationSource = {
  readonly frontmatter: Record<string, unknown>;
  readonly lineCount: number;
};

type SkillValidationSourceLoadResult =
  | ParsedSkillValidationSource
  | { readonly result: SkillValidationResult };

type SkillValidationDiagnostics = {
  readonly errors: string[];
  readonly warnings: string[];
};

const failedSkillValidation = (
  skillPath: string,
  errors: string[],
): SkillValidationResult => ({
  valid: false,
  errors,
  warnings: [],
  skillPath,
});

async function loadSkillValidationSource(
  skillMdPath: string,
  expandedPath: string,
): Promise<SkillValidationSourceLoadResult> {
  if (!(await exists(skillMdPath))) {
    return { result: failedSkillValidation(expandedPath, ["SKILL.md not found"]) };
  }

  try {
    return parseSkillValidationSource(await readFile(skillMdPath), expandedPath);
  } catch (error) {
    return {
      result: failedSkillValidation(expandedPath, [
        `Invalid YAML in frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      ]),
    };
  }
}

function parseSkillValidationSource(
  raw: string,
  expandedPath: string,
): SkillValidationSourceLoadResult {
  if (!raw.startsWith("---")) {
    return {
      result: failedSkillValidation(expandedPath, [
        "No YAML frontmatter found (file must start with ---)",
      ]),
    };
  }

  const { data, content: parsedContent } = matter(raw);

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      result: failedSkillValidation(expandedPath, [
        "Frontmatter must be a YAML dictionary",
      ]),
    };
  }

  const content = parsedContent.trim();
  return {
    frontmatter: data as Record<string, unknown>,
    lineCount: content.split("\n").length,
  };
}

function collectSkillValidationDiagnostics(
  frontmatter: Record<string, unknown>,
  lineCount: number,
  skillDirName?: string,
): SkillValidationDiagnostics {
  const errors: string[] = [];
  const warnings: string[] = [];

  const keysResult = validateSkillFrontmatterKeys(frontmatter);
  if (!keysResult.valid && keysResult.error) {
    errors.push(keysResult.error);
  }

  validateSkillRequiredFields(frontmatter, skillDirName, errors, warnings);

  const optionalResult = validateSkillOptionalFields(frontmatter);
  errors.push(...optionalResult.errors);
  warnings.push(...optionalResult.warnings);

  addSkillBodyLengthWarning(lineCount, warnings);

  return { errors, warnings };
}

function validateSkillRequiredFields(
  frontmatter: Record<string, unknown>,
  skillDirName: string | undefined,
  errors: string[],
  warnings: string[],
): void {
  validateSkillRequiredName(frontmatter, skillDirName, errors, warnings);
  validateSkillRequiredDescription(frontmatter, errors);
}

function validateSkillRequiredName(
  frontmatter: Record<string, unknown>,
  skillDirName: string | undefined,
  errors: string[],
  warnings: string[],
): void {
  if (!("name" in frontmatter)) {
    errors.push("Missing 'name' in frontmatter");
    return;
  }

  const nameResult = validateSkillName(frontmatter.name);
  if (!nameResult.valid && nameResult.error) {
    errors.push(nameResult.error);
  }

  if (
    skillDirName &&
    typeof frontmatter.name === "string" &&
    frontmatter.name !== skillDirName
  ) {
    warnings.push(
      `Skill name '${frontmatter.name}' does not match directory name '${skillDirName}'`,
    );
  }
}

function validateSkillRequiredDescription(
  frontmatter: Record<string, unknown>,
  errors: string[],
): void {
  if (!("description" in frontmatter)) {
    errors.push("Missing 'description' in frontmatter");
    return;
  }

  const descResult = validateSkillDescription(frontmatter.description);
  if (!descResult.valid && descResult.error) {
    errors.push(descResult.error);
  }
}

function addSkillBodyLengthWarning(lineCount: number, warnings: string[]): void {
  if (lineCount > SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES) {
    warnings.push(
      `SKILL.md body is ${lineCount} lines (recommended max: ${SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES}). Consider splitting into reference files.`,
    );
  }
}

function buildSkillValidationResult(
  skillPath: string,
  frontmatter: Record<string, unknown>,
  diagnostics: SkillValidationDiagnostics,
): SkillValidationResult {
  return {
    valid: diagnostics.errors.length === 0,
    errors: diagnostics.errors,
    warnings: diagnostics.warnings,
    skillName: typeof frontmatter.name === "string" ? frontmatter.name : undefined,
    skillPath,
  };
}

/**
 * Validate all skills in a plugin
 */
export async function validatePluginSkills(
  pluginPath: string
): Promise<SkillValidationResult[]> {
  const results: SkillValidationResult[] = [];
  const skillsDir = join(expandPath(pluginPath), "skills");

  if (!(await exists(skillsDir))) {
    return results;
  }

  // Get all subdirectories in skills/
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillPath = join(skillsDir, entry.name);
      const result = await validateSkill(skillPath, entry.name);
      results.push(result);
    }
  }

  return results;
}

// =============================================================================
// Agent Validation Functions
// =============================================================================

/**
 * Validate an agent description
 */
export function validateAgentDescription(description: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof description !== "string") {
    return {
      valid: false,
      error: `Description must be a string, got ${typeof description}`,
    };
  }

  const trimmed = description.trim();

  if (!trimmed) {
    return { valid: false, error: "Description cannot be empty" };
  }

  if (trimmed.length > AGENT_VALIDATION.DESCRIPTION_MAX_LENGTH) {
    return {
      valid: false,
      error: `Description is too long (${trimmed.length} characters). Maximum is ${AGENT_VALIDATION.DESCRIPTION_MAX_LENGTH} characters.`,
    };
  }

  return { valid: true };
}

/**
 * Validate an agent definition file
 */
export async function validateAgent(
  agentPath: string
): Promise<AgentValidationResult> {
  const expandedPath = expandPath(agentPath);
  const agentName = agentPath.split("/").pop()?.replace(/\.md$/, "");

  if (!(await exists(expandedPath))) {
    return {
      valid: false,
      errors: ["Agent file not found"],
      warnings: [],
      agentPath: expandedPath,
    };
  }

  return {
    valid: false,
    errors: [
      "Source markdown agents are not supported. Author agents as agents/*.agent.ts and let harness lowerers generate markdown output.",
    ],
    warnings: [],
    agentName,
    agentPath: expandedPath,
  };
}

/**
 * Validate all agents in a plugin
 */
export async function validatePluginAgents(
  pluginPath: string
): Promise<AgentValidationResult[]> {
  const results: AgentValidationResult[] = [];
  const agentsDir = join(expandPath(pluginPath), "agents");

  if (!(await exists(agentsDir))) {
    return results;
  }

  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(agentsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const agentPath = join(agentsDir, entry.name);
      const result = await validateAgent(agentPath);
      results.push(result);
    }
  }

  return results;
}
