import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentProcessIdentity,
  observeProcessIdentity,
  processIdentityOf,
  readBootIdentity,
  readProcessStartIdentity,
} from "./process-identity.js";

const onLinux = process.platform === "linux";
const spawned: Array<ReturnType<typeof Bun.spawn>> = [];
const tempRoots: string[] = [];

const spawnSleep = (): ReturnType<typeof Bun.spawn> => {
  const child = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
  spawned.push(child);
  return child;
};

const killAndReap = async (child: ReturnType<typeof Bun.spawn>): Promise<void> => {
  child.kill("SIGKILL");
  await child.exited;
  // `process.kill(pid, 0)` can still observe the pid briefly after exit.
  await new Promise((resolve) => setTimeout(resolve, 100));
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

describe("process identity", () => {
  test("exposes a boot identity for this host", () => {
    const bootId = readBootIdentity();
    expect(bootId).not.toBeNull();
    expect((bootId ?? "").length).toBeGreaterThan(0);
    // Stable within a boot — this is what makes a mismatch meaningful.
    expect(readBootIdentity()).toBe(bootId);
  });

  test("records a start identity for a live process, and reads it stably", () => {
    const identity = processIdentityOf(process.pid);
    expect(identity.pid).toBe(process.pid);
    expect(identity.startId).not.toBeNull();
    expect(readProcessStartIdentity(process.pid)).toBe(identity.startId);
  });

  /**
   * The start identity is coarse — `starttime` clock ticks (10 ms) on Linux,
   * the one-second `ps -o lstart` timestamp on macOS — so two processes
   * started within one tick legitimately share a value — the identity is a
   * *comparison*, not a unique key. That does not weaken pid-reuse detection:
   * a collision would require a reused pid to be handed out within the same
   * tick as the original, and the kernel recycles pids only after the
   * counter wraps, which takes many thousands of process creations. What must
   * hold is that each process is identified correctly against its *own* pid.
   */
  test("a shared start tick does not confuse identification of either process", async () => {
    const first = spawnSleep();
    const second = spawnSleep();
    const firstIdentity = processIdentityOf(first.pid);
    const secondIdentity = processIdentityOf(second.pid);

    expect(firstIdentity.startId).not.toBeNull();
    expect(secondIdentity.startId).not.toBeNull();
    expect(observeProcessIdentity(firstIdentity).kind).toBe("same-process");
    expect(observeProcessIdentity(secondIdentity).kind).toBe("same-process");

    await killAndReap(first);
    // The first process is gone even though the second shares its tick.
    expect(observeProcessIdentity(firstIdentity).kind).toBe("absent");
    expect(observeProcessIdentity(secondIdentity).kind).toBe("same-process");
  });

  test("observes itself and a live child as same-process", () => {
    expect(observeProcessIdentity(currentProcessIdentity())).toEqual({
      kind: "same-process",
      identity: currentProcessIdentity(),
    });
    const child = spawnSleep();
    expect(observeProcessIdentity(processIdentityOf(child.pid)).kind).toBe("same-process");
  });

  test("observes a killed and reaped worker as absent", async () => {
    const child = spawnSleep();
    const identity = processIdentityOf(child.pid);
    expect(observeProcessIdentity(identity).kind).toBe("same-process");
    await killAndReap(child);
    const observation = observeProcessIdentity(identity);
    expect(observation.kind).toBe("absent");
  });

  test("treats a nonexistent pid as absent", () => {
    // A very high pid is not in use on a normal host.
    const observation = observeProcessIdentity({ pid: 2_147_483_646, bootId: readBootIdentity(), startId: "1" });
    expect(observation.kind).toBe("absent");
  });
});

/**
 * The three ways `absent` can be reached beyond "the pid is gone". Each one is
 * a distinct failure the boolean liveness probe could not express, and each
 * must not be reachable by a weaker signal.
 */
describe("process identity mismatch proves absence", () => {
  test("a reused pid is absent, not the original worker", () => {
    const child = spawnSleep();
    const identity = processIdentityOf(child.pid);
    expect(observeProcessIdentity({ ...identity, startId: "not-the-real-start-id" }).kind).toBe("absent");
  });

  test("a worker from a previous boot is absent", () => {
    const child = spawnSleep();
    const identity = processIdentityOf(child.pid);
    expect(observeProcessIdentity({ ...identity, bootId: "00000000-0000-0000-0000-000000000000" }).kind).toBe("absent");
  });

  test("an invalid pid is unknown, not absent — there is nothing to conclude from", () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      const observation = observeProcessIdentity({ pid, bootId: readBootIdentity(), startId: "1" });
      expect(observation.kind).toBe("unknown");
    }
  });

  test("a live pid with no recorded start identity is unknown, never same-process", () => {
    // This is the case that makes pid reuse dangerous: the pid is alive, but
    // nothing proves it is *our* process.
    const observation = observeProcessIdentity({ pid: process.pid, bootId: readBootIdentity(), startId: null });
    expect(observation.kind).toBe("unknown");
    expect(observation.kind === "unknown" ? observation.reason : "").toContain("reused pid cannot be ruled out");
  });
});

/**
 * `comm` (field 2) of `/proc/<pid>/stat` is wrapped in parentheses and may
 * itself contain spaces and parentheses, so a naive `split(" ")` reads the
 * wrong column and yields a start identity that silently changes whenever the
 * executable name is unusual. The parse must split on the *last* `)`.
 */
describe.skipIf(!onLinux)("linux /proc stat parsing", () => {
  test("reads starttime from a process whose comm contains spaces and parentheses", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-comm-"));
    tempRoots.push(root);
    const weirdName = join(root, "weird ) name (x");
    await symlink("/bin/sleep", weirdName);

    const child = Bun.spawn({ cmd: [weirdName, "30"], stdout: "ignore", stderr: "ignore" });
    spawned.push(child);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const raw = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    expect(raw.slice(0, raw.indexOf(")"))).toContain("weird");

    const startId = readProcessStartIdentity(child.pid);
    expect(startId).not.toBeNull();
    // A misaligned parse would land on `state` ("S") or a pid-like column.
    expect(Number(startId)).toBeGreaterThan(0);
    expect(observeProcessIdentity(processIdentityOf(child.pid)).kind).toBe("same-process");
  });

  /**
   * The parse is only useful if the column really is `starttime`. Verified
   * against an independent source: `starttime` in clock ticks divided by
   * CLK_TCK is the process's age, which must agree with `ps -o etimes=`.
   */
  test("the parsed column is genuinely starttime", async () => {
    const child = spawnSleep();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const ticks = Number(readProcessStartIdentity(child.pid));
    const hertz = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim());
    const uptimeSeconds = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const psAgeSeconds = Number(spawnSync("ps", ["-o", "etimes=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.trim());

    expect(hertz).toBeGreaterThan(0);
    const derivedAgeSeconds = uptimeSeconds - ticks / hertz;
    // `ps -o etimes=` truncates to whole seconds, so allow a small window.
    expect(Math.abs(derivedAgeSeconds - psAgeSeconds)).toBeLessThan(2);
  });
});
