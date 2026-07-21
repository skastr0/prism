import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowRunnerLogDir, workflowRunnerLogPath } from "./workflow-runner-log.js";
import { WorkflowStore } from "./workflow-store.js";

const repoRoot = process.cwd();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-governance-cli-"));
  roots.push(root);
  return root;
};

const runCli = async (
  args: ReadonlyArray<string>,
  prismHome: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", join(repoRoot, "src", "cli.ts"), ...args],
    cwd: repoRoot,
    env: { ...process.env, PRISM_HOME: prismHome },
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

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

test("workflow run governance CLI inspects, redacts exports, deletes exactly, and prunes by age", async () => {
  const root = await tempRoot();
  const prismHome = join(root, "prism-home");
  const storePath = join(root, "workflows.sqlite");
  const exportPath = join(root, "exports", "run.json");
  const unrelated = join(root, "user-owned.txt");
  const store = await WorkflowStore.open(storePath, { applyDefaultRetention: false });
  const runId = store.createRun("governance-cli", "governance-cli");
  store.recordTaskAttemptStarted({
    runId,
    ordinal: 0,
    attempt: 1,
    taskId: "build",
    metadata: { sessionId: "cli-session-id", apiKey: "cli-attempt-secret" },
  });
  store.recordTaskAttemptFinished({ runId, ordinal: 0, attempt: 1, status: "completed" });
  store.recordEvent({
    runId,
    type: "cli.secret-evidence",
    payload: { authorization: "Bearer abcdefghijklmnop" },
  });
  store.finishRun(runId, "completed");
  const runningRun = store.createRun("running-cli", "running-cli");
  store.close();
  await mkdir(workflowRunnerLogDir(storePath), { recursive: true });
  const runLog = workflowRunnerLogPath(storePath, runId);
  await writeFile(runLog, "password=cli-log-secret\n");
  await writeFile(unrelated, "keep");

  for (const verb of ["inspect", "export", "delete", "prune"]) {
    const help = await runCli(["workflow", "runs", verb, "--help"], prismHome);
    expect(help.exitCode).toBe(0);
  }

  const inspected = await runCli(
    ["workflow", "runs", "inspect", runId, "--store", storePath],
    prismHome,
  );
  expect(inspected.exitCode).toBe(0);
  expect(JSON.parse(inspected.stdout)).toMatchObject({
    schema: "prism.workflow-run-inspection.v1",
    run: { runId, status: "completed" },
    rows: { runs: 1, attempts: 1 },
    runnerLog: { present: true },
  });

  const stdoutExport = await runCli(
    ["workflow", "runs", "export", runId, "--store", storePath],
    prismHome,
  );
  expect(stdoutExport.exitCode).toBe(0);
  expect(stdoutExport.stdout).toContain("cli-session-id");
  expect(stdoutExport.stdout).toContain("[REDACTED]");
  expect(stdoutExport.stdout).not.toContain("cli-attempt-secret");
  expect(stdoutExport.stdout).not.toContain("abcdefghijklmnop");
  expect(stdoutExport.stdout).not.toContain("cli-log-secret");

  const fileExport = await runCli(
    ["workflow", "runs", "export", runId, "--store", storePath, "--out", exportPath],
    prismHome,
  );
  expect(fileExport.exitCode).toBe(0);
  expect((await stat(exportPath)).mode & 0o777).toBe(0o600);
  expect(await readFile(exportPath, "utf8")).not.toContain("cli-log-secret");

  const runningDelete = await runCli(
    ["workflow", "runs", "delete", runningRun, "--store", storePath],
    prismHome,
  );
  expect(runningDelete.exitCode).not.toBe(0);
  expect(runningDelete.stderr).toContain("stop it before deletion");

  const deleted = await runCli(
    ["workflow", "runs", "delete", runId, "--store", storePath],
    prismHome,
  );
  expect(deleted.exitCode).toBe(0);
  expect(JSON.parse(deleted.stdout)).toMatchObject({ status: "deleted", runnerLog: { status: "deleted" } });
  expect(await exists(runLog)).toBe(false);
  expect(await readFile(unrelated, "utf8")).toBe("keep");
  const repeatedDelete = await runCli(
    ["workflow", "runs", "delete", runId, "--store", storePath],
    prismHome,
  );
  expect(repeatedDelete.exitCode).toBe(0);
  expect(JSON.parse(repeatedDelete.stdout)).toMatchObject({ status: "missing", rows: { runs: 0 } });

  const retentionStore = await WorkflowStore.open(storePath, { applyDefaultRetention: false });
  const oldRun = retentionStore.createRun("old-cli", "old-cli");
  retentionStore.finishRun(oldRun, "completed");
  retentionStore.recordCompleted({
    identity: {
      workflow: "old-cli",
      taskId: "build",
      cacheKey: "build",
      promptHash: "a".repeat(64),
      agentManifestHash: "b".repeat(64),
    },
    agent: { plugin: "forge", name: "builder" },
    output: { summary: "old" },
  });
  retentionStore.close();
  await writeFile(workflowRunnerLogPath(storePath, oldRun), "old log");
  const raw = new Database(storePath);
  raw.exec(`
    update workflow_runs set created_at = '2000-01-01 00:00:00', finished_at = '2000-01-01 00:00:00'
    where run_id = 'old-cli';
    update workflow_task_records set updated_at = '2000-01-01 00:00:00';
  `);
  raw.close();

  const pruned = await runCli(
    ["workflow", "runs", "prune", "--store", storePath, "--older-than", "1d"],
    prismHome,
  );
  expect(pruned.exitCode).toBe(0);
  expect(JSON.parse(pruned.stdout).cleanup).toMatchObject({
    runs: { matched: 1, deleted: 1 },
    caches: { taskCache: 1, judgeCache: 0 },
    runnerLogs: { deleted: 1 },
  });
  expect(await readFile(unrelated, "utf8")).toBe("keep");
  const repeatedPrune = await runCli(
    ["workflow", "runs", "prune", "--store", storePath, "--older-than", "1d"],
    prismHome,
  );
  expect(repeatedPrune.exitCode).toBe(0);
  expect(JSON.parse(repeatedPrune.stdout).cleanup).toMatchObject({
    runs: { matched: 0, deleted: 0 },
    caches: { taskCache: 0, judgeCache: 0 },
  });
}, 30_000);
