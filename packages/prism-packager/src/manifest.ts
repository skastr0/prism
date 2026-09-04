/**
 * Plugin manifest parsing and validation
 */

import { join } from "node:path";
import matter from "gray-matter";
import {
  exists,
  expandPath,
  listDirRecursive,
  readFile,
  readJson,
  realPathContainedBy,
} from "./fs.js";
import type {
  HarnessId,
  AgentValidationResult,
  PluginArtifactType,
  PluginManifest,
  PluginTargetId,
  AnyArtifactType,
  SkillFrontmatter,
  SkillValidationResult,
  UnifiedFrontmatter,
} from "./types.js";
import {
  AGENT_VALIDATION,
  COMPILE_ARTIFACT_TYPES,
  PLUGIN_ARTIFACT_TYPES,
  SKILL_VALIDATION,
} from "./types.js";
import type { CompileArtifactType } from "./types.js";
import { getAllHarnessIds, isValidHarnessId } from "./harnesses.js";
import { PluginManifestError } from "./errors.js";
import {
  getCompileManagedPluginArtifactTargets,
  isPluginTargetId,
  resolveManifestTargets as resolveSourceTargets,
  resolveManifestTargetsForSourceNoun,
  sourceSelectionFromManifestTargets,
  targetSupportsSourceNoun,
  validateSourceTargetSupport as validateSourceTargetSupportSelection,
} from "./source-selection.js";

const MANIFEST_FILE = "plugin.json";
const HARNESS_ROOT = "harness";

const manifestHasStructuredCompileTargets = (
  manifest: PluginManifest,
  harnessId?: HarnessId,
): boolean => {
  const selection = sourceSelectionFromManifestTargets(manifest.targets, {
    runtime: manifest.runtime,
  });
  const compileKeys = ["agents", ...COMPILE_ARTIFACT_TYPES] as const;
  for (const key of compileKeys) {
    const resolved = selection.entries.find((entry) => entry.noun === key)?.harnesses ?? [];
    if (harnessId === undefined) {
      if (resolved.length > 0) return true;
      continue;
    }
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

function getManifestPluginName(manifest: unknown): string | undefined {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return undefined;
  }

  const name = (manifest as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
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

interface ScanRootInspection {
  readonly exists: boolean;
  readonly error?: string;
}

function artifactRootDisplayPath(
  artifact: PluginArtifactType,
  scope: "shared" | "harness",
  harnessId: HarnessId | undefined,
): string {
  if (scope === "harness" && harnessId) {
    return `${HARNESS_ROOT}/${harnessId}/${artifact}`;
  }
  return artifact;
}

async function inspectContainedScanRoot(input: {
  readonly pluginPath: string;
  readonly rootPath: string;
  readonly displayRoot: string;
  readonly rootKind: string;
}): Promise<ScanRootInspection> {
  const { lstat } = await import("node:fs/promises");
  let stats: Awaited<ReturnType<typeof lstat>>;

  try {
    stats = await lstat(input.rootPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    return {
      exists: true,
      error: `${input.rootKind} ${input.displayRoot} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (stats.isSymbolicLink()) {
    try {
      const realSourcePath = await realPathContainedBy(input.pluginPath, input.rootPath);
      if (realSourcePath) return { exists: true };
      return {
        exists: true,
        error: `Symlinked ${input.rootKind} ${input.displayRoot} resolves outside plugin root`,
      };
    } catch (error) {
      return {
        exists: true,
        error: `Symlinked ${input.rootKind} ${input.displayRoot} could not be resolved inside plugin root: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { exists: true };
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
    const rootInspection = await inspectContainedScanRoot({
      pluginPath,
      rootPath: layer.rootPath,
      displayRoot: artifactRootDisplayPath(artifact, layer.scope, harnessId),
      rootKind: "artifact root",
    });
    if (!rootInspection.exists) continue;
    if (rootInspection.error) {
      throw PluginManifestError.forPlugin(pluginPath, "Artifact source escaped plugin root", [
        rootInspection.error,
      ]);
    }

    const files = (await listDirRecursive(layer.rootPath)).sort((a, b) =>
      a.localeCompare(b)
    );

    for (const relativePath of files) {
      const sourcePath = join(layer.rootPath, relativePath);
      const realSourcePath = await realPathContainedBy(pluginPath, sourcePath);
      if (!realSourcePath) {
        throw PluginManifestError.forPlugin(pluginPath, "Artifact source escaped plugin root", [
          `Symlinked artifact file ${artifactSourceDisplayPath(artifact, layer.scope, harnessId, relativePath)} resolves outside plugin root`,
        ]);
      }
      const { lstat } = await import("node:fs/promises");
      const sourceStats = await lstat(sourcePath);
      selectedFiles.set(relativePath, {
        relativePath,
        sourcePath: sourceStats.isSymbolicLink() ? realSourcePath : sourcePath,
        scope: layer.scope,
      });
    }
  }

  return [...selectedFiles.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
}

function artifactSourceDisplayPath(
  artifact: PluginArtifactType,
  scope: "shared" | "harness",
  harnessId: HarnessId | undefined,
  relativePath: string,
): string {
  if (scope === "harness" && harnessId) {
    return `${HARNESS_ROOT}/${harnessId}/${artifact}/${relativePath}`;
  }
  return `${artifact}/${relativePath}`;
}

async function collectArtifactSymlinkContainmentErrors(pluginPath: string): Promise<string[]> {
  const errors: string[] = [];

  for (const artifact of PLUGIN_ARTIFACT_TYPES) {
    await pushSymlinkContainmentErrors({
      errors,
      pluginPath,
      rootPath: join(pluginPath, artifact),
      displayRoot: artifact,
      rootKind: "artifact root",
    });
  }

  const harnessRoot = join(pluginPath, HARNESS_ROOT);
  const harnessRootInspection = await inspectContainedScanRoot({
    pluginPath,
    rootPath: harnessRoot,
    displayRoot: HARNESS_ROOT,
    rootKind: "harness root",
  });
  if (!harnessRootInspection.exists) return errors;
  if (harnessRootInspection.error) {
    errors.push(harnessRootInspection.error);
    return errors;
  }

  const { readdir } = await import("node:fs/promises");
  const harnessEntries = await readdir(harnessRoot, { withFileTypes: true });
  for (const harnessEntry of harnessEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!harnessEntry.isDirectory() && !harnessEntry.isSymbolicLink()) continue;
    const harnessPath = join(harnessRoot, harnessEntry.name);
    const harnessInspection = await inspectContainedScanRoot({
      pluginPath,
      rootPath: harnessPath,
      displayRoot: `${HARNESS_ROOT}/${harnessEntry.name}`,
      rootKind: "harness overlay root",
    });
    if (!harnessInspection.exists) continue;
    if (harnessInspection.error) {
      errors.push(harnessInspection.error);
      continue;
    }

    for (const artifact of PLUGIN_ARTIFACT_TYPES) {
      await pushSymlinkContainmentErrors({
        errors,
        pluginPath,
        rootPath: join(harnessPath, artifact),
        displayRoot: `${HARNESS_ROOT}/${harnessEntry.name}/${artifact}`,
        rootKind: "artifact root",
      });
    }
  }

  return errors;
}

async function pushSymlinkContainmentErrors(input: {
  readonly errors: string[];
  readonly pluginPath: string;
  readonly rootPath: string;
  readonly displayRoot: string;
  readonly rootKind: string;
}): Promise<void> {
  const rootInspection = await inspectContainedScanRoot({
    pluginPath: input.pluginPath,
    rootPath: input.rootPath,
    displayRoot: input.displayRoot,
    rootKind: input.rootKind,
  });
  if (!rootInspection.exists) return;
  if (rootInspection.error) {
    input.errors.push(rootInspection.error);
    return;
  }

  const { lstat } = await import("node:fs/promises");
  const files = await listDirRecursive(input.rootPath);
  for (const relativePath of files) {
    const sourcePath = join(input.rootPath, relativePath);
    let isSymlink = false;
    try {
      isSymlink = (await lstat(sourcePath)).isSymbolicLink();
    } catch (error) {
      input.errors.push(
        `Artifact file ${input.displayRoot}/${relativePath} could not be inspected: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }

    try {
      const realSourcePath = await realPathContainedBy(input.pluginPath, sourcePath);
      if (realSourcePath) continue;
      input.errors.push(
        `${isSymlink ? "Symlinked artifact file" : "Artifact file"} ${input.displayRoot}/${relativePath} resolves outside plugin root`
      );
    } catch (error) {
      input.errors.push(
        `Symlinked artifact file ${input.displayRoot}/${relativePath} could not be resolved inside plugin root: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
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

      if (!targetSupportsSourceNoun(harnessId, artifactEntry.name)) {
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

/**
 * Read and validate plugin manifest
 */
export async function readManifest(pluginPath: string): Promise<PluginManifest> {
  const expandedPluginPath = expandPath(pluginPath);
  const manifestPath = join(expandedPluginPath, MANIFEST_FILE);

  if (!(await exists(manifestPath))) {
    throw PluginManifestError.forPlugin(expandedPluginPath, "Plugin manifest not found");
  }

  let manifest: PluginManifest;

  try {
    manifest = await readJson<PluginManifest>(manifestPath);
  } catch (error) {
    throw PluginManifestError.forPlugin(
      expandedPluginPath,
      error instanceof SyntaxError
        ? "Plugin manifest is not valid JSON"
        : "Plugin manifest could not be read",
      [error instanceof Error ? error.message : String(error)],
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
  throw PluginManifestError.forPlugin(pluginPath, "Manifest validation failed", errors, {
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
  if ("inlineSkills" in manifest) {
    errors.push(
      "'inlineSkills' is not supported. Remove the 'inlineSkills' key from plugin.json; skills install via targets.skills, they are not dumped into harness rules files.",
    );
  }
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
    const declaredTargets = validateDeclaredTargetList(targets, artifact, errors);
    if (declaredTargets) {
      validateSourceTargetSupport(artifact, declaredTargets, errors);
    }
  }

  for (const artifact of COMPILE_ARTIFACT_TYPES) {
    const declaredTargets = validateDeclaredTargetList(targets, artifact, errors);
    if (declaredTargets) {
      validateSourceTargetSupport(artifact, declaredTargets, errors);
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

function validateSourceTargetSupport(
  artifact: AnyArtifactType,
  declaredTargets: unknown[],
  errors: string[]
): void {
  errors.push(...validateSourceTargetSupportSelection(artifact, declaredTargets));
}

async function validateManifestLayout(
  pluginPath: string,
  typedManifest: PluginManifest
): Promise<string[]> {
  const errors: string[] = [];
  errors.push(...await collectArtifactSymlinkContainmentErrors(pluginPath));
  if (errors.length > 0) return errors;
  const presentArtifacts = await getPresentArtifacts(pluginPath);
  errors.push(...await validateNoFileLevelInstallTargets(pluginPath));
  errors.push(...await validateNoSourceMarkdownAgents(pluginPath));
  errors.push(...await validateHarnessOverlays(pluginPath, typedManifest));
  errors.push(...validatePresentArtifactTargets(typedManifest, presentArtifacts));
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

/**
 * Validate manifest structure
 */
async function validateManifest(
  manifest: unknown,
  pluginPath: string,
  pluginName?: string
): Promise<void> {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw PluginManifestError.forPlugin(pluginPath, "Invalid manifest: must be an object", [], {
      pluginName,
    });
  }

  const structuralErrors = validateManifestStructure(manifest as Record<string, unknown>);
  throwManifestValidationErrors(pluginPath, pluginName, structuralErrors);

  const layoutErrors = await validateManifestLayout(pluginPath, manifest as PluginManifest);
  throwManifestValidationErrors(pluginPath, pluginName, layoutErrors);
}

export function resolveManifestTargets(targets: readonly PluginTargetId[]): HarnessId[] {
  return resolveSourceTargets(targets);
}

export function resolveManifestTargetsForArtifact(
  targets: readonly PluginTargetId[],
  artifact: AnyArtifactType
): HarnessId[] {
  return resolveManifestTargetsForSourceNoun(targets, artifact);
}

export function getManifestArtifactTargets(
  manifest: PluginManifest,
  artifact: AnyArtifactType
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
    "kimi-code",
    "amp-code",
    "cursor",
    "factory-droid",
    "pi",
    "omp",
    "grok",
    "devin",
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
