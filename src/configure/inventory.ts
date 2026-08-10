/**
 * Configure inventory — detect + list Prism / disk state for supported harnesses.
 * POC supports claude-code only. Snapshot-first; disk scan fills strays + foreign.
 */

import { basename, join, relative, resolve } from "node:path";
import { getHarness, resolveHarnessRoot } from "../harnesses.js";
import { exists, listDir, listDirRecursive, readFile } from "../fs.js";
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

export const classifyRelativePath = (
  relativePath: string,
  mode: SnapshotEntry["mode"],
): { readonly noun: ArtifactNoun; readonly label: string } => {
  const norm = relativePath.replaceAll("\\", "/");
  if (mode === "region") {
    return { noun: "rules", label: basename(norm) || "rules region" };
  }
  if (norm.includes("/hooks/") || norm.endsWith("hooks.json") || norm.endsWith("hooks.v1.json")) {
    return { noun: "hook", label: basename(norm) };
  }
  if (norm.includes("/commands/") || /(^|\/)commands\//.test(norm)) {
    return { noun: "command", label: basename(norm).replace(/\.md$/u, "") };
  }
  if (norm.includes("/agents/") || /(^|\/)agents\//.test(norm)) {
    return { noun: "agent", label: basename(norm).replace(/\.md$/u, "") };
  }
  if (norm.includes("SKILL.md") || norm.includes("/skills/")) {
    const generated = extractGeneratedPlugin(norm);
    if (generated && !norm.includes("/skills/") && norm.includes(`prism-generated-${generated}`)) {
      return { noun: "bundle", label: `prism-generated-${generated}` };
    }
    // skill dir name: skills/<name>/… or …/skills/<name>/SKILL.md
    const skillMatch = /(?:^|\/)skills\/([^/]+)/.exec(norm);
    const name = skillMatch?.[1] ?? basename(norm);
    if (name.startsWith("prism-generated-")) {
      return { noun: "bundle", label: name };
    }
    return { noun: "skill", label: name === "SKILL.md" ? basename(norm) : name };
  }
  if (norm.includes("prism-generated-")) {
    return { noun: "bundle", label: extractGeneratedPlugin(norm) ?? basename(norm) };
  }
  if (norm === "CLAUDE.md" || norm.endsWith("/CLAUDE.md")) {
    return { noun: "rules", label: "CLAUDE.md" };
  }
  return { noun: "other", label: basename(norm) || norm };
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
  const globalRoot = resolveHarnessRoot(harnessConfig, "global");
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
  const counts = emptyCounts();

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
    const { noun, label } = classifyRelativePath(rel, entry.mode);
    const ownership: OwnershipKind = entry.mode === "owned" ? "prism-owned" : "prism-region";
    const plugin = barePluginName(entry.plugin);
    const item: ArtifactEntry = {
      id: artifactId({
        targetPath: entry.targetPath,
        ownership,
        ...(entry.regionKey ? { regionKey: entry.regionKey } : {}),
      }),
      noun,
      ownership,
      targetPath: entry.targetPath,
      relativePath: rel,
      plugin,
      label: entry.regionKey ? `${label} · ${entry.regionKey}` : label,
      ...(entry.regionKey ? { regionKey: entry.regionKey } : {}),
      detail: entry.mode === "region" ? "region" : undefined,
    };
    artifacts.push(item);
    counts[noun] += 1;
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
        // Only index skill roots / leaf markdown to keep list readable
        const isSkillMd = rel.endsWith("SKILL.md") || rel.endsWith(".md");
        const isTopPluginDir =
          dir === "skills" &&
          !rel.includes("/") &&
          (await exists(join(base, rel))) &&
          relativePath.includes("prism-generated-");
        if (!isSkillMd && !isTopPluginDir) continue;
        const { noun, label } = classifyRelativePath(relativePath, "owned");
        const item: ArtifactEntry = {
          id: artifactId({ targetPath: absolute, ownership }),
          noun: isTopPluginDir ? "bundle" : noun,
          ownership,
          targetPath: absolute,
          relativePath,
          label: isTopPluginDir ? rel : label,
          ...(generated ? { plugin: generated } : {}),
          detail: ownership === "prism-namespace" ? "unledgered" : "not owned by Prism",
        };
        artifacts.push(item);
        counts[item.noun] += 1;
      }
    }
  }

  // Tool runtime as synthetic artifacts under plugins
  for (const name of toolRuntimePlugins) {
    const item: ArtifactEntry = {
      id: `tool-runtime:${name}`,
      noun: "tool-runtime",
      ownership: "prism-owned",
      targetPath: join(prismToolsRuntimeDir(prismHome), name),
      relativePath: `runtime/tools/${name}`,
      plugin: name,
      label: name,
      detail: "PRISM_HOME runtime/tools",
    };
    artifacts.push(item);
    counts["tool-runtime"] += 1;
  }

  artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

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

export const artifactsForPlugin = (
  artifacts: ReadonlyArray<ArtifactEntry>,
  pluginName: string,
): ReadonlyArray<ArtifactEntry> =>
  artifacts.filter((a) => a.plugin === pluginName);
