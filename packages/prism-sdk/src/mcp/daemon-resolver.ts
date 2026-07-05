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
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
}

export type SpawnDaemonFn = (options: SpawnDaemonOptions) => void;

/**
 * Spawns `bun <bundle>` detached (so it outlives this process) with the UDS
 * + registry identity env the bundle's own runtime reads at startup (see
 * `PRISM_MCP_UDS_PATH` / `PRISM_MCP_REGISTRY_PLUGIN_NAME` /
 * `PRISM_MCP_REGISTRY_BUNDLE_HASH` in `MCP_SDK_HTTP_RUNTIME`). Never waits
 * on the child and never lets a spawn-level error (e.g. `bun` missing from
 * PATH) throw unhandled -- resolution simply times out and reports a typed
 * `DaemonResolveError` instead.
 */
const defaultSpawnDaemon: SpawnDaemonFn = ({ plugin, bundlePath, udsPath, bundleHash }) => {
  const child = spawn("bun", [bundlePath], {
    cwd: dirname(bundlePath),
    env: {
      ...process.env,
      PRISM_MCP_UDS_PATH: udsPath,
      PRISM_MCP_REGISTRY_PLUGIN_NAME: plugin,
      PRISM_MCP_REGISTRY_BUNDLE_HASH: bundleHash,
    },
    detached: true,
    stdio: "ignore",
  });
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
  readonly getDaemon: GetDaemonFn;
  readonly probeSocketLiveness: ProbeSocketLivenessFn;
  readonly spawnTimeoutMs: number;
  readonly pollIntervalMs: number;
}): Promise<RegistryEntry> => {
  const { plugin, udsPath, getDaemon, probeSocketLiveness, spawnTimeoutMs, pollIntervalMs } = options;
  const deadline = Date.now() + spawnTimeoutMs;

  while (true) {
    const registered = await getDaemon(plugin);
    if (registered.kind === "ok" && registered.value.sock === udsPath) {
      const liveness = await probeSocketLiveness(registered.value.sock);
      if (liveness === "live") return registered.value;
    }

    if (Date.now() >= deadline) {
      throw new DaemonResolveError(
        plugin,
        `spawned daemon did not become live at ${udsPath} within ${spawnTimeoutMs}ms`,
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
  const getDaemon = options.getDaemon ?? getDaemonDefault;
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
  spawnDaemon({ plugin, bundlePath, udsPath, bundleHash: currentHash });

  return waitForLiveEntry({ plugin, udsPath, getDaemon, probeSocketLiveness, spawnTimeoutMs, pollIntervalMs });
};
