/**
 * Configure inventory — detect + list Prism / disk state for supported harnesses.
 * POC supports claude-code only. Snapshot-first; disk scan fills strays + foreign.
 */

import { basename, join, relative, resolve } from "node:path";
import { getHarness, resolveHarnessRoot } from "../harnesses.js";
import { exists, expandPath, listDir, listDirRecursive, readFile } from "../fs.js";
import { resolvePrismHome } from "../prism-home.js";
import {
  decodeSnapshotManifest,
  type SnapshotEntry,
  type SnapshotManifest,
} from "../state/snapshot.js";
import { snapshotDir } from "../state/store.js";
import { prismToolsRuntimeDir } from "../tools-cli/paths.js";
import { workflowBunRuntime } from "../workflow-bun-runtime.js";
import type {
  ArtifactEntry,
  ArtifactGroup,
  ArtifactNoun,
  ConfigureHarnessId,
  ConfigureInventory,
  HarnessPresence,
  HarnessSummary,
  OwnershipKind,
  PluginSummary,
  SectionId,
} from "./model.js";

const POC_HARNESS: ConfigureHarnessId = "claude-code";
const CLAUDE_BINARY = "claude";
const CLAUDE_BIN_ENV = "PRISM_WORKFLOW_CLAUDE_BIN";

const emptyCounts = (): Record<ArtifactNoun, number> => ({
  skill: 0,
  command: 0,
  agent: 0,
  hook: 0,
  rules: 0,
  bundle: 0,
  "tool-runtime": 0,
  other: 0,
});

/** Strip `#file-router` (and any future) attribution suffix. */
export const barePluginName = (plugin: string): string => {
  const hash = plugin.indexOf("#");
  return hash === -1 ? plugin : plugin.slice(0, hash);
};

export const pluginScopeNames = (name: string): ReadonlySet<string> =>
  new Set([name, `${name}#file-router`]);

const listSnapshotManifests = async (
  prismHome: string,
): Promise<ReadonlyArray<SnapshotManifest>> => {
  const dir = snapshotDir(prismHome);
  if (!(await exists(dir))) return [];
  const out: SnapshotManifest[] = [];
  for (const name of await listDir(dir)) {
    if (!name.endsWith(".json") || name.includes(".corrupt-")) continue;
    const path = join(dir, name);
    try {
      const decoded = decodeSnapshotManifest(await readFile(path));
      if (decoded._tag === "Right") out.push(decoded.right);
    } catch {
      // skip unreadable
    }
  }
  return out;
};

const resolveClaudeBinary = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const override = env[CLAUDE_BIN_ENV]?.trim();
  if (override) return override;
  return workflowBunRuntime("configure harness detect").which(CLAUDE_BINARY) ?? undefined;
};

const GENERATED_PLUGIN_RE = /(?:^|\/)prism-generated-([^/]+)/;

export const extractGeneratedPlugin = (relativePath: string): string | undefined => {
  const match = GENERATED_PLUGIN_RE.exec(relativePath.replaceAll("\\", "/"));
  return match?.[1];
};

/**
 * Skill package name for dedup:
 * - `skills/foo/…` → foo
 * - `skills/prism-generated-X/skills/foo/…` → foo
 * - bare `skills/prism-generated-X/…` (bundle root) → undefined (bundle, not skill)
 */
export const skillLogicalName = (relativePath: string): string | undefined => {
  const norm = relativePath.replaceAll("\\", "/");
  const nested = /(?:^|\/)prism-generated-[^/]+\/skills\/([^/]+)/.exec(norm);
  if (nested?.[1] && !nested[1].startsWith("prism-generated-")) return nested[1];
  const direct = /(?:^|\/)skills\/([^/]+)/.exec(norm);
  if (direct?.[1] && !direct[1].startsWith("prism-generated-")) return direct[1];
  return undefined;
};

/** Where this skill package is installed (direct root vs which generated plugin). */
export const skillSiteKey = (relativePath: string): string | undefined => {
  const name = skillLogicalName(relativePath);
  if (!name) return undefined;
  const norm = relativePath.replaceAll("\\", "/");
  const gen = extractGeneratedPlugin(norm);
  if (gen && /prism-generated-[^/]+\/skills\//.test(norm)) {
    return `bundle:${gen}:${name}`;
  }
  return `direct:${name}`;
};

export const classifyRelativePath = (
  relativePath: string,
  mode: SnapshotEntry["mode"],
): {
  readonly noun: ArtifactNoun;
  readonly label: string;
  readonly logicalKey?: string;
  readonly siteKey?: string;
  readonly role?: "primary" | "support";
} => {
  const norm = relativePath.replaceAll("\\", "/");
  if (mode === "region") {
    return {
      noun: "rules",
      label: basename(norm) || "rules region",
      logicalKey: `region:${norm}`,
      siteKey: `file:${norm}`,
      role: "primary",
    };
  }
  if (/(^|\/)hooks\//.test(norm) || norm.endsWith("hooks.json") || norm.endsWith("hooks.v1.json")) {
    const base = basename(norm);
    return {
      noun: "hook",
      label: base,
      logicalKey: base,
      siteKey: norm,
      role: "primary",
    };
  }
  // Agents / commands before skills — they often live under prism-generated bundles.
  if (/(^|\/)commands\//.test(norm)) {
    const base = basename(norm).replace(/\.md$/u, "");
    const gen = extractGeneratedPlugin(norm);
    return {
      noun: "command",
      label: base,
      logicalKey: base,
      siteKey: gen ? `bundle:${gen}:${base}` : `direct:${base}`,
      role: "primary",
    };
  }
  if (/(^|\/)agents\//.test(norm)) {
    const base = basename(norm).replace(/\.md$/u, "");
    const gen = extractGeneratedPlugin(norm);
    return {
      noun: "agent",
      label: base,
      logicalKey: base,
      siteKey: gen ? `bundle:${gen}:${base}` : `direct:${base}`,
      role: "primary",
    };
  }
  // Skills: match paths starting with skills/ OR containing /skills/
  if (/(^|\/)skills\//.test(norm) || /(^|\/)SKILL\.md$/u.test(norm)) {
    const skillName = skillLogicalName(norm);
    if (skillName) {
      const isPrimary = /(^|\/)SKILL\.md$/u.test(norm);
      return {
        noun: "skill",
        label: skillName,
        logicalKey: skillName,
        siteKey: skillSiteKey(norm),
        role: isPrimary ? "primary" : "support",
      };
    }
    // skills/prism-generated-X/… without nested skill package → bundle surface
    const generated = extractGeneratedPlugin(norm);
    if (generated) {
      return {
        noun: "bundle",
        label: `prism-generated-${generated}`,
        logicalKey: generated,
        siteKey: `bundle:${generated}`,
        role: "primary",
      };
    }
  }
  if (norm.includes("prism-generated-")) {
    const generated = extractGeneratedPlugin(norm) ?? basename(norm);
    return {
      noun: "bundle",
      label: generated.startsWith("prism-generated-") ? generated : `prism-generated-${generated}`,
      logicalKey: generated.replace(/^prism-generated-/u, ""),
      siteKey: `bundle:${generated.replace(/^prism-generated-/u, "")}`,
      role: "primary",
    };
  }
  if (norm === "CLAUDE.md" || norm.endsWith("/CLAUDE.md")) {
    return {
      noun: "rules",
      label: "CLAUDE.md",
      logicalKey: "CLAUDE.md",
      siteKey: "file:CLAUDE.md",
      role: "primary",
    };
  }
  return {
    noun: "other",
    label: basename(norm) || norm,
    logicalKey: norm,
    siteKey: norm,
    role: "primary",
  };
};

/**
 * Collapse flat artifacts into dedup groups (same logicalKey + noun).
 * Skills/agents/commands that appear in multiple install sites become one row.
 */
export const groupArtifacts = (
  artifacts: ReadonlyArray<ArtifactEntry>,
): ReadonlyArray<ArtifactGroup> => {
  const map = new Map<string, ArtifactEntry[]>();
  for (const entry of artifacts) {
    const key = entry.logicalKey
      ? `${entry.noun}:${entry.logicalKey}`
      : `path:${entry.id}`;
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  }

  const groups: ArtifactGroup[] = [];
  for (const [id, locations] of map) {
    const first = locations[0]!;
    const noun = first.noun;
    const logicalKey = first.logicalKey ?? first.relativePath;
    const sites = new Set(
      locations.map((l) => l.siteKey ?? l.relativePath).filter(Boolean),
    );
    const ownerships = [...new Set(locations.map((l) => l.ownership))];
    const plugins = [
      ...new Set(locations.map((l) => l.plugin).filter((p): p is string => p !== undefined)),
    ].sort();
    const primaryLocations = locations.filter((l) => l.role !== "support");
    const siteCount = sites.size;
    groups.push({
      id,
      noun,
      logicalKey,
      label: first.label,
      locations: [...locations].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      locationCount: locations.length,
      siteCount,
      isDuplicate: siteCount > 1,
      ownerships,
      plugins,
      primaryLocations:
        primaryLocations.length > 0
          ? primaryLocations
          : locations,
    });
  }

  return groups.sort((a, b) => {
    // Duplicates first within a noun, then label
    if (a.isDuplicate !== b.isDuplicate) return a.isDuplicate ? -1 : 1;
    if (a.noun !== b.noun) return a.noun.localeCompare(b.noun);
    return a.label.localeCompare(b.label);
  });
};

const artifactId = (entry: {
  readonly targetPath: string;
  readonly regionKey?: string;
  readonly ownership: OwnershipKind;
}): string => {
  const region = entry.regionKey ? `#${entry.regionKey}` : "";
  return `${entry.ownership}:${entry.targetPath}${region}`;
};

const CLAUDE_SCAN_DIRS = ["skills", "commands", "agents"] as const;

const buildPluginSummaries = (
  entries: ReadonlyArray<SnapshotEntry>,
  toolRuntimePlugins: ReadonlySet<string>,
  root: string,
): PluginSummary[] => {
  const byBare = new Map<
    string,
    { owned: number; regions: number; roots: Set<string> }
  >();
  for (const entry of entries) {
    const bare = barePluginName(entry.plugin);
    const current = byBare.get(bare) ?? { owned: 0, regions: 0, roots: new Set<string>() };
    if (entry.mode === "owned") current.owned += 1;
    else current.regions += 1;
    current.roots.add(root);
    byBare.set(bare, current);
  }
  // Also attach tools runtime-only plugins
  for (const name of toolRuntimePlugins) {
    if (!byBare.has(name)) {
      byBare.set(name, { owned: 0, regions: 0, roots: new Set([root]) });
    }
  }
  return [...byBare.entries()]
    .map(([name, stats]) => ({
      name,
      entryCount: stats.owned + stats.regions,
      ownedFiles: stats.owned,
      regions: stats.regions,
      hasToolRuntime: toolRuntimePlugins.has(name),
      roots: [...stats.roots].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

const listToolRuntimePlugins = async (prismHome: string): Promise<Set<string>> => {
  const dir = prismToolsRuntimeDir(prismHome);
  if (!(await exists(dir))) return new Set();
  const names = await listDir(dir);
  return new Set(names);
};

/**
 * Load full configure inventory for the POC (claude-code).
 */
export const loadConfigureInventory = async (options: {
  readonly prismHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Optional project path for future project-scope roots (ignored for POC global). */
  readonly projectPath?: string;
} = {}): Promise<ConfigureInventory> => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const env = options.env ?? process.env;
  const harnessConfig = getHarness(POC_HARNESS);
  // Global scope always resolves; project scope can be null (not used in POC).
  const globalRoot =
    resolveHarnessRoot(harnessConfig, "global") ?? expandPath(harnessConfig.globalConfigPath);
  const rootExists = await exists(globalRoot);
  const binaryPath = resolveClaudeBinary(env);

  const manifests = await listSnapshotManifests(prismHome);
  const claudeManifests = manifests.filter(
    (m) => m.harness === POC_HARNESS && resolve(m.root) === resolve(globalRoot),
  );
  // Also include any claude-code snapshot even if root path differs (custom roots)
  const allClaude = manifests.filter((m) => m.harness === POC_HARNESS);
  const primaryManifests = claudeManifests.length > 0 ? claudeManifests : allClaude;

  const snapshotEntries: SnapshotEntry[] = primaryManifests.flatMap((m) => [...m.entries]);
  const snapshotPaths = new Set(snapshotEntries.map((e) => resolve(e.targetPath)));

  const toolRuntimePlugins = await listToolRuntimePlugins(prismHome);

  const artifacts: ArtifactEntry[] = [];

  const pushClassified = (
    relativePath: string,
    mode: SnapshotEntry["mode"],
    ownership: OwnershipKind,
    targetPath: string,
    extras: {
      readonly plugin?: string;
      readonly regionKey?: string;
      readonly detail?: string;
      readonly forceNoun?: ArtifactNoun;
      readonly forceLabel?: string;
    } = {},
  ): void => {
    const classified = classifyRelativePath(relativePath, mode);
    const noun = extras.forceNoun ?? classified.noun;
    const label = extras.forceLabel ?? classified.label;
    artifacts.push({
      id: artifactId({
        targetPath,
        ownership,
        ...(extras.regionKey ? { regionKey: extras.regionKey } : {}),
      }),
      noun,
      ownership,
      targetPath,
      relativePath,
      label: extras.regionKey ? `${label} · ${extras.regionKey}` : label,
      ...(extras.plugin !== undefined ? { plugin: extras.plugin } : {}),
      ...(extras.regionKey !== undefined ? { regionKey: extras.regionKey } : {}),
      ...(extras.detail !== undefined ? { detail: extras.detail } : {}),
      ...(classified.logicalKey !== undefined ? { logicalKey: classified.logicalKey } : {}),
      ...(classified.siteKey !== undefined ? { siteKey: classified.siteKey } : {}),
      ...(classified.role !== undefined ? { role: classified.role } : {}),
    });
  };

  for (const entry of snapshotEntries) {
    const root = primaryManifests.find((m) =>
      m.entries.some((e) => e.targetPath === entry.targetPath && e.plugin === entry.plugin),
    )?.root ?? globalRoot;
    let rel: string;
    try {
      rel = relative(root, entry.targetPath);
      if (rel.startsWith("..")) rel = entry.targetPath;
    } catch {
      rel = entry.targetPath;
    }
    const ownership: OwnershipKind = entry.mode === "owned" ? "prism-owned" : "prism-region";
    pushClassified(rel, entry.mode, ownership, entry.targetPath, {
      plugin: barePluginName(entry.plugin),
      ...(entry.regionKey ? { regionKey: entry.regionKey } : {}),
      detail: entry.mode === "region" ? "region" : undefined,
    });
  }

  // Disk scan: strays + foreign under known dirs
  if (rootExists) {
    for (const dir of CLAUDE_SCAN_DIRS) {
      const base = join(globalRoot, dir);
      if (!(await exists(base))) continue;
      for (const rel of await listDirRecursive(base)) {
        const absolute = resolve(join(base, rel));
        if (snapshotPaths.has(absolute)) continue;
        const relativePath = join(dir, rel);
        const generated = extractGeneratedPlugin(relativePath);
        const ownership: OwnershipKind =
          generated !== undefined || relativePath.includes("prism-generated-")
            ? "prism-namespace"
            : "foreign";
        // Index SKILL.md + agent/command markdown + top-level generated plugin dirs
        const isSkillMd = rel.endsWith("SKILL.md");
        const isAgentOrCommand =
          /(^|\/)agents\/[^/]+\.md$/u.test(relativePath) ||
          /(^|\/)commands\/[^/]+\.md$/u.test(relativePath);
        const isTopPluginDir =
          dir === "skills" &&
          !rel.includes("/") &&
          relativePath.includes("prism-generated-");
        // Also index skill package support files that are markdown (grouped later)
        const isSkillSupportMd =
          /(^|\/)skills\//.test(relativePath) &&
          rel.endsWith(".md") &&
          !rel.endsWith("SKILL.md");
        if (!isSkillMd && !isAgentOrCommand && !isTopPluginDir && !isSkillSupportMd) continue;
        pushClassified(relativePath, "owned", ownership, absolute, {
          ...(generated ? { plugin: generated } : {}),
          ...(isTopPluginDir
            ? { forceNoun: "bundle", forceLabel: rel }
            : {}),
          detail: ownership === "prism-namespace" ? "unledgered" : "not owned by Prism",
        });
      }
    }
  }

  // Tool runtime as synthetic artifacts under plugins
  for (const name of toolRuntimePlugins) {
    artifacts.push({
      id: `tool-runtime:${name}`,
      noun: "tool-runtime",
      ownership: "prism-owned",
      targetPath: join(prismToolsRuntimeDir(prismHome), name),
      relativePath: `runtime/tools/${name}`,
      plugin: name,
      label: name,
      detail: "PRISM_HOME runtime/tools",
      logicalKey: name,
      siteKey: `tools:${name}`,
      role: "primary",
    });
  }

  artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const groups = groupArtifacts(artifacts);

  // Nav counts = unique logical groups (deduped), not raw file rows.
  const counts = emptyCounts();
  for (const group of groups) {
    counts[group.noun] += 1;
  }

  const plugins = buildPluginSummaries(
    snapshotEntries,
    toolRuntimePlugins,
    globalRoot,
  );

  let presence: HarnessPresence = "absent";
  if (rootExists || binaryPath !== undefined || snapshotEntries.length > 0) {
    presence =
      !rootExists && snapshotEntries.length > 0 && binaryPath === undefined
        ? "snapshot-only"
        : "present";
  }

  const summary: HarnessSummary = {
    harness: POC_HARNESS,
    displayName: harnessConfig.name,
    presence,
    globalRoot,
    rootExists,
    ...(binaryPath !== undefined ? { binaryPath } : {}),
    snapshotEntryCount: snapshotEntries.length,
    plugins,
    counts,
  };

  return {
    prismHome,
    harnesses: [summary],
    artifacts,
    groups,
  };
};

export const artifactsForSection = (
  artifacts: ReadonlyArray<ArtifactEntry>,
  section: SectionId,
): ReadonlyArray<ArtifactEntry> => {
  switch (section) {
    case "skills":
      return artifacts.filter((a) => a.noun === "skill");
    case "commands":
      return artifacts.filter((a) => a.noun === "command");
    case "agents":
      return artifacts.filter((a) => a.noun === "agent");
    case "hooks":
      return artifacts.filter((a) => a.noun === "hook");
    case "rules":
      return artifacts.filter((a) => a.noun === "rules");
    case "bundles":
      return artifacts.filter((a) => a.noun === "bundle");
    case "plugins":
      return artifacts.filter((a) => a.plugin !== undefined);
    case "other":
      return artifacts.filter((a) => a.noun === "other" || a.noun === "tool-runtime");
    case "summary":
      return artifacts;
  }
};

export const groupsForSection = (
  groups: ReadonlyArray<ArtifactGroup>,
  section: SectionId,
): ReadonlyArray<ArtifactGroup> => {
  switch (section) {
    case "skills":
      return groups.filter((g) => g.noun === "skill");
    case "commands":
      return groups.filter((g) => g.noun === "command");
    case "agents":
      return groups.filter((g) => g.noun === "agent");
    case "hooks":
      return groups.filter((g) => g.noun === "hook");
    case "rules":
      return groups.filter((g) => g.noun === "rules");
    case "bundles":
      return groups.filter((g) => g.noun === "bundle");
    case "other":
      return groups.filter((g) => g.noun === "other" || g.noun === "tool-runtime");
    case "plugins":
    case "summary":
      return groups;
  }
};

export const artifactsForPlugin = (
  artifacts: ReadonlyArray<ArtifactEntry>,
  pluginName: string,
): ReadonlyArray<ArtifactEntry> =>
  artifacts.filter((a) => a.plugin === pluginName);

export const groupsForPlugin = (
  groups: ReadonlyArray<ArtifactGroup>,
  pluginName: string,
): ReadonlyArray<ArtifactGroup> =>
  groups.filter((g) => g.plugins.includes(pluginName));
