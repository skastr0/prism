import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  probeSocketLiveness,
  probeAndRecoverWithLock,
  ensureSocketBindability,
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
});
