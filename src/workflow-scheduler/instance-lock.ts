/**
 * Machine-wide single-instance lock for the scheduler.
 *
 * Exactly one scheduler may serve a Prism home. Two would each believe they own
 * the schedule catalog, and while the store's occupancy index prevents two
 * *concurrent executions of one schedule*, it does not prevent two schedulers
 * from fighting over every schedule in turn.
 *
 * The lock is a dedicated SQLite file whose **only** job is mutual exclusion:
 *
 *   1. Open the file with `busy_timeout = 0` so contention fails immediately
 *      rather than stalling a tick.
 *   2. `BEGIN IMMEDIATE` and hold the transaction for the process lifetime.
 *
 * `BEGIN IMMEDIATE` takes SQLite's RESERVED lock, so a second scheduler's
 * `BEGIN IMMEDIATE` raises `SQLITE_BUSY`, while readers are unaffected — a
 * reserved lock does not block reads. When the holder dies the OS releases the
 * file lock with the process, so a `SIGKILL` cannot leave the lock stuck.
 *
 * Two alternatives were rejected deliberately:
 *
 *   - **A pidfile with `O_EXCL`.** Survives a crash as stale state and then
 *     needs racy reclamation logic, which is the problem it was meant to solve.
 *   - **A pid/heartbeat row as the lock.** Expiry cannot safely authorize
 *     takeover: an aged heartbeat means unhealthy, not dead. That row is still
 *     written — into `scheduler_instances` — but it is *reporting*, not
 *     exclusion. Conflating the two is how a second scheduler ends up running
 *     work alongside a slow first one.
 *
 * `bun:ffi`-based `flock` was also rejected: Bun 1.3.14 exposes no file-lock API
 * and `node:fs` exports no `LOCK_*` constants, so it would mean shipping a native
 * adapter with its own source and compiled-binary test burden for a guarantee
 * SQLite already provides.
 */

import { Database } from "bun:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_FILE_MODE = 0o600;
const LOCK_DIRECTORY_MODE = 0o700;

export type SchedulerInstanceLockResult =
  | { readonly kind: "acquired"; readonly release: () => void }
  | { readonly kind: "held" }
  | { readonly kind: "error"; readonly reason: string };

/**
 * Take the machine-wide scheduler lock without blocking.
 *
 * `held` means another scheduler owns it, and the caller should exit
 * successfully — losing this race means the desired state is already achieved,
 * which is not a failure. Only an unexpected error is reported as `error`.
 */
export const acquireSchedulerInstanceLock = (lockPath: string): SchedulerInstanceLockResult => {
  let db: Database | undefined;
  try {
    const directory = dirname(lockPath);
    mkdirSync(directory, { recursive: true, mode: LOCK_DIRECTORY_MODE });
    chmodSync(directory, LOCK_DIRECTORY_MODE);
    // Opened before the Database handle so the mode is applied at creation and
    // the file is never briefly readable by other users.
    closeSync(openSync(lockPath, "a", LOCK_FILE_MODE));
    chmodSync(lockPath, LOCK_FILE_MODE);

    db = new Database(lockPath);
    db.exec("pragma busy_timeout = 0;");
    // A valid, minimal database. `BEGIN IMMEDIATE` alone is the lock; nothing is
    // ever written, because a committed row would be a second, contradicting
    // source of truth for who is running.
    db.exec("create table if not exists scheduler_mutex (id integer primary key);");
    try {
      db.exec("begin immediate;");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.close();
      if (message.includes("SQLITE_BUSY") || message.includes("database is locked")) {
        return { kind: "held" };
      }
      return { kind: "error", reason: message };
    }

    const owned = db;
    let released = false;
    return {
      kind: "acquired",
      release: () => {
        if (released) return;
        released = true;
        try {
          owned.exec("commit;");
        } catch {
          // A failed commit cannot leave the lock held: closing the database
          // releases the file lock, and the OS releases it on process death.
        }
        owned.close();
      },
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // best-effort
    }
    return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Whether the lock is currently held, by attempting to take and immediately
 * release it. For `scheduler status` only — never used to decide whether to
 * launch work, because the answer is stale the moment it is read. `null` means
 * the question could not be answered, which is reported as unknown rather than
 * as "free".
 */
export const schedulerLockIsHeld = (lockPath: string): boolean | null => {
  const result = acquireSchedulerInstanceLock(lockPath);
  if (result.kind === "acquired") {
    result.release();
    return false;
  }
  if (result.kind === "held") return true;
  return null;
};
