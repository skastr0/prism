import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolvePrismHomeForSdk } from "./prism-home-resolve.js";

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
 * Tolerance below the hard limit to account for null terminator and safety margin.
 * Standard practice: 104 - 4 bytes = 100 bytes.
 */
const PATH_LENGTH_LIMIT = 100;

/**
 * Regex to validate plugin names: alphanumeric, dash, underscore only.
 * Prevents path traversal and special chars that could break socket path integrity.
 */
const VALID_PLUGIN_NAME = /^[a-zA-Z0-9_-]+$/;

export function assertValidUdsPluginName(plugin: string): void {
  if (!VALID_PLUGIN_NAME.test(plugin)) {
    throw new Error(
      `Invalid plugin name: '${plugin}'. Must match /^[a-zA-Z0-9_-]+$/`,
    );
  }
}

const socketOwner = (): string =>
  typeof process.getuid === "function" ? String(process.getuid()) : "user";

const socketIdentity = (prismHome: string, plugin: string, bundleHash: string): string =>
  createHash("sha256")
    .update(prismHome)
    .update("\0")
    .update(plugin)
    .update("\0")
    .update(bundleHash)
    .digest("hex")
    .slice(0, 32);

/**
 * Construct a content-addressed UDS socket path.
 *
 * Returns `<prismHome>/runtime/mcp/<plugin>/<hash16>.sock` when that fits.
 * Long Prism homes fall back to a fixed-width path under a per-user
 * temporary namespace: `/tmp/prism-mcp-<uid>/<identity>.sock`.
 *
 * The identity hashes the resolved Prism home, plugin name, and complete
 * bundle hash. The overflow path is required because macOS limits
 * `sockaddr_un.sun_path` to 104 bytes; a normal sandboxed `PRISM_HOME` can
 * already exceed that limit before the plugin name is added. Durable
 * bundle, registry, and log files always remain under Prism home.
 *
 * @param plugin - Plugin identifier (must match /^[a-zA-Z0-9_-]+$/)
 * @param bundleHash - Full content hash
 * @param prismHome - Prism home directory. Threaded explicitly by the
 *   caller (the CLI edge resolves `PRISM_HOME` once via `resolvePrismHome()`
 *   and passes the result down); this package cannot import that resolver
 *   itself (`packages/prism-sdk` has no dependency on the root `src/`
 *   tree). The SDK resolver normalizes the explicit value, then falls back
 *   to `PRISM_HOME` and finally `~/.prism`, exactly like durable runtime
 *   paths do.
 * @returns Absolute path to the socket file
 * @throws UDSPathLengthError if even the fixed-width fallback exceeds 100 bytes
 */
export function udsPathFor(plugin: string, bundleHash: string, prismHome?: string): string {
  assertValidUdsPluginName(plugin);

  const home = resolvePrismHomeForSdk(prismHome);
  const preferredPath = join(
    home,
    "runtime",
    "mcp",
    plugin,
    `${bundleHash.slice(0, 16)}.sock`,
  );
  if (Buffer.byteLength(preferredPath, "utf8") <= PATH_LENGTH_LIMIT) {
    return preferredPath;
  }

  // Prism home remains part of the overflow identity even though its
  // potentially-long literal path is not embedded in sun_path.
  const fallbackPath = join(
    "/tmp",
    `prism-mcp-${socketOwner()}`,
    `${socketIdentity(home, plugin, bundleHash)}.sock`,
  );

  const pathLength = Buffer.byteLength(fallbackPath, "utf8");
  if (pathLength > PATH_LENGTH_LIMIT) {
    throw new UDSPathLengthError(
      `UDS socket path exceeds ${PATH_LENGTH_LIMIT}-byte limit (got ${pathLength} bytes). ` +
        "The fixed Prism MCP socket namespace is not usable on this host.",
      fallbackPath,
    );
  }

  return fallbackPath;
}
