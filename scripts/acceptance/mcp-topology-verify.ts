/**
 * Acceptance gate: mcp-topology-verify.
 *
 * The DETERMINISTIC falsifier for the per-plugin MCP topology (one MCP
 * server per MCP-owning plugin, per harness, keyed by `pluginServerKey`,
 * never a shared aggregated shim). It reads INSTALLED harness configs —
 * either the real machine's harness roots or `--root <harness>=<path>`
 * overrides for sandboxed use — plus the compiled plugin inventory (the
 * plugin.json corpus passed via `--plugins <dir>`, one level of
 * `plugin.json`-bearing subdirectories, mirroring `discoverPluginPaths`),
 * and asserts six invariants per harness root:
 *
 *   A. Naming        — every prism server key equals `pluginServerKey(owner)`
 *                       recomputed from the installed plugin set; zero
 *                       `prism-mcp-shim` keys, zero `p_<hash8>` keys, zero
 *                       `shim` substrings in any server key.
 *   B. Owned-only     — `PRISM_SHIM_PLUGINS` on a server is exactly its own
 *                       single owner plugin; where the harness allowlists
 *                       tools inside the server's own config entry
 *                       (`toolAllowlist: "within-server"` in
 *                       `src/harness-mcp-contract.ts` — codex-cli, hermes,
 *                       kimi-code), the allowlist equals the owner's own
 *                       tools rendered bare via `renderPluginAllowlist` /
 *                       `renderPluginWire` — never a hand-maintained list.
 *   C. No consumers   — a plugin with zero owned MCP tools gets no server
 *                       entry; no within-server harness carries a 0-tool
 *                       (empty-allowlist) server.
 *   D. No duplication — one server entry per owner plugin per harness root;
 *                       no fully-qualified `<server>::<tool>` name repeats.
 *   E. Coverage       — every owner plugin whose `plugin.json` `targets.tools`
 *                       names a harness has a server present in that
 *                       harness's root.
 *   F. No dead        — zero prism-looking entries carrying an HTTP `url`
 *      transports        transport anywhere in a scanned servers map (Prism
 *                       is stdio-only: `command: "prism", args: ["mcp",
 *                       "shim"]`).
 *
 * Scope boundary (documented, not silently narrowed): "the owner's own
 * tools" in assertion B is the plugin's own canonical tools
 * (`tools/*.tool.ts`, whose file stem IS the tool name — enforced by the
 * compiler at `src/compile/load.ts`), not synthetic contract-dispatch
 * bindings pulled in via agent composition. Verifying those would require
 * running the full compose/registry pipeline per plugin, which is compile
 * verification, not topology verification. The allowlist check is likewise
 * scoped to harnesses where the allowlist lives INSIDE the server's own
 * config entry (`within-server`); `global-prefixed` harnesses (claude-code,
 * factory-droid, grok) place their allowlist in agent frontmatter, a
 * separate artifact family this topology scan does not read.
 *
 * Two run modes:
 *
 *   bun scripts/acceptance/mcp-topology-verify.ts
 *     Self-contained acceptance mode (the `acceptance:mcp-topology` script).
 *     Compiles `examples/prism-harness-qa` for real, via the real compile
 *     pipeline, into a sandboxed PRISM_HOME + per-harness temp roots
 *     (`createPrismSandbox`), then verifies the topology invariants against
 *     that real compiled output. Deterministic, CI-safe, never touches a
 *     real harness root.
 *
 *   bun scripts/acceptance/mcp-topology-verify.ts --plugins <dir> \
 *       [--harness <id> ...] [--root <harness>=<path> ...]
 *     Diagnostic mode. Verifies the topology invariants against REAL
 *     installed harness configs (or `--root` overrides for sandboxed use),
 *     treating every `plugin.json`-bearing subdirectory of `<dir>` as the
 *     installed plugin set.
 *
 * Output: a PASS/FAIL line + violation detail per harness, followed by one
 * JSON report `{ schema, harnesses: [{ harness, root, serversFound,
 * violations }], pass }`. Exit 0 iff `pass`.
 */

import { Effect, Layer } from "effect";
import { join, resolve } from "node:path";
import { compilePluginForTarget } from "../../src/compile/pipeline.js";
import { generatedOwnerToolName } from "../../src/compile/generated-plugin.js";
import { exists, expandPath, isDirectory, listDir, readFile } from "../../src/fs.js";
import {
  getHarnessMcpContract,
  type HarnessMcpContract,
} from "../../src/harness-mcp-contract.js";
import { getHarness } from "../../src/harnesses.js";
import { getManifestArtifactTargets, readManifest } from "../../src/manifest.js";
import { discoverPluginPaths } from "../../src/plugin-inventory.js";
import { HarnessRoots, type HarnessRootsEnv } from "../../src/services/prism-env.js";
import { createPrismSandbox } from "../../src/testing/prism-sandbox.js";
import type { HarnessId, PluginManifest } from "../../src/types.js";
import {
  pluginServerKey,
  renderPluginAllowlist,
  SHIM_HARNESS_IDS,
  type ShimHarnessId,
} from "@skastr0/prism-sdk/mcp/wire-naming";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SELF_TEST_PLUGIN_PATH = resolve(REPO_ROOT, "examples", "prism-harness-qa");

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type McpTopologyAssertion = "A" | "B" | "C" | "D" | "E" | "F";

export interface McpTopologyViolation {
  readonly assertion: McpTopologyAssertion;
  readonly code: string;
  readonly harness: HarnessId;
  readonly severity: "error";
  readonly message: string;
  readonly path?: string;
  readonly serverKey?: string;
  readonly plugin?: string;
  readonly data?: Record<string, unknown>;
}

export interface HarnessTopologyReport {
  readonly harness: HarnessId;
  readonly root: string;
  readonly serversFound: number;
  readonly violations: readonly McpTopologyViolation[];
}

export interface TopologyReport {
  readonly schema: "prism.acceptance.mcp-topology-verify.v1";
  readonly harnesses: readonly HarnessTopologyReport[];
  readonly pass: boolean;
}

// ---------------------------------------------------------------------------
// Plugin inventory — the "installed plugin set" every naming assertion
// recomputes against. Own-tool discovery is a directory scan, not a hand
// list: `tools/<name>.tool.ts`'s file stem IS the canonical tool name (the
// compiler rejects any mismatch — src/compile/load.ts's `parseCanonicalTool`
// fails the build if `parsed.name !== fileStem`), so scanning filenames is
// exactly as grounded as parsing the tool source for its `name` field.
// ---------------------------------------------------------------------------

interface PluginRecord {
  readonly name: string;
  readonly ownTools: readonly string[];
  readonly targetedHarnesses: ReadonlySet<ShimHarnessId>;
}

interface PluginInventory {
  readonly all: ReadonlyMap<string, PluginRecord>;
}

const isShimHarnessId = (harness: HarnessId): harness is ShimHarnessId =>
  (SHIM_HARNESS_IDS as readonly HarnessId[]).includes(harness);

const TOOL_SUFFIX = ".tool.ts";

const discoverOwnCanonicalToolNames = async (pluginPath: string): Promise<string[]> => {
  const toolsDir = join(pluginPath, "tools");
  if (!(await isDirectory(toolsDir))) return [];
  const entries = await listDir(toolsDir);
  return entries
    .filter((entry) => entry.endsWith(TOOL_SUFFIX))
    .map((entry) => entry.slice(0, -TOOL_SUFFIX.length))
    .sort((left, right) => left.localeCompare(right));
};

export const loadPluginInventory = async (
  pluginPaths: readonly string[],
): Promise<PluginInventory> => {
  const all = new Map<string, PluginRecord>();
  for (const pluginPath of pluginPaths) {
    let manifest: PluginManifest;
    try {
      manifest = await readManifest(pluginPath);
    } catch {
      // Manifest/layout validity is `prism validate`'s concern, not this
      // topology scan's — an invalid plugin simply contributes nothing to
      // the installed set (fixture corpora like `examples/` deliberately
      // include invalid plugins to exercise that validator elsewhere).
      continue;
    }
    if (all.has(manifest.name)) {
      throw new Error(
        `mcp-topology-verify: duplicate plugin name '${manifest.name}' in the --plugins corpus (${pluginPath})`,
      );
    }
    const ownTools = await discoverOwnCanonicalToolNames(pluginPath);
    const targetedHarnesses = new Set(
      getManifestArtifactTargets(manifest, "tools").filter(isShimHarnessId),
    );
    all.set(manifest.name, { name: manifest.name, ownTools, targetedHarnesses });
  }
  return { all };
};

// ---------------------------------------------------------------------------
// Server-config location per harness — where each harness's lowerer writes
// the per-plugin server entry (cited: each lowerer's `planMcpServer`).
// ---------------------------------------------------------------------------

type HarnessMcpLocation =
  | {
      readonly kind: "single-file";
      readonly relativeConfigPath: string;
      readonly format: "toml" | "json" | "hermes-yaml";
    }
  | {
      readonly kind: "bundle-dirs";
      readonly bundleSubdir: string;
      readonly configFileName: string;
    };

const HARNESS_MCP_LOCATION: Record<ShimHarnessId, HarnessMcpLocation> = {
  // src/compile/lowerers/claude-code.ts `planMcpServer` -> generatedPath -> "skills/<bundle>/.mcp.json"
  "claude-code": { kind: "bundle-dirs", bundleSubdir: "skills", configFileName: ".mcp.json" },
  // src/compile/lowerers/antigravity-cli.ts `writeManifest`/pluginRoot -> "plugins/<bundle>/mcp_config.json"
  "antigravity-cli": { kind: "bundle-dirs", bundleSubdir: "plugins", configFileName: "mcp_config.json" },
  // src/compile/lowerers/factory-droid.ts `planMcpServer` -> "plugins/<bundle>/mcp.json"
  "factory-droid": { kind: "bundle-dirs", bundleSubdir: "plugins", configFileName: "mcp.json" },
  // src/compile/lowerers/kimi-code.ts `generatedPath` -> "plugins/managed/<bundle>/kimi.plugin.json"
  "kimi-code": {
    kind: "bundle-dirs",
    bundleSubdir: join("plugins", "managed"),
    configFileName: "kimi.plugin.json",
  },
  // src/compile/lowerers/codex-cli.ts `configTarget` -> "config.toml" #mcp_servers
  "codex-cli": { kind: "single-file", relativeConfigPath: "config.toml", format: "toml" },
  // src/compile/lowerers/grok.ts -> "config.toml" #mcp_servers
  grok: { kind: "single-file", relativeConfigPath: "config.toml", format: "toml" },
  // src/compile/lowerers/cursor.ts `configPath` -> "mcp.json" #mcpServers
  cursor: { kind: "single-file", relativeConfigPath: "mcp.json", format: "json" },
  // src/compile/lowerers/hermes.ts `configPath` -> "config.yaml" #mcp_servers
  hermes: { kind: "single-file", relativeConfigPath: "config.yaml", format: "hermes-yaml" },
};

/** Field name of the within-server allowlist, for the three harnesses that have one. */
const ALLOWLIST_FIELD: Partial<Record<ShimHarnessId, string>> = {
  "codex-cli": "enabled_tools",
  "kimi-code": "enabledTools",
};

const GENERATED_PLUGIN_PREFIX = "prism-generated-";

// ---------------------------------------------------------------------------
// Normalized server entry — every format (TOML/JSON/hand-rolled YAML)
// collapses to this shape so the assertions are format-agnostic.
// ---------------------------------------------------------------------------

interface NormalizedServerEntry {
  readonly configPath: string;
  readonly serverKey: string;
  readonly command?: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Populated only when this harness's allowlist lives inside the server's own entry. */
  readonly allowlist?: readonly string[];
  readonly url?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const stringEnv = (value: unknown): Record<string, string> => {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
};

const normalizeStructuredEntry = (
  configPath: string,
  serverKey: string,
  raw: unknown,
  allowlistField: string | undefined,
): NormalizedServerEntry | undefined => {
  const record = asRecord(raw);
  if (!record) return undefined;
  return {
    configPath,
    serverKey,
    command: typeof record.command === "string" ? record.command : undefined,
    args: stringArray(record.args),
    env: stringEnv(record.env),
    allowlist:
      allowlistField !== undefined && Array.isArray(record[allowlistField])
        ? stringArray(record[allowlistField])
        : undefined,
    url: typeof record.url === "string" ? record.url : undefined,
  };
};

const readServersMapJson = async (
  configPath: string,
  serversKey: string,
): Promise<Record<string, unknown> | undefined> => {
  if (!(await exists(configPath))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(configPath));
    return asRecord(asRecord(parsed)?.[serversKey]);
  } catch {
    return undefined;
  }
};

const readServersMapToml = async (
  configPath: string,
): Promise<Record<string, unknown> | undefined> => {
  if (!(await exists(configPath))) return undefined;
  try {
    const parsed = Bun.TOML.parse(await readFile(configPath)) as Record<string, unknown>;
    return asRecord(parsed.mcp_servers);
  } catch {
    return undefined;
  }
};

const listGeneratedBundleDirs = async (bundleRoot: string): Promise<string[]> => {
  const entries = await listDir(bundleRoot);
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(GENERATED_PLUGIN_PREFIX)) continue;
    if (await isDirectory(join(bundleRoot, entry))) dirs.push(entry);
  }
  return dirs.sort((left, right) => left.localeCompare(right));
};

// ---- Hermes's hand-rolled YAML (no YAML parser dependency in this codebase
// — see src/doctor.ts's identical justification for its own copy of this
// grammar-scoped reader; this is a fresh implementation for this script's
// independence, not an import of doctor.ts's private helpers). Reads back
// exactly the fixed-indentation grammar `renderHermesOwnerMcpServerYaml`
// (src/compile/lowerers/hermes.ts) writes. ----

const yamlIndent = (line: string): number => line.length - line.trimStart().length;

const yamlSiblingBlock = (lines: readonly string[], startIndex: number, indent: number): string[] => {
  const block: string[] = [];
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    // The sync engine's marker-region fences (`# --- prism:<key> begin/end
    // ---`) land at column 0 inside this block — skip comment lines rather
    // than let one end the block early (see hermes.ts's `configPath` region:
    // its fence wraps the owner mapping this reader needs to see past it).
    if (line.trim().startsWith("#")) continue;
    if (yamlIndent(line) <= indent) break;
    block.push(line);
  }
  return block;
};

const yamlChildBlock = (lines: readonly string[], indent: number, key: string): string[] => {
  const keyIndex = lines.findIndex((line) => yamlIndent(line) === indent && line.trim() === `${key}:`);
  return keyIndex === -1 ? [] : yamlSiblingBlock(lines, keyIndex + 1, indent);
};

const yamlChildKeyNames = (lines: readonly string[], indent: number): string[] => {
  const names: string[] = [];
  for (const line of lines) {
    if (yamlIndent(line) !== indent) continue;
    const match = line.trim().match(/^([^\s:]+):\s*$/u);
    if (match) names.push(match[1]!);
  }
  return names;
};

const yamlUnquote = (value: string): string =>
  value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;

const yamlScalarValue = (lines: readonly string[], indent: number, key: string): string | undefined => {
  const line = lines.find(
    (entry) => yamlIndent(entry) === indent && entry.trim().startsWith(`${key}:`),
  );
  if (!line) return undefined;
  const value = line.trim().slice(key.length + 1).trim();
  return value.length > 0 ? yamlUnquote(value) : undefined;
};

const yamlListItems = (lines: readonly string[], indent: number): string[] =>
  lines
    .filter((line) => yamlIndent(line) === indent && line.trim().startsWith("- "))
    .map((line) => yamlUnquote(line.trim().slice(2).trim()));

/** Every `key: <scalar value>` entry at `indent` (bare `key:` lines with no inline value, e.g. a nested mapping's own header, are not scalars and are skipped). */
const yamlScalarMapping = (lines: readonly string[], indent: number): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of lines) {
    if (yamlIndent(line) !== indent) continue;
    const trimmed = line.trim();
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const value = trimmed.slice(colonIndex + 1).trim();
    if (value.length === 0) continue; // bare `key:` header for a nested block, not a scalar
    out[trimmed.slice(0, colonIndex)] = yamlUnquote(value);
  }
  return out;
};

const readHermesServerEntries = async (configPath: string): Promise<NormalizedServerEntry[]> => {
  if (!(await exists(configPath))) return [];
  const lines = (await readFile(configPath)).split("\n");
  const mcpServersBlock = yamlChildBlock(lines, 0, "mcp_servers");
  const serverKeys = yamlChildKeyNames(mcpServersBlock, 2);
  const entries: NormalizedServerEntry[] = [];
  for (const serverKey of serverKeys) {
    const serverBlock = yamlChildBlock(mcpServersBlock, 2, serverKey);
    const command = yamlScalarValue(serverBlock, 4, "command");
    const url = yamlScalarValue(serverBlock, 4, "url");
    const args = yamlListItems(yamlChildBlock(serverBlock, 4, "args"), 6);
    const env = yamlScalarMapping(yamlChildBlock(serverBlock, 4, "env"), 6);
    const toolsBlock = yamlChildBlock(serverBlock, 4, "tools");
    const allowlist = yamlListItems(yamlChildBlock(toolsBlock, 6, "include"), 8);
    entries.push({ configPath, serverKey, command, args, env, allowlist, url });
  }
  return entries;
};

// ---------------------------------------------------------------------------
// Collect every normalized server entry a harness root exposes.
// ---------------------------------------------------------------------------

const collectHarnessServerEntries = async (
  harness: ShimHarnessId,
  root: string,
): Promise<NormalizedServerEntry[]> => {
  const location = HARNESS_MCP_LOCATION[harness];
  const allowlistField = ALLOWLIST_FIELD[harness];

  if (location.kind === "single-file") {
    const configPath = join(root, location.relativeConfigPath);
    if (location.format === "hermes-yaml") return readHermesServerEntries(configPath);
    const serversMap =
      location.format === "toml"
        ? await readServersMapToml(configPath)
        : await readServersMapJson(configPath, "mcpServers");
    if (!serversMap) return [];
    const entries: NormalizedServerEntry[] = [];
    for (const [serverKey, raw] of Object.entries(serversMap)) {
      const entry = normalizeStructuredEntry(configPath, serverKey, raw, allowlistField);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  const bundleRoot = join(root, location.bundleSubdir);
  const entries: NormalizedServerEntry[] = [];
  for (const dir of await listGeneratedBundleDirs(bundleRoot)) {
    const configPath = join(bundleRoot, dir, location.configFileName);
    const serversMap = await readServersMapJson(configPath, "mcpServers");
    if (!serversMap) continue;
    for (const [serverKey, raw] of Object.entries(serversMap)) {
      const entry = normalizeStructuredEntry(configPath, serverKey, raw, allowlistField);
      if (entry) entries.push(entry);
    }
  }
  return entries;
};

// ---------------------------------------------------------------------------
// Assertions A-F
// ---------------------------------------------------------------------------

const LEGACY_SHIM_SERVER_KEY = "prism-mcp-shim";
const LEGACY_HASH_KEY_PATTERN = /^p_[0-9a-f]{8}$/iu;

/** Recognizes a Prism-managed entry regardless of naming correctness, so a broken/legacy entry still gets scanned rather than silently skipped as "foreign". */
const looksPrismManaged = (serverKey: string, entry: NormalizedServerEntry): boolean =>
  entry.command === "prism" ||
  entry.args.includes("shim") ||
  entry.env.PRISM_SHIM_HARNESS !== undefined ||
  entry.env.PRISM_SHIM_PLUGINS !== undefined ||
  serverKey === LEGACY_SHIM_SERVER_KEY ||
  LEGACY_HASH_KEY_PATTERN.test(serverKey) ||
  /shim/iu.test(serverKey);

const arraysEqualSorted = (left: readonly string[], right: readonly string[]): boolean => {
  const a = [...left].sort((x, y) => x.localeCompare(y));
  const b = [...right].sort((x, y) => x.localeCompare(y));
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const duplicateValues = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
};

const singleOwnerFromEnv = (entry: NormalizedServerEntry): string | undefined => {
  const raw = entry.env.PRISM_SHIM_PLUGINS ?? "";
  const plugins = raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  return plugins.length === 1 ? plugins[0] : undefined;
};

export const verifyHarnessTopology = async (
  harness: ShimHarnessId,
  root: string,
  inventory: PluginInventory,
): Promise<HarnessTopologyReport> => {
  const contract: HarnessMcpContract = getHarnessMcpContract(harness);
  const allowlistIsWithinServer =
    contract.mcpSupport === "supported" && contract.toolAllowlist === "within-server";

  const entries = await collectHarnessServerEntries(harness, root);
  const managed = entries.filter((entry) => looksPrismManaged(entry.serverKey, entry));
  const managedByKey = new Map(managed.map((entry) => [entry.serverKey, entry] as const));
  const installedNames = [...inventory.all.keys()];

  const violations: McpTopologyViolation[] = [];
  const violate = (
    assertion: McpTopologyAssertion,
    code: string,
    message: string,
    extra?: Partial<Omit<McpTopologyViolation, "assertion" | "code" | "harness" | "severity" | "message">>,
  ): void => {
    violations.push({ assertion, code, harness, severity: "error", message, ...extra });
  };

  // ---- A: naming ----
  for (const entry of managed) {
    const { serverKey, configPath } = entry;
    if (serverKey === LEGACY_SHIM_SERVER_KEY) {
      violate(
        "A",
        "topology.legacy-shim-key",
        `server key is the retired aggregated shim key '${LEGACY_SHIM_SERVER_KEY}'`,
        { path: configPath, serverKey },
      );
    }
    if (LEGACY_HASH_KEY_PATTERN.test(serverKey)) {
      violate(
        "A",
        "topology.legacy-hash-key",
        `server key '${serverKey}' matches the retired 'p_<hash8>' namespace pattern`,
        { path: configPath, serverKey },
      );
    }
    if (/shim/iu.test(serverKey)) {
      violate("A", "topology.shim-substring-in-key", `server key '${serverKey}' contains 'shim'`, {
        path: configPath,
        serverKey,
      });
    }
    if (!installedNames.some((name) => pluginServerKey(name) === serverKey)) {
      violate(
        "A",
        "topology.unrecognized-server-key",
        `server key '${serverKey}' does not equal pluginServerKey(p) for any plugin in the installed set`,
        { path: configPath, serverKey },
      );
    }
  }

  // ---- B: owned-only ----
  for (const entry of managed) {
    const { serverKey, configPath } = entry;
    const raw = entry.env.PRISM_SHIM_PLUGINS ?? "";
    const plugins = raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
    if (plugins.length !== 1) {
      violate(
        "B",
        "topology.plugins-env-not-single-owner",
        `PRISM_SHIM_PLUGINS resolves to ${plugins.length} plugin(s) ('${raw}'), expected exactly 1`,
        { path: configPath, serverKey, data: { plugins } },
      );
      continue;
    }
    const owner = plugins[0]!;
    if (pluginServerKey(owner) !== serverKey) {
      violate(
        "B",
        "topology.server-key-owner-mismatch",
        `server key '${serverKey}' does not equal pluginServerKey('${owner}')`,
        { path: configPath, serverKey, plugin: owner },
      );
    }
    const ownerRecord = inventory.all.get(owner);
    if (!ownerRecord || ownerRecord.ownTools.length === 0) {
      violate(
        "B",
        "topology.owner-not-installed",
        `owner plugin '${owner}' is not an MCP-owning plugin in the installed set`,
        { path: configPath, serverKey, plugin: owner },
      );
      continue;
    }
    if (allowlistIsWithinServer) {
      const expected = ownerRecord.ownTools.map((tool) =>
        renderPluginAllowlist(harness, owner, generatedOwnerToolName(owner, tool)),
      );
      const actual = entry.allowlist ?? [];
      if (!arraysEqualSorted(expected, actual)) {
        violate(
          "B",
          "topology.allowlist-mismatch",
          `allowlist for server '${serverKey}' does not equal owner '${owner}''s own tools rendered bare`,
          { path: configPath, serverKey, plugin: owner, data: { expected, actual } },
        );
      }
    }
  }

  // ---- C: no consumer servers / no 0-tool servers ----
  for (const [name, record] of inventory.all) {
    if (record.ownTools.length > 0) continue;
    if (!record.targetedHarnesses.has(harness)) continue;
    const key = pluginServerKey(name);
    const found = managedByKey.get(key);
    if (found) {
      violate(
        "C",
        "topology.consumer-has-server",
        `plugin '${name}' owns no MCP tools but has a server entry '${key}'`,
        { path: found.configPath, serverKey: key, plugin: name },
      );
    }
  }
  if (allowlistIsWithinServer) {
    for (const entry of managed) {
      if (entry.allowlist !== undefined && entry.allowlist.length === 0) {
        violate("C", "topology.zero-tool-server", `server '${entry.serverKey}' advertises an empty allowlist`, {
          path: entry.configPath,
          serverKey: entry.serverKey,
        });
      }
    }
  }

  // ---- D: no duplication ----
  const ownerToEntries = new Map<string, NormalizedServerEntry[]>();
  for (const entry of managed) {
    const owner = singleOwnerFromEnv(entry);
    if (owner === undefined) continue; // already flagged under B
    const list = ownerToEntries.get(owner) ?? [];
    list.push(entry);
    ownerToEntries.set(owner, list);
  }
  for (const [owner, ownerEntries] of ownerToEntries) {
    if (ownerEntries.length > 1) {
      violate(
        "D",
        "topology.duplicate-owner-server",
        `owner plugin '${owner}' has ${ownerEntries.length} server entries in this harness root`,
        {
          plugin: owner,
          data: {
            paths: ownerEntries.map((entry) => entry.configPath),
            serverKeys: ownerEntries.map((entry) => entry.serverKey),
          },
        },
      );
    }
  }
  const seenFqNames = new Set<string>();
  for (const entry of managed) {
    for (const tool of entry.allowlist ?? []) {
      const fq = `${entry.serverKey}::${tool}`;
      if (seenFqNames.has(fq)) {
        violate(
          "D",
          "topology.duplicate-fq-tool-name",
          `fully-qualified tool name '${fq}' appears more than once across this root's prism servers`,
          { path: entry.configPath, serverKey: entry.serverKey },
        );
      }
      seenFqNames.add(fq);
    }
    for (const dupe of duplicateValues(entry.allowlist ?? [])) {
      violate(
        "D",
        "topology.duplicate-tool-in-allowlist",
        `server '${entry.serverKey}' allowlist contains '${dupe}' more than once`,
        { path: entry.configPath, serverKey: entry.serverKey },
      );
    }
  }

  // ---- E: coverage ----
  for (const [name, record] of inventory.all) {
    if (record.ownTools.length === 0) continue;
    if (!record.targetedHarnesses.has(harness)) continue;
    const key = pluginServerKey(name);
    if (!managedByKey.has(key)) {
      violate(
        "E",
        "topology.owner-missing-server",
        `owner plugin '${name}' targets ${harness} for tools but has no server entry (expected key '${key}')`,
        { serverKey: key, plugin: name },
      );
    }
  }

  // ---- F: no dead transports ----
  // Scanned across ALL entries (not just `managed`) so a corrupted legacy
  // entry that lost its recognizable command/env but kept a prism-looking
  // key or url is still caught.
  for (const entry of entries) {
    if (!entry.url) continue;
    if (
      looksPrismManaged(entry.serverKey, entry) ||
      /prism/iu.test(entry.serverKey) ||
      /prism/iu.test(entry.url)
    ) {
      violate(
        "F",
        "topology.dead-http-transport",
        `server '${entry.serverKey}' carries a prism-looking HTTP url transport ('${entry.url}') — Prism is stdio-only`,
        { path: entry.configPath, serverKey: entry.serverKey },
      );
    }
  }

  return { harness, root, serversFound: managed.length, violations };
};

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

export interface VerifyTopologyOptions {
  readonly pluginPaths: readonly string[];
  readonly harnesses: readonly ShimHarnessId[];
  readonly roots: HarnessRootsEnv;
}

export const verifyTopology = async (options: VerifyTopologyOptions): Promise<TopologyReport> => {
  const inventory = await loadPluginInventory(options.pluginPaths);
  const harnesses: HarnessTopologyReport[] = [];
  for (const harness of options.harnesses) {
    const root = expandPath(options.roots.resolve(harness));
    harnesses.push(await verifyHarnessTopology(harness, root, inventory));
  }
  return {
    schema: "prism.acceptance.mcp-topology-verify.v1",
    harnesses,
    pass: harnesses.every((report) => report.violations.length === 0),
  };
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const printReport = (report: TopologyReport): void => {
  for (const harnessReport of report.harnesses) {
    const pass = harnessReport.violations.length === 0;
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${harnessReport.harness} — ${harnessReport.serversFound} server(s), ${harnessReport.violations.length} violation(s) @ ${harnessReport.root}`,
    );
    for (const violation of harnessReport.violations) {
      const server = violation.serverKey ? ` server=${violation.serverKey}` : "";
      const plugin = violation.plugin ? ` plugin=${violation.plugin}` : "";
      console.log(`  ! [${violation.assertion}] ${violation.code}${server}${plugin} — ${violation.message}`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
};

const flagValues = (args: readonly string[], name: string): string[] => {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1] !== undefined) out.push(args[index + 1]!);
  }
  return out;
};

const parseRootOverrides = (raw: readonly string[]): Map<HarnessId, string> => {
  const overrides = new Map<HarnessId, string>();
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw new Error(`mcp-topology-verify: --root must be '<harness>=<path>', got '${entry}'`);
    }
    overrides.set(entry.slice(0, eq) as HarnessId, resolve(entry.slice(eq + 1)));
  }
  return overrides;
};

const runDiagnosticMode = async (
  pluginsDir: string,
  harnesses: readonly ShimHarnessId[],
  rootOverrides: ReadonlyMap<HarnessId, string>,
): Promise<TopologyReport> => {
  const pluginPaths = await discoverPluginPaths(resolve(pluginsDir));
  const roots: HarnessRootsEnv = {
    resolve: (harness) => rootOverrides.get(harness) ?? getHarness(harness).globalConfigPath,
  };
  return verifyTopology({ pluginPaths, harnesses, roots });
};

const runSelfTestMode = async (harnesses: readonly ShimHarnessId[]): Promise<TopologyReport> => {
  const sandbox = await createPrismSandbox();
  try {
    for (const harness of harnesses) {
      await Effect.runPromise(
        compilePluginForTarget({
          pluginPath: SELF_TEST_PLUGIN_PATH,
          target: harness,
          scope: "global",
          prismHome: sandbox.prismHome,
          dryRun: false,
          mcpLifecycle: "none",
        }).pipe(Effect.provide(Layer.succeed(HarnessRoots, sandbox.roots))),
      );
    }
    return await verifyTopology({
      pluginPaths: [SELF_TEST_PLUGIN_PATH],
      harnesses,
      roots: sandbox.roots,
    });
  } finally {
    await sandbox.cleanup();
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const pluginsDir = flagValues(args, "--plugins").at(-1);
  const harnessArgs = flagValues(args, "--harness");
  const harnesses = (harnessArgs.length > 0 ? harnessArgs : [...SHIM_HARNESS_IDS]) as ShimHarnessId[];
  const rootOverrides = parseRootOverrides(flagValues(args, "--root"));

  const report =
    pluginsDir !== undefined
      ? await runDiagnosticMode(pluginsDir, harnesses, rootOverrides)
      : await runSelfTestMode(harnesses);

  printReport(report);
  process.exitCode = report.pass ? 0 : 1;
};

if (import.meta.main) {
  await main();
}
