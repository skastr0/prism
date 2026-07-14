import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { parse as parseJsonc } from "jsonc-parser";
import { getHarness, resolveHarnessRoot } from "./harnesses.js";
import {
  exists,
  expandPath,
  listDir,
  listDirRecursive,
  pathContains,
  readFile,
  removeDir,
} from "./fs.js";
import type { HarnessId, HarnessScope } from "./types.js";
import { HarnessRoots, type HarnessRootsEnv } from "./services/prism-env.js";
import { refreshPlugin, type RefreshResult } from "./refresh.js";
import { EXIT_CODES, type ExitCode } from "./exit.js";
import { computeContentHash, computeMcpHttpConfigContentHash } from "./content-hash.js";
import {
  decodeSnapshotManifest,
  type SnapshotEntry,
  type SnapshotManifest,
} from "./state/snapshot.js";
import { gcSnapshots, snapshotDir } from "./state/store.js";
import { runBackupsSummary, type RunBackupsSummary } from "./state/run-backups.js";
import { MISSING_OWNED_FILE_SELF_HEALS, parseRegionRef } from "./sync/plan.js";
import {
  manifestHasCompileTargets,
  readManifest,
  resolveManifestTargets,
} from "./manifest.js";
import { compilePluginForTarget } from "./compile/pipeline.js";
import { prismMcpServerPath } from "./compile/mcp-runtime-path.js";
import { pluginServerKey, shimServerKey, type ShimHarnessId } from "@skastr0/prism-sdk/mcp/wire-naming";
import { getDaemon } from "@skastr0/prism-sdk/mcp/uds-registry";
import { probeSocketLiveness } from "@skastr0/prism-sdk/mcp/uds-singleton";
import { describePrismCause } from "./errors.js";
import { getMcpStatus } from "./mcp/lifecycle.js";
import {
  isShimHarnessId,
  loadPluginInventory,
  verifyHarnessTopology,
  type McpTopologyAssertion,
  type McpTopologyViolation,
} from "./doctor/mcp-topology-checks.js";
import { discoverPluginPaths } from "./plugin-inventory.js";
import {
  detectWorkflowHarnesses,
  workflowHarnessIdsForHarnesses,
  type WorkflowHarnessDetection,
} from "./workflow-harness-detection.js";
import {
  cleanupLaunchdResidueEntry,
  collectLaunchdResidueEntries,
} from "./doctor/launchd-residue.js";
import {
  collectOrphanedMcpEntries,
  isSharedConfigHarnessId,
  pruneOrphanedMcpEntry,
  type OrphanedMcpEntry,
} from "./doctor/orphaned-mcp-entries.js";
import {
  deadWorkflowStoreRegistryEntries,
  pruneDeadWorkflowStoreRegistryEntries,
} from "./workflow-store-registry.js";

export type DoctorSeverity = "error" | "warning" | "info";

export type DoctorFindingFamily =
  | "sync.plan"
  | "harness.config"
  | "snapshot.disk-drift"
  | "snapshot.gc"
  | "namespace.stray"
  | "region.integrity"
  | "mcp.health"
  | "determinism.selfcheck"
  | "topology.invariant"
  | "launchd.residue"
  | "workflow.store-registry";

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
  readonly workflowHarnesses?: ReadonlyArray<WorkflowHarnessDetection>;
  readonly findings: ReadonlyArray<DoctorFinding>;
  readonly refresh?: RefreshResult;
  /**
   * PQ-159: read-only run-backup retention visibility (count/size/oldest
   * age). Deliberately NOT a `DoctorFinding` -- it is never actionable
   * (retention itself is enforced during refresh, not by doctor), so it
   * must not affect `doctorExitCode`'s clean/dirty determination. Same
   * out-of-band-metadata pattern as `workflowHarnesses` above. Omitted
   * when there are no run backups at all.
   */
  readonly backupRetention?: RunBackupsSummary;
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
  /**
   * Directory of installed plugins (shallow `plugin.json` scan, mirroring
   * `refresh --plugins`/`plan --plugins`) to verify the MCP topology
   * invariants (`topology.*` findings) against. Doctor has no persisted
   * record of "where plugins were installed from" — there is no such state
   * anywhere in `prism-home` today — so this is opt-in per invocation,
   * exactly like refresh/plan's own `--plugins` flag. Omitted: the
   * `topology.*` check family contributes zero findings, unchanged from
   * doctor's pre-existing behavior.
   */
  readonly pluginsDir?: string;
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
    // Severity derives from the sync plan classifier (PQ-157, one
    // classifier): plan.ts's planOwnedFile recreates a still-desired missing
    // file (`create`) and planSync silently drops a no-longer-desired one —
    // neither path is ever `blocked`, so this is always a refresh-heals
    // state, never a hard error.
    return [finding({
      severity: MISSING_OWNED_FILE_SELF_HEALS ? "warning" : "error",
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

  // Grok's owned .mcp.json bundles a dynamic host:port the owner daemon can
  // rebind on every restart; normalize it out of the comparison so a port
  // change alone is never reported as drift (PQ-167). A snapshot entry
  // written before this normalization existed still holds a raw (unnormalized)
  // hash, so accept either domain — otherwise every pre-existing grok
  // .mcp.json, even a byte-identical one, false-flags as drifted until its
  // next refresh re-snapshots it.
  if (
    computeContentHash(content) === entry.contentHash ||
    (manifest.harness === "grok" && computeMcpHttpConfigContentHash(content) === entry.contentHash)
  ) {
    return [];
  }
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
  // The shim-exposure registry (state/shim-exposure.ts) is retired — wipe any
  // leftover directory from a pre-migration install (silent, one-time sweep).
  await removeDir(join(prismHome, "state", "shim-exposure"));
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

/**
 * `launchd.residue` -- retired launchd-era `com.prism.mcp.*` LaunchAgents
 * (OBS-002, `doctor/launchd-residue.ts`). Scoped to the exact conditions
 * `src/mcp/lifecycle.ts`'s deleted `launchAgentEligible` used before this
 * scheme was retired (real `~/.prism` home, darwin only) -- every doctor
 * test uses a sandboxed `prismHome`, so this gate keeps every existing and
 * future doctor test from ever reaching real `launchctl`/`~/Library/
 * LaunchAgents`; only a real production invocation against the real home
 * reaches `collectLaunchdResidueEntries`'s default (real) deps.
 */
const isLaunchdResidueEligible = (prismHome: string): boolean =>
  process.platform === "darwin" && resolve(expandPath(prismHome)) === resolve(join(homedir(), ".prism"));

const detectLaunchdResidue = async (prismHome: string): Promise<DoctorFinding[]> => {
  if (!isLaunchdResidueEligible(prismHome)) return [];
  const entries = await collectLaunchdResidueEntries();
  const findings: DoctorFinding[] = [];
  for (const entry of entries) {
    findings.push(finding({
      severity: "error",
      family: "launchd.residue",
      code: "launchd.orphaned-service",
      message: `Retired launchd-era Prism MCP service is still ${entry.loaded ? "loaded in launchctl" : "registered on disk"}: ${entry.label}`,
      ...(entry.plistPath ? { path: entry.plistPath } : {}),
      fix: "gc",
      data: { label: entry.label, loaded: entry.loaded, plistExists: entry.plistExists },
    }));
    if (entry.missingProgramPaths.length > 0) {
      findings.push(finding({
        severity: "error",
        family: "launchd.residue",
        code: "launchd.dead-bundle-respawn",
        message: `Retired launchd service '${entry.label}' is respawning against a deleted bundle: ${entry.missingProgramPaths.join(", ")}`,
        ...(entry.plistPath ? { path: entry.plistPath } : {}),
        fix: "gc",
        data: {
          label: entry.label,
          missingProgramPaths: entry.missingProgramPaths,
          ...(entry.errLogSize !== undefined ? { errLogSize: entry.errLogSize } : {}),
        },
      }));
    }
  }
  return findings;
};

const runLaunchdResidueFix = async (prismHome: string): Promise<DoctorFinding[]> => {
  if (!isLaunchdResidueEligible(prismHome)) return [];
  const entries = await collectLaunchdResidueEntries();
  const findings: DoctorFinding[] = [];
  for (const entry of entries) {
    const result = await cleanupLaunchdResidueEntry(entry);
    findings.push(finding({
      severity: "info",
      family: "launchd.residue",
      code: "launchd.residue-dropped",
      message: `Booted out and removed retired launchd-era Prism MCP residue: ${result.label}`,
      ...(result.plistPath ? { path: result.plistPath } : {}),
      data: {
        label: result.label,
        removedPlist: result.removedPlist,
        removedErrLog: result.removedErrLog,
        removedOutLog: result.removedOutLog,
      },
    }));
  }
  return findings;
};

/**
 * `workflow.store-registry` -- WFE-008: `<prismHome>/state/
 * workflow-store-registry.json` is otherwise append-only, so every tmp
 * store a test or a scratch run ever opened accumulates forever. Detection
 * is read-only (matches every other `detect*` in this file); the fix drops
 * exactly the entries whose backing file no longer exists — the only claim
 * `workflow-store-registry.ts` is entitled to make (AGENTS.md rule 7).
 */
const detectWorkflowStoreRegistryResidue = async (prismHome: string): Promise<DoctorFinding[]> =>
  deadWorkflowStoreRegistryEntries(prismHome).map((entry) => finding({
    severity: "info",
    family: "workflow.store-registry",
    code: "workflow.store-registry.stale-entry",
    message: `Workflow store registry references a store that no longer exists: ${entry.path}`,
    path: entry.path,
    fix: "gc",
    data: { lastOpenedAt: entry.lastOpenedAt },
  }));

const runWorkflowStoreRegistryGcFix = async (prismHome: string): Promise<DoctorFinding[]> =>
  pruneDeadWorkflowStoreRegistryEntries(prismHome).map((entry) => finding({
    severity: "info",
    family: "workflow.store-registry",
    code: "workflow.store-registry.stale-entry-dropped",
    message: `Dropped workflow store registry entry for missing store: ${entry.path}`,
    path: entry.path,
    data: { lastOpenedAt: entry.lastOpenedAt },
  }));

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
    case "omp":
      return ["agents", "skills", "extensions", "commands", "rules"];
    case "amp-code":
      return ["plugins", "skills"];
    case "openclaw":
      return ["skills"];
    case "devin":
      return ["skills", "hooks"];
  }
};

/**
 * Kimi Code's own plugin manager writes these two files as install-time side
 * effects directly inside every `prism-generated-*` plugin directory it
 * activates -- `plugin.json` (a symlink to Prism's own `kimi.plugin.json`)
 * and `prism.lock` (Kimi's own lockfile), grounded by inspecting a real
 * `~/.kimi-code/plugins/managed/prism-generated-<plugin>/` install. Neither
 * is written by the kimi-code lowerer, so neither is ever recorded in
 * Prism's snapshot; without this allowance both would misreport as unowned
 * strays every doctor run. Scoped to kimi-code only -- no other harness's
 * scan is affected.
 */
const KIMI_MANAGER_ARTIFACT_BASENAMES = new Set(["plugin.json", "prism.lock"]);

const isKimiManagerArtifact = (harnessId: HarnessId, relativePath: string): boolean => {
  if (harnessId !== "kimi-code") return false;
  const segments = relativePath.split("/");
  const basename = segments.at(-1);
  const parentDir = segments.at(-2);
  return (
    basename !== undefined &&
    KIMI_MANAGER_ARTIFACT_BASENAMES.has(basename) &&
    parentDir !== undefined &&
    parentDir.startsWith("prism-generated-")
  );
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
          if (isKimiManagerArtifact(harnessId, relativePath)) continue;
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

/**
 * `namespace.stray`'s structured-entry sibling (PQ-172,
 * `doctor/orphaned-mcp-entries.ts`): every prism-fingerprinted MCP server
 * entry a shared harness config carries that the current snapshot's tracked
 * regionKeys do not claim, across every requested shared-config harness
 * (codex-cli/grok/hermes/cursor).
 */
const collectAllOrphanedMcpEntries = async (options: {
  readonly prismHome: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly roots?: HarnessRootsEnv;
}): Promise<OrphanedMcpEntry[]> => {
  const snapshots = await readAllSnapshots(options.prismHome);
  const orphans: OrphanedMcpEntry[] = [];

  for (const harnessId of options.harnesses) {
    if (!isSharedConfigHarnessId(harnessId)) continue;
    for (const root of rootsForHarness(harnessId, options.scope, options.projectPath, options.roots)) {
      if (!(await exists(root))) continue;
      const ownedRegionKeys = new Set<string>();
      for (const snapshot of snapshots) {
        const manifest = snapshot.manifest;
        if (!manifest || manifest.harness !== harnessId || resolve(manifest.root) !== resolve(root)) continue;
        for (const entry of manifest.entries) {
          if (entry.mode === "region" && entry.regionKey !== undefined) ownedRegionKeys.add(entry.regionKey);
        }
      }
      orphans.push(...(await collectOrphanedMcpEntries(harnessId, root, ownedRegionKeys)));
    }
  }

  return orphans;
};

const detectOrphanedMcpEntries = async (options: {
  readonly prismHome: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly roots?: HarnessRootsEnv;
}): Promise<DoctorFinding[]> => {
  const orphans = await collectAllOrphanedMcpEntries(options);
  return orphans.map((orphan) => finding({
    severity: "warning",
    family: "namespace.stray",
    code: "namespace.unowned-mcp-entry",
    message: `Prism-fingerprinted MCP entry '${orphan.serverKey}' in ${orphan.configPath} is outside every owned patch region`,
    harness: orphan.harness,
    path: orphan.configPath,
    fix: "gc",
    data: { serverKey: orphan.serverKey, regionKey: orphan.regionKey },
  }));
};

const runOrphanedMcpEntryFix = async (options: {
  readonly prismHome: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly roots?: HarnessRootsEnv;
}): Promise<DoctorFinding[]> => {
  const orphans = await collectAllOrphanedMcpEntries(options);
  const findings: DoctorFinding[] = [];
  for (const orphan of orphans) {
    const result = await pruneOrphanedMcpEntry(orphan);
    if (!result.pruned) continue;
    findings.push(finding({
      severity: "info",
      family: "namespace.stray",
      code: "namespace.mcp-entry-pruned",
      message: `Pruned orphaned Prism-fingerprinted MCP entry '${result.serverKey}' from ${result.configPath}`,
      harness: result.harness,
      path: result.configPath,
      data: { serverKey: result.serverKey },
    }));
  }
  return findings;
};

const generatedConfigPathExists = async (
  path: string,
): Promise<boolean> => exists(expandPath(path));

/**
 * Doctor's per-harness MCP validation, migrated to the stdio-shim-only world
 * (overhaul: HTTP transport retired, `stdio-shim` is the only transport).
 * Every shim harness registers the shim under `shimServerKey(harness)` with
 * exactly `{ command, args: ["mcp", "shim"], env: { PRISM_SHIM_* } }` (see
 * `packages/prism-sdk/src/mcp/wire-naming.ts` and each lowerer's
 * `planMcpServer`/shim branch) -- there is no more port, url, or HTTP
 * headers to validate. This section validates a harness's on-disk MCP
 * server entry against that exact contract, the same one the lowerers emit.
 *
 * `command` is no longer always the literal `"prism"`: the compiler stamps
 * the binary that ran the compile (`shim-command.ts`'s
 * `shimCommandForCompile`), so a dev compile (`prism-dev`, or any other
 * compiled-binary name) carries its own absolute self path instead. Doctor
 * accepts both shapes.
 */

/** `p_<hash8>_` -- the fixed-width namespace segment every wire name carries (see `canonicalNamespace`). */
const WIRE_NAME_NAMESPACE = /p_[0-9a-f]{8}_/u;

/**
 * "Resolvable" here means shape-correct, not PATH-resolved: the literal
 * token `"prism"` is always accepted without a PATH lookup, so doctor stays
 * non-flaky in a dev loop that runs against an uninstalled checkout. A
 * path-shaped command (containing a separator) must additionally have a
 * basename starting with `prism` (the self-stamped dev-binary shape) and
 * exist on disk -- catching both a genuine stale remnant (e.g. a leftover
 * `bun`/`node` + missing bundle path from the retired per-plugin HTTP
 * daemon) and an unrelated absolute path that happens to exist.
 */
const isResolvablePrismShimCommand = async (command: unknown): Promise<boolean> => {
  if (typeof command !== "string" || command.length === 0) return false;
  if (command === "prism") return true;
  if (command.includes("/") || command.includes("\\")) {
    if (!basename(command).toLowerCase().startsWith("prism")) return false;
    return generatedConfigPathExists(command);
  }
  return false;
};

const hasStdioShimArgs = (args: unknown): boolean =>
  Array.isArray(args) && args.includes("mcp") && args.includes("shim");

const shimServerEnv = (server: Record<string, unknown>): Record<string, unknown> | undefined => {
  const env = server.env;
  return env && typeof env === "object" && !Array.isArray(env) ? (env as Record<string, unknown>) : undefined;
};

/**
 * True precondition for "this owner plugin can serve MCP tools right now" --
 * grounded in `resolveOrSpawnDaemon`
 * (packages/prism-sdk/src/mcp/daemon-resolver.ts, `mcp-shim-plugin-bundle-missing`
 * grounding pass, 2026-07-07): the per-plugin UDS daemon architecture keeps
 * NO artifact at rest once a daemon is live. `prismMcpServerPath`'s
 * `server.mjs` is written once by compile (`src/compile/pipeline.ts`'s
 * `prepareUnionMcpServer` -> `writePrismMcpServerBundle`) and is read back
 * exactly once, by `resolveOrSpawnDaemon`, to SPAWN a fresh `bun <bundle>`
 * daemon -- it throws `DaemonResolveError` ("cannot spawn: unable to
 * locate/read compiled bundle") only when it is about to spawn and finds
 * nothing to read. But that same module's `isBundleStale` treats an
 * unreadable bundle as "unknown, not proven stale" for an *already-live*
 * registered daemon: a `bun <bundle>` process that already started keeps
 * serving over its UDS socket with no bundle file on disk at all, and a
 * live daemon is deliberately never torn down just because compile output
 * was pruned/relocated out from under it. So a plugin is servable when
 * EITHER the bundle exists (a fresh daemon can be spawned) OR the UDS
 * registry names a daemon that is still live (nothing to spawn --
 * already running); neither holding is the one state that is genuinely
 * broken. A plugin that has simply never been spawned yet (no registry
 * entry at all, bundle present) is intentionally NOT this state -- lazy
 * first-spawn is healthy, matching `mcp.health`'s own "stopped" bucket in
 * `src/mcp/lifecycle.ts`'s `classifyStatus`, which treats an absent
 * registry entry as non-fatal by the same reasoning.
 */
/**
 * Injectable seam for `pluginIsServable`'s two UDS lookups. `getDaemon`
 * (`@skastr0/prism-sdk/mcp/uds-registry`) resolves its registry root via
 * `node:os`'s `homedir()`, which -- unlike `prismHome` -- Bun resolves once
 * at process start and never re-reads from a test's mutated
 * `process.env.HOME`; a real-function test would silently read/write the
 * *actual invoking machine's* `~/.prism/runtime/mcp`, not a hermetic
 * fixture. Tests inject fakes here instead of touching real machine state;
 * every production call site omits this and gets the real functions.
 */
export interface PluginServableDeps {
  readonly getDaemon?: typeof getDaemon;
  readonly probeSocketLiveness?: typeof probeSocketLiveness;
}

export const pluginIsServable = async (
  prismHome: string,
  pluginName: string,
  deps: PluginServableDeps = {},
): Promise<boolean> => {
  if (await generatedConfigPathExists(prismMcpServerPath(prismHome, pluginName))) return true;
  const resolveDaemon = deps.getDaemon ?? ((plugin: string) => getDaemon(plugin, prismHome));
  const probeLiveness = deps.probeSocketLiveness ?? probeSocketLiveness;
  const registered = await resolveDaemon(pluginName);
  if (registered.kind !== "ok") return false;
  return (await probeLiveness(registered.value.sock)) === "live";
};

const missingShimPluginBundles = async (
  prismHome: string,
  pluginsCsv: string,
): Promise<string[]> => {
  const names = pluginsCsv.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  const missing: string[] = [];
  for (const pluginName of names) {
    if (!(await pluginIsServable(prismHome, pluginName))) missing.push(pluginName);
  }
  return missing;
};

interface StdioShimVerdict {
  readonly commandResolvable: boolean;
  readonly argsValid: boolean;
  readonly envHarnessMatches: boolean;
  readonly envPluginsPresent: boolean;
  readonly missingPluginBundles: ReadonlyArray<string>;
  readonly invalidAllowlistEntries: ReadonlyArray<string>;
}

/**
 * Evaluates one harness's on-disk stdio-shim MCP server entry against the
 * lowerer contract. Returns a plain verdict rather than `DoctorFinding[]` so
 * every call site can emit its own static, double-quoted finding code (the
 * `finding-catalog.test.ts` meta-test greps `doctor.ts` for exactly that
 * literal shape, so a code built from a template-literal variable would
 * silently escape the catalog-completeness check).
 */
const evaluateStdioShimServerEntry = async (options: {
  readonly harness: HarnessId;
  readonly server: Record<string, unknown>;
  readonly prismHome: string;
  readonly allowlist?: ReadonlyArray<string>;
}): Promise<StdioShimVerdict> => {
  const env = shimServerEnv(options.server);
  const pluginsRaw = env?.PRISM_SHIM_PLUGINS;
  const envPluginsPresent = typeof pluginsRaw === "string" && pluginsRaw.trim().length > 0;
  return {
    commandResolvable: await isResolvablePrismShimCommand(options.server.command),
    argsValid: hasStdioShimArgs(options.server.args),
    envHarnessMatches: env?.PRISM_SHIM_HARNESS === options.harness,
    envPluginsPresent,
    missingPluginBundles: envPluginsPresent
      ? await missingShimPluginBundles(options.prismHome, pluginsRaw as string)
      : [],
    invalidAllowlistEntries: (options.allowlist ?? []).filter((entry) => !WIRE_NAME_NAMESPACE.test(entry)),
  };
};

/** Shared finding builder: every stdio-shim call site reports the same six checks under the same codes. */
const findingsFromStdioShimVerdict = (
  verdict: StdioShimVerdict,
  options: {
    readonly harness: HarnessId;
    readonly serverName: string;
    readonly path: string;
    readonly root?: string;
  },
): DoctorFinding[] => {
  const base = {
    family: "harness.config" as const,
    harness: options.harness,
    path: options.path,
    fix: "refresh" as const,
    ...(options.root ? { root: options.root } : {}),
  };
  const findings: DoctorFinding[] = [];
  if (!verdict.commandResolvable) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-command-unresolvable",
      message: `${options.harness} MCP server '${options.serverName}' command does not resolve to a prism binary`,
    }));
  }
  if (!verdict.argsValid) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-args-invalid",
      message: `${options.harness} MCP server '${options.serverName}' args do not invoke 'prism mcp shim'`,
    }));
  }
  if (!verdict.envHarnessMatches) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-env-harness-mismatch",
      message: `${options.harness} MCP server '${options.serverName}' env.PRISM_SHIM_HARNESS is missing or does not match '${options.harness}'`,
    }));
  }
  if (!verdict.envPluginsPresent) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-env-plugins-missing",
      message: `${options.harness} MCP server '${options.serverName}' is missing env.PRISM_SHIM_PLUGINS`,
    }));
  }
  if (verdict.missingPluginBundles.length > 0) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-plugin-bundle-missing",
      message: `${options.harness} MCP server '${options.serverName}' references owner plugin(s) with no compiled MCP bundle and no live daemon: ${verdict.missingPluginBundles.join(", ")}`,
      data: { missingPluginBundles: verdict.missingPluginBundles },
    }));
  }
  if (verdict.invalidAllowlistEntries.length > 0) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-allowlist-invalid",
      message: `${options.harness} MCP server '${options.serverName}' allowlist entries do not match the stdio-shim wire naming: ${verdict.invalidAllowlistEntries.join(", ")}`,
      data: { invalidAllowlistEntries: verdict.invalidAllowlistEntries },
    }));
  }
  return findings;
};

const validateStdioShimServerEntry = async (options: {
  readonly harness: HarnessId;
  readonly path: string;
  readonly root?: string;
  readonly serverName: string;
  readonly server: Record<string, unknown>;
  readonly prismHome: string;
  readonly allowlist?: ReadonlyArray<string>;
}): Promise<DoctorFinding[]> => {
  const verdict = await evaluateStdioShimServerEntry(options);
  return findingsFromStdioShimVerdict(verdict, options);
};

// ---------------------------------------------------------------------------
// Per-plugin server entries — codex-cli / hermes / cursor (the
// single-config-file family). One MCP-owning plugin, one server entry keyed
// by `pluginServerKey(plugin)`, advertising bare wire names (no `p_<hash8>_`
// namespace prefix — see `packages/prism-sdk/src/mcp/wire-naming.ts`'s
// per-plugin naming section and each lowerer's `planMcpServer`). This is a
// parallel verdict to `evaluateStdioShimServerEntry` above (never reused by
// it) because the two schemes disagree on what "valid" means for
// `PRISM_SHIM_PLUGINS` (exactly one plugin vs. a union) and for allowlist
// shape (bare vs. `p_<hash8>_`-namespaced) — grok and claude-code still use
// the aggregated scheme unchanged.
// ---------------------------------------------------------------------------

/** Detects a Prism-managed shim entry regardless of server key, so a foreign hand-authored MCP server is never touched. */
const isPrismShimServerEntry = (server: Record<string, unknown>): boolean => {
  if (server.command === "prism") return true;
  const env = shimServerEnv(server);
  return typeof env?.PRISM_SHIM_HARNESS === "string";
};

interface PerPluginShimVerdict {
  readonly commandResolvable: boolean;
  readonly argsValid: boolean;
  readonly envHarnessMatches: boolean;
  readonly envNamingMatches: boolean;
  readonly envPluginMatches: boolean;
  readonly serverKeyMatches: boolean;
  readonly missingPluginBundle: boolean;
}

/**
 * Evaluates one per-plugin server entry: `serverKey` is the map key this
 * entry was found under, `expectedPlugin` is `undefined` when
 * `PRISM_SHIM_PLUGINS` does not resolve to exactly one plugin name (already
 * a defect worth its own finding, so no plugin-scoped checks — bundle
 * presence, server-key identity — can run).
 */
const evaluatePerPluginShimServerEntry = async (options: {
  readonly harness: HarnessId;
  readonly serverKey: string;
  readonly server: Record<string, unknown>;
  readonly prismHome: string;
}): Promise<PerPluginShimVerdict> => {
  const env = shimServerEnv(options.server);
  const pluginsRaw = typeof env?.PRISM_SHIM_PLUGINS === "string" ? env.PRISM_SHIM_PLUGINS.trim() : "";
  const plugins = pluginsRaw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  const expectedPlugin = plugins.length === 1 ? plugins[0] : undefined;
  return {
    commandResolvable: await isResolvablePrismShimCommand(options.server.command),
    argsValid: hasStdioShimArgs(options.server.args),
    envHarnessMatches: env?.PRISM_SHIM_HARNESS === options.harness,
    envNamingMatches: env?.PRISM_SHIM_NAMING === "per-plugin",
    envPluginMatches: expectedPlugin !== undefined,
    serverKeyMatches: expectedPlugin !== undefined && options.serverKey === pluginServerKey(expectedPlugin),
    missingPluginBundle:
      expectedPlugin !== undefined && !(await pluginIsServable(options.prismHome, expectedPlugin)),
  };
};

const findingsFromPerPluginShimVerdict = (
  verdict: PerPluginShimVerdict,
  options: { readonly harness: HarnessId; readonly serverKey: string; readonly path: string; readonly root?: string },
): DoctorFinding[] => {
  const base = {
    family: "harness.config" as const,
    harness: options.harness,
    path: options.path,
    fix: "refresh" as const,
    ...(options.root ? { root: options.root } : {}),
  };
  const findings: DoctorFinding[] = [];
  if (!verdict.commandResolvable) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-command-unresolvable",
      message: `${options.harness} MCP server '${options.serverKey}' command does not resolve to a prism binary`,
    }));
  }
  if (!verdict.argsValid) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-args-invalid",
      message: `${options.harness} MCP server '${options.serverKey}' args do not invoke 'prism mcp shim'`,
    }));
  }
  if (!verdict.envHarnessMatches) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-env-harness-mismatch",
      message: `${options.harness} MCP server '${options.serverKey}' env.PRISM_SHIM_HARNESS is missing or does not match '${options.harness}'`,
    }));
  }
  if (!verdict.envNamingMatches) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-per-plugin-naming-missing",
      message: `${options.harness} MCP server '${options.serverKey}' is missing env.PRISM_SHIM_NAMING=per-plugin`,
    }));
  }
  if (!verdict.envPluginMatches) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-per-plugin-plugin-mismatch",
      message: `${options.harness} MCP server '${options.serverKey}' env.PRISM_SHIM_PLUGINS must name exactly one owner plugin`,
    }));
  } else if (!verdict.serverKeyMatches) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-per-plugin-plugin-mismatch",
      message: `${options.harness} MCP server '${options.serverKey}' key does not match its own PRISM_SHIM_PLUGINS owner`,
    }));
  }
  if (verdict.missingPluginBundle) {
    findings.push(finding({
      ...base,
      severity: "error",
      code: "config.mcp-shim-plugin-bundle-missing",
      message: `${options.harness} MCP server '${options.serverKey}' references an owner plugin with no compiled MCP bundle and no live daemon`,
    }));
  }
  return findings;
};

/**
 * The retired aggregated-shim key (`prism-mcp-shim`) surviving under the
 * per-plugin scheme is a migration artifact, not live config: no lowerer for
 * this harness family emits it anymore, so it is never re-validated against
 * either verdict — only flagged. `fix: "manual"` because no plugin's own
 * compile is scoped to prune a key it never owned; a plain refresh will not
 * touch this key, so the operator removes it by hand once migrated.
 */
const legacyAggregatedShimFinding = (options: {
  readonly harness: HarnessId;
  readonly serverKey: string;
  readonly path: string;
  readonly root?: string;
}): DoctorFinding =>
  finding({
    family: "harness.config",
    severity: "warning",
    code: "config.mcp-shim-legacy-aggregated-entry",
    message: `${options.harness} MCP config still carries the retired aggregated shim entry '${options.serverKey}' — this harness now renders one server per owner plugin`,
    harness: options.harness,
    path: options.path,
    fix: "manual",
    ...(options.root ? { root: options.root } : {}),
  });

const validatePerPluginShimServerEntry = async (options: {
  readonly harness: HarnessId;
  readonly serverKey: string;
  readonly path: string;
  readonly root?: string;
  readonly server: Record<string, unknown>;
  readonly prismHome: string;
}): Promise<DoctorFinding[]> => {
  const verdict = await evaluatePerPluginShimServerEntry(options);
  return findingsFromPerPluginShimVerdict(verdict, options);
};

/**
 * Validates every entry under a single-config-file harness's `mcp_servers`
 * (or `mcpServers`) map for the codex/hermes/cursor per-plugin scheme: the
 * legacy aggregated key gets the OLD generic verdict (unchanged shape checks)
 * plus a migration advisory, every other Prism-shaped entry gets the new
 * per-plugin verdict, and anything that isn't Prism-managed is left alone.
 */
const validatePerPluginShimServerMap = async (options: {
  readonly harness: HarnessId;
  readonly path: string;
  readonly root?: string;
  readonly servers: Record<string, unknown>;
  readonly prismHome: string;
  /** Codex only: non-array `enabled_tools` is its own distinct defect. */
  readonly onEnabledToolsNotArray?: (serverKey: string, server: Record<string, unknown>) => DoctorFinding | undefined;
}): Promise<DoctorFinding[]> => {
  const findings: DoctorFinding[] = [];
  const legacyKey = shimServerKey(options.harness as ShimHarnessId);
  for (const [serverKey, raw] of Object.entries(options.servers)) {
    if (!raw || typeof raw !== "object") continue;
    const server = raw as Record<string, unknown>;
    // The legacy key is a deterministic, Prism-assigned name — anything
    // found under it is presumed Prism's regardless of shape (a corrupted
    // remnant still needs every shape check to fire). Any OTHER key is only
    // treated as Prism-managed when it looks like a shim entry, so a
    // foreign hand-authored MCP server is never touched.
    if (serverKey !== legacyKey && !isPrismShimServerEntry(server)) continue;

    const enabledToolsFinding = options.onEnabledToolsNotArray?.(serverKey, server);
    if (enabledToolsFinding) findings.push(enabledToolsFinding);

    if (serverKey === legacyKey) {
      // Every legacy-key call site (codex's TOML `enabled_tools`, hermes's
      // synthesized `enabled_tools` from its YAML `tools.include`) exposes
      // the allowlist as this same field on the server object; cursor's
      // shim entry never had one.
      const allowlist = Array.isArray(server.enabled_tools)
        ? server.enabled_tools.filter((tool): tool is string => typeof tool === "string")
        : undefined;
      findings.push(
        ...(await validateStdioShimServerEntry({
          harness: options.harness,
          path: options.path,
          serverName: serverKey,
          server,
          prismHome: options.prismHome,
          ...(allowlist ? { allowlist } : {}),
          ...(options.root ? { root: options.root } : {}),
        })),
      );
      findings.push(legacyAggregatedShimFinding({
        harness: options.harness,
        serverKey,
        path: options.path,
        ...(options.root ? { root: options.root } : {}),
      }));
      continue;
    }

    findings.push(
      ...(await validatePerPluginShimServerEntry({
        harness: options.harness,
        serverKey,
        path: options.path,
        server,
        prismHome: options.prismHome,
        ...(options.root ? { root: options.root } : {}),
      })),
    );
  }
  return findings;
};

const pathFromCommandString = (command: string): string | undefined => {
  const match = command.match(/(?:node|bun)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u);
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

/**
 * Grok registers the stdio shim inside `<grok-root>/config.toml` — the only
 * MCP source grok actually resolves for installed plugins — under ONE
 * `[mcp_servers.<pluginServerKey(owner)>]` entry PER MCP-owning plugin (a
 * Prism-managed marker region each), not a single shared key. There is no
 * fixed key to look up, so every `mcp_servers` entry is scanned and any that
 * carries a Prism shim marker — `command == "prism"` or an
 * `env.PRISM_SHIM_HARNESS` key present (even on an otherwise-broken entry
 * with a corrupted command) — is validated against the stdio-shim contract.
 * An entry with neither signal is a user's own server (Linear, Sentry, ...)
 * and is left alone. There is no per-tool allowlist in the server table
 * (agent frontmatter `tools:` gates exposure).
 */
const validateGrokConfigReferences = async (
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
  const mcpServers = parsed.mcp_servers;
  if (!mcpServers || typeof mcpServers !== "object") return [];
  const findings: DoctorFinding[] = [];
  for (const [serverName, raw] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const server = raw as Record<string, unknown>;
    const env = shimServerEnv(server);
    const looksLikePrismShim = server.command === "prism" || env?.PRISM_SHIM_HARNESS !== undefined;
    if (!looksLikePrismShim) continue;
    findings.push(
      ...(await validateStdioShimServerEntry({
        harness: "grok",
        path,
        serverName,
        server,
        prismHome,
      })),
    );
  }
  return findings;
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
    findings.push(
      ...(await validatePerPluginShimServerMap({
        harness: "codex-cli",
        path,
        servers: mcpServers as Record<string, unknown>,
        prismHome,
        onEnabledToolsNotArray: (serverKey, server) =>
          "enabled_tools" in server && !Array.isArray(server.enabled_tools)
            ? finding({
                severity: "error",
                family: "harness.config",
                code: "config.codex-enabled-tools-invalid",
                message: `Codex MCP server '${serverKey}' has non-array enabled_tools`,
                harness: "codex-cli",
                path,
                fix: "refresh",
              })
            : undefined,
      })),
    );
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

const OPEN_CODE_BUNDLE_SUFFIX = join("dist", "server.mjs");

// opencode.json entries may already target the bundle file directly (the
// bundling consolidation writes `file:///.../dist/server.mjs`), or, for
// legacy directory-form entries, target the plugin root. Only append the
// bundle-relative path in the latter case, or callers double it into
// `.../dist/server.mjs/dist/server.mjs`.
const openCodeBundlePathFor = (pluginPath: string): string =>
  pluginPath.endsWith(OPEN_CODE_BUNDLE_SUFFIX) ? pluginPath : join(pluginPath, "dist", "server.mjs");

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
    const serverPath = openCodeBundlePathFor(pluginPath);
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

/** Mirrors the claude-code lowerer's `generatedPluginId` prefix (`prism-generated-<plugin>`). */
const CLAUDE_GENERATED_PLUGIN_PREFIX = "prism-generated-";

/**
 * Per-plugin server shape: a generated plugin bundle's `.mcp.json` (when
 * present at all — a pure consumer plugin has none, see the claude-code
 * lowerer's `planMcpServer`) registers exactly one server, keyed by
 * `pluginServerKey` of the SOURCE plugin the bundle was generated from — not
 * the shared `shimServerKey("claude-code")` the retired aggregated shape
 * used. `generatedPluginDirName` is that bundle directory's own basename
 * (`prism-generated-<plugin>`), so stripping the fixed prefix recovers the
 * same plugin-name input the lowerer fed `pluginServerKey` at compile time.
 */
const validateClaudeGeneratedPlugin = async (
  root: string,
  pluginRoot: string,
  prismHome: string,
  generatedPluginDirName: string,
): Promise<DoctorFinding[]> => {
  const findings: DoctorFinding[] = [];
  const mcpPath = join(pluginRoot, ".mcp.json");
  if (await exists(mcpPath)) {
    try {
      const parsed = JSON.parse(await readFile(mcpPath)) as {
        readonly mcpServers?: Record<string, Record<string, unknown>>;
      };
      const sourcePluginName = generatedPluginDirName.startsWith(CLAUDE_GENERATED_PLUGIN_PREFIX)
        ? generatedPluginDirName.slice(CLAUDE_GENERATED_PLUGIN_PREFIX.length)
        : generatedPluginDirName;
      const expectedServerName = pluginServerKey(sourcePluginName);
      const server = parsed.mcpServers?.[expectedServerName];
      if (server && Object.keys(server).length > 0) {
        findings.push(
          ...(await validateStdioShimServerEntry({
            harness: "claude-code",
            root,
            path: mcpPath,
            serverName: expectedServerName,
            server,
            prismHome,
          })),
        );
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
      findings.push(...(await validateClaudeGeneratedPlugin(root, pluginRoot, prismHome, entry)));
    }
  }
  return findings;
};

/**
 * Cursor keeps the shim entry directly under the harness's own shared
 * `mcp.json` (a `json-key` sync region, not a per-generated-plugin file --
 * see `src/compile/lowerers/cursor.ts`), so, unlike the other JSON-based
 * shim harnesses, there is exactly one file and one root to read per scope.
 */
const validateCursorConfigReferences = async (
  path: string,
  root: string,
  prismHome: string,
): Promise<DoctorFinding[]> => {
  if (!(await exists(path))) return [];
  let parsed: { readonly mcpServers?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(await readFile(path));
  } catch (error) {
    return [finding({
      severity: "error",
      family: "harness.config",
      code: "config.mcp-shim-json-invalid",
      message: `Cursor MCP config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      harness: "cursor",
      root,
      path,
      fix: "manual",
    })];
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") return [];
  return validatePerPluginShimServerMap({
    harness: "cursor",
    root,
    path,
    servers: parsed.mcpServers,
    prismHome,
  });
};

/**
 * Antigravity CLI's per-plugin server scheme (operator-locked): a generated
 * plugin bundle's `mcp_config.json` holds exactly one non-empty server, keyed
 * by that bundle's OWN plugin's `pluginServerKey` — never the aggregated
 * `prism-mcp-shim` key, never a multi-plugin `PRISM_SHIM_PLUGINS` re-export
 * closure, never an empty `mcpServers` block (a consumer plugin referencing
 * only foreign owners' tools must have no `mcp_config.json` at all). Mirrors
 * `validateClaudeGeneratedPlugin`'s per-plugin checks, adapted to
 * Antigravity's `plugins/<bundle>/mcp_config.json` shape (see
 * `src/compile/lowerers/antigravity-cli.ts` `planMcpServers`).
 */
const validateAntigravityGeneratedPlugin = async (
  root: string,
  pluginRoot: string,
  prismHome: string,
): Promise<DoctorFinding[]> => {
  const findings: DoctorFinding[] = [];
  const mcpPath = join(pluginRoot, "mcp_config.json");
  if (!(await exists(mcpPath))) return findings;
  let parsed: { readonly mcpServers?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(await readFile(mcpPath)) as {
      readonly mcpServers?: Record<string, Record<string, unknown>>;
    };
  } catch (error) {
    return [finding({
      severity: "error",
      family: "harness.config",
      code: "config.antigravity-mcp-json-invalid",
      message: `Antigravity generated plugin has invalid mcp_config.json: ${error instanceof Error ? error.message : String(error)}`,
      harness: "antigravity-cli",
      root,
      path: mcpPath,
      fix: "refresh",
    })];
  }

  const servers = Object.entries(parsed.mcpServers ?? {});
  if (servers.length === 0) {
    findings.push(finding({
      severity: "error",
      family: "harness.config",
      code: "config.antigravity-mcp-empty-servers",
      message: `Antigravity generated plugin ships an empty mcpServers block (a consumer plugin must have no mcp_config.json): ${mcpPath}`,
      harness: "antigravity-cli",
      root,
      path: mcpPath,
      fix: "refresh",
    }));
  }
  for (const [serverName, server] of servers) {
    if (serverName === shimServerKey("antigravity-cli")) {
      findings.push(finding({
        severity: "error",
        family: "harness.config",
        code: "config.antigravity-mcp-legacy-aggregated-shim",
        message: `Antigravity generated plugin still registers the legacy aggregated '${serverName}' server; per-plugin servers replaced it`,
        harness: "antigravity-cli",
        root,
        path: mcpPath,
        fix: "refresh",
      }));
      continue;
    }
    if (!server || Object.keys(server).length === 0) continue;
    const env = (server.env ?? {}) as Record<string, unknown>;
    const shimPlugins = typeof env.PRISM_SHIM_PLUGINS === "string"
      ? env.PRISM_SHIM_PLUGINS.split(",").map((name) => name.trim()).filter((name) => name.length > 0)
      : [];
    if (
      shimPlugins.length !== 1
      || env.PRISM_SHIM_NAMING !== "per-plugin"
      || pluginServerKey(shimPlugins[0] ?? "") !== serverName
    ) {
      findings.push(finding({
        severity: "error",
        family: "harness.config",
        code: "config.antigravity-mcp-not-per-plugin",
        message: `Antigravity generated plugin server '${serverName}' is not a single-plugin per-plugin shim entry (PRISM_SHIM_NAMING=per-plugin, PRISM_SHIM_PLUGINS naming exactly the owner whose server key is '${serverName}')`,
        harness: "antigravity-cli",
        root,
        path: mcpPath,
        fix: "refresh",
      }));
    }
    findings.push(
      ...(await validateStdioShimServerEntry({
        harness: "antigravity-cli",
        root,
        path: mcpPath,
        serverName,
        server,
        prismHome,
      })),
    );
  }
  return findings;
};

const validateAntigravityGeneratedPluginReferences = async (
  scope: HarnessScope,
  projectPath: string | undefined,
  prismHome: string,
  roots?: HarnessRootsEnv,
): Promise<DoctorFinding[]> => {
  const rootsList = rootsForHarness("antigravity-cli", scope, projectPath, roots);
  const findings: DoctorFinding[] = [];
  for (const root of rootsList) {
    const pluginsRoot = join(root, "plugins");
    if (!(await exists(pluginsRoot))) continue;
    for (const entry of await listDir(pluginsRoot)) {
      if (!entry.startsWith("prism-generated-")) continue;
      findings.push(
        ...(await validateAntigravityGeneratedPlugin(root, join(pluginsRoot, entry), prismHome)),
      );
    }
  }
  return findings;
};

/**
 * Kimi Code and Factory Droid each write the (still-aggregated) shim entry
 * into a JSON manifest inside their own generated-plugin directory
 * (mirroring Claude Code's `.mcp.json`, just a different subdir and
 * filename per harness -- see each lowerer's `planMcpServer`/manifest
 * write). One shared reader covers both; only the scan subdir, config
 * filename, and (for Kimi) the allowlist field name differ. Antigravity CLI
 * has its own per-plugin-scheme reader above
 * (`validateAntigravityGeneratedPluginReferences`) now that its lowerer has
 * migrated off this aggregated shape.
 */
const validateGeneratedPluginMcpReferences = async (options: {
  readonly harness: ShimHarnessId;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly roots?: HarnessRootsEnv;
  readonly prismHome: string;
  readonly pluginsSubdir: string;
  readonly configFileName: string;
  readonly allowlistField?: string;
}): Promise<DoctorFinding[]> => {
  const rootsList = rootsForHarness(options.harness, options.scope, options.projectPath, options.roots);
  const findings: DoctorFinding[] = [];
  const serverName = shimServerKey(options.harness);
  for (const root of rootsList) {
    const pluginsRoot = join(root, options.pluginsSubdir);
    if (!(await exists(pluginsRoot))) continue;
    for (const entry of await listDir(pluginsRoot)) {
      if (!entry.startsWith("prism-generated-")) continue;
      const configPath = join(pluginsRoot, entry, options.configFileName);
      if (!(await exists(configPath))) continue;
      let parsed: { readonly mcpServers?: Record<string, Record<string, unknown>> };
      try {
        parsed = JSON.parse(await readFile(configPath));
      } catch (error) {
        findings.push(finding({
          severity: "error",
          family: "harness.config",
          code: "config.mcp-shim-json-invalid",
          message: `${options.harness} generated plugin has invalid ${options.configFileName}: ${error instanceof Error ? error.message : String(error)}`,
          harness: options.harness,
          root,
          path: configPath,
          fix: "refresh",
        }));
        continue;
      }
      const server = parsed.mcpServers?.[serverName];
      if (!server || Object.keys(server).length === 0) continue;
      const allowlistRaw = options.allowlistField ? server[options.allowlistField] : undefined;
      const allowlist = Array.isArray(allowlistRaw)
        ? allowlistRaw.filter((tool): tool is string => typeof tool === "string")
        : undefined;
      findings.push(
        ...(await validateStdioShimServerEntry({
          harness: options.harness,
          root,
          path: configPath,
          serverName,
          server,
          prismHome: options.prismHome,
          allowlist,
        })),
      );
    }
  }
  return findings;
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

const yamlSiblingBlock = (lines: ReadonlyArray<string>, startIndex: number, indent: number): string[] => {
  const block: string[] = [];
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    if (line.trim().startsWith("#")) continue;
    if (indentOf(line) <= indent) break;
    block.push(line);
  }
  return block;
};

const yamlUnquote = (value: string): string =>
  value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;

const yamlScalarValue = (lines: ReadonlyArray<string>, indent: number, key: string): string | undefined => {
  const line = lines.find((entry) => indentOf(entry) === indent && entry.trim().startsWith(`${key}:`));
  if (!line) return undefined;
  const value = line.trim().slice(key.length + 1).trim();
  return value.length > 0 ? yamlUnquote(value) : undefined;
};

const yamlChildBlock = (
  lines: ReadonlyArray<string>,
  indent: number,
  key: string,
): string[] => {
  const keyIndex = lines.findIndex((line) => indentOf(line) === indent && line.trim() === `${key}:`);
  return keyIndex === -1 ? [] : yamlSiblingBlock(lines, keyIndex + 1, indent);
};

/**
 * Sequence items following `${key}:` at `indent`. YAML block sequences may
 * sit flush with their key (`args:\n    - mcp`) or indented one level past
 * it (`args:\n      - mcp`) -- both are the same document to any real YAML
 * parser. Confirmed live on this machine: Hermes itself re-serializes its
 * own `config.yaml` on write and normalizes list items to the same column as
 * `args:`/`include:`, not one level deeper, which is the shape
 * `renderHermesOwnerMcpServerYaml` (`src/compile/lowerers/hermes.ts`)
 * literally emits before Hermes ever touches the file. `yamlChildBlock`'s
 * sibling-block reader requires the item indent to be strictly deeper than
 * the key, so it read a real, valid `args: [mcp, shim]` in the flush-column
 * shape as `[]` -- turning a healthy live config into a false
 * `config.mcp-shim-args-invalid` finding. This reader accepts either shape.
 */
const yamlSequenceItems = (
  lines: ReadonlyArray<string>,
  indent: number,
  key: string,
): string[] => {
  const keyIndex = lines.findIndex((line) => indentOf(line) === indent && line.trim() === `${key}:`);
  if (keyIndex === -1) return [];
  const items: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    if (indentOf(line) < indent) break;
    if (!line.trim().startsWith("- ")) break;
    items.push(yamlUnquote(line.trim().slice(2).trim()));
  }
  return items;
};

/** Every top-level `<key>:` mapping name directly under `mcp_servers:` (indent 2). */
const yamlChildKeyNames = (lines: ReadonlyArray<string>, indent: number): string[] => {
  const names: string[] = [];
  for (const line of lines) {
    if (indentOf(line) !== indent) continue;
    const match = line.trim().match(/^([^\s:]+):\s*$/u);
    if (match) names.push(match[1]!);
  }
  return names;
};

const validateHermesConfigReferences = async (
  path: string,
  prismHome: string,
): Promise<DoctorFinding[]> => {
  if (!(await exists(path))) return [];
  const lines = (await readFile(path)).split("\n");
  const rootBlock = yamlChildBlock(lines, 0, "mcp_servers");
  if (rootBlock.length === 0) return [];

  const servers: Record<string, unknown> = {};
  for (const serverKey of yamlChildKeyNames(rootBlock, 2)) {
    const serverBlock = yamlChildBlock(rootBlock, 2, serverKey);
    if (serverBlock.length === 0) continue;
    const envBlock = yamlChildBlock(serverBlock, 4, "env");
    const toolsBlock = yamlChildBlock(serverBlock, 4, "tools");
    const includeItems = yamlSequenceItems(toolsBlock, 6, "include");
    const allowlist = includeItems.length > 0 ? includeItems : undefined;
    servers[serverKey] = {
      command: yamlScalarValue(serverBlock, 4, "command"),
      args: yamlSequenceItems(serverBlock, 4, "args"),
      env: {
        PRISM_SHIM_HARNESS: yamlScalarValue(envBlock, 6, "PRISM_SHIM_HARNESS"),
        PRISM_SHIM_PLUGINS: yamlScalarValue(envBlock, 6, "PRISM_SHIM_PLUGINS"),
        PRISM_SHIM_NAMING: yamlScalarValue(envBlock, 6, "PRISM_SHIM_NAMING"),
      },
      // Normalized onto the same `enabled_tools` field codex/cursor's real
      // parsed objects already carry, so the legacy-key branch inside
      // `validatePerPluginShimServerMap` can read every harness's allowlist
      // the same way regardless of source config shape.
      ...(allowlist ? { enabled_tools: allowlist } : {}),
    };
  }

  return validatePerPluginShimServerMap({
    harness: "hermes",
    path,
    servers,
    prismHome,
  });
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
    case "hermes":
      return path ? validateHermesConfigReferences(path, options.prismHome) : [];
    case "cursor": {
      const root = rootForHarness(options.harness, options.scope, options.projectPath, options.roots);
      return path && root ? validateCursorConfigReferences(path, root, options.prismHome) : [];
    }
    case "grok":
      return path ? validateGrokConfigReferences(path, options.prismHome) : [];
    case "antigravity-cli":
      return validateAntigravityGeneratedPluginReferences(
        options.scope,
        options.projectPath,
        options.prismHome,
        options.roots,
      );
    case "factory-droid":
      return validateGeneratedPluginMcpReferences({
        harness: "factory-droid",
        scope: options.scope,
        projectPath: options.projectPath,
        roots: options.roots,
        prismHome: options.prismHome,
        pluginsSubdir: "plugins",
        configFileName: "mcp.json",
      });
    case "kimi-code":
      return validateGeneratedPluginMcpReferences({
        harness: "kimi-code",
        scope: options.scope,
        projectPath: options.projectPath,
        roots: options.roots,
        prismHome: options.prismHome,
        pluginsSubdir: join("plugins", "managed"),
        configFileName: "kimi.plugin.json",
        allowlistField: "enabledTools",
      });
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
        path: status.descriptor.serverPath,
        fix: "mcp-restart",
        data: {
          serverName: status.descriptor.serverName,
          staleReasons: status.staleReasons,
          // Where to read this daemon's own diagnostics (OBS-001
          // acceptance: doctor must be able to point at the log path).
          ...(status.descriptor.logPath ? { logPath: status.descriptor.logPath } : {}),
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

// ---------------------------------------------------------------------------
// topology.* — the per-plugin MCP topology invariants (assertions A-F),
// shared with the `mcp-topology-verify` acceptance gate via
// `./doctor/mcp-topology-checks.js` (one source of truth, two surfaces: this
// is the runtime-backpressure surface, the acceptance script is the release
// gate). Opt-in on `options.pluginsDir` -- see `DoctorOptions.pluginsDir`'s
// doc comment for why doctor has no default corpus to fall back to.
// ---------------------------------------------------------------------------

/** How `doctor --fix` (i.e. `prism refresh`) is expected to resolve each assertion family's violations. */
const TOPOLOGY_ASSERTION_FIX: Record<McpTopologyAssertion, DoctorFinding["fix"]> = {
  A: "manual", // retired/foreign-looking server key -- refresh never renames or removes a key it doesn't recognize as its own
  B: "refresh", // owner/allowlist drift from the compiler's own canonical shape -- a refresh recomputes and rewrites it
  C: "refresh", // stale server for a plugin that lost its MCP ownership -- the next refresh's sync-prune removes it
  D: "manual", // duplicate/orphaned generated bundle directories -- refresh does not delete a stray bundle dir it doesn't own
  E: "refresh", // owner plugin missing its server entry -- refresh compiles and adds it
  F: "manual", // dead HTTP transport remnant from the retired transport -- no lowerer emits or removes this shape anymore
};

const findingFromTopologyViolation = (violation: McpTopologyViolation): DoctorFinding =>
  finding({
    severity: violation.severity,
    family: "topology.invariant",
    code: violation.code,
    message: violation.message,
    harness: violation.harness,
    fix: TOPOLOGY_ASSERTION_FIX[violation.assertion],
    ...(violation.plugin ? { plugin: violation.plugin } : {}),
    ...(violation.path ? { path: violation.path } : {}),
    ...(violation.data || violation.serverKey
      ? {
          data: {
            assertion: violation.assertion,
            ...(violation.serverKey ? { serverKey: violation.serverKey } : {}),
            ...(violation.data ?? {}),
          },
        }
      : {}),
  });

const validateMcpTopology = async (options: {
  readonly pluginsDir?: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly roots?: HarnessRootsEnv;
}): Promise<DoctorFinding[]> => {
  if (!options.pluginsDir) return [];
  const shimHarnesses = options.harnesses.filter(isShimHarnessId);
  if (shimHarnesses.length === 0) return [];

  const pluginPaths = await discoverPluginPaths(expandPath(options.pluginsDir));
  const inventory = await loadPluginInventory(pluginPaths, shimHarnesses);

  const findings: DoctorFinding[] = [];
  for (const harness of shimHarnesses) {
    const root = rootForHarness(harness, options.scope, options.projectPath, options.roots);
    if (!root) continue;
    const report = await verifyHarnessTopology(harness, root, inventory);
    findings.push(...report.violations.map(findingFromTopologyViolation));
  }
  return findings;
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
  const workflowHarnesses = await detectWorkflowHarnesses({
    harnesses: workflowHarnessIdsForHarnesses(options.harnesses),
  });

  if (options.fix) {
    findings.push(...(await runSnapshotGcFix(options.prismHome)));
    findings.push(...(await runLaunchdResidueFix(options.prismHome)));
    findings.push(...(await runWorkflowStoreRegistryGcFix(options.prismHome)));
    findings.push(
      ...(await runOrphanedMcpEntryFix({
        prismHome: options.prismHome,
        harnesses: options.harnesses,
        scope: options.scope,
        ...(options.projectPath ? { projectPath: options.projectPath } : {}),
        roots: options.roots,
      })),
    );
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
    ...(await validateMcpTopology({
      ...(options.pluginsDir ? { pluginsDir: options.pluginsDir } : {}),
      harnesses: options.harnesses,
      scope: options.scope,
      ...(options.projectPath ? { projectPath: options.projectPath } : {}),
      roots: options.roots,
    })),
  );

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
  findings.push(...(await detectLaunchdResidue(options.prismHome)));
  findings.push(...(await detectWorkflowStoreRegistryResidue(options.prismHome)));
  findings.push(
    ...(await detectOrphanedMcpEntries({
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

  // PQ-159: read-only visibility, never a finding (see DoctorReport.backupRetention doc).
  const backupRetention = await runBackupsSummary(options.prismHome);

  return {
    schema: "prism.doctor.report.v1",
    ...(options.pluginPath ? { pluginPath: options.pluginPath } : {}),
    fix: options.fix,
    ...(options.fix && fixFailed ? { fixFailed } : {}),
    ...(workflowHarnesses.length > 0 ? { workflowHarnesses } : {}),
    findings,
    ...(refresh ? { refresh } : {}),
    ...(backupRetention.count > 0 ? { backupRetention } : {}),
  };
};

export const doctorExitCode = (report: DoctorReport): ExitCode => {
  if (report.fix && (report.fixFailed || (report.refresh && !report.refresh.success))) {
    return EXIT_CODES.environment;
  }
  return report.findings.length === 0 ? EXIT_CODES.success : EXIT_CODES.domainFailure;
};

/** PQ-159: human-readable render of `DoctorReport.backupRetention`. */
const formatBackupRetentionLine = (summary: RunBackupsSummary): string => {
  const megabytes = (summary.totalBytes / (1024 * 1024)).toFixed(1);
  const ageDays =
    summary.oldestAgeMs === undefined
      ? undefined
      : Math.floor(summary.oldestAgeMs / (24 * 60 * 60 * 1000));
  return `INFO backup.retention ${summary.count} run backups kept (${megabytes} MB${ageDays === undefined ? "" : `, oldest ${ageDays}d`})`;
};

export const formatDoctorReport = (report: DoctorReport): string => {
  const lines: string[] = [];
  if (report.findings.length === 0) {
    lines.push(report.fix ? "doctor: clean after fix" : "doctor: clean");
    if (report.backupRetention) lines.push(formatBackupRetentionLine(report.backupRetention));
    return lines.join("\n");
  }
  for (const item of report.findings) {
    const location = [item.harness, item.path].filter(Boolean).join(" ");
    lines.push(`${item.severity.toUpperCase()} ${item.family}/${item.code}${location ? ` ${location}` : ""}`);
    lines.push(`  ${item.message}`);
  }
  if (report.backupRetention) lines.push(formatBackupRetentionLine(report.backupRetention));
  return lines.join("\n");
};
