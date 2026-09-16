/**
 * Process identity and tri-state observation.
 *
 * The scheduler has to answer one question about a worker it launched earlier,
 * possibly in a previous life of the process: *is that same process still
 * running?* A pid alone cannot answer it. Pids are reused, and the boolean
 * `processIsAlive` helper in `workflow-store.ts` answers "false" for every
 * error except `EPERM` — so a probe that fails for an unrelated reason (a
 * permission boundary, a sandbox restriction) reads as "the worker is dead".
 *
 * This module therefore carries a *triple* — pid, kernel boot identity, and
 * process start identity — and returns a three-valued observation:
 *
 *   - `same-process` — the recorded process is demonstrably still there.
 *   - `absent`       — it is demonstrably gone.
 *   - `unknown`      — the probe could not establish either.
 *
 * `absent` is deliberately hard to reach. Only a definitive `ESRCH`, a
 * definitive boot-identity mismatch (a reboot proves the old process cannot
 * survive), a definitive start-identity mismatch (the pid was reused), or a
 * zombie state counts. Anything else is `unknown`, because the alternative is
 * declaring a live worker dead and starting a second copy of work that is
 * already running.
 *
 * On a platform where neither identity can be read, every observation is
 * `unknown` and the scheduler keeps the schedule occupied. That is the honest
 * answer, not a limitation to paper over.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface ProcessIdentity {
  readonly pid: number;
  /** Kernel boot identity. `null` when the platform does not expose one. */
  readonly bootId: string | null;
  /** OS process start identity. `null` when it could not be read. */
  readonly startId: string | null;
}

export type ProcessObservation =
  | { readonly kind: "same-process"; readonly identity: ProcessIdentity }
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Kernel boot identity for this host, or `null` when unavailable.
 *
 * Used to prove that a recorded worker cannot still be running: after a reboot,
 * no process from the previous boot survives, so a boot-identity mismatch is
 * authoritative absence rather than a guess.
 */
export const readBootIdentity = (): string | null => {
  if (process.platform === "linux") {
    try {
      const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    if (result.error !== undefined || result.status !== 0) return null;
    const match = /sec\s*=\s*(\d+)/u.exec(result.stdout ?? "");
    return match?.[1] ?? null;
  }
  return null;
};

/**
 * The OS-level start identity of `pid`, or `null` when it cannot be read.
 *
 * On Linux this is field 22 (`starttime`, in clock ticks since boot) of
 * `/proc/<pid>/stat`, read by splitting on the **last** `)` because field 2
 * (`comm`) may itself contain spaces and parentheses. On Darwin it is `ps`
 * start time under `LC_ALL=C` so the format is stable. Both are opaque strings
 * to every caller: they are only ever compared for equality.
 */
export const readProcessStartIdentity = (pid: number): string | null => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // Fields after `comm`: state is field 3, so starttime (field 22) is
      // index 19 of the remainder.
      const fields = stat.slice(close + 1).trim().split(/\s+/u);
      const starttime = fields[19];
      return starttime !== undefined && starttime.length > 0 ? starttime : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    if (result.error !== undefined || result.status !== 0) return null;
    const value = (result.stdout ?? "").trim();
    return value.length > 0 ? value : null;
  }
  return null;
};

/**
 * The identity of a process this host is currently running, read from the OS.
 *
 * Returns a partial identity when only some parts are readable — the caller
 * persists whatever it gets, and a missing part degrades later observations of
 * that identity to `unknown` rather than to a false `absent`.
 */
export const processIdentityOf = (pid: number): ProcessIdentity => ({
  pid,
  bootId: readBootIdentity(),
  startId: readProcessStartIdentity(pid),
});

/** The scheduler's own identity, for the instance record. */
export const currentProcessIdentity = (): ProcessIdentity => processIdentityOf(process.pid);

/**
 * Liveness probe that distinguishes "gone" from "could not tell".
 *
 * `process.kill(pid, 0)` performs no signal delivery, so it is safe on any
 * process this user may signal. `EPERM` means the process exists but is not
 * ours to signal; `ESRCH` is the only definitive absence; everything else
 * (a sandbox denying the syscall, for instance) is `unknown`.
 */
const probeLiveness = (pid: number): "alive" | "absent" | "unknown" => {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "ESRCH") return "absent";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
};

/** Linux exposes process state directly; `Z` means it has exited but is unreaped. */
const linuxProcessIsZombie = (pid: number): boolean => {
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return false;
    return stat.slice(close + 1).trim().split(/\s+/u)[0] === "Z";
  } catch {
    return false;
  }
};

/**
 * Observe whether `identity` still refers to the same live process.
 *
 * Order matters: a definitive mismatch on either identity proves absence, and
 * is checked before any optimistic conclusion. A live pid with no recorded
 * start identity to compare against is `unknown`, never `same-process` — a
 * reused pid would otherwise be mistaken for the original worker.
 */
export const observeProcessIdentity = (identity: ProcessIdentity): ProcessObservation => {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0) {
    return { kind: "unknown", reason: `recorded pid ${String(identity.pid)} is not a valid process id` };
  }

  const liveness = probeLiveness(identity.pid);
  if (liveness === "absent") {
    return { kind: "absent", reason: `pid ${identity.pid} does not exist` };
  }
  if (liveness === "unknown") {
    return { kind: "unknown", reason: `could not probe pid ${identity.pid} (neither present nor definitively gone)` };
  }
  if (linuxProcessIsZombie(identity.pid)) {
    return { kind: "absent", reason: `pid ${identity.pid} has exited and is awaiting reaping` };
  }

  if (identity.bootId !== null) {
    const bootId = readBootIdentity();
    if (bootId === null) {
      return { kind: "unknown", reason: "boot identity is unreadable, so the recorded worker cannot be distinguished from a post-reboot process" };
    }
    if (bootId !== identity.bootId) {
      return { kind: "absent", reason: `pid ${identity.pid} belongs to a previous boot (recorded ${identity.bootId}, current ${bootId})` };
    }
  }

  if (identity.startId === null) {
    return { kind: "unknown", reason: `no recorded start identity for pid ${identity.pid}, so a reused pid cannot be ruled out` };
  }

  const startId = readProcessStartIdentity(identity.pid);
  if (startId === null) {
    return { kind: "unknown", reason: `start identity of pid ${identity.pid} is unreadable` };
  }
  if (startId !== identity.startId) {
    return { kind: "absent", reason: `pid ${identity.pid} was reused by a different process` };
  }

  return { kind: "same-process", identity };
};
