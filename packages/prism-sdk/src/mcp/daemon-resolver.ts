/**
 * Resolve-or-spawn: given a plugin name, produce a *live* daemon registry
 * entry to connect to -- spawning a fresh daemon when the registry has no
 * entry, the recorded entry is dead, or the recorded entry's bundle hash no
 * longer matches the compiled bundle on disk (a `prism refresh` ran since
 * that daemon started).
 *
 * Builds entirely on the wave-0 substrate rather than re-implementing any of
 * it:
 *  - `getDaemon` / the per-plugin registry file (`uds-registry.ts`).
 *  - `udsPathFor`, the content-addressed socket path (`uds-path.ts`) --
 *    a different bundle hash always yields a different socket path, so a
 *    stale daemon (old hash) and a fresh one (new hash) never collide on the
 *    same file.
 *  - `probeSocketLiveness` (`uds-singleton.ts`).
 *
 * This module deliberately never binds a socket or acquires the bind lock
 * itself. Every compiled bundle's own runtime already calls
 * `bindUnixSocketSingleton` on startup (see `src/compile/mcp-bundle.ts`'s
 * `MCP_SDK_HTTP_RUNTIME`), and *that* is what guarantees exactly one winner
 * when N callers race to spawn the same plugin: this module just spawns
 * (possibly redundantly) and waits for a live registry entry to show up.
 * Losing spawns detect "already-served" inside their own bundle and
 * `process.exit(0)` before ever registering.
 */

import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareDaemonLogSink } from "./daemon-log.js";
import { udsPathFor as udsPathForDefault } from "./uds-path.js";
import { getDaemon as getDaemonDefault, type RegistryEntry, type RegistryResult } from "./uds-registry.js";
import { probeSocketLiveness as probeSocketLivenessDefault, type ProbeResult } from "./uds-singleton.js";

export class DaemonResolveError extends Error {
  readonly kind = "daemon-resolve-error" as const;

  constructor(
    readonly pluginName: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`[${pluginName}] ${message}`);
    this.name = "DaemonResolveError";
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export const DEFAULT_SPAWN_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

/**
 * `<prismHome>/runtime/mcp/<plugin>` -- the per-plugin runtime directory
 * that owns this plugin's registry file, socket file(s), and compiled
 * bundle. Derived from `udsPathFor` (any hash value yields the same parent
 * directory) rather than re-deriving the layout independently.
 *
 * `prismHome` is threaded explicitly (never read from the environment
 * here): the CLI edge resolves `PRISM_HOME` once via `resolvePrismHome()`
 * and passes the result down. An omitted value falls back to the same
 * `~/.prism` default `resolvePrismHome()` uses when unset -- `prism-sdk`
 * cannot import that resolver itself (no dependency on the root `src/`
 * tree).
 */
export const pluginRuntimeDir = (plugin: string, prismHome?: string): string =>
  dirname(udsPathForDefault(plugin, "", prismHome));

/**
 * `<prismHome>/runtime/mcp/<plugin>/server.mjs` -- the canonical compiled
 * bundle a `prism refresh` run produces. This module only ever reads it; it
 * never writes or rebuilds it.
 */
export const pluginBundlePath = (plugin: string, prismHome?: string): string =>
  join(pluginRuntimeDir(plugin, prismHome), "server.mjs");

/**
 * `<prismHome>/runtime/mcp/<plugin>/daemon.log` -- the append-only,
 * size-capped file a freshly spawned daemon's stdout+stderr is redirected to
 * (OBS-001; see `daemon-log.ts`'s `prepareDaemonLogSink`). Lives next to the
 * compiled bundle and the daemon's own socket/registry files
 * (`pluginRuntimeDir`), so "where does this plugin's daemon log live" is
 * answered the same deterministic way as "where is its bundle" -- one
 * directory, derived once.
 *
 * This piggybacks on `pluginRuntimeDir`, which in turn derives from
 * `udsPathFor` and so inherits that function's plugin-name/length
 * validation even though a log file path itself carries no such OS
 * constraint (only an actual `bind()`ed socket path is bound by
 * `sockaddr_un.sun_path`). That's intentional: the log necessarily lives in
 * the same directory as the socket this plugin would bind, so if the socket
 * path fits, the log path's directory always fits too -- and if it
 * wouldn't, `resolveOrSpawnDaemon` already fails earlier building the real
 * socket path, before any daemon is spawned for this hint to describe.
 */
export const pluginDaemonLogPath = (plugin: string, prismHome?: string): string =>
  join(pluginRuntimeDir(plugin, prismHome), "daemon.log");

/**
 * `pluginDaemonLogPath`, but never throws -- for call sites where the log
 * path is a cosmetic hint (enriching a timeout error message, an `mcp
 * status` line) rather than the thing actually being spawned or read into.
 * A plugin/prismHome combination that cannot produce a valid UDS-shaped path
 * (see `pluginDaemonLogPath`'s doc comment) degrades to "no hint" instead of
 * replacing the real error or status with an unrelated one.
 */
export const tryPluginDaemonLogPath = (plugin: string, prismHome: string | undefined): string | undefined => {
  try {
    return pluginDaemonLogPath(plugin, prismHome);
  } catch {
    return undefined;
  }
};

const sha256Hex = (content: Buffer | string): string => createHash("sha256").update(content).digest("hex");

export type GetDaemonFn = (plugin: string) => Promise<RegistryResult<RegistryEntry>>;
export type ProbeSocketLivenessFn = (socketPath: string) => Promise<ProbeResult>;
export type HashBundleFn = (bundlePath: string) => Promise<string>;
export type UdsPathForFn = (plugin: string, bundleHash: string) => string;

const defaultHashBundle: HashBundleFn = async (bundlePath) => sha256Hex(await readFile(bundlePath));

export interface SpawnDaemonOptions {
  readonly plugin: string;
  readonly bundlePath: string;
  readonly udsPath: string;
  readonly bundleHash: string;
  /** See `ResolveOrSpawnOptions.prismHome`. Threaded through so the default
   * spawn can locate this plugin's log file (`pluginDaemonLogPath`) the same
   * way it locates everything else -- never re-derived independently. */
  readonly prismHome?: string;
}

export type SpawnDaemonFn = (options: SpawnDaemonOptions) => void;

/**
 * Spawns `bun <bundle>` detached (so it outlives this process) with the UDS
 * + registry identity env the bundle's own runtime reads at startup (see
 * `PRISM_MCP_UDS_PATH` / `PRISM_MCP_REGISTRY_PLUGIN_NAME` /
 * `PRISM_MCP_REGISTRY_BUNDLE_HASH` in `MCP_SDK_HTTP_RUNTIME`). Redirects the
 * child's stdout+stderr to its per-plugin, size-capped log file
 * (`pluginDaemonLogPath`, OBS-001) instead of the prior `stdio: "ignore"` --
 * every diagnostic the compiled bundle's runtime emits (idle-reap,
 * double-bind, registry errors, the "listening on unix:..." line) is now
 * readable after the fact. Never waits on the child and never lets a
 * spawn-level error -- `bun` missing from PATH, or the log sink itself
 * failing to open (e.g. a read-only `prismHome`; logging is best-effort) --
 * throw unhandled: resolution simply times out and reports a typed
 * `DaemonResolveError` instead.
 */
const defaultSpawnDaemon: SpawnDaemonFn = ({ plugin, bundlePath, udsPath, bundleHash, prismHome }) => {
  let logFd: number | undefined;
  try {
    logFd = prepareDaemonLogSink(pluginDaemonLogPath(plugin, prismHome));
  } catch {
    // Best-effort: a log-sink failure must never block the daemon spawn
    // itself -- fall back to the pre-OBS-001 behavior (discarded stdio).
  }

  const child = spawn("bun", [bundlePath], {
    cwd: dirname(bundlePath),
    env: {
      ...process.env,
      PRISM_MCP_UDS_PATH: udsPath,
      PRISM_MCP_REGISTRY_PLUGIN_NAME: plugin,
      PRISM_MCP_REGISTRY_BUNDLE_HASH: bundleHash,
    },
    detached: true,
    // Same fd for both slots: the child's stdout/stderr descriptors are
    // both duplicated from this one open file description and so share its
    // file offset, interleaving correctly (same mechanism as shell's
    // `2>&1`).
    stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
  });
  if (logFd !== undefined) {
    // `spawn` duplicates the fd into the child synchronously before
    // returning; closing our own copy here avoids leaking one fd per
    // respawn in a long-lived caller (the stdio shim resolves-or-spawns
    // repeatedly over its process lifetime). The child keeps writing
    // through its own copy either way.
    try {
      closeSync(logFd);
    } catch {
      // Non-fatal.
    }
  }
  child.on("error", () => undefined);
  child.unref();
};

export interface ResolveOrSpawnOptions {
  readonly plugin: string;
  /**
   * Prism home directory, threaded from the CLI edge (`resolvePrismHome()`).
   * Only consulted to build the *default* `bundlePathFor`/`udsPathFor`; a
   * caller that supplies either override directly takes over that
   * resolution entirely and this is ignored for that one.
   */
  readonly prismHome?: string;
  readonly spawnTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly getDaemon?: GetDaemonFn;
  readonly probeSocketLiveness?: ProbeSocketLivenessFn;
  readonly bundlePathFor?: (plugin: string) => string;
  readonly udsPathFor?: UdsPathForFn;
  readonly hashBundle?: HashBundleFn;
  readonly spawnDaemon?: SpawnDaemonFn;
}

/**
 * Returns `true` when the bundle on disk no longer matches
 * `registeredHash`. Locating the bundle (`bundlePathFor`, which by default
 * derives from `udsPathFor` and so can throw `UDSPathLengthError` for a
 * plugin/home combination that would not fit a UDS socket path either) or
 * reading it (deleted, or -- in a hermetic test -- never written) are both
 * treated as "unknown, not proven stale": a live daemon is strictly better
 * than none, so failing to independently re-derive where a *hypothetical
 * replacement* bundle would live never forces a respawn of an
 * otherwise-healthy, already-reachable daemon.
 */
const isBundleStale = async (options: {
  readonly plugin: string;
  readonly registeredHash: string;
  readonly bundlePathFor: (plugin: string) => string;
  readonly hashBundle: HashBundleFn;
}): Promise<boolean> => {
  try {
    const bundlePath = options.bundlePathFor(options.plugin);
    return (await options.hashBundle(bundlePath)) !== options.registeredHash;
  } catch {
    return false;
  }
};

const waitForLiveEntry = async (options: {
  readonly plugin: string;
  readonly udsPath: string;
  readonly prismHome: string | undefined;
  readonly getDaemon: GetDaemonFn;
  readonly probeSocketLiveness: ProbeSocketLivenessFn;
  readonly spawnTimeoutMs: number;
  readonly pollIntervalMs: number;
}): Promise<RegistryEntry> => {
  const { plugin, udsPath, prismHome, getDaemon, probeSocketLiveness, spawnTimeoutMs, pollIntervalMs } = options;
  const deadline = Date.now() + spawnTimeoutMs;

  while (true) {
    const registered = await getDaemon(plugin);
    if (registered.kind === "ok" && registered.value.sock === udsPath) {
      const liveness = await probeSocketLiveness(registered.value.sock);
      if (liveness === "live") return registered.value;
    }

    if (Date.now() >= deadline) {
      // Points the operator at the same log file `defaultSpawnDaemon` wrote
      // to (OBS-001) -- a spawn that never came live is exactly the case a
      // human needs to read the daemon's own diagnostics for.
      const logPath = tryPluginDaemonLogPath(plugin, prismHome);
      const logHint = logPath ? ` (see ${logPath} for daemon diagnostics)` : "";
      throw new DaemonResolveError(
        plugin,
        `spawned daemon did not become live at ${udsPath} within ${spawnTimeoutMs}ms${logHint}`,
      );
    }
    await delay(pollIntervalMs);
  }
};

/**
 * Resolves the live registry entry to connect to for `plugin`:
 *
 *   registry entry present -> liveness probe
 *     live & bundle hash matches on-disk bundle -> use it
 *     dead, OR bundle hash stale               -> spawn fresh
 *   registry entry absent                       -> spawn fresh
 *
 * "Spawn fresh" computes the bundle's current content hash, derives its
 * content-addressed socket path via `udsPathFor`, launches the daemon, and
 * polls the registry + a liveness probe until a live entry at that exact
 * socket path appears or `spawnTimeoutMs` elapses.
 *
 * Throws `DaemonResolveError` when the bundle cannot be read (nothing to
 * spawn) or the spawned daemon never becomes live in time.
 */
export const resolveOrSpawnDaemon = async (options: ResolveOrSpawnOptions): Promise<RegistryEntry> => {
  const { plugin } = options;
  const spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // Bind `prismHome` into the default lookup -- an override supplied
  // directly via `options.getDaemon` takes over resolution entirely (same
  // convention as `bundlePathFor`/`udsPathFor` below) and is used as-is.
  const getDaemon = options.getDaemon ?? ((pluginName: string) => getDaemonDefault(pluginName, options.prismHome));
  const probeSocketLiveness = options.probeSocketLiveness ?? probeSocketLivenessDefault;
  const bundlePathFor =
    options.bundlePathFor ?? ((plugin: string) => pluginBundlePath(plugin, options.prismHome));
  const buildUdsPath =
    options.udsPathFor ?? ((plugin: string, bundleHash: string) => udsPathForDefault(plugin, bundleHash, options.prismHome));
  const hashBundle = options.hashBundle ?? defaultHashBundle;
  const spawnDaemon = options.spawnDaemon ?? defaultSpawnDaemon;

  const registered = await getDaemon(plugin);
  if (registered.kind === "ok") {
    const liveness = await probeSocketLiveness(registered.value.sock);
    if (liveness === "live") {
      const stale = await isBundleStale({
        plugin,
        registeredHash: registered.value.bundleHash,
        bundlePathFor,
        hashBundle,
      });
      if (!stale) return registered.value;
    }
  }

  // Reaching here means we are actually about to spawn, so -- unlike the
  // staleness check above -- locating and reading the bundle now has to
  // succeed; there is nothing to fall back to.
  let bundlePath: string;
  let currentHash: string;
  try {
    bundlePath = bundlePathFor(plugin);
    currentHash = await hashBundle(bundlePath);
  } catch (error) {
    throw new DaemonResolveError(
      plugin,
      `cannot spawn: unable to locate/read compiled bundle: ${errorMessage(error)}`,
      error,
    );
  }

  const udsPath = buildUdsPath(plugin, currentHash);
  spawnDaemon({ plugin, bundlePath, udsPath, bundleHash: currentHash, prismHome: options.prismHome });

  return waitForLiveEntry({
    plugin,
    udsPath,
    prismHome: options.prismHome,
    getDaemon,
    probeSocketLiveness,
    spawnTimeoutMs,
    pollIntervalMs,
  });
};
