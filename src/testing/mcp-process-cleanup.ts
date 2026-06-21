import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForPidExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    await delay(100);
  }
  return !processIsRunning(pid);
};

const mcpServerPidsUnder = async (root: string): Promise<number[]> => {
  const normalizedRoot = resolve(root);
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
    maxBuffer: 20_000_000,
  });
  return stdout
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/u);
      if (!match) return [];
      const pid = Number(match[1]);
      const command = match[2] ?? "";
      return Number.isInteger(pid) &&
        command.includes(normalizedRoot) &&
        /\/runtime\/mcp\/[^/]+\/server\.mjs(?:\s|$)/u.test(command)
        ? [pid]
        : [];
    });
};

export const cleanupPrismMcpProcessesUnder = async (
  root: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> => {
  const pids = await mcpServerPidsUnder(root);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }

  const survivors: number[] = [];
  for (const pid of pids) {
    if (!(await waitForPidExit(pid, timeoutMs))) survivors.push(pid);
  }

  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }

  for (const pid of survivors) {
    await waitForPidExit(pid, timeoutMs);
  }
};
