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
    "gemini-cli",
    "amp-code",
    "cursor",
    "factory-droid",
  ],
  "claw-harness": ["openclaw", "hermes"],
} as const satisfies Record<TargetPresetId, readonly HarnessId[]>;

const COMPILE_SUPPORTED_HARNESSES = [
  "opencode",
  "claude-code",
  "gemini-cli",
  "codex-cli",
  "amp-code",
  "hermes",
] as const satisfies ReadonlyArray<HarnessId>;

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
  const errors: string[] = [];

  const checkMarkdownFrontmatter = async (
    filePath: string,
    artifact: PluginArtifactType,
    displayPath: string
  ): Promise<void> => {
    const raw = await readFile(filePath);
    if (!raw.startsWith("---")) {
      return;
    }

    const { data } = matter(raw);
    if (data && typeof data === "object" && !Array.isArray(data) && "targets" in data) {
      errors.push(
        `File-level install targets are not supported in ${displayPath}. Move install scope to plugin.json targets.${artifact}`
      );
    }
  };

  for (const artifact of ["rules", "commands", "agents"] as const) {
    const artifactRoot = join(pluginPath, artifact);
    const files = await listDirRecursive(artifactRoot);
    for (const relativePath of files) {
      if (!relativePath.endsWith(".md")) {
        continue;
      }

      await checkMarkdownFrontmatter(
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

    await checkMarkdownFrontmatter(
      join(skillsRoot, relativePath),
      "skills",
      `skills/${relativePath}`
    );
  }

  const harnessRoot = join(pluginPath, HARNESS_ROOT);
  const harnessFiles = await listDirRecursive(harnessRoot);
  for (const relativePath of harnessFiles) {
    const [harnessId, artifact, ...rest] = relativePath.split("/");
    if (!harnessId || !artifact || rest.length === 0 || !isPluginArtifactType(artifact)) {
      continue;
    }

    const isMarkdownArtifact =
      (artifact === "rules" || artifact === "commands" || artifact === "agents") &&
      relativePath.endsWith(".md");
    const isSkillEntryPoint = artifact === "skills" && relativePath.endsWith("SKILL.md");
    if (!isMarkdownArtifact && !isSkillEntryPoint) {
      continue;
    }

    await checkMarkdownFrontmatter(
      join(harnessRoot, relativePath),
      artifact,
      `${HARNESS_ROOT}/${relativePath}`
    );
  }

  return errors;
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
      return harness.rulesFile !== null;
    case "commands":
      return harness.supportsCommands && harness.commandsDir !== null;
    case "agents":
      return harness.supportsAgents && harness.agentsDir !== null;
    case "skills":
      return harness.supportsSkills && harness.skillsDir !== null;
  }
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

/**
 * Validate manifest structure
 */
async function validateManifest(
  manifest: unknown,
  pluginPath: string,
  pluginName?: string
): Promise<void> {
  const errors: string[] = [];
  const validTargetKeys = [...PLUGIN_ARTIFACT_TYPES, ...COMPILE_ARTIFACT_TYPES];
  const targetKeyList = validTargetKeys.join(", ");

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new PluginManifestError(pluginPath, "Invalid manifest: must be an object", [], {
      pluginName,
    });
  }

  const m = manifest as Record<string, unknown>;

  if (typeof m.name !== "string" || m.name.length === 0) {
    errors.push(`'name' is required`);
  }

  if (typeof m.version !== "string" || m.version.length === 0) {
    errors.push(`'version' is required`);
  }

  if (!("targets" in m)) {
    errors.push(
      `'targets' is required and must be an object keyed by artifact type (${targetKeyList})`
    );
  } else if (!m.targets || typeof m.targets !== "object" || Array.isArray(m.targets)) {
    errors.push(
      `'targets' must be an object keyed by artifact type (${targetKeyList})`
    );
  } else {
    const targets = m.targets as Record<string, unknown>;

    for (const key of Object.keys(targets)) {
      if (!validTargetKeys.includes(key as typeof validTargetKeys[number])) {
        errors.push(
          `Unknown targets key '${key}'. Expected one of: ${targetKeyList}`
        );
      }
    }

    for (const artifact of PLUGIN_ARTIFACT_TYPES) {
      const declaredTargets = targets[artifact];

      if (declaredTargets === undefined) {
        continue;
      }

      if (!Array.isArray(declaredTargets)) {
        errors.push(`targets.${artifact} must be an array of harness IDs and/or preset IDs`);
        continue;
      }

      if (declaredTargets.length === 0) {
        errors.push(`targets.${artifact} must not be empty`);
        continue;
      }

      for (const target of declaredTargets) {
        if (!isPluginTargetId(target)) {
          errors.push(
            `targets.${artifact} contains unknown target '${String(target)}'`
          );
        }
      }
    }

    for (const artifact of COMPILE_ARTIFACT_TYPES) {
      const declaredTargets = targets[artifact];

      if (declaredTargets === undefined) {
        continue;
      }

      if (!Array.isArray(declaredTargets)) {
        errors.push(`targets.${artifact} must be an array of harness IDs and/or preset IDs`);
        continue;
      }

      if (declaredTargets.length === 0) {
        errors.push(`targets.${artifact} must not be empty`);
        continue;
      }

      for (const target of declaredTargets) {
        if (!isPluginTargetId(target)) {
          errors.push(`targets.${artifact} contains unknown target '${String(target)}'`);
        }
      }

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
  }

  if (errors.length > 0) {
    throw new PluginManifestError(pluginPath, "Manifest validation failed", errors, {
      pluginName,
    });
  }

  const typedManifest = manifest as PluginManifest;
  const presentArtifacts = await getPresentArtifacts(pluginPath);
  errors.push(...await validateNoFileLevelInstallTargets(pluginPath));
  errors.push(...await validateNoSourceMarkdownAgents(pluginPath));
  errors.push(...await validateHarnessOverlays(pluginPath, typedManifest));

  for (const artifact of presentArtifacts) {
    const declaredTargets = typedManifest.targets[artifact];
    if (!declaredTargets || declaredTargets.length === 0) {
      errors.push(
        `Plugin contains ${artifact} artifacts, but plugin.json targets.${artifact} is missing or empty`
      );
    }
  }

  for (const artifact of PLUGIN_ARTIFACT_TYPES) {
    const declaredTargets = typedManifest.targets[artifact];
    if (!declaredTargets || declaredTargets.length === 0) {
      continue;
    }

    const unsupportedAgents = resolveManifestTargets(declaredTargets).filter((harnessId) => {
      if (artifact === "agents") {
        return !(COMPILE_SUPPORTED_HARNESSES as readonly HarnessId[]).includes(harnessId);
      }
      return !harnessSupportsArtifact(harnessId, artifact);
    });

    if (unsupportedAgents.length > 0) {
      const unsupportedList = unsupportedAgents
        .map((harnessId) => `${harnessId} (${getHarness(harnessId).name})`)
        .join(", ");
      errors.push(
        artifact === "agents"
          ? `targets.agents resolves to unsupported compile harnesses: ${unsupportedList}. Source agents must be authored as agents/*.agent.ts and can only target compile-supported harnesses.`
          : `targets.${artifact} resolves to unsupported harnesses for ${artifact}: ${unsupportedList}`
      );
    }
  }

  if (errors.length > 0) {
    throw new PluginManifestError(pluginPath, "Manifest validation failed", errors, {
      pluginName,
    });
  }
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

export function getManifestArtifactTargets(
  manifest: PluginManifest,
  artifact: PluginArtifactType
): HarnessId[] {
  return resolveManifestTargets(manifest.targets[artifact] ?? []);
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

  const compileKeys = ["agents", ...COMPILE_ARTIFACT_TYPES] as const;
  for (const key of compileKeys) {
    const targets = (manifest.targets as Record<string, unknown>)[key];
    if (!Array.isArray(targets) || targets.length === 0) continue;
    if (!harnessId) return true;
    const resolved = resolveManifestTargets(targets as PluginTargetId[]);
    if (resolved.includes(harnessId)) return true;
  }
  return false;
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
    "gemini-cli",
    "amp-code",
    "cursor",
    "factory-droid",
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
  const errors: string[] = [];
  const warnings: string[] = [];
  const expandedPath = expandPath(skillPath);
  const skillMdPath = join(expandedPath, "SKILL.md");

  // Check SKILL.md exists
  if (!(await exists(skillMdPath))) {
    return {
      valid: false,
      errors: ["SKILL.md not found"],
      warnings: [],
      skillPath: expandedPath,
    };
  }

  // Parse the file
  let frontmatter: Record<string, unknown>;
  let content: string;
  let lineCount: number;

  try {
    const raw = await readFile(skillMdPath);

    // Check frontmatter format
    if (!raw.startsWith("---")) {
      return {
        valid: false,
        errors: ["No YAML frontmatter found (file must start with ---)"],
        warnings: [],
        skillPath: expandedPath,
      };
    }

    const { data, content: parsedContent } = matter(raw);

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return {
        valid: false,
        errors: ["Frontmatter must be a YAML dictionary"],
        warnings: [],
        skillPath: expandedPath,
      };
    }

    frontmatter = data as Record<string, unknown>;
    content = parsedContent.trim();
    lineCount = content.split("\n").length;
  } catch (error) {
    return {
      valid: false,
      errors: [
        `Invalid YAML in frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      ],
      warnings: [],
      skillPath: expandedPath,
    };
  }

  // Validate frontmatter keys (whitelist)
  const keysResult = validateSkillFrontmatterKeys(frontmatter);
  if (!keysResult.valid && keysResult.error) {
    errors.push(keysResult.error);
  }

  // Validate required field: name
  if (!("name" in frontmatter)) {
    errors.push("Missing 'name' in frontmatter");
  } else {
    const nameResult = validateSkillName(frontmatter.name);
    if (!nameResult.valid && nameResult.error) {
      errors.push(nameResult.error);
    }

    // Check name matches directory name (if provided)
    if (
      skillDirName &&
      typeof frontmatter.name === "string" &&
      frontmatter.name !== skillDirName
    ) {
      warnings.push(
        `Skill name '${frontmatter.name}' does not match directory name '${skillDirName}'`
      );
    }
  }

  // Validate required field: description
  if (!("description" in frontmatter)) {
    errors.push("Missing 'description' in frontmatter");
  } else {
    const descResult = validateSkillDescription(frontmatter.description);
    if (!descResult.valid && descResult.error) {
      errors.push(descResult.error);
    }
  }

  // Validate optional fields
  const optionalResult = validateSkillOptionalFields(frontmatter);
  errors.push(...optionalResult.errors);
  warnings.push(...optionalResult.warnings);

  // Check body length (warning only)
  if (lineCount > SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES) {
    warnings.push(
      `SKILL.md body is ${lineCount} lines (recommended max: ${SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES}). Consider splitting into reference files.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    skillName: typeof frontmatter.name === "string" ? frontmatter.name : undefined,
    skillPath: expandedPath,
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
