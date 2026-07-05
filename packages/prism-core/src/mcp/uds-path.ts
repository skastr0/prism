import { homedir } from "os";

/**
 * Error type for UDS path violations.
 * Typed to distinguish from other path errors.
 */
export class UDSPathLengthError extends Error {
  readonly kind = "uds-path-length-error" as const;

  constructor(message: string, public readonly attemptedPath: string) {
    super(message);
    this.name = "UDSPathLengthError";
  }
}

/**
 * macOS sun_path limit (sockaddr_un.sun_path)
 */
const MACOS_SUN_PATH_LIMIT = 104;

/**
 * Tolerance below the hard limit to account for null terminator and safety margin.
 * Standard practice: 104 - 4 bytes = 100 bytes.
 */
const PATH_LENGTH_LIMIT = 100;

/**
 * Regex to validate plugin names: alphanumeric, dash, underscore only.
 * Prevents path traversal and special chars that could break socket path integrity.
 */
const VALID_PLUGIN_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Truncate hash to first 16 hex characters for path length safety.
 * 16 hex chars = 64 bits, sufficient for disambiguation.
 */
function truncateHash(bundleHash: string): string {
  return bundleHash.slice(0, 16);
}

/**
 * Construct a content-addressed UDS socket path.
 *
 * Returns: `<prismHome>/runtime/mcp/<plugin>/<truncated-hash>.sock`
 *
 * @param plugin - Plugin identifier (must match /^[a-zA-Z0-9_-]+$/)
 * @param bundleHash - Full content hash; will be truncated to first 16 hex
 * @param prismHome - Prism home directory. Threaded explicitly by the
 *   caller (the CLI edge resolves `PRISM_HOME` once via `resolvePrismHome()`
 *   and passes the result down); this package cannot import that resolver
 *   itself (`packages/prism-core` has no dependency on the root `src/`
 *   tree), so an omitted value falls back to the same default
 *   (`~/.prism`) `resolvePrismHome()` uses when unset.
 * @returns Absolute path to the socket file
 * @throws UDSPathLengthError if resulting path exceeds 100 bytes
 */
export function udsPathFor(plugin: string, bundleHash: string, prismHome?: string): string {
  // Validate plugin name
  if (!VALID_PLUGIN_NAME.test(plugin)) {
    throw new Error(
      `Invalid plugin name: '${plugin}'. Must match /^[a-zA-Z0-9_-]+$/`
    );
  }

  // Truncate hash to first 16 hex characters
  const truncated = truncateHash(bundleHash);

  // Build the path
  const home = prismHome ?? `${homedir()}/.prism`;
  const relativePath = `runtime/mcp/${plugin}/${truncated}.sock`;
  const fullPath = `${home}/${relativePath}`;

  // Assert length constraint
  const pathLength = Buffer.byteLength(fullPath, "utf8");
  if (pathLength > PATH_LENGTH_LIMIT) {
    throw new UDSPathLengthError(
      `UDS socket path exceeds ${PATH_LENGTH_LIMIT}-byte limit (got ${pathLength} bytes). ` +
        `Plugin name '${plugin}' may be too long.`,
      fullPath
    );
  }

  return fullPath;
}
