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

import { runShim } from "@skastr0/prism-sdk/mcp/shim";
import { resolvePrismHome } from "../prism-home.js";

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

const plugins = parsePluginList(process.env.PRISM_SHIM_PLUGINS);
if (plugins.length === 0) {
  console.error("[prism-mcp-shim] PRISM_SHIM_PLUGINS is empty; the shim will advertise zero tools.");
}

await runShim({
  plugins,
  // Resolved once, here, at the process entrypoint (the CLI edge for this
  // process) -- never re-read from the environment inside prism-sdk, which
  // has no dependency on this resolver (see `ShimAggregatorOptions.prismHome`).
  prismHome: resolvePrismHome(),
  daemonTimeoutMs: parseTimeoutMs(process.env.PRISM_SHIM_DAEMON_TIMEOUT_MS),
  spawnTimeoutMs: parseTimeoutMs(process.env.PRISM_SHIM_SPAWN_TIMEOUT_MS),
  enabledTools: parseToolNameSet(process.env.PRISM_SHIM_ENABLED_TOOLS),
  exposureProfile: parseExposureProfile(process.env.PRISM_SHIM_EXPOSURE),
});
