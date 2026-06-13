import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { computeContentHash } from "./content-hash.js";
import { runWorkflow, WorkflowRunStoppedError, WorkflowTaskDecodeError } from "./workflow-runner.js";
import { WorkflowStore, workflowTaskIdentity } from "./workflow-store.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";
import { defineTask, defineWorkflow, type WorkflowAgentRef, type WorkflowFinishOptions } from "./workflows.js";

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
  sourcePath: "/plugins/forge/agents/builder.agent.ts",
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
  readonly worker?: string;
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

  test("dynamic fan-out failures wait for sibling task records before run failure", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = defineWorkflow({
      name: "dynamic-fanout-failure-smoke",
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
          wf.runTask(fail),
          wf.runTask(slow),
        ], { concurrency: "unbounded" });
      }),
    });
    const completions: string[] = [];

    await expect(runWorkflow(workflow, {
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
    })).rejects.toThrow("fast failure");

    const runId = store.listRuns()[0]!.runId;
    expect(completions).toEqual(["fail", "slow"]);
    expect(store.listRuns()[0]?.status).toBe("failed");
    expect(store.listRunTasks(runId).map((task) => ({ taskId: task.taskId, status: task.status }))).toEqual([
      { taskId: "fail", status: "failed" },
      { taskId: "slow", status: "completed" },
    ]);
    const events = store.listRunEvents(runId).map((event) => ({ taskId: event.taskId, type: event.type }));
    expect(events.at(-1)).toEqual({ taskId: null, type: "run.failed" });
    expect(events.some((event) => event.taskId === "slow" && event.type === "task.completed")).toBe(true);
    expect(events.findLastIndex((event) => event.type === "task.completed"))
      .toBeLessThan(events.findLastIndex((event) => event.type === "run.failed"));
    store.close();
  });

  test("runner records decode failures in run history", async () => {
    const root = await createTempRoot();
    const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
    const workflow = createWorkflow();

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
});
