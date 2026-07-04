import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { findWorkflowExecutable } from "./workflow-runtime.js";
import type { WorkflowWorkerProcessOptions, WorkflowWorkerProcessResult } from "./workflow-worker-process.js";

/**
 * Embedded Python PTY wrapper for spawning the Antigravity CLI (`agy`) with a
 * controlling terminal. The upstream `agy --print` mode is known to drop or
 * stall stdout when stdin is not a TTY; allocating a PTY works around the
 * issue and also lets us reliably terminate the whole process group.
 *
 * The wrapper runs on Python 3, uses only stdlib modules, and is written to
 * be compatible with both macOS and Linux.
 */
export const antigravityPtyWrapperScript = (): string => `#!/usr/bin/env python3
import os
import sys
import pty
import select
import signal
import time
import struct
import fcntl
import termios


def set_winsize(fd, row, col, xpix=0, ypix=0):
    winsize = struct.pack('HHHH', row, col, xpix, ypix)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def main():
    if len(sys.argv) < 5:
        print("usage: pty_wrapper.py cwd timeout_seconds cmd [args...]", file=sys.stderr)
        sys.exit(2)

    cwd = sys.argv[1]
    timeout_seconds = float(sys.argv[2])
    cmd = sys.argv[3]
    args = sys.argv[3:]
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")

    pid, fd = pty.fork()
    if pid != 0:
        set_winsize(fd, 24, 80)
    if pid == 0:
        # Child: pty.fork already makes this a new session/process group leader.
        try:
            os.chdir(cwd)
        except Exception as e:
            print(f"chdir failed: {e}", file=sys.stderr)
            sys.exit(2)
        os.execvpe(cmd, args, env)
        sys.exit(127)

    child_status = None
    child_done = False

    def reap():
        nonlocal child_status, child_done
        if child_done:
            return
        try:
            _, status = os.waitpid(pid, os.WNOHANG)
            if _ != 0:
                child_status = status
                child_done = True
        except ChildProcessError:
            child_done = True

    def cleanup():
        nonlocal child_status, child_done
        reap()
        if child_done:
            return
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        for _ in range(20):
            reap()
            if child_done:
                break
            time.sleep(0.05)
        else:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
            child_done = True
        try:
            os.close(fd)
        except OSError:
            pass

    def signal_handler(signum, _frame):
        cleanup()
        sys.exit(128 + signum)

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    deadline = time.monotonic() + timeout_seconds if timeout_seconds > 0 else None
    timed_out = False
    try:
        while True:
            remaining = None
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                timed_out = True
                break
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.flush()
    finally:
        cleanup()
        if not child_done:
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass

    if timed_out:
        sys.exit(124)
    if child_status is not None:
        if os.WIFEXITED(child_status):
            sys.exit(os.WEXITSTATUS(child_status))
        if os.WIFSIGNALED(child_status):
            sys.exit(128 + os.WTERMSIG(child_status))
    sys.exit(0)


if __name__ == "__main__":
    main()
`;

export interface AntigravityPtyProcessOptions extends WorkflowWorkerProcessOptions {
  /** Go-style duration string passed to `agy --print-timeout`. */
  readonly printTimeout: string;
}

const processIsAlive = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

const killProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // Process group may already be gone.
  }
};

const resolvePython3 = (): string | undefined => {
  const fromEnv = process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY_PYTHON;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const found = findWorkflowExecutable("python3");
  if (found !== undefined) return found;
  return process.env.PATH?.split(path.delimiter)
    .map((dir) => path.join(dir, "python3"))
    .find((candidate) => existsSync(candidate));
};

const materializePtyWrapper = async (): Promise<string> => {
  const wrapperPath = path.join(os.tmpdir(), `prism-agy-pty-${randomUUID()}.py`);
  await writeFile(wrapperPath, antigravityPtyWrapperScript(), { mode: 0o700 });
  return wrapperPath;
};

/**
 * Run a command through the Python PTY wrapper with process-group cleanup.
 *
 * This is intentionally lower-level than `runWorkflowWorkerProcess` so the
 * Antigravity worker can decide when the extra weight is justified.
 */
export const runAntigravityPtyProcess = async (
  options: AntigravityPtyProcessOptions,
): Promise<WorkflowWorkerProcessResult> => {
  const python3 = resolvePython3();
  if (python3 === undefined) {
    throw new Error("python3 is required for the Antigravity PTY wrapper but was not found");
  }

  const timeoutSeconds = options.processTimeoutMs === undefined
    ? 0
    : Math.max(1, options.processTimeoutMs / 1_000);

  const wrapperPath = await materializePtyWrapper();
  const started = Date.now();

  const child = spawn(python3, [wrapperPath, options.cwd, String(timeoutSeconds), options.command, ...options.args], {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let timedOut = false;
  let aborted = false;
  let killed = false;
  let stdout = "";
  let stderr = "";

  const killGroup = async (): Promise<void> => {
    if (killed || child.pid === undefined) return;
    killed = true;
    killProcessGroup(child.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (processIsAlive(child) && child.pid !== undefined) {
      killProcessGroup(child.pid, "SIGKILL");
    }
  };

  const recordKillGroupFailure = (error: unknown): void => {
    stderr += `\nfailed to terminate Antigravity PTY process group: ${error instanceof Error ? error.message : String(error)}`;
  };

  const requestKillGroup = (): void => {
    killGroup().catch(recordKillGroupFailure);
  };

  const onAbort = (): void => {
    aborted = true;
    requestKillGroup();
  };

  if (options.abortSignal?.aborted === true) {
    onAbort();
  } else {
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  const timeout = options.processTimeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true;
      requestKillGroup();
    }, options.processTimeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("error", (error) => {
        stderr += String(error);
        resolve(null);
      });
      child.on("close", (code) => {
        resolve(code);
      });
    });
    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      timedOut,
      aborted,
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", onAbort);
    if (child.pid !== undefined) {
      killProcessGroup(child.pid, "SIGKILL");
    }
    await rm(wrapperPath, { force: true });
  }
};
