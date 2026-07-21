import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { runWorkflow, WorkflowTaskDecodeError } from "./workflow-runner.js";
import { WorkflowStore } from "./workflow-store.js";
import { defineTask, defineWorkflow } from "./workflows.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("task phase events never outrun their attempt rows and decode failures retain evidence (Quasar #44)", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-ledger-ordering-"));
  roots.push(root);
  const store = await WorkflowStore.open(join(root, "workflows.sqlite"), { applyDefaultRetention: false });
  const task = defineTask({
    id: "build",
    agent: {
      kind: "agent-ref",
      plugin: "forge",
      name: "builder",
      description: "Build specialist",
      sourceHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
      installs: ["codex-cli"],
    },
    prompt: "Build the slice.",
    output: Schema.Struct({ summary: Schema.String }),
    cacheKey: "build-cache",
    finish: { maxDecodeRepairs: 0 },
  });
  const workflow = defineWorkflow({ name: "ledger-ordering", tasks: [task] as const });

  await expect(runWorkflow(workflow, {
    store,
    executeTask: async () => ({ notSummary: "schema-invalid-output" }),
  })).rejects.toThrow(WorkflowTaskDecodeError);

  const runId = store.listRuns()[0]?.runId;
  expect(runId).toBeString();
  const events = store.listRunEvents(runId!);
  const indexOf = (type: string): number => events.findIndex((event) => event.type === type);
  expect(indexOf("task.attempt.started")).toBeGreaterThanOrEqual(0);
  expect(indexOf("task.attempt.started")).toBeLessThan(indexOf("task.executor.started"));
  expect(indexOf("task.attempt.failed")).toBeGreaterThanOrEqual(0);
  expect(indexOf("task.attempt.failed")).toBeLessThan(indexOf("task.decode.failed"));
  const decodeFailure = events.find((event) => event.type === "task.decode.failed");
  expect(decodeFailure?.payload).toMatchObject({
    attempt: 0,
    attemptedOutput: { notSummary: "schema-invalid-output" },
  });
  expect(decodeFailure?.payload).not.toEqual({});
  expect(store.listRunTaskAttempts(runId!)).toMatchObject([
    { taskId: "build", status: "failed", failure: { kind: "decode" } },
  ]);
  store.close();
}, 15_000);
