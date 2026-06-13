import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { runWorkflow, WorkflowTaskDecodeError } from "./workflow-runner.js";
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
        { id: "build", agent: { plugin: "forge", name: "builder" }, output: { summary: "built" }, cached: false },
        { id: "review", agent: { plugin: "forge", name: "simplicity-reviewer" }, output: { verdict: "pass" }, cached: false },
      ],
    });
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
      run: async (wf) => {
        const patch = await wf.runTask(build);
        const review = defineTask({
          id: "review",
          agent: reviewer,
          prompt: `Review this patch: ${patch.summary}`,
          output: ReviewReport,
        });
        const verdict = await wf.runTask(review);
        return { reviewed: patch.summary, verdict: verdict.verdict };
      },
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
      run: async (wf) => {
        const [slowOutput, fastOutput] = await Promise.all([
          wf.runTask(slow),
          wf.runTask(fast),
        ]);
        return { slow: slowOutput.summary, fast: fastOutput.verdict };
      },
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
});
