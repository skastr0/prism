import { chmod, lstat, mkdir, unlink, readFile, open } from "node:fs/promises";
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
 * Shape of the JSON payload written into a lock file by its holder.
 */
interface LockHolder {
  readonly pid: number;
  readonly startedAt: number;
}

/**
 * Returns true if a process with the given pid is currently alive.
 *
 * Uses the `kill(pid, 0)` idiom: no signal is actually delivered, but the
 * OS still validates that a process with this pid exists and reports
 * permission errors for processes that exist but are owned by another
 * user (EPERM means "alive, just not signalable by us" — still alive).
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Best-effort read of the holder recorded in a lock file. Returns undefined
 * if the file is missing, unreadable, or does not contain a well-formed
 * holder record — callers must treat that as "unknown holder" and never
 * infer liveness from it.
 */
async function readLockHolder(lockPath: string): Promise<LockHolder | undefined> {
  try {
    const content = await readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { pid?: unknown }).pid === "number" &&
      typeof (parsed as { startedAt?: unknown }).startedAt === "number"
    ) {
      return parsed as LockHolder;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attempt to exclusively create the lock file in one atomic step (open with
 * the `wx` flag: O_CREAT | O_EXCL). Unlike rename-based "locking", this
 * fails with EEXIST when the destination already exists instead of
 * silently replacing it — exactly one concurrent caller can ever succeed
 * for a given lockPath.
 *
 * Returns true if this call created the file (lock acquired), false if the
 * file already existed (EEXIST). Any other error propagates.
 */
async function tryCreateLockFile(lockPath: string, pid: number): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }

  try {
    const payload: LockHolder = { pid, startedAt: Date.now() };
    await handle.writeFile(JSON.stringify(payload), "utf8");
    return true;
  } finally {
    await handle.close();
  }
}

async function ensurePrivateLockDirectory(lockDir: string): Promise<void> {
  try {
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new UDSSingletonError(`Failed to create lock directory ${lockDir}`, error);
  }

  let info;
  try {
    info = await lstat(lockDir);
  } catch (error) {
    throw new UDSSingletonError(`Failed to inspect lock directory ${lockDir}`, error);
  }

  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new UDSSingletonError(`Lock directory ${lockDir} must be a real directory`);
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) {
    throw new UDSSingletonError(
      `Lock directory ${lockDir} is owned by uid ${info.uid}, expected ${uid}`,
    );
  }

  if ((info.mode & 0o777) !== 0o700) {
    try {
      await chmod(lockDir, 0o700);
      info = await lstat(lockDir);
    } catch (error) {
      throw new UDSSingletonError(`Failed to secure lock directory ${lockDir}`, error);
    }
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
      throw new UDSSingletonError(`Lock directory ${lockDir} could not be secured to mode 0700`);
    }
    if (uid !== undefined && info.uid !== uid) {
      throw new UDSSingletonError(
        `Lock directory ${lockDir} changed ownership while being secured`,
      );
    }
  }
}

/**
 * Acquire a lock via exclusive file creation (fs `wx` open), with
 * dead-holder reclamation and retry.
 *
 * Only one concurrent caller can ever hold the lock: the underlying
 * `open(lockPath, "wx")` is an atomic O_CREAT|O_EXCL create that fails with
 * EEXIST for every caller after the first, unlike a rename-based scheme
 * (which silently replaces the destination and lets every racer "succeed").
 *
 * On EEXIST, the recorded holder's pid is liveness-checked via
 * `process.kill(pid, 0)`: a dead holder's lock file is reclaimed (unlinked)
 * and creation is retried once immediately; a live holder means the lock is
 * genuinely held elsewhere, so this attempt waits out the retry interval
 * and tries again until timeoutMs elapses.
 *
 * @param lockPath Path to the lock file
 * @param timeoutMs How long to wait
 * @param pid Process ID to write into the lock file
 */
export async function acquireLock(
  lockPath: string,
  timeoutMs: number,
  pid: number,
): Promise<boolean> {
  const lockDir = dirname(lockPath);
  const startTime = Date.now();
  const retryIntervalMs = 10;

  await ensurePrivateLockDirectory(lockDir);

  while (Date.now() - startTime < timeoutMs) {
    if (await tryCreateLockFile(lockPath, pid)) {
      return true;
    }

    // Lock file exists (EEXIST). Inspect the holder before deciding to wait.
    const holder = await readLockHolder(lockPath);
    if (holder && !isProcessAlive(holder.pid)) {
      // Stale lock left by a dead process: reclaim it and retry immediately,
      // once, before falling back to the normal wait-and-retry loop.
      try {
        await unlink(lockPath);
      } catch {
        // Another process may have already reclaimed/removed it; fall
        // through to the retry loop below.
      }
      if (await tryCreateLockFile(lockPath, pid)) {
        return true;
      }
    }

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

/**
 * Outcome of `bindUnixSocketSingleton`.
 *
 * - "bound": this call's `bind` callback ran and its result is attached.
 * - "already-served": a live daemon already owns the socket; the caller
 *   should exit cleanly (e.g. `process.exit(0)`) without ever binding.
 */
export type UdsBindOutcome<T> =
  | { readonly kind: "bound"; readonly server: T }
  | { readonly kind: "already-served" };

function isAddrInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

/**
 * Probe, recover from a stale socket, and invoke `bind()` — all inside the
 * single critical section held by the `<socketPath>.lock` file.
 *
 * This closes the race the two-step "check bindability, then bind()
 * separately" pattern leaves open: between releasing the probe/unlink lock
 * and actually calling `bind()`, another process could probe the same
 * now-empty path, also decide it is free, and race this one to `bind()`.
 * Here `bind()` itself runs while the lock is still held, so at most one
 * process per lock ever reaches it while the path is in the
 * stale/available state.
 *
 * `bind()` is also wrapped in try/catch: if it still throws EADDRINUSE
 * (e.g. a process outside this locking scheme bound the path, or a timing
 * gap before the lock was acquired), the live owner is re-probed — if it
 * responds, this process reports "already-served" instead of crashing
 * uncaught; if it does not respond, the socket is stale, and `bind()` is
 * retried exactly once after unlinking it.
 *
 * @param socketPath Absolute path to the UDS socket
 * @param bind Callback that performs the actual bind (e.g. `() => Bun.serve(...)`)
 * @param lockTimeoutMs How long to wait acquiring the lock file
 */
export async function bindUnixSocketSingleton<T>(
  socketPath: string,
  bind: () => T | Promise<T>,
  lockTimeoutMs: number = 1000,
): Promise<UdsBindOutcome<T>> {
  const lockPath = `${socketPath}.lock`;
  const lockAcquired = await acquireLock(lockPath, lockTimeoutMs, process.pid);

  if (!lockAcquired) {
    // Could not get the bind lock in time; check whether someone else is
    // actually serving before giving up entirely.
    const probeResult = await probeSocketLiveness(socketPath);
    if (probeResult === "live") {
      return { kind: "already-served" };
    }
    throw new UDSSingletonError(
      `Failed to acquire bind lock on ${lockPath} within ${lockTimeoutMs}ms; socket state is ${probeResult}`,
    );
  }

  try {
    return await bindWithRecovery(socketPath, bind);
  } finally {
    try {
      await unlink(lockPath);
    } catch {
      // Lock file cleanup failures are non-fatal.
    }
  }
}

async function bindWithRecovery<T>(
  socketPath: string,
  bind: () => T | Promise<T>,
): Promise<UdsBindOutcome<T>> {
  const initialProbe = await probeSocketLiveness(socketPath);
  if (initialProbe === "live") {
    return { kind: "already-served" };
  }
  if (initialProbe === "stale") {
    try {
      await unlink(socketPath);
    } catch {
      // May already be gone.
    }
  }

  try {
    const server = await bind();
    return { kind: "bound", server };
  } catch (error) {
    if (!isAddrInUseError(error)) {
      throw error;
    }

    // Something bound the path between our probe and our bind() attempt.
    const raceProbe = await probeSocketLiveness(socketPath);
    if (raceProbe === "live") {
      return { kind: "already-served" };
    }

    // Stale socket file left behind by a process that died mid-race;
    // reclaim it and retry exactly once.
    try {
      await unlink(socketPath);
    } catch {
      // May already be gone.
    }
    const server = await bind();
    return { kind: "bound", server };
  }
}
