/**
 * Orphaned prism-fingerprinted MCP entries (PQ-172) -- structured-entry
 * sibling of `namespace.stray`'s path-based scan (`doctor.ts`'s
 * `detectNamespaceStrays`). A shared harness config (hermes/codex-cli/grok/
 * cursor's single `config.toml`/`config.yaml`/`mcp.json`) can carry an MCP
 * server-map entry that (a) is provably Prism's own by name shape or content
 * provenance, yet (b) sits outside every regionKey the current snapshot
 * tracks for that harness+root -- invisible to both `doctor` (never scanned
 * structural entries before this module) and `refresh` (the snapshot-driven
 * orphan prune only ever fires for a region a live compile pass still
 * emits; an entry with no current owner, or one predating the marker-fence
 * scheme entirely, never enters that pass at all). Grounded case: a 2026-07-04
 * audit found nine unfenced `prism-generated-*` entries surviving in
 * `~/.hermes/config.yaml` from the pre-wire-key naming scheme, each pointing
 * at a dead port.
 *
 * Scope: the four SINGLE-FILE shared-config shim harnesses --
 * `HARNESS_MCP_LOCATION` in `./mcp-topology-checks.ts` classifies
 * claude-code/antigravity-cli/factory-droid/kimi-code as `bundle-dirs` (a
 * whole generated-plugin directory Prism owns outright; `namespace.stray`
 * already covers an unowned bundle there). Only codex-cli/grok/hermes/
 * cursor write into a file the USER also owns, where a Prism entry can
 * outlive its own snapshot tracking without the whole file disappearing.
 *
 * Fingerprint: the exact two provenance surfaces `sync/legacy-prism-entries.ts`
 * already established as sanctioned (never a duplicate reimplementation) --
 * a name shape retired by a naming-scheme migration
 * (`isLegacyPrismServerKeyName`: `prism-mcp-shim`, `prism-generated-<x>`,
 * bare `p_<hash8>`), OR positive content provenance (`hasLegacyPrismProvenance`:
 * the retired HTTP era's `X-Prism-Mcp-Exposure` header, or the
 * `{ command: "prism", args: ["mcp", "shim"] }` pair the CURRENT per-plugin
 * scheme also renders). Either predicate alone is sufficient, matching that
 * module's OR-classification -- this scan additionally requires the entry
 * be untracked (below), so it never needs the desired-keys AND-gate
 * `sweepJsonServerMap` uses to avoid cannibalizing a live plugin's own
 * just-written entry: a properly tracked, currently-owned entry's regionKey
 * is always in the caller's `ownedRegionKeys` set by construction.
 *
 * Untracked test: `regionKeyForServerKey` reconstructs the exact per-harness
 * regionKey a live compile would emit for a given `serverKey` (one citation
 * per harness, matching the lowerer that renders it); the caller
 * (`doctor.ts`'s `collectAllOrphanedMcpEntries`) checks that key against the
 * snapshot's actually-recorded regionKeys for that harness+root.
 *
 * Resolution (rule 7, "no adopt, ever" -- AGENTS.md): prune only. These
 * entries already carry positive Prism provenance; removing a proven orphan
 * is not adoption of a file Prism cannot prove it owns -- it is discarding
 * dead Prism-authored residue, the same posture `sweepLegacyPrismMcpEntries`
 * already takes during a live compile. Two removal paths, tried in order:
 * (1) the entry happens to already sit inside a marker fence matching the
 * expected regionKey (a stale-but-still-fenced region, e.g. after a deleted/
 * rebuilt snapshot) -- `removeMarkerRegion` handles this uniformly for every
 * marker-fenced harness (codex-cli/grok/hermes all use the SAME `#`-prefixed
 * grammar, TOML and YAML alike); (2) truly unfenced structural residue (the
 * actually-reported case) -- a narrow, format-specific structural remover,
 * `removeTomlServerTable` (codex-cli/grok) or `removeYamlMappingChild`
 * (hermes), in the same "fresh small reader, not a shared parser" idiom this
 * codebase already uses per format (see `mcp-topology-checks.ts`'s own
 * from-scratch YAML reader, and its module doc explaining why). Cursor's
 * entries are always structural JSON (never marker-fenced) --
 * `removeJsonKeyRegion` alone.
 */

import { exists, readFile, writeFile } from "../fs.js";
import type { HarnessId } from "../types.js";
import { removeJsonKeyRegion, removeMarkerRegion } from "../sync/regions.js";
import { hasLegacyPrismProvenance, isLegacyPrismServerKeyName } from "../sync/legacy-prism-entries.js";
import { collectHarnessServerEntries, type NormalizedServerEntry } from "./mcp-topology-checks.js";

/** The single-file shared-config shim harnesses -- see module doc for the bundle-dirs exclusion. */
const SHARED_CONFIG_HARNESS_IDS = ["codex-cli", "grok", "cursor", "hermes"] as const;
export type SharedConfigHarnessId = (typeof SHARED_CONFIG_HARNESS_IDS)[number];

export const isSharedConfigHarnessId = (harness: HarnessId): harness is SharedConfigHarnessId =>
  (SHARED_CONFIG_HARNESS_IDS as readonly HarnessId[]).includes(harness);

/**
 * The exact per-harness regionKey a live compile emits for a plugin's own
 * MCP entry, reconstructed from a live entry's `serverKey` alone -- one
 * citation per harness, matching the lowerer that renders it:
 *  - `src/compile/lowerers/codex-cli.ts:574` `codex.mcp.${mcp.mcpServerName}`
 *  - `src/compile/lowerers/grok.ts:437` `grok.mcp.${pluginServerKey(owner)}`
 *  - `src/compile/lowerers/hermes.ts:323` `hermes.mcp.${mcp.serverName}`
 *  - `src/compile/lowerers/cursor.ts:104` `mcpServers.${serverName}`
 */
const regionKeyForServerKey = (harness: SharedConfigHarnessId, serverKey: string): string => {
  switch (harness) {
    case "codex-cli":
      return `codex.mcp.${serverKey}`;
    case "grok":
      return `grok.mcp.${serverKey}`;
    case "hermes":
      return `hermes.mcp.${serverKey}`;
    case "cursor":
      return `mcpServers.${serverKey}`;
  }
};

/**
 * Positive Prism provenance, independent of whether the entry is currently
 * tracked (module doc: either sanctioned fingerprint is sufficient).
 * Applying `hasLegacyPrismProvenance` to the already-normalized shape, never
 * a duplicate reimplementation of the raw-record check.
 */
const isPrismFingerprintedEntry = (entry: NormalizedServerEntry): boolean =>
  isLegacyPrismServerKeyName(entry.serverKey) ||
  hasLegacyPrismProvenance({ command: entry.command, args: entry.args, headers: entry.headers });

export interface OrphanedMcpEntry {
  readonly harness: SharedConfigHarnessId;
  readonly configPath: string;
  readonly serverKey: string;
  readonly regionKey: string;
}

/**
 * Every prism-fingerprinted entry `root`'s harness config carries that
 * `ownedRegionKeys` does not claim. `ownedRegionKeys` is the caller's
 * snapshot-derived set (every `mode: "region"` entry's `regionKey` recorded
 * for this exact harness+root, across all snapshots -- see `doctor.ts`'s
 * `collectAllOrphanedMcpEntries`); this module has no snapshot access of its
 * own by design, so it stays testable against bare config fixtures.
 */
export const collectOrphanedMcpEntries = async (
  harness: SharedConfigHarnessId,
  root: string,
  ownedRegionKeys: ReadonlySet<string>,
): Promise<OrphanedMcpEntry[]> => {
  const entries = await collectHarnessServerEntries(harness, root);
  const orphans: OrphanedMcpEntry[] = [];
  for (const entry of entries) {
    if (!isPrismFingerprintedEntry(entry)) continue;
    const regionKey = regionKeyForServerKey(harness, entry.serverKey);
    if (ownedRegionKeys.has(regionKey)) continue;
    orphans.push({ harness, configPath: entry.configPath, serverKey: entry.serverKey, regionKey });
  }
  return orphans;
};

// ---------------------------------------------------------------------------
// Structural removal -- one small, format-scoped reader per config format,
// matching this codebase's established idiom (see module doc). Never a full
// parse/re-serialize round-trip: line-based, everything outside the removed
// span preserved byte-for-byte.
// ---------------------------------------------------------------------------

/**
 * Splits a TOML table-header line into its dotted path segments, tolerant of
 * both bare (`mcp_servers.foo`) and quoted (`"mcp_servers"."foo"`) segments
 * -- the current lowerers always quote (`tomlDottedTable`'s `quote =
 * JSON.stringify`), a historical pre-migration writer may not have. Read
 * side only: this module never re-serializes a parsed TOML document.
 */
const tomlHeaderSegments = (line: string): string[] | undefined => {
  const match = line.match(/^\s*\[{1,2}(.+?)\]{1,2}\s*$/);
  if (!match) return undefined;
  const inner = match[1]!;
  const segments: string[] = [];
  let cursor = 0;
  while (cursor < inner.length) {
    if (inner[cursor] === ".") {
      cursor += 1;
      continue;
    }
    if (inner[cursor] === '"' || inner[cursor] === "'") {
      const quote = inner[cursor]!;
      const end = inner.indexOf(quote, cursor + 1);
      if (end === -1) return undefined;
      segments.push(inner.slice(cursor + 1, end));
      cursor = end + 1;
    } else {
      const dot = inner.indexOf(".", cursor);
      const end = dot === -1 ? inner.length : dot;
      segments.push(inner.slice(cursor, end).trim());
      cursor = end;
    }
  }
  return segments;
};

/**
 * Removes a `[mcp_servers.<serverKey>]` table AND every nested sub-table
 * (`[mcp_servers.<serverKey>.env]`, matching
 * `renderCodexOwnerMcpServerToml`/`renderGrokPerPluginShimServerToml`'s own
 * two-table shape) -- everything from that header up to (not including) the
 * next header NOT nested under it, or EOF.
 */
export const removeTomlServerTable = (
  content: string,
  serverKey: string,
): { readonly content: string; readonly changed: boolean } => {
  const target = ["mcp_servers", serverKey];
  const lines = content.split("\n");
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const segments = tomlHeaderSegments(lines[index]!);
    if (segments === undefined) continue;
    const underTarget = target.every((segment, position) => segments[position] === segment);
    if (start === -1) {
      if (underTarget && segments.length === target.length) start = index;
      continue;
    }
    if (!underTarget) {
      end = index;
      break;
    }
  }
  if (start === -1) return { content, changed: false };
  let sliceStart = start;
  let sliceEnd = end;
  if (sliceEnd < lines.length && lines[sliceEnd]!.trim().length === 0) sliceEnd += 1;
  else if (sliceStart > 0 && lines[sliceStart - 1]!.trim().length === 0) sliceStart -= 1;
  return { content: [...lines.slice(0, sliceStart), ...lines.slice(sliceEnd)].join("\n"), changed: true };
};

const yamlLineIndent = (line: string): number => line.length - line.trimStart().length;

/**
 * Removes `<topKey>`'s `<childKey>:` mapping child and its entire value
 * block -- every following line indented deeper than the child's own key,
 * stopping at the next sibling (indent <= the child's) or the end of
 * `<topKey>`'s own block (indent <= 0), whichever comes first. Matches
 * `renderHermesOwnerMcpServerYaml`'s per-plugin child shape under
 * `mcp_servers:` without requiring the marker fence the caller already
 * tried and failed to find -- an unfenced legacy entry has the same
 * key/indent grammar, minus the fence.
 */
export const removeYamlMappingChild = (
  content: string,
  topKey: string,
  childKey: string,
): { readonly content: string; readonly changed: boolean } => {
  const lines = content.split("\n");
  const topIndex = lines.findIndex((line) => yamlLineIndent(line) === 0 && line.trim() === `${topKey}:`);
  if (topIndex === -1) return { content, changed: false };

  let childIndent: number | undefined;
  let start = -1;
  let end = lines.length;
  for (let index = topIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const indent = yamlLineIndent(line);
    if (indent <= 0) {
      end = index;
      break;
    }
    if (start === -1) {
      if (line.trim() === `${childKey}:`) {
        childIndent = indent;
        start = index;
      }
      continue;
    }
    if (indent <= childIndent!) {
      end = index;
      break;
    }
  }
  if (start === -1) return { content, changed: false };
  let sliceEnd = end;
  if (sliceEnd < lines.length && lines[sliceEnd]!.trim().length === 0) sliceEnd += 1;
  return { content: [...lines.slice(0, start), ...lines.slice(sliceEnd)].join("\n"), changed: true };
};

const attemptFencedThenStructural = (
  orphan: OrphanedMcpEntry,
  content: string,
): { readonly content: string; readonly changed: boolean } => {
  const fenced = removeMarkerRegion(content, { commentPrefix: "#", regionKey: orphan.regionKey });
  if (fenced.changed) return fenced;
  return orphan.harness === "hermes"
    ? removeYamlMappingChild(content, "mcp_servers", orphan.serverKey)
    : removeTomlServerTable(content, orphan.serverKey);
};

export interface PrunedMcpEntry {
  readonly harness: SharedConfigHarnessId;
  readonly configPath: string;
  readonly serverKey: string;
  readonly pruned: boolean;
}

/**
 * Removes one orphan from disk, format-appropriate (module doc): JSON key
 * removal for cursor; a marker-fence attempt first for the three
 * `#`-grammar harnesses (handles a stale-but-fenced region), falling back
 * to the structural remover for a genuinely unfenced legacy entry. A no-op
 * (`pruned: false`) if the file (or the entry inside it) is already gone --
 * idempotent by construction, never an error on a second run.
 */
export const pruneOrphanedMcpEntry = async (orphan: OrphanedMcpEntry): Promise<PrunedMcpEntry> => {
  if (!(await exists(orphan.configPath))) {
    return { harness: orphan.harness, configPath: orphan.configPath, serverKey: orphan.serverKey, pruned: false };
  }
  const before = await readFile(orphan.configPath);
  const outcome =
    orphan.harness === "cursor"
      ? removeJsonKeyRegion(before, ["mcpServers", orphan.serverKey])
      : attemptFencedThenStructural(orphan, before);
  if (!outcome.changed) {
    return { harness: orphan.harness, configPath: orphan.configPath, serverKey: orphan.serverKey, pruned: false };
  }
  await writeFile(orphan.configPath, outcome.content);
  return { harness: orphan.harness, configPath: orphan.configPath, serverKey: orphan.serverKey, pruned: true };
};
