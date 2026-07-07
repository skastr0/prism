#!/usr/bin/env bun
/**
 * Bin entry for the aggregating MCP shim (see `@skastr0/prism-sdk/mcp/shim`
 * for the actual protocol/aggregation logic). This is the process a harness
 * spawns directly over stdio (via the `prism mcp shim` CLI subcommand, and
 * the `command`/`args` a `stdio-shim`-transport lowerer writes into the
 * harness's generated MCP config); it reads its plugin set, daemon-request
 * timeout, and resolve-or-spawn timeout from the environment and hands off
 * to `runShim`.
 */

import { runShim, type ShimNamingMode } from "@skastr0/prism-sdk/mcp/shim";
import { SHIM_HARNESS_IDS, type ShimHarnessId } from "@skastr0/prism-sdk/mcp/wire-naming";
import { resolvePrismHome } from "../prism-home.js";

/**
 * Wire naming is harness-specific (see `wire-naming.ts`'s `renderWire`), so
 * a harness whose lowerer forgot to set `PRISM_SHIM_HARNESS` — or an older
 * config predating this env var — needs a defined fallback rather than an
 * `undefined` that would crash `ShimAggregator`'s per-harness lookup.
 * Claude Code is the harness the original shim branch was written against,
 * so it is the least-surprising default.
 */
const DEFAULT_SHIM_HARNESS: ShimHarnessId = "claude-code";

const parseHarness = (raw: string | undefined): ShimHarnessId => {
  if (raw !== undefined && (SHIM_HARNESS_IDS as ReadonlyArray<string>).includes(raw)) {
    return raw as ShimHarnessId;
  }
  console.error(
    `[prism-mcp-shim] PRISM_SHIM_HARNESS is missing or unrecognized ('${raw ?? ""}'); defaulting to '${DEFAULT_SHIM_HARNESS}' wire naming.`,
  );
  return DEFAULT_SHIM_HARNESS;
};

const parsePluginList = (raw: string | undefined): ReadonlyArray<string> =>
  (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

const parseTimeoutMs = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const parseToolNameSet = (raw: string | undefined): ReadonlySet<string> | undefined => {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names.length > 0 ? new Set(names) : undefined;
};

const parseExposureProfile = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return raw.trim();
};

/**
 * `PRISM_SHIM_NAMING=per-plugin` selects the per-plugin server shape (one
 * plugin, bare wire tool names — see `ShimNamingMode`). Anything else —
 * absent, empty, or unrecognized — is the legacy aggregated shape. A
 * `per-plugin` value with N != 1 plugins is a lowerer config bug; it is
 * reported and downgraded to aggregated rather than crashing the harness's
 * MCP handshake.
 */
const parseNaming = (raw: string | undefined, pluginCount: number): ShimNamingMode => {
  const value = raw?.trim();
  if (value !== "per-plugin") {
    if (value !== undefined && value.length > 0 && value !== "aggregated") {
      console.error(`[prism-mcp-shim] PRISM_SHIM_NAMING unrecognized ('${value}'); using 'aggregated'.`);
    }
    return "aggregated";
  }
  if (pluginCount !== 1) {
    console.error(
      `[prism-mcp-shim] PRISM_SHIM_NAMING=per-plugin requires exactly one plugin (got ${pluginCount}); using 'aggregated'.`,
    );
    return "aggregated";
  }
  return "per-plugin";
};

const plugins = parsePluginList(process.env.PRISM_SHIM_PLUGINS);
if (plugins.length === 0) {
  console.error("[prism-mcp-shim] PRISM_SHIM_PLUGINS is empty; the shim will advertise zero tools.");
}

await runShim({
  plugins,
  harness: parseHarness(process.env.PRISM_SHIM_HARNESS),
  naming: parseNaming(process.env.PRISM_SHIM_NAMING, plugins.length),
  // Resolved once, here, at the process entrypoint (the CLI edge for this
  // process) -- never re-read from the environment inside prism-sdk, which
  // has no dependency on this resolver (see `ShimAggregatorOptions.prismHome`).
  prismHome: resolvePrismHome(),
  daemonTimeoutMs: parseTimeoutMs(process.env.PRISM_SHIM_DAEMON_TIMEOUT_MS),
  spawnTimeoutMs: parseTimeoutMs(process.env.PRISM_SHIM_SPAWN_TIMEOUT_MS),
  enabledTools: parseToolNameSet(process.env.PRISM_SHIM_ENABLED_TOOLS),
  exposureProfile: parseExposureProfile(process.env.PRISM_SHIM_EXPOSURE),
});
