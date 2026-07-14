import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_LOG_SIZE_CAP_BYTES, prepareDaemonLogSink } from "./daemon-log";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "daemon-log-test-"));
  tempDirs.push(dir);
  return dir;
};

describe("prepareDaemonLogSink", () => {
  it("creates the parent directory and an empty log file for a fresh path", async () => {
    const dir = await makeTempDir();
    const logPath = join(dir, "runtime", "mcp", "my-plugin", "daemon.log");

    const fd = prepareDaemonLogSink(logPath);
    try {
      expect(statSync(logPath).size).toBe(0);
    } finally {
      closeSync(fd);
    }
  });

  it("returns an fd that appends -- writes through it land after existing content", async () => {
    const dir = await makeTempDir();
    const logPath = join(dir, "daemon.log");
    writeFileSync(logPath, "pre-existing\n");

    const fd = prepareDaemonLogSink(logPath);
    try {
      writeFileSync(fd, "appended\n");
    } finally {
      closeSync(fd);
    }

    expect(readFileSync(logPath, "utf8")).toBe("pre-existing\nappended\n");
  });

  it("leaves a file under the size cap untouched (no truncation)", async () => {
    const dir = await makeTempDir();
    const logPath = join(dir, "daemon.log");
    const content = "x".repeat(1024);
    writeFileSync(logPath, content);

    const fd = prepareDaemonLogSink(logPath);
    closeSync(fd);

    expect(readFileSync(logPath, "utf8")).toBe(content);
  });

  it("truncates a file that has already grown past the size cap before returning the fd (OBS-001)", async () => {
    const dir = await makeTempDir();
    const logPath = join(dir, "daemon.log");
    writeFileSync(logPath, Buffer.alloc(DAEMON_LOG_SIZE_CAP_BYTES + 1, "a"));
    expect(statSync(logPath).size).toBeGreaterThan(DAEMON_LOG_SIZE_CAP_BYTES);

    const fd = prepareDaemonLogSink(logPath);
    try {
      expect(statSync(logPath).size).toBe(0);
      writeFileSync(fd, "fresh-after-truncate\n");
    } finally {
      closeSync(fd);
    }

    expect(readFileSync(logPath, "utf8")).toBe("fresh-after-truncate\n");
  });

  it("throws when the parent directory cannot be created (e.g. a file occupies that path segment)", async () => {
    const dir = await makeTempDir();
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "blocking file");
    const logPath = join(blocker, "daemon.log");

    expect(() => prepareDaemonLogSink(logPath)).toThrow();
  });
});

// Sandboxing note: unlike `uds-registry.test.ts`, this module never reads
// `PRISM_HOME`/`homedir()` itself -- every path is threaded in explicitly by
// the caller -- so there is no real-machine-state risk to guard against here
// beyond the ordinary per-test `mkdtemp`/`rm` cleanup above.
