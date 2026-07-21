import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  probeSocketLiveness,
  probeAndRecoverWithLock,
  ensureSocketBindability,
  acquireLock,
  bindUnixSocketSingleton,
  UDSSingletonError,
} from "./uds-singleton";

// Helper: create a temporary test directory
async function createTestDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "uds-singleton-test-"));
}

// Helper: spawn a simple UDS server on a given socket path
async function spawnTestServer(
  socketPath: string,
): Promise<{ stop: () => Promise<void> }> {
  const server = Bun.serve({
    unix: socketPath,
    fetch: (req) => new Response("OK"),
  });

  return {
    async stop() {
      server.stop(true);
    },
  };
}

describe("UDS Singleton & Stale Socket Recovery", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Cleanup failures are non-fatal in tests
    }
  });

  describe("probeSocketLiveness", () => {
    it("returns 'available' for a socket path that does not exist", async () => {
      const socketPath = join(testDir, "nonexistent.sock");
      const result = await probeSocketLiveness(socketPath);
      expect(result).toBe("available");
    });

    it("returns 'stale' for a socket file that exists but cannot be connected to", async () => {
      const socketPath = join(testDir, "stale.sock");
      // Create an empty file to simulate a stale socket
      await writeFile(socketPath, "");

      const result = await probeSocketLiveness(socketPath);
      expect(result).toBe("stale");
    });

    it("returns 'live' for an active Unix domain socket server", async () => {
      const socketPath = join(testDir, "live.sock");
      const server = await spawnTestServer(socketPath);

      try {
        const result = await probeSocketLiveness(socketPath);
        expect(result).toBe("live");
      } finally {
        await server.stop();
      }
    });

    it("respects the timeout parameter and treats slow-to-respond as stale", async () => {
      const socketPath = join(testDir, "timeout.sock");
      // Create a fake socket file
      await writeFile(socketPath, "");

      // Use a very short timeout; expect stale (connection attempt times out)
      const result = await probeSocketLiveness(socketPath, 10);
      expect(result).toBe("stale");
    });
  });

  describe("probeAndRecoverWithLock", () => {
    it("returns 'available' when socket does not exist", async () => {
      const socketPath = join(testDir, "free.sock");
      const result = await probeAndRecoverWithLock(socketPath);
      expect(result).toBe("available");
    });

    it("unlilnks a stale socket and returns 'stale-recovered'", async () => {
      const socketPath = join(testDir, "stale-to-recover.sock");
      // Pre-create a stale socket file
      await writeFile(socketPath, "");
      expect(existsSync(socketPath)).toBe(true);

      const result = await probeAndRecoverWithLock(socketPath);
      expect(result).toBe("stale-recovered");
      // Socket file should be unlinked
      expect(existsSync(socketPath)).toBe(false);
    });

    it("returns 'live' when another daemon owns the socket", async () => {
      const socketPath = join(testDir, "live-socket.sock");
      const server = await spawnTestServer(socketPath);

      try {
        const result = await probeAndRecoverWithLock(socketPath);
        expect(result).toBe("live");
        // Socket should still exist (not unlinked by this process)
        expect(existsSync(socketPath)).toBe(true);
      } finally {
        await server.stop();
      }
    });

    it("is idempotent: repeated calls on an available path return 'available'", async () => {
      const socketPath = join(testDir, "idempotent.sock");

      const result1 = await probeAndRecoverWithLock(socketPath);
      const result2 = await probeAndRecoverWithLock(socketPath);
      expect(result1).toBe("available");
      expect(result2).toBe("available");
    });
  });

  describe("ensureSocketBindability", () => {
    it("is a wrapper around probeAndRecoverWithLock with the same behavior", async () => {
      const socketPath = join(testDir, "ensure-available.sock");
      const result = await ensureSocketBindability(socketPath);
      expect(result).toBe("available");
    });

    it("detects and recovers from stale sockets", async () => {
      const socketPath = join(testDir, "ensure-stale.sock");
      await writeFile(socketPath, "");

      const result = await ensureSocketBindability(socketPath);
      expect(result).toBe("stale-recovered");
      expect(existsSync(socketPath)).toBe(false);
    });
  });

  describe("UDS | Race safety: simultaneous probers", () => {
    it("exactly one of 5 simultaneous processes binds to the same socket", async () => {
      const socketPath = join(testDir, "race-socket.sock");

      // Race 5 processes to probe/recover and bind to the same socket
      const promises = Array.from({ length: 5 }, async (_, index) => {
        try {
          const result = await probeAndRecoverWithLock(socketPath);

          if (result === "live") {
            // Another process won the race and bound the socket
            return { index, bound: false, reason: "live" };
          }

          // Try to bind (simulate what the real daemon would do)
          try {
            const server = await spawnTestServer(socketPath);
            // Successfully bound
            return { index, bound: true, server };
          } catch {
            // Binding failed; another process must have bound it
            return { index, bound: false, reason: "bind-failed" };
          }
        } catch (error) {
          return { index, bound: false, reason: `error: ${error}` };
        }
      });

      const results = await Promise.all(promises);

      // Exactly one should have bound; others should have detected "live" or bind failure
      const bound = results.filter((r) => r.bound);
      expect(bound.length).toBe(1);

      // Clean up the bound server
      const boundResult = bound[0];
      if (boundResult && "server" in boundResult && boundResult.server) {
        await boundResult.server.stop();
      }

      // The other 4 should have either seen "live" or failed to bind
      const notBound = results.filter((r) => !r.bound);
      expect(notBound.length).toBe(4);
      for (const result of notBound) {
        expect(
          result.reason === "live" || result.reason === "bind-failed",
        ).toBe(true);
      }
    });
  });

  describe("UDS | Stale socket + recovery", () => {
    it("pre-created dead socket is recovered and made available for binding", async () => {
      const socketPath = join(testDir, "pre-stale.sock");

      // Pre-create a dead socket file (simulating a SIGKILLed predecessor)
      await writeFile(socketPath, "");
      expect(existsSync(socketPath)).toBe(true);

      // Probe and recover
      const result = await ensureSocketBindability(socketPath);
      expect(result).toBe("stale-recovered");

      // Socket should be unlinked
      expect(existsSync(socketPath)).toBe(false);

      // Now binding should succeed
      const server = await spawnTestServer(socketPath);
      expect(existsSync(socketPath)).toBe(true);

      try {
        // Verify the server is actually alive and responds
        const probeAfterBind = await probeSocketLiveness(socketPath);
        expect(probeAfterBind).toBe("live");
      } finally {
        await server.stop();
      }
    });

    it("handles a SIGKILLed predecessor leaving stale socket with active registry entry", async () => {
      const socketPath = join(testDir, "killed-daemon.sock");

      // Simulate a SIGKILLed predecessor: socket file exists but is stale
      await writeFile(socketPath, "");

      // First process detects stale socket and recovers
      const result1 = await probeAndRecoverWithLock(socketPath);
      expect(result1).toBe("stale-recovered");
      expect(existsSync(socketPath)).toBe(false);

      // Start a real server on the now-clean path
      const server = await spawnTestServer(socketPath);

      try {
        // Second process (late joiner) should detect the live daemon
        const result2 = await probeAndRecoverWithLock(socketPath);
        expect(result2).toBe("live");
      } finally {
        await server.stop();
      }
    });
  });

  describe("UDS | Registry", () => {
    it("simultaneous race: 5 daemons, exactly 1 succeeds, others exit 0 quickly", async () => {
      const socketPath = join(testDir, "registry-race.sock");

      // Simulate 5 daemon spawns racing to the same socket
      const raceResults = await Promise.allSettled(
        Array.from({ length: 5 }, async () => {
          const bindability = await ensureSocketBindability(socketPath);

          if (bindability === "live") {
            // Exit 0 without binding (another daemon won)
            return { status: "exited-0", reason: "live" };
          }

          // Try to bind
          try {
            const server = await spawnTestServer(socketPath);
            return { status: "bound", server };
          } catch {
            // Bind failed; another must have gotten there first
            return { status: "exited-0", reason: "bind-collision" };
          }
        }),
      );

      // Count successes
      const binds = raceResults.filter((r) => {
        if (r.status === "rejected") return false;
        return r.value.status === "bound";
      });

      const cleanExits = raceResults.filter((r) => {
        if (r.status === "rejected") return false;
        return r.value.status === "exited-0";
      });

      expect(binds.length).toBe(1);
      expect(cleanExits.length).toBe(4);

      // Clean up
      const bound = binds[0];
      if (bound && bound.status === "fulfilled" && "server" in bound.value) {
        await (bound.value as any).server.stop();
      }
    });
  });

  describe("regression: acquireLock exclusivity (was: rename() silently replaces, all racers 'win')", () => {
    for (const initialMode of [0o755, 0o500]) {
      it(`normalizes an owned lock directory from mode ${initialMode.toString(8)} to 0700`, async () => {
        const lockDir = join(testDir, "lock-dir");
        await mkdir(lockDir);
        await chmod(lockDir, initialMode);

        expect(await acquireLock(join(lockDir, "secure.lock"), 100, process.pid)).toBe(true);
        expect((await stat(lockDir)).mode & 0o777).toBe(0o700);
      });
    }

    it("rejects a symlink as the lock directory", async () => {
      const target = join(testDir, "symlink-target");
      const linked = join(testDir, "symlink-lock-dir");
      await mkdir(target);
      await symlink(target, linked, "dir");

      await expect(
        acquireLock(join(linked, "unsafe.lock"), 100, process.pid),
      ).rejects.toBeInstanceOf(UDSSingletonError);
    });

    it("fails closed when the lock directory cannot be created", async () => {
      const notDirectory = join(testDir, "not-a-directory");
      await writeFile(notDirectory, "occupied");

      await expect(
        acquireLock(join(notDirectory, "unsafe.lock"), 100, process.pid),
      ).rejects.toBeInstanceOf(UDSSingletonError);
    });

    it("exactly one of 20 concurrent acquire attempts wins the lock", async () => {
      const lockPath = join(testDir, "race.lock");
      const pid = process.pid;

      const results = await Promise.all(
        Array.from({ length: 20 }, () => acquireLock(lockPath, 300, pid)),
      );

      const winners = results.filter((won) => won === true);
      expect(winners.length).toBe(1);

      // The lock file records a single, valid holder -- not silently
      // clobbered by a second "winner".
      const content = await readFile(lockPath, "utf8");
      const holder = JSON.parse(content);
      expect(holder.pid).toBe(pid);
      expect(typeof holder.startedAt).toBe("number");
    });

    it("reclaims a lock left by a dead pid and lets a new caller win", async () => {
      const lockPath = join(testDir, "dead-holder.lock");

      // A pid that is essentially guaranteed not to be alive.
      const deadPid = 999999;
      await writeFile(lockPath, JSON.stringify({ pid: deadPid, startedAt: Date.now() }), "utf8");

      const acquired = await acquireLock(lockPath, 1000, process.pid);
      expect(acquired).toBe(true);

      const content = await readFile(lockPath, "utf8");
      const holder = JSON.parse(content);
      expect(holder.pid).toBe(process.pid);
    });

    it("does not reclaim a lock held by a live pid", async () => {
      const lockPath = join(testDir, "live-holder.lock");
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");

      // Our own pid is alive, so this must NOT be able to steal the lock.
      const acquired = await acquireLock(lockPath, 100, process.pid + 1);
      expect(acquired).toBe(false);

      // The original holder's record must be untouched.
      const content = await readFile(lockPath, "utf8");
      const holder = JSON.parse(content);
      expect(holder.pid).toBe(process.pid);
    });
  });

  describe("regression: bindUnixSocketSingleton (was: Bun.serve() outside the lock, uncaught EADDRINUSE crash)", () => {
    it("pre-bound path: second process gets 'already-served' and never calls bind()", async () => {
      const socketPath = join(testDir, "prebound.sock");
      const server = await spawnTestServer(socketPath);

      try {
        let bindCalled = false;
        const outcome = await bindUnixSocketSingleton(socketPath, () => {
          bindCalled = true;
          throw new Error("bind() must not be invoked when already served");
        });

        expect(outcome.kind).toBe("already-served");
        expect(bindCalled).toBe(false);
      } finally {
        await server.stop();
      }
    });

    it("stale socket file: recovers (unlinks) and binds successfully", async () => {
      const socketPath = join(testDir, "stale-then-bind.sock");
      await writeFile(socketPath, "");
      expect(existsSync(socketPath)).toBe(true);

      const outcome = await bindUnixSocketSingleton(socketPath, () =>
        Bun.serve({ unix: socketPath, fetch: () => new Response("ok") }),
      );

      expect(outcome.kind).toBe("bound");
      expect(existsSync(socketPath)).toBe(true);

      // Verify it is genuinely live.
      const liveness = await probeSocketLiveness(socketPath);
      expect(liveness).toBe("live");

      if (outcome.kind === "bound") {
        outcome.server.stop(true);
      }
    });

    it("bind() throwing EADDRINUSE against a live owner reports 'already-served' instead of throwing", async () => {
      const socketPath = join(testDir, "race-eaddrinuse-live.sock");
      const server = await spawnTestServer(socketPath);

      try {
        // A bind() callback that always races into EADDRINUSE, simulating a
        // process that binds outside the lock's visibility.
        const eaddrinuse = () => {
          const error = new Error("EADDRINUSE") as NodeJS.ErrnoException;
          error.code = "EADDRINUSE";
          throw error;
        };

        const outcome = await bindUnixSocketSingleton(socketPath, eaddrinuse);
        expect(outcome.kind).toBe("already-served");
      } finally {
        await server.stop();
      }
    });

    it("bind() throwing EADDRINUSE against a stale socket retries once and succeeds", async () => {
      const socketPath = join(testDir, "race-eaddrinuse-stale.sock");

      let attempt = 0;
      const flakyBind = () => {
        attempt += 1;
        if (attempt === 1) {
          // Simulate a racer that bound and crashed/unbound between our
          // probe and our own bind() call, leaving a stale socket file.
          require("node:fs").writeFileSync(socketPath, "");
          const error = new Error("EADDRINUSE") as NodeJS.ErrnoException;
          error.code = "EADDRINUSE";
          throw error;
        }
        return Bun.serve({ unix: socketPath, fetch: () => new Response("ok") });
      };

      const outcome = await bindUnixSocketSingleton(socketPath, flakyBind);

      expect(attempt).toBe(2);
      expect(outcome.kind).toBe("bound");

      if (outcome.kind === "bound") {
        outcome.server.stop(true);
      }
    });

    it("propagates a non-EADDRINUSE bind() error instead of masking it", async () => {
      const socketPath = join(testDir, "other-error.sock");

      await expect(
        bindUnixSocketSingleton(socketPath, () => {
          throw new Error("disk full");
        }),
      ).rejects.toThrow("disk full");
    });
  });
});
