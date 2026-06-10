/**
 * Advisory run lock — one concurrent plan→apply→commit per PRISM_HOME.
 *
 * O_EXCL create of `<PRISM_HOME>/state/lock` holding {pid}; a lock whose pid
 * is dead is stale and taken over. Ledger files were bare read-modify-write
 * JSON with no concurrency story; the snapshot store inherits a real one.
 */

import { open, readFile as nodeReadFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir } from "../fs.js";

const LOCK_SEGMENTS = ["state", "lock"] as const;

export const lockPath = (prismHome: string): string => join(prismHome, ...LOCK_SEGMENTS);

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const tryAcquire = async (path: string): Promise<boolean> => {
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
};

const holderPid = async (path: string): Promise<number | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await nodeReadFile(path, "utf8"));
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
};

export class SnapshotLockHeldError extends Error {
  constructor(readonly path: string, readonly pid: number | undefined) {
    super(
      `Another prism run holds the snapshot lock${pid === undefined ? "" : ` (pid ${pid})`}: ${path}`,
    );
    this.name = "SnapshotLockHeldError";
  }
}

export const withSnapshotLock = async <T>(
  prismHome: string,
  run: () => Promise<T>,
): Promise<T> => {
  const path = lockPath(prismHome);
  await ensureDir(dirname(path));

  if (!(await tryAcquire(path))) {
    const pid = await holderPid(path);
    // Unreadable lock files count as stale: the holder either never finished
    // writing (crash mid-acquire) or the file is foreign garbage.
    if (pid !== undefined && pidIsAlive(pid)) throw new SnapshotLockHeldError(path, pid);
    await rm(path, { force: true });
    if (!(await tryAcquire(path))) {
      throw new SnapshotLockHeldError(path, await holderPid(path));
    }
  }

  try {
    return await run();
  } finally {
    await rm(path, { force: true });
  }
};
