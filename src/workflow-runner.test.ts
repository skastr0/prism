import { describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Fiber, Schema } from "effect";
import { compareCodePoint } from "@skastr0/prism-sdk/stable-json";
import { WorkflowStore } from "./workflow-store.js";
import { workflowTaskIdentity } from "./workflow-identity.js";
import {
  runWorkflow,
  DEFAULT_WORKFLOW_MAX_PROMPT_BYTES,
  WorkflowCostExceededError,
  WorkflowCostUnavailableError,
  WorkflowFanoutExceededError,
  WorkflowRunStoppedError,
  WorkflowRunTimeoutError,
  WorkflowPromptLimitError,
  WorkflowTaskDecodeError,
  WorkflowTaskEscalatedError,
  WorkflowTaskNoProgressError,
} from "./workflow-runner.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction, WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";
import { createWorkflowWorkerExecutor } from "./workflow-workers.js";
import {
  DEFAULT_WORKFLOW_DECODE_REPAIRS,
  defineTask,
  defineWorkflow,
  type PhaseContract,
  type WorkflowAgentRef,
} from "./workflows.js";

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
  test("public API runs an in-memory workflow from outside a Prism project directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-sdk-"));
    const script = join(root, "run-in-memory.mjs");
    const prismSpecifier = new URL("./index.ts", import.meta.url).href;
    const effectSpecifier = import.meta.resolve("effect");

    await writeFile(script, `
import { Schema } from ${JSON.stringify(effectSpecifier)};
import { defineTask, defineWorkflow, runWorkflow } from ${JSON.stringify(prismSpecifier)};

const agent = {
  kind: "agent-ref",
  plugin: "sdk-test",
  name: "worker",
  description: "Stub worker",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["codex-cli"],
};

const task = defineTask({
  id: "summarize",
  agent,
  prompt: "Summarize the input.",
  output: Schema.Struct({ summary: Schema.String }),
});

const workflow = defineWorkflow({ name: "in-memory-sdk-smoke", tasks: [task] });
const result = await runWorkflow(workflow, {
  executeTask: async () => ({ summary: "ran outside project" }),
});

console.log(JSON.stringify(result));
`);

    try {
      const proc = Bun.spawn({
        cmd: ["bun", script],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PRISM_HOME: join(root, "prism-home"),
        },
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout) as unknown;
      expect(result).toMatchObject({
        runId: null,
        workflow: "in-memory-sdk-smoke",
        tasks: [
          {
            id: "summarize",
            agent: { plugin: "sdk-test", name: "worker" },
            output: { summary: "ran outside project" },
            cached: false,
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
        { id: "build", agent: { plugin: "forge", name: "builder" }, output: { summary: "built" }, cached: false, status: "completed", metadata: contractMetadata },
        { id: "review", agent: { plugin: "forge", name: "simplicity-reviewer" }, output: { verdict: "pass" }, cached: false, status: "completed", metadata: contractMetadata },
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
      finish: { maxRepairs: 0, maxDecodeRepairs: 0 },
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

  test("rejects invalid decode and finish repair budgets before any executor invocation", async () => {
    const invalidBudgets = [
      { name: "maxRepairs" as const, value: -1 },
      { name: "maxRepairs" as const, value: 0.5 },
      { name: "maxRepairs" as const, value: Number.NaN },
      { name: "maxRepairs" as const, value: Number.POSITIVE_INFINITY },
      { name: "maxDecodeRepairs" as const, value: -1 },
      { name: "maxDecodeRepairs" as const, value: 0.5 },
      { name: "maxDecodeRepairs" as const, value: Number.NaN },
      { name: "maxDecodeRepairs" as const, value: Number.POSITIVE_INFINITY },
    ];

    for (const { name, value } of invalidBudgets) {
      const valid = defineTask({
        id: "valid",
        agent: builder,
        prompt: "This task must not execute.",
        output: PatchReport,
      });
      const finish = name === "maxRepairs" ? { maxRepairs: value } : { maxDecodeRepairs: value };
      const invalid = defineTask({
        id: "invalid",
        agent: builder,
        prompt: "This task must not execute either.",
        output: PatchReport,
        finish,
      });
      const workflow = defineWorkflow({
        name: `invalid-${name}-${String(value)}`,
        tasks: [valid, invalid] as const,
      });
      let executorCalls = 0;

      await expect(runWorkflow(workflow, {
        executeTask: async () => {
          executorCalls += 1;
          return { summary: "unexpected" };
        },
      })).rejects.toThrow(`finish.${name} must be a finite non-negative integer`);

      expect(executorCalls).toBe(0);
    }
  });

  test("accepts zero decode and finish repair budgets", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: { maxRepairs: 0, maxDecodeRepairs: 0 },
    });
    const workflow = defineWorkflow({ name: "zero-repair-budgets", tasks: [build] as const });
    let executorCalls = 0;

    const result = await runWorkflow(workflow, {
      executeTask: async () => {
        executorCalls += 1;
        return { summary: "built" };
      },
    });

    expect(executorCalls).toBe(1);
    expect(result.tasks[0]?.status).toBe("completed");
    expect(result.tasks[0]?.metadata?.finish).toMatchObject({
      repairs: 0,
      decodeRepairs: 0,
      finishRepairs: 0,
    });
  });

  test("defaults finish criterion repair allowance to zero", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: {
        criteria: [{
          name: "always-fails",
          check: () => Effect.fail(new Error("finish rejected")),
          repairPrompt: () => "This repair must not run.",
        }],
      },
    });
    const workflow = defineWorkflow({ name: "default-zero-finish-repairs", tasks: [build] as const });
    let executorCalls = 0;

    await expect(runWorkflow(workflow, {
      executeTask: async () => {
        executorCalls += 1;
        return { summary: "rejected" };
      },
    })).rejects.toThrow("failed finish criterion 'always-fails': finish rejected");

    expect(executorCalls).toBe(1);
  });

  test("keeps decode and finish repair budgets independent with monotonic executor attempts", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: {
        maxDecodeRepairs: 1,
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
    const workflow = defineWorkflow({ name: "independent-repair-budgets", tasks: [build] as const });
    const prompts: string[] = [];
    const executorAttempts: Array<number | undefined> = [];
    const repairCriteria: Array<string | undefined> = [];

    const result = await runWorkflow(workflow, {
      executeTask: async (task, context) => {
        prompts.push(task.prompt);
        executorAttempts.push(context?.repair?.attempt);
        repairCriteria.push(context?.repair?.criterion);
        if (prompts.length === 1) {
          return { output: parseWorkflowWorkerJsonOutput('{"summary":"bad\\q"}') };
        }
        return prompts.length === 2 ? { summary: "built" } : { summary: "done built" };
      },
    });

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("Your previous response was not valid JSON");
    expect(prompts[2]).toContain("Your summary must include the word done.");
    expect(executorAttempts).toEqual([undefined, 1, 2]);
    expect(repairCriteria).toEqual([undefined, "output-json-parse", "mentions-done"]);
    expect(result.tasks[0]?.output).toEqual({ summary: "done built" });
    expect(result.tasks[0]?.metadata?.finish).toMatchObject({
      repairs: 2,
      decodeRepairs: 1,
      finishRepairs: 1,
      repairAttempts: [
        expect.objectContaining({ attempt: 1, criterion: "output-json-parse" }),
        expect.objectContaining({ attempt: 2, criterion: "mentions-done" }),
      ],
    });
  });

  test("bounds decode repair exhaustion without borrowing from the finish budget", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: { maxDecodeRepairs: 1, maxRepairs: 3 },
    });
    const workflow = defineWorkflow({ name: "decode-repair-exhaustion", tasks: [build] as const });
    let executorCalls = 0;

    await expect(runWorkflow(workflow, {
      executeTask: async () => {
        executorCalls += 1;
        return { wrong: "shape" };
      },
    })).rejects.toThrow(WorkflowTaskDecodeError);

    expect(executorCalls).toBe(2);
  });

  test("bounds and persists exhausted finish repairs without borrowing from the decode budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-finish-exhaustion-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const build = defineTask({
        id: "build",
        agent: builder,
        prompt: "Build the slice.",
        output: PatchReport,
        finish: {
          maxDecodeRepairs: 3,
          maxRepairs: 1,
          criteria: [{
            name: "always-fails",
            check: () => Effect.fail(new Error("finish rejected")),
            repairPrompt: () => "Try the finish criterion again.",
          }],
        },
      });
      const workflow = defineWorkflow({ name: "finish-repair-exhaustion", tasks: [build] as const });
      const runId = store.createRun(workflow.name);
      let executorCalls = 0;

      await expect(runWorkflow(workflow, {
        runId,
        store,
        executeTask: async () => {
          executorCalls += 1;
          return { summary: "still rejected" };
        },
      })).rejects.toThrow("failed finish criterion 'always-fails': finish rejected");

      expect(executorCalls).toBe(2);
      expect(store.listRunTaskAttempts(runId).map((attempt) => ({
        attempt: attempt.attempt,
        status: attempt.status,
        kind: attempt.failure?.kind,
      }))).toEqual([
        { attempt: 1, status: "failed", kind: "finish" },
        { attempt: 2, status: "failed", kind: "finish" },
      ]);
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        terminalCause: {
          kind: "task-failed",
          taskId: "build",
          ordinal: 0,
          attempt: 2,
          errorName: "Error",
          message: "workflow task build failed finish criterion 'always-fails': finish rejected",
        },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("includes the effective decode repair allowance in task cache identity", () => {
    const base = {
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
    } as const;
    const omitted = defineTask(base);
    const explicitDefault = defineTask({
      ...base,
      finish: { maxDecodeRepairs: DEFAULT_WORKFLOW_DECODE_REPAIRS },
    });
    const disabled = defineTask({
      ...base,
      finish: { maxDecodeRepairs: 0 },
    });

    expect(workflowTaskIdentity("repair-identity", omitted).promptHash).toBe(
      workflowTaskIdentity("repair-identity", explicitDefault).promptHash,
    );
    expect(workflowTaskIdentity("repair-identity", disabled).promptHash).not.toBe(
      workflowTaskIdentity("repair-identity", omitted).promptHash,
    );
  });

  test("repairs malformed worker JSON before failing the task", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: { maxDecodeRepairs: 1 },
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
      "if (args.includes('--help')) { console.log('--add-dir --print --model --log-file --conversation --print-timeout --sandbox --dangerously-skip-permissions'); process.exit(0); }",
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

  test("re-prompts a named harness via a fresh invocation when continuation metadata is missing", async () => {
    // PQ-166 fix (2): a missing session id must fall back to a fresh executor invocation
    // carrying the original prompt + repair instruction, never a `repair requires stable
    // sessionId` abort.
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-runner-"));
    const fakeClaude = join(root, "fake-claude-fallback.mjs");
    const callsFile = join(root, "claude-fallback-calls.jsonl");
    const oldBin = process.env.PRISM_WORKFLOW_CLAUDE_BIN;
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const resumeIndex = args.indexOf('--resume');",
      "const agentIndex = args.indexOf('--agent');",
      "const prompt = args.at(-1);",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ resume: resumeIndex >= 0 ? args[resumeIndex + 1] : undefined, agent: agentIndex >= 0 ? args[agentIndex + 1] : undefined, prompt }) + '\\n');`,
      // Never emits session_id, so repair cannot resume; the fresh re-prompt is detectable
      // because the runner appends the repair instruction onto the original prompt.
      "const repaired = prompt.includes('did not satisfy the task finish requirements');",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ summary: repaired ? 'ok after repair' : 'bad' }), is_error: false, duration_ms: 10, num_turns: 1 }));",
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
      const result = await runWorkflow(workflow, {
        executeTask: createWorkflowWorkerExecutor({ worker: "claude-code", cwd: root }),
      });

      const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { resume?: string; agent?: string; prompt: string });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.resume).toBeUndefined();
      // The repair is a fresh invocation: no --resume, but a full re-prompt carrying the
      // original task prompt and the repair instruction.
      expect(calls[1]?.resume).toBeUndefined();
      expect(calls[1]?.agent).toBe("builder");
      expect(calls[1]?.prompt).toContain("Build the slice.");
      expect(calls[1]?.prompt).toContain("summary must start with ok");
      expect(result.tasks[0]?.status).toBe("completed");
      expect(result.tasks[0]?.output).toEqual({ summary: "ok after repair" });
      expect(result.tasks[0]?.metadata?.finish).toMatchObject({
        repairs: 1,
        repairMode: "fresh-executor-invocation",
      });
      expect(result.tasks[0]?.metadata?.repairExecution).toMatchObject({
        mode: "fresh-executor-invocation",
        fallbackReason: "missing-session-id",
      });
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

  test("validates run budget options before dispatch", async () => {
    const task = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
    const workflow = defineWorkflow({ name: "invalid-run-budgets", tasks: [task] as const });
    const invalid = [
      { maxWallMs: 0 },
      { maxWallMs: 1.5 },
      { taskNoProgressMs: Number.POSITIVE_INFINITY },
      { maxTasks: -1 },
      { maxPromptBytes: 0 },
      { maxPromptBytes: 1.5 },
      { maxCostUsd: -0.01 },
      { maxCostUsd: Number.NaN },
    ] as const;
    let calls = 0;

    for (const budget of invalid) {
      await expect(runWorkflow(workflow, {
        ...budget,
        executeTask: async () => {
          calls += 1;
          return { summary: "unexpected" };
        },
      })).rejects.toBeInstanceOf(RangeError);
    }
    expect(calls).toBe(0);
  });

  test("fails a hard wall timeout with its exact cause and ignores late executor settlement", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-wall-budget-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
      const workflow = defineWorkflow({ name: "wall-budget", tasks: [task] as const });
      const runId = store.createRun(workflow.name);
      const run = runWorkflow(workflow, {
        runId,
        store,
        maxWallMs: 20,
        executeTask: async () => {
          await delay(70);
          throw new Error("late executor rejection");
        },
      });

      await expect(run).rejects.toEqual(new WorkflowRunTimeoutError(20));
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        terminalCause: { kind: "workflow-timeout", limitMs: 20 },
      });
      const settledAttempts = store.listRunTaskAttempts(runId);
      expect(settledAttempts).toEqual([
        expect.objectContaining({
          status: "failed",
          failure: { kind: "executor", message: "workflow exceeded maxWallMs of 20ms" },
        }),
      ]);
      await delay(80);
      expect(store.listRunTaskAttempts(runId)).toEqual(settledAttempts);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resets per-attempt progress and then fails on inactivity", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-progress-budget-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    let fakeNow = 10_000;
    const dateNow = spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      // WFE-009: pin to a single attempt — idle timeout is a classified-transient executor
      // failure and would otherwise be retried once by the new default budget, doubling
      // progressReports/elapsed time and breaking this test's attempt-count assertions.
      const task = defineTask({
        id: "build",
        agent: builder,
        prompt: "Build.",
        output: PatchReport,
        worker: { retry: { maxAttempts: 1 } },
      });
      const workflow = defineWorkflow({ name: "task-progress-budget", tasks: [task] as const });
      const runId = store.createRun(workflow.name);
      let progressReports = 0;
      let reportAfterSettlement: (() => void) | undefined;
      const startedAt = performance.now();
      let caught: unknown;
      try {
        await runWorkflow(workflow, {
          runId,
          store,
          taskNoProgressMs: 100,
          executeTask: async (_task, context) => {
            reportAfterSettlement = context?.reportProgress;
            for (let index = 0; index < 8; index += 1) {
              await delay(8);
              fakeNow += 500;
              // Runtime callers can bypass TypeScript; arbitrary strings must never enter
              // the durable event payload as worker output or user-provided content.
              context?.reportProgress?.(index === 0 ? "private-payload" as never : "worker-stdout");
              progressReports += 1;
            }
            return await new Promise<never>(() => undefined);
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toEqual(new WorkflowTaskNoProgressError("build", 100));
      expect(progressReports).toBe(8);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(150);
      fakeNow += 6_000;
      reportAfterSettlement?.();
      const progressEvents = store.listRunEvents(runId)
        .filter((event) => event.type === "task.progress");
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0]).toMatchObject({
        taskId: "build",
        payload: { source: "executor" },
        createdAt: expect.any(String),
      });
      expect(JSON.stringify(progressEvents[0]?.payload)).not.toContain("Build.");
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        terminalCause: {
          kind: "task-failed",
          taskId: "build",
          ordinal: 0,
          attempt: 1,
          errorName: "WorkflowTaskNoProgressError",
          message: "workflow task build made no progress for 100ms",
        },
      });
    } finally {
      dateNow.mockRestore();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not spend live fanout budget on a cache hit", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-cache-fanout-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const cachedTask = defineTask({ id: "cached", agent: builder, prompt: "Cached.", output: PatchReport });
      const liveTask = defineTask({ id: "live", agent: builder, prompt: "Live.", output: PatchReport });
      const workflow = defineWorkflow({
        name: "cache-free-fanout",
        run: (wf) => Effect.all([wf.runTask(cachedTask), wf.runTask(liveTask)], { concurrency: "unbounded" }),
      });
      store.recordCompleted({
        identity: workflowTaskIdentity(workflow.name, cachedTask, {}),
        agent: { plugin: builder.plugin, name: builder.name },
        output: { summary: "cached" },
      });
      const calls: string[] = [];

      const result = await runWorkflow(workflow, {
        store,
        maxTasks: 1,
        executeTask: async (task) => {
          calls.push(task.id);
          return { summary: "live" };
        },
      });

      expect(calls).toEqual(["live"]);
      expect(result.tasks.map(({ id, cached }) => ({ id, cached }))).toEqual([
        { id: "cached", cached: true },
        { id: "live", cached: false },
      ]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cuts off concurrent fanout inside the limiter with an exact run cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-fanout-budget-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const tasks = Array.from({ length: 4 }, (_, index) =>
        defineTask({ id: `task-${index}`, agent: builder, prompt: `Run ${index}.`, output: PatchReport }));
      const workflow = defineWorkflow({
        name: "concurrent-fanout-budget",
        run: (wf) => Effect.all(tasks.map((task) => wf.runTask(task)), { concurrency: "unbounded" }),
      });
      const runId = store.createRun(workflow.name);
      const calls: string[] = [];

      await expect(runWorkflow(workflow, {
        runId,
        store,
        maxConcurrentTasks: 2,
        maxTasks: 2,
        executeTask: async (task, context) => {
          calls.push(task.id);
          if (task.id === "task-0") {
            await delay(10);
            return { summary: task.id };
          }
          const signal = context?.abortSignal;
          return await new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(signal?.reason);
            if (signal?.aborted === true) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      })).rejects.toEqual(new WorkflowFanoutExceededError(2, 3));

      expect(calls).toEqual(["task-0", "task-1"]);
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        terminalCause: { kind: "workflow-fanout-exceeded", limit: 2, observed: 3 },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cuts off cost after canonical attempt metadata and persists the exact total", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-cost-budget-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const tasks = Array.from({ length: 3 }, (_, index) =>
        defineTask({ id: `task-${index}`, agent: builder, prompt: `Run ${index}.`, output: PatchReport }));
      const workflow = defineWorkflow({
        name: "cost-budget",
        run: (wf) => Effect.all(tasks.map((task) => wf.runTask(task)), { concurrency: "unbounded" }),
      });
      const runId = store.createRun(workflow.name);
      let calls = 0;

      await expect(runWorkflow(workflow, {
        runId,
        store,
        maxConcurrentTasks: 1,
        maxCostUsd: 1,
        executeTask: async (task) => {
          calls += 1;
          return { output: { summary: task.id }, metadata: { usage: { costUsd: 0.6 } } };
        },
      })).rejects.toEqual(new WorkflowCostExceededError(1, 1.2));

      expect(calls).toBe(2);
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        terminalCause: { kind: "workflow-cost-exceeded", limitUsd: 1, observedUsd: 1.2 },
        usage: { agentRuns: 2, reused: 0, costUsd: 1.2 },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when maxCostUsd is set but a live attempt does not report cost", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-cost-unavailable-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
      const workflow = defineWorkflow({ name: "cost-unavailable", tasks: [task] as const });
      const runId = store.createRun(workflow.name);
      let calls = 0;

      await expect(runWorkflow(workflow, {
        runId,
        store,
        maxCostUsd: 1,
        executeTask: async () => {
          calls += 1;
          return {
            output: { summary: "built" },
            metadata: { usage: { inputTokens: 12, outputTokens: 4 } },
          };
        },
      })).rejects.toEqual(new WorkflowCostUnavailableError(1));

      expect(calls).toBe(1);
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        terminalCause: { kind: "workflow-cost-unavailable", limitUsd: 1 },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an oversized prepared prompt context before invoking an executor", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-prompt-budget-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({
        id: "oversized",
        agent: builder,
        prompt: "x".repeat(DEFAULT_WORKFLOW_MAX_PROMPT_BYTES),
        output: PatchReport,
      });
      const workflow = defineWorkflow({ name: "prompt-budget", tasks: [task] as const });
      const runId = store.createRun(workflow.name);
      const observedBytes = Buffer.byteLength(
        `${task.prompt}${workflowWorkerJsonInstruction(task)}`,
        "utf8",
      );
      let calls = 0;

      await expect(runWorkflow(workflow, {
        runId,
        store,
        executeTask: async () => {
          calls += 1;
          return { summary: "unexpected" };
        },
      })).rejects.toEqual(
        new WorkflowPromptLimitError(task.id, DEFAULT_WORKFLOW_MAX_PROMPT_BYTES, observedBytes),
      );

      expect(calls).toBe(0);
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        terminalCause: {
          kind: "workflow-prompt-limit-exceeded",
          taskId: task.id,
          limitBytes: DEFAULT_WORKFLOW_MAX_PROMPT_BYTES,
          observedBytes,
        },
      });
      expect(store.listRunTaskAttempts(runId)).toEqual([]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cancels every active fan-out executor before rejecting an unisolated task failure", async () => {
    const blockers = ["block-a", "block-b", "block-c"].map((id) => defineTask({
      id,
      agent: builder,
      prompt: `Block ${id}.`,
      output: PatchReport,
    }));
    const failure = defineTask({
      id: "fail",
      agent: builder,
      prompt: "Fail immediately.",
      output: PatchReport,
    });
    const later = defineTask({
      id: "later",
      agent: builder,
      prompt: "Must not start.",
      output: PatchReport,
    });
    const workflow = defineWorkflow({
      name: "unisolated-fanout-cancellation",
      run: (wf) => Effect.gen(function* () {
        yield* Effect.all(
          [...blockers.map((task) => wf.runTask(task)), wf.runTask(failure)],
          { concurrency: "unbounded" },
        );
        return yield* wf.runTask(later);
      }),
    });
    const started: string[] = [];
    const aborted: string[] = [];
    let active = 0;
    let resolveAllAborted!: () => void;
    const allAborted = new Promise<void>((resolve) => {
      resolveAllAborted = resolve;
    });

    const run = runWorkflow(workflow, {
      executeTask: async (task, context) => {
        started.push(task.id);
        active += 1;
        try {
          if (task.id === failure.id) throw new Error("fan-out task failed");
          if (task.id === later.id) return { summary: "unexpected" };
          const signal = context?.abortSignal;
          if (signal === undefined) throw new Error(`${task.id} did not receive an AbortSignal`);
          return await new Promise<never>((_resolve, reject) => {
            const onAbort = () => {
              aborted.push(task.id);
              if (aborted.length === blockers.length) resolveAllAborted();
              reject(new Error(`${task.id} observed run cancellation`));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        } finally {
          active -= 1;
        }
      },
    });
    const rejected = expect(run).rejects.toThrow("fan-out task failed");

    await Promise.race([
      allAborted,
      delay(1_000).then(() => {
        throw new Error("fan-out siblings did not observe cancellation within 1 second");
      }),
    ]);
    await rejected;

    expect([...aborted].sort()).toEqual(blockers.map((task) => task.id).sort());
    expect(active).toBe(0);
    expect(started).not.toContain(later.id);
    expect([...started].sort()).toEqual([...blockers.map((task) => task.id), failure.id].sort());
  });

  test("does not cancel fan-out siblings when the failing task is fault-isolated", async () => {
    const blockers = ["block-a", "block-b", "block-c"].map((id) => defineTask({
      id,
      agent: builder,
      prompt: `Block ${id}.`,
      output: PatchReport,
    }));
    const failure = defineTask({
      id: "fail",
      agent: builder,
      prompt: "Fail in isolation.",
      output: PatchReport,
    });
    const later = defineTask({
      id: "later",
      agent: builder,
      prompt: "Run after isolated fan-out.",
      output: PatchReport,
    });
    let resolveBlockers!: () => void;
    const releaseBlockers = new Promise<void>((resolve) => {
      resolveBlockers = resolve;
    });
    let resolveIsolatedFailure!: () => void;
    const isolatedFailure = new Promise<void>((resolve) => {
      resolveIsolatedFailure = resolve;
    });
    const workflow = defineWorkflow({
      name: "isolated-fanout-no-cancellation",
      run: (wf) => Effect.gen(function* () {
        const isolated = Effect.either(
          wf.runTask(failure).pipe(
            Effect.tapError(() => Effect.sync(resolveIsolatedFailure)),
          ),
        );
        yield* Effect.all(
          [...blockers.map((task) => wf.runTask(task)), isolated],
          { concurrency: "unbounded" },
        );
        return yield* wf.runTask(later);
      }),
    });
    const started: string[] = [];
    const blockerSignals: AbortSignal[] = [];
    let active = 0;

    const run = runWorkflow(workflow, {
      executeTask: async (task, context) => {
        started.push(task.id);
        active += 1;
        try {
          if (task.id === failure.id) throw new Error("isolated fan-out task failed");
          if (task.id === later.id) return { summary: "continued" };
          const signal = context?.abortSignal;
          if (signal === undefined) throw new Error(`${task.id} did not receive an AbortSignal`);
          blockerSignals.push(signal);
          await releaseBlockers;
          return { summary: task.id };
        } finally {
          active -= 1;
        }
      },
    });

    await Promise.race([
      isolatedFailure,
      delay(1_000).then(() => {
        throw new Error("task failure was not isolated within 1 second");
      }),
    ]);
    expect(blockerSignals).toHaveLength(blockers.length);
    expect(blockerSignals.every((signal) => !signal.aborted)).toBe(true);
    resolveBlockers();
    const result = await run;

    expect(result.output).toEqual({ summary: "continued" });
    expect(result.tasks.map((task) => task.id)).toEqual([
      ...blockers.map((task) => task.id),
      failure.id,
      later.id,
    ]);
    expect(result.tasks.find((task) => task.id === failure.id)?.status).toBe("failed");
    expect(blockers.every((blocker) =>
      result.tasks.find((task) => task.id === blocker.id)?.status === "completed"
    )).toBe(true);
    expect(blockerSignals.every((signal) => !signal.aborted)).toBe(true);
    expect(started).toContain(later.id);
    expect(active).toBe(0);
  });

  test("keeps queued fan-out siblings running when one limited task fails decode", async () => {
    // PQ-166 fault isolation: a decode failure no longer cancels queued siblings. Every
    // task runs to completion; the failed one is recorded, and the run does not abort.
    const tasks = Array.from({ length: 5 }, (_, index) => defineTask({
      id: `task-${index}`,
      agent: builder,
      prompt: `Run task ${index}.`,
      output: PatchReport,
      finish: { maxRepairs: 0, maxDecodeRepairs: 0 },
    }));
    const workflow = defineWorkflow({
      name: "bounded-fanout-isolation-smoke",
      run: (wf) => Effect.gen(function* () {
        return yield* Effect.all(
          tasks.map((task) => Effect.either(wf.runTask(task))),
          { concurrency: "unbounded" },
        );
      }),
    });
    const calls: string[] = [];

    const result = await runWorkflow(workflow, {
      maxConcurrentTasks: 1,
      executeTask: async (task) => {
        calls.push(task.id);
        await delay(5);
        return { wrong: task.id };
      },
    });

    expect(calls).toEqual(["task-0", "task-1", "task-2", "task-3", "task-4"]);
    expect(result.tasks.map((task) => task.id)).toEqual(["task-0", "task-1", "task-2", "task-3", "task-4"]);
    expect(result.tasks.map((task) => task.status)).toEqual(["failed", "failed", "failed", "failed", "failed"]);
    expect(result.tasks.every((task) => (task.error?.length ?? 0) > 0)).toBe(true);
  });

  test("repairs malformed schema output before yielding to downstream workflow code", async () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
      finish: { maxDecodeRepairs: 1 },
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

  test("escalates judge verdicts with exact attempt evidence in the run cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-attempt-escalate-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
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
      const runId = store.createRun(workflow.name);

      await expect(runWorkflow(workflow, {
        runId,
        store,
        executeTask: async () => ({ summary: "ambiguous" }),
      })).rejects.toThrow(WorkflowTaskEscalatedError);

      expect(store.listRunTaskAttempts(runId)).toEqual([
        expect.objectContaining({
          taskId: "build",
          ordinal: 0,
          attempt: 1,
          status: "failed",
          failure: expect.objectContaining({ kind: "finish" }),
        }),
      ]);
      expect(store.getRun(runId)).toMatchObject({
        status: "escalated",
        terminalCause: {
          kind: "task-escalated",
          taskId: "build",
          ordinal: 0,
          attempt: 1,
          errorName: "WorkflowTaskEscalatedError",
          message: "workflow task build escalated by judge criterion 'human-required': Needs human decision.",
        },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isolates a crashed fan-out task so siblings and downstream fusion complete with partial results", async () => {
    // PQ-166 fault isolation: a hard worker error (the codex exit-1 / opencode session-loss
    // class) is recorded as a failed task; siblings and the downstream fusion still run, and
    // the run completes rather than flipping to a whole-run abort.
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-fault-iso-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const leaf = (id: string) => defineTask({ id, agent: builder, prompt: `Run ${id}.`, output: PatchReport });
      // WFE-009: pin b to a single attempt — this test asserts fault isolation on the first
      // hard failure, not the new executor-retry budget (a separate, dedicated test below).
      const [a, b, c] = [
        leaf("a"),
        defineTask({ id: "b", agent: builder, prompt: "Run b.", output: PatchReport, worker: { retry: { maxAttempts: 1 } } }),
        leaf("c"),
      ];
      const fusion = defineTask({ id: "fusion", agent: reviewer, prompt: "Fuse the leaves.", output: ReviewReport });
      const workflow = defineWorkflow({
        name: "fault-isolation-crash-fanout",
        run: (wf) => Effect.gen(function* () {
          const outcomes = yield* Effect.all(
            [a, b, c].map((task) => Effect.either(wf.runTask(task))),
            { concurrency: "unbounded" },
          );
          const verdict = yield* wf.runTask(fusion);
          return { leaves: outcomes.map((outcome) => Either.isRight(outcome) ? "ok" : "failed"), verdict };
        }),
      });

      const result = await runWorkflow(workflow, {
        store,
        executeTask: async (task) => {
          if (task.id === "b") throw new Error("codex exited with 1: model/account mismatch");
          if (task.id === "fusion") return { verdict: "needs-work" };
          return { summary: task.id };
        },
      });

      expect(result.output).toMatchObject({ leaves: ["ok", "failed", "ok"], verdict: { verdict: "needs-work" } });

      const byId = new Map(result.tasks.map((task) => [task.id, task] as const));
      expect(result.tasks.filter((task) => task.status === "failed").map((task) => task.id)).toEqual(["b"]);
      expect(byId.get("b")?.error).toContain("model/account mismatch");
      expect(["a", "c", "fusion"].map((id) => byId.get(id)?.status)).toEqual(["completed", "completed", "completed"]);

      expect(result.runId).not.toBeNull();
      expect(store.getRun(result.runId!)?.status).toBe("completed");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isolates a task that exhausts decode repair while siblings and fusion complete", async () => {
    // The guaranteed-failing worker feeds fusion: it exhausts its objective decode-repair
    // budget, is recorded failed with a non-empty error, and the fusion verdict is still
    // produced from the surviving siblings.
    const leaf = (id: string) => defineTask({ id, agent: builder, prompt: `Run ${id}.`, output: PatchReport });
    const [a, b, c] = [leaf("a"), leaf("b"), leaf("c")];
    const fusion = defineTask({ id: "fusion", agent: reviewer, prompt: "Fuse the leaves.", output: ReviewReport });
    const workflow = defineWorkflow({
      name: "fault-isolation-repair-exhaustion-fanout",
      run: (wf) => Effect.gen(function* () {
        const outcomes = yield* Effect.all(
          [a, b, c].map((task) => Effect.either(wf.runTask(task))),
          { concurrency: "unbounded" },
        );
        const verdict = yield* wf.runTask(fusion);
        return { leaves: outcomes.map((outcome) => Either.isRight(outcome) ? "ok" : "failed"), verdict };
      }),
    });
    let bCalls = 0;

    const result = await runWorkflow(workflow, {
      executeTask: async (task) => {
        if (task.id === "b") {
          bCalls += 1;
          return { wrong: "shape" };
        }
        if (task.id === "fusion") return { verdict: "pass" };
        return { summary: task.id };
      },
    });

    // Attempt 0 + the two default decode repairs, all malformed.
    expect(bCalls).toBe(3);
    expect(result.output).toMatchObject({ leaves: ["ok", "failed", "ok"], verdict: { verdict: "pass" } });
    const byId = new Map(result.tasks.map((task) => [task.id, task] as const));
    expect(byId.get("b")?.status).toBe("failed");
    expect(byId.get("b")?.error).toContain("failed schema decode");
    expect(["a", "c", "fusion"].map((id) => byId.get(id)?.status)).toEqual(["completed", "completed", "completed"]);
  });

  test("carries a worker adapter's failure metadata into the event and the persisted store row (OBS-006)", async () => {
    // Before OBS-006, a hard executor failure discarded everything the adapter attached to its
    // error (stderrExcerpt/stderrTruncated/sessionId/adapter) down to bare contract metadata —
    // in both the task.executor.failed event and the persisted workflow_run_tasks row. Every
    // worker adapter's custom Error now carries this on a `metadata` property; assert the
    // runner actually reads it back out in both places.
    class FakeAdapterError extends Error {
      readonly metadata: Record<string, unknown>;
      constructor(message: string, metadata: Record<string, unknown>) {
        super(message);
        this.metadata = metadata;
      }
    }
    const failureMetadata = {
      adapter: "codex-cli",
      stderrBytes: 11,
      stderrSha256: "deadbeef",
      stderrExcerpt: "boom detail",
      stderrTruncated: false,
      sessionId: "sess-obs-006",
    };

    const root = await mkdtemp(join(tmpdir(), "prism-workflow-obs-006-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      // WFE-009: pin to a single attempt — this test asserts OBS-006 forensics carry-through
      // on the first hard failure, not the new executor-retry budget.
      const build = defineTask({
        id: "build",
        agent: builder,
        prompt: "Build the slice.",
        output: PatchReport,
        worker: { retry: { maxAttempts: 1 } },
      });
      const workflow = defineWorkflow({ name: "runner-obs-006-failure-metadata", tasks: [build] as const });

      await expect(runWorkflow(workflow, {
        store,
        executeTask: async () => {
          throw new FakeAdapterError("codex exited with 1: boom detail", failureMetadata);
        },
      })).rejects.toThrow("codex exited with 1: boom detail");

      const runId = store.listRuns()[0]?.runId;
      expect(runId).toBeDefined();

      const persistedTask = store.listRunTasks(runId!).find((row) => row.taskId === "build");
      expect(persistedTask?.metadata).toMatchObject(failureMetadata);

      const failedEvent = store.listRunEvents(runId!).find((event) => event.type === "task.executor.failed");
      expect(failedEvent?.payload).toMatchObject(failureMetadata);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("carries a worker adapter's failure metadata into an isolated fan-out result's metadata (OBS-006)", async () => {
    // The dynamic/isolated path (Effect.either(wf.runTask(...))) settles a failed task into
    // WorkflowRunTaskResult via failedTaskResult — a second, separate call site from the one
    // above that also used to drop error.metadata down to bare contract metadata.
    class FakeAdapterError extends Error {
      readonly metadata: Record<string, unknown>;
      constructor(message: string, metadata: Record<string, unknown>) {
        super(message);
        this.metadata = metadata;
      }
    }
    const leaf = (id: string) => defineTask({ id, agent: builder, prompt: `Run ${id}.`, output: PatchReport });
    // WFE-009: pin b to a single attempt — this test asserts OBS-006 forensics carry-through
    // on the first hard failure, not the new executor-retry budget.
    const [a, b] = [
      leaf("a"),
      defineTask({ id: "b", agent: builder, prompt: "Run b.", output: PatchReport, worker: { retry: { maxAttempts: 1 } } }),
    ];
    const workflow = defineWorkflow({
      name: "runner-obs-006-isolated-failure-metadata",
      run: (wf) => Effect.gen(function* () {
        const outcomes = yield* Effect.all([a, b].map((task) => Effect.either(wf.runTask(task))), { concurrency: "unbounded" });
        return { leaves: outcomes.map((outcome) => Either.isRight(outcome) ? "ok" : "failed") };
      }),
    });

    const result = await runWorkflow(workflow, {
      executeTask: async (task) => {
        if (task.id === "b") {
          throw new FakeAdapterError("grok exited with 1: session lost", {
            adapter: "grok-cli",
            stderrExcerpt: "session lost",
            sessionId: "grok-isolated-sess",
          });
        }
        return { summary: "ok" };
      },
    });

    expect(result.output).toEqual({ leaves: ["ok", "failed"] });
    const failed = result.tasks.find((task) => task.id === "b");
    expect(failed?.status).toBe("failed");
    expect(failed?.metadata).toMatchObject({
      adapter: "grok-cli",
      stderrExcerpt: "session lost",
      sessionId: "grok-isolated-sess",
    });
  });

  describe("executor-level transient-failure retry (WFE-009)", () => {
    test("retries a classified-transient non-zero-exit failure once before succeeding", async () => {
      const root = await mkdtemp(join(tmpdir(), "prism-workflow-executor-retry-exit-"));
      const store = await WorkflowStore.open(join(root, "runs.sqlite"));
      try {
        const build = defineTask({
          id: "build",
          agent: builder,
          prompt: "Build.",
          output: PatchReport,
          worker: { retry: { backoffMs: 1 } },
        });
        const workflow = defineWorkflow({ name: "executor-retry-exit-success", tasks: [build] as const });
        const runId = store.createRun(workflow.name);
        let calls = 0;

        const result = await runWorkflow(workflow, {
          runId,
          store,
          executeTask: async () => {
            calls += 1;
            if (calls === 1) throw new Error("codex exited with 1: transient blip");
            return { summary: "built" };
          },
        });

        expect(calls).toBe(2);
        expect(result.tasks[0]).toMatchObject({ status: "completed", output: { summary: "built" } });
        const attempts = store.listRunTaskAttempts(runId);
        expect(attempts).toHaveLength(2);
        expect(attempts[0]).toMatchObject({ attempt: 1, status: "failed", failure: { kind: "executor" } });
        expect(attempts[1]).toMatchObject({ attempt: 2, status: "completed" });
        expect(attempts[1]?.failure).toBeUndefined();
        const retryEvent = store.listRunEvents(runId).find((event) => event.type === "task.executor.retrying");
        expect(retryEvent?.payload).toMatchObject({ attempt: 1, executorRetries: 1 });
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    test("retries a task-local idle timeout once before succeeding", async () => {
      const root = await mkdtemp(join(tmpdir(), "prism-workflow-executor-retry-idle-"));
      const store = await WorkflowStore.open(join(root, "runs.sqlite"));
      try {
        const build = defineTask({
          id: "build",
          agent: builder,
          prompt: "Build.",
          output: PatchReport,
          worker: { retry: { backoffMs: 1 } },
        });
        const workflow = defineWorkflow({ name: "executor-retry-idle-success", tasks: [build] as const });
        const runId = store.createRun(workflow.name);
        let calls = 0;

        const result = await runWorkflow(workflow, {
          runId,
          store,
          taskNoProgressMs: 25,
          executeTask: async (_task, context) => {
            calls += 1;
            if (calls === 1) {
              // Never reports progress; the per-attempt idle-timeout controller aborts after 25ms.
              return await new Promise<never>(() => undefined);
            }
            context?.reportProgress?.();
            return { summary: "built" };
          },
        });

        expect(calls).toBe(2);
        expect(result.tasks[0]).toMatchObject({ status: "completed", output: { summary: "built" } });
        const attempts = store.listRunTaskAttempts(runId);
        expect(attempts).toHaveLength(2);
        expect(attempts[0]).toMatchObject({
          attempt: 1,
          status: "failed",
          failure: { kind: "executor", message: "workflow task build made no progress for 25ms" },
        });
        expect(attempts[1]).toMatchObject({ attempt: 2, status: "completed" });
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    test("does not retry a non-retryable (config/load-shaped) executor failure — immediate terminal", async () => {
      const root = await mkdtemp(join(tmpdir(), "prism-workflow-executor-retry-terminal-"));
      const store = await WorkflowStore.open(join(root, "runs.sqlite"));
      try {
        const build = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
        const workflow = defineWorkflow({ name: "executor-retry-non-retryable", tasks: [build] as const });
        const runId = store.createRun(workflow.name);
        let calls = 0;

        await expect(runWorkflow(workflow, {
          runId,
          store,
          executeTask: async () => {
            calls += 1;
            throw new Error("agy is incompatible with Prism workflows; missing required flags: --model");
          },
        })).rejects.toThrow("agy is incompatible with Prism workflows");

        expect(calls).toBe(1);
        const attempts = store.listRunTaskAttempts(runId);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ attempt: 1, status: "failed", failure: { kind: "executor" } });
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    test("exempts the antigravity-cli adapter from the generic retry (it already retries internally)", async () => {
      // Mind the agy adapter's own retry state machine: dedupe, don't double-retry. agy's
      // failure metadata always carries adapter: "antigravity-cli"; the generic executor
      // retry must recognize that and defer entirely to agy's own waitForAgyBackoff.
      class FakeAdapterError extends Error {
        readonly metadata: Record<string, unknown>;
        constructor(message: string, metadata: Record<string, unknown>) {
          super(message);
          this.metadata = metadata;
        }
      }
      const root = await mkdtemp(join(tmpdir(), "prism-workflow-executor-retry-agy-exempt-"));
      const store = await WorkflowStore.open(join(root, "runs.sqlite"));
      try {
        const build = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
        const workflow = defineWorkflow({ name: "executor-retry-agy-exempt", tasks: [build] as const });
        const runId = store.createRun(workflow.name);
        let calls = 0;

        await expect(runWorkflow(workflow, {
          runId,
          store,
          executeTask: async () => {
            calls += 1;
            throw new FakeAdapterError("agy exited with 1: print mode failed", { adapter: "antigravity-cli" });
          },
        })).rejects.toThrow("agy exited with 1: print mode failed");

        expect(calls).toBe(1);
        expect(store.listRunTaskAttempts(runId)).toHaveLength(1);
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    test("exhausts the executor retry budget and fails terminal after the configured attempts", async () => {
      const root = await mkdtemp(join(tmpdir(), "prism-workflow-executor-retry-exhaustion-"));
      const store = await WorkflowStore.open(join(root, "runs.sqlite"));
      try {
        const build = defineTask({
          id: "build",
          agent: builder,
          prompt: "Build.",
          output: PatchReport,
          worker: { retry: { maxAttempts: 3, backoffMs: 1 } },
        });
        const workflow = defineWorkflow({ name: "executor-retry-budget-exhaustion", tasks: [build] as const });
        const runId = store.createRun(workflow.name);
        let calls = 0;

        await expect(runWorkflow(workflow, {
          runId,
          store,
          executeTask: async () => {
            calls += 1;
            throw new Error(`codex exited with 1: blip ${calls}`);
          },
        })).rejects.toThrow("codex exited with 1: blip 3");

        expect(calls).toBe(3);
        const attempts = store.listRunTaskAttempts(runId);
        expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed", "failed"]);
        expect(store.getRun(runId)).toMatchObject({
          status: "failed",
          terminalCause: { kind: "task-failed", taskId: "build", attempt: 3 },
        });
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    test("caps executor retry backoff by the remaining process-timeout deadline", async () => {
      const root = await mkdtemp(join(tmpdir(), "prism-workflow-executor-retry-deadline-"));
      const store = await WorkflowStore.open(join(root, "runs.sqlite"));
      try {
        const build = defineTask({
          id: "build",
          agent: builder,
          prompt: "Build.",
          output: PatchReport,
          worker: { processTimeoutMs: 200, retry: { backoffMs: 10_000 } },
        });
        const workflow = defineWorkflow({ name: "executor-retry-backoff-capped", tasks: [build] as const });
        const runId = store.createRun(workflow.name);
        let calls = 0;
        const startedAt = Date.now();

        const result = await runWorkflow(workflow, {
          runId,
          store,
          executeTask: async () => {
            calls += 1;
            if (calls === 1) throw new Error("codex exited with 1: transient blip");
            return { summary: "built" };
          },
        });

        const elapsedMs = Date.now() - startedAt;
        expect(calls).toBe(2);
        expect(result.tasks[0]?.status).toBe("completed");
        // The configured 10s backoff must never be honored in full — it is capped by the
        // task's own 200ms process-timeout deadline, not the fixed backoffMs.
        expect(elapsedMs).toBeLessThan(3_000);
        const retryEvent = store.listRunEvents(runId).find((event) => event.type === "task.executor.retrying");
        expect(retryEvent).toBeDefined();
        expect((retryEvent!.payload as { readonly backoffMs: number }).backoffMs).toBeLessThanOrEqual(200);
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    test("preserves only the LAST attempt's forensics across an exhausted executor retry (WFE-009 x OBS-006)", async () => {
      class FakeAdapterError extends Error {
        readonly metadata: Record<string, unknown>;
        constructor(message: string, metadata: Record<string, unknown>) {
          super(message);
          this.metadata = metadata;
        }
      }
      const root = await mkdtemp(join(tmpdir(), "prism-workflow-executor-retry-forensics-"));
      const store = await WorkflowStore.open(join(root, "runs.sqlite"));
      try {
        const build = defineTask({
          id: "build",
          agent: builder,
          prompt: "Build.",
          output: PatchReport,
          worker: { retry: { backoffMs: 1 } },
        });
        const workflow = defineWorkflow({ name: "executor-retry-forensics", tasks: [build] as const });
        const runId = store.createRun(workflow.name);
        let calls = 0;

        await expect(runWorkflow(workflow, {
          runId,
          store,
          executeTask: async () => {
            calls += 1;
            if (calls === 1) {
              throw new FakeAdapterError("codex exited with 1: first blip", {
                adapter: "codex-cli",
                sessionId: "sess-attempt-1",
                stderrExcerpt: "first blip",
              });
            }
            throw new FakeAdapterError("codex exited with 1: second blip", {
              adapter: "codex-cli",
              sessionId: "sess-attempt-2",
              stderrExcerpt: "second blip",
            });
          },
        })).rejects.toThrow("codex exited with 1: second blip");

        expect(calls).toBe(2);
        const persistedTask = store.listRunTasks(runId).find((row) => row.taskId === "build");
        expect(persistedTask?.metadata).toMatchObject({ sessionId: "sess-attempt-2", stderrExcerpt: "second blip" });

        const failedEvent = store.listRunEvents(runId).find((event) => event.type === "task.executor.failed");
        expect(failedEvent?.payload).toMatchObject({ sessionId: "sess-attempt-2", stderrExcerpt: "second blip" });

        const attempts = store.listRunTaskAttempts(runId);
        expect(attempts.map((attempt) => ({ attempt: attempt.attempt, status: attempt.status, sessionId: attempt.sessionId }))).toEqual([
          { attempt: 1, status: "failed", sessionId: "sess-attempt-1" },
          { attempt: 2, status: "failed", sessionId: "sess-attempt-2" },
        ]);
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  test("awaits forked task fibers so a failed fork does not orphan its result or the run", async () => {
    // Effect.fork fan-out: both forked fibers are joined and their results recorded — the
    // failing fork is isolated, not orphaned, and the run completes.
    const a = defineTask({ id: "a", agent: builder, prompt: "Run a.", output: PatchReport });
    const b = defineTask({ id: "b", agent: reviewer, prompt: "Run b.", output: ReviewReport });
    const workflow = defineWorkflow({
      name: "forked-fanout-isolation",
      run: (wf) => Effect.gen(function* () {
        const fiberA = yield* Effect.fork(wf.runTask(a));
        const fiberB = yield* Effect.fork(Effect.either(wf.runTask(b)));
        const outA = yield* Fiber.join(fiberA);
        const outB = yield* Fiber.join(fiberB);
        return { a: outA.summary, b: Either.isRight(outB) ? "ok" : "failed" };
      }),
    });

    const result = await runWorkflow(workflow, {
      executeTask: async (task) => {
        if (task.id === "b") throw new Error("forked worker crash");
        return { summary: "forked-a" };
      },
    });

    expect(result.output).toEqual({ a: "forked-a", b: "failed" });
    const byId = new Map(result.tasks.map((task) => [task.id, task] as const));
    expect(byId.get("a")?.status).toBe("completed");
    expect(byId.get("b")?.status).toBe("failed");
    expect(byId.get("b")?.error).toContain("forked worker crash");
  });

  test("repairs malformed JSON on a task with no finish block using the default decode budget", async () => {
    // PQ-166 fix (3): objective decode repair is independent of the finish block, so a task
    // that declares no finish still self-heals a malformed attempt-0 on a repair attempt.
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the slice.",
      output: PatchReport,
    });
    const workflow = defineWorkflow({ name: "no-finish-decode-repair", tasks: [build] as const });
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
    expect(result.tasks[0]?.status).toBe("completed");
    expect(result.tasks[0]?.output).toEqual({ summary: "repaired" });
    expect(result.tasks[0]?.metadata?.finish).toMatchObject({ repairs: 1, criteria: [] });
  });

  test("re-prompts a continuation-less worker via a fresh invocation carrying the original prompt", async () => {
    // PQ-166 fix (2): grok/hermes/kimi-class workers that never surface a resumable session
    // must fall back to a fresh invocation carrying the original prompt + repair instruction,
    // not die with `repair requires stable sessionId`.
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-runner-grok-"));
    const fakeGrok = join(root, "fake-grok.mjs");
    const callsFile = join(root, "grok-calls.jsonl");
    const oldBin = process.env.PRISM_WORKFLOW_GROK_BIN;
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const resumeIndex = args.indexOf('-r');",
      "const prompt = args.at(-1);",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ resume: resumeIndex >= 0 ? args[resumeIndex + 1] : undefined, prompt }) + '\\n');`,
      // No sessionId in the envelope: continuation is impossible, so the repair must be fresh.
      "const repaired = prompt.includes('did not satisfy the task finish requirements');",
      "console.log(JSON.stringify({ text: JSON.stringify({ summary: repaired ? 'ok fixed' : 'bad' }), stopReason: 'complete' }));",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);
    process.env.PRISM_WORKFLOW_GROK_BIN = fakeGrok;

    try {
      const task = defineTask({
        id: "build",
        agent: builder,
        prompt: "Build the slice.",
        output: PatchReport,
        worker: { worker: "grok" },
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
      const workflow = defineWorkflow({ name: "runner-grok-fresh-repair", tasks: [task] as const });
      const result = await runWorkflow(workflow, {
        executeTask: createWorkflowWorkerExecutor({ worker: "grok", cwd: root }),
      });

      const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { resume?: string; prompt: string });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.resume).toBeUndefined();
      expect(calls[1]?.resume).toBeUndefined();
      expect(calls[1]?.prompt).toContain("Build the slice.");
      expect(calls[1]?.prompt).toContain("summary must start with ok");
      expect(result.tasks[0]?.status).toBe("completed");
      expect(result.tasks[0]?.output).toEqual({ summary: "ok fixed" });
      expect(result.tasks[0]?.metadata?.finish).toMatchObject({ repairMode: "fresh-executor-invocation" });
      expect(result.tasks[0]?.metadata?.repairExecution).toMatchObject({
        mode: "fresh-executor-invocation",
        fallbackReason: "missing-session-id",
      });
    } finally {
      if (oldBin === undefined) delete process.env.PRISM_WORKFLOW_GROK_BIN;
      else process.env.PRISM_WORKFLOW_GROK_BIN = oldBin;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("phase contract criteria attach as a default judge criterion", async () => {
    const explorer = {
      ...builder,
      name: "explorer",
      description: "Exploration specialist",
    } as const satisfies WorkflowAgentRef;

    const Exploration = Schema.Struct({
      assumption: Schema.String,
      options: Schema.Array(Schema.String),
    });

    const exploreContract = {
      name: "explore",
      orbit: "delivery",
      plugin: "core",
      agents: { explorer },
      output: Exploration,
      criteria: ["Surface at least one option", "Name the core assumption"],
    } as const satisfies PhaseContract<"explore", { readonly explorer: typeof explorer }, typeof Exploration>;

    const judgeGoals: string[] = [];
    const workflow = defineWorkflow({
      name: "runner-phase-criteria",
      run: (wf) => wf.phase(exploreContract, (ctx) => ctx.task({
        id: "scope",
        agent: ctx.agents.explorer,
        prompt: "Explore.",
        finish: {
          criteria: [{
            kind: "judge",
            name: "author-judge",
            goal: "Author criterion runs after the inherited phase contract.",
            evaluate: ({ goal }) => {
              judgeGoals.push(goal);
              return Effect.succeed({ verdict: "pass" as const });
            },
          }],
        },
      })),
    });

    const result = await runWorkflow(workflow, {
      executeTask: async () => ({ assumption: "bounded", options: ["a"] }),
    });

    expect(result.tasks[0]?.output).toEqual({ assumption: "bounded", options: ["a"] });
    expect(result.tasks[0]?.metadata?.finish).toMatchObject({
      repairs: 0,
      criteria: ["phase-contract", "author-judge"],
      judgeRuns: [
        expect.objectContaining({ criterion: "phase-contract", verdict: "pass", cached: false }),
        expect.objectContaining({ criterion: "author-judge", verdict: "pass", cached: false }),
      ],
    });
    expect(judgeGoals).toContain("Author criterion runs after the inherited phase contract.");
  });

  test("phase contract criteria fail closed on empty or trivial output", async () => {
    const explorer = {
      ...builder,
      name: "explorer",
      description: "Exploration specialist",
    } as const satisfies WorkflowAgentRef;

    const Exploration = Schema.Struct({
      assumption: Schema.String,
      options: Schema.Array(Schema.String),
    });

    const exploreContract = {
      name: "explore",
      orbit: "delivery",
      plugin: "core",
      agents: { explorer },
      output: Exploration,
      criteria: ["Surface at least one option", "Name the core assumption"],
    } as const satisfies PhaseContract<"explore", { readonly explorer: typeof explorer }, typeof Exploration>;

    const workflow = defineWorkflow({
      name: "runner-phase-criteria-fail",
      run: (wf) => wf.phase(exploreContract, (ctx) => ctx.task({
        id: "scope",
        agent: ctx.agents.explorer,
        prompt: "Explore.",
      })),
    });

    await expect(runWorkflow(workflow, {
      executeTask: async () => ({ assumption: "", options: [] }),
    })).rejects.toThrow(
      "workflow task scope failed finish criterion 'phase-contract': Phase output is empty or trivial",
    );
  });

  test("phase finish inherit:false opts out of contract criteria", async () => {
    const explorer = {
      ...builder,
      name: "explorer",
      description: "Exploration specialist",
    } as const satisfies WorkflowAgentRef;

    const Exploration = Schema.Struct({
      assumption: Schema.String,
      options: Schema.Array(Schema.String),
    });

    const exploreContract = {
      name: "explore",
      orbit: "delivery",
      plugin: "core",
      agents: { explorer },
      output: Exploration,
      criteria: ["Surface at least one option"],
    } as const satisfies PhaseContract<"explore", { readonly explorer: typeof explorer }, typeof Exploration>;

    const workflow = defineWorkflow({
      name: "runner-phase-inherit-false",
      run: (wf) => wf.phase(exploreContract, (ctx) => ctx.task({
        id: "scope",
        agent: ctx.agents.explorer,
        prompt: "Explore.",
        finish: { inherit: false },
      })),
    });

    const result = await runWorkflow(workflow, {
      executeTask: async () => ({ assumption: "bounded", options: ["a"] }),
    });

    expect(result.tasks[0]?.metadata?.finish).toBeUndefined();
  });

  test("persists one completed attempt and an exact completed run cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-attempt-success-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
      const workflow = defineWorkflow({ name: "attempt-success", tasks: [task] as const });
      const result = await runWorkflow(workflow, {
        store,
        executeTask: async () => ({
          output: { summary: "built" },
          metadata: {
            adapter: "codex-cli",
            model: "gpt-5.6-codex",
            nativeAgent: "builder",
            sessionId: "session-success",
          },
        }),
      });

      const attempts = store.listRunTaskAttempts(result.runId!);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        taskId: "build",
        ordinal: 0,
        attempt: 1,
        status: "completed",
        adapter: "codex-cli",
        model: "gpt-5.6-codex",
        nativeAgent: "builder",
        sessionId: "session-success",
      });
      expect(attempts[0]?.failure).toBeUndefined();
      expect(store.getRun(result.runId!)?.terminalCause).toEqual({ kind: "completed" });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists decode and finish repairs as three monotonic attempts pinned to the native session", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-attempt-repairs-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({
        id: "build",
        agent: builder,
        prompt: "Build.",
        output: PatchReport,
        finish: {
          maxDecodeRepairs: 1,
          maxRepairs: 1,
          criteria: [{
            name: "done",
            check: ({ output }) => output.summary.startsWith("done")
              ? Effect.void
              : Effect.fail(new Error("summary must start with done")),
            repairPrompt: () => "Start the summary with done.",
          }],
        },
      });
      const workflow = defineWorkflow({ name: "attempt-repairs", tasks: [task] as const });
      let invocation = 0;
      const repairModes: Array<string | undefined> = [];
      const result = await runWorkflow(workflow, {
        store,
        executeTask: async (_task, context) => {
          invocation += 1;
          repairModes.push(context?.repair?.mode);
          return {
            output: invocation === 1
              ? { wrong: "shape" }
              : { summary: invocation === 2 ? "built" : "done built" },
            metadata: {
              adapter: "claude-code",
              model: "claude-sonnet",
              nativeAgent: "builder",
              sessionId: "repair-session-1",
            },
          };
        },
      });

      const attempts = store.listRunTaskAttempts(result.runId!);
      expect(attempts.map(({ attempt, status, sessionId }) => ({ attempt, status, sessionId }))).toEqual([
        { attempt: 1, status: "failed", sessionId: "repair-session-1" },
        { attempt: 2, status: "failed", sessionId: "repair-session-1" },
        { attempt: 3, status: "completed", sessionId: "repair-session-1" },
      ]);
      expect(attempts.map((attempt) => attempt.failure?.kind)).toEqual(["decode", "finish", undefined]);
      expect(repairModes).toEqual([
        undefined,
        "native-continuation",
        "native-continuation",
      ]);
      expect(store.getRun(result.runId!)?.terminalCause).toEqual({ kind: "completed" });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  test("persists the new session returned by a fresh-executor repair", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-attempt-fresh-repair-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({
        id: "build",
        agent: builder,
        prompt: "Build.",
        output: PatchReport,
        finish: {
          maxRepairs: 1,
          criteria: [{
            name: "done",
            check: ({ output }) => output.summary === "done"
              ? Effect.void
              : Effect.fail(new Error("not done")),
            repairPrompt: () => "Return done.",
          }],
        },
      });
      const workflow = defineWorkflow({ name: "attempt-fresh-repair-session", tasks: [task] as const });
      let invocation = 0;
      const repairModes: Array<string | undefined> = [];
      const result = await runWorkflow(workflow, {
        store,
        executeTask: async (_task, context) => {
          invocation += 1;
          repairModes.push(context?.repair?.mode);
          return {
            output: { summary: invocation === 1 ? "retry" : "done" },
            metadata: {
              adapter: "grok",
              model: "grok-build",
              sessionId: `fresh-session-${invocation}`,
            },
          };
        },
      });

      expect(repairModes).toEqual([undefined, "fresh-executor-invocation"]);
      expect(store.listRunTaskAttempts(result.runId!).map(({ attempt, sessionId }) => ({
        attempt,
        sessionId,
      }))).toEqual([
        { attempt: 1, sessionId: "fresh-session-1" },
        { attempt: 2, sessionId: "fresh-session-2" },
      ]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists adapter failure identity, metadata, and exact failed run cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-attempt-adapter-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
      const workflow = defineWorkflow({ name: "attempt-adapter-failure", tasks: [task] as const });
      const runId = store.createRun(workflow.name);
      const adapterError = Object.assign(new Error("provider account mismatch"), {
        name: "CodexAdapterError",
        metadata: {
          adapter: "codex-cli",
          model: "gpt-5.6-codex",
          nativeAgent: "builder",
          sessionId: "adapter-session",
          exitCode: 1,
        },
      });

      await expect(runWorkflow(workflow, {
        runId,
        store,
        executeTask: async () => {
          throw adapterError;
        },
      })).rejects.toThrow("provider account mismatch");

      expect(store.listRunTaskAttempts(runId)).toEqual([
        expect.objectContaining({
          ordinal: 0,
          attempt: 1,
          taskId: "build",
          status: "failed",
          adapter: "codex-cli",
          model: "gpt-5.6-codex",
          nativeAgent: "builder",
          sessionId: "adapter-session",
          failure: { kind: "executor", message: "provider account mismatch" },
          metadata: expect.objectContaining({ exitCode: 1 }),
        }),
      ]);
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        terminalCause: {
          kind: "task-failed",
          taskId: "build",
          ordinal: 0,
          attempt: 1,
          errorName: "CodexAdapterError",
          message: "provider account mismatch",
        },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not create an attempt when a task is served from cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-attempt-cache-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
      const workflow = defineWorkflow({ name: "attempt-cache-hit", tasks: [task] as const });
      await runWorkflow(workflow, {
        store,
        executeTask: async () => ({ summary: "cached" }),
      });
      const cachedRunId = store.createRun(workflow.name);
      let executorCalls = 0;
      await runWorkflow(workflow, {
        runId: cachedRunId,
        store,
        executeTask: async () => {
          executorCalls += 1;
          throw new Error("cache miss");
        },
      });

      expect(executorCalls).toBe(0);
      expect(store.listRunTaskAttempts(cachedRunId)).toEqual([]);
      expect(store.getRun(cachedRunId)).toMatchObject({
        status: "completed",
        terminalCause: { kind: "completed" },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminalizes an author-program defect as workflow-failed rather than stopped or crashed", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-author-failure-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
      const authorError = Object.assign(new Error("author program rejected output"), {
        name: "AuthorProgramError",
      });
      const workflow = defineWorkflow({
        name: "author-program-failure",
        run: (wf) => Effect.gen(function* () {
          yield* wf.runTask(task);
          return yield* Effect.fail(authorError);
        }),
      });
      const runId = store.createRun(workflow.name);

      await expect(runWorkflow(workflow, {
        runId,
        store,
        executeTask: async () => ({ summary: "built" }),
      })).rejects.toThrow("author program rejected output");

      expect(store.listRunTaskAttempts(runId)).toEqual([
        expect.objectContaining({ taskId: "build", attempt: 1, status: "completed" }),
      ]);
      expect(store.listRunTasks(runId)).toEqual([
        expect.objectContaining({ taskId: "build", ordinal: 0, status: "completed" }),
      ]);
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        terminalCause: {
          kind: "workflow-failed",
          errorName: "AuthorProgramError",
          message: "author program rejected output",
        },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminalizes every started sibling attempt before rejecting with the originating task cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-attempt-siblings-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const blockers = ["block-a", "block-b"].map((id) =>
        defineTask({ id, agent: builder, prompt: `Block ${id}.`, output: PatchReport }));
      const failure = defineTask({ id: "fail", agent: builder, prompt: "Fail.", output: PatchReport });
      const workflow = defineWorkflow({
        name: "attempt-sibling-cancellation",
        run: (wf) => Effect.all(
          [...blockers.map((task) => wf.runTask(task)), wf.runTask(failure)],
          { concurrency: "unbounded" },
        ),
      });
      const runId = store.createRun(workflow.name);
      let blockersStarted = 0;
      let releaseFailure!: () => void;
      const blockersReady = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });

      await expect(runWorkflow(workflow, {
        runId,
        store,
        executeTask: async (task, context) => {
          if (task.id === "fail") {
            await blockersReady;
            throw Object.assign(new Error("originating failure"), { name: "AdapterFailure" });
          }
          blockersStarted += 1;
          if (blockersStarted === blockers.length) releaseFailure();
          const signal = context?.abortSignal;
          if (signal === undefined) throw new Error("missing cancellation signal");
          return await new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        },
      })).rejects.toThrow("originating failure");

      const attempts = store.listRunTaskAttempts(runId);
      expect(attempts).toHaveLength(3);
      expect(attempts.every((attempt) => attempt.status !== "running")).toBe(true);
      expect(attempts.filter((attempt) => attempt.taskId.startsWith("block")).map((attempt) => ({
        status: attempt.status,
        failure: attempt.failure,
      }))).toEqual([
        { status: "failed", failure: { kind: "executor", message: "originating failure" } },
        { status: "failed", failure: { kind: "executor", message: "originating failure" } },
      ]);
      expect(attempts.find((attempt) => attempt.taskId === "fail")).toMatchObject({
        ordinal: 2,
        attempt: 1,
        status: "failed",
        failure: { kind: "executor", message: "originating failure" },
      });
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        terminalCause: {
          kind: "task-failed",
          taskId: "fail",
          ordinal: 2,
          attempt: 1,
          errorName: "AdapterFailure",
          message: "originating failure",
        },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records an externally stopped invocation and run as stopped rather than failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-attempt-stop-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
      const workflow = defineWorkflow({ name: "attempt-external-stop", tasks: [task] as const });
      const runId = store.createRun(workflow.name);
      const controller = new AbortController();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const run = runWorkflow(workflow, {
        runId,
        store,
        abortSignal: controller.signal,
        executeTask: async (_task, context) => {
          const signal = context?.abortSignal;
          if (signal === undefined) throw new Error("missing cancellation signal");
          markStarted();
          return await new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        },
      });
      await started;
      controller.abort(Object.assign(new Error("operator stopped the run"), { signal: "SIGTERM" }));
      await expect(run).rejects.toThrow("operator stopped the run");

      expect(store.listRunTaskAttempts(runId)).toEqual([
        expect.objectContaining({
          taskId: "build",
          attempt: 1,
          status: "stopped",
          failure: { kind: "stopped", message: "operator stopped the run" },
        }),
      ]);
      expect(store.listRunTasks(runId)).toEqual([]);
      expect(store.getRun(runId)).toMatchObject({
        status: "stopped",
        terminalCause: {
          kind: "stopped",
          reason: "operator stopped the run",
          signal: "SIGTERM",
        },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves a crashed run cause while its active invocation is reconciled", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-attempt-crash-"));
    const store = await WorkflowStore.open(join(root, "runs.sqlite"));
    try {
      const task = defineTask({ id: "build", agent: builder, prompt: "Build.", output: PatchReport });
      const workflow = defineWorkflow({ name: "attempt-runner-crash", tasks: [task] as const });
      const runId = store.createRun(workflow.name);
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const run = runWorkflow(workflow, {
        runId,
        store,
        executeTask: async (_task, context) => {
          const signal = context?.abortSignal;
          if (signal === undefined) throw new Error("missing cancellation signal");
          markStarted();
          return await new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        },
      });
      await started;
      store.finishRun(runId, "crashed", {
        kind: "crashed",
        reason: "runner heartbeat expired",
        runnerPid: 41_042,
        heartbeatAt: "2026-07-13T12:00:00.000Z",
      });
      await expect(run).rejects.toThrow(WorkflowRunStoppedError);

      expect(store.listRunTaskAttempts(runId)).toEqual([
        expect.objectContaining({
          taskId: "build",
          attempt: 1,
          status: "crashed",
          failure: { kind: "crashed", message: "runner heartbeat expired" },
        }),
      ]);
      expect(store.getRun(runId)).toMatchObject({
        status: "crashed",
        terminalCause: {
          kind: "crashed",
          reason: "runner heartbeat expired",
          runnerPid: 41_042,
          heartbeatAt: "2026-07-13T12:00:00.000Z",
        },
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cache-key key sort uses the same code-point comparator as prism-sdk stable-json, not locale ordering", () => {
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
