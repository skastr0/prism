import { mkdir, writeFile, readFile, unlink, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolvePrismHomeForSdk } from "./prism-home-resolve.js";

/**
 * Error type for registry operation violations.
 * Used to distinguish registry errors from other file system errors.
 */
export class UDSRegistryError extends Error {
  readonly kind = "uds-registry-error" as const;

  constructor(message: string, public readonly context?: unknown) {
    super(message);
    this.name = "UDSRegistryError";
  }
}

/**
 * Per-plugin daemon instance record.
 */
export interface RegistryEntry {
  readonly pid: number;
  readonly sock: string;
  readonly bundleHash: string;
  readonly startedAt: number; // milliseconds since epoch
  readonly lastUsed: number; // milliseconds since epoch
}

/**
 * Registry of active daemon instances, indexed by plugin name.
 */
export type RegistryData = Record<string, RegistryEntry>;

/**
 * Result type for registry operations that may fail gracefully.
 * Success carries the result; absent means the entry does not exist or is corrupted.
 */
export type RegistryResult<T> = { kind: "ok"; value: T } | { kind: "absent" };

/**
 * Storage layout
 * --------------
 * Each plugin owns its own registry file:
 *
 *   ~/.prism/runtime/mcp/<plugin>/<hash>.registry.json
 *
 * where `<hash>` is a short content-addressed digest of the plugin name.
 * There is deliberately no single shared registry.json spanning every
 * plugin: registering plugin A never touches any file plugin B reads or
 * writes, so concurrent registrations across different plugins cannot race
 * on the same path and cannot drop each other's entries. Within one
 * plugin's file, writes are still atomic (write-temp + rename), so the
 * per-plugin file itself is never observed half-written.
 */

/**
 * `<prismHome>/runtime/mcp` — the root of all registry state.
 *
 * `prismHome` is threaded explicitly by every public function below,
 * defaulting through `resolvePrismHomeForSdk()` (explicit param, then
 * `PRISM_HOME` from the environment, then `~/.prism`) when omitted — never
 * a bare, unconditional `homedir()` read. See that function's doc comment
 * for why: an unconditional `homedir()` read here is exactly the defect
 * class that let a test's `beforeEach`/`afterEach` delete the real
 * `~/.prism/runtime/mcp` on the invoking machine.
 */
function registryRootDir(prismHome?: string): string {
  return join(resolvePrismHomeForSdk(prismHome), "runtime", "mcp");
}

/**
 * Filesystem-safe representation of a plugin name for use as a directory
 * segment. Plugin names may contain characters (e.g. `/` in a scoped name
 * like `@scope/plugin`) that would otherwise create unintended nested
 * directories; the original, unsanitized name is preserved inside the
 * stored record itself (see `StoredRecord`) so readers never need to
 * reverse this transform.
 */
function sanitizePluginSegment(plugin: string): string {
  const sanitized = plugin.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "_";
}

function pluginDir(plugin: string, prismHome?: string): string {
  return join(registryRootDir(prismHome), sanitizePluginSegment(plugin));
}

/**
 * Deterministic, content-addressed file name for a plugin's registration
 * record: every reader and writer for a given plugin name resolves to
 * exactly this one path, so there is never ambiguity about which file is
 * "the" current record for that plugin.
 */
function pluginRegistryFilePath(plugin: string, prismHome?: string): string {
  const hash = createHash("sha256").update(plugin).digest("hex").slice(0, 16);
  return join(pluginDir(plugin, prismHome), `${hash}.registry.json`);
}

/** On-disk shape: the entry fields plus the original (unsanitized) plugin name. */
interface StoredRecord extends RegistryEntry {
  readonly plugin: string;
}

function isValidStoredRecord(value: unknown): value is StoredRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.plugin === "string" &&
    typeof record.pid === "number" &&
    typeof record.sock === "string" &&
    typeof record.bundleHash === "string" &&
    typeof record.startedAt === "number" &&
    typeof record.lastUsed === "number"
  );
}

async function ensurePluginDir(plugin: string, prismHome?: string): Promise<void> {
  try {
    await mkdir(pluginDir(plugin, prismHome), { recursive: true });
  } catch {
    // Directory may already exist; proceed.
  }
}

/**
 * Atomically write a single plugin's registration record via write-temp +
 * rename. Because each plugin owns a distinct file, this never reads or
 * merges another plugin's (or another write's) data — there is no
 * read-modify-write of shared state to race on.
 *
 * Throws UDSRegistryError on I/O failure (unrecoverable).
 */
async function writePluginEntry(plugin: string, entry: RegistryEntry, prismHome?: string): Promise<void> {
  try {
    await ensurePluginDir(plugin, prismHome);
  } catch (error) {
    throw new UDSRegistryError(
      `Failed to ensure registry directory for plugin ${plugin}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  const finalPath = pluginRegistryFilePath(plugin, prismHome);
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const tempPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randomSuffix}`;

  const stored: StoredRecord = { ...entry, plugin };

  try {
    await writeFile(tempPath, JSON.stringify(stored, null, 2), "utf8");
    await rename(tempPath, finalPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup failures
    }
    throw new UDSRegistryError(
      `Failed to write registry entry for plugin ${plugin}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * Read a single plugin's registration record. Returns undefined if the file
 * does not exist, is corrupted, or is missing required fields — never
 * throws.
 */
async function readPluginEntry(plugin: string, prismHome?: string): Promise<RegistryEntry | undefined> {
  try {
    const json = await readFile(pluginRegistryFilePath(plugin, prismHome), "utf8");
    const parsed: unknown = JSON.parse(json);
    if (!isValidStoredRecord(parsed)) return undefined;
    const { plugin: _plugin, ...entry } = parsed;
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * Register a new daemon instance or update an existing one.
 *
 * Atomically writes the entry to this plugin's own registry file. Never
 * reads or rewrites any other plugin's file.
 *
 * Throws UDSRegistryError on I/O failure (unrecoverable).
 */
export async function registerDaemon(
  plugin: string,
  entry: RegistryEntry,
  prismHome?: string,
): Promise<void> {
  await writePluginEntry(plugin, entry, prismHome);
}

/**
 * Unregister a daemon instance by plugin name.
 *
 * Removes this plugin's registry file. Does nothing (no error) if the
 * entry does not exist.
 *
 * Throws UDSRegistryError on I/O failure (unrecoverable), file-not-found excepted.
 */
export async function unregisterDaemon(plugin: string, prismHome?: string): Promise<void> {
  try {
    await unlink(pluginRegistryFilePath(plugin, prismHome));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new UDSRegistryError(
      `Failed to unregister plugin ${plugin}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * Get a single daemon entry by plugin name.
 *
 * Returns `{ kind: "ok", value: entry }` on success.
 * Returns `{ kind: "absent" }` if the plugin is not registered or
 * the registry is corrupted.
 *
 * Never throws.
 */
export async function getDaemon(plugin: string, prismHome?: string): Promise<RegistryResult<RegistryEntry>> {
  const entry = await readPluginEntry(plugin, prismHome);
  return entry ? { kind: "ok", value: entry } : { kind: "absent" };
}

/**
 * Get all registered daemon entries across every plugin.
 *
 * Returns `{ kind: "ok", value: data }` on success (may be empty).
 * Returns `{ kind: "absent" }` if the registry root directory does not
 * exist yet (nothing has ever registered).
 *
 * Never throws; unreadable or corrupted per-plugin files are skipped
 * individually rather than failing the whole scan.
 */
export async function getAllDaemons(prismHome?: string): Promise<RegistryResult<RegistryData>> {
  const root = registryRootDir(prismHome);
  let pluginDirs: string[];
  try {
    pluginDirs = await readdir(root);
  } catch {
    return { kind: "absent" };
  }

  const data: RegistryData = {};

  for (const dirName of pluginDirs) {
    let files: string[];
    try {
      files = await readdir(join(root, dirName));
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".registry.json")) continue;
      try {
        const json = await readFile(join(root, dirName, file), "utf8");
        const parsed: unknown = JSON.parse(json);
        if (!isValidStoredRecord(parsed)) continue;
        const { plugin, ...entry } = parsed;
        data[plugin] = entry;
      } catch {
        // Skip unreadable/corrupted per-plugin files; they do not affect
        // any other plugin's data.
      }
    }
  }

  return { kind: "ok", value: data };
}

/**
 * Update the lastUsed timestamp for a daemon entry.
 *
 * Returns `{ kind: "ok" }` on success.
 * Returns `{ kind: "absent" }` if the plugin is not registered.
 *
 * Throws UDSRegistryError on I/O failure (unrecoverable).
 */
export async function touchDaemon(plugin: string, prismHome?: string): Promise<RegistryResult<void>> {
  const entry = await readPluginEntry(plugin, prismHome);
  if (!entry) {
    return { kind: "absent" };
  }

  await writePluginEntry(plugin, { ...entry, lastUsed: Date.now() }, prismHome);

  return { kind: "ok", value: undefined };
}

/**
 * Outcome of `cleanupDaemonIfOwner`.
 *
 * - "cleaned": the record belonged to the given pid; it was unregistered
 *   and the socket file (if provided) was unlinked.
 * - "not-owner": a record exists but names a *different* pid — a successor
 *   that has already re-registered under the same plugin key. Nothing was
 *   touched.
 * - "absent": no record exists for this plugin. Treated as "not ours":
 *   nothing was touched.
 */
export type OwnershipCleanupResult = "cleaned" | "not-owner" | "absent";

/**
 * Ownership-gated teardown for a daemon's registration and socket file.
 *
 * Re-reads the current registry record for `plugin` and only acts — unlink
 * `socketPath` and remove the registry entry — when that record's pid
 * matches `pid`, i.e. when the caller is still the process the registry
 * currently considers live for that plugin.
 *
 * This exists to protect a fast-respawning successor: if a predecessor is
 * slow to drain and only calls this after a successor has already bound
 * the same socket path and re-registered under the same plugin key, the
 * registry record now names the successor's pid — a missing record or one
 * naming a different pid means "not mine to clean up", so the successor's
 * live socket file and registration are left completely untouched.
 */
export async function cleanupDaemonIfOwner(
  plugin: string,
  pid: number,
  socketPath: string | undefined,
  prismHome?: string,
): Promise<OwnershipCleanupResult> {
  const result = await getDaemon(plugin, prismHome);

  if (result.kind === "absent") {
    return "absent";
  }
  if (result.value.pid !== pid) {
    return "not-owner";
  }

  if (socketPath) {
    try {
      await unlink(socketPath);
    } catch {
      // Socket may already be gone; non-fatal.
    }
  }

  await unregisterDaemon(plugin, prismHome);
  return "cleaned";
}
