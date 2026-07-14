/**
 * Per-plugin daemon log sink (OBS-001).
 *
 * Every UDS daemon spawned via `daemon-resolver.ts`'s `defaultSpawnDaemon`
 * gets its stdout+stderr redirected here instead of discarded (the prior
 * `stdio: "ignore"`). This file is the ONLY capture channel Prism itself
 * owns for a daemon's own runtime diagnostics -- idle-reap, double-bind,
 * registry errors, the "listening on unix:..." line (see
 * `src/compile/mcp-bundle.ts`'s `MCP_SDK_HTTP_RUNTIME`). It complements,
 * and never replaces, whatever an external process supervisor (launchd,
 * systemd, a dev shell) already captures on its own stderr.
 *
 * Size-capped via truncate-on-start rather than an in-process rotator: the
 * retired launchd era's failure mode was an ever-growing `.err.log` whose
 * unbounded size itself became a source of respawn spam once it crossed a
 * few MB. Daemons idle-reap and re-spawn routinely, so checking the cap
 * once per spawn attempt -- truncating an oversized file back to empty
 * right before the fresh daemon starts appending -- keeps the file bounded
 * across the daemon's natural respawn cadence, without the added machinery
 * of a rotating ring buffer.
 */

import { mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Truncation threshold, in bytes. Matches the exact size whose crossing
 * caused launchd-era log spam, kept as the cap so that failure mode cannot
 * recur.
 */
export const DAEMON_LOG_SIZE_CAP_BYTES = 5 * 1024 * 1024;

/**
 * Ensures `logPath`'s parent directory exists, truncates the file to empty
 * if it has already grown past `DAEMON_LOG_SIZE_CAP_BYTES`, and returns a
 * writable, append-mode file descriptor suitable for use directly as a
 * `child_process.spawn` `stdio` slot.
 *
 * Synchronous by necessity: the caller (`defaultSpawnDaemon`) must have the
 * fd in hand before calling `spawn(...)`, and this only ever runs once per
 * spawn attempt -- not a hot path. Throws on any I/O failure (e.g. a
 * read-only `prismHome`); callers treat that as best-effort and fall back
 * to discarding the child's stdio entirely rather than blocking the spawn.
 */
export const prepareDaemonLogSink = (logPath: string): number => {
  mkdirSync(dirname(logPath), { recursive: true });

  try {
    if (statSync(logPath).size > DAEMON_LOG_SIZE_CAP_BYTES) {
      truncateSync(logPath, 0);
    }
  } catch {
    // No existing file (or unreadable stat) -- nothing to cap; `openSync`
    // below creates a fresh file either way.
  }

  return openSync(logPath, "a");
};
