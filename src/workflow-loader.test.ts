import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkflowFile, WorkflowLoadError } from "./workflow-loader.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-loader-"));
  tempRoots.push(root);
  return root;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error("timed out waiting for condition");
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const workflowSource = (exportKind: "default" | "named" = "default") => {
  const effectPath = join(process.cwd(), "node_modules", "effect", "dist", "esm", "index.js")
    .replace(/\\/g, "/");
  const prismPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");
  return `
import { Schema } from ${JSON.stringify(effectPath)};
import { defineTask, defineWorkflow } from ${JSON.stringify(prismPath)};

const builder = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourcePath: "/plugins/forge/agents/builder.agent.ts",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
};

const output = Schema.Struct({ summary: Schema.String });
const build = defineTask({
  id: "build",
  agent: builder,
  prompt: "Build the next slice.",
  output,
  cacheKey: "workflow-loader-build",
});

const workflow = defineWorkflow({ name: "loader-smoke", tasks: [build] });
${exportKind === "default" ? "export default workflow;" : "export { workflow };"}
`;
};

const dynamicWorkflowSource = () => {
  const effectPath = join(process.cwd(), "node_modules", "effect", "dist", "esm", "index.js")
    .replace(/\\/g, "/");
  const prismPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");
  return `
import { Effect, Schema } from ${JSON.stringify(effectPath)};
import { defineTask, defineWorkflow } from ${JSON.stringify(prismPath)};

const builder = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourcePath: "/plugins/forge/agents/builder.agent.ts",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
};

const buildOutput = Schema.Struct({ summary: Schema.String });
const reviewOutput = Schema.Struct({ verdict: Schema.Literal("pass") });

export default defineWorkflow({
  name: "dynamic-loader-smoke",
  run: (wf) => Effect.gen(function* () {
    const build = yield* wf.runTask(defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the next slice.",
      output: buildOutput,
      cacheKey: "dynamic-build",
    }));
    const review = yield* wf.runTask(defineTask({
      id: "review",
      agent: builder,
      prompt: \`Review: \${build.summary}\`,
      output: reviewOutput,
      cacheKey: "dynamic-review",
    }));
    return { summary: build.summary, verdict: review.verdict };
  }),
});
`;
};

const workerModelWorkflowSource = () => {
  const effectPath = join(process.cwd(), "node_modules", "effect", "dist", "esm", "index.js")
    .replace(/\\/g, "/");
  const prismPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");
  return `
import { Schema } from ${JSON.stringify(effectPath)};
import { defineTask, defineWorkflow } from ${JSON.stringify(prismPath)};

const builder = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourcePath: "/plugins/forge/agents/builder.agent.ts",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
};

const output = Schema.Struct({ summary: Schema.String });
const build = defineTask({
  id: "build",
  agent: builder,
  prompt: "Build with explicit model.",
  output,
  cacheKey: "model-build",
  worker: { model: "grok-build" },
});
const review = defineTask({
  id: "review",
  agent: builder,
  prompt: "Review with CLI fallback model.",
  output,
  cacheKey: "model-review",
});

export default defineWorkflow({ name: "worker-model-smoke", tasks: [build, review] });
`;
};

describe("workflow loader", () => {
  test("loads a workflow module and summarizes its tasks", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, workflowSource());

    const summary = await validateWorkflowFile(file);

    expect(summary.name).toBe("loader-smoke");
    expect(summary.dynamic).toBe(false);
    expect(summary.tasks).toEqual([
      {
        id: "build",
        agent: { plugin: "forge", name: "builder" },
        cacheKey: "workflow-loader-build",
      },
    ]);
  });

  test("loads a named workflow export", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, workflowSource("named"));

    const summary = await validateWorkflowFile(file);

    expect(summary.name).toBe("loader-smoke");
    expect(summary.tasks[0]?.agent).toEqual({ plugin: "forge", name: "builder" });
  });

  test("loads a dynamic workflow module", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, dynamicWorkflowSource());

    const summary = await validateWorkflowFile(file);

    expect(summary.name).toBe("dynamic-loader-smoke");
    expect(summary.dynamic).toBe(true);
    expect(summary.tasks).toEqual([]);
  });

  test("rejects modules that do not export a workflow definition", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, "export default { kind: 'not-a-workflow' };\n");

    await expect(validateWorkflowFile(file)).rejects.toThrow(WorkflowLoadError);
  });

  test("CLI validates a workflow module", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, workflowSource());

    const processHandle = Bun.spawn({
      cmd: [process.execPath, "run", join(process.cwd(), "src", "cli.ts"), "workflow", "validate", file],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const summary = JSON.parse(stdout) as { name: string; tasks: Array<{ id: string }> };
    expect(summary.name).toBe("loader-smoke");
    expect(summary.tasks[0]?.id).toBe("build");
  });

  test("CLI runs a workflow with mock outputs and decodes them", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const outputFile = join(root, "outputs.json");
    const storeFile = join(root, "workflows.sqlite");
    await writeFile(file, workflowSource());
    await writeFile(outputFile, JSON.stringify({ build: { summary: "mocked" } }));

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--mock-output",
        outputFile,
        "--store",
        storeFile,
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as { workflow: string; tasks: Array<{ output: { summary: string } }> };
    expect(result.workflow).toBe("loader-smoke");
    expect(result.tasks[0]?.output.summary).toBe("mocked");
  });

  test("CLI runs a dynamic workflow with decoded upstream output in downstream prompt", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const outputFile = join(root, "outputs.json");
    const storeFile = join(root, "workflows.sqlite");
    await writeFile(file, dynamicWorkflowSource());
    await writeFile(outputFile, JSON.stringify({
      build: { summary: "dynamic build" },
      review: { verdict: "pass" },
    }));

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--mock-output",
        outputFile,
        "--store",
        storeFile,
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as {
      output: { summary: string; verdict: string };
      tasks: Array<{ id: string; output: unknown }>;
    };
    expect(result.output).toEqual({ summary: "dynamic build", verdict: "pass" });
    expect(result.tasks.map((task) => task.id)).toEqual(["build", "review"]);
  });

  test("CLI mock run reuses cached task output from the store", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const firstOutputFile = join(root, "first.json");
    const secondOutputFile = join(root, "second.json");
    const storeFile = join(root, "workflows.sqlite");
    await writeFile(file, workflowSource());
    await writeFile(firstOutputFile, JSON.stringify({ build: { summary: "first" } }));
    await writeFile(secondOutputFile, JSON.stringify({ build: { summary: "second" } }));

    const run = async (outputFile: string) => {
      const processHandle = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          join(process.cwd(), "src", "cli.ts"),
          "workflow",
          "run",
          file,
          "--mock-output",
          outputFile,
          "--store",
          storeFile,
        ],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as { tasks: Array<{ output: { summary: string }; cached: boolean }> };
    };

    const first = await run(firstOutputFile);
    const second = await run(secondOutputFile);

    expect(first.tasks[0]?.cached).toBe(false);
    expect(second.tasks[0]?.cached).toBe(true);
    expect(second.tasks[0]?.output.summary).toBe("first");
  });

  test("CLI runs a workflow through the Grok worker and reuses its cached output", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "grok-calls.txt");
    const fakeGrok = join(root, "fake-grok.mjs");
    await writeFile(file, workflowSource());
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, 'called\\n');`,
      "console.log(JSON.stringify({ summary: 'from grok' }));",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);

    const run = async () => {
      const processHandle = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          join(process.cwd(), "src", "cli.ts"),
          "workflow",
          "run",
          file,
          "--store",
          storeFile,
        ],
        cwd: process.cwd(),
        env: { ...process.env, PRISM_WORKFLOW_GROK_BIN: fakeGrok },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as { tasks: Array<{ output: { summary: string }; cached: boolean; metadata?: { adapter?: string } }> };
    };

    const first = await run();
    const second = await run();
    const calls = await Bun.file(callsFile).text();

    expect(first.tasks[0]?.cached).toBe(false);
    expect(first.tasks[0]?.output.summary).toBe("from grok");
    expect(first.tasks[0]?.metadata?.adapter).toBe("grok-cli");
    expect(second.tasks[0]?.cached).toBe(true);
    expect(second.tasks[0]?.output.summary).toBe("from grok");
    expect(calls.trim().split("\n")).toHaveLength(1);
  });

  test("CLI rejects unsupported workflow workers from the adapter registry", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    await writeFile(file, workflowSource());

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "not-real",
        "--store",
        storeFile,
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unsupported workflow worker 'not-real'. Supported workers: codex-cli, grok");
  });

  test("CLI runs a workflow through the Codex worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "codex-calls.jsonl");
    const fakeCodex = join(root, "fake-codex.mjs");
    await writeFile(file, workerModelWorkflowSource());
    await writeFile(fakeCodex, [
      "#!/usr/bin/env node",
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const outputIndex = process.argv.indexOf('--output-last-message');",
      "const cdIndex = process.argv.indexOf('--cd');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;",
      "const cwd = cdIndex >= 0 ? process.argv[cdIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command: process.argv[2], model, cwd }) + '\\n');`,
      "if (!outputPath) throw new Error('missing --output-last-message');",
      "writeFileSync(outputPath, JSON.stringify({ summary: model }));",
      "console.log('ignored stdout');",
      "",
    ].join("\n"));
    await chmod(fakeCodex, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "codex-cli",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_CODEX_BIN: fakeCodex },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as { tasks: Array<{ output: { summary: string }; metadata?: { adapter?: string; model?: string } }> };
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "gpt-5.5-codex"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["codex-cli", "codex-cli"]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["grok-build", "gpt-5.5-codex"]);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { command: string; model: string; cwd: string });
    expect(calls).toEqual([
      { command: "exec", model: "grok-build", cwd: expectedCwd },
      { command: "exec", model: "gpt-5.5-codex", cwd: expectedCwd },
    ]);
  });

  test("CLI fails Codex runs when --output-last-message is missing", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeCodex = join(root, "fake-codex-missing-output.mjs");
    await writeFile(file, workflowSource());
    await writeFile(fakeCodex, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ summary: 'stdout fallback must not be used' }));",
      "",
    ].join("\n"));
    await chmod(fakeCodex, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "codex-cli",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_CODEX_BIN: fakeCodex },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("codex did not write --output-last-message");
  });

  test("CLI detaches a workflow run and leaves it inspectable by run id", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "detached-grok-calls.txt");
    const fakeGrok = join(root, "fake-grok.mjs");
    await writeFile(file, workflowSource());
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "await new Promise((resolve) => setTimeout(resolve, 1200));",
      `appendFileSync(${JSON.stringify(callsFile)}, 'called\\n');`,
      "console.log(JSON.stringify({ summary: 'detached' }));",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);
    const cli = async (args: string[]) => {
      const processHandle = Bun.spawn({
        cmd: [process.execPath, "run", join(process.cwd(), "src", "cli.ts"), ...args],
        cwd: root,
        env: { ...process.env, PRISM_WORKFLOW_GROK_BIN: fakeGrok },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as unknown;
    };

    const started = Date.now();
    const runResult = await cli([
      "workflow",
      "run",
      file,
      "--detach",
      "--store",
      storeFile,
    ]) as { runId: string; workflow: string; status: string; detached: boolean };
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(runResult).toEqual({
      runId: expect.any(String),
      workflow: "loader-smoke",
      status: "running",
      detached: true,
    });

    await waitFor(async () => {
      const listResult = await cli(["workflow", "runs", "list", "--store", storeFile]) as {
        runs: Array<{ runId: string; status: string }>;
      };
      return listResult.runs.find((run) => run.runId === runResult.runId)?.status === "completed";
    });

    const showResult = await cli(["workflow", "runs", "show", runResult.runId, "--store", storeFile]) as {
      tasks: Array<{ taskId: string; output: { summary: string } }>;
    };
    const eventsResult = await cli(["workflow", "runs", "events", runResult.runId, "--store", storeFile]) as {
      events: Array<{ type: string }>;
    };

    expect(showResult.tasks).toMatchObject([{ taskId: "build", output: { summary: "detached" } }]);
    expect(eventsResult.events.map((event) => event.type).at(-1)).toBe("run.completed");
    expect((await Bun.file(callsFile).text()).trim()).toBe("called");
  });

  test("CLI rejects user supplied workflow run ids", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const outputFile = join(root, "outputs.json");
    const storeFile = join(root, "workflows.sqlite");
    await writeFile(file, workflowSource());
    await writeFile(outputFile, JSON.stringify({ build: { summary: "manual" } }));

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--run-id",
        "manual-run-id",
        "--mock-output",
        outputFile,
        "--store",
        storeFile,
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--run-id is reserved for Prism's internal detached runner");

    const forgedProcess = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--run-id",
        "manual-run-id",
        "--run-token",
        "wrong-token",
        "--mock-output",
        outputFile,
        "--store",
        storeFile,
      ],
      cwd: process.cwd(),
      env: { ...process.env, PRISM_WORKFLOW_DETACHED_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [forgedExitCode, forgedStderr] = await Promise.all([
      forgedProcess.exited,
      new Response(forgedProcess.stderr).text(),
    ]);

    expect(forgedExitCode).not.toBe(0);
    expect(forgedStderr).toContain("invalid detached workflow run handoff");
  });

  test("CLI uses task-level worker models before the CLI fallback model", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "grok-models.txt");
    const fakeGrok = join(root, "fake-grok.mjs");
    await writeFile(file, workerModelWorkflowSource());
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, model + '\\n');`,
      "console.log(JSON.stringify({ summary: model }));",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--store",
        storeFile,
        "--model",
        "grok-composer-2.5-fast",
      ],
      cwd: process.cwd(),
      env: { ...process.env, PRISM_WORKFLOW_GROK_BIN: fakeGrok },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as { tasks: Array<{ output: { summary: string }; metadata?: { model?: string } }> };
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "grok-composer-2.5-fast"]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["grok-build", "grok-composer-2.5-fast"]);
    expect((await Bun.file(callsFile).text()).trim().split("\n")).toEqual(["grok-build", "grok-composer-2.5-fast"]);
  });

  test("CLI lists and shows workflow run history", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const outputFile = join(root, "outputs.json");
    const storeFile = join(root, "workflows.sqlite");
    await writeFile(file, workflowSource());
    await writeFile(outputFile, JSON.stringify({ build: { summary: "history" } }));

    const cli = async (args: string[]) => {
      const processHandle = Bun.spawn({
        cmd: [process.execPath, "run", join(process.cwd(), "src", "cli.ts"), ...args],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as unknown;
    };

    const runResult = await cli([
      "workflow",
      "run",
      file,
      "--mock-output",
      outputFile,
      "--store",
      storeFile,
    ]) as { runId: string };
    const listResult = await cli(["workflow", "runs", "list", "--store", storeFile]) as {
      runs: Array<{ runId: string; workflow: string; status: string; finishedAt: string | null }>;
    };
    const showResult = await cli(["workflow", "runs", "show", runResult.runId, "--store", storeFile]) as {
      tasks: Array<{
        runId: string;
        taskId: string;
        cacheKey: string;
        status: string;
        cached: boolean;
        agent: { plugin: string; name: string };
        output: { summary: string };
      }>;
    };
    const eventsResult = await cli(["workflow", "runs", "events", runResult.runId, "--store", storeFile]) as {
      events: Array<{ type: string; taskId: string | null }>;
    };

    expect(listResult.runs).toEqual([
      { runId: runResult.runId, workflow: "loader-smoke", status: "completed", finishedAt: expect.any(String) },
    ]);
    expect(showResult.tasks).toEqual([
      {
        runId: runResult.runId,
        taskId: "build",
        cacheKey: "workflow-loader-build",
        status: "completed",
        cached: false,
        agent: { plugin: "forge", name: "builder" },
        output: { summary: "history" },
      },
    ]);
    expect(eventsResult.events.map((event) => event.type)).toEqual([
      "run.started",
      "task.started",
      "task.cache_lookup.started",
      "task.cache_lookup.miss",
      "task.executor.started",
      "task.executor.completed",
      "task.decode.started",
      "task.decode.completed",
      "task.cache_write.completed",
      "task.completed",
      "run.completed",
    ]);
  });
});
