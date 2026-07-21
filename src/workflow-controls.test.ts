import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startDetachedWorkflowRun,
  updateDetachedWorkflowRun,
  workflowDetachedRunArgs,
  workflowRunOptionsSnapshot,
  workflowRunnerLogDir,
  workflowRunnerLogPath,
  workflowRunnerLogPathIfPresent,
  type WorkflowUpdateResult,
} from "./workflow-controls.js";
import { WorkflowStore } from "./workflow-store.js";

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

// WFE-008: several tests here spawn the real CLI without setting PRISM_HOME,
// so `workflow run`/`runs stop`/`runs update` register their tmp store paths
// into the developer's real `~/.prism` registry (src/cli.ts's
// resolveWorkflowStorePath runs on every store touch). Sandbox PRISM_HOME for
// the whole file; a test that passes its own PRISM_HOME override still wins.
let sandboxPrismHome: string;
let previousPrismHomeEnv: string | undefined;

beforeAll(async () => {
  sandboxPrismHome = await mkdtemp(join(tmpdir(), "prism-workflow-controls-home-"));
  previousPrismHomeEnv = process.env.PRISM_HOME;
  process.env.PRISM_HOME = sandboxPrismHome;
});

afterAll(async () => {
  if (previousPrismHomeEnv === undefined) delete process.env.PRISM_HOME;
  else process.env.PRISM_HOME = previousPrismHomeEnv;
  await rm(sandboxPrismHome, { recursive: true, force: true });
});

interface WorkerTreeMarker {
  readonly workerPid: number;
  readonly guardPid: number;
  readonly grandchildPid: number;
}

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const errorCode = (error: unknown): string | undefined => {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
};

const isValidPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const pollUntil = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return true;
    await delay(25);
  } while (Date.now() < deadline);
  return predicate();
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
};

const isProcessGroupAlive = (leaderPid: number): boolean => {
  try {
    process.kill(-leaderPid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return false;
    throw error;
  }
};

const terminateProcessGroup = async (leaderPid: number): Promise<void> => {
  if (!isProcessGroupAlive(leaderPid)) return;
  try {
    process.kill(-leaderPid, "SIGTERM");
  } catch (error) {
    if (errorCode(error) === "ESRCH" || errorCode(error) === "EPERM") return;
    throw error;
  }
  if (await pollUntil(() => !isProcessGroupAlive(leaderPid), 250)) return;
  try {
    process.kill(-leaderPid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) === "ESRCH" || errorCode(error) === "EPERM") return;
    throw error;
  }
  await pollUntil(() => !isProcessGroupAlive(leaderPid), 2_000);
};

const cleanupProcessTree = async (
  runnerPid: number | undefined,
  marker: WorkerTreeMarker | undefined,
): Promise<void> => {
  if (runnerPid !== undefined) await terminateProcessGroup(runnerPid);
  if (marker !== undefined) await terminateProcessGroup(marker.workerPid);
  for (const pid of marker === undefined ? [] : [marker.workerPid, marker.guardPid, marker.grandchildPid]) {
    if (!isPidAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (errorCode(error) !== "ESRCH" && errorCode(error) !== "EPERM") throw error;
    }
  }
  await pollUntil(
    () => marker === undefined || [marker.workerPid, marker.guardPid, marker.grandchildPid].every((pid) => !isPidAlive(pid)),
    2_000,
  );
};

const workflowTestEnv = (overrides: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
};

const runCli = async (
  root: string,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<CliResult> => {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", join(process.cwd(), "src", "cli.ts"), ...args],
    cwd: root,
    env: workflowTestEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const workerWorkflowSource = (name: string): string => `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

export default defineWorkflow({
  name: ${JSON.stringify(name)},
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Exercise detached process ownership.",
    output: Schema.Struct({ summary: Schema.String }),
  })],
});
`;

const writeHangingWorkerTree = async (input: {
  readonly root: string;
  readonly markerPath: string;
  readonly releasePath?: string;
  readonly terminationMarkerPath?: string;
}): Promise<string> => {
  const grandchildPath = join(input.root, `grandchild-${randomUUID()}.mjs`);
  const guardPath = join(input.root, `guard-${randomUUID()}.mjs`);
  const workerPath = join(input.root, `worker-${randomUUID()}.mjs`);
  const releasePath = input.releasePath ?? "";
  const terminationMarkerPath = input.terminationMarkerPath ?? "";
  const signalHandlerLines = [
    "let stopping = false;",
    "const stop = (signal) => {",
    "  stopping = true;",
    "  if (terminationMarkerPath) appendFileSync(terminationMarkerPath, `${role}:${signal}\\n`);",
    "};",
    "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(signal));",
    "setInterval(() => {",
    "  if (stopping && (!releasePath || existsSync(releasePath))) process.exit(0);",
    "}, 10);",
    "if (terminationMarkerPath) appendFileSync(terminationMarkerPath, `${role}:ready\\n`);",
  ];
  await writeFile(grandchildPath, [
    "import { appendFileSync, existsSync } from 'node:fs';",
    "const role = 'grandchild';",
    `const releasePath = ${JSON.stringify(releasePath)};`,
    `const terminationMarkerPath = ${JSON.stringify(terminationMarkerPath)};`,
    ...signalHandlerLines,
    "",
  ].join("\n"));
  await writeFile(guardPath, [
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const role = 'guard';",
    `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildPath)}], { stdio: 'inherit' });`,
    `const markerPath = ${JSON.stringify(input.markerPath)};`,
    `const releasePath = ${JSON.stringify(releasePath)};`,
    `const terminationMarkerPath = ${JSON.stringify(terminationMarkerPath)};`,
    "writeFileSync(markerPath, JSON.stringify({ workerPid: process.ppid, guardPid: process.pid, grandchildPid: grandchild.pid }));",
    ...signalHandlerLines,
    "",
  ].join("\n"));
  await writeFile(workerPath, [
    "#!/usr/bin/env node",
    "import { appendFileSync, existsSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const role = 'worker';",
    `spawn(process.execPath, [${JSON.stringify(guardPath)}], { stdio: 'inherit' });`,
    `const releasePath = ${JSON.stringify(releasePath)};`,
    `const terminationMarkerPath = ${JSON.stringify(terminationMarkerPath)};`,
    ...signalHandlerLines,
    "",
  ].join("\n"));
  await chmod(workerPath, 0o755);
  return workerPath;
};

const readWorkerTreeMarker = async (path: string): Promise<WorkerTreeMarker> => {
  const value: unknown = JSON.parse(await Bun.file(path).text());
  if (
    value === null ||
    typeof value !== "object" ||
    !("workerPid" in value) ||
    !isValidPid(value.workerPid) ||
    !("guardPid" in value) ||
    !isValidPid(value.guardPid) ||
    !("grandchildPid" in value) ||
    !isValidPid(value.grandchildPid)
  ) {
    throw new Error(`invalid worker tree marker: ${path}`);
  }
  return { workerPid: value.workerPid, guardPid: value.guardPid, grandchildPid: value.grandchildPid };
};

const readPersistedRunnerPid = async (storePath: string, runId: string): Promise<number> => {
  const store = await WorkflowStore.open(storePath);
  try {
    const run = store.getRun(runId);
    expect(run).toMatchObject({
      status: "running",
      heartbeatAt: expect.any(String),
    });
    if (!isValidPid(run?.runnerPid)) {
      throw new Error(`workflow run did not persist a valid runner pid: ${runId}`);
    }
    return run.runnerPid;
  } finally {
    store.close();
  }
};

const waitForPersistedTerminal = async (storePath: string, runId: string): Promise<boolean> =>
  pollUntil(async () => {
    let store: WorkflowStore | undefined;
    try {
      store = await WorkflowStore.open(storePath);
      return store.getRun(runId)?.status !== "running";
    } catch (error) {
      if (errorCode(error) === "SQLITE_BUSY") return false;
      throw error;
    } finally {
      store?.close();
    }
  });

const parseCliRunId = (stdout: string): string => {
  const value: unknown = JSON.parse(stdout);
  if (value === null || typeof value !== "object" || !("runId" in value) || typeof value.runId !== "string") {
    throw new Error(`CLI response did not contain a run id: ${stdout}`);
  }
  return value.runId;
};

const treePids = (runnerPid: number, marker: WorkerTreeMarker): ReadonlyArray<number> => [
  runnerPid,
  marker.workerPid,
  marker.guardPid,
  marker.grandchildPid,
];

test("workflow budget controls round-trip through snapshots and exact detached child arguments", () => {
  const options = {
    worker: "grok",
    model: "grok-code-fast-1",
    permission: "restricted",
    mockOutput: "/tmp/mock-output.json",
    maxConcurrentTasks: 2,
    taskTimeoutMs: 3_000,
    maxWallMs: 12_000,
    taskNoProgressMs: 4_000,
    maxTasks: 7,
    maxCostUsd: 1.25,
    maxPromptBytes: 262_144,
  } as const;

  expect(workflowRunOptionsSnapshot(options)).toEqual(options);
  expect(workflowDetachedRunArgs(
    "/tmp/example.workflow.ts",
    options,
    { runId: "run-1", storePath: "/tmp/workflows.sqlite", token: "token-1" },
  )).toEqual([
    "workflow",
    "run",
    "/tmp/example.workflow.ts",
    "--store",
    "/tmp/workflows.sqlite",
    "--run-id",
    "run-1",
    "--run-token",
    "token-1",
    "--worker",
    "grok",
    "--model",
    "grok-code-fast-1",
    "--permission",
    "restricted",
    "--mock-output",
    "/tmp/mock-output.json",
    "--max-concurrent-tasks",
    "2",
    "--task-timeout-ms",
    "3000",
    "--max-wall-ms",
    "12000",
    "--task-no-progress-ms",
    "4000",
    "--max-tasks",
    "7",
    "--max-cost-usd",
    "1.25",
    "--max-prompt-bytes",
    "262144",
  ]);
});

test("detached CLI budget flags persist and survive the child handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-controls-roundtrip-"));
  let runnerPid: number | undefined;
  try {
    const workflowPath = join(root, "roundtrip.workflow.ts");
    const mockOutputPath = join(root, "mock-output.json");
    const storePath = join(root, "workflows.sqlite");
    await writeFile(workflowPath, workerWorkflowSource("budget-roundtrip"));
    await writeFile(mockOutputPath, `${JSON.stringify({ build: { summary: "done" } })}\n`);

    const result = await runCli(root, [
      "workflow",
      "run",
      workflowPath,
      "--mock-output",
      mockOutputPath,
      "--store",
      storePath,
      "--detach",
      "--max-concurrent-tasks",
      "2",
      "--task-timeout-ms",
      "5000",
      "--max-wall-ms",
      "30000",
      "--task-no-progress-ms",
      "20000",
      "--max-tasks",
      "3",
      "--max-cost-usd",
      "0",
      "--max-prompt-bytes",
      "8192",
    ], { PRISM_HOME: join(root, "prism-home") });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const runId = parseCliRunId(result.stdout);
    const store = await WorkflowStore.open(storePath);
    try {
      expect(store.getRunSnapshot(runId)?.options).toEqual({
        mockOutput: mockOutputPath,
        maxConcurrentTasks: 2,
        taskTimeoutMs: 5_000,
        maxWallMs: 30_000,
        taskNoProgressMs: 20_000,
        maxTasks: 3,
        maxCostUsd: 0,
        maxPromptBytes: 8_192,
      });
      const run = store.getRun(runId);
      if (!isValidPid(run?.runnerPid)) {
        throw new Error(`detached budget run did not persist a valid runner pid: ${runId}`);
      }
      runnerPid = run.runnerPid;
    } finally {
      store.close();
    }
    expect(await waitForPersistedTerminal(storePath, runId)).toBe(true);
    expect(await pollUntil(() => !isProcessGroupAlive(runnerPid!))).toBe(true);
  } finally {
    if (runnerPid !== undefined) await terminateProcessGroup(runnerPid);
    await rm(root, { recursive: true, force: true });
  }
});

test("detached workflow update inherits budget controls, applies explicit overrides, and records child pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-controls-"));
  try {
    const workflowPath = join(root, "update.workflow.ts");
    const mockOutputPath = join(root, "mock-output.json");
    const storePath = join(root, "workflows.sqlite");
    await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

const Output = Schema.Struct({ summary: Schema.String });

export default defineWorkflow({
  name: "update-control-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Build with previous options.",
    output: Output,
  })],
});
`);
    await writeFile(mockOutputPath, `${JSON.stringify({ build: { summary: "updated" } })}\n`);
    await mkdir(join(root, ".prism"), { recursive: true });

    const store = await WorkflowStore.open(storePath);
    const previousRunId = store.createRun("update-control-smoke");
    store.recordRunSnapshot({
      runId: previousRunId,
      workflowFile: workflowPath,
      options: {
        cache: false,
        mockOutput: mockOutputPath,
        maxConcurrentTasks: 1,
        maxWallMs: 30_000,
        taskNoProgressMs: 20_000,
        maxTasks: 2,
        maxCostUsd: 1.25,
        maxPromptBytes: 8_192,
      },
    });
    store.close();

    const update = await runCli(root, [
      "workflow",
      "runs",
      "update",
      previousRunId,
      workflowPath,
      "--store",
      storePath,
      "--max-wall-ms",
      "40000",
      "--task-no-progress-ms",
      "25000",
      "--max-tasks",
      "3",
      "--max-cost-usd",
      "0.75",
      "--max-prompt-bytes",
      "16384",
    ], { PRISM_HOME: join(root, "prism-home") });
    expect(update.exitCode).toBe(0);
    expect(update.stderr).toBe("");
    const result = JSON.parse(update.stdout) as WorkflowUpdateResult;
    expect(result.update).toMatchObject({
      inheritedOptions: {
        maxWallMs: 30_000,
        taskNoProgressMs: 20_000,
        maxTasks: 2,
        maxCostUsd: 1.25,
        maxPromptBytes: 8_192,
      },
      overrideOptions: {
        maxWallMs: 40_000,
        taskNoProgressMs: 25_000,
        maxTasks: 3,
        maxCostUsd: 0.75,
        maxPromptBytes: 16_384,
      },
      effectiveOptions: {
        maxWallMs: 40_000,
        taskNoProgressMs: 25_000,
        maxTasks: 3,
        maxCostUsd: 0.75,
        maxPromptBytes: 16_384,
      },
    });
    expect(result.update.inheritedOptions).not.toHaveProperty("cache");
    expect(result.update.overrideOptions).not.toHaveProperty("cache");
    expect(result.update.effectiveOptions).not.toHaveProperty("cache");
    expect(await waitForPersistedTerminal(storePath, result.runId)).toBe(true);

    let updatedRunnerPid: number | undefined;
    const updatedStore = await WorkflowStore.open(storePath);
    try {
      expect(updatedStore.getRun(previousRunId)?.status).toBe("stopped");
      const updatedRun = updatedStore.getRun(result.runId);
      expect(updatedRun).toEqual(expect.objectContaining({ status: expect.any(String) }));
      if (!isValidPid(updatedRun?.runnerPid)) {
        throw new Error(`updated workflow run did not persist a valid runner pid: ${result.runId}`);
      }
      updatedRunnerPid = updatedRun.runnerPid;
      expect(updatedStore.getRunSnapshot(result.runId)?.options).toMatchObject({
        mockOutput: mockOutputPath,
        maxConcurrentTasks: 1,
        maxWallMs: 40_000,
        taskNoProgressMs: 25_000,
        maxTasks: 3,
        maxCostUsd: 0.75,
        maxPromptBytes: 16_384,
      });
      expect(updatedStore.getRunSnapshot(result.runId)?.options).not.toHaveProperty("cache");
    } finally {
      updatedStore.close();
    }
    if (!isValidPid(updatedRunnerPid)) {
      throw new Error(`updated workflow run lost its runner pid: ${result.runId}`);
    }
    expect(await pollUntil(() => !isProcessGroupAlive(updatedRunnerPid))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume (allowTerminalPreviousRun) starts a fresh run from an already-terminal previous run", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-controls-resume-"));
  try {
    const workflowPath = join(root, "resume.workflow.ts");
    const mockOutputPath = join(root, "mock-output.json");
    const storePath = join(root, "workflows.sqlite");
    await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

const Output = Schema.Struct({ summary: Schema.String });

export default defineWorkflow({
  name: "resume-control-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Build after resume.",
    output: Output,
  })],
});
`);
    await writeFile(mockOutputPath, `${JSON.stringify({ build: { summary: "resumed" } })}\n`);
    await mkdir(join(root, ".prism"), { recursive: true });

    const store = await WorkflowStore.open(storePath);
    const previousRunId = store.createRun("resume-control-smoke");
    store.recordRunSnapshot({
      runId: previousRunId,
      workflowFile: workflowPath,
      options: {
        cache: false,
        mockOutput: mockOutputPath,
        maxConcurrentTasks: 1,
        maxWallMs: 30_000,
        taskNoProgressMs: 20_000,
        maxTasks: 2,
        maxCostUsd: 1.25,
        maxPromptBytes: 8_192,
      },
    });
    // Move the previous run to a terminal status before resuming — the exact
    // case `update` rejects and `resume` must tolerate.
    store.stopRunningRun(previousRunId, "test-setup");
    expect(store.getRun(previousRunId)?.status).toBe("stopped");
    store.close();

    const resume = await runCli(root, [
      "workflow",
      "runs",
      "resume",
      previousRunId,
      workflowPath,
      "--store",
      storePath,
    ], { PRISM_HOME: join(root, "prism-home") });
    expect(resume.exitCode).toBe(0);
    expect(resume.stderr).toBe("");
    const result = JSON.parse(resume.stdout) as WorkflowUpdateResult;
    expect(result.update.inheritedOptions).not.toHaveProperty("cache");
    expect(result.update.overrideOptions).not.toHaveProperty("cache");
    expect(result.update.effectiveOptions).not.toHaveProperty("cache");
    expect(await waitForPersistedTerminal(storePath, result.runId)).toBe(true);

    let resumedRunnerPid: number | undefined;
    const updatedStore = await WorkflowStore.open(storePath);
    try {
      // The previous run stays exactly as it was (already terminal) — resume never re-stops it.
      expect(updatedStore.getRun(previousRunId)?.status).toBe("stopped");
      const resumedRun = updatedStore.getRun(result.runId);
      expect(resumedRun).toEqual(expect.objectContaining({ status: expect.any(String) }));
      if (!isValidPid(resumedRun?.runnerPid)) {
        throw new Error(`resumed workflow run did not persist a valid runner pid: ${result.runId}`);
      }
      resumedRunnerPid = resumedRun.runnerPid;
      expect(updatedStore.getRunSnapshot(result.runId)?.options).toMatchObject({
        mockOutput: mockOutputPath,
        maxConcurrentTasks: 1,
        maxWallMs: 30_000,
        taskNoProgressMs: 20_000,
        maxTasks: 2,
        maxCostUsd: 1.25,
        maxPromptBytes: 8_192,
      });
      expect(updatedStore.getRunSnapshot(result.runId)?.options).not.toHaveProperty("cache");
      const events = updatedStore.listRunEvents(result.runId);
      expect(events.some((event) => event.type === "run.updated_from")).toBe(true);
    } finally {
      updatedStore.close();
    }
    if (!isValidPid(resumedRunnerPid)) {
      throw new Error(`resumed workflow run lost its runner pid: ${result.runId}`);
    }
    expect(await pollUntil(() => !isProcessGroupAlive(resumedRunnerPid))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update (without allowTerminalPreviousRun) still rejects a previous run that is already terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-controls-reject-"));
  try {
    const workflowPath = join(root, "reject.workflow.ts");
    const storePath = join(root, "workflows.sqlite");
    await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

const Output = Schema.Struct({ summary: Schema.String });

export default defineWorkflow({
  name: "reject-control-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Never runs.",
    output: Output,
  })],
});
`);
    await mkdir(join(root, ".prism"), { recursive: true });

    const store = await WorkflowStore.open(storePath);
    const previousRunId = store.createRun("reject-control-smoke");
    store.stopRunningRun(previousRunId, "test-setup");
    store.close();

    await expect(
      updateDetachedWorkflowRun({ runId: previousRunId, file: workflowPath, storePath, options: {} }),
    ).rejects.toThrow("workflow run is not running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop returns only after the detached runner and inherited-stdio worker tree are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-stop-tree-"));
  const workflowPath = join(root, "stop-tree.workflow.ts");
  const storePath = join(root, "workflows.sqlite");
  const markerPath = join(root, "worker-tree.json");
  let runnerPid: number | undefined;
  let marker: WorkerTreeMarker | undefined;
  try {
    await writeFile(workflowPath, workerWorkflowSource("stop-tree"));
    const workerPath = await writeHangingWorkerTree({ root, markerPath });
    const detachedResult = await runCli(
      root,
      ["workflow", "run", workflowPath, "--detach", "--store", storePath, "--worker", "grok"],
      { HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: workerPath },
    );
    expect(detachedResult).toMatchObject({ exitCode: 0, stderr: "" });
    const runId = parseCliRunId(detachedResult.stdout);
    runnerPid = await readPersistedRunnerPid(storePath, runId);
    expect(isProcessGroupAlive(runnerPid)).toBe(true);
    expect(await pollUntil(() => Bun.file(markerPath).exists())).toBe(true);
    marker = await readWorkerTreeMarker(markerPath);
    expect(treePids(runnerPid, marker).every(isPidAlive)).toBe(true);

    const stopped = await runCli(
      root,
      ["workflow", "runs", "stop", runId, "--store", storePath],
      { HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: workerPath },
    );

    expect(stopped).toMatchObject({ exitCode: 0, stderr: "" });
    expect(treePids(runnerPid, marker).every((pid) => !isPidAlive(pid))).toBe(true);
    expect(isProcessGroupAlive(runnerPid)).toBe(false);
    const store = await WorkflowStore.open(storePath);
    const run = store.getRun(runId);
    const events = store.listRunEvents(runId);
    store.close();
    expect(run).toMatchObject({
      status: "stopped",
      runnerPid,
      terminalCause: { kind: "stopped", reason: "stop-requested" },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "runner.termination_requested",
      payload: expect.objectContaining({ reason: "stop-requested", signal: "SIGTERM" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "runner.termination_confirmed",
      payload: expect.objectContaining({ reason: "stop-requested", runnerPid }),
    }));
  } finally {
    await cleanupProcessTree(runnerPid, marker);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

for (const signal of ["SIGINT", "SIGHUP"] as const) {
  test(`${signal} aborts a detached run, closes its store, and leaves no descendants`, async () => {
    const root = await mkdtemp(join(tmpdir(), `prism-workflow-${signal.toLowerCase()}-`));
    const workflowPath = join(root, `${signal.toLowerCase()}.workflow.ts`);
    const storePath = join(root, "workflows.sqlite");
    const markerPath = join(root, "worker-tree.json");
    const releasePath = join(root, "release-worker-tree");
    const terminationMarkerPath = join(root, "worker-termination.log");
    let runnerPid: number | undefined;
    let marker: WorkerTreeMarker | undefined;
    try {
      await writeFile(workflowPath, workerWorkflowSource(`signal-${signal.toLowerCase()}`));
      const workerPath = await writeHangingWorkerTree({
        root,
        markerPath,
        releasePath,
        terminationMarkerPath,
      });
      const detachedResult = await runCli(
        root,
        ["workflow", "run", workflowPath, "--detach", "--store", storePath, "--worker", "grok"],
        { HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: workerPath },
      );
      expect(detachedResult).toMatchObject({ exitCode: 0, stderr: "" });
      const runId = parseCliRunId(detachedResult.stdout);
      runnerPid = await readPersistedRunnerPid(storePath, runId);
      expect(await pollUntil(() => Bun.file(markerPath).exists())).toBe(true);
      marker = await readWorkerTreeMarker(markerPath);
      expect(treePids(runnerPid, marker).every(isPidAlive)).toBe(true);
      expect(await pollUntil(async () => {
        if (!(await Bun.file(terminationMarkerPath).exists())) return false;
        const content = await Bun.file(terminationMarkerPath).text();
        return ["worker:ready", "guard:ready", "grandchild:ready"]
          .every((entry) => content.includes(entry));
      })).toBe(true);

      process.kill(runnerPid, signal);

      expect(await pollUntil(async () => {
        if (!(await Bun.file(terminationMarkerPath).exists())) return false;
        const content = await Bun.file(terminationMarkerPath).text();
        return ["worker:SIGTERM", "guard:SIGTERM", "grandchild:SIGTERM"]
          .every((entry) => content.includes(entry));
      })).toBe(true);
      // The workload deliberately remains alive until release. The CLI must
      // therefore remain the process guard's owner instead of exiting as soon
      // as its run-scoped abort race rejects. HEAD before the fix exited here
      // while the orphaned guard continued cleanup in the background.
      await delay(500);
      expect(isPidAlive(runnerPid)).toBe(true);
      expect(isProcessGroupAlive(runnerPid)).toBe(true);

      await writeFile(releasePath, "release");
      expect(await pollUntil(() => treePids(runnerPid!, marker!).every((pid) => !isPidAlive(pid)))).toBe(true);
      expect(await pollUntil(() => !isProcessGroupAlive(runnerPid!))).toBe(true);
      const reopened = await WorkflowStore.open(storePath);
      try {
        const run = reopened.getRun(runId);
        const events = reopened.listRunEvents(runId);
        expect(run).toMatchObject({
          status: "stopped",
          runnerPid,
          terminalCause: { kind: "stopped", reason: signal },
        });
        expect(events).toContainEqual(expect.objectContaining({
          type: "runner.termination_signal.received",
          payload: { signal },
        }));
        reopened.recordEvent({ runId, type: "test.store_reopened", payload: { signal } });
      } finally {
        reopened.close();
      }

      const reopenedAgain = await WorkflowStore.open(storePath);
      try {
        expect(reopenedAgain.listRunEvents(runId)).toContainEqual(expect.objectContaining({
          type: "test.store_reopened",
          payload: { signal },
        }));
      } finally {
        reopenedAgain.close();
      }
    } finally {
      await writeFile(releasePath, "release").catch(() => undefined);
      await cleanupProcessTree(runnerPid, marker);
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
}

test("update starts the replacement worker only after the old process group is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-update-order-"));
  const workflowPath = join(root, "update-order.workflow.ts");
  const storePath = join(root, "workflows.sqlite");
  const oldMarkerPath = join(root, "old-worker-tree.json");
  const releasePath = join(root, "release-old-tree");
  const newStartPath = join(root, "new-worker-start.json");
  let oldRunnerPid: number | undefined;
  let oldMarker: WorkerTreeMarker | undefined;
  let newRunnerPid: number | undefined;
  try {
    await writeFile(workflowPath, workerWorkflowSource("update-order"));
    const oldWorkerPath = await writeHangingWorkerTree({
      root,
      markerPath: oldMarkerPath,
      releasePath,
    });
    const detachedResult = await runCli(
      root,
      ["workflow", "run", workflowPath, "--detach", "--store", storePath, "--worker", "grok"],
      { HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: oldWorkerPath },
    );
    expect(detachedResult).toMatchObject({ exitCode: 0, stderr: "" });
    const oldRunId = parseCliRunId(detachedResult.stdout);
    oldRunnerPid = await readPersistedRunnerPid(storePath, oldRunId);
    expect(await pollUntil(() => Bun.file(oldMarkerPath).exists())).toBe(true);
    oldMarker = await readWorkerTreeMarker(oldMarkerPath);
    const oldPids = treePids(oldRunnerPid, oldMarker);
    expect(oldPids.every(isPidAlive)).toBe(true);

    const newWorkerPath = join(root, "replacement-worker.mjs");
    await writeFile(newWorkerPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `const oldPids = ${JSON.stringify(oldPids)};`,
      "const alive = (pid) => {",
      "  try { process.kill(pid, 0); return true; }",
      "  catch (error) { if (error?.code === 'ESRCH') return false; throw error; }",
      "};",
      `writeFileSync(${JSON.stringify(newStartPath)}, JSON.stringify({ oldPidsAlive: oldPids.filter(alive) }));`,
      "console.log(JSON.stringify({ summary: 'replacement-started' }));",
      "",
    ].join("\n"));
    await chmod(newWorkerPath, 0o755);

    const updateProcess = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "runs",
        "update",
        oldRunId,
        workflowPath,
        "--store",
        storePath,
        "--worker",
        "grok",
      ],
      cwd: root,
      env: workflowTestEnv({ HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: newWorkerPath }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const replacementStartedWithinGrace = await pollUntil(() => Bun.file(newStartPath).exists(), 500);
    const oldPidsAliveWithinGrace = oldPids.every(isPidAlive);
    const oldGroupAliveWithinGrace = isProcessGroupAlive(oldRunnerPid);
    const [updateExitCode, updateStdout, updateStderr] = await Promise.all([
      updateProcess.exited,
      new Response(updateProcess.stdout).text(),
      new Response(updateProcess.stderr).text(),
    ]);
    expect({ exitCode: updateExitCode, stderr: updateStderr }).toEqual({ exitCode: 0, stderr: "" });
    const newRunId = parseCliRunId(updateStdout);
    expect(await pollUntil(() => Bun.file(newStartPath).exists())).toBe(true);
    const newStartValue: unknown = JSON.parse(await Bun.file(newStartPath).text());
    if (
      newStartValue === null ||
      typeof newStartValue !== "object" ||
      !("oldPidsAlive" in newStartValue) ||
      !Array.isArray(newStartValue.oldPidsAlive) ||
      !newStartValue.oldPidsAlive.every(isValidPid)
    ) {
      throw new Error("replacement worker wrote an invalid start marker");
    }
    const updateStore = await WorkflowStore.open(storePath);
    const newRun = updateStore.getRun(newRunId);
    const oldEvents = updateStore.listRunEvents(oldRunId);
    updateStore.close();
    newRunnerPid = newRun?.runnerPid;

    expect(replacementStartedWithinGrace).toBe(false);
    expect(oldPidsAliveWithinGrace).toBe(true);
    expect(oldGroupAliveWithinGrace).toBe(true);
    expect(newStartValue.oldPidsAlive).toEqual([]);
    expect(oldPids.every((pid) => !isPidAlive(pid))).toBe(true);
    expect(isProcessGroupAlive(oldRunnerPid)).toBe(false);
    expect(oldEvents).toContainEqual(expect.objectContaining({
      type: "runner.termination_confirmed",
      payload: expect.objectContaining({ reason: "update-requested", runnerPid: oldRunnerPid }),
    }));
  } finally {
    await writeFile(releasePath, "release").catch(() => undefined);
    await cleanupProcessTree(newRunnerPid, undefined);
    await cleanupProcessTree(oldRunnerPid, oldMarker);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);


// --- OBS-003: detached-runner crash-evidence capture ---------------------

/** Polls for content to land in a file — the runner log is written by an
 * independently-scheduled child process, so it arrives asynchronously. */
const waitForFileContent = async (
  path: string,
  predicate: (content: string) => boolean,
  timeoutMs = 15_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) {
      const content = await Bun.file(path).text();
      if (predicate(content)) return content;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for expected content in ${path}`);
};

test("workflowRunnerLogPath is deterministic from runId + storePath and lives beside the store (OBS-003)", () => {
  const storePath = join("some", "project", "workflows.sqlite");
  expect(workflowRunnerLogDir(storePath)).toBe(join(process.cwd(), "some", "project", "runner-logs"));
  expect(workflowRunnerLogPath(storePath, "abc-123")).toBe(
    join(process.cwd(), "some", "project", "runner-logs", "abc-123.log"),
  );
});

test("workflowRunnerLogPathIfPresent is silent for foreground runs and missing files (OBS-003)", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-runner-log-presence-"));
  try {
    const storePath = join(root, "workflows.sqlite");
    expect(workflowRunnerLogPathIfPresent(storePath, { runId: "r1" })).toBeUndefined();
    expect(workflowRunnerLogPathIfPresent(storePath, { runId: "r1", runnerPid: 4242 })).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a detached runner's pre-readiness failure output lands in the runner log (OBS-003)", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-crash-evidence-"));
  try {
    const storePath = join(root, "workflows.sqlite");
    const store = await WorkflowStore.open(storePath);
    try {
      const runId = store.createRun("crash-evidence");
      const missingWorkflow = join(root, "does-not-exist.workflow.ts");
      // The child CLI fails while loading the workflow file; whatever it manages
      // to print is the only evidence of WHY — the capture file must hold it.
      await startDetachedWorkflowRun(store, missingWorkflow, {}, { runId, storePath, token: "tok" }).catch(
        () => undefined,
      );
      const logPath = workflowRunnerLogPath(storePath, runId);
      const content = await waitForFileContent(logPath, (c) => c.trim().length > 0);
      expect(content.trim().length).toBeGreaterThan(0);
      expect((await stat(logPath)).mode & 0o777).toBe(0o600);
      expect((await stat(workflowRunnerLogDir(storePath))).mode & 0o777).toBe(0o700);
      expect(workflowRunnerLogPathIfPresent(storePath, { runId, runnerPid: 4242 })).toBe(logPath);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
