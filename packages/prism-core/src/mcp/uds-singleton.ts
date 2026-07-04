import { mkdir, unlink, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { Socket } from "node:net";

/**
 * Error type for singleton/stale-socket violations.
 */
export class UDSSingletonError extends Error {
  readonly kind = "uds-singleton-error" as const;

  constructor(message: string, public readonly context?: unknown) {
    super(message);
    this.name = "UDSSingletonError";
  }
}

/**
 * Result of probing for an existing live daemon on a socket path.
 *
 * - "live": Another daemon is running on this socket; this process should exit.
 * - "stale": Socket file exists but the daemon is not responding; safe to unlink and bind.
 * - "available": Socket path is free; bind immediately.
 */
export type ProbeResult = "live" | "stale" | "available";

/**
 * Attempt to connect to an existing Unix domain socket to detect a live daemon.
 *
 * Returns "live" if a connection succeeds (live daemon).
 * Returns "stale" if connection is refused/times out (socket file exists but no daemon).
 * Returns "available" if the socket file does not exist.
 *
 * @param socketPath Absolute path to the UDS socket
 * @param timeoutMs How long to wait before considering a connection attempt stale
 */
export async function probeSocketLiveness(
  socketPath: string,
  timeoutMs: number = 500,
): Promise<ProbeResult> {
  // Socket file does not exist — path is available
  if (!existsSync(socketPath)) {
    return "available";
  }

  // Socket file exists; try connecting to detect a live daemon
  return new Promise<ProbeResult>((resolve) => {
    const socket = new Socket();
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve("stale");
      }
    }, timeoutMs);

    socket.on("connect", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve("live");
      }
    });

    socket.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve("stale");
      }
    });

    socket.connect({ path: socketPath });
  });
}

/**
 * Acquire a lock using atomic file write + retry pattern.
 * Returns true if lock acquired, false on timeout.
 *
 * Lock is held by writing to a temp file then atomically renaming it to lockPath.
 * Only one process can succeed; others will retry until timeout.
 *
 * @param lockPath Path to the lock file
 * @param timeoutMs How long to wait
 * @param pid Process ID to write into the lock file
 */
async function acquireLock(
  lockPath: string,
  timeoutMs: number,
  pid: number,
): Promise<boolean> {
  const lockDir = dirname(lockPath);
  const startTime = Date.now();
  const retryIntervalMs = 10;

  // Ensure lock directory exists
  try {
    await mkdir(lockDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  while (Date.now() - startTime < timeoutMs) {
    // Try to acquire lock: write PID to a temp file and atomically rename
    const tempLockPath = `${lockPath}.${pid}.${Date.now()}.tmp`;

    try {
      // Write to temp file (always succeeds)
      await writeFile(tempLockPath, String(pid), "utf8");

      // Atomic rename: succeeds only if lockPath doesn't exist yet
      // If it exists, rename fails and we retry
      try {
        // Try to rename (atomic operation)
        const { rename } = await import("node:fs/promises");
        await rename(tempLockPath, lockPath);
        return true; // Lock acquired
      } catch {
        // Rename failed; lockPath already exists (another process has the lock)
        // Clean up the temp file and retry
        try {
          await unlink(tempLockPath);
        } catch {
          // Cleanup failure is non-fatal
        }
      }
    } catch {
      // Temp file write failed; cleanup and retry
      try {
        await unlink(tempLockPath);
      } catch {
        // Cleanup failure is non-fatal
      }
    }

    // Wait a bit before retrying
    await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
  }

  return false; // Timeout reached
}

/**
 * Atomically probe and recover from a stale socket using a lock file for race safety.
 *
 * On the first call (or after lock acquisition), probes for a live daemon:
 * - If live: returns "live" immediately (this process should exit)
 * - If stale: unlinks the socket file and returns "stale-recovered"
 * - If available: returns "available" immediately
 *
 * The lock file (at `<socketPath>.lock`) ensures only one process enters the
 * probe-unlink-bind critical section at a time. Two simultaneous spawners will
 * race to acquire the lock; the winner probes/unlinks/binds, the loser re-probes
 * and discovers "live" (sees the winner's bound socket) and exits.
 *
 * @param socketPath Absolute path to the UDS socket
 * @param lockTimeoutMs How long to wait acquiring the lock file
 * @returns "live" (other daemon won the race), "stale-recovered" (unlinked stale socket), or "available" (free to bind)
 * @throws UDSSingletonError if lock acquisition fails or other I/O errors
 */
export async function probeAndRecoverWithLock(
  socketPath: string,
  lockTimeoutMs: number = 1000,
): Promise<"live" | "stale-recovered" | "available"> {
  const lockPath = `${socketPath}.lock`;

  // Try to acquire lock
  const lockAcquired = await acquireLock(lockPath, lockTimeoutMs, process.pid);

  if (!lockAcquired) {
    // Lock acquisition timed out; re-probe to see if another process succeeded
    const probeResult = await probeSocketLiveness(socketPath);
    if (probeResult === "live") {
      return "live";
    }
    // Stale or available; try again (may get lock next time)
    throw new UDSSingletonError(
      `Failed to acquire lock on ${lockPath} within ${lockTimeoutMs}ms; socket state is ${probeResult}`,
    );
  }

  try {
    // Locked section: probe for a live daemon
    const probeResult = await probeSocketLiveness(socketPath);

    if (probeResult === "live") {
      // Another daemon owns this socket
      return "live";
    }

    if (probeResult === "stale") {
      // Socket file is stale; unlink it so bind() can proceed
      try {
        await unlink(socketPath);
      } catch {
        // May have already been unlinked by another process; safe to ignore
      }
      return "stale-recovered";
    }

    // Socket path is free
    return "available";
  } finally {
    // Release lock by deleting the lock file
    try {
      await unlink(lockPath);
    } catch {
      // Lock file cleanup failures are non-fatal
    }
  }
}

/**
 * Ensure the daemon can bind to the given socket path, handling stale sockets.
 *
 * This is the high-level entry point for singleton + stale-socket recovery.
 * Call this before binding to a UDS socket in your server:
 *
 * ```
 * const result = await ensureSocketBindability(socketPath);
 * if (result === "live") {
 *   // Another daemon already owns this socket; exit gracefully
 *   process.exit(0);
 * }
 * // result is "stale-recovered" or "available"; proceed with binding
 * ```
 *
 * @param socketPath Absolute path to the UDS socket
 * @returns "live" if another daemon owns the socket (exit immediately),
 *          or "stale-recovered"/"available" (safe to bind)
 * @throws UDSSingletonError on unrecoverable errors (lock acquisition, etc.)
 */
export async function ensureSocketBindability(
  socketPath: string,
): Promise<"live" | "stale-recovered" | "available"> {
  return probeAndRecoverWithLock(socketPath);
}
