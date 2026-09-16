import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSchedulerInstanceLock, schedulerLockIsHeld } from "./instance-lock.js";

const tempRoots: string[] = [];
const spawned: Array<ReturnType<typeof Bun.spawn>> = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-scheduler-lock-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    spawned.splice(0).map(async (child) => {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        // already gone
      }
    }),
  );
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const lockPathIn = async (root: string): Promise<string> => join(root, "state", "workflow-scheduler.lock.sqlite");

describe("scheduler instance lock", () => {
  test("excludes a second holder and allows reacquisition after release", async () => {
    const root = await createTempRoot();
    const lockPath = await lockPathIn(root);

    const first = acquireSchedulerInstanceLock(lockPath);
    expect(first.kind).toBe("acquired");

    // A second scheduler in the same process hits the same file lock.
    expect(acquireSchedulerInstanceLock(lockPath).kind).toBe("held");
    expect(schedulerLockIsHeld(lockPath)).toBe(true);

    if (first.kind !== "acquired") throw new Error("expected acquisition");
    first.release();

    expect(schedulerLockIsHeld(lockPath)).toBe(false);
    const third = acquireSchedulerInstanceLock(lockPath);
    expect(third.kind).toBe("acquired");
    if (third.kind === "acquired") third.release();
  });

  test("release is idempotent", async () => {
    const root = await createTempRoot();
    const lockPath = await lockPathIn(root);
    const acquired = acquireSchedulerInstanceLock(lockPath);
    if (acquired.kind !== "acquired") throw new Error("expected acquisition");
    acquired.release();
    expect(() => acquired.release()).not.toThrow();
    expect(schedulerLockIsHeld(lockPath)).toBe(false);
  });

  test("creates the lock file and directory with private modes", async () => {
    const root = await createTempRoot();
    const lockPath = await lockPathIn(root);
    const acquired = acquireSchedulerInstanceLock(lockPath);
    if (acquired.kind !== "acquired") throw new Error("expected acquisition");
    try {
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700);
    } finally {
      acquired.release();
    }
  });

  /**
   * The reason the lock is a held file lock rather than a pidfile: a `SIGKILL`
   * must release it, because the OS drops the lock with the process. A stale
   * pidfile would instead need racy reclamation before the next scheduler could
   * start.
   */
  test("a SIGKILLed holder releases the lock", async () => {
    const root = await createTempRoot();
    const lockPath = await lockPathIn(root);
    const holderPath = join(root, "holder.ts");
    const modulePath = join(process.cwd(), "src", "workflow-scheduler", "instance-lock.ts").replace(/\\/g, "/");
    await writeFile(holderPath, `
import { acquireSchedulerInstanceLock } from "${modulePath}";

const result = acquireSchedulerInstanceLock(${JSON.stringify(lockPath)});
if (result.kind !== "acquired") {
  console.error("holder failed to acquire: " + result.kind);
  process.exit(3);
}
console.log("held");
// Hold until killed, and never release: only the OS can drop this lock.
setInterval(() => {}, 1000);
`);

    const child = Bun.spawn({ cmd: [process.execPath, holderPath], stdout: "ignore", stderr: "pipe" });
    spawned.push(child);

    // Poll rather than read stdout: the holder never exits, so reading its
    // stdout to EOF would block until the kill this test is about to perform.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && schedulerLockIsHeld(lockPath) !== true) {
      if (child.exitCode !== null) {
        throw new Error(`holder exited early: ${await new Response(child.stderr).text()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(schedulerLockIsHeld(lockPath)).toBe(true);

    child.kill("SIGKILL");
    await child.exited;
    // Give the OS a moment to drop the lock with the process.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(schedulerLockIsHeld(lockPath)).toBe(false);
    const reacquired = acquireSchedulerInstanceLock(lockPath);
    expect(reacquired.kind).toBe("acquired");
    if (reacquired.kind === "acquired") reacquired.release();
  }, 30_000);

  test("a held lock is not reported as an error", async () => {
    const root = await createTempRoot();
    const lockPath = await lockPathIn(root);
    const acquired = acquireSchedulerInstanceLock(lockPath);
    if (acquired.kind !== "acquired") throw new Error("expected acquisition");
    try {
      // Contention is a normal outcome, not a failure: losing this race means
      // the desired state is already achieved.
      expect(acquireSchedulerInstanceLock(lockPath)).toEqual({ kind: "held" });
    } finally {
      acquired.release();
    }
  });
});
