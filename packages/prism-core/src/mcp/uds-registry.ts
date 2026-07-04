import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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
 * Registry file path: ~/.prism/runtime/mcp/registry.json
 */
function getRegistryPath(): string {
  const home = homedir();
  return join(home, ".prism", "runtime", "mcp", "registry.json");
}

/**
 * Ensure the registry directory exists.
 */
async function ensureRegistryDir(): Promise<void> {
  const path = getRegistryPath();
  const dir = dirname(path);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Directory may already exist; proceed.
  }
}

/**
 * Atomically write the registry data to disk.
 *
 * Uses write-to-temp + rename strategy to ensure atomicity even under
 * concurrent writers. Callers must serialize writes via a lock if multiple
 * writers are possible in the same process.
 *
 * Throws UDSRegistryError on I/O failure (unrecoverable).
 */
export async function writeRegistry(data: RegistryData): Promise<void> {
  try {
    await ensureRegistryDir();
  } catch (error) {
    throw new UDSRegistryError(
      `Failed to ensure registry directory: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  const registryPath = getRegistryPath();
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const tempPath = `${registryPath}.tmp.${process.pid}.${Date.now()}.${randomSuffix}`;

  try {
    // Write to temporary file
    const json = JSON.stringify(data, null, 2);
    await writeFile(tempPath, json, "utf8");

    // Atomic rename (on POSIX, rename is atomic)
    // Re-import to get the current version
    const { rename } = await import("node:fs/promises");
    await rename(tempPath, registryPath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup failures
    }
    throw new UDSRegistryError(
      `Failed to write registry: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * Read the registry data from disk.
 *
 * Returns `{ kind: "ok", value: data }` on success.
 * Returns `{ kind: "absent" }` if:
 * - The file does not exist
 * - The file is corrupted or contains invalid JSON
 * - The file is incomplete (partial write)
 *
 * Never throws; all errors are handled gracefully.
 */
export async function readRegistry(): Promise<RegistryResult<RegistryData>> {
  const registryPath = getRegistryPath();

  try {
    const json = await readFile(registryPath, "utf8");

    // Validate the JSON structure
    const parsed: unknown = JSON.parse(json);

    // Ensure it's a record of entries
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "absent" };
    }

    // Validate each entry has the required shape
    const data = parsed as Record<string, unknown>;
    for (const [plugin, entry] of Object.entries(data)) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("pid" in entry) ||
        !("sock" in entry) ||
        !("bundleHash" in entry) ||
        !("startedAt" in entry) ||
        !("lastUsed" in entry)
      ) {
        // Invalid entry; treat the entire registry as corrupted
        return { kind: "absent" };
      }
    }

    return { kind: "ok", value: data as RegistryData };
  } catch {
    // File does not exist, is corrupted, or cannot be read; return absent.
    return { kind: "absent" };
  }
}

/**
 * Register a new daemon instance or update an existing one.
 *
 * Atomically adds/updates the entry for the given plugin and persists to disk.
 *
 * Throws UDSRegistryError on I/O failure (unrecoverable).
 */
export async function registerDaemon(
  plugin: string,
  entry: RegistryEntry,
): Promise<void> {
  const result = await readRegistry();
  const data = result.kind === "ok" ? result.value : {};

  data[plugin] = entry;

  await writeRegistry(data);
}

/**
 * Unregister a daemon instance by plugin name.
 *
 * Atomically removes the entry and persists to disk.
 * Does nothing (no error) if the entry does not exist.
 *
 * Throws UDSRegistryError on I/O failure (unrecoverable).
 */
export async function unregisterDaemon(plugin: string): Promise<void> {
  const result = await readRegistry();
  const data = result.kind === "ok" ? result.value : {};

  delete data[plugin];

  await writeRegistry(data);
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
export async function getDaemon(plugin: string): Promise<RegistryResult<RegistryEntry>> {
  const result = await readRegistry();

  if (result.kind === "absent") {
    return { kind: "absent" };
  }

  const entry = result.value[plugin];
  if (!entry) {
    return { kind: "absent" };
  }

  return { kind: "ok", value: entry };
}

/**
 * Get all registered daemon entries.
 *
 * Returns `{ kind: "ok", value: data }` on success (may be empty).
 * Returns `{ kind: "absent" }` if the registry is corrupted.
 *
 * Never throws.
 */
export async function getAllDaemons(): Promise<RegistryResult<RegistryData>> {
  return readRegistry();
}

/**
 * Update the lastUsed timestamp for a daemon entry.
 *
 * Returns `{ kind: "ok" }` on success.
 * Returns `{ kind: "absent" }` if the plugin is not registered.
 *
 * Throws UDSRegistryError on I/O failure (unrecoverable).
 */
export async function touchDaemon(plugin: string): Promise<RegistryResult<void>> {
  const result = await readRegistry();
  const data = result.kind === "ok" ? result.value : {};

  const entry = data[plugin];
  if (!entry) {
    return { kind: "absent" };
  }

  data[plugin] = { ...entry, lastUsed: Date.now() };

  await writeRegistry(data);

  return { kind: "ok", value: undefined };
}
