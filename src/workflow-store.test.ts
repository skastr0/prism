import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { runWorkflow } from "./workflow-runner.js";
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

const Output = Schema.Struct({ summary: Schema.String });

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
