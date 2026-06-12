import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("workflow loader", () => {
  test("loads a workflow module and summarizes its tasks", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, workflowSource());

    const summary = await validateWorkflowFile(file);

    expect(summary.name).toBe("loader-smoke");
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
      runs: Array<{ runId: string; workflow: string }>;
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

    expect(listResult.runs).toEqual([{ runId: runResult.runId, workflow: "loader-smoke" }]);
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
  });
});
