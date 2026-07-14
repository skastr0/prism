import { describe, expect, it, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DaemonResolveError,
  pluginBundlePath,
  pluginDaemonLogPath,
  pluginRuntimeDir,
  resolveOrSpawnDaemon,
  tryPluginDaemonLogPath,
} from "./daemon-resolver";
import { udsPathFor } from "./uds-path";
import type { RegistryEntry, RegistryResult } from "./uds-registry";

const sha256Hex = (content: string): string => createHash("sha256").update(content).digest("hex");

const tempDirs: string[] = [];
const fakeServers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of fakeServers.splice(0)) server.stop(true);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "daemon-resolver-test-"));
  tempDirs.push(dir);
  return dir;
};

const writeBundle = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

/** Binds a bare UDS listener so `probeSocketLiveness` sees "live" -- the
 * liveness probe is a raw socket connect, not an MCP/HTTP handshake, so this
 * needs no protocol at all. */
const bindFakeDaemon = (socketPath: string): void => {
  fakeServers.push(Bun.serve({ unix: socketPath, fetch: () => new Response("ok") }));
};

describe("pluginRuntimeDir / pluginBundlePath", () => {
  it("derive from udsPathFor's own directory layout rather than re-deriving it", () => {
    expect(pluginRuntimeDir("my-plugin")).toBe(dirname(udsPathFor("my-plugin", "")));
    expect(pluginBundlePath("my-plugin")).toBe(join(pluginRuntimeDir("my-plugin"), "server.mjs"));
  });

  it("thread an explicit prismHome through to udsPathFor instead of raw homedir()", () => {
    const prismHome = "/custom/prism-home";
    expect(pluginRuntimeDir("my-plugin", prismHome)).toBe(
      dirname(udsPathFor("my-plugin", "", prismHome)),
    );
    expect(pluginRuntimeDir("my-plugin", prismHome)).toBe(
      "/custom/prism-home/runtime/mcp/my-plugin",
    );
    expect(pluginBundlePath("my-plugin", prismHome)).toBe(
      "/custom/prism-home/runtime/mcp/my-plugin/server.mjs",
    );
  });
});

describe("pluginDaemonLogPath / tryPluginDaemonLogPath", () => {
  it("derives from pluginRuntimeDir, next to the bundle and socket (OBS-001)", () => {
    expect(pluginDaemonLogPath("my-plugin")).toBe(join(pluginRuntimeDir("my-plugin"), "daemon.log"));
  });

  it("threads an explicit prismHome through, same as pluginBundlePath", () => {
    const prismHome = "/custom/prism-home";
    expect(pluginDaemonLogPath("my-plugin", prismHome)).toBe(
      "/custom/prism-home/runtime/mcp/my-plugin/daemon.log",
    );
  });

  it("tryPluginDaemonLogPath matches pluginDaemonLogPath for a valid plugin/prismHome", () => {
    const prismHome = "/custom/prism-home";
    expect(tryPluginDaemonLogPath("my-plugin", prismHome)).toBe(pluginDaemonLogPath("my-plugin", prismHome));
  });

  it("tryPluginDaemonLogPath degrades to undefined instead of throwing for an invalid plugin name", () => {
    expect(() => pluginDaemonLogPath("not a valid plugin name!")).toThrow();
    expect(tryPluginDaemonLogPath("not a valid plugin name!", undefined)).toBeUndefined();
  });
});

describe("resolveOrSpawnDaemon", () => {
  it("reuses a live registry entry when the bundle hash matches, without spawning", async () => {
    const dir = await makeTempDir();
    const bundlePath = join(dir, "server.mjs");
    const content = "console.log('v1');";
    await writeBundle(bundlePath, content);
    const hash = sha256Hex(content);

    const sock = join(dir, "d.sock");
    bindFakeDaemon(sock);
    const entry: RegistryEntry = { pid: 4242, sock, bundleHash: hash, startedAt: 0, lastUsed: 0 };

    let spawnCalls = 0;
    const result = await resolveOrSpawnDaemon({
      plugin: "plugin-x",
      bundlePathFor: () => bundlePath,
      getDaemon: async (): Promise<RegistryResult<RegistryEntry>> => ({ kind: "ok", value: entry }),
      spawnDaemon: () => {
        spawnCalls += 1;
      },
    });

    expect(result).toEqual(entry);
    expect(spawnCalls).toBe(0);
  });

  it("spawns a fresh daemon when the registry is absent, and resolves once it registers", async () => {
    const dir = await makeTempDir();
    const bundlePath = join(dir, "server.mjs");
    const content = "console.log('v1');";
    await writeBundle(bundlePath, content);
    const hash = sha256Hex(content);

    let registered: RegistryEntry | undefined;
    let spawnCalls = 0;

    const result = await resolveOrSpawnDaemon({
      plugin: "plugin-x",
      spawnTimeoutMs: 2000,
      pollIntervalMs: 10,
      bundlePathFor: () => bundlePath,
      udsPathFor: (plugin, bundleHash) => join(dir, `${plugin}-${bundleHash}.sock`),
      getDaemon: async (): Promise<RegistryResult<RegistryEntry>> =>
        registered ? { kind: "ok", value: registered } : { kind: "absent" },
      spawnDaemon: ({ plugin, udsPath, bundleHash }) => {
        spawnCalls += 1;
        setTimeout(() => {
          bindFakeDaemon(udsPath);
          registered = { pid: 4343, sock: udsPath, bundleHash, startedAt: Date.now(), lastUsed: Date.now() };
        }, 30);
      },
    });

    expect(spawnCalls).toBe(1);
    expect(result.bundleHash).toBe(hash);
    expect(result.sock).toBe(join(dir, `plugin-x-${hash}.sock`));
  });

  it("honors options.prismHome in the default bundlePathFor/udsPathFor when neither is overridden", async () => {
    // Short prefix + short plugin name: udsPathFor's 100-byte sun_path
    // assertion leaves little headroom once the OS tmpdir prefix is added.
    const prismHome = await mkdtemp(join(tmpdir(), "ph"));
    tempDirs.push(prismHome);
    const bundlePath = pluginBundlePath("p", prismHome);
    const content = "console.log('v1');";
    await writeBundle(bundlePath, content);
    const hash = sha256Hex(content);
    const expectedSock = udsPathFor("p", hash, prismHome);

    let registered: RegistryEntry | undefined;
    let spawnCalls = 0;

    const result = await resolveOrSpawnDaemon({
      plugin: "p",
      prismHome,
      spawnTimeoutMs: 2000,
      pollIntervalMs: 10,
      getDaemon: async (): Promise<RegistryResult<RegistryEntry>> =>
        registered ? { kind: "ok", value: registered } : { kind: "absent" },
      spawnDaemon: ({ udsPath, bundleHash }) => {
        spawnCalls += 1;
        expect(udsPath).toBe(expectedSock);
        setTimeout(() => {
          bindFakeDaemon(udsPath);
          registered = { pid: 5151, sock: udsPath, bundleHash, startedAt: Date.now(), lastUsed: Date.now() };
        }, 30);
      },
    });

    expect(spawnCalls).toBe(1);
    expect(result.sock).toBe(expectedSock);
  });

  it("treats a hash-mismatched registered entry as stale and spawns fresh on a new socket", async () => {
    const dir = await makeTempDir();
    const bundlePath = join(dir, "server.mjs");
    const newContent = "console.log('v2');";
    await writeBundle(bundlePath, newContent);
    const newHash = sha256Hex(newContent);

    const oldSock = join(dir, "old.sock");
    bindFakeDaemon(oldSock); // the old (stale-bundle) daemon is still alive
    const oldEntry: RegistryEntry = { pid: 1, sock: oldSock, bundleHash: "stale-hash", startedAt: 0, lastUsed: 0 };

    let registered: RegistryEntry | undefined;
    const spawnedWith: Array<{ readonly udsPath: string; readonly bundleHash: string }> = [];

    const result = await resolveOrSpawnDaemon({
      plugin: "plugin-x",
      spawnTimeoutMs: 2000,
      pollIntervalMs: 10,
      bundlePathFor: () => bundlePath,
      udsPathFor: (plugin, bundleHash) => join(dir, `${plugin}-${bundleHash}.sock`),
      getDaemon: async (): Promise<RegistryResult<RegistryEntry>> =>
        registered ? { kind: "ok", value: registered } : { kind: "ok", value: oldEntry },
      spawnDaemon: ({ udsPath, bundleHash }) => {
        spawnedWith.push({ udsPath, bundleHash });
        setTimeout(() => {
          bindFakeDaemon(udsPath);
          registered = { pid: 2, sock: udsPath, bundleHash, startedAt: Date.now(), lastUsed: Date.now() };
        }, 30);
      },
    });

    expect(spawnedWith).toHaveLength(1);
    expect(spawnedWith[0]?.bundleHash).toBe(newHash);
    expect(result.bundleHash).toBe(newHash);
    expect(result.sock).not.toBe(oldSock);
    // The stale-bundle daemon was never touched -- it idle-reaps on its own.
    expect(oldEntry.pid).toBe(1);
  });

  it("treats a dead registered entry (matching hash) as absent and respawns on the same socket", async () => {
    const dir = await makeTempDir();
    const bundlePath = join(dir, "server.mjs");
    const content = "console.log('v1');";
    await writeBundle(bundlePath, content);
    const hash = sha256Hex(content);

    // Same path a fresh spawn for this hash would compute -- but never
    // bound, simulating a daemon that died without unregistering.
    const sock = join(dir, `plugin-x-${hash}.sock`);
    const deadEntry: RegistryEntry = { pid: 999, sock, bundleHash: hash, startedAt: 0, lastUsed: 0 };

    let spawnCalls = 0;
    const result = await resolveOrSpawnDaemon({
      plugin: "plugin-x",
      spawnTimeoutMs: 2000,
      pollIntervalMs: 10,
      bundlePathFor: () => bundlePath,
      udsPathFor: (plugin, bundleHash) => join(dir, `${plugin}-${bundleHash}.sock`),
      getDaemon: async (): Promise<RegistryResult<RegistryEntry>> => ({ kind: "ok", value: deadEntry }),
      spawnDaemon: ({ udsPath }) => {
        spawnCalls += 1;
        setTimeout(() => bindFakeDaemon(udsPath), 30);
      },
    });

    expect(spawnCalls).toBe(1);
    expect(result.sock).toBe(sock);
  });

  it("throws DaemonResolveError when there is no daemon and no bundle to spawn", async () => {
    const dir = await makeTempDir();
    const missingBundlePath = join(dir, "nowhere", "server.mjs");

    await expect(
      resolveOrSpawnDaemon({
        plugin: "plugin-x",
        bundlePathFor: () => missingBundlePath,
        getDaemon: async (): Promise<RegistryResult<RegistryEntry>> => ({ kind: "absent" }),
      }),
    ).rejects.toBeInstanceOf(DaemonResolveError);
  });

  it("throws DaemonResolveError when the spawned daemon never becomes live in time", async () => {
    const dir = await makeTempDir();
    const bundlePath = join(dir, "server.mjs");
    await writeBundle(bundlePath, "console.log('v1');");

    await expect(
      resolveOrSpawnDaemon({
        plugin: "plugin-x",
        spawnTimeoutMs: 120,
        pollIntervalMs: 20,
        bundlePathFor: () => bundlePath,
        udsPathFor: () => join(dir, "never-bound.sock"),
        getDaemon: async (): Promise<RegistryResult<RegistryEntry>> => ({ kind: "absent" }),
        spawnDaemon: () => {
          // Never registers -- simulates a daemon that fails to start.
        },
      }),
    ).rejects.toBeInstanceOf(DaemonResolveError);
  });

  it("mentions the daemon log path in the timeout error (OBS-001 discoverability)", async () => {
    const dir = await makeTempDir();
    const bundlePath = join(dir, "server.mjs");
    await writeBundle(bundlePath, "console.log('v1');");
    // Short prismHome + short plugin name: `pluginDaemonLogPath` routes
    // through the real `udsPathFor` (see its doc comment) and so is bound
    // by its 100-byte sun_path assertion even though this hint is just a
    // log file path -- same constraint the "honors options.prismHome" test
    // above works around.
    const prismHome = await mkdtemp(join(tmpdir(), "ph"));
    tempDirs.push(prismHome);
    const plugin = "q";

    let caught: unknown;
    try {
      await resolveOrSpawnDaemon({
        plugin,
        prismHome,
        spawnTimeoutMs: 120,
        pollIntervalMs: 20,
        bundlePathFor: () => bundlePath,
        udsPathFor: () => join(dir, "never-bound.sock"),
        getDaemon: async (): Promise<RegistryResult<RegistryEntry>> => ({ kind: "absent" }),
        spawnDaemon: () => {
          // Never registers -- simulates a daemon that fails to start.
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DaemonResolveError);
    expect((caught as DaemonResolveError).message).toContain(pluginDaemonLogPath(plugin, prismHome));
  });

  it("redirects a real spawned daemon's stdout+stderr into its per-plugin log file (OBS-001)", async () => {
    // Short prismHome + short plugin name -- same sun_path-length reason as
    // the test above; `defaultSpawnDaemon` derives the log path via
    // `pluginDaemonLogPath` -> `pluginRuntimeDir`, which is still subject to
    // that assertion even though a log file itself has no such OS limit.
    const prismHome = await mkdtemp(join(tmpdir(), "ph"));
    tempDirs.push(prismHome);
    const plugin = "p";

    const scriptDir = await makeTempDir();
    const scriptPath = join(scriptDir, "fake-daemon.mjs");
    await writeFile(
      scriptPath,
      "console.log('obs-001-stdout-marker');\nconsole.error('obs-001-stderr-marker');\n",
    );

    // `spawnDaemon` is deliberately NOT overridden here -- this is the one
    // test in this suite that exercises the real `defaultSpawnDaemon`, the
    // only code path that wires the log sink. The daemon never registers
    // (getDaemon always reports absent), so resolution times out; that is
    // expected and irrelevant to what this test checks.
    await expect(
      resolveOrSpawnDaemon({
        plugin,
        prismHome,
        spawnTimeoutMs: 2000,
        pollIntervalMs: 20,
        bundlePathFor: () => scriptPath,
        udsPathFor: () => join(scriptDir, "never-bound.sock"),
        getDaemon: async (): Promise<RegistryResult<RegistryEntry>> => ({ kind: "absent" }),
      }),
    ).rejects.toBeInstanceOf(DaemonResolveError);

    const logPath = pluginDaemonLogPath(plugin, prismHome);
    const content = await readFile(logPath, "utf8");
    expect(content).toContain("obs-001-stdout-marker");
    expect(content).toContain("obs-001-stderr-marker");
  });
});
