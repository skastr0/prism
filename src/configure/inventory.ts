/**
 * Configure inventory — multi-harness detect + Prism/disk inventory + settings catalogues.
 * Snapshot-first; disk scan fills strays + foreign; catalogues drive scan dirs + config overview.
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
import type { HarnessId } from "../types.js";
import { workflowBunRuntime } from "../workflow-bun-runtime.js";
import { allHarnessCatalogs, getHarnessCatalog, readCatalogSettings } from "./catalogs/index.js";
import type { HarnessCatalog } from "./catalogs/types.js";
import type {
  ArtifactEntry,
  ArtifactGroup,
  ArtifactNoun,
  ConfigFileEntry,
  ConfigOverview,
  ConfigureHarnessId,
  ConfigureInventory,
  HarnessInventory,
  HarnessPresence,
  HarnessSummary,
  OwnershipKind,
  PluginSummary,
  ProfileInventory,
  ProfileSummary,
  SectionId,
  SettingsKeySummary,
} from "./model.js";

export const emptyCounts = (): Record<ArtifactNoun, number> => ({
  skill: 0,
  command: 0,
  agent: 0,
  hook: 0,
  rules: 0,
  bundle: 0,
  "tool-runtime": 0,
  soul: 0,
  memory: 0,
  identity: 0,
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

const resolveHarnessBinary = (
  catalog: HarnessCatalog,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  for (const envVar of catalog.binaryEnvVars ?? []) {
    const override = env[envVar]?.trim();
    if (override) return override;
  }
  const runtime = workflowBunRuntime("configure harness detect");
  for (const name of catalog.binaryNames) {
    const found = runtime.which(name);
    if (found) return found;
  }
  return undefined;
};

/** Expand ~ using a specific env (tests pass HOME without mutating process.env). */
const expandPathEnv = (path: string, env: NodeJS.ProcessEnv = process.env): string => {
  const home = env.HOME ?? process.env.HOME ?? expandPath("~");
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (path === "~") return home;
  return resolve(path);
};

const buildConfigOverview = async (
  catalog: HarnessCatalog,
  root: string,
): Promise<ConfigOverview> => {
  const files: ConfigFileEntry[] = [];
  for (const sf of catalog.settingsFiles) {
    const abs = sf.path.startsWith("~") || sf.path.startsWith("/")
      ? expandPath(sf.path)
      : join(root, sf.path);
    const fileExists = await exists(abs);
    let sizeBytes: number | undefined;
    if (fileExists) {
      try {
        const text = await readFile(abs);
        sizeBytes = text.length;
      } catch {
        sizeBytes = undefined;
      }
    }
    const kind =
      sf.path.includes("credential") || sf.path.includes("auth")
        ? "credentials" as const
        : sf.format === "md" || sf.format === "mdc"
          ? "rules" as const
          : sf.primary
            ? "settings" as const
            : "other" as const;
    const prismTouch =
      kind === "rules"
        ? "regions" as const
        : catalog.fields.some((f) => f.file === sf.path && f.prismTouch === "region")
          ? "regions" as const
          : "none" as const;
    files.push({
      id: sf.path,
      kind,
      label: basename(sf.path) || sf.path,
      path: abs,
      exists: fileExists,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      prismTouch,
      ...(sf.note ? { note: sf.note } : {}),
    });
  }

  const resolved = await readCatalogSettings({ catalog, root });
  const settingsKeys: SettingsKeySummary[] = catalog.fields.map((field) => {
    const hit = resolved.find((r) => r.key === field.key);
    if (!hit || !hit.present) {
      return { key: field.key, shape: "absent" };
    }
    // shape = type-ish status only; preview = value. Never put the value in shape
    // (TUI concatenates columns and that looked like garbled glue).
    const shape = hit.redacted ? "redacted" : field.type;
    return {
      key: field.key,
      shape,
      ...(hit.valuePreview !== undefined ? { preview: hit.valuePreview } : {}),
    };
  });

  const primary = catalog.settingsFiles.find((s) => s.primary) ?? catalog.settingsFiles[0];
  const settingsPath = primary
    ? primary.path.startsWith("~") || primary.path.startsWith("/")
      ? expandPath(primary.path)
      : join(root, primary.path)
    : undefined;

  return {
    files,
    ...(settingsPath !== undefined ? { settingsPath } : {}),
    settingsKeys,
    notes: [
      ...(catalog.notes ?? []),
      `Refresh catalogue: see refresh.procedure in catalogs/${catalog.harness}.ts`,
    ],
  };
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

/** Prism / harness region keys that register hooks (not feature flags like features.hooks). */
export const isHookRegionKey = (regionKey: string): boolean => {
  if (/features\.hooks/i.test(regionKey)) return false;
  return /\.hooks(?:\.|$)/i.test(regionKey) || /^hooks(?:\.|$)/i.test(regionKey);
};

/**
 * Disk paths that are hook artifacts worth listing.
 * Avoids node_modules noise and plugin-cache wrapper spam (prefer hooks.json primary).
 */
export const isHookArtifactPath = (relativePath: string): boolean => {
  const norm = relativePath.replaceAll("\\", "/");
  if (norm.includes("/node_modules/") || norm.includes("/.git/")) return false;
  // Codex plugin-cache backups are not active install surfaces
  if (norm.includes("/plugin-backup-")) return false;
  if (/(^|\/)hooks\.json$/u.test(norm) || /(^|\/)hooks\.v1\.json$/u.test(norm)) return true;
  // Root hooks/ wrappers (Prism Codex) + prism-generated bundle wrappers
  if (/^hooks\/[^/]+\.(mjs|js|cjs|sh|cmd)$/u.test(norm)) return true;
  if (/prism-generated-[^/]+\/hooks\/[^/]+\.(mjs|js|cjs|json|sh|cmd)$/u.test(norm)) return true;
  return false;
};

const hookPackageLabel = (norm: string): string | undefined => {
  // Prefer .../<plugin>/<version>/hooks/hooks.json (handles marketplace + plugin-backup/*).
  const versioned =
    /(?:^|\/)([^/]+)\/\d+\.\d+[^/]*\/hooks\/(?:hooks(?:\.v1)?\.json|[^/]+\.(?:mjs|js|cjs|sh|cmd))$/u.exec(
      norm,
    );
  if (versioned?.[1] && versioned[1] !== "cache" && !versioned[1].startsWith("plugin-backup-")) {
    return versioned[1];
  }
  // plugins/<plugin>/hooks/... (non-cache install)
  const direct = /(?:^|\/)plugins\/([^/]+)\/hooks\//u.exec(norm);
  if (direct?.[1] && direct[1] !== "cache") return direct[1];
  return extractGeneratedPlugin(norm);
};

export const classifyRelativePath = (
  relativePath: string,
  mode: SnapshotEntry["mode"],
  options: { readonly regionKey?: string } = {},
): {
  readonly noun: ArtifactNoun;
  readonly label: string;
  readonly logicalKey?: string;
  readonly siteKey?: string;
  readonly role?: "primary" | "support";
} => {
  const norm = relativePath.replaceAll("\\", "/");
  if (mode === "region") {
    if (options.regionKey && isHookRegionKey(options.regionKey)) {
      const key = options.regionKey;
      return {
        noun: "hook",
        label: key,
        logicalKey: `region:${key}`,
        siteKey: `region:${key}`,
        role: "primary",
      };
    }
    return {
      noun: "rules",
      label: basename(norm) || "rules region",
      logicalKey: `region:${options.regionKey ?? norm}`,
      siteKey: `file:${norm}`,
      role: "primary",
    };
  }
  if (isHookArtifactPath(norm) || /(^|\/)hooks\//.test(norm)) {
    // Only treat as hook noun when path is a known hook artifact OR under hooks/
    // with a hooks.json / wrapper name — keep isHookArtifactPath gate for disk scan.
    const base = basename(norm);
    const pkg = hookPackageLabel(norm);
    const gen = extractGeneratedPlugin(norm);
    const isPrimary =
      base === "hooks.json" ||
      base === "hooks.v1.json" ||
      /^hooks\/[^/]+\.(mjs|js|cjs)$/u.test(norm);
    const isSupport = !isPrimary && /(^|\/)hooks\//.test(norm);
    // Collapse plugin package hooks under one logical key; root hooks.json stays unique.
    const logicalKey = pkg
      ? `plugin:${pkg}`
      : gen
        ? `${gen}:${base}`
        : base === "hooks.json" || base === "hooks.v1.json"
          ? base
          : norm;
    const label = pkg ? `${pkg}${base === "hooks.json" ? "" : `/${base}`}` : gen ? `${gen}/${base}` : base;
    return {
      noun: "hook",
      label,
      logicalKey,
      siteKey: pkg ? `plugin:${pkg}` : gen ? `bundle:${gen}:${base}` : `path:${norm}`,
      role: isSupport ? "support" : "primary",
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
  // Hermes identity surfaces (shared root or profile root)
  if (/(^|\/)SOUL\.md$/iu.test(norm)) {
    return {
      noun: "soul",
      label: "SOUL.md",
      logicalKey: "soul",
      siteKey: `path:${norm}`,
      role: "primary",
    };
  }
  if (/(^|\/)memories\//u.test(norm) && /\.md$/iu.test(norm) && !norm.endsWith(".lock")) {
    const base = basename(norm);
    return {
      noun: "memory",
      label: base,
      logicalKey: `memory:${base}`,
      siteKey: `path:${norm}`,
      role: "primary",
    };
  }
  if (
    /(^|\/)identity-brief\.md$/iu.test(norm) ||
    /(^|\/)profile\.yaml$/iu.test(norm) ||
    /(^|\/)profile\.yml$/iu.test(norm) ||
    /(^|\/)profile\.vouch$/iu.test(norm)
  ) {
    const base = basename(norm);
    return {
      noun: "identity",
      label: base,
      logicalKey: `identity:${base}`,
      siteKey: `path:${norm}`,
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

/** Hermes-specific identity paths to always surface when present. */
const HERMES_IDENTITY_RELS = [
  "SOUL.md",
  "identity-brief.md",
  "profile.yaml",
  "profile.yml",
  "profile.vouch",
  "memories/MEMORY.md",
  "memories/USER.md",
] as const;

const isHermesIdentityPath = (relativePath: string): boolean => {
  const norm = relativePath.replaceAll("\\", "/");
  if (/(^|\/)SOUL\.md$/iu.test(norm)) return true;
  if (/(^|\/)identity-brief\.md$/iu.test(norm)) return true;
  if (/(^|\/)profile\.(yaml|yml|vouch)$/iu.test(norm)) return true;
  if (/(^|\/)memories\/[^/]+\.md$/iu.test(norm) && !norm.endsWith(".lock")) return true;
  return false;
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

const loadOneHarnessInventory = async (options: {
  readonly catalog: HarnessCatalog;
  readonly prismHome: string;
  readonly manifests: ReadonlyArray<SnapshotManifest>;
  readonly toolRuntimePlugins: ReadonlySet<string>;
  readonly env: NodeJS.ProcessEnv;
  /** Attach shared tool-runtime rows only to the first present harness (avoid N× duplicates). */
  readonly attachToolRuntime: boolean;
}): Promise<HarnessInventory> => {
  const { catalog, prismHome, env } = options;
  const harnessId = catalog.harness as ConfigureHarnessId;
  const harnessConfig = getHarness(harnessId);
  // Prefer env.HOME when tests/callers override it (expandPath alone uses process.env).
  const envHome = env.HOME?.trim();
  const globalRoot = envHome
    ? expandPathEnv(catalog.globalRoot, env)
    : (resolveHarnessRoot(harnessConfig, "global") ?? expandPath(catalog.globalRoot));
  const rootExists = await exists(globalRoot);
  const binaryPath = resolveHarnessBinary(catalog, env);

  const matching = options.manifests.filter((m) => m.harness === harnessId);
  const rooted = matching.filter((m) => resolve(m.root) === resolve(globalRoot));
  const primaryManifests = rooted.length > 0 ? rooted : matching;
  const snapshotEntries: SnapshotEntry[] = primaryManifests.flatMap((m) => [...m.entries]);
  const snapshotPaths = new Set(snapshotEntries.map((e) => resolve(e.targetPath)));

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
    const classified = classifyRelativePath(relativePath, mode, {
      ...(extras.regionKey ? { regionKey: extras.regionKey } : {}),
    });
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
      label: extras.regionKey && noun !== "hook" ? `${label} · ${extras.regionKey}` : label,
      ...(extras.plugin !== undefined ? { plugin: extras.plugin } : {}),
      ...(extras.regionKey !== undefined ? { regionKey: extras.regionKey } : {}),
      ...(extras.detail !== undefined ? { detail: extras.detail } : {}),
      ...(classified.logicalKey !== undefined ? { logicalKey: classified.logicalKey } : {}),
      ...(classified.siteKey !== undefined ? { siteKey: classified.siteKey } : {}),
      ...(classified.role !== undefined ? { role: classified.role } : {}),
    });
  };

  for (const entry of snapshotEntries) {
    const root =
      primaryManifests.find((m) =>
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

  const markers = catalog.prismNamespaceMarkers;
  const isPrismNs = (p: string): boolean => markers.some((m) => p.includes(m));

  if (rootExists) {
    // Hermes profiles are harness-equivalent sub-roots — do not bulk-scan them
    // into the shared inventory (they load via loadHermesProfiles).
    const scanDirs = catalog.scanDirs.filter((d) => {
      if (harnessId === "hermes" && (d === "profiles" || d.startsWith("profiles/"))) {
        return false;
      }
      return true;
    });

    for (const dir of scanDirs) {
      const base = join(globalRoot, dir);
      if (!(await exists(base))) continue;
      for (const rel of await listDirRecursive(base)) {
        const absolute = resolve(join(base, rel));
        if (snapshotPaths.has(absolute)) continue;
        const relativePath = join(dir, rel).replaceAll("\\", "/");
        // Extra guard: never index profile trees into shared hermes inventory.
        if (harnessId === "hermes" && relativePath.startsWith("profiles/")) continue;
        const generated = extractGeneratedPlugin(relativePath);
        const ownership: OwnershipKind =
          generated !== undefined || isPrismNs(relativePath) ? "prism-namespace" : "foreign";
        const isSkillMd = rel.endsWith("SKILL.md");
        const isAgentOrCommand =
          /(^|\/)agents\/[^/]+\.md$/u.test(relativePath) ||
          /(^|\/)commands\/[^/]+\.md$/u.test(relativePath) ||
          /(^|\/)droids\/[^/]+\.md$/u.test(relativePath) ||
          /(^|\/)prompts\/[^/]+\.md$/u.test(relativePath);
        const isTopPluginDir =
          !rel.includes("/") && isPrismNs(relativePath);
        const isSkillSupportMd =
          /(^|\/)skills\//.test(relativePath) &&
          rel.endsWith(".md") &&
          !rel.endsWith("SKILL.md");
        const isHook = isHookArtifactPath(relativePath);
        const isIdentity = isHermesIdentityPath(relativePath);
        if (
          !isSkillMd &&
          !isAgentOrCommand &&
          !isTopPluginDir &&
          !isSkillSupportMd &&
          !isHook &&
          !isIdentity
        ) {
          continue;
        }
        const hookPkg = isHook ? hookPackageLabel(relativePath) : undefined;
        pushClassified(relativePath, "owned", ownership, absolute, {
          ...(generated
            ? { plugin: generated }
            : hookPkg
              ? { plugin: hookPkg }
              : {}),
          ...(isTopPluginDir ? { forceNoun: "bundle", forceLabel: rel } : {}),
          detail: ownership === "prism-namespace" ? "unledgered" : "not owned by Prism",
        });
      }
    }

    // Root-level hook files (e.g. ~/.codex/hooks.json) live outside scanDirs.
    for (const sf of catalog.settingsFiles) {
      if (sf.path.includes("..")) continue;
      const rel = sf.path.replaceAll("\\", "/").replace(/^\.\//u, "");
      if (!isHookArtifactPath(rel) && rel !== "hooks.json" && rel !== "hooks.v1.json") continue;
      const absolute = resolve(join(globalRoot, rel));
      if (snapshotPaths.has(absolute)) continue;
      if (!(await exists(absolute))) continue;
      if (artifacts.some((a) => resolve(a.targetPath) === absolute)) continue;
      pushClassified(rel, "owned", "foreign", absolute, {
        detail: "not owned by Prism",
      });
    }

    // Hermes shared-root identity files (SOUL, memories) outside scanDirs.
    if (harnessId === "hermes") {
      for (const rel of HERMES_IDENTITY_RELS) {
        const absolute = resolve(join(globalRoot, rel));
        if (!(await exists(absolute))) continue;
        if (artifacts.some((a) => resolve(a.targetPath) === absolute)) continue;
        pushClassified(rel, "owned", "foreign", absolute, {
          detail: "hermes shared identity",
        });
      }
    }
  }

  if (options.attachToolRuntime) {
    for (const name of options.toolRuntimePlugins) {
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
  }

  artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const groups = groupArtifacts(artifacts);
  const counts = emptyCounts();
  for (const group of groups) counts[group.noun] += 1;

  const plugins = buildPluginSummaries(
    snapshotEntries,
    options.attachToolRuntime ? options.toolRuntimePlugins : new Set(),
    globalRoot,
  );

  let presence: HarnessPresence = "absent";
  if (rootExists || binaryPath !== undefined || snapshotEntries.length > 0) {
    presence =
      !rootExists && snapshotEntries.length > 0 && binaryPath === undefined
        ? "snapshot-only"
        : "present";
  }

  const config = await buildConfigOverview(catalog, globalRoot);

  let profiles: ReadonlyArray<ProfileInventory> | undefined;
  if (harnessId === "hermes" && rootExists) {
    profiles = await loadHermesProfiles({
      sharedRoot: globalRoot,
      prismHome,
      manifests: primaryManifests,
      markers,
    });
  }

  const summary: HarnessSummary = {
    harness: harnessId,
    displayName: catalog.displayName,
    presence,
    globalRoot,
    rootExists,
    ...(binaryPath !== undefined ? { binaryPath } : {}),
    snapshotEntryCount: snapshotEntries.length,
    plugins,
    counts,
    config,
    ...(profiles !== undefined ? { profileCount: profiles.length } : {}),
  };

  return {
    summary,
    artifacts,
    groups,
    ...(profiles !== undefined ? { profiles } : {}),
  };
};

/**
 * Scan one Hermes profile directory as a harness-equivalent sub-inventory.
 * Paths are relative to the profile root (not the shared ~/.hermes).
 */
const loadOneHermesProfile = async (options: {
  readonly profileId: string;
  readonly profileRoot: string;
  readonly sharedRoot: string;
  readonly prismHome: string;
  readonly manifests: ReadonlyArray<SnapshotManifest>;
  readonly markers: ReadonlyArray<string>;
}): Promise<ProfileInventory> => {
  const { profileId, profileRoot, markers } = options;
  const isPrismNs = (p: string): boolean => markers.some((m) => p.includes(m));
  const artifacts: ArtifactEntry[] = [];

  const push = (
    relativePath: string,
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
    const classified = classifyRelativePath(relativePath, "owned", {
      ...(extras.regionKey ? { regionKey: extras.regionKey } : {}),
    });
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
      label,
      ...(extras.plugin !== undefined ? { plugin: extras.plugin } : {}),
      ...(extras.regionKey !== undefined ? { regionKey: extras.regionKey } : {}),
      ...(extras.detail !== undefined ? { detail: extras.detail } : {}),
      ...(classified.logicalKey !== undefined ? { logicalKey: classified.logicalKey } : {}),
      ...(classified.siteKey !== undefined ? { siteKey: classified.siteKey } : {}),
      ...(classified.role !== undefined ? { role: classified.role } : {}),
    });
  };

  // Snapshot entries that land under this profile root
  for (const manifest of options.manifests) {
    for (const entry of manifest.entries) {
      const abs = resolve(entry.targetPath);
      if (!abs.startsWith(resolve(profileRoot) + "/") && abs !== resolve(profileRoot)) continue;
      let rel: string;
      try {
        rel = relative(profileRoot, entry.targetPath).replaceAll("\\", "/");
      } catch {
        continue;
      }
      if (rel.startsWith("..")) continue;
      const ownership: OwnershipKind = entry.mode === "owned" ? "prism-owned" : "prism-region";
      push(rel, ownership, entry.targetPath, {
        plugin: barePluginName(entry.plugin),
        ...(entry.regionKey ? { regionKey: entry.regionKey } : {}),
        detail: entry.mode === "region" ? "region" : undefined,
      });
    }
  }

  const snapshotPaths = new Set(artifacts.map((a) => resolve(a.targetPath)));
  const profileScanDirs = ["skills", "hooks", "plugins", "memories"] as const;

  for (const dir of profileScanDirs) {
    const base = join(profileRoot, dir);
    if (!(await exists(base))) continue;
    for (const rel of await listDirRecursive(base)) {
      const absolute = resolve(join(base, rel));
      if (snapshotPaths.has(absolute)) continue;
      const relativePath = `${dir}/${rel}`.replaceAll("\\", "/");
      const generated = extractGeneratedPlugin(relativePath);
      const ownership: OwnershipKind =
        generated !== undefined || isPrismNs(relativePath) ? "prism-namespace" : "foreign";
      const isSkillMd = rel.endsWith("SKILL.md");
      const isSkillSupportMd =
        relativePath.startsWith("skills/") && rel.endsWith(".md") && !rel.endsWith("SKILL.md");
      const isHook = isHookArtifactPath(relativePath);
      const isIdentity = isHermesIdentityPath(relativePath);
      if (!isSkillMd && !isSkillSupportMd && !isHook && !isIdentity) continue;
      push(relativePath, ownership, absolute, {
        ...(generated ? { plugin: generated } : {}),
        detail: ownership === "prism-namespace" ? "unledgered" : "profile-local",
      });
    }
  }

  for (const rel of HERMES_IDENTITY_RELS) {
    const absolute = resolve(join(profileRoot, rel));
    if (!(await exists(absolute))) continue;
    if (artifacts.some((a) => resolve(a.targetPath) === absolute)) continue;
    push(rel, "foreign", absolute, { detail: "profile identity" });
  }

  // Profile config.yaml (settings surface; also as artifact for identity/config browse)
  const configAbs = join(profileRoot, "config.yaml");
  if (await exists(configAbs) && !artifacts.some((a) => resolve(a.targetPath) === resolve(configAbs))) {
    // config is browsable via Config section; no need as skill-like artifact
  }

  artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const groups = groupArtifacts(artifacts);
  const counts = emptyCounts();
  for (const group of groups) counts[group.noun] += 1;

  const identityFiles: ConfigFileEntry[] = [];
  for (const rel of HERMES_IDENTITY_RELS) {
    const abs = join(profileRoot, rel);
    const fileExists = await exists(abs);
    let sizeBytes: number | undefined;
    if (fileExists) {
      try {
        sizeBytes = (await readFile(abs)).length;
      } catch {
        sizeBytes = undefined;
      }
    }
    identityFiles.push({
      id: rel,
      kind: "other",
      label: basename(rel),
      path: abs,
      exists: fileExists,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      prismTouch: "none",
    });
  }

  const profileCatalog: HarnessCatalog = {
    harness: "hermes",
    displayName: `Hermes · ${profileId}`,
    binaryNames: [],
    globalRoot: profileRoot,
    projectRoot: null,
    settingsFiles: [
      { path: "config.yaml", format: "yaml", primary: true, note: "Profile config" },
      { path: "SOUL.md", format: "md", note: "Profile soul / personality" },
      { path: "identity-brief.md", format: "md", note: "Identity brief" },
      { path: "profile.yaml", format: "yaml", note: "Profile metadata" },
      { path: ".env", format: "other", note: "secrets — never display" },
    ],
    scanDirs: [...profileScanDirs],
    prismNamespaceMarkers: markers,
    fields: getHarnessCatalog("hermes").fields,
    refresh: getHarnessCatalog("hermes").refresh,
  };
  const config = await buildConfigOverview(profileCatalog, profileRoot);

  const summary: ProfileSummary = {
    id: profileId,
    displayName: profileId,
    root: profileRoot,
    rootExists: true,
    counts,
    config,
    identityFiles,
  };

  return { summary, artifacts, groups };
};

export const loadHermesProfiles = async (options: {
  readonly sharedRoot: string;
  readonly prismHome: string;
  readonly manifests: ReadonlyArray<SnapshotManifest>;
  readonly markers: ReadonlyArray<string>;
}): Promise<ReadonlyArray<ProfileInventory>> => {
  const profilesDir = join(options.sharedRoot, "profiles");
  if (!(await exists(profilesDir))) return [];
  const names = (await listDir(profilesDir)).filter((n) => !n.startsWith(".")).sort();
  const out: ProfileInventory[] = [];
  for (const name of names) {
    const profileRoot = join(profilesDir, name);
    // Must be a directory
    try {
      const listing = await listDir(profileRoot);
      if (!Array.isArray(listing)) continue;
    } catch {
      continue;
    }
    // Require at least one profile marker so random dirs are skipped
    const markers = ["SOUL.md", "config.yaml", "profile.yaml", "skills", "memories"];
    let ok = false;
    for (const m of markers) {
      if (await exists(join(profileRoot, m))) {
        ok = true;
        break;
      }
    }
    if (!ok) continue;
    out.push(
      await loadOneHermesProfile({
        profileId: name,
        profileRoot,
        sharedRoot: options.sharedRoot,
        prismHome: options.prismHome,
        manifests: options.manifests,
        markers: options.markers,
      }),
    );
  }
  return out;
};

/**
 * Load configure inventory for all catalogue harnesses (global roots).
 */
export const loadConfigureInventory = async (options: {
  readonly prismHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly projectPath?: string;
  /** Limit to one harness id (faster). */
  readonly harness?: HarnessId;
} = {}): Promise<ConfigureInventory> => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const env = options.env ?? process.env;
  const manifests = await listSnapshotManifests(prismHome);
  const toolRuntimePlugins = await listToolRuntimePlugins(prismHome);

  const catalogs = options.harness
    ? [getHarnessCatalog(options.harness)]
    : allHarnessCatalogs();

  const byHarness: Partial<Record<ConfigureHarnessId, HarnessInventory>> = {};
  const summaries: HarnessSummary[] = [];

  let attachedTools = false;
  for (const catalog of catalogs) {
    const attachToolRuntime = !attachedTools;
    const inv = await loadOneHarnessInventory({
      catalog,
      prismHome,
      manifests,
      toolRuntimePlugins,
      env,
      attachToolRuntime,
    });
    if (attachToolRuntime) attachedTools = true;
    byHarness[catalog.harness as ConfigureHarnessId] = inv;
    summaries.push(inv.summary);
  }

  summaries.sort((a, b) => {
    const rank = (p: HarnessPresence): number =>
      p === "present" ? 0 : p === "snapshot-only" ? 1 : 2;
    const d = rank(a.presence) - rank(b.presence);
    return d !== 0 ? d : a.displayName.localeCompare(b.displayName);
  });

  const focused =
    (options.harness as ConfigureHarnessId | undefined) ??
    summaries.find((s) => s.presence === "present")?.harness ??
    summaries[0]?.harness ??
    ("claude-code" as ConfigureHarnessId);
  const focusedInv = byHarness[focused];

  return {
    prismHome,
    harnesses: summaries,
    byHarness,
    artifacts: focusedInv?.artifacts ?? [],
    groups: focusedInv?.groups ?? [],
    focusedHarness: focused,
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
    case "identity":
      return artifacts.filter((a) => a.noun === "soul" || a.noun === "identity");
    case "memories":
      return artifacts.filter((a) => a.noun === "memory");
    case "plugins":
      return artifacts.filter((a) => a.plugin !== undefined);
    case "other":
      return artifacts.filter((a) => a.noun === "other" || a.noun === "tool-runtime");
    case "summary":
    case "config":
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
    case "identity":
      return groups.filter((g) => g.noun === "soul" || g.noun === "identity");
    case "memories":
      return groups.filter((g) => g.noun === "memory");
    case "other":
      return groups.filter((g) => g.noun === "other" || g.noun === "tool-runtime");
    case "plugins":
    case "summary":
    case "config":
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
