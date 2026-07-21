import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { WORKFLOW_REDACTION_MARKER, WORKFLOW_SECRET_DIGEST_PREFIX } from "./workflow-data-policy.js";
import { workflowRunnerLogDir, workflowRunnerLogPath } from "./workflow-runner-log.js";
import { runWorkflow } from "./workflow-runner.js";
import { WORKFLOW_STORE_SCHEMA_VERSION, WorkflowStore } from "./workflow-store.js";
import { defineTask, defineWorkflow } from "./workflows.js";

const roots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-governance-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const identity = (taskId: string, cacheKey: string = `${taskId}-cache`) => ({
  workflow: "governance-workflow",
  taskId,
  cacheKey,
  promptHash: "a".repeat(64),
  agentManifestHash: "b".repeat(64),
});

const taskSnapshot = (runId: string, taskId: string = "build", ordinal: number = 0) => ({
  runId,
  ordinal,
  taskId,
  prompt: "Build with password=prompt-secret",
  cacheKey: `${taskId}-cache`,
  promptHash: "a".repeat(64),
  agentManifestHash: "b".repeat(64),
  agent: {
    plugin: "forge",
    name: "builder",
    description: "Bearer abcdefghijklmnop",
    sourceHash: "c".repeat(64),
    manifestHash: "b".repeat(64),
  },
  finishCriteria: ["do not expose api_key=finish-secret"],
});

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const exitedPid = async (): Promise<number> => {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", ""],
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = child.pid;
  await child.exited;
  return pid;
};

describe("workflow store data governance", () => {
  test("keeps secret-bearing live results unchanged while skipping replay cache writes with a content-free event", async () => {
    const root = await tempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"), { applyDefaultRetention: false });
    const task = defineTask({
      id: "secret-result",
      agent: {
        kind: "agent-ref",
        plugin: "forge",
        name: "builder",
        description: "Build specialist",
        sourceHash: "a".repeat(64),
        manifestHash: "b".repeat(64),
        installs: ["codex-cli"],
      },
      prompt: "Return the result.",
      output: Schema.Struct({ summary: Schema.String, accessToken: Schema.String }),
      cacheKey: "secret-result-cache",
    });
    const workflow = defineWorkflow({ name: "secret-result", tasks: [task] as const });
    let executions = 0;
    const executeTask = async () => {
      executions += 1;
      return { summary: "usable live result", accessToken: "live-result-secret" };
    };

    const first = await runWorkflow(workflow, { store, executeTask });
    const second = await runWorkflow(workflow, { store, executeTask });
    expect(first.tasks[0]?.output).toEqual({ summary: "usable live result", accessToken: "live-result-secret" });
    expect(second.tasks[0]?.cached).toBe(false);
    expect(executions).toBe(2);
    expect(store.listCompletedCache()).toEqual([]);
    const skipped = store.listRunEvents(first.runId!).find(
      (event) => event.type === "task.cache_write.skipped_sensitive",
    );
    expect(skipped?.payload).toMatchObject({ cacheKey: "secret-result-cache", findingCount: 1 });
    expect(JSON.stringify(skipped)).not.toContain("live-result-secret");
    expect(JSON.stringify(skipped)).not.toContain("accessToken");
    store.close();
  });

  test("inspects and persists one normalized cache value without a second toJSON call", async () => {
    const root = await tempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"), { applyDefaultRetention: false });
    let calls = 0;
    const output = {
      toJSON() {
        calls += 1;
        return calls === 1
          ? { summary: "stable serialized result" }
          : { accessToken: "second-call-secret" };
      },
    };

    expect(store.recordCompleted({
      identity: identity("single-serialization"),
      agent: { plugin: "forge", name: "builder" },
      output,
    })).toEqual({ stored: true });
    expect(calls).toBe(1);
    expect(store.getCompleted(identity("single-serialization"))?.output).toEqual({
      summary: "stable serialized result",
    });
    expect(JSON.stringify(store.listCompletedCache())).not.toContain("second-call-secret");
    store.close();
  });

  test("redacts durable evidence, preserves continuation provenance, hashes handoff secrets, and skips unsafe caches", async () => {
    const root = await tempRoot();
    const path = join(root, "workflows.sqlite");
    const store = await WorkflowStore.open(path, { applyDefaultRetention: false });
    const runId = store.createRun("governance-workflow");

    store.recordRunSnapshot({
      runId,
      workflowFile: "/tmp/password=workflow-secret.workflow.ts",
      options: { authorization: "Bearer abcdefghijklmnop" },
    });
    store.recordRunTaskSnapshot(taskSnapshot(runId));
    store.recordTaskAttemptStarted({
      runId,
      ordinal: 0,
      attempt: 1,
      taskId: "build",
      metadata: {
        adapter: "codex-cli",
        sessionId: "sk-session-shaped-continuation-id",
        accessToken: "attempt-secret",
      },
    });
    store.recordTaskAttemptFinished({
      runId,
      ordinal: 0,
      attempt: 1,
      status: "failed",
      failure: { kind: "executor", message: "Bearer abcdefghijklmnop" },
      metadata: {
        adapter: "codex-cli",
        sessionId: "sk-session-shaped-continuation-id",
        apiKey: "attempt-finish-secret",
      },
    });
    store.recordRunTask({
      runId,
      ordinal: 0,
      identity: identity("build"),
      agent: { plugin: "forge", name: "builder" },
      status: "failed",
      cached: false,
      output: { accessToken: "output-secret" },
      metadata: { password: "metadata-secret" },
    });
    store.recordEvent({
      runId,
      taskId: "build",
      type: "custom.evidence",
      payload: {
        privateKey: "private-key-secret",
        detail: "api_key=event-secret",
        serialized: {
          toJSON: () => ({ password: "custom-event-secret" }),
        },
      },
    });
    store.recordSpanStart({
      runId,
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      parentSpanId: null,
      taskId: "build",
      name: "task",
      kind: "internal",
      startNs: 1n,
      endNs: null,
      status: "unset",
      errorMessage: null,
      attributes: { authorization: "Bearer abcdefghijklmnop" },
    });
    store.recordSpanEnd({
      spanId: "2".repeat(16),
      endNs: 2n,
      status: "error",
      errorMessage: "password=span-secret",
      attributes: { clientSecret: "span-attribute-secret" },
    });
    store.setRunHandoffToken(runId, "plaintext-handoff-secret");

    expect(store.recordCompleted({
      identity: identity("unsafe"),
      agent: { plugin: "forge", name: "builder" },
      output: { accessToken: "cache-secret" },
    })).toMatchObject({ stored: false, reason: "sensitive-data" });
    expect(store.getCompleted(identity("unsafe"))).toBeNull();
    expect(store.recordCompleted({
      identity: identity("safe"),
      agent: { plugin: "forge", name: "builder" },
      output: { summary: "safe" },
      metadata: { sessionId: "sk-safe-continuation-id" },
    })).toEqual({ stored: true });
    expect(store.recordJudge({
      identity: {
        workflow: "governance-workflow",
        taskId: "build",
        taskCacheKey: "build-cache",
        criterion: "quality",
        cacheKey: "judge-unsafe",
      },
      verdict: { verdict: "pass", metadata: { apiKey: "judge-secret" } },
      evidence: { ok: true },
      output: { summary: "safe" },
      taskMetadata: { id: "build" },
    })).toMatchObject({ stored: false, reason: "sensitive-data" });
    expect(store.getJudgeRecord({
      workflow: "governance-workflow",
      taskId: "build",
      taskCacheKey: "build-cache",
      criterion: "quality",
      cacheKey: "judge-unsafe",
    })).toBeNull();

    const raw = new Database(path);
    const handoff = raw.query<{ readonly handoff_token: string }, [string]>(
      "select handoff_token from workflow_runs where run_id = ?",
    ).get(runId)?.handoff_token;
    raw.close();
    expect(handoff?.startsWith(WORKFLOW_SECRET_DIGEST_PREFIX)).toBe(true);
    expect(handoff).not.toContain("plaintext-handoff-secret");
    expect(store.consumeRunHandoffToken(runId, "plaintext-handoff-secret")).toBe(true);

    store.finishRun(runId, "failed", {
      kind: "workflow-failed",
      errorName: "Error",
      message: "Bearer abcdefghijklmnop",
    });
    const exported = await store.exportRun(runId);
    const serialized = JSON.stringify(exported);
    for (const secret of [
      "prompt-secret",
      "workflow-secret",
      "attempt-secret",
      "attempt-finish-secret",
      "output-secret",
      "metadata-secret",
      "event-secret",
      "custom-event-secret",
      "span-secret",
      "span-attribute-secret",
      "abcdefghijklmnop",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain(WORKFLOW_REDACTION_MARKER);
    expect(serialized).toContain("sk-session-shaped-continuation-id");
    expect(exported.attempts[0]?.sessionId).toBe("sk-session-shaped-continuation-id");

    const inspection = await store.inspectRun(runId);
    expect(inspection.rows).toMatchObject({ runs: 1, tasks: 1, attempts: 1, runSnapshots: 1, taskSnapshots: 1 });
    for (const file of inspection.store.files.filter((candidate) => candidate.present)) {
      expect(file.mode).toBe(0o600);
    }
    store.close();
  });

  test("migrates version 4 evidence through the policy and removes unsafe legacy caches without changing session ids", async () => {
    const root = await tempRoot();
    const path = join(root, "workflows.sqlite");
    const store = await WorkflowStore.open(path, { applyDefaultRetention: false });
    const runId = store.createRun("legacy-policy");
    store.recordTaskAttemptStarted({
      runId,
      ordinal: 0,
      attempt: 1,
      taskId: "build",
      metadata: { sessionId: "legacy-session-id" },
    });
    store.recordTaskAttemptFinished({ runId, ordinal: 0, attempt: 1, status: "completed" });
    store.recordCompleted({
      identity: identity("legacy-cache"),
      agent: { plugin: "forge", name: "builder" },
      output: { summary: "safe-before-corruption" },
    });
    store.recordJudge({
      identity: {
        workflow: "governance-workflow",
        taskId: "build",
        taskCacheKey: "build-cache",
        criterion: "quality",
        cacheKey: "legacy-judge",
      },
      verdict: { verdict: "pass" },
      evidence: { ok: true },
      output: { summary: "safe" },
      taskMetadata: { id: "build" },
    });
    store.finishRun(runId, "completed");
    store.close();

    const legacy = new Database(path);
    legacy.exec(`
      update workflow_task_records set output_json = '{"accessToken":"legacy-cache-secret"}';
      update workflow_judge_records set feedback = 'Bearer abcdefghijklmnop';
      update workflow_runs
      set handoff_token = 'raw-legacy-handoff',
          terminal_cause_json = '{"kind":"completed","password":"legacy-run-secret"}'
      where run_id = '${runId}';
      update workflow_task_attempts
      set metadata_json = '{"sessionId":"legacy-session-id","apiKey":"legacy-attempt-secret"}'
      where run_id = '${runId}';
      update workflow_events
      set payload_json = '{"authorization":"Bearer abcdefghijklmnop"}'
      where run_id = '${runId}';
      pragma user_version = 4;
    `);
    legacy.close();
    await mkdir(workflowRunnerLogDir(path), { recursive: true });
    const logPath = workflowRunnerLogPath(path, runId);
    await writeFile(logPath, "password=legacy-log-secret\n", { mode: 0o644 });
    await chmod(logPath, 0o644);

    const migrated = await WorkflowStore.open(path, { applyDefaultRetention: false });
    expect(migrated.listCompletedCache()).toEqual([]);
    expect(migrated.listJudgeRecords()).toEqual([]);
    expect(migrated.listRunTaskAttempts(runId)[0]).toMatchObject({
      sessionId: "legacy-session-id",
      metadata: { sessionId: "legacy-session-id", apiKey: WORKFLOW_REDACTION_MARKER },
    });
    const evidence = JSON.stringify(await migrated.exportRun(runId));
    expect(evidence).not.toContain("legacy-run-secret");
    expect(evidence).not.toContain("legacy-attempt-secret");
    expect(evidence).not.toContain("abcdefghijklmnop");
    expect(await readFile(logPath, "utf8")).toBe("password=[REDACTED]\n");
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    migrated.close();

    const inspected = new Database(path);
    expect(inspected.query<{ readonly user_version: number }, []>("pragma user_version").get()?.user_version)
      .toBe(WORKFLOW_STORE_SCHEMA_VERSION);
    const digest = inspected.query<{ readonly handoff_token: string }, [string]>(
      "select handoff_token from workflow_runs where run_id = ?",
    ).get(runId)?.handoff_token;
    expect(digest?.startsWith(WORKFLOW_SECRET_DIGEST_PREFIX)).toBe(true);
    expect(digest).not.toContain("raw-legacy-handoff");
    inspected.close();
  });

  test("prunes by age and deletes one run idempotently without touching running runs or unrelated files", async () => {
    const root = await tempRoot();
    const path = join(root, "workflows.sqlite");
    const store = await WorkflowStore.open(path, { applyDefaultRetention: false });
    const oldRun = store.createRun("old-run", "old-run");
    store.recordRunSnapshot({ runId: oldRun, workflowFile: "/tmp/old.workflow.ts" });
    store.recordRunTaskSnapshot(taskSnapshot(oldRun));
    store.recordRunTask({
      runId: oldRun,
      ordinal: 0,
      identity: identity("build"),
      agent: { plugin: "forge", name: "builder" },
      status: "completed",
      cached: false,
      output: { summary: "old" },
    });
    store.finishRun(oldRun, "completed");
    const freshRun = store.createRun("fresh-run", "fresh-run");
    store.finishRun(freshRun, "completed");
    const runningRun = store.createRun("running-run", "running-run");
    store.recordCompleted({
      identity: identity("old-cache"),
      agent: { plugin: "forge", name: "builder" },
      output: { summary: "old cache" },
    });
    store.recordJudge({
      identity: {
        workflow: "governance-workflow",
        taskId: "build",
        taskCacheKey: "build-cache",
        criterion: "quality",
        cacheKey: "old-judge",
      },
      verdict: { verdict: "pass" },
      evidence: { ok: true },
      output: { summary: "safe" },
      taskMetadata: { id: "build" },
    });

    await mkdir(workflowRunnerLogDir(path), { recursive: true });
    await Promise.all([
      writeFile(workflowRunnerLogPath(path, oldRun), "old"),
      writeFile(workflowRunnerLogPath(path, freshRun), "fresh"),
      writeFile(workflowRunnerLogPath(path, runningRun), "running"),
      writeFile(join(root, "user-owned.txt"), "keep"),
    ]);
    const raw = new Database(path);
    raw.exec(`
      update workflow_runs set created_at = '2000-01-01 00:00:00', finished_at = '2000-01-01 00:00:00'
      where run_id = 'old-run';
      update workflow_task_records set updated_at = '2000-01-01 00:00:00';
      update workflow_judge_records set updated_at = '2000-01-01 00:00:00';
    `);
    raw.close();

    const first = await store.pruneByAge({ olderThanMs: 30 * 24 * 60 * 60 * 1_000 });
    expect(first.runs).toMatchObject({ matched: 1, deleted: 1 });
    expect(first.runs.rows).toMatchObject({ runs: 1, tasks: 1, events: 3, runSnapshots: 1, taskSnapshots: 1 });
    expect(first.caches).toEqual({ taskCache: 1, judgeCache: 1 });
    expect(first.runnerLogs.deleted).toBe(1);
    expect(store.getRun(oldRun)).toBeNull();
    expect(store.getRun(freshRun)?.status).toBe("completed");
    expect(store.getRun(runningRun)?.status).toBe("running");
    expect(await fileExists(workflowRunnerLogPath(path, oldRun))).toBe(false);
    expect(await readFile(workflowRunnerLogPath(path, freshRun), "utf8")).toBe("fresh");
    expect(await readFile(workflowRunnerLogPath(path, runningRun), "utf8")).toBe("running");
    expect(await readFile(join(root, "user-owned.txt"), "utf8")).toBe("keep");

    const repeated = await store.pruneByAge({ olderThanMs: 30 * 24 * 60 * 60 * 1_000 });
    expect(repeated.runs).toMatchObject({ matched: 0, deleted: 0 });
    expect(repeated.caches).toEqual({ taskCache: 0, judgeCache: 0 });

    const deleted = await store.deleteRun(freshRun);
    expect(deleted).toMatchObject({ runId: freshRun, status: "deleted", rows: { runs: 1 } });
    expect(deleted.runnerLog.status).toBe("deleted");
    expect((await store.deleteRun(freshRun)).status).toBe("missing");
    await expect(store.deleteRun(runningRun)).rejects.toThrow("stop it before deletion");
    expect(await readFile(workflowRunnerLogPath(path, runningRun), "utf8")).toBe("running");
    expect(await readFile(join(root, "user-owned.txt"), "utf8")).toBe("keep");
    store.close();
  });

  test("applies the default retention window on open and reports the cleanup", async () => {
    const root = await tempRoot();
    const path = join(root, "workflows.sqlite");
    const store = await WorkflowStore.open(path, { applyDefaultRetention: false });
    const runId = store.createRun("expired", "expired");
    store.finishRun(runId, "completed");
    store.close();
    const raw = new Database(path);
    raw.exec(`
      update workflow_runs set created_at = '2000-01-01 00:00:00', finished_at = '2000-01-01 00:00:00'
      where run_id = 'expired';
    `);
    raw.close();

    const reopened = await WorkflowStore.open(path);
    expect(reopened.getRun(runId)).toBeNull();
    expect(reopened.initialRetentionCleanup?.runs).toMatchObject({ matched: 1, deleted: 1 });
    reopened.close();
  });

  test("reconciles a hard-killed runner's raw sidecar on the next observer open and drains queued orphan cleanup", async () => {
    const root = await tempRoot();
    const path = join(root, "workflows.sqlite");
    const store = await WorkflowStore.open(path, { applyDefaultRetention: false });
    const runId = store.createRun("crash-window", "crash-window");
    store.finishRun(runId, "crashed", { kind: "crashed", reason: "sigkill" });
    store.close();
    await mkdir(workflowRunnerLogDir(path), { recursive: true });
    const logPath = workflowRunnerLogPath(path, runId);
    await writeFile(logPath, "Bearer abcdefghijklmnop\n", { mode: 0o644 });
    await chmod(logPath, 0o644);

    const observed = await WorkflowStore.open(path, { applyDefaultRetention: false });
    expect(await readFile(logPath, "utf8")).toBe("Bearer [REDACTED]\n");
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    observed.close();

    await writeFile(logPath, "orphan", { mode: 0o600 });
    const raw = new Database(path);
    raw.exec(`
      insert into workflow_runner_log_cleanup (run_id) values ('${runId}');
      delete from workflow_events where run_id = '${runId}';
      delete from workflow_runs where run_id = '${runId}';
    `);
    raw.close();
    const recovered = await WorkflowStore.open(path, { applyDefaultRetention: false });
    expect(await fileExists(logPath)).toBe(false);
    recovered.close();
  });

  test("does not append runner.started after a run becomes terminal", async () => {
    const root = await tempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"), { applyDefaultRetention: false });
    const runId = store.createRun("late-runner", "late-runner");
    store.finishRun(runId, "stopped", { kind: "stopped", reason: "test-stop" });

    expect(() => store.markRunRunnerStarted(runId, process.pid)).toThrow("already terminal");
    expect(store.listRunEvents(runId).filter((event) => event.type === "runner.started")).toEqual([]);
    store.close();
  });

  test("dead-runner reconciliation emits one stale event across repeated observers", async () => {
    const root = await tempRoot();
    const path = join(root, "workflows.sqlite");
    const pid = await exitedPid();
    const store = await WorkflowStore.open(path, { applyDefaultRetention: false });
    const runId = store.createRun("dead-observer", "dead-observer");
    store.markRunRunnerStarted(runId, pid);
    store.close();

    const first = await WorkflowStore.open(path, { applyDefaultRetention: false });
    expect(first.getRun(runId)?.status).toBe("crashed");
    first.close();
    const second = await WorkflowStore.open(path, { applyDefaultRetention: false });
    const events = second.listRunEvents(runId);
    expect(events.filter((event) => event.type === "run.stale_dead_pid")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.crashed")).toHaveLength(1);
    second.close();
  });

  test("does not rewrite a terminal sidecar while its persisted runner pid is alive", async () => {
    const root = await tempRoot();
    const path = join(root, "workflows.sqlite");
    const runId = "terminal-live-runner";
    const store = await WorkflowStore.open(path, { applyDefaultRetention: false });
    store.createRun("terminal-live-runner", runId);
    store.markRunRunnerStarted(runId, process.pid);
    store.finishRun(runId, "stopped", { kind: "stopped", reason: "stop-before-reap" });
    store.close();
    await mkdir(workflowRunnerLogDir(path), { recursive: true });
    const logPath = workflowRunnerLogPath(path, runId);
    await writeFile(logPath, "password=still-being-written\n", { mode: 0o600 });

    const whileAlive = await WorkflowStore.open(path, { applyDefaultRetention: false });
    expect(await readFile(logPath, "utf8")).toBe("password=still-being-written\n");
    await expect(whileAlive.deleteRun(runId)).rejects.toThrow("still has live runner pid");
    const skipped = await whileAlive.pruneByAge({
      olderThanMs: 1,
      now: new Date(Date.now() + 60_000),
    });
    expect(skipped.runs).toMatchObject({ matched: 1, deleted: 0 });
    expect(await readFile(logPath, "utf8")).toBe("password=still-being-written\n");
    whileAlive.close();

    const deadRunnerPid = await exitedPid();
    const raw = new Database(path);
    raw.query("update workflow_runs set runner_pid = ? where run_id = ?").run(deadRunnerPid, runId);
    raw.close();
    const afterReap = await WorkflowStore.open(path, { applyDefaultRetention: false });
    expect(await readFile(logPath, "utf8")).toBe("password=[REDACTED]\n");
    afterReap.close();
  });
});
