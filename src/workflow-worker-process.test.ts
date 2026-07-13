import { describe, expect, test as bunTest } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentCliCommand } from "./workflow-cli-command.js";
import { runWorkflowWorkerProcess } from "./workflow-worker-process.js";

const POLL_MS = 20;
const PROCESS_DEADLINE_MS = 4_000;

const test = (name: string, run: () => void | Promise<void>) => bunTest(name, run, 15_000);

interface ProcessFixture {
  readonly root: string;
  readonly parentPidFile: string;
  readonly descendantPidFile: string;
}

const createProcessFixture = async (): Promise<ProcessFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "prism-workflow-process-"));
  return {
    root,
    parentPidFile: path.join(root, "parent.pid"),
    descendantPidFile: path.join(root, "descendant.pid"),
  };
};

const errnoCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return false;
    if (errnoCode(error) === "EPERM") return true;
    throw error;
  }
};

const processGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return false;
    if (errnoCode(error) === "EPERM") return true;
    throw error;
  }
};

const pollUntil = async (predicate: () => boolean | Promise<boolean>, timeoutMs = PROCESS_DEADLINE_MS): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
  return true;
};

const readFixturePid = async (file: string): Promise<number> => {
  let pid: number | undefined;
  const appeared = await pollUntil(async () => {
    try {
      const value = Number.parseInt((await readFile(file, "utf8")).trim(), 10);
      if (!Number.isInteger(value) || value <= 0) return false;
      pid = value;
      return true;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
  });
  if (!appeared || pid === undefined) throw new Error(`fixture PID did not appear: ${file}`);
  return pid;
};

const signalFixtureGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (errnoCode(error) !== "ESRCH") throw error;
  }
};

const cleanupFixtureGroup = async (pid: number | undefined): Promise<void> => {
  if (pid === undefined || !processGroupExists(pid)) return;
  signalFixtureGroup(pid, "SIGTERM");
  if (await pollUntil(() => !processGroupExists(pid), 500)) return;
  signalFixtureGroup(pid, "SIGKILL");
  if (!(await pollUntil(() => !processGroupExists(pid)))) {
    throw new Error(`fixture process group ${pid} survived SIGKILL`);
  }
};

const fixtureShellArgs = (fixture: ProcessFixture, completion: string): ReadonlyArray<string> => [
  "-c",
  [
    "printf '%s\\n' \"$$\" > \"$1\"",
    "(trap '' HUP; exec sleep 30) &",
    "printf '%s\\n' \"$!\" > \"$2\"",
    completion,
  ].join("\n"),
  "workflow-process-fixture",
  fixture.parentPidFile,
  fixture.descendantPidFile,
];

const expectFixtureAbsent = async (parentPid: number, descendantPid: number): Promise<void> => {
  expect(await pollUntil(() => !pidIsAlive(parentPid) && !pidIsAlive(descendantPid))).toBe(true);
  expect(processGroupExists(parentPid)).toBe(false);
};

const runFixture = (
  fixture: ProcessFixture,
  completion: string,
  options: { readonly abortSignal?: AbortSignal; readonly processTimeoutMs?: number; readonly earlyExit?: boolean } = {},
) => runWorkflowWorkerProcess({
  command: "sh",
  args: fixtureShellArgs(fixture, completion),
  cwd: fixture.root,
  ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  ...(options.processTimeoutMs === undefined ? {} : { processTimeoutMs: options.processTimeoutMs }),
  ...(options.earlyExit === true
    ? { earlyExitPatterns: [{ name: "fixture-ready", pattern: /fixture-ready/u }] }
    : {}),
});

describe("runWorkflowWorkerProcess process ownership", () => {
  test("resolves the source CLI independently of the caller entrypoint", () => {
    expect(currentCliCommand()).toEqual([
      process.execPath,
      "run",
      fileURLToPath(new URL("./cli.ts", import.meta.url)),
    ]);
  });

  test("timeout kills the direct child and inherited-stdio descendant", async () => {
    const fixture = await createProcessFixture();
    let parentPid: number | undefined;
    try {
      const result = await runFixture(fixture, "wait", { processTimeoutMs: 1_000 });
      parentPid = await readFixturePid(fixture.parentPidFile);
      const descendantPid = await readFixturePid(fixture.descendantPidFile);

      expect(result.timedOut).toBe(true);
      expect(result.aborted).toBe(false);
      await expectFixtureAbsent(parentPid, descendantPid);
    } finally {
      await cleanupFixtureGroup(parentPid);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("abort kills the direct child and inherited-stdio descendant", async () => {
    const fixture = await createProcessFixture();
    const controller = new AbortController();
    let parentPid: number | undefined;
    try {
      const running = runFixture(fixture, "wait", { abortSignal: controller.signal });
      parentPid = await readFixturePid(fixture.parentPidFile);
      const descendantPid = await readFixturePid(fixture.descendantPidFile);
      controller.abort();
      const result = await running;

      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(true);
      await expectFixtureAbsent(parentPid, descendantPid);
    } finally {
      controller.abort();
      await cleanupFixtureGroup(parentPid);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("successful direct-child exit cleans inherited-stdio descendants", async () => {
    const fixture = await createProcessFixture();
    let parentPid: number | undefined;
    try {
      const result = await runFixture(
        fixture,
        "printf 'completed'; exit 0",
      );
      parentPid = await readFixturePid(fixture.parentPidFile);
      const descendantPid = await readFixturePid(fixture.descendantPidFile);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("completed");
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
      await expectFixtureAbsent(parentPid, descendantPid);
    } finally {
      await cleanupFixtureGroup(parentPid);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("normal direct-child exit cleans background descendants and preserves output and exit code", async () => {
    const fixture = await createProcessFixture();
    let parentPid: number | undefined;
    try {
      const result = await runFixture(
        fixture,
        "printf 'stdout-unchanged'; printf 'stderr-unchanged' >&2; exit 7",
      );
      parentPid = await readFixturePid(fixture.parentPidFile);
      const descendantPid = await readFixturePid(fixture.descendantPidFile);

      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe("stdout-unchanged");
      expect(result.stderr).toBe("stderr-unchanged");
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
      await expectFixtureAbsent(parentPid, descendantPid);
    } finally {
      await cleanupFixtureGroup(parentPid);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("early-exit detection cleans the full workload process group", async () => {
    const fixture = await createProcessFixture();
    let parentPid: number | undefined;
    try {
      const result = await runFixture(fixture, "printf 'fixture-ready'; wait", { earlyExit: true });
      parentPid = await readFixturePid(fixture.parentPidFile);
      const descendantPid = await readFixturePid(fixture.descendantPidFile);

      expect(result.earlyExit).toBe("fixture-ready");
      expect(result.stdout).toBe("fixture-ready");
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
      await expectFixtureAbsent(parentPid, descendantPid);
    } finally {
      await cleanupFixtureGroup(parentPid);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("host SIGKILL closes the guard lease and removes both workload processes", async () => {
    const fixture = await createProcessFixture();
    const hostFile = path.join(fixture.root, "host.ts");
    const workerModule = pathToFileURL(path.join(process.cwd(), "src", "workflow-worker-process.ts")).href;
    await writeFile(hostFile, [
      `import { runWorkflowWorkerProcess } from ${JSON.stringify(workerModule)};`,
      "await runWorkflowWorkerProcess({",
      "  command: 'sh',",
      `  args: ${JSON.stringify(fixtureShellArgs(fixture, "wait"))},`,
      `  cwd: ${JSON.stringify(fixture.root)},`,
      "});",
    ].join("\n"));

    let parentPid: number | undefined;
    const host = Bun.spawn({
      cmd: [process.execPath, "run", hostFile],
      cwd: fixture.root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      parentPid = await readFixturePid(fixture.parentPidFile);
      const descendantPid = await readFixturePid(fixture.descendantPidFile);
      host.kill("SIGKILL");
      await host.exited;

      await expectFixtureAbsent(parentPid, descendantPid);
    } finally {
      host.kill("SIGKILL");
      await host.exited;
      await cleanupFixtureGroup(parentPid);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
