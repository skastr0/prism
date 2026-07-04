#!/usr/bin/env bun
/**
 * Bin entry for the aggregating MCP shim (see `@skastr0/prism-core/mcp/shim`
 * for the actual protocol/aggregation logic). This is the process a harness
 * spawns directly over stdio; it reads its plugin set and daemon-request
 * timeout from the environment and hands off to `runShim`.
 *
 * Not yet wired into any harness lowerer or CLI subcommand — this file is
 * the process entrypoint a later wave points harness MCP configs at.
 */

import { runShim } from "@skastr0/prism-core/mcp/shim";

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

const plugins = parsePluginList(process.env.PRISM_SHIM_PLUGINS);
if (plugins.length === 0) {
  console.error("[prism-mcp-shim] PRISM_SHIM_PLUGINS is empty; the shim will advertise zero tools.");
}

await runShim({
  plugins,
  daemonTimeoutMs: parseTimeoutMs(process.env.PRISM_SHIM_DAEMON_TIMEOUT_MS),
});
