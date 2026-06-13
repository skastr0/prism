import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkflowFile, WorkflowLoadError } from "./workflow-loader.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-loader-"));
  tempRoots.push(root);
  return root;
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

const buildOutput = Schema.Struct({ summary: Schema.String });
const reviewOutput = Schema.Struct({ verdict: Schema.Literal("pass") });

export default defineWorkflow({
  name: "dynamic-loader-smoke",
  run: async (wf) => {
    const build = await wf.runTask(defineTask({
      id: "build",
      agent: builder,
      prompt: "Build the next slice.",
      output: buildOutput,
      cacheKey: "dynamic-build",
    }));
    const review = await wf.runTask(defineTask({
      id: "review",
      agent: builder,
      prompt: \`Review: \${build.summary}\`,
      output: reviewOutput,
      cacheKey: "dynamic-review",
    }));
    return { summary: build.summary, verdict: review.verdict };
  },
});
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
