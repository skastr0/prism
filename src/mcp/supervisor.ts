import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EXIT_CODES, exitWith } from "../exit.js";
import { chmodFile, writeFile } from "../fs.js";

export interface SupervisorMcpDaemon {
  readonly pid: number;
  readonly prismHome: string;
  readonly serverName: string;
  readonly serverPath: string;
}

const supervisedMcpDaemons = new Map<number, SupervisorMcpDaemon>();
let installedReaper = false;

const normalizePath = (path: string): string => resolve(path);

const isPathWithin = (path: string, parent: string): boolean => {
  const normalized = normalizePath(path);
  const normalizedParent = normalizePath(parent);
  return normalized === normalizedParent || normalized.startsWith(`${normalizedParent}/`);
};

const shouldSuperviseMcpDaemon = (prismHome: string): boolean => {
  if (process.env.PRISM_MCP_SUPERVISE_DAEMONS === "1") return true;
  if (process.env.PRISM_MCP_SUPERVISE_DAEMONS === "0") return false;
  return isPathWithin(prismHome, tmpdir());
};

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
};

const reapSupervisedMcpDaemonsSync = (): void => {
  for (const [pid] of supervisedMcpDaemons) {
    if (!processIsRunning(pid)) {
      supervisedMcpDaemons.delete(pid);
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited or no longer owned by this process.
    }
    supervisedMcpDaemons.delete(pid);
  }
};

const installSupervisorReaper = (): void => {
  if (installedReaper) return;
  installedReaper = true;
  process.once("beforeExit", reapSupervisedMcpDaemonsSync);
  process.once("exit", reapSupervisedMcpDaemonsSync);
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
    process.once(signal, () => {
      reapSupervisedMcpDaemonsSync();
      exitWith(EXIT_CODES.domainFailure);
    });
  }
};

export const registerSupervisorMcpDaemon = (daemon: SupervisorMcpDaemon): void => {
  if (!Number.isInteger(daemon.pid) || daemon.pid <= 0) return;
  if (!shouldSuperviseMcpDaemon(daemon.prismHome)) return;
  supervisedMcpDaemons.set(daemon.pid, daemon);
  installSupervisorReaper();
};

export const unregisterSupervisorMcpDaemon = (pid: number | undefined): void => {
  if (pid === undefined) return;
  supervisedMcpDaemons.delete(pid);
};

export const writeSupervisorTextFile = async (
  path: string,
  content: string,
  options: { readonly mode?: number } = {},
): Promise<void> => {
  await writeFile(path, content, options);
  if (options.mode !== undefined) {
    await chmodFile(path, options.mode);
  }
};

export const writeSupervisorJsonFile = async (
  path: string,
  value: unknown,
  options: { readonly mode?: number } = {},
): Promise<void> =>
  writeSupervisorTextFile(path, `${JSON.stringify(value, null, 2)}\n`, options);
