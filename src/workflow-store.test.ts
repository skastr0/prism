import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { stableJsonHash } from "@skastr0/prism-core/stable-json";
import { computeContentHash } from "./content-hash.js";
import { runWorkflow, WorkflowRunStoppedError, WorkflowTaskDecodeError, WorkflowTaskEscalatedError } from "./workflow-runner.js";
import { WorkflowStore, workflowTaskIdentity } from "./workflow-store.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";
import { defineTask, defineWorkflow, type WorkflowAgentRef, type WorkflowFinishOptions, type WorkflowWorkerId } from "./workflows.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-store-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const builder = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["grok"],
} as const satisfies WorkflowAgentRef;

const reviewer = {
  ...builder,
  name: "reviewer",
  description: "Review specialist",
} as const satisfies WorkflowAgentRef;

const Output = Schema.Struct({ summary: Schema.String });
const ReviewOutput = Schema.Struct({ verdict: Schema.Literal("pass") });

const contractMetadata = {
  contractVersion: WORKFLOW_WORKER_JSON_CONTRACT_VERSION,
  instructionSource: WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE,
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const deadPid = async (): Promise<number> => {
  const processHandle = Bun.spawn({ cmd: ["sh", "-c", "sleep 30"] });
  const pid = processHandle.pid;
  processHandle.kill("SIGKILL");
  await processHandle.exited;
  return pid;
};

const createWorkflow = (options?: {
  readonly prompt?: string;
  readonly agent?: WorkflowAgentRef;
  readonly worker?: WorkflowWorkerId;
  readonly model?: string;
  readonly finish?: WorkflowFinishOptions<{ summary: string }>;
}) => {
  const build = defineTask({
    id: "build",
    agent: options?.agent ?? builder,
    prompt: options?.prompt ?? "Build the slice.",
    output: Output,
    cacheKey: "builder-cache",
    ...(options?.finish !== undefined ? { finish: options.finish } : {}),
    ...(options?.worker !== undefined || options?.model !== undefined
      ? { worker: { ...(options.worker !== undefined ? { worker: options.worker } : {}), ...(options.model !== undefined ? { model: options.model } : {}) } }
      : {}),
  });
  return defineWorkflow({ name: "store-smoke", tasks: [build] as const });
};

describe("workflow store", () => {
  test("backfills run status when opening a legacy ledger", async () => {
    const root = await createTempRoot();
    const path = join(root, "workflows.sqlite");
    const db = new Database(path);
    db.exec(`
      create table workflow_runs (
        run_id text primary key,
        workflow text not null,
        created_at text not null default (datetime('now'))
      );
      create table workflow_run_tasks (
        run_id text not null,
        ordinal integer not null,
        workflow text not null,
        task_id text not null,
        cache_key text not null,
        prompt_hash text not null,
        agent_manifest_hash text not null,
        agent_plugin text not null,
        agent_name text not null,
        status text not null,
        cached integer not null,
        output_json text not null,
        created_at text not null default (datetime('now')),
        primary key (run_id, ordinal)
      );
      insert into workflow_runs (run_id, workflow) values ('ok-run', 'legacy'), ('bad-run', 'legacy'), ('empty-run', 'legacy');
      insert into workflow_run_tasks (
        run_id, ordinal, workflow, task_id, cache_key, prompt_hash, agent_manifest_hash,
        agent_plugin, agent_name, status, cached, output_json
      ) values
        ('ok-run', 0, 'legacy', 'build', 'build', '${"a".repeat(64)}', '${"b".repeat(64)}', 'forge', 'builder', 'completed', 0, '{"summary":"ok"}'),
        ('bad-run', 0, 'legacy', 'build', 'build', '${"a".repeat(64)}', '${"b".repeat(64)}', 'forge', 'builder', 'failed', 0, '{"summary":"bad"}');
    `);
    db.close();

    const store = await WorkflowStore.open(path);

    expect(store.listRuns()).toEqual([
      { runId: "bad-run", workflow: "legacy", status: "failed", finishedAt: expect.any(String) },
      { runId: "empty-run", workflow: "legacy", status: "unknown", finishedAt: null },
      { runId: "ok-run", workflow: "legacy", status: "unknown", finishedAt: null },
    ]);
    const newRunId = store.createRun("legacy");
    expect(store.listRuns().find((run) => run.runId === newRunId)?.status).toBe("running");
    store.close();
  });

  test("does not backfill active running runs with caught failed task rows", async () => {
    const root = await createTempRoot();
    const path = join(root, "workflows.sqlite");
    const store = await WorkflowStore.open(path);
    const runId = store.createRun("dynamic-review");
    store.recordRunTask({
      runId,
      ordinal: 0,
      identity: {
        workflow: "dynamic-review",
        taskId: "optional-reviewer",
        cacheKey: "optional-reviewer",
        promptHash: "a".repeat(64),
        agentManifestHash: "b".repeat(64),
      },
      agent: { plugin: "forge", name: "reviewer" },
      status: "failed",
      cached: false,
      output: { error: "reviewer setup blocker" },
      metadata: contractMetadata,
    });
    store.close();

    const reopened = await WorkflowStore.open(path);

    expect(reopened.getRun(runId)?.status).toBe("running");
    expect(reopened.listRunTasks(runId)).toEqual([
      expect.objectContaining({
        taskId: "optional-reviewer",
        status: "failed",
        output: { error: "reviewer setup blocker" },
      }),
    ]);
    reopened.close();
  });

  test("backfills unknown runs with failed task rows in current-schema ledgers", async () => {
    const root = await createTempRoot();
    const path = join(root, "workflows.sqlite");
    const store = await WorkflowStore.open(path);
    const runId = store.createRun("legacy-current-schema");
    store.recordRunTask({
      runId,
      ordinal: 0,
      identity: {
        workflow: "legacy-current-schema",
        taskId: "failed-task",
        cacheKey: "failed-task",
        promptHash: "a".repeat(64),
        agentManifestHash: "b".repeat(64),
      },
      agent: { plugin: "forge", name: "reviewer" },
      status: "failed",
      cached: false,
      output: { error: "legacy failure" },
      metadata: contractMetadata,
    });
    store.close();

    const db = new Database(path);
    db.query("update workflow_runs set status = 'unknown' where run_id = ?").run(runId);
    db.close();

    const reopened = await WorkflowStore.open(path);

    expect(reopened.getRun(runId)?.status).toBe("failed");
    reopened.close();
  });

  test("fails stale running runs without touching fresh running runs", async () => {
    const root = await createTempRoot();
    const path = join(root, "workflows.sqlite");
    const store = await WorkflowStore.open(path);
    store.createRun("store-smoke", "old-run");
    store.createRun("store-smoke", "fresh-run");
    store.createRun("store-smoke", "old-with-fresh-heartbeat");
    store.markRunRunnerStarted("old-with-fresh-heartbeat", process.pid);
    store.close();

    const db = new Database(path);
    db.query("update workflow_runs set created_at = ? where run_id = ?")
      .run("2026-01-01 00:00:00", "old-run");
    db.query("update workflow_runs set created_at = ? where run_id = ?")
      .run("2026-01-01 00:00:59", "fresh-run");
    db.query("update workflow_runs set created_at = ?, heartbeat_at = ? where run_id = ?")
      .run("2026-01-01 00:00:00", "2026-01-01 00:00:59", "old-with-fresh-heartbeat");
    db.close();

    const reopened = await WorkflowStore.open(path);
    const reconciled = reopened.failStaleRuns(30_000, new Date("2026-01-01T00:01:00Z"));

    expect(reconciled.map((run) => run.runId)).toEqual(["old-run"]);
    expect(typeof reconciled[0]?.finishedAt).toBe("string");
    expect(reopened.listRuns().map((run) => ({ runId: run.runId, status: run.status }))).toEqual([
      { runId: "old-run", status: "failed" },
      { runId: "old-with-fresh-heartbeat", status: "running" },
      { runId: "fresh-run", status: "running" },
    ]);
    expect(reopened.listRunEvents("old-run").map((event) => event.type)).toEqual([
      "run.started",
      "run.stale_reconciled",
      "run.failed",
    ]);
    expect(reopened.listRunEvents("old-run").at(-1)?.payload).toEqual({
      reason: "stale-running-run",
      staleAfterMs: 30_000,
      staleBefore: "2026-01-01 00:00:30",
      createdAt: "2026-01-01 00:00:00",
    });
    expect(reopened.listRunEvents("fresh-run").map((event) => event.type)).toEqual(["run.started"]);
    expect(reopened.listRunEvents("old-with-fresh-heartbeat").map((event) => event.type)).toEqual([
      "run.started",
      "runner.started",
    ]);
    expect(reopened.failStaleRuns(30_000, new Date("2026-01-01T00:01:00Z"))).toEqual([]);
    expect(reopened.listRunEvents("old-run").map((event) => event.type)).toEqual([
      "run.started",
      "run.stale_reconciled",
      "run.failed",
    ]);
    reopened.close();
  });

  test("rejects invalid stale run thresholds", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));

    expect(() => store.failStaleRuns(0)).toThrow("olderThanMs must be a positive number");
    expect(() => store.failStaleRuns(Number.POSITIVE_INFINITY)).toThrow("olderThanMs must be a positive number");

    store.close();
  });

  test("stopRun marks running runs failed and preserves terminal status", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    store.createRun("store-smoke", "running-run");
    store.createRun("store-smoke", "completed-run");
    store.finishRun("completed-run", "completed");

    const stopped = store.stopRun("running-run");
    const completed = store.stopRun("completed-run");
    const missing = store.stopRun("missing-run");

    expect(stopped).toMatchObject({ runId: "running-run", workflow: "store-smoke", status: "failed" });
    expect(completed).toMatchObject({ runId: "completed-run", workflow: "store-smoke", status: "completed" });
    expect(missing).toBeNull();
    expect(store.listRunEvents("running-run").map((event) => event.type)).toEqual([
      "run.started",
      "run.stop_requested",
      "run.failed",
    ]);
    expect(store.listRunEvents("running-run").at(-1)?.payload).toEqual({ reason: "stop-requested" });
    expect(store.listRunEvents("completed-run").map((event) => event.type)).toEqual([
      "run.started",
      "run.completed",
    ]);
    store.close();
  });

  test("stopRunningRun only returns a record when it transitions a running run", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    store.createRun("store-smoke", "running-run");
    store.createRun("store-smoke", "completed-run");
    store.finishRun("completed-run", "completed");

    const stopped = store.stopRunningRun("running-run", "update-requested");
    const completed = store.stopRunningRun("completed-run", "update-requested");
    const missing = store.stopRunningRun("missing-run", "update-requested");

    expect(stopped).toMatchObject({ runId: "running-run", workflow: "store-smoke", status: "failed" });
    expect(completed).toBeNull();
    expect(missing).toBeNull();
    expect(store.listRunEvents("running-run").map((event) => event.type)).toEqual([
      "run.started",
      "run.stop_requested",
      "run.failed",
    ]);
    expect(store.listRunEvents("running-run").at(-1)?.payload).toEqual({ reason: "update-requested" });
    expect(store.listRunEvents("completed-run").map((event) => event.type)).toEqual([
      "run.started",
      "run.completed",
    ]);
    store.close();
  });

  test("restartRunningRun links the stopped run and replacement run atomically", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    store.createRun("store-smoke", "running-run");
    store.createRun("store-smoke", "completed-run");
    store.finishRun("completed-run", "completed");

    const stopped = store.restartRunningRun({
      previousRunId: "running-run",
      nextRunId: "replacement-run",
      nextWorkflow: "store-smoke-v2",
      handoffToken: "token",
    });
    const completed = store.restartRunningRun({
      previousRunId: "completed-run",
      nextRunId: "should-not-exist",
      nextWorkflow: "store-smoke-v2",
      handoffToken: "token",
    });

    expect(stopped).toMatchObject({ runId: "running-run", workflow: "store-smoke", status: "failed" });
    expect(completed).toBeNull();
    expect(store.getRun("replacement-run")).toMatchObject({
      runId: "replacement-run",
      workflow: "store-smoke-v2",
      status: "running",
    });
    expect(store.getRun("should-not-exist")).toBeNull();
    expect(store.listRunEvents("running-run").map((event) => event.type)).toEqual([
      "run.started",
      "run.stop_requested",
      "run.failed",
    ]);
    expect(store.listRunEvents("replacement-run").map((event) => event.type)).toEqual([
      "run.started",
      "run.updated_from",
    ]);
    expect(store.listRunEvents("replacement-run").at(-1)?.payload).toEqual({
      previousRunId: "running-run",
      mode: "restart-with-cache",
    });
    expect(store.consumeRunHandoffToken("replacement-run", "token")).toBe(true);
    store.close();
  });

  test("read surfaces reconcile running runs whose runner pid is dead", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const pid = await deadPid();
    store.createRun("store-smoke", "dead-run");
    store.createRun("store-smoke", "live-run");
    store.markRunRunnerStarted("dead-run", pid);
    store.markRunRunnerStarted("live-run", process.pid);

    expect(store.getRun("dead-run")).toMatchObject({
      runId: "dead-run",
      status: "failed",
      runnerPid: pid,
      finishedAt: expect.any(String),
    });
    expect(store.getRun("live-run")).toMatchObject({
      runId: "live-run",
      status: "running",
      runnerPid: process.pid,
      finishedAt: null,
    });
    expect(store.listRunEvents("dead-run").map((event) => event.type)).toEqual([
      "run.started",
      "runner.started",
      "run.stale_dead_pid",
      "run.failed",
    ]);
    expect(store.listRunEvents("dead-run").at(-1)?.payload).toMatchObject({
      reason: "dead-runner-pid",
      runnerPid: pid,
    });
    expect(store.failDeadPidRuns()).toEqual([]);
    expect(store.listRunEvents("live-run").map((event) => event.type)).toEqual([
      "run.started",
      "runner.started",
    ]);
    store.close();
  });

  test("stopRun returns a healed terminal record when the runner pid is already dead", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const pid = await deadPid();
    store.createRun("store-smoke", "dead-stop-run");
    store.markRunRunnerStarted("dead-stop-run", pid);

    expect(store.stopRun("dead-stop-run")).toMatchObject({
      runId: "dead-stop-run",
      status: "failed",
      runnerPid: pid,
    });
    expect(store.listRunEvents("dead-stop-run").map((event) => event.type)).toEqual([
      "run.started",
      "runner.started",
      "run.stale_dead_pid",
      "run.failed",
    ]);
    store.close();
  });

  test("records detached runner pid and heartbeat on run records", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    store.createRun("store-smoke", "detached-run");

    store.markRunRunnerStarted("detached-run", process.pid);
    const started = store.getRun("detached-run");
    store.heartbeatRun("detached-run");
    const heartbeat = store.getRun("detached-run");

    expect(started).toMatchObject({
      runId: "detached-run",
      workflow: "store-smoke",
      status: "running",
      runnerPid: process.pid,
      heartbeatAt: expect.any(String),
    });
    expect(heartbeat).toMatchObject({ runnerPid: process.pid, heartbeatAt: expect.any(String) });
    expect(store.listRuns()).toEqual([expect.objectContaining({
      runId: "detached-run",
      runnerPid: process.pid,
      heartbeatAt: expect.any(String),
    })]);
    expect(store.listRunEvents("detached-run").map((event) => event.type)).toEqual([
      "run.started",
      "runner.started",
    ]);

    store.finishRun("detached-run", "completed");
    store.heartbeatRun("detached-run");
    expect(store.getRun("detached-run")?.status).toBe("completed");
    store.close();
  });

  test("runner observes a stopped run before starting the next task", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const first = defineTask({
      id: "first",
      agent: builder,
      prompt: "First task.",
      output: Output,
      cacheKey: "first-cache",
    });
    const second = defineTask({
      id: "second",
      agent: reviewer,
      prompt: "Second task.",
      output: ReviewOutput,
      cacheKey: "second-cache",
    });
    const workflow = defineWorkflow({ name: "stop-smoke", tasks: [first, second] as const });
    const runId = store.createRun(workflow.name);
    const seen: string[] = [];

    await expect(runWorkflow(workflow, {
      store,
      runId,
      executeTask: async (task) => {
        seen.push(task.id);
        if (task.id === "first") {
          store.stopRun(runId);
          return { summary: "done" };
        }
        return { verdict: "pass" };
      },
    })).rejects.toThrow(WorkflowRunStoppedError);

    expect(seen).toEqual(["first"]);
    expect(store.getRun(runId)).toMatchObject({ status: "failed" });
    expect(store.listRunTasks(runId).map((task) => task.taskId)).toEqual(["first"]);
    store.close();
  });

  test("runner observes a stopped run before launching a repair attempt", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const runId = store.createRun("stop-before-repair-smoke");
    const task = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: Output,
      finish: {
        maxRepairs: 1,
        criteria: [{
          name: "stop-before-repair",
          check: () => {
            store.stopRun(runId);
            return Effect.fail(new Error("stopped before repair"));
          },
        }],
      },
    });
    const workflow = defineWorkflow({ name: "stop-before-repair-smoke", tasks: [task] as const });
    let calls = 0;

    await expect(runWorkflow(workflow, {
      store,
      runId,
      executeTask: async () => {
        calls += 1;
        return { summary: "needs repair" };
      },
    })).rejects.toThrow(WorkflowRunStoppedError);

    expect(calls).toBe(1);
    expect(store.listRunEvents(runId).map((event) => event.type)).not.toContain("task.repair.started");
    expect(store.getRun(runId)).toMatchObject({ status: "failed" });
    store.close();
  });

  test("runner cancels queued dynamic fan-out siblings and rejects raw when stopped mid-run", async () => {
    // PQ-166 regression: the dynamic path recovers WorkflowRunStoppedError via Cause.squash
    // (not runPromise's FiberFailure wrapper) and eagerly cancels queued siblings. Assert both
    // the raw rejection type and that a queued sibling never reaches the executor, so a refactor
    // that silently reintroduces the FiberFailure wrap or drops eager cancellation stays caught.
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const runId = store.createRun("stop-dynamic-fanout-smoke");
    const leaf = (id: string) => defineTask({ id, agent: builder, prompt: `Run ${id}.`, output: Output });
    const [a, b, c] = [leaf("a"), leaf("b"), leaf("c")];
    const workflow = defineWorkflow({
      name: "stop-dynamic-fanout-smoke",
      run: (wf) => Effect.gen(function* () {
        return yield* Effect.all([a, b, c].map((task) => wf.runTask(task)), { concurrency: "unbounded" });
      }),
    });
    const seen: string[] = [];

    await expect(runWorkflow(workflow, {
      store,
      runId,
      maxConcurrentTasks: 1,
      executeTask: async (task) => {
        seen.push(task.id);
        if (task.id === "a") store.stopRun(runId);
        return { summary: task.id };
      },
    })).rejects.toThrow(WorkflowRunStoppedError);

    expect(seen).toEqual(["a"]);
    expect(store.getRun(runId)).toMatchObject({ status: "failed" });
    expect(store.listRunTasks(runId).map((task) => task.taskId)).toEqual(["a"]);
    store.close();
  });

  test("stores and reads completed task output by identity", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow();
    const task = workflow.tasks[0]!;
    const identity = workflowTaskIdentity(workflow.name, task);

    store.recordCompleted({
      identity,
      agent: { plugin: task.agent.plugin, name: task.agent.name },
      output: { summary: "stored" },
      metadata: contractMetadata,
    });

    expect(store.getCompleted(identity)).toMatchObject({
      output: { summary: "stored" },
      metadata: contractMetadata,
    });
    expect(store.listCompletedCache()).toEqual([
      {
        identity,
        agent: { plugin: "forge", name: "builder" },
        status: "completed",
        output: { summary: "stored" },
        metadata: contractMetadata,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(store.listCompletedCache({ workflow: workflow.name }).map((entry) => entry.identity.cacheKey)).toEqual([
      "builder-cache",
    ]);
    expect(store.listCompletedCache({
      workflow: workflow.name,
      taskId: "build",
      cacheKey: "builder-cache",
      promptHash: identity.promptHash,
      agentManifestHash: identity.agentManifestHash,
    }).map((entry) => entry.metadata)).toEqual([contractMetadata]);
    expect(store.listCompletedCache({ cacheKey: "missing-cache" })).toEqual([]);
    store.close();
  });

  test("real completed task cache records are immutable", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow({ worker: "claude-code" });
    const task = workflow.tasks[0]!;
    const identity = workflowTaskIdentity(workflow.name, task);

    store.recordCompleted({
      identity,
      agent: { plugin: task.agent.plugin, name: task.agent.name },
      output: { summary: "first" },
      metadata: { ...contractMetadata, adapter: "claude-code", sessionId: "session-1" },
    });
    store.recordCompleted({
      identity,
      agent: { plugin: task.agent.plugin, name: task.agent.name },
      output: { summary: "second" },
      metadata: { ...contractMetadata, adapter: "claude-code", sessionId: "session-2" },
    });

    expect(store.getCompleted(identity)).toMatchObject({
      output: { summary: "first" },
      metadata: expect.objectContaining({
        adapter: "claude-code",
        sessionId: "session-1",
      }),
    });
    store.close();
  });

  test("records and reuses judge executions separately from primary task output cache", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    let executorCalls = 0;
    let judgeCalls = 0;
    const finish: WorkflowFinishOptions<{ summary: string }> = {
      criteria: [{
        kind: "judge",
        name: "bounded-quality-judge",
        goal: "Accept summaries that mention done.",
        selectEvidence: ({ output, task }) => ({ summary: output.summary, taskId: task.id }),
        evaluate: ({ output, evidence }) => {
          judgeCalls += 1;
          expect(evidence).toEqual({ summary: output.summary, taskId: "build" });
          return Effect.succeed({ verdict: "pass" as const, metadata: { judgeModel: "mock" } });
        },
      }],
    };
    const workflow = createWorkflow({ finish });

    const first = await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        executorCalls += 1;
        return { output: { summary: "done" }, metadata: { attemptId: "primary-1" } };
      },
    });
    const second = await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        executorCalls += 1;
        return { summary: "should not execute" };
      },
    });

    expect(executorCalls).toBe(1);
    expect(judgeCalls).toBe(1);
    expect(first.tasks[0]?.metadata?.finish).toMatchObject({
      judgeRuns: [expect.objectContaining({ criterion: "bounded-quality-judge", verdict: "pass", cached: false })],
    });
    expect(second.tasks[0]?.metadata?.finish).toMatchObject({
      judgeRuns: [expect.objectContaining({ criterion: "bounded-quality-judge", verdict: "pass", cached: true })],
    });
    const records = store.listJudgeRecords({ workflow: workflow.name, taskId: "build" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      identity: {
        workflow: workflow.name,
        taskId: "build",
        taskCacheKey: "builder-cache",
        criterion: "bounded-quality-judge",
      },
      verdict: "pass",
      evidence: { summary: "done", taskId: "build" },
      output: { summary: "done" },
      taskMetadata: {
        id: "build",
        agent: { plugin: "forge", name: "builder" },
      },
      metadata: { judgeModel: "mock" },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(store.listRunEvents(second.runId!).map((event) => event.type)).toContain("task.judge.cache_lookup.hit");
    store.close();
  });

  test("judge escalation records an escalated run and task status", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow({
      finish: {
        criteria: [{
          kind: "judge",
          name: "requires-human",
          evaluate: () => Effect.succeed({ verdict: "escalate" as const, feedback: "Needs human decision." }),
        }],
      },
    });

    await expect(runWorkflow(workflow, {
      store,
      executeTask: async () => ({ summary: "ambiguous" }),
    })).rejects.toThrow(WorkflowTaskEscalatedError);

    const run = store.listRuns()[0]!;
    expect(run.status).toBe("escalated");
    expect(store.listRunTasks(run.runId)).toEqual([
      expect.objectContaining({
        taskId: "build",
        status: "escalated",
        output: { summary: "ambiguous" },
        metadata: expect.objectContaining({
          finish: expect.objectContaining({
            escalated: true,
            escalation: {
              criterion: "requires-human",
              feedback: "Needs human decision.",
            },
          }),
        }),
      }),
    ]);
    expect(store.listRunEvents(run.runId).map((event) => event.type)).toContain("task.escalated");
    expect(store.listRunEvents(run.runId).map((event) => event.type)).toContain("run.escalated");
    expect(store.compactRunSummary(run.runId)).toMatchObject({
      totals: {
        status: "escalated",
        durationMs: expect.any(Number),
      },
      tasks: [expect.objectContaining({
        taskId: "build",
        status: "escalated",
      })],
    });
    store.close();
  });

  test("runner reuses cached task output and does not call the executor", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow();
    let calls = 0;

    const first = await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "first" };
      },
    });
    const second = await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "second" };
      },
    });

    expect(calls).toBe(1);
    expect(first.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.cached).toBe(true);
    expect(second.tasks[0]?.output).toEqual({ summary: "first" });
    expect(store.getCompleted(workflowTaskIdentity(workflow.name, workflow.tasks[0]!))?.metadata).toEqual(contractMetadata);
    const firstRunId = first.runId!;
    const secondRunId = second.runId!;
    expect(store.listRuns().map((run) => run.status)).toEqual(["completed", "completed"]);
    expect(store.listRunTasks(firstRunId)).toEqual([
      {
        runId: firstRunId,
        ordinal: 0,
        taskId: "build",
        cacheKey: "builder-cache",
        status: "completed",
        cached: false,
        agent: { plugin: "forge", name: "builder" },
        output: { summary: "first" },
        metadata: contractMetadata,
      },
    ]);
    expect(store.listRunEvents(firstRunId).map((event) => event.type)).toEqual([
      "run.started",
      "task.started",
      "task.cache_lookup.started",
      "task.cache_lookup.miss",
      "task.executor.started",
      "task.executor.completed",
      "task.decode.started",
      "task.decode.completed",
      "task.finish.completed",
      "task.cache_write.completed",
      "task.completed",
      "run.completed",
    ]);
    expect(store.listRunEvents(firstRunId).find((event) => event.type === "task.completed")?.payload)
      .toMatchObject(contractMetadata);
    expect(store.listRunTasks(secondRunId)).toEqual([
      {
        runId: secondRunId,
        ordinal: 0,
        taskId: "build",
        cacheKey: "builder-cache",
        status: "completed",
        cached: true,
        agent: { plugin: "forge", name: "builder" },
        output: { summary: "first" },
        metadata: {
          ...contractMetadata,
          cachedFrom: "workflow_task_records",
          finish: { repairs: 0, criteria: [], repairMode: "none" },
        },
      },
    ]);
    expect(store.listRunEvents(secondRunId).map((event) => event.type)).toEqual([
      "run.started",
      "task.started",
      "task.cache_lookup.started",
      "task.cache_lookup.hit",
      "task.decode.started",
      "task.decode.completed",
      "task.finish.completed",
      "task.completed",
      "run.completed",
    ]);
    expect(store.listRunEvents(secondRunId).find((event) => event.type === "task.completed")?.payload)
      .toMatchObject(contractMetadata);
    store.close();
  });

  test("mock-output run records outputSource provenance and real run does not reuse it", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow();
    let calls = 0;

    // First run: mock-output mode — seeds the cache with outputSource marker
    const mockRun = await runWorkflow(workflow, {
      store,
      mockOutput: true,
      executeTask: async () => {
        calls += 1;
        return { summary: "mock-value" };
      },
    });

    // After the mock run, the cache record carries the provenance marker
    const identity = workflowTaskIdentity(workflow.name, workflow.tasks[0]!);
    const cacheRecordAfterMock = store.getCompleted(identity, { allowMockSourced: true });
    expect(cacheRecordAfterMock?.outputSource).toBe("mock-output");
    expect(cacheRecordAfterMock?.output).toEqual({ summary: "mock-value" });

    // getCompleted without allowMockSourced returns null (real runs see no cache)
    const cacheRecordRealLookup = store.getCompleted(identity);
    expect(cacheRecordRealLookup).toBeNull();

    // Mock-sourced event has the provenance field
    const mockRunId = mockRun.runId!;
    const cacheWriteEvent = store.listRunEvents(mockRunId).find((event) => event.type === "task.cache_write.completed");
    expect(cacheWriteEvent?.payload).toMatchObject({ outputSource: "mock-output" });

    // listCompletedCache shows the mock-sourced marker
    expect(store.listCompletedCache()).toEqual([
      expect.objectContaining({
        outputSource: "mock-output",
        output: { summary: "mock-value" },
      }),
    ]);

    // Second run: real (non-mock) mode — must NOT reuse mock-sourced cache entry
    const realRun = await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "real-value" };
      },
    });

    expect(calls).toBe(2);
    expect(mockRun.tasks[0]?.cached).toBe(false);
    expect(mockRun.tasks[0]?.output).toEqual({ summary: "mock-value" });
    expect(realRun.tasks[0]?.cached).toBe(false);
    expect(realRun.tasks[0]?.output).toEqual({ summary: "real-value" });

    // Real run recorded a cache miss (not a hit) since mock-sourced entries are excluded
    const realRunId = realRun.runId!;
    expect(store.listRunEvents(realRunId).map((event) => event.type)).toContain("task.cache_lookup.miss");
    expect(store.listRunEvents(realRunId).map((event) => event.type)).not.toContain("task.cache_lookup.hit");

    // After real run, the cache record is overwritten with real output and no outputSource
    const cacheRecordAfterReal = store.getCompleted(identity);
    expect(cacheRecordAfterReal?.output).toEqual({ summary: "real-value" });
    expect(cacheRecordAfterReal?.outputSource).toBeUndefined();

    store.close();
  });

  test("mock-output run reuses its own prior mock-sourced cache on a subsequent mock run", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow();
    let calls = 0;

    // First mock run seeds the cache
    await runWorkflow(workflow, {
      store,
      mockOutput: true,
      executeTask: async () => {
        calls += 1;
        return { summary: "mock-seeded" };
      },
    });

    // Second mock run reuses the mock-sourced cache (mock runs can reuse mock cache)
    const secondMock = await runWorkflow(workflow, {
      store,
      mockOutput: true,
      executeTask: async () => {
        calls += 1;
        return { summary: "should-not-execute" };
      },
    });

    expect(calls).toBe(1);
    expect(secondMock.tasks[0]?.cached).toBe(true);
    expect(secondMock.tasks[0]?.output).toEqual({ summary: "mock-seeded" });
    store.close();
  });

  test("real run caches its output and subsequent real run reuses it", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow();
    let calls = 0;

    // First real run
    const first = await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "real-first" };
      },
    });

    // Second real run reuses real cache (no outputSource marker)
    const second = await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "real-second" };
      },
    });

    expect(calls).toBe(1);
    expect(first.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.cached).toBe(true);
    expect(second.tasks[0]?.output).toEqual({ summary: "real-first" });

    // No outputSource on real cache records
    const cacheRecord = store.getCompleted(workflowTaskIdentity(workflow.name, workflow.tasks[0]!));
    expect(cacheRecord?.outputSource).toBeUndefined();
    store.close();
  });

  test("summarizes workflow task progress from stored task records and events", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow({
      finish: {
        maxRepairs: 1,
        criteria: [{
          name: "summary-length",
          check: () => Effect.void,
        }],
      },
    });

    const first = await runWorkflow(workflow, {
      store,
      executeTask: async () => ({ summary: "first" }),
    });
    const second = await runWorkflow(workflow, {
      store,
      executeTask: async () => ({ summary: "second" }),
    });
    store.createRun("store-smoke", "event-only-run");
    store.recordEvent({ runId: "event-only-run", taskId: "running-task", type: "task.started", payload: { cacheKey: "running-cache" } });
    store.recordEvent({ runId: "event-only-run", taskId: "running-task", type: "task.cache_lookup.miss", payload: { cacheKey: "running-cache" } });
    store.recordEvent({ runId: "event-only-run", taskId: "running-task", type: "task.repair.started", payload: { attempt: 1 } });

    expect(store.summarizeRunTasks(first.runId!)).toEqual([
      expect.objectContaining({
        taskId: "build",
        status: "completed",
        cacheKey: "builder-cache",
        cached: false,
        cacheLookup: "miss",
        repairs: 0,
        agent: { plugin: "forge", name: "builder" },
        lastEventType: "task.completed",
      }),
    ]);
    expect(store.summarizeRunTasks(second.runId!)).toEqual([
      expect.objectContaining({
        taskId: "build",
        status: "completed",
        cacheKey: "builder-cache",
        cached: true,
        cacheLookup: "hit",
        repairs: 0,
      }),
    ]);
    expect(store.summarizeRunTasks("event-only-run")).toEqual([
      expect.objectContaining({
        taskId: "running-task",
        status: "running",
        cacheKey: "running-cache",
        cacheLookup: "miss",
        repairs: 1,
        lastEventType: "task.repair.started",
      }),
    ]);
    store.close();
  });

  test("records task snapshots for monitor display without changing cache identity", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const buildA = defineTask({
      id: "build",
      phase: "Build",
      agent: builder,
      prompt: "Build the slice.",
      output: Output,
      cacheKey: "builder-cache",
      worker: { worker: "grok", model: "grok-build" },
    });
    const buildB = defineTask({
      ...buildA,
      phase: "Review",
    });
    expect(workflowTaskIdentity("monitor-smoke", buildA)).toEqual(workflowTaskIdentity("monitor-smoke", buildB));

    const workflow = defineWorkflow({ name: "monitor-smoke", tasks: [buildA] as const });
    const first = await runWorkflow(workflow, {
      store,
      executeTask: async () => ({ summary: "fresh" }),
    });
    store.recordRunSnapshot({
      runId: first.runId!,
      workflowFile: join(root, "monitor.workflow.ts"),
      options: { worker: "grok", model: "grok-build" },
    });
    const second = await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        throw new Error("cache should avoid executor");
      },
    });

    expect(store.listRunTaskSnapshots(first.runId!)).toEqual([
      expect.objectContaining({
        taskId: "build",
        phase: "Build",
        prompt: "Build the slice.",
        cacheKey: "builder-cache",
        agent: expect.objectContaining({ plugin: "forge", name: "builder" }),
        worker: { worker: "grok", model: "grok-build" },
        finishCriteria: [],
      }),
    ]);
    expect(store.workflowMonitorState(first.runId!).selectedRun).toMatchObject({
      snapshot: expect.objectContaining({ workflowFile: join(root, "monitor.workflow.ts") }),
      tasks: [expect.objectContaining({ taskId: "build", phase: "Build", badges: expect.arrayContaining(["miss", "fresh", "write"]) })],
    });
    expect(store.workflowMonitorState(second.runId!).selectedRun?.tasks[0]?.badges).toEqual(expect.arrayContaining(["hit", "cached"]));
    store.close();
  });

  test("builds compact execution evidence for completed, failed, cached, repaired, and event-only tasks", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));

    const completed = await runWorkflow(createWorkflow({ worker: "grok", model: "grok-build" }), {
      store,
      executeTask: async () => ({
        output: { summary: "fresh" },
        metadata: {
          adapter: "grok-cli",
          nativeAgent: "builder",
          model: "grok-build",
          durationMs: 25,
          sessionId: "grok-session-1",
        },
      }),
    });
    const cached = await runWorkflow(createWorkflow({ worker: "grok", model: "grok-build" }), {
      store,
      executeTask: async () => {
        throw new Error("cache should avoid executor");
      },
    });

    let repairCalls = 0;
    const repaired = await runWorkflow(createWorkflow({
      finish: {
        maxRepairs: 1,
        criteria: [{
          name: "summary-prefix",
          check: ({ output }) => output.summary.startsWith("ok")
            ? Effect.void
            : Effect.fail(new Error("summary must start with ok")),
        }],
      },
    }), {
      store,
      executeTask: async () => {
        repairCalls += 1;
        return { summary: repairCalls === 1 ? "bad" : "ok after repair" };
      },
    });

    let nativeRepairCalls = 0;
    const nativeRepaired = await runWorkflow(createWorkflow({
      worker: "claude-code",
      model: "sonnet",
      finish: {
        maxRepairs: 1,
        criteria: [{
          name: "summary-prefix",
          check: ({ output }) => output.summary.startsWith("ok")
            ? Effect.void
            : Effect.fail(new Error("summary must start with ok")),
        }],
      },
    }), {
      store,
      executeTask: async (_task, context) => {
        nativeRepairCalls += 1;
        return {
          output: { summary: context?.repair?.mode === "native-continuation" ? "ok native repair" : "bad" },
          metadata: {
            adapter: "claude-code",
            model: "sonnet",
            nativeAgent: "builder",
            sessionId: "native-session",
            durationMs: nativeRepairCalls * 10,
          },
        };
      },
    });

    const failedWorkflow = createWorkflow({ prompt: "Return malformed output.", finish: { maxRepairs: 0 } });
    const failedRunId = store.createRun(failedWorkflow.name);
    const failed = await runWorkflow(failedWorkflow, {
      store,
      runId: failedRunId,
      executeTask: async () => ({
        output: { summary: 1 },
        metadata: {
          adapter: "mock-worker",
          model: "mock-model",
          nativeAgent: "builder",
          durationMs: 10,
        },
      }),
    }).catch((error) => {
      expect(error).toBeInstanceOf(WorkflowTaskDecodeError);
      return { runId: failedRunId };
    });

    store.createRun("store-smoke", "started-only-run");
    store.recordEvent({ runId: "started-only-run", taskId: "pending-task", type: "task.started", payload: { cacheKey: "pending-cache" } });

    store.createRun("store-smoke", "event-only-run");
    store.recordEvent({ runId: "event-only-run", taskId: "running-task", type: "task.started", payload: { cacheKey: "running-cache" } });
    store.recordEvent({ runId: "event-only-run", taskId: "running-task", type: "task.cache_lookup.miss", payload: { cacheKey: "running-cache" } });
    store.recordEvent({ runId: "event-only-run", taskId: "running-task", type: "task.executor.started", payload: { attempt: 0 } });
    store.recordEvent({ runId: "event-only-run", taskId: "running-task", type: "task.repair.started", payload: { attempt: 1 } });
    store.recordEvent({
      runId: "event-only-run",
      taskId: "running-task",
      type: "task.executor.completed",
      payload: {
        adapter: "claude-code",
        model: "sonnet",
        nativeAgent: "builder",
        durationMs: 123,
        sessionId: "claude-session",
      },
    });

    const metadataOnlyWorkflow = createWorkflow({ worker: "opencode", model: "gpt-5" });
    const metadataOnlyTask = metadataOnlyWorkflow.tasks[0]!;
    const metadataOnlyRunId = store.createRun(metadataOnlyWorkflow.name, "metadata-only-repair-run");
    store.recordRunTask({
      runId: metadataOnlyRunId,
      ordinal: 0,
      identity: workflowTaskIdentity(metadataOnlyWorkflow.name, metadataOnlyTask),
      agent: { plugin: metadataOnlyTask.agent.plugin, name: metadataOnlyTask.agent.name },
      status: "completed",
      cached: false,
      output: { summary: "metadata repair" },
      metadata: {
        finish: {
          repairs: 2,
          repairMode: "native-continuation",
        },
      },
      finishRunStatus: "completed",
    });

    const mixedRunId = store.createRun("store-smoke", "mixed-order-run");
    store.recordEvent({ runId: mixedRunId, taskId: "in-flight", type: "task.started", payload: { cacheKey: "in-flight-cache" } });
    store.recordRunTask({
      runId: mixedRunId,
      ordinal: 0,
      identity: workflowTaskIdentity(metadataOnlyWorkflow.name, metadataOnlyTask),
      agent: { plugin: metadataOnlyTask.agent.plugin, name: metadataOnlyTask.agent.name },
      status: "completed",
      cached: false,
      output: { summary: "terminal" },
      metadata: { adapter: "opencode", model: "gpt-5" },
    });

    expect(store.compactRunSummary(completed.runId!)).toMatchObject({
      kind: "workflow-execution-evidence",
      semanticCorrectness: "not-evaluated",
      run: { status: "completed" },
      totals: { totalTasks: 1, freshExecutions: 1, cacheHits: 0, repairs: 0, status: "completed" },
      tasks: [{
        taskId: "build",
        status: "completed",
        execution: "fresh",
        evidenceSource: "this-run",
        cached: false,
        workerAdapter: "grok-cli",
        model: "grok-build",
        nativeAgent: "builder",
        repairCount: 0,
        repairMode: "none",
        durationMs: 25,
        externalSessionPointer: "grok-session-1",
      }],
    });
    expect(store.compactRunSummary(cached.runId!)).toMatchObject({
      totals: { totalTasks: 1, freshExecutions: 0, cacheHits: 1, repairs: 0 },
      tasks: [expect.objectContaining({
        taskId: "build",
        execution: "cached",
        evidenceSource: "prior-cache-record",
        cached: true,
        workerAdapter: "grok-cli",
      })],
    });
    expect(store.compactRunSummary(repaired.runId!)).toMatchObject({
      totals: { totalTasks: 1, freshExecutions: 1, cacheHits: 0, repairs: 1 },
      tasks: [expect.objectContaining({ taskId: "build", status: "completed", execution: "fresh", repairCount: 1, repairMode: "fresh-executor-invocation" })],
    });
    expect(store.compactRunSummary(nativeRepaired.runId!)).toMatchObject({
      totals: { totalTasks: 1, freshExecutions: 1, cacheHits: 0, repairs: 1 },
      tasks: [expect.objectContaining({
        taskId: "build",
        status: "completed",
        execution: "fresh",
        evidenceSource: "this-run",
        repairCount: 1,
        repairMode: "native-continuation",
      })],
    });
    expect(store.compactRunSummary(failed.runId!)).toMatchObject({
      run: { status: "failed" },
      totals: { totalTasks: 1, freshExecutions: 1, cacheHits: 0, repairs: 0, status: "failed" },
      tasks: [expect.objectContaining({
        taskId: "build",
        status: "failed",
        execution: "fresh",
        workerAdapter: "mock-worker",
        model: "mock-model",
        nativeAgent: "builder",
        durationMs: 10,
      })],
    });
    expect(store.compactRunSummary("started-only-run")).toMatchObject({
      run: { status: "running" },
      totals: { totalTasks: 1, freshExecutions: 1, cacheHits: 0, repairs: 0, status: "running" },
      tasks: [expect.objectContaining({
        taskId: "pending-task",
        status: "running",
        execution: "fresh",
        evidenceSource: "run-events",
        cached: false,
        workerAdapter: null,
      })],
    });
    expect(store.compactRunSummary("event-only-run")).toMatchObject({
      run: { status: "running" },
      totals: { totalTasks: 1, freshExecutions: 1, cacheHits: 0, repairs: 1, status: "running" },
      tasks: [expect.objectContaining({
        taskId: "running-task",
        status: "running",
        execution: "fresh",
        evidenceSource: "run-events",
        cached: false,
        workerAdapter: "claude-code",
        model: "sonnet",
        nativeAgent: "builder",
        repairCount: 1,
        repairMode: null,
        durationMs: 123,
        externalSessionPointer: "claude-session",
      })],
    });
    expect(store.compactRunSummary(metadataOnlyRunId)).toMatchObject({
      totals: { totalTasks: 1, freshExecutions: 1, cacheHits: 0, repairs: 2 },
      tasks: [expect.objectContaining({
        taskId: "build",
        repairCount: 2,
        repairMode: "native-continuation",
      })],
    });
    expect(store.compactRunSummary(mixedRunId)?.tasks.map((task) => task.taskId)).toEqual(["in-flight", "build"]);
    expect(store.compactRunSummary("missing-run")).toBeNull();
    store.close();
  });

  test("dynamic workflows reuse cached upstream output to construct downstream tasks", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = defineWorkflow({
      name: "dynamic-store-smoke",
      run: (wf) => Effect.gen(function* () {
        const build = yield* wf.runTask(defineTask({
          id: "build",
          agent: builder,
          prompt: "Build the slice.",
          output: Output,
          cacheKey: "dynamic-builder-cache",
        }));
        const review = yield* wf.runTask(defineTask({
          id: "review",
          agent: reviewer,
          prompt: `Review ${build.summary}`,
          output: ReviewOutput,
          cacheKey: "dynamic-review-cache",
        }));
        return { summary: build.summary, verdict: review.verdict };
      }),
    });
    const calls: string[] = [];

    const first = await runWorkflow(workflow, {
      store,
      executeTask: async (task) => {
        calls.push(task.prompt);
        if (task.id === "build") return { summary: "first" };
        return { verdict: "pass" };
      },
    });
    const second = await runWorkflow(workflow, {
      store,
      executeTask: async (task) => {
        calls.push(`unexpected:${task.id}`);
        return task.id === "build" ? { summary: "second" } : { verdict: "pass" };
      },
    });

    expect(calls).toEqual(["Build the slice.", "Review first"]);
    expect(first.output).toEqual({ summary: "first", verdict: "pass" });
    expect(second.output).toEqual({ summary: "first", verdict: "pass" });
    expect(second.tasks.map((task) => ({ id: task.id, cached: task.cached }))).toEqual([
      { id: "build", cached: true },
      { id: "review", cached: true },
    ]);
    store.close();
  });

  test("dynamic fan-out preserves invocation order in run history", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = defineWorkflow({
      name: "dynamic-fanout-store-smoke",
      run: (wf) => Effect.gen(function* () {
        const slow = defineTask({
          id: "slow",
          agent: builder,
          prompt: "Return slow output.",
          output: Output,
          cacheKey: "dynamic-slow-cache",
        });
        const fast = defineTask({
          id: "fast",
          agent: reviewer,
          prompt: "Return fast output.",
          output: ReviewOutput,
          cacheKey: "dynamic-fast-cache",
        });
        const [slowOutput, fastOutput] = yield* Effect.all([
          wf.runTask(slow),
          wf.runTask(fast),
        ], { concurrency: "unbounded" });
        return { slow: slowOutput.summary, fast: fastOutput.verdict };
      }),
    });
    const completions: string[] = [];

    const result = await runWorkflow(workflow, {
      store,
      executeTask: async (task) => {
        if (task.id === "slow") {
          await delay(20);
          completions.push(task.id);
          return { summary: "slow" };
        }
        completions.push(task.id);
        return { verdict: "pass" };
      },
    });

    expect(completions).toEqual(["fast", "slow"]);
    expect(result.tasks.map((task) => task.id)).toEqual(["slow", "fast"]);
    expect(store.listRuns()[0]?.status).toBe("completed");
    expect(store.listRunTasks(result.runId!).map((task) => task.taskId)).toEqual(["slow", "fast"]);
    expect(store.listRunEvents(result.runId!).map((event) => event.type).at(-1)).toBe("run.completed");
    store.close();
  });

  test("monitor summaries preserve repeated dynamic task ids by invocation ordinal", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const repeated = defineTask({
      id: "review",
      agent: reviewer,
      prompt: "Review the item.",
      output: ReviewOutput,
      cacheKey: "repeated-review-cache",
    });
    const workflow = defineWorkflow({
      name: "dynamic-duplicate-task-id-smoke",
      run: (wf) => Effect.gen(function* () {
        const first = yield* wf.runTask(repeated);
        const second = yield* wf.runTask(repeated);
        return { first: first.verdict, second: second.verdict };
      }),
    });

    const result = await runWorkflow(workflow, {
      store,
      executeTask: async () => ({ verdict: "pass" }),
    });

    expect(result.tasks.map((task) => task.id)).toEqual(["review", "review"]);
    expect(store.listRunTasks(result.runId!).map((task) => ({ ordinal: task.ordinal, taskId: task.taskId }))).toEqual([
      { ordinal: 0, taskId: "review" },
      { ordinal: 1, taskId: "review" },
    ]);
    expect(store.compactRunSummary(result.runId!)?.tasks.map((task) => ({ ordinal: task.ordinal, taskId: task.taskId }))).toEqual([
      { ordinal: 0, taskId: "review" },
      { ordinal: 1, taskId: "review" },
    ]);
    expect(store.workflowMonitorRunDetail(result.runId!)?.tasks.map((task) => ({ ordinal: task.ordinal, taskId: task.taskId }))).toEqual([
      { ordinal: 0, taskId: "review" },
      { ordinal: 1, taskId: "review" },
    ]);
    store.close();
  });

  test("dynamic workflow failures after completed tasks mark the run failed", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = defineWorkflow({
      name: "dynamic-post-task-failure-smoke",
      run: (wf) => Effect.gen(function* () {
        yield* wf.runTask(defineTask({
          id: "build",
          agent: builder,
          prompt: "Build before failing.",
          output: Output,
        }));
        return yield* Effect.fail(new Error("dynamic workflow body failed"));
      }),
    });

    await expect(runWorkflow(workflow, {
      store,
      executeTask: async () => ({ summary: "built" }),
    })).rejects.toThrow("dynamic workflow body failed");

    const runId = store.listRuns()[0]!.runId;
    expect(store.listRuns()[0]?.status).toBe("failed");
    expect(store.listRunTasks(runId)).toEqual([
      {
        runId,
        ordinal: 0,
        taskId: "build",
        cacheKey: "build",
        status: "completed",
        cached: false,
        agent: { plugin: "forge", name: "builder" },
        output: { summary: "built" },
        metadata: contractMetadata,
      },
    ]);
    expect(store.listRunEvents(runId).map((event) => event.type).at(-1)).toBe("run.failed");
    store.close();
  });

  test("dynamic fan-out isolates a failed task and completes the run with sibling records", async () => {
    // PQ-166 fault isolation: an unhandled task failure no longer fails the whole run. The
    // sibling still completes and is recorded, and the run finishes `completed` with partial
    // results rather than aborting to `failed`.
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = defineWorkflow({
      name: "dynamic-fanout-isolation-smoke",
      run: (wf) => Effect.gen(function* () {
        const fail = defineTask({
          id: "fail",
          agent: builder,
          prompt: "Fail quickly.",
          output: Output,
          cacheKey: "dynamic-fail-cache",
        });
        const slow = defineTask({
          id: "slow",
          agent: reviewer,
          prompt: "Finish slowly.",
          output: Output,
          cacheKey: "dynamic-slow-cache",
        });
        yield* Effect.all([
          Effect.either(wf.runTask(fail)),
          Effect.either(wf.runTask(slow)),
        ], { concurrency: "unbounded" });
      }),
    });
    const completions: string[] = [];

    const result = await runWorkflow(workflow, {
      store,
      executeTask: async (task) => {
        if (task.id === "fail") {
          completions.push(task.id);
          throw new Error("fast failure");
        }
        await delay(20);
        completions.push(task.id);
        return { summary: "slow" };
      },
    });

    const runId = result.runId!;
    expect(completions).toEqual(["fail", "slow"]);
    expect(store.listRuns()[0]?.status).toBe("completed");
    expect(result.tasks.map((task) => ({ id: task.id, status: task.status }))).toEqual([
      { id: "fail", status: "failed" },
      { id: "slow", status: "completed" },
    ]);
    expect(store.listRunTasks(runId).map((task) => ({ taskId: task.taskId, status: task.status }))).toEqual([
      { taskId: "fail", status: "failed" },
      { taskId: "slow", status: "completed" },
    ]);
    const events = store.listRunEvents(runId).map((event) => ({ taskId: event.taskId, type: event.type }));
    expect(events.at(-1)).toEqual({ taskId: null, type: "run.completed" });
    expect(events.some((event) => event.taskId === "slow" && event.type === "task.completed")).toBe(true);
    expect(events.findLastIndex((event) => event.type === "task.completed"))
      .toBeLessThan(events.findLastIndex((event) => event.type === "run.completed"));
    store.close();
  });

  test("runner records decode failures in run history", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow({ finish: { maxRepairs: 0 } });

    await expect(runWorkflow(workflow, {
      store,
      executeTask: async () => ({ notSummary: "wrong" }),
    })).rejects.toThrow(WorkflowTaskDecodeError);

    const runId = store.listRuns()[0]?.runId;
    expect(runId).toBeString();
    expect(store.listRuns()[0]?.status).toBe("failed");
    const recordedRunId = runId!;
    expect(store.listRunTasks(recordedRunId)).toEqual([
      {
        runId: recordedRunId,
        ordinal: 0,
        taskId: "build",
        cacheKey: "builder-cache",
        status: "failed",
        cached: false,
        agent: { plugin: "forge", name: "builder" },
        output: { notSummary: "wrong" },
        metadata: contractMetadata,
      },
    ]);
    expect(store.listRunEvents(recordedRunId).map((event) => event.type)).toEqual([
      "run.started",
      "task.started",
      "task.cache_lookup.started",
      "task.cache_lookup.miss",
      "task.executor.started",
      "task.executor.completed",
      "task.decode.started",
      "task.decode.failed",
      "task.failed",
      "run.failed",
    ]);
    store.close();
  });

  test("self-heals a schema-decode failure by default when no finish block is set", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow(); // no finish block -> objective decode repair is on by default
    let calls = 0;
    await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        calls += 1;
        return calls === 1 ? { summary: 42 } : { summary: "healed" };
      },
    });

    expect(calls).toBe(2);
    const runId = store.listRuns()[0]!.runId;
    expect(store.listRuns()[0]?.status).toBe("completed");
    const tasks = store.listRunTasks(runId);
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.output).toEqual({ summary: "healed" });
    expect(store.listRunEvents(runId).map((event) => event.type)).toContain("task.repair.started");
    store.close();
  });

  test("runner records executor failures in run history", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow();

    await expect(runWorkflow(workflow, {
      store,
      executeTask: async () => {
        throw new Error("mock harness failed");
      },
    })).rejects.toThrow("mock harness failed");

    const runId = store.listRuns()[0]!.runId;
    expect(store.listRuns()[0]?.status).toBe("failed");
    expect(store.listRunTasks(runId)).toEqual([
      {
        runId,
        ordinal: 0,
        taskId: "build",
        cacheKey: "builder-cache",
        status: "failed",
        cached: false,
        agent: { plugin: "forge", name: "builder" },
        output: { error: "mock harness failed" },
        metadata: contractMetadata,
      },
    ]);
    expect(store.listRunEvents(runId).map((event) => event.type)).toEqual([
      "run.started",
      "task.started",
      "task.cache_lookup.started",
      "task.cache_lookup.miss",
      "task.executor.started",
      "task.executor.failed",
      "task.failed",
      "run.failed",
    ]);
    store.close();
  });

  test("no-cache still records run history without reading or writing the reuse cache", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow();
    let calls = 0;

    await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "first" };
      },
    });
    const second = await runWorkflow(workflow, {
      store,
      cache: false,
      executeTask: async () => {
        calls += 1;
        return { summary: "second" };
      },
    });

    expect(calls).toBe(2);
    expect(second.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.output).toEqual({ summary: "second" });
    expect(store.listRunTasks(second.runId!)[0]?.output).toEqual({ summary: "second" });
    expect(store.listRunEvents(second.runId!).map((event) => event.type)).toEqual([
      "run.started",
      "task.started",
      "task.cache_lookup.skipped",
      "task.executor.started",
      "task.executor.completed",
      "task.decode.started",
      "task.decode.completed",
      "task.finish.completed",
      "task.completed",
      "run.completed",
    ]);
    expect(store.getCompleted(workflowTaskIdentity(workflow.name, workflow.tasks[0]!))?.output).toEqual({ summary: "first" });
    store.close();
  });

  test("ledger preserves completed tasks before a later decode failure", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: Output,
    });
    const review = defineTask({
      id: "review",
      agent: reviewer,
      prompt: "Review the slice.",
      output: ReviewOutput,
      finish: { maxRepairs: 0 },
    });
    const workflow = defineWorkflow({ name: "partial-failure-smoke", tasks: [build, review] as const });

    await expect(runWorkflow(workflow, {
      store,
      executeTask: async (task) => task.id === "build"
        ? { summary: "built" }
        : { verdict: "needs-work" },
    })).rejects.toThrow(WorkflowTaskDecodeError);

    const runId = store.listRuns()[0]!.runId;
    expect(store.listRuns()[0]?.status).toBe("failed");
    expect(store.listRunTasks(runId)).toEqual([
      {
        runId,
        ordinal: 0,
        taskId: "build",
        cacheKey: "build",
        status: "completed",
        cached: false,
        agent: { plugin: "forge", name: "builder" },
        output: { summary: "built" },
        metadata: contractMetadata,
      },
      {
        runId,
        ordinal: 1,
        taskId: "review",
        cacheKey: "review",
        status: "failed",
        cached: false,
        agent: { plugin: "forge", name: "reviewer" },
        output: { verdict: "needs-work" },
        metadata: contractMetadata,
      },
    ]);
    expect(store.listRunEvents(runId).map((event) => event.type)).toEqual([
      "run.started",
      "task.started",
      "task.cache_lookup.started",
      "task.cache_lookup.miss",
      "task.executor.started",
      "task.executor.completed",
      "task.decode.started",
      "task.decode.completed",
      "task.finish.completed",
      "task.cache_write.completed",
      "task.completed",
      "task.started",
      "task.cache_lookup.started",
      "task.cache_lookup.miss",
      "task.executor.started",
      "task.executor.completed",
      "task.decode.started",
      "task.decode.failed",
      "task.failed",
      "run.failed",
    ]);
    store.close();
  });

  test("empty workflows emit start and completion events", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = defineWorkflow({ name: "empty-smoke", tasks: [] as const });

    const result = await runWorkflow(workflow, {
      store,
      executeTask: async () => ({ summary: "unused" }),
    });

    expect(result.tasks).toEqual([]);
    expect(store.listRuns()[0]?.status).toBe("completed");
    expect(store.listRunEvents(result.runId!).map((event) => event.type)).toEqual(["run.started", "run.completed"]);
    store.close();
  });

  test("changing the prompt breaks the task cache", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    let calls = 0;

    await runWorkflow(createWorkflow({ prompt: "Build the slice." }), {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "first" };
      },
    });
    const second = await runWorkflow(createWorkflow({ prompt: "Build the changed slice." }), {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "second" };
      },
    });

    expect(calls).toBe(2);
    expect(second.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.output).toEqual({ summary: "second" });
    store.close();
  });

  test("changing the agent manifest hash breaks the task cache", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    let calls = 0;

    await runWorkflow(createWorkflow(), {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "first" };
      },
    });
    const second = await runWorkflow(createWorkflow({
      agent: { ...builder, manifestHash: "c".repeat(64) },
    }), {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "second" };
      },
    });

    expect(calls).toBe(2);
    expect(second.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.output).toEqual({ summary: "second" });
    store.close();
  });

  test("changing the task worker breaks the task cache", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    let calls = 0;

    await runWorkflow(createWorkflow({ worker: "grok" }), {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "first" };
      },
    });
    const second = await runWorkflow(createWorkflow({ worker: "codex-cli" }), {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "second" };
      },
    });

    expect(calls).toBe(2);
    expect(second.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.output).toEqual({ summary: "second" });
    store.close();
  });

  test("volatile continuation metadata does not participate in task cache identity", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    let calls = 0;
    const workflow = createWorkflow({ worker: "claude-code" });

    await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        calls += 1;
        return {
          output: { summary: "cached result" },
          metadata: {
            adapter: "claude-code",
            sessionId: "volatile-session-1",
          },
        };
      },
    });
    const second = await runWorkflow(workflow, {
      store,
      executeTask: async () => {
        calls += 1;
        return {
          output: { summary: "should not execute" },
          metadata: {
            adapter: "claude-code",
            sessionId: "volatile-session-2",
          },
        };
      },
    });

    expect(calls).toBe(1);
    expect(second.tasks[0]).toMatchObject({
      cached: true,
      output: { summary: "cached result" },
      metadata: {
        adapter: "claude-code",
        sessionId: "volatile-session-1",
        cachedFrom: "workflow_task_records",
      },
    });
    store.close();
  });

  test("worker execution semantics participate in task cache identity", () => {
    const workflow = createWorkflow({ worker: "grok", model: "grok-build" });
    const task = workflow.tasks[0]!;
    const identity = workflowTaskIdentity(workflow.name, task);
    const preSemanticsHash = computeContentHash(JSON.stringify({
      prompt: task.prompt,
      worker: task.worker?.worker ?? null,
      model: task.worker?.model ?? null,
      outputSchema: (task.output as { readonly ast?: unknown }).ast ?? null,
      finish: {
        maxRepairs: task.finish?.maxRepairs ?? 0,
        criteria: task.finish?.criteria?.map((criterion) => criterion.name) ?? [],
      },
    }));

    expect(identity.promptHash).not.toBe(preSemanticsHash);
  });

  test("changing finish criterion logic breaks the task cache", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    let calls = 0;
    const firstFinish: WorkflowFinishOptions<{ summary: string }> = {
      criteria: [{
        name: "summary-prefix",
        check: ({ output }) => output.summary.startsWith("first")
          ? Effect.void
          : Effect.fail(new Error("summary must start with first")),
      }],
    };
    const secondFinish: WorkflowFinishOptions<{ summary: string }> = {
      criteria: [{
        name: "summary-prefix",
        check: ({ output }) => output.summary.startsWith("second")
          ? Effect.void
          : Effect.fail(new Error("summary must start with second")),
      }],
    };

    await runWorkflow(createWorkflow({ finish: firstFinish }), {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "first output" };
      },
    });
    const second = await runWorkflow(createWorkflow({ finish: secondFinish }), {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "second output" };
      },
    });

    expect(calls).toBe(2);
    expect(second.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.output).toEqual({ summary: "second output" });
    store.close();
  });

  test("changing the task model breaks the task cache", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    let calls = 0;

    await runWorkflow(createWorkflow({ worker: "grok", model: "grok-build" }), {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "first" };
      },
    });
    const second = await runWorkflow(createWorkflow({ worker: "grok", model: "grok-composer-2.5-fast" }), {
      store,
      executeTask: async () => {
        calls += 1;
        return { summary: "second" };
      },
    });

    expect(calls).toBe(2);
    expect(second.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.output).toEqual({ summary: "second" });
    store.close();
  });

  test("changing the fallback worker breaks the task cache", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    let calls = 0;

    await runWorkflow(createWorkflow(), {
      store,
      runtimeOptions: { fallbackWorker: "grok" },
      executeTask: async () => {
        calls += 1;
        return { summary: "first" };
      },
    });
    const second = await runWorkflow(createWorkflow(), {
      store,
      runtimeOptions: { fallbackWorker: "codex-cli" },
      executeTask: async () => {
        calls += 1;
        return { summary: "second" };
      },
    });

    expect(calls).toBe(2);
    expect(second.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.output).toEqual({ summary: "second" });
    store.close();
  });

  test("changing the fallback model breaks the task cache", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    let calls = 0;

    await runWorkflow(createWorkflow(), {
      store,
      runtimeOptions: { fallbackWorker: "grok", fallbackModel: "grok-build" },
      executeTask: async () => {
        calls += 1;
        return { summary: "first" };
      },
    });
    const second = await runWorkflow(createWorkflow(), {
      store,
      runtimeOptions: { fallbackWorker: "grok", fallbackModel: "grok-composer-2.5-fast" },
      executeTask: async () => {
        calls += 1;
        return { summary: "second" };
      },
    });

    expect(calls).toBe(2);
    expect(second.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.output).toEqual({ summary: "second" });
    store.close();
  });

  test("prompt hash is produced via canonical stableJsonHash pipeline (key-order and non-ASCII stable)", () => {
    // Verify: promptHash equals what stableJsonHash would produce, not what a raw JSON.stringify would.
    // This proves key-order independence: stableJsonHash sorts keys before hashing.
    const workflow = createWorkflow({ worker: "grok", model: "grok-build" });
    const task = workflow.tasks[0]!;
    const identity = workflowTaskIdentity(workflow.name, task);
    const outputSchema = (task.output as { readonly ast?: unknown }).ast ?? null;

    // Construct the same payload as workflowTaskIdentity does internally in canonical order.
    const canonicalOrder = {
      identityVersion: 2,
      workerJsonContractVersion: WORKFLOW_WORKER_JSON_CONTRACT_VERSION,
      workerJsonInstructionSource: WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE,
      prompt: task.prompt,
      worker: task.worker?.worker ?? null,
      workerSemantics: "native-agent-v1",
      model: task.worker?.model ?? null,
      profile: task.worker?.profile ?? null,
      outputSchema,
      finish: { maxRepairs: task.finish?.maxRepairs ?? 0, criteria: task.finish?.criteria?.map((criterion) => ({
        kind: criterion.kind ?? "deterministic",
        name: criterion.name,
        ...(criterion.kind === "judge"
          ? {
            goal: typeof criterion.goal === "function" ? criterion.goal.toString() : criterion.goal ?? null,
            selectEvidence: criterion.selectEvidence?.toString() ?? null,
            evaluate: criterion.evaluate.toString(),
          }
          : {
            check: criterion.check.toString(),
            repairPrompt: criterion.repairPrompt?.toString() ?? null,
          }),
      })) ?? [] },
    };

    // Build the same payload in a reversed key order to prove stableJsonHash is key-order independent.
    const reversedOrder = {
      finish: canonicalOrder.finish,
      outputSchema: canonicalOrder.outputSchema,
      profile: canonicalOrder.profile,
      model: canonicalOrder.model,
      workerSemantics: canonicalOrder.workerSemantics,
      worker: canonicalOrder.worker,
      prompt: canonicalOrder.prompt,
      workerJsonInstructionSource: canonicalOrder.workerJsonInstructionSource,
      workerJsonContractVersion: canonicalOrder.workerJsonContractVersion,
      identityVersion: canonicalOrder.identityVersion,
    };

    // Raw JSON.stringify is insertion-order dependent and produces different strings.
    const rawCanonical = computeContentHash(JSON.stringify(canonicalOrder));
    const rawReversed = computeContentHash(JSON.stringify(reversedOrder));
    expect(rawCanonical).not.toBe(rawReversed);

    // stableJsonHash is key-order independent — both orderings must hash identically.
    const stableCanonical = stableJsonHash(canonicalOrder as Parameters<typeof stableJsonHash>[0]);
    const stableReversed = stableJsonHash(reversedOrder as Parameters<typeof stableJsonHash>[0]);
    expect(stableCanonical).toBe(stableReversed);

    // The identity promptHash must equal the stable hash, proving it uses stableJsonHash.
    expect(identity.promptHash).toBe(stableCanonical);
    expect(identity.promptHash).toBe(stableReversed);
  });
});
