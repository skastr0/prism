import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { compareCodePoint } from "@skastr0/prism-core/stable-json";
import { runWorkflow, WorkflowTaskDecodeError, WorkflowTaskEscalatedError } from "./workflow-runner.js";
import { parseWorkflowWorkerJsonOutput, WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";
import { createWorkflowWorkerExecutor } from "./workflow-workers.js";
import { defineTask, defineWorkflow, type WorkflowAgentRef } from "./workflows.js";

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
      finish: { maxRepairs: 0 },
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

  test("repairs malformed worker JSON before failing the task", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: { maxRepairs: 1 },
    });
    const workflow = defineWorkflow({ name: "runner-json-parse-repair", tasks: [build] as const });
    const prompts: string[] = [];

    const result = await runWorkflow(workflow, {
      executeTask: async (task) => {
        prompts.push(task.prompt);
        if (prompts.length === 1) {
          return { output: parseWorkflowWorkerJsonOutput('{"summary":"bad\\q"}') };
        }
        return { summary: "repaired" };
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Your previous response was not valid JSON");
    expect(prompts[1]).toContain("Invalid escape character");
    expect(prompts[1]).toContain('{"summary":"bad\\q"}');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject(
      {
        id: "build",
        agent: { plugin: "forge", name: "builder" },
        output: { summary: "repaired" },
        cached: false,
        metadata: {
          ...contractMetadata,
          finish: {
            repairs: 1,
            criteria: [],
            repairMode: "fresh-executor-invocation",
            repairAttempts: [expect.objectContaining({
              attempt: 1,
              criterion: "output-json-parse",
              mode: "fresh-executor-invocation",
              fallbackReason: "executor-does-not-advertise-continuation",
            })],
          },
        },
      },
    );
  });

  test("continues Claude repairs in the native session when a session id is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-runner-"));
    const fakeClaude = join(root, "fake-claude.mjs");
    const callsFile = join(root, "claude-calls.jsonl");
    const oldBin = process.env.PRISM_WORKFLOW_CLAUDE_BIN;
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const resumeIndex = args.indexOf('--resume');",
      "const agentIndex = args.indexOf('--agent');",
      "const prompt = args.at(-1);",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ resume: resumeIndex >= 0 ? args[resumeIndex + 1] : undefined, agent: agentIndex >= 0 ? args[agentIndex + 1] : undefined, prompt }) + '\\n');`,
      "const repaired = resumeIndex >= 0;",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ summary: repaired ? 'ok after repair' : 'bad' }), is_error: false, session_id: 'claude-session-1', duration_ms: 10, num_turns: repaired ? 2 : 1 }));",
      "",
    ].join("\n"));
    await chmod(fakeClaude, 0o755);
    process.env.PRISM_WORKFLOW_CLAUDE_BIN = fakeClaude;

    try {
      const task = defineTask({
        id: "build",
        agent: builder,
        prompt: "Build the slice.",
        output: PatchReport,
        worker: { worker: "claude-code" },
        finish: {
          maxRepairs: 1,
          criteria: [{
            name: "summary-prefix",
            check: ({ output }) => output.summary.startsWith("ok")
              ? Effect.void
              : Effect.fail(new Error("summary must start with ok")),
          }],
        },
      });
      const workflow = defineWorkflow({ name: "runner-claude-native-repair", tasks: [task] as const });
      const result = await runWorkflow(workflow, {
        executeTask: createWorkflowWorkerExecutor({ worker: "claude-code", cwd: root }),
      });

      const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { resume?: string; agent?: string; prompt: string });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ agent: "builder" });
      expect(calls[0]?.prompt).toContain("Build the slice.");
      expect(calls[1]).toMatchObject({ resume: "claude-session-1" });
      expect(calls[1]?.agent).toBeUndefined();
      expect(calls[1]?.prompt).not.toContain("Build the slice.");
      expect(calls[1]?.prompt).toContain("summary must start with ok");
      expect(result.tasks[0]?.metadata).toMatchObject({
        adapter: "claude-code",
        sessionId: "claude-session-1",
        repairExecution: {
          mode: "native-continuation",
          continuation: { adapter: "claude-code", sessionId: "claude-session-1" },
        },
        finish: {
          repairs: 1,
          repairMode: "native-continuation",
        },
      });
    } finally {
      if (oldBin === undefined) delete process.env.PRISM_WORKFLOW_CLAUDE_BIN;
      else process.env.PRISM_WORKFLOW_CLAUDE_BIN = oldBin;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("continues Antigravity repairs in the native conversation when a conversation id is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-runner-"));
    const fakeAgy = join(root, "fake-agy.mjs");
    const callsFile = join(root, "agy-calls.jsonl");
    const conversationId = "103febcc-41a4-435b-a6ed-f6992fb1c3ff";
    const oldBin = process.env.PRISM_WORKFLOW_ANTIGRAVITY_BIN;
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const conversationIndex = args.indexOf('--conversation');",
      "const logIndex = args.indexOf('--log-file');",
      "const printIndex = args.indexOf('--print');",
      "const conversation = conversationIndex >= 0 ? args[conversationIndex + 1] : undefined;",
      "const prompt = printIndex >= 0 ? args[printIndex + 1] : args.at(-1);",
      `if (logIndex >= 0) appendFileSync(args[logIndex + 1], 'I printmode.go:156] Print mode: conversation=${conversationId}, sending message\\n');`,
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ conversation, hasContinue: args.includes('--continue'), finalFlag: args.at(-2), prompt }) + '\\n');`,
      "const repaired = conversation !== undefined;",
      "console.log(JSON.stringify({ summary: repaired ? 'ok after repair' : 'bad' }));",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);
    process.env.PRISM_WORKFLOW_ANTIGRAVITY_BIN = fakeAgy;

    try {
      const task = defineTask({
        id: "build",
        agent: builder,
        prompt: "Build the slice.",
        output: PatchReport,
        worker: { worker: "antigravity-cli" },
        finish: {
          maxRepairs: 1,
          criteria: [{
            name: "summary-prefix",
            check: ({ output }) => output.summary.startsWith("ok")
              ? Effect.void
              : Effect.fail(new Error("summary must start with ok")),
          }],
        },
      });
      const workflow = defineWorkflow({ name: "runner-antigravity-native-repair", tasks: [task] as const });
      const result = await runWorkflow(workflow, {
        executeTask: createWorkflowWorkerExecutor({ worker: "antigravity-cli", cwd: root }),
      });

      const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
        conversation?: string;
        hasContinue: boolean;
        finalFlag: string;
        prompt: string;
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ hasContinue: false, finalFlag: "--print" });
      expect(calls[0]?.conversation).toBeUndefined();
      expect(calls[0]?.prompt).toContain("Build the slice.");
      expect(calls[1]).toMatchObject({ conversation: conversationId, hasContinue: false, finalFlag: "--print" });
      expect(calls[1]?.prompt).not.toContain("Build the slice.");
      expect(calls[1]?.prompt).toContain("summary must start with ok");
      expect(result.tasks[0]?.metadata).toMatchObject({
        adapter: "antigravity-cli",
        sessionId: conversationId,
        conversationId,
        continuationStrategy: "explicit-conversation-id",
        repairExecution: {
          mode: "native-continuation",
          continuation: { adapter: "antigravity-cli", sessionId: conversationId },
        },
        finish: {
          repairs: 1,
          repairMode: "native-continuation",
        },
      });
    } finally {
      if (oldBin === undefined) delete process.env.PRISM_WORKFLOW_ANTIGRAVITY_BIN;
      else process.env.PRISM_WORKFLOW_ANTIGRAVITY_BIN = oldBin;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails named harness repairs when continuation metadata is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-runner-"));
    const fakeClaude = join(root, "fake-claude-fallback.mjs");
    const callsFile = join(root, "claude-fallback-calls.jsonl");
    const oldBin = process.env.PRISM_WORKFLOW_CLAUDE_BIN;
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const resumeIndex = args.indexOf('--resume');",
      "const prompt = args.at(-1);",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ resume: resumeIndex >= 0 ? args[resumeIndex + 1] : undefined, prompt }) + '\\n');`,
	      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ summary: 'bad' }), is_error: false, duration_ms: 10, num_turns: 1 }));",
      "",
    ].join("\n"));
    await chmod(fakeClaude, 0o755);
    process.env.PRISM_WORKFLOW_CLAUDE_BIN = fakeClaude;

    try {
      const task = defineTask({
        id: "build",
        agent: builder,
        prompt: "Build the slice.",
        output: PatchReport,
        worker: { worker: "claude-code" },
        finish: {
          maxRepairs: 1,
          criteria: [{
            name: "summary-prefix",
            check: ({ output }) => output.summary.startsWith("ok")
              ? Effect.void
              : Effect.fail(new Error("summary must start with ok")),
          }],
        },
      });
	      const workflow = defineWorkflow({ name: "runner-claude-missing-session-repair", tasks: [task] as const });
	      await expect(runWorkflow(workflow, {
	        executeTask: createWorkflowWorkerExecutor({ worker: "claude-code", cwd: root }),
	      })).rejects.toThrow("repair requires stable sessionId");

	      const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { resume?: string; prompt: string });
	      expect(calls).toHaveLength(1);
	      expect(calls[0]?.resume).toBeUndefined();
    } finally {
      if (oldBin === undefined) delete process.env.PRISM_WORKFLOW_CLAUDE_BIN;
      else process.env.PRISM_WORKFLOW_CLAUDE_BIN = oldBin;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not repair ordinary executor failures", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: { maxRepairs: 1 },
    });
    const workflow = defineWorkflow({ name: "runner-executor-failure-no-repair", tasks: [build] as const });
    const calls: string[] = [];

    await expect(runWorkflow(workflow, {
      executeTask: async (task) => {
        calls.push(task.prompt);
        throw new Error("provider auth missing");
      },
    })).rejects.toThrow("provider auth missing");

    expect(calls).toEqual(["Build the slice."]);
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
        models.push(typeof task.worker?.model === "string" ? task.worker.model : undefined);
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
      finish: { maxRepairs: 0 },
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
    expect(result.tasks[0]?.metadata?.finish).toMatchObject({
      repairs: 1,
      criteria: [],
      repairMode: "fresh-executor-invocation",
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
    expect(result.tasks[0]?.metadata?.finish).toMatchObject({
      repairs: 1,
      criteria: ["mentions-done"],
      repairMode: "fresh-executor-invocation",
    });
    expect(calls[1]).toContain("Your summary must include the word done.");
  });

  test("runs judge criteria on bounded decoded output, metadata, task metadata, and selected evidence", async () => {
    const contexts: unknown[] = [];
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: {
        criteria: [{
          kind: "judge",
          name: "bounded-judge",
          goal: "Decide whether the report is shippable.",
          selectEvidence: ({ output, metadata, task }) => ({
            summary: output.summary,
            attemptId: metadata?.attemptId,
            taskId: task.id,
          }),
          evaluate: (context) => {
            contexts.push(context);
            return Effect.succeed({ verdict: "pass" as const, metadata: { score: 1 } });
          },
        }],
      },
    });
    const workflow = defineWorkflow({ name: "runner-judge-bounded", tasks: [build] as const });

    const result = await runWorkflow(workflow, {
      executeTask: async () => ({
        output: { summary: "done" },
        metadata: { attemptId: "primary-1" },
      }),
    });

    expect(result.tasks[0]?.output).toEqual({ summary: "done" });
    expect(contexts).toEqual([{
      goal: "Decide whether the report is shippable.",
      output: { summary: "done" },
      metadata: expect.objectContaining({ attemptId: "primary-1" }),
      task: {
        id: "build",
        agent: { plugin: "forge", name: "builder" },
      },
      evidence: {
        summary: "done",
        attemptId: "primary-1",
        taskId: "build",
      },
    }]);
    expect(JSON.stringify(contexts[0])).not.toContain("Build the slice.");
    expect(result.tasks[0]?.metadata?.finish).toMatchObject({
      repairs: 0,
      criteria: ["bounded-judge"],
      judgeRuns: [expect.objectContaining({ criterion: "bounded-judge", verdict: "pass", cached: false })],
    });
  });

  test("feeds judge continue feedback into the existing repair path", async () => {
    const prompts: string[] = [];
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: {
        maxRepairs: 1,
        criteria: [{
          kind: "judge",
          name: "judge-quality",
          goal: "Require a done summary.",
          selectEvidence: ({ output }) => ({ summary: output.summary }),
          evaluate: ({ output }) => Effect.succeed(
            output.summary.includes("done")
              ? { verdict: "pass" as const }
              : { verdict: "continue" as const, feedback: "Add the word done to the summary." },
          ),
        }],
      },
    });
    const workflow = defineWorkflow({ name: "runner-judge-continue", tasks: [build] as const });

    const result = await runWorkflow(workflow, {
      executeTask: async (task) => {
        prompts.push(task.prompt);
        return prompts.length === 1 ? { summary: "built" } : { summary: "done built" };
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Add the word done to the summary.");
    expect(result.tasks[0]?.output).toEqual({ summary: "done built" });
    expect(result.tasks[0]?.metadata?.finish).toMatchObject({
      repairs: 1,
      criteria: ["judge-quality"],
      repairMode: "fresh-executor-invocation",
      judgeRuns: [expect.objectContaining({ criterion: "judge-quality", verdict: "pass" })],
    });
  });

  test("escalates judge verdicts distinctly from deterministic finish failures", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: {
        criteria: [{
          kind: "judge",
          name: "human-required",
          evaluate: () => Effect.succeed({ verdict: "escalate" as const, feedback: "Needs human decision." }),
        }],
      },
    });
    const workflow = defineWorkflow({ name: "runner-judge-escalate", tasks: [build] as const });

    await expect(runWorkflow(workflow, {
      executeTask: async () => ({ summary: "ambiguous" }),
    })).rejects.toThrow(WorkflowTaskEscalatedError);
  });

  test("cache-key key sort uses the same code-point comparator as prism-core stable-json, not locale ordering", () => {
    const keys = ["b", "a", "ä", "Z"];

    const manualCodePointOrder = [...keys].sort((left, right) => {
      const normalizedLeft = left.normalize("NFC");
      const normalizedRight = right.normalize("NFC");
      if (normalizedLeft === normalizedRight) return 0;
      return normalizedLeft < normalizedRight ? -1 : 1;
    });

    // workflow-runner's stableValue() sorts object keys with this exact import (see src/workflow-runner.ts);
    // asserting it matches manual codePointAt ordering pins the cache key to a locale-independent sort.
    expect([...keys].sort(compareCodePoint)).toEqual(manualCodePointOrder);
    expect(manualCodePointOrder).toEqual(["Z", "a", "b", "ä"]);

    // The locale-sensitive comparator this replaced produces a materially different order in this
    // environment's ICU locale data — proof the fix is not a no-op.
    const localeOrder = [...keys].sort((left, right) => left.localeCompare(right));
    expect(localeOrder).not.toEqual(manualCodePointOrder);
  });
});
