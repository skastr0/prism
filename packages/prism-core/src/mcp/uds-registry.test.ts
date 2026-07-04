import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  writeRegistry,
  readRegistry,
  registerDaemon,
  unregisterDaemon,
  getDaemon,
  getAllDaemons,
  touchDaemon,
  type RegistryData,
  type RegistryEntry,
  UDSRegistryError,
} from "./uds-registry.js";

const getTestRegistryPath = (): string => {
  const home = homedir();
  return join(home, ".prism", "runtime", "mcp", "registry.json");
};

describe("UDS Registry", () => {
  beforeEach(async () => {
    // Clean up any existing registry file before each test
    try {
      const path = getTestRegistryPath();
      await rm(path, { force: true });
    } catch {
      // File doesn't exist, which is fine
    }
  });

  afterEach(async () => {
    // Clean up after each test
    try {
      const path = getTestRegistryPath();
      await rm(path, { force: true });
    } catch {
      // File doesn't exist, which is fine
    }
  });

  describe("writeRegistry", () => {
    it("writes registry data to disk", async () => {
      const data: RegistryData = {
        "plugin-a": {
          pid: 1234,
          sock: "/tmp/plugin-a.sock",
          bundleHash: "abc123",
          startedAt: Date.now(),
          lastUsed: Date.now(),
        },
      };

      await writeRegistry(data);

      // Read file directly to verify
      const path = getTestRegistryPath();
      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content);

      expect(parsed).toEqual(data);
    });

    it("survives concurrent writes (5 writers): final file is valid JSON", async () => {
      // Spawn 5 concurrent writers
      // Each concurrent writer will read, modify, and write back.
      // Due to TOCTOU race conditions, not all entries may survive,
      // but the final file will always be valid JSON (atomic write guarantee).
      const entries: RegistryEntry[] = Array.from({ length: 5 }, (_, i) => ({
        pid: 2000 + i,
        sock: `/tmp/plugin-${i}.sock`,
        bundleHash: `hash-${i}`,
        startedAt: Date.now(),
        lastUsed: Date.now(),
      }));

      // Use registerDaemon for concurrent writes
      const promises = entries.map((entry, i) => registerDaemon(`plugin-${i}`, entry));

      // Wait for all writers
      await Promise.all(promises);

      // Verify final registry is valid JSON (core atomic guarantee)
      const path = getTestRegistryPath();
      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content);

      // The atomic write guarantee: file is always valid JSON after concurrent writes
      expect(parsed).toBeObject();
      // At least one entry should survive
      expect(Object.keys(parsed).length).toBeGreaterThan(0);
      // All entries in the file should be valid
      for (const [key, value] of Object.entries(parsed)) {
        expect(key).toBeString();
        expect(value).toHaveProperty("pid");
        expect(value).toHaveProperty("sock");
        expect(value).toHaveProperty("bundleHash");
      }
    });

    it("throws UDSRegistryError on I/O failure (read-only directory)", async () => {
      const data: RegistryData = {
        "plugin-a": {
          pid: 1234,
          sock: "/tmp/plugin-a.sock",
          bundleHash: "abc123",
          startedAt: Date.now(),
          lastUsed: Date.now(),
        },
      };

      // Make a read-only directory to trigger write failure
      const path = getTestRegistryPath();
      const dir = path.split("/").slice(0, -1).join("/");

      try {
        // Create the directory with read-only permissions
        await mkdir(dir, { recursive: true });
        // Temporarily make it read-only (Unix only)
        if (process.platform !== "win32") {
          // This test only works on Unix
          await new Promise<void>((resolve, reject) => {
            require("child_process").exec(`chmod 444 "${dir}"`, (err: unknown) => {
              if (err) reject(err);
              else resolve();
            });
          });

          try {
            await writeRegistry(data);
            throw new Error("Expected writeRegistry to throw");
          } catch (error) {
            expect(error).toBeInstanceOf(UDSRegistryError);
          }
        }
      } finally {
        // Restore permissions
        if (process.platform !== "win32") {
          try {
            await new Promise<void>((resolve) => {
              require("child_process").exec(`chmod 755 "${dir}"`, () => {
                resolve();
              });
            });
          } catch {
            // Ignore
          }
        }
      }
    });
  });

  describe("readRegistry", () => {
    it("returns absent for non-existent file", async () => {
      const result = await readRegistry();
      expect(result.kind).toBe("absent");
    });

    it("returns absent for corrupted JSON", async () => {
      const path = getTestRegistryPath();
      const dir = path.split("/").slice(0, -1).join("/");
      await mkdir(dir, { recursive: true });

      // Write invalid JSON
      await writeFile(path, "not valid json {", "utf8");

      const result = await readRegistry();
      expect(result.kind).toBe("absent");
    });

    it("returns absent for incomplete/malformed data structure", async () => {
      const path = getTestRegistryPath();
      const dir = path.split("/").slice(0, -1).join("/");
      await mkdir(dir, { recursive: true });

      // Write valid JSON but wrong structure
      await writeFile(path, JSON.stringify({ "plugin-a": { pid: 1234 } }), "utf8");

      const result = await readRegistry();
      expect(result.kind).toBe("absent");
    });

    it("returns absent for array instead of object", async () => {
      const path = getTestRegistryPath();
      const dir = path.split("/").slice(0, -1).join("/");
      await mkdir(dir, { recursive: true });

      // Write valid JSON but as array
      await writeFile(path, JSON.stringify([]), "utf8");

      const result = await readRegistry();
      expect(result.kind).toBe("absent");
    });

    it("returns present for valid registry data", async () => {
      const data: RegistryData = {
        "plugin-a": {
          pid: 1234,
          sock: "/tmp/plugin-a.sock",
          bundleHash: "abc123",
          startedAt: Date.now(),
          lastUsed: Date.now(),
        },
      };

      await writeRegistry(data);

      const result = await readRegistry();
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value["plugin-a"]).toBeDefined();
      }
    });
  });

  describe("registerDaemon", () => {
    it("registers a new daemon", async () => {
      const entry: RegistryEntry = {
        pid: 1234,
        sock: "/tmp/plugin-a.sock",
        bundleHash: "abc123",
        startedAt: Date.now(),
        lastUsed: Date.now(),
      };

      await registerDaemon("plugin-a", entry);

      const result = await getDaemon("plugin-a");
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.pid).toBe(1234);
      }
    });

    it("updates an existing daemon", async () => {
      const entry1: RegistryEntry = {
        pid: 1234,
        sock: "/tmp/plugin-a.sock",
        bundleHash: "abc123",
        startedAt: Date.now(),
        lastUsed: Date.now(),
      };

      await registerDaemon("plugin-a", entry1);

      const entry2: RegistryEntry = {
        pid: 5678,
        sock: "/tmp/plugin-a-new.sock",
        bundleHash: "xyz789",
        startedAt: Date.now(),
        lastUsed: Date.now(),
      };

      await registerDaemon("plugin-a", entry2);

      const result = await getDaemon("plugin-a");
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.pid).toBe(5678);
      }
    });
  });

  describe("unregisterDaemon", () => {
    it("removes a registered daemon", async () => {
      const entry: RegistryEntry = {
        pid: 1234,
        sock: "/tmp/plugin-a.sock",
        bundleHash: "abc123",
        startedAt: Date.now(),
        lastUsed: Date.now(),
      };

      await registerDaemon("plugin-a", entry);
      await unregisterDaemon("plugin-a");

      const result = await getDaemon("plugin-a");
      expect(result.kind).toBe("absent");
    });

    it("succeeds silently if daemon not registered", async () => {
      // Should not throw
      await unregisterDaemon("plugin-not-registered");
      expect(true).toBe(true); // If we reach here, no error was thrown
    });
  });

  describe("getDaemon", () => {
    it("returns absent if daemon not registered", async () => {
      const result = await getDaemon("plugin-not-registered");
      expect(result.kind).toBe("absent");
    });

    it("returns entry for registered daemon", async () => {
      const entry: RegistryEntry = {
        pid: 1234,
        sock: "/tmp/plugin-a.sock",
        bundleHash: "abc123",
        startedAt: Date.now(),
        lastUsed: Date.now(),
      };

      await registerDaemon("plugin-a", entry);

      const result = await getDaemon("plugin-a");
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.pid).toBe(entry.pid);
        expect(result.value.sock).toBe(entry.sock);
      }
    });
  });

  describe("getAllDaemons", () => {
    it("returns absent when no registry file exists", async () => {
      const result = await getAllDaemons();
      expect(result.kind).toBe("absent");
    });

    it("returns empty record when registry exists but is empty", async () => {
      // Create an empty registry first
      await writeRegistry({});

      const result = await getAllDaemons();
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(Object.keys(result.value).length).toBe(0);
      }
    });

    it("returns all registered daemons", async () => {
      const entry1: RegistryEntry = {
        pid: 1234,
        sock: "/tmp/plugin-a.sock",
        bundleHash: "abc123",
        startedAt: Date.now(),
        lastUsed: Date.now(),
      };

      const entry2: RegistryEntry = {
        pid: 5678,
        sock: "/tmp/plugin-b.sock",
        bundleHash: "def456",
        startedAt: Date.now(),
        lastUsed: Date.now(),
      };

      await registerDaemon("plugin-a", entry1);
      await registerDaemon("plugin-b", entry2);

      const result = await getAllDaemons();
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(Object.keys(result.value).length).toBe(2);
        expect(result.value["plugin-a"]).toBeDefined();
        expect(result.value["plugin-b"]).toBeDefined();
      }
    });
  });

  describe("touchDaemon", () => {
    it("updates lastUsed timestamp", async () => {
      const now = Date.now();
      const entry: RegistryEntry = {
        pid: 1234,
        sock: "/tmp/plugin-a.sock",
        bundleHash: "abc123",
        startedAt: now,
        lastUsed: now,
      };

      await registerDaemon("plugin-a", entry);

      // Wait a bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await touchDaemon("plugin-a");
      expect(result.kind).toBe("ok");

      const updated = await getDaemon("plugin-a");
      if (updated.kind === "ok") {
        expect(updated.value.lastUsed).toBeGreaterThan(now);
      }
    });

    it("returns absent if daemon not registered", async () => {
      const result = await touchDaemon("plugin-not-registered");
      expect(result.kind).toBe("absent");
    });
  });
});
