/**
 * Legacy Prism MCP identity sweep — reserved names retired by prior
 * naming-scheme migrations (docs/mcp-http-goal.md's HTTP-transport era, and
 * the aggregated `prism-mcp-shim` union scheme retired for codex/hermes/
 * cursor in favor of one region per owner plugin, see commit 6b44d8a).
 *
 * Why this needs to exist at all (root cause of the prune asymmetry): grok
 * and claude-code's per-plugin MCP regions/files have ALWAYS been identified
 * by a real owner plugin (`grok.mcp.<pluginServerKey(owner)>`, or claude-code's
 * whole per-plugin-bundle `.mcp.json`), so the standard snapshot-driven
 * orphan prune in `plan.ts` fires the moment that real plugin's own scoped
 * compile no longer desires the entry. Codex/hermes/cursor's now-retired
 * aggregated scheme instead attributed its ONE shared region/entry to the
 * synthetic union-owner sentinel `'prism#shim'` (see commit be15253) — not a
 * real, individually-compilable plugin. `refresh.ts` only ever calls
 * `planSync` scoped to a real plugin (`scopePlugins: new Set([plugin])`); no
 * refresh is ever scoped to `'prism#shim'`, so even when the snapshot still
 * carries that entry, `planSync`'s scope check (`inScope`) can never fire for
 * it — it is carried into the next manifest untouched, forever. A
 * differently-shaped, even older per-plugin HTTP-transport artifact (Cursor's
 * `prism-generated-<plugin>`/bare `p_<hash8>` server keys, predating any
 * region/snapshot tracking at all) has no snapshot entry whatsoever, so no
 * scope-based fix can reach it either.
 *
 * The fix here is a scope-independent identity denylist: no live plugin's
 * own `pluginServerKey` output (the plugin's own sanitized name) ever
 * legitimately produces one of these reserved names — they are sentinels
 * and historical prefixes disjoint from the plugin-name sanitizer's output
 * space — so sweeping them is safe unconditionally, on every refresh,
 * scoped or not, with zero risk of colliding with a currently-desired entry.
 * This generalizes to future retirements: any new synthetic/reserved
 * identity added to this module gets swept the same way, independent of
 * snapshot history or refresh scoping.
 */

import { shimServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
import { readJsonKeyRegion, removeJsonKeyRegion, removeMarkerRegion } from "./regions.js";

/**
 * The retired aggregated-shim marker regionKey for a marker-fenced harness's
 * shared MCP config (`config.toml`/`config.yaml`) — `undefined` for a
 * harness with no such history (it never used the union scheme, or its MCP
 * entries are structural JSON, not marker-fenced).
 */
const legacyAggregatedMcpMarkerRegionKey = (harness: string): string | undefined => {
  switch (harness) {
    case "codex-cli":
      return `codex.mcp.${shimServerKey("codex-cli")}`;
    case "hermes":
      return `hermes.mcp.${shimServerKey("hermes")}`;
    default:
      return undefined;
  }
};

/**
 * The JSON path a harness's shared MCP config keys its server map under,
 * for a harness that manages MCP servers structurally (JSON keys, not a
 * marker fence).
 */
const jsonMcpServerMapPath = (harness: string): ReadonlyArray<string> | undefined =>
  harness === "cursor" ? ["mcpServers"] : undefined;

/** Bare `p_<hash8>` — the pre-shim HTTP era's per-plugin canonical namespace, used alone (no tool suffix) as a server key. */
const BARE_AGGREGATED_TOOL_NAMESPACE = /^p_[0-9a-f]{8}$/;
const LEGACY_GENERATED_PREFIX = "prism-generated-";

/**
 * A server-map key from a retired Prism naming scheme: the aggregated union
 * sentinel (`prism-mcp-shim`), or the pre-shim HTTP-transport era's
 * per-plugin exposure names (`prism-generated-<segment>`, bare
 * `p_<hash8>`). None of these is ever a legitimate `pluginServerKey` output
 * for a real, live plugin (module doc), so matching by name alone is safe —
 * no currently-desired entry can ever be mistaken for one.
 */
const isLegacyPrismServerKeyName = (key: string): boolean =>
  key === "prism-mcp-shim" ||
  key.startsWith(LEGACY_GENERATED_PREFIX) ||
  BARE_AGGREGATED_TOOL_NAMESPACE.test(key);

export interface LegacySweepOutcome {
  readonly content: string;
  readonly changed: boolean;
  readonly removedKeys: ReadonlyArray<string>;
}

const sweepJsonServerMap = (
  content: string,
  jsonPath: ReadonlyArray<string>,
): LegacySweepOutcome => {
  let current = content;
  const removedKeys: string[] = [];
  // Bounded loop: each removal can shift jsonc-parser edit offsets, so the
  // object is re-read fresh every pass rather than iterating a stale key
  // list computed before any edit.
  for (let guard = 0; guard < 64; guard++) {
    const servers = readJsonKeyRegion(current, jsonPath);
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) break;
    const staleKey = Object.keys(servers as Record<string, unknown>).find(isLegacyPrismServerKeyName);
    if (staleKey === undefined) break;
    const outcome = removeJsonKeyRegion(current, [...jsonPath, staleKey]);
    if (!outcome.changed) break;
    current = outcome.content;
    removedKeys.push(staleKey);
  }
  return { content: current, changed: removedKeys.length > 0, removedKeys };
};

/**
 * Sweeps `content` (the file's content after normal desired-region
 * application and snapshot-driven orphan removal already ran) for any
 * surviving legacy Prism MCP identity, and removes it. Safe to run
 * unconditionally on every compile, scoped or not — see module doc.
 */
export const sweepLegacyPrismMcpEntries = (
  harness: string,
  content: string,
): LegacySweepOutcome => {
  const markerKey = legacyAggregatedMcpMarkerRegionKey(harness);
  if (markerKey !== undefined) {
    const outcome = removeMarkerRegion(content, { commentPrefix: "#", regionKey: markerKey });
    return {
      content: outcome.content,
      changed: outcome.changed,
      removedKeys: outcome.changed ? [markerKey] : [],
    };
  }
  const jsonPath = jsonMcpServerMapPath(harness);
  if (jsonPath !== undefined) return sweepJsonServerMap(content, jsonPath);
  return { content, changed: false, removedKeys: [] };
};
