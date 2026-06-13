import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { runWorkflow, WorkflowTaskDecodeError } from "./workflow-runner.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";
import { defineTask, defineWorkflow, type WorkflowAgentRef } from "./workflows.js";

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
  name: "simplicity-reviewer",
  description: "Simplicity reviewer",
} as const satisfies WorkflowAgentRef;

const PatchReport = Schema.Struct({ summary: Schema.String });
const ReviewReport = Schema.Struct({ verdict: Schema.Literal("pass", "needs-work") });

const contractMetadata = {
  contractVersion: WORKFLOW_WORKER_JSON_CONTRACT_VERSION,
  instructionSource: WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE,
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("workflow runner", () => {
  test("executes tasks sequentially and decodes outputs", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
    });
    const review = defineTask({
      id: "review",
      agent: reviewer,
      prompt: "Review the slice.",
      output: ReviewReport,
    });
    const workflow = defineWorkflow({ name: "runner-smoke", tasks: [build, review] as const });
    const calls: string[] = [];

    const result = await runWorkflow(workflow, {
      executeTask: async (task) => {
        calls.push(task.id);
        if (task.id === "build") return { summary: "built" };
        return { verdict: "pass" };
      },
    });

    expect(calls).toEqual(["build", "review"]);
    expect(result).toEqual({
      runId: null,
      workflow: "runner-smoke",
      tasks: [
        { id: "build", agent: { plugin: "forge", name: "builder" }, output: { summary: "built" }, cached: false, metadata: contractMetadata },
        { id: "review", agent: { plugin: "forge", name: "simplicity-reviewer" }, output: { verdict: "pass" }, cached: false, metadata: contractMetadata },
      ],
    });
    expect(result.tasks.map((task) => task.metadata)).toEqual([contractMetadata, contractMetadata]);
  });

  test("fails before handoff when task output does not decode", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
    });
    const workflow = defineWorkflow({ name: "runner-smoke", tasks: [build] as const });

    await expect(runWorkflow(workflow, {
      executeTask: async () => ({ notSummary: "wrong" }),
    })).rejects.toThrow(WorkflowTaskDecodeError);
  });

  test("does not execute downstream tasks after a decode failure", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
    });
    const review = defineTask({
      id: "review",
      agent: reviewer,
      prompt: "Review the slice.",
      output: ReviewReport,
    });
    const workflow = defineWorkflow({ name: "runner-smoke", tasks: [build, review] as const });
    const calls: string[] = [];

    await expect(runWorkflow(workflow, {
      executeTask: async (task) => {
        calls.push(task.id);
        return { notSummary: "wrong" };
      },
    })).rejects.toThrow(WorkflowTaskDecodeError);

    expect(calls).toEqual(["build"]);
  });

  test("runs dynamic workflows that construct downstream tasks from decoded outputs", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
    });
    const workflow = defineWorkflow({
      name: "dynamic-runner-smoke",
      run: (wf) => Effect.gen(function* () {
        const patch = yield* wf.runTask(build);
        const review = defineTask({
          id: "review",
          agent: reviewer,
          prompt: `Review this patch: ${patch.summary}`,
          output: ReviewReport,
        });
        const verdict = yield* wf.runTask(review);
        return { reviewed: patch.summary, verdict: verdict.verdict };
      }),
    });
    const prompts: string[] = [];

    const result = await runWorkflow(workflow, {
      executeTask: async (task) => {
        prompts.push(task.prompt);
        if (task.id === "build") return { summary: "built" };
        return { verdict: "pass" };
      },
    });

    expect(prompts).toEqual(["Build the slice.", "Review this patch: built"]);
    expect(result.output).toEqual({ reviewed: "built", verdict: "pass" });
    expect(result.tasks.map((task) => task.id)).toEqual(["build", "review"]);
  });

  test("orders dynamic fan-out results by invocation ordinal", async () => {
    const slow = defineTask({
      id: "slow",
      agent: builder,
      prompt: "Return slow output.",
      output: PatchReport,
    });
    const fast = defineTask({
      id: "fast",
      agent: reviewer,
      prompt: "Return fast output.",
      output: ReviewReport,
    });
    const workflow = defineWorkflow({
      name: "dynamic-fanout-smoke",
      run: (wf) => Effect.gen(function* () {
        const [slowOutput, fastOutput] = yield* Effect.all([
          wf.runTask(slow),
          wf.runTask(fast),
        ], { concurrency: "unbounded" });
        return { slow: slowOutput.summary, fast: fastOutput.verdict };
      }),
    });
    const completions: string[] = [];

    const result = await runWorkflow(workflow, {
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
    expect(result.output).toEqual({ slow: "slow", fast: "pass" });
  });

  test("passes mixed task-level worker models through the executor seam", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build with Grok Build.",
      output: PatchReport,
      worker: { model: "grok-build" },
    });
    const review = defineTask({
      id: "review",
      agent: reviewer,
      prompt: "Review with Composer.",
      output: ReviewReport,
      worker: { model: "grok-composer-2.5-fast" },
    });
    const workflow = defineWorkflow({
      name: "mixed-model-smoke",
      run: (wf) => Effect.gen(function* () {
        const [buildOutput, reviewOutput] = yield* Effect.all([
          wf.runTask(build),
          wf.runTask(review),
        ], { concurrency: "unbounded" });
        return { build: buildOutput.summary, review: reviewOutput.verdict };
      }),
    });
    const models: Array<string | undefined> = [];

    await runWorkflow(workflow, {
      executeTask: async (task) => {
        models.push(task.worker?.model);
        return task.id === "build" ? { summary: "built" } : { verdict: "pass" };
      },
    });

    expect(models).toEqual(["grok-build", "grok-composer-2.5-fast"]);
  });

  test("passes mixed task-level workers through the executor seam", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build with Grok.",
      output: PatchReport,
      worker: { worker: "grok", model: "grok-build" },
    });
    const review = defineTask({
      id: "review",
      agent: reviewer,
      prompt: "Review with Codex.",
      output: ReviewReport,
      worker: { worker: "codex-cli", model: "gpt-5.5-codex" },
    });
    const workflow = defineWorkflow({
      name: "mixed-worker-smoke",
      run: (wf) => Effect.gen(function* () {
        const [buildOutput, reviewOutput] = yield* Effect.all([
          wf.runTask(build),
          wf.runTask(review),
        ], { concurrency: "unbounded" });
        return { build: buildOutput.summary, review: reviewOutput.verdict };
      }),
    });
    const workers: Array<string | undefined> = [];

    await runWorkflow(workflow, {
      executeTask: async (task) => {
        workers.push(task.worker?.worker);
        return task.id === "build" ? { summary: "built" } : { verdict: "pass" };
      },
    });

    expect(workers).toEqual(["grok", "codex-cli"]);
  });

  test("bounds executor concurrency below unbounded author fan-out", async () => {
    const tasks = Array.from({ length: 5 }, (_, index) => defineTask({
      id: `task-${index}`,
      agent: builder,
      prompt: `Run task ${index}.`,
      output: PatchReport,
    }));
    const workflow = defineWorkflow({
      name: "bounded-fanout-smoke",
      run: (wf) => Effect.gen(function* () {
        return yield* Effect.all(
          tasks.map((task) => wf.runTask(task)),
          { concurrency: "unbounded" },
        );
      }),
    });
    let active = 0;
    let maxActive = 0;

    const result = await runWorkflow(workflow, {
      maxConcurrentTasks: 2,
      executeTask: async (task) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
        return { summary: task.id };
      },
    });

    expect(maxActive).toBe(2);
    expect(result.tasks.map((task) => task.id)).toEqual(["task-0", "task-1", "task-2", "task-3", "task-4"]);
  });

  test("cancels queued dynamic fan-out when the first limited task fails decode", async () => {
    const tasks = Array.from({ length: 5 }, (_, index) => defineTask({
      id: `task-${index}`,
      agent: builder,
      prompt: `Run task ${index}.`,
      output: PatchReport,
    }));
    const workflow = defineWorkflow({
      name: "bounded-fanout-failure-smoke",
      run: (wf) => Effect.gen(function* () {
        return yield* Effect.all(
          tasks.map((task) => wf.runTask(task)),
          { concurrency: "unbounded" },
        );
      }),
    });
    const calls: string[] = [];

    await expect(runWorkflow(workflow, {
      maxConcurrentTasks: 1,
      executeTask: async (task) => {
        calls.push(task.id);
        await delay(20);
        return { wrong: task.id };
      },
    })).rejects.toThrow("workflow task task-0 returned output that failed schema decode");

    expect(calls).toEqual(["task-0"]);
  });

  test("repairs malformed schema output before yielding to downstream workflow code", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: { maxRepairs: 1 },
    });
    const workflow = defineWorkflow({
      name: "repair-schema-smoke",
      run: (wf) => Effect.gen(function* () {
        const patch = yield* wf.runTask(build);
        return patch.summary;
      }),
    });
    const prompts: string[] = [];

    const result = await runWorkflow(workflow, {
      executeTask: async (task) => {
        prompts.push(task.prompt);
        if (prompts.length === 1) return { wrong: "shape" };
        return { summary: "repaired" };
      },
    });

    expect(result.output).toBe("repaired");
    expect(result.tasks[0]?.metadata?.finish).toEqual({
      repairs: 1,
      criteria: [],
      repairMode: "new-executor-invocation",
    });
    expect(prompts[1]).toContain("failed the output schema decode");
  });

  test("repairs arbitrary Effect finish criteria before completing a task", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: {
        maxRepairs: 1,
        criteria: [{
          name: "mentions-done",
          check: ({ output }) => output.summary.includes("done")
            ? Effect.void
            : Effect.fail(new Error("summary must include done")),
          repairPrompt: () => "Your summary must include the word done.",
        }],
      },
    });
    const workflow = defineWorkflow({ name: "repair-criterion-smoke", tasks: [build] as const });
    const calls: string[] = [];

    const result = await runWorkflow(workflow, {
      executeTask: async (task) => {
        calls.push(task.prompt);
        return calls.length === 1 ? { summary: "built" } : { summary: "done built" };
      },
    });

    expect(result.tasks[0]?.output).toEqual({ summary: "done built" });
    expect(result.tasks[0]?.metadata?.finish).toEqual({
      repairs: 1,
      criteria: ["mentions-done"],
      repairMode: "new-executor-invocation",
    });
    expect(calls[1]).toContain("Your summary must include the word done.");
  });
});
