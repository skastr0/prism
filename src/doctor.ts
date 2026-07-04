import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { parse as parseJsonc } from "jsonc-parser";
import { getHarness, resolveHarnessRoot } from "./harnesses.js";
import { exists, expandPath, listDir, listDirRecursive, pathContains, readFile } from "./fs.js";
import type { HarnessId, HarnessScope } from "./types.js";
import { HarnessRoots, type HarnessRootsEnv } from "./services/prism-env.js";
import { refreshPlugin, type RefreshResult } from "./refresh.js";
import { EXIT_CODES, type ExitCode } from "./exit.js";
import { computeContentHash } from "./content-hash.js";
import {
  decodeSnapshotManifest,
  type SnapshotEntry,
  type SnapshotManifest,
} from "./state/snapshot.js";
import { gcSnapshots, snapshotDir } from "./state/store.js";
import { parseRegionRef } from "./sync/plan.js";
import {
  manifestHasCompileTargets,
  readManifest,
  resolveManifestTargets,
} from "./manifest.js";
import { compilePluginForTarget } from "./compile/pipeline.js";
import { prismMcpServerPath } from "./compile/mcp-runtime-path.js";
import { MCP_EXPOSURE_HEADER } from "./compile/mcp-runtime.js";
import { describePrismCause } from "./errors.js";
import { getMcpStatus } from "./mcp/lifecycle.js";

export type DoctorSeverity = "error" | "warning" | "info";

export type DoctorFindingFamily =
  | "sync.plan"
  | "harness.config"
  | "snapshot.disk-drift"
  | "snapshot.gc"
  | "namespace.stray"
  | "region.integrity"
  | "mcp.health"
  | "determinism.selfcheck";

export interface DoctorFinding {
  readonly schema: "prism.doctor.finding.v1";
  readonly severity: DoctorSeverity;
  readonly family: DoctorFindingFamily;
  readonly code: string;
  readonly message: string;
  readonly harness?: HarnessId;
  readonly plugin?: string;
  readonly root?: string;
  readonly path?: string;
  readonly fix?: "refresh" | "gc" | "manual" | "mcp-restart";
  readonly data?: Record<string, unknown>;
}

export interface DoctorReport {
  readonly schema: "prism.doctor.report.v1";
  readonly pluginPath?: string;
  readonly fix: boolean;
  readonly fixFailed?: boolean;
  readonly findings: ReadonlyArray<DoctorFinding>;
  readonly refresh?: RefreshResult;
}

export interface DoctorOptions {
  readonly pluginPath?: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly prismHome: string;
  readonly fix: boolean;
  /** Optional harness-root resolver; when provided, global roots come from here instead of HOME. */
  readonly roots?: HarnessRootsEnv;
}

const finding = (input: Omit<DoctorFinding, "schema">): DoctorFinding => ({
  schema: "prism.doctor.finding.v1",
  ...input,
});

const rootForHarness = (
  harnessId: HarnessId,
  scope: HarnessScope,
  projectPath: string | undefined,
  roots?: HarnessRootsEnv,
): string | undefined => {
  const harness = getHarness(harnessId);
  const root = resolveHarnessRoot(harness, scope, projectPath, roots);
  return root ? expandPath(root) : undefined;
};

const configPathForHarness = (
  harnessId: HarnessId,
  scope: HarnessScope,
  projectPath: string | undefined,
  roots?: HarnessRootsEnv,
): string | undefined => {
  const harness = getHarness(harnessId);
  if (!harness.configFile) return undefined;
  const root = rootForHarness(harnessId, scope, projectPath, roots);
  return root ? join(root, harness.configFile) : undefined;
};

const unique = <T>(values: ReadonlyArray<T>): T[] => [...new Set(values)];

const rootsForHarness = (
  harnessId: HarnessId,
  scope: HarnessScope,
  projectPath: string | undefined,
  roots?: HarnessRootsEnv,
): string[] => {
  const harness = getHarness(harnessId);
  const rootsList = [roots ? roots.resolve(harnessId) : expandPath(harness.globalConfigPath)];
  const scopedRoot = resolveHarnessRoot(harness, scope, projectPath, roots);
  if (scopedRoot) rootsList.push(expandPath(scopedRoot));
  if (projectPath) rootsList.push(expandPath(projectPath));
  return unique(rootsList.map((root) => resolve(root)));
};

const countOccurrences = (content: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = content.indexOf(needle, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + needle.length;
  }
};

const regexEscape = (value: string): string => value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");

const markerLine = (
  prefix: string,
  key: string,
  edge: "begin" | "end",
  suffix = "",
): string => `${prefix} --- prism:${key} ${edge} ---${suffix}`;

const markerRegionBody = (
  content: string,
  parsed: Extract<NonNullable<ReturnType<typeof parseRegionRef>>, { kind: "marker" }>,
): string | undefined => {
  const begin = markerLine(parsed.commentPrefix, parsed.regionKey, "begin", parsed.commentSuffix);
  const end = markerLine(parsed.commentPrefix, parsed.regionKey, "end", parsed.commentSuffix);
  const match = content.match(new RegExp(`${regexEscape(begin)}[\\s\\S]*?${regexEscape(end)}`));
  return match?.[0];
};

const jsonAtPath = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
  let cursor = value;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[String(segment)];
  }
  return cursor;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const readAllSnapshots = async (
  prismHome: string,
): Promise<Array<{ readonly path: string; readonly manifest?: SnapshotManifest; readonly error?: string }>> => {
  const dir = snapshotDir(prismHome);
  const results: Array<{ path: string; manifest?: SnapshotManifest; error?: string }> = [];
  if (!(await exists(dir))) return results;
  for (const name of await listDir(dir)) {
    if (!name.endsWith(".json") || name.includes(".corrupt-")) continue;
    const path = join(dir, name);
    const decoded = decodeSnapshotManifest(await readFile(path));
    if (decoded._tag === "Right") results.push({ path, manifest: decoded.right });
    else results.push({ path, error: String(decoded.left) });
  }
  return results;
};

const validateOwnedSnapshotEntry = async (
  manifest: SnapshotManifest,
  entry: SnapshotEntry,
): Promise<DoctorFinding[]> => {
  if (!(await exists(entry.targetPath))) {
    return [finding({
      severity: "error",
      family: "snapshot.disk-drift",
      code: "snapshot.owned-missing",
      message: `Prism-owned file recorded in snapshot is missing: ${entry.targetPath}`,
      harness: manifest.harness as HarnessId,
      plugin: entry.plugin,
      root: manifest.root,
      path: entry.targetPath,
      fix: "refresh",
    })];
  }

  let content: string;
  try {
    content = await readFile(entry.targetPath);
  } catch (error) {
    return [finding({
      severity: "error",
      family: "snapshot.disk-drift",
      code: "snapshot.owned-unreadable",
      message: `Prism-owned file cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      harness: manifest.harness as HarnessId,
      plugin: entry.plugin,
      root: manifest.root,
      path: entry.targetPath,
      fix: "manual",
    })];
  }

  if (computeContentHash(content) === entry.contentHash) return [];
  return [finding({
    severity: "warning",
    family: "snapshot.disk-drift",
    code: "snapshot.owned-drift",
    message: `Prism-owned file differs from the snapshot: ${entry.targetPath}`,
    harness: manifest.harness as HarnessId,
    plugin: entry.plugin,
    root: manifest.root,
    path: entry.targetPath,
    fix: "refresh",
  })];
};

type ParsedRegionRef = NonNullable<ReturnType<typeof parseRegionRef>>;

const regionFinding = (
  manifest: SnapshotManifest,
  entry: SnapshotEntry,
  input: {
    readonly severity: DoctorSeverity;
    readonly code: string;
    readonly message: string;
    readonly fix: DoctorFinding["fix"];
  },
): DoctorFinding => finding({
  severity: input.severity,
  family: "region.integrity",
  code: input.code,
  message: input.message,
  harness: manifest.harness as HarnessId,
  plugin: entry.plugin,
  root: manifest.root,
  path: entry.targetPath,
  fix: input.fix,
});

const validateMarkerRegionEntry = (
  manifest: SnapshotManifest,
  entry: SnapshotEntry,
  parsed: Extract<ParsedRegionRef, { kind: "marker" }>,
  content: string,
): DoctorFinding[] => {
  const begin = markerLine(parsed.commentPrefix, parsed.regionKey, "begin", parsed.commentSuffix);
  const end = markerLine(parsed.commentPrefix, parsed.regionKey, "end", parsed.commentSuffix);
  const beginCount = countOccurrences(content, begin);
  const endCount = countOccurrences(content, end);
  if (beginCount !== 1 || endCount !== 1) {
    return [regionFinding(manifest, entry, {
      severity: "error",
      code: "region.marker-count",
      message: `Expected one begin/end fence for region ${parsed.regionKey}; found begin=${beginCount}, end=${endCount}`,
      fix: "refresh",
    })];
  }

  const body = markerRegionBody(content, parsed);
  if (body && computeContentHash(body) !== entry.contentHash) {
    return [regionFinding(manifest, entry, {
      severity: "warning",
      code: "region.marker-drift",
      message: `Prism-owned marker region differs from the snapshot: ${parsed.regionKey}`,
      fix: "refresh",
    })];
  }
  return [];
};

const validateJsonRegionEntry = (
  manifest: SnapshotManifest,
  entry: SnapshotEntry,
  parsed: Exclude<ParsedRegionRef, { kind: "marker" }>,
  json: unknown,
): DoctorFinding[] => {
  if (parsed.kind === "json" && jsonAtPath(json, parsed.jsonPath) === undefined) {
    return [regionFinding(manifest, entry, {
      severity: "error",
      code: "region.json-key-missing",
      message: `Prism-owned JSON key region is missing: ${parsed.regionKey}`,
      fix: "refresh",
    })];
  }

  if (parsed.kind === "json-array") {
    const array = jsonAtPath(json, parsed.jsonPath);
    const wanted = stableJson(parsed.identity);
    const found = Array.isArray(array) && array.some((item) => {
      if (parsed.memberKey === undefined) return stableJson(item) === wanted;
      return stableJson(jsonAtPath(item, parsed.memberKey)) === wanted;
    });
    if (!found) {
      return [regionFinding(manifest, entry, {
        severity: "error",
        code: "region.json-array-member-missing",
        message: `Prism-owned JSON array member is missing: ${parsed.regionKey}`,
        fix: "refresh",
      })];
    }
  }

  return [];
};

const validateRegionSnapshotEntry = async (
  manifest: SnapshotManifest,
  entry: SnapshotEntry,
): Promise<DoctorFinding[]> => {
  if (!entry.regionKey) {
    return [regionFinding(manifest, entry, {
      severity: "error",
      code: "region.ref-missing",
      message: `Snapshot region entry is missing a serialized region key: ${entry.targetPath}`,
      fix: "refresh",
    })];
  }

  const parsed = parseRegionRef(entry.regionKey);
  if (!parsed) {
    return [regionFinding(manifest, entry, {
      severity: "error",
      code: "region.ref-invalid",
      message: `Snapshot region key is not parseable: ${entry.regionKey}`,
      fix: "refresh",
    })];
  }

  if (!(await exists(entry.targetPath))) {
    return [regionFinding(manifest, entry, {
      severity: "error",
      code: "region.target-missing",
      message: `Shared config file recorded in snapshot is missing: ${entry.targetPath}`,
      fix: "refresh",
    })];
  }

  const content = await readFile(entry.targetPath);
  if (parsed.kind === "marker") {
    return validateMarkerRegionEntry(manifest, entry, parsed, content);
  }

  const errors: unknown[] = [];
  const json = parseJsonc(content, errors as never[]);
  if (errors.length > 0) {
    return [regionFinding(manifest, entry, {
      severity: "error",
      code: "region.json-invalid",
      message: `Shared JSON config with Prism regions is not parseable: ${entry.targetPath}`,
      fix: "manual",
    })];
  }

  return validateJsonRegionEntry(manifest, entry, parsed, json);
};

const validateJsonConfig = async (options: {
  readonly harness: HarnessId;
  readonly path: string;
}): Promise<DoctorFinding[]> => {
  if (!(await exists(options.path))) return [];
  try {
    JSON.parse(await readFile(options.path));
    return [];
  } catch (error) {
    return [finding({
      severity: "error",
      family: "harness.config",
      code: "config.json.invalid",
      message: `${options.harness} config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      harness: options.harness,
      path: options.path,
      fix: "manual",
    })];
  }
};

const validateTomlConfig = async (options: {
  readonly harness: HarnessId;
  readonly path: string;
}): Promise<DoctorFinding[]> => {
  if (!(await exists(options.path))) return [];
  const content = await readFile(options.path);
  const findings: DoctorFinding[] = [];
  try {
    Bun.TOML.parse(content);
  } catch (error) {
    findings.push(finding({
      severity: "error",
      family: "harness.config",
      code: "config.toml.invalid",
      message: `${options.harness} config is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
      harness: options.harness,
      path: options.path,
      fix: "manual",
    }));
  }
  return findings;
};

const isLoopbackHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
};

const validateHarnessConfig = async (options: {
  readonly harness: HarnessId;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly roots?: HarnessRootsEnv;
}): Promise<DoctorFinding[]> => {
  const path = configPathForHarness(options.harness, options.scope, options.projectPath, options.roots);
  if (!path) return [];

  switch (options.harness) {
    case "codex-cli":
      return validateTomlConfig({ harness: options.harness, path });
    case "claude-code":
    case "opencode":
      return validateJsonConfig({ harness: options.harness, path });
    default:
      return [];
  }
};

const validateSnapshotDiskState = async (options: {
  readonly prismHome: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly roots?: HarnessRootsEnv;
}): Promise<DoctorFinding[]> => {
  const selectedRoots = new Set(
    options.harnesses.flatMap((harness) =>
      rootsForHarness(harness, options.scope, options.projectPath, options.roots),
    ),
  );
  const findings: DoctorFinding[] = [];

  for (const snapshot of await readAllSnapshots(options.prismHome)) {
    if (snapshot.error) {
      findings.push(finding({
        severity: "error",
        family: "snapshot.gc",
        code: "snapshot.manifest-invalid",
        message: `Snapshot manifest is not decodeable: ${snapshot.error}`,
        path: snapshot.path,
        fix: "gc",
      }));
      continue;
    }
    const manifest = snapshot.manifest;
    if (!manifest) continue;
    if (!options.harnesses.includes(manifest.harness as HarnessId)) continue;
    if (!selectedRoots.has(resolve(manifest.root)) && options.projectPath) continue;

    if (!(await exists(manifest.root))) {
      findings.push(finding({
        severity: "warning",
        family: "snapshot.gc",
        code: "snapshot.dead-root",
        message: `Snapshot root no longer exists: ${manifest.root}`,
        harness: manifest.harness as HarnessId,
        root: manifest.root,
        path: snapshot.path,
        fix: "gc",
      }));
      continue;
    }

    for (const entry of manifest.entries) {
      findings.push(
        ...(entry.mode === "owned"
          ? await validateOwnedSnapshotEntry(manifest, entry)
          : await validateRegionSnapshotEntry(manifest, entry)),
      );
    }
  }

  return findings;
};

const runSnapshotGcFix = async (prismHome: string): Promise<DoctorFinding[]> => {
  const result = await gcSnapshots(prismHome);
  const findings: DoctorFinding[] = result.dropped.map((dropped) => finding({
    severity: "info",
    family: "snapshot.gc",
    code: "snapshot.dead-root-dropped",
    message: `Dropped snapshot for missing root: ${dropped.root}`,
    root: dropped.root,
    path: dropped.path,
  }));
  findings.push(...result.droppedEntries.map((dropped) => finding({
    severity: "info",
    family: "snapshot.gc",
    code: "snapshot.stale-entry-dropped",
    message: `Dropped stale snapshot entry for missing file: ${dropped.targetPath}`,
    harness: dropped.harness as HarnessId,
    plugin: dropped.plugin,
    root: dropped.root,
    path: dropped.targetPath,
  })));
  return findings;
};

const namespaceStrayCandidate = (relativePath: string): boolean =>
  relativePath.includes("prism-generated-") || relativePath.includes("prism_generated_");

const namespaceScanDirs = (harness: HarnessId): string[] => {
  switch (harness) {
    case "codex-cli":
      return ["agents", "skills", "prompts"];
    case "claude-code":
      return ["skills", "commands", "agents"];
    case "opencode":
      return ["agents", "skills", "plugins", "commands"];
    case "hermes":
      return ["skills", "prism/mcp"];
    case "cursor":
      return ["plugins", "skills", "mcp"];
    case "antigravity-cli":
    case "grok":
    case "factory-droid":
      return ["plugins", "skills"];
    case "kimi-code":
      return ["plugins", "skills"];
    case "pi":
      return ["packages", "agents"];
    case "amp-code":
      return ["plugins", "skills"];
    case "openclaw":
      return ["skills"];
  }
};

const detectNamespaceStrays = async (options: {
  readonly prismHome: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly roots?: HarnessRootsEnv;
}): Promise<DoctorFinding[]> => {
  const snapshots = await readAllSnapshots(options.prismHome);
  const owned = new Set(
    snapshots.flatMap((snapshot) =>
      snapshot.manifest?.entries.map((entry) => resolve(entry.targetPath)) ?? [],
    ),
  );
  const findings: DoctorFinding[] = [];

  for (const harnessId of options.harnesses) {
    for (const root of rootsForHarness(harnessId, options.scope, options.projectPath, options.roots)) {
      if (!(await exists(root))) continue;
      for (const dir of namespaceScanDirs(harnessId)) {
        const base = join(root, dir);
        if (!(await exists(base))) continue;
        for (const relativePath of await listDirRecursive(base)) {
          if (!namespaceStrayCandidate(relativePath) && !namespaceStrayCandidate(base)) continue;
          const absolutePath = resolve(join(base, relativePath));
          if (owned.has(absolutePath)) continue;
          findings.push(finding({
            severity: "warning",
            family: "namespace.stray",
            code: "namespace.unowned-prism-path",
            message: `Prism-looking path is not recorded in the snapshot: ${absolutePath}`,
            harness: harnessId,
            root,
            path: absolutePath,
            fix: "manual",
          }));
        }
      }
    }
  }

  return findings;
};

const generatedConfigPathExists = async (
  path: string,
): Promise<boolean> => exists(expandPath(path));

const GENERATED_MCP_SERVER_PREFIX = "prism-generated-";

const pluginNameFromReadableMcpServerName = (
  serverName: string,
): string | undefined => {
  if (!serverName.startsWith(GENERATED_MCP_SERVER_PREFIX)) return undefined;
  const pluginName = serverName.slice(GENERATED_MCP_SERVER_PREFIX.length);
  return pluginName.length > 0 ? pluginName : undefined;
};

const exposureProfileFromMcpServer = (
  server: Record<string, unknown>,
): string | undefined => {
  const headers = server.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const profile = (headers as Record<string, unknown>)[MCP_EXPOSURE_HEADER];
  return typeof profile === "string" ? profile : undefined;
};

const pluginNameFromExposureProfile = (
  exposureProfile: string | undefined,
): string | undefined => {
  if (!exposureProfile) return undefined;
  const [serverName] = exposureProfile.split(":");
  return serverName ? pluginNameFromReadableMcpServerName(serverName) : undefined;
};

const pluginNameForMcpServerConfig = (
  serverName: string,
  server: Record<string, unknown>,
): string | undefined =>
  pluginNameFromReadableMcpServerName(serverName) ??
    pluginNameFromExposureProfile(exposureProfileFromMcpServer(server));

const isPrismGeneratedMcpServerConfig = (
  serverName: string,
  server: Record<string, unknown>,
): boolean => pluginNameForMcpServerConfig(serverName, server) !== undefined;

const canonicalMcpBundlePathForServer = (
  prismHome: string,
  serverName: string,
  server: Record<string, unknown>,
): string | undefined => {
  const pluginName = pluginNameForMcpServerConfig(serverName, server);
  return pluginName ? prismMcpServerPath(prismHome, pluginName) : undefined;
};

const enabledToolFindings = async (options: {
  readonly harness: HarnessId;
  readonly configPath: string;
  readonly serverName: string;
  readonly bundlePath: string;
  readonly enabledTools: ReadonlyArray<string>;
}): Promise<DoctorFinding[]> => {
  if (!(await exists(options.bundlePath))) return [];
  const bundle = await readFile(options.bundlePath);
  return options.enabledTools
    .filter((tool) => !bundle.includes(tool))
    .map((tool) => finding({
      severity: "error",
      family: "harness.config",
      code: "config.enabled-tool-missing-from-bundle",
      message: `${options.harness} MCP server '${options.serverName}' enables tool '${tool}' but the generated bundle does not contain that tool name`,
      harness: options.harness,
      path: options.configPath,
      fix: "refresh",
      data: {
        bundlePath: options.bundlePath,
        tool,
      },
    }));
};

const pathFromCommandString = (command: string): string | undefined => {
  const match = command.match(/(?:node|bun)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u);
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const validateCodexConfigReferences = async (
  path: string,
  prismHome: string,
): Promise<DoctorFinding[]> => {
  if (!(await exists(path))) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(await readFile(path)) as Record<string, unknown>;
  } catch {
    return [];
  }
  const findings: DoctorFinding[] = [];
  const mcpServers = parsed.mcp_servers;
  if (mcpServers && typeof mcpServers === "object") {
    for (const [name, raw] of Object.entries(mcpServers as Record<string, unknown>)) {
      const server = raw as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || !isPrismGeneratedMcpServerConfig(name, server)) {
        continue;
      }
      const bundle = canonicalMcpBundlePathForServer(prismHome, name, server);
      const args = Array.isArray(server.args) ? server.args : [];
      const stdioBundle = args.find((item): item is string => typeof item === "string" && item.includes("server.mjs"));
      if (typeof server.command === "string" || stdioBundle) {
        findings.push(finding({
          severity: "error",
          family: "harness.config",
          code: "config.codex-mcp-stdio-removed",
          message: `Codex MCP server '${name}' still uses removed stdio command/args config; refresh to Streamable HTTP`,
          harness: "codex-cli",
          path,
          fix: "refresh",
        }));
      }
      if (bundle && !(await generatedConfigPathExists(bundle))) {
        findings.push(finding({
          severity: "error",
          family: "harness.config",
          code: "config.codex-mcp-bundle-missing",
          message: `Codex MCP server '${name}' references a missing canonical bundle: ${bundle}`,
          harness: "codex-cli",
          path,
          fix: "refresh",
        }));
      }
      if (typeof server.url !== "string") {
        findings.push(finding({
          severity: "error",
          family: "harness.config",
          code: "config.codex-mcp-url-missing",
          message: `Codex MCP server '${name}' is missing Streamable HTTP url`,
          harness: "codex-cli",
          path,
          fix: "refresh",
        }));
      } else if (!isLoopbackHttpUrl(server.url)) {
        findings.push(finding({
          severity: "error",
          family: "harness.config",
          code: "config.codex-mcp-url-non-loopback",
          message: `Codex MCP server '${name}' must use a loopback HTTP url`,
          harness: "codex-cli",
          path,
          fix: "refresh",
        }));
      }
      if ("enabled_tools" in server && !Array.isArray(server.enabled_tools)) {
        findings.push(finding({
          severity: "error",
          family: "harness.config",
          code: "config.codex-enabled-tools-invalid",
          message: `Codex MCP server '${name}' has non-array enabled_tools`,
          harness: "codex-cli",
          path,
          fix: "refresh",
        }));
      } else if (bundle && Array.isArray(server.enabled_tools)) {
        findings.push(
          ...(await enabledToolFindings({
            harness: "codex-cli",
            configPath: path,
            serverName: name,
            bundlePath: bundle,
            enabledTools: server.enabled_tools.filter(
              (tool): tool is string => typeof tool === "string",
            ),
          })),
        );
      }
    }
  }

  const visitCommands = async (value: unknown): Promise<void> => {
    if (Array.isArray(value)) {
      for (const item of value) await visitCommands(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.command === "string" && record.command.includes("prism")) {
      const commandPath = pathFromCommandString(record.command);
      if (commandPath && !(await generatedConfigPathExists(commandPath))) {
        findings.push(finding({
          severity: "error",
          family: "harness.config",
          code: "config.codex-hook-command-missing",
          message: `Codex hook command references a missing file: ${commandPath}`,
          harness: "codex-cli",
          path,
          fix: "refresh",
        }));
      }
    }
    for (const item of Object.values(record)) await visitCommands(item);
  };
  await visitCommands(parsed.hooks);

  return findings;
};

const isPrismHookCommand = (command: string): boolean => {
  if (command.includes("prism-generated-")) return true;
  if (command.includes("prism hook ")) return true;
  const path = pathFromCommandString(command);
  if (path && (path.includes("/.codex/hooks/") || path.includes("/hooks/prism-"))) return true;
  return false;
};

const collectCodexHooksJsonCommands = (value: unknown): string[] => {
  const commands: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (typeof record.command === "string") commands.push(record.command);
    for (const item of Object.values(record)) visit(item);
  };
  visit(value);
  return commands;
};

const validateCodexHooksJson = async (root: string): Promise<DoctorFinding[]> => {
  const path = join(root, "hooks.json");
  if (!(await exists(path))) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path));
  } catch {
    return [];
  }

  const prismCommands = collectCodexHooksJsonCommands(parsed).filter(isPrismHookCommand);
  if (prismCommands.length === 0) return [];

  return [finding({
    severity: "warning",
    family: "harness.config",
    code: "config.codex-hooks-json-split",
    message:
      `Codex hooks.json contains ${prismCommands.length} Prism-managed hook(s). ` +
      `Codex merges hooks.json with config.toml hooks, so these may duplicate or conflict with ` +
      `Prism's config.toml hooks. Remove Prism hooks from hooks.json and keep them in config.toml.`,
    harness: "codex-cli",
    root,
    path,
    fix: "manual",
    data: { prismCommands },
  })];
};

const generatedPluginPathFromOpenCodeEntry = (entry: string): string | undefined => {
  if (entry.startsWith("file://")) {
    try {
      return fileURLToPath(entry);
    } catch {
      return undefined;
    }
  }
  return entry.includes("prism-generated-") ? expandPath(entry) : undefined;
};

const validateOpenCodeConfigReferences = async (path: string): Promise<DoctorFinding[]> => {
  if (!(await exists(path))) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path)) as Record<string, unknown>;
  } catch {
    return [];
  }
  const pluginEntries = Array.isArray(parsed.plugin) ? parsed.plugin : [];
  const findings: DoctorFinding[] = [];
  for (const entry of pluginEntries) {
    if (typeof entry !== "string" || !entry.includes("prism-generated-")) continue;
    const pluginPath = generatedPluginPathFromOpenCodeEntry(entry);
    if (!pluginPath || !(await exists(pluginPath))) {
      findings.push(finding({
        severity: "error",
        family: "harness.config",
        code: "config.opencode-plugin-missing",
        message: `OpenCode plugin entry references a missing generated plugin: ${entry}`,
        harness: "opencode",
        path,
        fix: "refresh",
      }));
      continue;
    }
    const serverPath = join(pluginPath, "dist", "server.mjs");
    if (!(await exists(serverPath))) {
      findings.push(finding({
        severity: "error",
        family: "harness.config",
        code: "config.opencode-plugin-bundle-missing",
        message: `OpenCode generated plugin is missing its bundle: ${serverPath}`,
        harness: "opencode",
        path,
        fix: "refresh",
      }));
    }
  }
  return findings;
};

const validateClaudeGeneratedPlugin = async (
  root: string,
  pluginRoot: string,
  prismHome: string,
): Promise<DoctorFinding[]> => {
  const findings: DoctorFinding[] = [];
  const mcpPath = join(pluginRoot, ".mcp.json");
  if (await exists(mcpPath)) {
    try {
      const parsed = JSON.parse(await readFile(mcpPath)) as {
        readonly mcpServers?: Record<string, Record<string, unknown>>;
      };
      for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
        const bundle = canonicalMcpBundlePathForServer(prismHome, name, server);
        const args = Array.isArray(server.args) ? server.args : [];
        const stdioBundle = args.find((item): item is string => typeof item === "string" && item.includes("server.mjs"));
        if (typeof server.command === "string" || stdioBundle) {
          findings.push(finding({
            severity: "error",
            family: "harness.config",
            code: "config.claude-mcp-stdio-removed",
            message: `Claude generated plugin '${name}' still uses removed stdio command/args config; refresh to Streamable HTTP`,
            harness: "claude-code",
            root,
            path: mcpPath,
            fix: "refresh",
          }));
        }
        if (bundle && !(await generatedConfigPathExists(bundle))) {
          findings.push(finding({
            severity: "error",
            family: "harness.config",
            code: "config.claude-mcp-bundle-missing",
            message: `Claude generated plugin '${name}' references a missing canonical bundle: ${bundle}`,
            harness: "claude-code",
            root,
            path: mcpPath,
            fix: "refresh",
          }));
        }
        if (Object.keys(server).length > 0 && typeof server.url !== "string") {
          findings.push(finding({
            severity: "error",
            family: "harness.config",
            code: "config.claude-mcp-url-missing",
            message: `Claude generated plugin '${name}' is missing Streamable HTTP url`,
            harness: "claude-code",
            root,
            path: mcpPath,
            fix: "refresh",
          }));
        } else if (Object.keys(server).length > 0 && !isLoopbackHttpUrl(server.url as string)) {
          findings.push(finding({
            severity: "error",
            family: "harness.config",
            code: "config.claude-mcp-url-non-loopback",
            message: `Claude generated plugin '${name}' must use a loopback HTTP url`,
            harness: "claude-code",
            root,
            path: mcpPath,
            fix: "refresh",
          }));
        }
        const headers = server.headers;
        if (Object.keys(server).length > 0 && (!headers || typeof headers !== "object")) {
          findings.push(finding({
            severity: "error",
            family: "harness.config",
            code: "config.claude-mcp-headers-missing",
            message: `Claude generated plugin '${name}' is missing HTTP headers`,
            harness: "claude-code",
            root,
            path: mcpPath,
            fix: "refresh",
          }));
        }
      }
    } catch (error) {
      findings.push(finding({
        severity: "error",
        family: "harness.config",
        code: "config.claude-mcp-json-invalid",
        message: `Claude generated plugin has invalid .mcp.json: ${error instanceof Error ? error.message : String(error)}`,
        harness: "claude-code",
        root,
        path: mcpPath,
        fix: "refresh",
      }));
    }
  }

  const hooksPath = join(pluginRoot, "hooks", "hooks.json");
  if (await exists(hooksPath)) {
    try {
      const parsed = JSON.parse(await readFile(hooksPath)) as unknown;
      const commands: string[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
          return;
        }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (typeof record.command === "string") commands.push(record.command);
        for (const item of Object.values(record)) visit(item);
      };
      visit(parsed);
      for (const command of commands) {
        const relative = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/u)?.[1];
        if (relative && !(await exists(join(pluginRoot, relative)))) {
          findings.push(finding({
            severity: "error",
            family: "harness.config",
            code: "config.claude-hook-command-missing",
            message: `Claude hook command references a missing generated file: ${relative}`,
            harness: "claude-code",
            root,
            path: hooksPath,
            fix: "refresh",
          }));
        }
      }
    } catch (error) {
      findings.push(finding({
        severity: "error",
        family: "harness.config",
        code: "config.claude-hooks-json-invalid",
        message: `Claude generated plugin has invalid hooks.json: ${error instanceof Error ? error.message : String(error)}`,
        harness: "claude-code",
        root,
        path: hooksPath,
        fix: "refresh",
      }));
    }
  }
  return findings;
};

const validateClaudeGeneratedPluginReferences = async (
  scope: HarnessScope,
  projectPath: string | undefined,
  prismHome: string,
  roots?: HarnessRootsEnv,
): Promise<DoctorFinding[]> => {
  const rootsList = rootsForHarness("claude-code", scope, projectPath, roots);
  const findings: DoctorFinding[] = [];
  for (const root of rootsList) {
    const skillsRoot = join(root, "skills");
    if (!(await exists(skillsRoot))) continue;
    for (const entry of await listDir(skillsRoot)) {
      if (!entry.startsWith("prism-generated-")) continue;
      const pluginRoot = join(skillsRoot, entry);
      findings.push(...(await validateClaudeGeneratedPlugin(root, pluginRoot, prismHome)));
    }
  }
  return findings;
};

const validateHarnessConfigReferences = async (options: {
  readonly harness: HarnessId;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly prismHome: string;
  readonly roots?: HarnessRootsEnv;
}): Promise<DoctorFinding[]> => {
  const path = configPathForHarness(options.harness, options.scope, options.projectPath, options.roots);
  switch (options.harness) {
    case "codex-cli": {
      const codexFindings = path ? await validateCodexConfigReferences(path, options.prismHome) : [];
      const root = rootForHarness(options.harness, options.scope, options.projectPath, options.roots);
      if (root) codexFindings.push(...(await validateCodexHooksJson(root)));
      return codexFindings;
    }
    case "opencode":
      return path ? validateOpenCodeConfigReferences(path) : [];
    case "claude-code":
      return validateClaudeGeneratedPluginReferences(options.scope, options.projectPath, options.prismHome, options.roots);
    default:
      return [];
  }
};

const findingsFromRefresh = (result: RefreshResult): DoctorFinding[] =>
  result.reports.flatMap((report) =>
    report.ops.flatMap((op): DoctorFinding[] => {
      if (op.kind === "skip" || op.kind === "skip-regions") return [];
      if (op.kind === "blocked") {
        return [finding({
          severity: "error",
          family: "sync.plan",
          code: "sync.blocked",
          message: op.hint,
          harness: report.harness as HarnessId,
          plugin: op.plugin,
          root: report.root,
          path: op.targetPath,
          fix: "manual",
        })];
      }
      return [finding({
        severity: "warning",
        family: "sync.plan",
        code: `sync.${op.kind}`,
        message: `${op.kind} required for ${op.targetPath}`,
        harness: report.harness as HarnessId,
        root: report.root,
        path: op.targetPath,
        fix: "refresh",
        data: "reason" in op ? { reason: op.reason } : undefined,
      })];
    }),
  );

const findingsFromRefreshFailures = (result: RefreshResult): DoctorFinding[] =>
  result.failures.map((failure) =>
    finding({
      severity: "error",
      family: "sync.plan",
      code: "sync.apply-failed",
      message: failure.message,
      path: failure.op.targetPath,
    })
  );

const validateMcpHealth = async (options: {
  readonly pluginPath?: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly prismHome: string;
}): Promise<DoctorFinding[]> => {
  if (!options.pluginPath) return [];
  const manifest = await readManifest(options.pluginPath);
  const findings: DoctorFinding[] = [];
  for (const harness of options.harnesses) {
    if (!manifestHasCompileTargets(manifest, harness)) continue;
    if (!resolveManifestTargets(manifest.targets.tools ?? []).includes(harness)) continue;
    try {
      const status = await getMcpStatus({
        pluginPath: options.pluginPath,
        harness,
        scope: options.scope,
        projectPath: options.projectPath,
        prismHome: options.prismHome,
      });
      if (status.state === "running" || status.state === "stopped") continue;
      findings.push(finding({
        severity: status.state === "stale-pid" ? "warning" : "error",
        family: "mcp.health",
        code: `mcp.${status.state}`,
        message: status.detail,
        harness,
        plugin: manifest.name,
        path: status.descriptor.runtimePath,
        fix: "mcp-restart",
        data: {
          serverName: status.descriptor.serverName,
          staleReasons: status.staleReasons,
        },
      }));
    } catch (error) {
      findings.push(finding({
        severity: "warning",
        family: "mcp.health",
        code: "mcp.status-unavailable",
        message: error instanceof Error ? error.message : String(error),
        harness,
        plugin: manifest.name,
        fix: "refresh",
      }));
    }
  }
  return findings;
};

const operationSignature = (result: { readonly operations: ReadonlyArray<unknown> }): string =>
  stableJson(result.operations);

const validateDeterminismSelfcheck = async (options: {
  readonly pluginPath?: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly prismHome: string;
  readonly roots?: HarnessRootsEnv;
}): Promise<DoctorFinding[]> => {
  if (!options.pluginPath) return [];
  const manifest = await readManifest(options.pluginPath);
  const harness = options.harnesses.find((id) => manifestHasCompileTargets(manifest, id));
  if (!harness) return [];

  const run = () => {
    const program = compilePluginForTarget({
      pluginPath: expandPath(options.pluginPath!),
      target: harness,
      scope: options.scope,
      projectPath: options.projectPath,
      prismHome: options.prismHome,
      dryRun: true,
      mcpLifecycle: "serve",
    });
    const provisioned = options.roots
      ? program.pipe(Effect.provide(Layer.succeed(HarnessRoots, options.roots)))
      : program;
    return Effect.runPromiseExit(provisioned);
  };

  const first = await run();
  const second = await run();
  if (first._tag === "Failure" || second._tag === "Failure") {
    const failed = first._tag === "Failure" ? first : second;
    if (failed._tag !== "Failure") return [];
    const described = describePrismCause(failed.cause);
    return [finding({
      severity: "warning",
      family: "determinism.selfcheck",
      code: "determinism.compile-failed",
      message: `Dry-run compile self-check failed for ${harness}: ${described.headline}`,
      harness,
      plugin: manifest.name,
      fix: "refresh",
      data: {
        detail: described.detail ?? [],
        ...(described.hint ? { hint: described.hint } : {}),
      },
    })];
  }

  const firstSignature = operationSignature(first.value);
  const secondSignature = operationSignature(second.value);
  if (firstSignature === secondSignature) return [];
  return [finding({
    severity: "error",
    family: "determinism.selfcheck",
    code: "determinism.operations-changed",
    message: `Two dry-run compiles for ${harness} produced different operation plans`,
    harness,
    plugin: manifest.name,
    fix: "manual",
  })];
};

const runCompileFixes = async (options: DoctorOptions): Promise<{
  readonly findings: DoctorFinding[];
  readonly failed: boolean;
}> => {
  if (!options.pluginPath) return { findings: [], failed: false };
  const manifest = await readManifest(options.pluginPath);
  const findings: DoctorFinding[] = [];

  for (const harness of options.harnesses) {
    if (!manifestHasCompileTargets(manifest, harness)) continue;
    const program = compilePluginForTarget({
      pluginPath: expandPath(options.pluginPath),
      target: harness,
      scope: options.scope,
      projectPath: options.projectPath,
      prismHome: options.prismHome,
      dryRun: false,
      mcpLifecycle: "serve",
    });
    const provisioned = options.roots
      ? program.pipe(Effect.provide(Layer.succeed(HarnessRoots, options.roots)))
      : program;
    const result = await Effect.runPromiseExit(provisioned);

    if (result._tag === "Failure") {
      const described = describePrismCause(result.cause);
      findings.push(finding({
        severity: "error",
        family: "sync.plan",
        code: "compile.failed",
        message: `Compile failed for ${harness}: ${described.headline}`,
        harness,
        plugin: manifest.name,
        ...(described.path ? { path: described.path } : {}),
        fix: "manual",
        data: {
          detail: described.detail ?? [],
          ...(described.hint ? { hint: described.hint } : {}),
        },
      }));
      continue;
    }

    for (const blocked of result.value.blocked) {
      findings.push(finding({
        severity: "error",
        family: "sync.plan",
        code: "compile.blocked",
        message: blocked.message,
        harness,
        plugin: manifest.name,
        path: blocked.targetPath,
        fix: "manual",
        ...(blocked.hint ? { data: { hint: blocked.hint } } : {}),
      }));
    }
    for (const failure of result.value.failures) {
      findings.push(finding({
        severity: "error",
        family: "sync.plan",
        code: "compile.apply-failed",
        message: failure.message,
        harness,
        plugin: manifest.name,
        path: failure.op.targetPath,
        fix: "manual",
      }));
    }
  }

  return { findings, failed: findings.length > 0 };
};

const inspectPlugin = async (options: DoctorOptions): Promise<{
  readonly findings: DoctorFinding[];
  readonly refresh?: RefreshResult;
  readonly fixFailed: boolean;
}> => {
  if (!options.pluginPath) return { findings: [], fixFailed: false };
  const findings: DoctorFinding[] = [];
  let refresh: RefreshResult | undefined;
  let fixFailed = false;

  if (options.fix) {
    const compileFix = await runCompileFixes(options);
    findings.push(...compileFix.findings);
    fixFailed = fixFailed || compileFix.failed;
  }
  findings.push(
    ...(await validateMcpHealth({
      pluginPath: options.pluginPath,
      harnesses: options.harnesses,
      scope: options.scope,
      ...(options.projectPath ? { projectPath: options.projectPath } : {}),
      prismHome: options.prismHome,
    })),
  );
  findings.push(
    ...(await validateDeterminismSelfcheck({
      pluginPath: options.pluginPath,
      harnesses: options.harnesses,
      scope: options.scope,
      ...(options.projectPath ? { projectPath: options.projectPath } : {}),
      prismHome: options.prismHome,
      roots: options.roots,
    })),
  );

  if (options.fix) {
    const applied = await refreshPlugin({
      pluginPath: options.pluginPath,
      harnesses: options.harnesses,
      projectPath: options.projectPath,
      prismHome: options.prismHome,
      overwrite: false,
      dryRun: false,
      roots: options.roots,
    });
    fixFailed = fixFailed || !applied.success;
    findings.push(...findingsFromRefreshFailures(applied));
  }

  refresh = await refreshPlugin({
    pluginPath: options.pluginPath,
    harnesses: options.harnesses,
    projectPath: options.projectPath,
    prismHome: options.prismHome,
    overwrite: false,
    dryRun: true,
    roots: options.roots,
  });
  if (options.fix) fixFailed = fixFailed || !refresh.success;
  findings.push(...findingsFromRefresh(refresh));
  findings.push(...findingsFromRefreshFailures(refresh));

  return {
    findings,
    fixFailed,
    ...(refresh ? { refresh } : {}),
  };
};

export const runDoctor = async (options: DoctorOptions): Promise<DoctorReport> => {
  const findings: DoctorFinding[] = [];
  let refresh: RefreshResult | undefined;
  let fixFailed = false;

  if (options.fix) {
    findings.push(...(await runSnapshotGcFix(options.prismHome)));
  }

  for (const harness of options.harnesses) {
    findings.push(
      ...(await validateHarnessConfig({
        harness,
        scope: options.scope,
        ...(options.projectPath ? { projectPath: options.projectPath } : {}),
        roots: options.roots,
      })),
    );
    findings.push(
      ...(await validateHarnessConfigReferences({
        harness,
        scope: options.scope,
        prismHome: options.prismHome,
        ...(options.projectPath ? { projectPath: options.projectPath } : {}),
        roots: options.roots,
      })),
    );
  }

  findings.push(
    ...(await validateSnapshotDiskState({
      prismHome: options.prismHome,
      harnesses: options.harnesses,
      scope: options.scope,
      ...(options.projectPath ? { projectPath: options.projectPath } : {}),
      roots: options.roots,
    })),
  );
  findings.push(
    ...(await detectNamespaceStrays({
      prismHome: options.prismHome,
      harnesses: options.harnesses,
      scope: options.scope,
      ...(options.projectPath ? { projectPath: options.projectPath } : {}),
      roots: options.roots,
    })),
  );

  const pluginInspection = await inspectPlugin(options);
  findings.push(...pluginInspection.findings);
  refresh = pluginInspection.refresh;
  fixFailed = fixFailed || pluginInspection.fixFailed;

  return {
    schema: "prism.doctor.report.v1",
    ...(options.pluginPath ? { pluginPath: options.pluginPath } : {}),
    fix: options.fix,
    ...(options.fix && fixFailed ? { fixFailed } : {}),
    findings,
    ...(refresh ? { refresh } : {}),
  };
};

export const doctorExitCode = (report: DoctorReport): ExitCode => {
  if (report.fix && (report.fixFailed || (report.refresh && !report.refresh.success))) {
    return EXIT_CODES.environment;
  }
  return report.findings.length === 0 ? EXIT_CODES.success : EXIT_CODES.domainFailure;
};

export const formatDoctorReport = (report: DoctorReport): string => {
  const lines: string[] = [];
  if (report.findings.length === 0) {
    return report.fix ? "doctor: clean after fix" : "doctor: clean";
  }
  for (const item of report.findings) {
    const location = [item.harness, item.path].filter(Boolean).join(" ");
    lines.push(`${item.severity.toUpperCase()} ${item.family}/${item.code}${location ? ` ${location}` : ""}`);
    lines.push(`  ${item.message}`);
  }
  return lines.join("\n");
};
