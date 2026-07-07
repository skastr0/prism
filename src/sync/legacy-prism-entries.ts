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
 * The name pattern alone is NOT disjoint from live output. `pluginServerKey`
 * sanitizes to (not away from) these reserved shapes: a plugin literally
 * named `p_deadbeef` sanitizes byte-identical (already legal), colliding
 * with the bare `p_<hash8>` namespace regex; a plugin named
 * `prism-generated-my-internal-tool` collides with the retired HTTP-era
 * prefix; codex/hermes's own per-plugin marker regionKey (`codex.mcp.
 * <pluginServerKey>`) collides with the retired aggregated marker key the
 * moment a plugin sanitizes to `prism-mcp-shim`. Name-pattern matching a
 * cursor JSON entry is therefore gated on two further, independently
 * necessary checks before removal: the entry's own content must carry
 * positive evidence of Prism provenance (`hasLegacyPrismProvenance` — the
 * dead HTTP-era pair's `X-Prism-Mcp-Exposure` header, or the retired
 * aggregated shim's `command`/`args` pair, which a hand-authored server
 * pointing at the user's own tool never carries), AND the key must not be
 * among this pass's own desired entries (a live plugin's own just-written
 * entry, however it is named, is never eligible — see `plan.ts`'s
 * `sweepLegacyPrismMcpEntries` call site, which threads the pass's desired
 * regions through for exactly this). The codex/hermes marker sweep does not
 * need the same two-check treatment: `removeMarkerRegion` only ever matches
 * the LITERAL `# --- prism:<key> begin/end ---` fence text, which only
 * Prism itself ever writes — the fence delimiters ARE the provenance, so a
 * user's own unfenced content sharing the same table/key name is untouched
 * by construction (see `legacy-prism-entries.test.ts`).
 */

import { shimServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
import type { DesiredRegion } from "./desired.js";
import { readJsonKeyRegion, removeJsonKeyRegion, removeMarkerRegion } from "./regions.js";

/**
 * Mirror of `compile/mcp-runtime.ts`'s `MCP_EXPOSURE_HEADER`. Duplicated
 * (not imported) because `sync` sits below `compile` in the dependency
 * graph — `compile`'s lowerers already depend on `sync`'s `DesiredRegion`
 * type, so the reverse import would invert that layering.
 */
const MCP_EXPOSURE_HEADER = "X-Prism-Mcp-Exposure";

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
 * A server-map key SHAPED like a retired Prism naming scheme: the aggregated
 * union sentinel (`prism-mcp-shim`), or the pre-shim HTTP-transport era's
 * per-plugin exposure names (`prism-generated-<segment>`, bare
 * `p_<hash8>`). Name shape alone is NOT proof of provenance — `pluginServerKey`
 * sanitizes a live plugin's own name INTO these exact shapes for plugins
 * named e.g. `p_deadbeef` or `prism-generated-my-internal-tool` (module doc)
 * — so a name-shape match is only ever a *candidate*; the caller
 * (`sweepJsonServerMap`) additionally requires positive content provenance
 * and desired-keys exclusion before removing anything.
 */
const isLegacyPrismServerKeyName = (key: string): boolean =>
  key === "prism-mcp-shim" ||
  key.startsWith(LEGACY_GENERATED_PREFIX) ||
  BARE_AGGREGATED_TOOL_NAMESPACE.test(key);

/**
 * Positive evidence that a JSON MCP server-map entry was produced by Prism
 * itself, independent of its key's name shape. Two retired entry shapes
 * carry it:
 *  - the pre-shim HTTP-transport era's bearer entry, which stamped its
 *    daemon exposure profile into an `X-Prism-Mcp-Exposure` header (mirrored
 *    here as `MCP_EXPOSURE_HEADER` — see the module doc);
 *  - the retired aggregated-shim entry, `{ command: "prism", args: ["mcp",
 *    "shim"], ... }` — byte-identical to the shape the CURRENT per-plugin
 *    scheme also renders, which is exactly why this check alone is not
 *    sufficient (a live plugin's own entry matches it too); pairing it with
 *    the desired-keys exclusion in `sweepJsonServerMap` is what makes
 *    removal safe.
 * A hand-authored server pointing at the user's own tool carries neither —
 * no header, and no reason to independently reinvent Prism's exact
 * command/args pair — so it is never mistaken for a legacy Prism entry
 * regardless of what its key happens to be named.
 */
const hasLegacyPrismProvenance = (entry: unknown): boolean => {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  const headers = record.headers;
  if (headers !== null && typeof headers === "object" && !Array.isArray(headers)) {
    if (MCP_EXPOSURE_HEADER in (headers as Record<string, unknown>)) return true;
  }
  return (
    record.command === "prism" &&
    Array.isArray(record.args) &&
    record.args.length === 2 &&
    record.args[0] === "mcp" &&
    record.args[1] === "shim"
  );
};

export interface LegacySweepOutcome {
  readonly content: string;
  readonly changed: boolean;
  readonly removedKeys: ReadonlyArray<string>;
}

/**
 * The set of JSON server-map keys this pass's own desired regions render at
 * `jsonPath` (e.g. cursor's `mcpServers.<pluginServerKey>`) — every key a
 * live, currently-compiling plugin owns this pass. Never eligible for
 * removal by the legacy sweep below, however its name happens to be shaped:
 * this is what stops a plugin literally named `p_deadbeef` (or
 * `prism-generated-<x>`) from sweeping its own just-written entry.
 */
const desiredJsonServerMapKeys = (
  desiredRegions: ReadonlyArray<DesiredRegion>,
  jsonPath: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const region of desiredRegions) {
    if (region.kind !== "json-key") continue;
    if (region.jsonPath.length !== jsonPath.length + 1) continue;
    if (jsonPath.some((segment, index) => region.jsonPath[index] !== segment)) continue;
    const key = region.jsonPath[jsonPath.length];
    if (typeof key === "string") keys.add(key);
  }
  return keys;
};

const sweepJsonServerMap = (
  content: string,
  jsonPath: ReadonlyArray<string>,
  desiredKeys: ReadonlySet<string>,
): LegacySweepOutcome => {
  let current = content;
  const removedKeys: string[] = [];
  // Bounded loop: each removal can shift jsonc-parser edit offsets, so the
  // object is re-read fresh every pass rather than iterating a stale key
  // list computed before any edit.
  for (let guard = 0; guard < 64; guard++) {
    const servers = readJsonKeyRegion(current, jsonPath);
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) break;
    const record = servers as Record<string, unknown>;
    const staleKey = Object.keys(record).find(
      (key) =>
        isLegacyPrismServerKeyName(key) &&
        !desiredKeys.has(key) &&
        hasLegacyPrismProvenance(record[key]),
    );
    if (staleKey === undefined) break;
    const outcome = removeJsonKeyRegion(current, [...jsonPath, staleKey]);
    if (!outcome.changed) break;
    current = outcome.content;
    // Qualified, matching the regionKey format a live region for the same
    // path would carry (e.g. cursor's `mcpServers.<key>`) — so callers can
    // reconcile this sweep's removals against materialized region refs by
    // regionKey alone, regardless of removal source.
    removedKeys.push([...jsonPath, staleKey].join("."));
  }
  return { content: current, changed: removedKeys.length > 0, removedKeys };
};

/**
 * Sweeps `content` (the file's content after normal desired-region
 * application and snapshot-driven orphan removal already ran) for any
 * surviving legacy Prism MCP identity, and removes it. Safe to run
 * unconditionally on every compile, scoped or not — see module doc.
 *
 * `desiredRegions` is this same pass's full desired-region list for the
 * target file (whatever `planSharedFileRegions` was given), threaded
 * through so BOTH branches can exclude this pass's own live entries by
 * key. Fence authorship alone is NOT sufficient provenance for the marker
 * branch: a live plugin whose name sanitizes to the retired sentinel
 * (pluginServerKey("prism_mcp_shim") === "prism-mcp-shim") produces the
 * byte-identical region key, so a marker region claimed by any current
 * desired region is never a sweep candidate — otherwise the sweep would
 * silently cannibalize the plugin's own just-written region.
 */
export const sweepLegacyPrismMcpEntries = (
  harness: string,
  content: string,
  desiredRegions: ReadonlyArray<DesiredRegion> = [],
): LegacySweepOutcome => {
  const markerKey = legacyAggregatedMcpMarkerRegionKey(harness);
  if (markerKey !== undefined) {
    const claimedByDesired = desiredRegions.some(
      (region) => "regionKey" in region && region.regionKey === markerKey,
    );
    if (claimedByDesired) {
      return { content, changed: false, removedKeys: [] };
    }
    const outcome = removeMarkerRegion(content, { commentPrefix: "#", regionKey: markerKey });
    return {
      content: outcome.content,
      changed: outcome.changed,
      removedKeys: outcome.changed ? [markerKey] : [],
    };
  }
  const jsonPath = jsonMcpServerMapPath(harness);
  if (jsonPath !== undefined) {
    const desiredKeys = desiredJsonServerMapKeys(desiredRegions, jsonPath);
    return sweepJsonServerMap(content, jsonPath, desiredKeys);
  }
  return { content, changed: false, removedKeys: [] };
};
