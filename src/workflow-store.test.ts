import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { runWorkflow, WorkflowTaskDecodeError } from "./workflow-runner.js";
import { WorkflowStore, workflowTaskIdentity } from "./workflow-store.js";
import { defineTask, defineWorkflow, type WorkflowAgentRef } from "./workflows.js";

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

const createWorkflow = (options?: { readonly prompt?: string; readonly agent?: WorkflowAgentRef }) => {
  const build = defineTask({
    id: "build",
    agent: options?.agent ?? builder,
    prompt: options?.prompt ?? "Build the slice.",
    output: Output,
    cacheKey: "builder-cache",
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
    });

    expect(store.getCompleted(identity)?.output).toEqual({ summary: "stored" });
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
      },
    ]);
    expect(store.listRunTasks(secondRunId)).toEqual([
      {
        runId: secondRunId,
        taskId: "build",
        cacheKey: "builder-cache",
        status: "completed",
        cached: true,
        agent: { plugin: "forge", name: "builder" },
        output: { summary: "first" },
      },
    ]);
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
      },
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
      },
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
      },
      {
        runId,
        taskId: "review",
        cacheKey: "review",
        status: "failed",
        cached: false,
        agent: { plugin: "forge", name: "reviewer" },
        output: { verdict: "needs-work" },
      },
    ]);
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
});
