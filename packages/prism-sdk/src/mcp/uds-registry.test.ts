import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  registerDaemon,
  unregisterDaemon,
  getDaemon,
  getAllDaemons,
  touchDaemon,
  cleanupDaemonIfOwner,
  type RegistryEntry,
  UDSRegistryError,
} from "./uds-registry.js";
import { resolvePrismHomeForSdk } from "./prism-home-resolve.js";

// Regression conviction: this suite's beforeEach/afterEach used to compute
// the registry root as an unconditional `join(homedir(), ".prism",
// "runtime", "mcp")` -- never sandboxed -- and `rm(..., { recursive: true,
// force: true })` it. `getDaemon`/`registerDaemon`/etc. under test resolve
// their own root via `resolvePrismHomeForSdk()` (explicit param, then
// `PRISM_HOME`, then `~/.prism`); every call in this file omits the
// explicit param, so this suite sandboxes itself the same way -- via
// `PRISM_HOME` -- rather than duplicating the resolver's fallback chain a
// second, divergence-prone time.
const realPrismHome = join(homedir(), ".prism");
const realRegistryRoot = join(realPrismHome, "runtime", "mcp");

let sandboxPrismHome: string;
const originalPrismHome = process.env.PRISM_HOME;

// Regression canary (task 4): plant a marker under the REAL homedir
// runtime root before this suite runs, and assert it survives after --
// the property "this suite can never eat the user's runtime again" is
// enforced by an assertion, not by code review. Skipped if the sandbox and
// the real root ever coincide (e.g. a machine whose real HOME already is a
// throwaway sandbox), since in that case "survives" is meaningless.
const canaryDir = join(realRegistryRoot, `canary-regression-${randomUUID()}`);
const canaryFile = join(canaryDir, "server.mjs");
const canaryContent = `// regression canary ${randomUUID()}\n`;
let canaryPlanted = false;

beforeAll(async () => {
  sandboxPrismHome = await mkdtemp(join(tmpdir(), "prism-uds-registry-test-"));
  process.env.PRISM_HOME = sandboxPrismHome;

  if (sandboxPrismHome !== realPrismHome) {
    // Sandbox is confirmed distinct from the real home; plant the canary.
    await mkdir(canaryDir, { recursive: true });
    await writeFile(canaryFile, canaryContent, "utf8");
    canaryPlanted = true;
  }
});

afterAll(async () => {
  try {
    if (canaryPlanted) {
      const survived = existsSync(canaryFile) && (await readFile(canaryFile, "utf8")) === canaryContent;
      if (!survived) {
        throw new Error(
          `Regression: '${canaryFile}' under the REAL ~/.prism/runtime/mcp did not survive the ` +
            "uds-registry suite. A test in this file escaped its PRISM_HOME sandbox.",
        );
      }
    }
  } finally {
    // Clean up only the exact canary this run planted -- never a recursive
    // delete of the real root itself.
    await rm(canaryDir, { recursive: true, force: true }).catch(() => undefined);

    if (originalPrismHome === undefined) delete process.env.PRISM_HOME;
    else process.env.PRISM_HOME = originalPrismHome;
    await rm(sandboxPrismHome, { recursive: true, force: true }).catch(() => undefined);
  }
});

// Mirrors the module's private path-derivation logic so tests can locate
// (and corrupt, for negative tests) a specific plugin's registry file
// without depending on any exported path helper. Resolves through the same
// `resolvePrismHomeForSdk()` the production module uses, so it tracks the
// sandboxed `PRISM_HOME` set in `beforeAll` above instead of the real home.
const registryRootDir = (): string => join(resolvePrismHomeForSdk(), "runtime", "mcp");
const sanitizePluginSegment = (plugin: string): string => {
  const sanitized = plugin.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "_";
};
const pluginRegistryFilePath = (plugin: string): string => {
  const hash = createHash("sha256").update(plugin).digest("hex").slice(0, 16);
  return join(registryRootDir(), sanitizePluginSegment(plugin), `${hash}.registry.json`);
};

const makeEntry = (overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
  pid: 1234,
  sock: "/tmp/plugin-a.sock",
  bundleHash: "abc123",
  startedAt: Date.now(),
  lastUsed: Date.now(),
  ...overrides,
});

describe("UDS Registry", () => {
  beforeEach(async () => {
    // Clean up the whole registry root before each test.
    try {
      await rm(registryRootDir(), { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, which is fine.
    }
  });

  afterEach(async () => {
    try {
      await rm(registryRootDir(), { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, which is fine.
    }
  });

  describe("registerDaemon / getDaemon", () => {
    it("registers a new daemon", async () => {
      const entry = makeEntry();
      await registerDaemon("plugin-a", entry);

      const result = await getDaemon("plugin-a");
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.pid).toBe(1234);
      }
    });

    it("writes to a dedicated per-plugin file, not a shared registry.json", async () => {
      const entry = makeEntry();
      await registerDaemon("plugin-a", entry);

      const path = pluginRegistryFilePath("plugin-a");
      expect(existsSync(path)).toBe(true);

      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.plugin).toBe("plugin-a");
      expect(parsed.pid).toBe(1234);
    });

    it("updates an existing daemon", async () => {
      await registerDaemon("plugin-a", makeEntry({ pid: 1234, sock: "/tmp/plugin-a.sock", bundleHash: "abc123" }));
      await registerDaemon("plugin-a", makeEntry({ pid: 5678, sock: "/tmp/plugin-a-new.sock", bundleHash: "xyz789" }));

      const result = await getDaemon("plugin-a");
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.pid).toBe(5678);
      }
    });

    it("returns absent if daemon not registered", async () => {
      const result = await getDaemon("plugin-not-registered");
      expect(result.kind).toBe("absent");
    });

    it("returns absent for a corrupted per-plugin registry file", async () => {
      const path = pluginRegistryFilePath("plugin-a");
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "not valid json {", "utf8");

      const result = await getDaemon("plugin-a");
      expect(result.kind).toBe("absent");
    });

    it("returns absent for a per-plugin file missing required fields", async () => {
      const path = pluginRegistryFilePath("plugin-a");
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify({ plugin: "plugin-a", pid: 1234 }), "utf8");

      const result = await getDaemon("plugin-a");
      expect(result.kind).toBe("absent");
    });

    it("supports plugin names with scoped-package characters (e.g. '/')", async () => {
      const entry = makeEntry({ sock: "/tmp/scoped.sock" });
      await registerDaemon("@scope/plugin", entry);

      const result = await getDaemon("@scope/plugin");
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.sock).toBe("/tmp/scoped.sock");
      }
    });

    it("throws UDSRegistryError on I/O failure (read-only plugin directory)", async () => {
      const path = pluginRegistryFilePath("plugin-a");
      const dir = join(path, "..");

      await mkdir(dir, { recursive: true });
      if (process.platform !== "win32") {
        await new Promise<void>((resolve, reject) => {
          require("child_process").exec(`chmod 444 "${dir}"`, (err: unknown) => {
            if (err) reject(err);
            else resolve();
          });
        });

        try {
          await expect(registerDaemon("plugin-a", makeEntry())).rejects.toBeInstanceOf(UDSRegistryError);
        } finally {
          await new Promise<void>((resolve) => {
            require("child_process").exec(`chmod 755 "${dir}"`, () => resolve());
          });
        }
      }
    });
  });

  describe("unregisterDaemon", () => {
    it("removes a registered daemon", async () => {
      await registerDaemon("plugin-a", makeEntry());
      await unregisterDaemon("plugin-a");

      const result = await getDaemon("plugin-a");
      expect(result.kind).toBe("absent");
    });

    it("succeeds silently if daemon not registered", async () => {
      await unregisterDaemon("plugin-not-registered");
      expect(true).toBe(true); // If we reach here, no error was thrown
    });

    it("does not affect other plugins' registrations", async () => {
      await registerDaemon("plugin-a", makeEntry({ sock: "/tmp/a.sock" }));
      await registerDaemon("plugin-b", makeEntry({ sock: "/tmp/b.sock" }));

      await unregisterDaemon("plugin-a");

      expect((await getDaemon("plugin-a")).kind).toBe("absent");
      const b = await getDaemon("plugin-b");
      expect(b.kind).toBe("ok");
      if (b.kind === "ok") expect(b.value.sock).toBe("/tmp/b.sock");
    });
  });

  describe("getAllDaemons", () => {
    it("returns absent when the registry root does not exist", async () => {
      const result = await getAllDaemons();
      expect(result.kind).toBe("absent");
    });

    it("returns empty record once every registered plugin has been unregistered", async () => {
      await registerDaemon("plugin-a", makeEntry());
      await unregisterDaemon("plugin-a");

      const result = await getAllDaemons();
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(Object.keys(result.value).length).toBe(0);
      }
    });

    it("returns all registered daemons across plugins", async () => {
      await registerDaemon("plugin-a", makeEntry({ pid: 1234, sock: "/tmp/plugin-a.sock", bundleHash: "abc123" }));
      await registerDaemon("plugin-b", makeEntry({ pid: 5678, sock: "/tmp/plugin-b.sock", bundleHash: "def456" }));

      const result = await getAllDaemons();
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(Object.keys(result.value).length).toBe(2);
        expect(result.value["plugin-a"]).toBeDefined();
        expect(result.value["plugin-b"]).toBeDefined();
      }
    });

    it("skips a corrupted per-plugin file without losing the others", async () => {
      await registerDaemon("plugin-a", makeEntry({ sock: "/tmp/plugin-a.sock" }));
      await registerDaemon("plugin-b", makeEntry({ sock: "/tmp/plugin-b.sock" }));

      // Corrupt plugin-a's own file directly.
      await writeFile(pluginRegistryFilePath("plugin-a"), "not valid json {", "utf8");

      const result = await getAllDaemons();
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value["plugin-a"]).toBeUndefined();
        expect(result.value["plugin-b"]).toBeDefined();
      }
    });
  });

  describe("touchDaemon", () => {
    it("updates lastUsed timestamp", async () => {
      const now = Date.now();
      await registerDaemon("plugin-a", makeEntry({ startedAt: now, lastUsed: now }));

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

    it("preserves the plugin's other fields (pid, sock, bundleHash) unchanged", async () => {
      await registerDaemon("plugin-a", makeEntry({ pid: 999, sock: "/tmp/keep.sock", bundleHash: "keep-hash" }));
      await touchDaemon("plugin-a");

      const result = await getDaemon("plugin-a");
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.pid).toBe(999);
        expect(result.value.sock).toBe("/tmp/keep.sock");
        expect(result.value.bundleHash).toBe("keep-hash");
      }
    });
  });

  describe("regression: cross-plugin registration race (was: shared registry.json read-modify-write)", () => {
    it("10 concurrent registrations across 10 different plugins: all 10 survive", async () => {
      const pluginCount = 10;
      const entries: Array<{ plugin: string; entry: RegistryEntry }> = Array.from(
        { length: pluginCount },
        (_, i) => ({
          plugin: `plugin-${i}`,
          entry: makeEntry({
            pid: 2000 + i,
            sock: `/tmp/plugin-${i}.sock`,
            bundleHash: `hash-${i}`,
          }),
        }),
      );

      // Fire all registrations concurrently -- this is exactly the shape
      // that used to drop entries under the old single shared-file
      // read-modify-write design.
      await Promise.all(entries.map(({ plugin, entry }) => registerDaemon(plugin, entry)));

      const result = await getAllDaemons();
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;

      expect(Object.keys(result.value).length).toBe(pluginCount);

      for (const { plugin, entry } of entries) {
        const record = result.value[plugin];
        expect(record).toBeDefined();
        expect(record?.pid).toBe(entry.pid);
        expect(record?.sock).toBe(entry.sock);
        expect(record?.bundleHash).toBe(entry.bundleHash);
      }
    });
  });

  describe("regression: ownership-gated cleanup (was: predecessor unlinks successor's socket/record)", () => {
    it("cleans up when the record still names the caller's own pid", async () => {
      await mkdir(registryRootDir(), { recursive: true });
      const socketPath = join(registryRootDir(), "cleanup-owned.sock");
      await writeFile(socketPath, "");
      await registerDaemon("plugin-a", makeEntry({ pid: process.pid, sock: socketPath }));

      const outcome = await cleanupDaemonIfOwner("plugin-a", process.pid, socketPath);

      expect(outcome).toBe("cleaned");
      expect(existsSync(socketPath)).toBe(false);
      expect((await getDaemon("plugin-a")).kind).toBe("absent");
    });

    it("does not touch a successor's socket file or record when the record names a different pid", async () => {
      await mkdir(registryRootDir(), { recursive: true });
      const socketPath = join(registryRootDir(), "cleanup-successor.sock");
      const successorPid = process.pid; // a real, live pid
      const predecessorPid = successorPid + 1; // a different pid than the record's owner

      // Successor has already bound its socket and re-registered under the
      // same plugin key by the time the predecessor's slow-drain cleanup runs.
      await writeFile(socketPath, "");
      await registerDaemon("plugin-a", makeEntry({ pid: successorPid, sock: socketPath }));

      const outcome = await cleanupDaemonIfOwner("plugin-a", predecessorPid, socketPath);

      expect(outcome).toBe("not-owner");
      // Successor's socket file must survive.
      expect(existsSync(socketPath)).toBe(true);
      // Successor's registry record must survive, untouched.
      const record = await getDaemon("plugin-a");
      expect(record.kind).toBe("ok");
      if (record.kind === "ok") {
        expect(record.value.pid).toBe(successorPid);
        expect(record.value.sock).toBe(socketPath);
      }
    });

    it("treats a missing record as not-ours and touches nothing", async () => {
      await mkdir(registryRootDir(), { recursive: true });
      const socketPath = join(registryRootDir(), "cleanup-missing.sock");
      await writeFile(socketPath, "");

      const outcome = await cleanupDaemonIfOwner("plugin-never-registered", process.pid, socketPath);

      expect(outcome).toBe("absent");
      expect(existsSync(socketPath)).toBe(true);
    });
  });
});
