import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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

const workflowSource = (
  exportKind: "default" | "named" = "default",
  options?: { readonly worker?: string; readonly model?: string },
) => {
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
  ${options?.worker !== undefined || options?.model !== undefined
    ? `worker: { ${options.worker !== undefined ? `worker: ${JSON.stringify(options.worker)},` : ""} ${options.model !== undefined ? `model: ${JSON.stringify(options.model)},` : ""} },`
    : ""}
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

const workerModelWorkflowSource = (worker?: string) => {
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
  worker: { ${worker !== undefined ? `worker: ${JSON.stringify(worker)},` : ""} model: "grok-build" },
});
const review = defineTask({
  id: "review",
  agent: builder,
  prompt: "Review with CLI fallback model.",
  output,
  cacheKey: "model-review",
  ${worker !== undefined ? `worker: { worker: ${JSON.stringify(worker)} },` : ""}
});

export default defineWorkflow({ name: "worker-model-smoke", tasks: [build, review] });
`;
};

const ampWorkerModelWorkflowSource = () => {
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
  installs: ["amp"],
};

const output = Schema.Struct({ summary: Schema.String });
const build = defineTask({
  id: "build",
  agent: builder,
  prompt: "Build with Amp deep mode.",
  output,
  cacheKey: "amp-model-build",
  worker: { worker: "amp-code", model: "deep" },
});
const review = defineTask({
  id: "review",
  agent: builder,
  prompt: "Review with Amp fallback mode.",
  output,
  cacheKey: "amp-model-review",
  worker: { worker: "amp-code" },
});

export default defineWorkflow({ name: "amp-worker-model-smoke", tasks: [build, review] });
`;
};

const antigravityWorkerModelWorkflowSource = () => {
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
  installs: ["antigravity-cli"],
};

const output = Schema.Struct({ summary: Schema.String });
const build = defineTask({
  id: "build",
  agent: builder,
  prompt: "Build with AGY Flash.",
  output,
  cacheKey: "antigravity-model-build",
  worker: { worker: "antigravity-cli", model: "Gemini 3.5 Flash (Low)" },
});
const review = defineTask({
  id: "review",
  agent: builder,
  prompt: "Review with AGY fallback model.",
  output,
  cacheKey: "antigravity-model-review",
  worker: { worker: "antigravity-cli" },
});

export default defineWorkflow({ name: "antigravity-worker-model-smoke", tasks: [build, review] });
`;
};

const workerRoutingWorkflowSource = () => {
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
  prompt: "Build with OpenCode.",
  output,
  cacheKey: "worker-routing-build",
  worker: { worker: "opencode", model: "github-copilot/gpt-5.1" },
});
const review = defineTask({
  id: "review",
  agent: builder,
  prompt: "Review with fallback worker.",
  output,
  cacheKey: "worker-routing-review",
});

export default defineWorkflow({ name: "worker-routing-smoke", tasks: [build, review] });
`;
};

const allTaskWorkersWorkflowSource = () => {
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
  prompt: "Build with OpenCode.",
  output,
  cacheKey: "all-task-workers-build",
  worker: { worker: "opencode", model: "github-copilot/gpt-5.1" },
});
const review = defineTask({
  id: "review",
  agent: builder,
  prompt: "Review with Grok.",
  output,
  cacheKey: "all-task-workers-review",
  worker: { worker: "grok", model: "grok-build" },
});

export default defineWorkflow({ name: "all-task-workers-smoke", tasks: [build, review] });
`;
};

describe("workflow loader", () => {
  test("loads a workflow module and summarizes its tasks", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, workflowSource("default", { worker: "grok" }));

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
    await writeFile(file, workflowSource("default", { worker: "opencode" }));

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
    await writeFile(file, workflowSource("default", { worker: "grok" }));
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
    await writeFile(file, workflowSource("default", { worker: "grok" }));
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
    await writeFile(file, workflowSource("default", { worker: "grok" }));
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
    expect(stderr).toContain("unsupported workflow worker 'not-real'. Supported workers: amp-code, antigravity-cli, claude-code, codex-cli, grok, hermes, opencode");
  });

  test("CLI runs a workflow through the Antigravity worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "agy-calls.jsonl");
    const fakeAgy = join(root, "fake-agy.mjs");
    await writeFile(file, antigravityWorkerModelWorkflowSource());
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const timeoutIndex = process.argv.indexOf('--print-timeout');",
      "const addDirIndex = process.argv.indexOf('--add-dir');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const printTimeout = timeoutIndex >= 0 ? process.argv[timeoutIndex + 1] : 'missing';",
      "const addDir = addDirIndex >= 0 ? process.argv[addDirIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ print: process.argv.includes('--print'), skipPermissions: process.argv.includes('--dangerously-skip-permissions'), sandbox: process.argv.includes('--sandbox'), printTimeout, addDir, model, cwd: process.cwd() }) + '\\n');`,
      "console.log(JSON.stringify({ summary: model }));",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const run = async () => {
      const processHandle = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          join(process.cwd(), "src", "cli.ts"),
          "workflow",
          "run",
          file,
          "--worker",
          "antigravity-cli",
          "--store",
          storeFile,
          "--model",
          "Gemini 3.5 Flash (High)",
        ],
        cwd: root,
        env: { ...process.env, PRISM_WORKFLOW_ANTIGRAVITY_BIN: fakeAgy, PRISM_WORKFLOW_ANTIGRAVITY_PRINT_TIMEOUT: "20s" },
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
      return JSON.parse(stdout) as {
        tasks: Array<{ output: { summary: string }; cached: boolean; metadata?: { adapter?: string; model?: string; printTimeout?: string; processTimeoutMs?: number } }>;
      };
    };

    const result = await run();
    const cachedResult = await run();
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["Gemini 3.5 Flash (Low)", "Gemini 3.5 Flash (High)"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["antigravity-cli", "antigravity-cli"]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["Gemini 3.5 Flash (Low)", "Gemini 3.5 Flash (High)"]);
    expect(result.tasks.map((task) => task.metadata?.printTimeout)).toEqual(["20s", "20s"]);
    expect(result.tasks.map((task) => task.metadata?.processTimeoutMs)).toEqual([360000, 360000]);
    expect(cachedResult.tasks.map((task) => task.cached)).toEqual([true, true]);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
      print: boolean;
      skipPermissions: boolean;
      sandbox: boolean;
      printTimeout: string;
      addDir: string;
      model: string;
      cwd: string;
    });
    expect(calls).toEqual([
      { print: true, skipPermissions: true, sandbox: true, printTimeout: "20s", addDir: expectedCwd, model: "Gemini 3.5 Flash (Low)", cwd: expectedCwd },
      { print: true, skipPermissions: true, sandbox: true, printTimeout: "20s", addDir: expectedCwd, model: "Gemini 3.5 Flash (High)", cwd: expectedCwd },
    ]);
  });

  test("CLI fails Antigravity runs when print mode reports a timeout with exit zero", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeAgy = join(root, "fake-agy-timeout.mjs");
    await writeFile(file, workflowSource("default", { worker: "antigravity-cli" }));
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "console.log('Error: timed out waiting for response');",
      "process.exit(0);",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "antigravity-cli",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_ANTIGRAVITY_BIN: fakeAgy },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("agy exited with 0: Error: timed out waiting for response");
  });

  test("CLI fails Antigravity runs when prefixed output contains an AGY error", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeAgy = join(root, "fake-agy-prefixed-error.mjs");
    await writeFile(file, workflowSource("default", { worker: "antigravity-cli" }));
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "console.log('notice before failure\\nError: timed out waiting for response');",
      "process.exit(0);",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "antigravity-cli",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_ANTIGRAVITY_BIN: fakeAgy },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("agy exited with 0: Error: timed out waiting for response");
  });

  test("CLI accepts Antigravity JSON output that contains the word Error", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeAgy = join(root, "fake-agy-error-word.mjs");
    await writeFile(file, workflowSource("default", { worker: "antigravity-cli" }));
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ summary: 'Error: handled upstream' }));",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "antigravity-cli",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_ANTIGRAVITY_BIN: fakeAgy },
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
    const result = JSON.parse(stdout) as { tasks: Array<{ output: { summary: string } }> };
    expect(result.tasks[0]?.output.summary).toBe("Error: handled upstream");
  });

  test("CLI kills Antigravity runs that exceed the Prism process timeout", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeAgy = join(root, "fake-agy-hang.mjs");
    await writeFile(file, workflowSource("default", { worker: "antigravity-cli" }));
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "await new Promise((resolve) => setTimeout(resolve, 10_000));",
      "console.log(JSON.stringify({ summary: 'too late' }));",
      "",
    ].join("\n"));
    await chmod(fakeAgy, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "antigravity-cli",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_ANTIGRAVITY_BIN: fakeAgy, PRISM_WORKFLOW_ANTIGRAVITY_PROCESS_TIMEOUT_MS: "100" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("agy exceeded Prism process timeout after 100ms");
  });

  test("CLI runs a workflow through the Amp worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "amp-calls.jsonl");
    const fakeAmp = join(root, "fake-amp.mjs");
    await writeFile(file, ampWorkerModelWorkflowSource());
    await writeFile(fakeAmp, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modeIndex = process.argv.indexOf('--mode');",
      "const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ execute: process.argv.includes('--execute'), noArchive: process.argv.includes('--no-archive-after-execute'), noIde: process.argv.includes('--no-ide'), noNotifications: process.argv.includes('--no-notifications'), noColor: process.argv.includes('--no-color'), mode, cwd: process.cwd() }) + '\\n');`,
      "console.log(JSON.stringify({ summary: mode }));",
      "",
    ].join("\n"));
    await chmod(fakeAmp, 0o755);

    const run = async () => {
      const processHandle = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          join(process.cwd(), "src", "cli.ts"),
          "workflow",
          "run",
          file,
          "--worker",
          "amp-code",
          "--store",
          storeFile,
          "--model",
          "smart",
        ],
        cwd: root,
        env: { ...process.env, PRISM_WORKFLOW_AMP_BIN: fakeAmp },
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
      return JSON.parse(stdout) as {
        tasks: Array<{ output: { summary: string }; cached: boolean; metadata?: { adapter?: string; model?: string } }>;
      };
    };

    const result = await run();
    const cachedResult = await run();
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["deep", "smart"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["amp-code", "amp-code"]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["deep", "smart"]);
    expect(cachedResult.tasks.map((task) => task.cached)).toEqual([true, true]);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
      execute: boolean;
      noArchive: boolean;
      noIde: boolean;
      noNotifications: boolean;
      noColor: boolean;
      mode: string;
      cwd: string;
    });
    expect(calls).toEqual([
      { execute: true, noArchive: true, noIde: true, noNotifications: true, noColor: true, mode: "deep", cwd: expectedCwd },
      { execute: true, noArchive: true, noIde: true, noNotifications: true, noColor: true, mode: "smart", cwd: expectedCwd },
    ]);
  });

  test("CLI fails Amp runs when execute mode exits non-zero", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeAmp = join(root, "fake-amp-error.mjs");
    await writeFile(file, workflowSource("default", { worker: "amp-code" }));
    await writeFile(fakeAmp, [
      "#!/usr/bin/env node",
      "console.error('amp auth failed');",
      "process.exit(2);",
      "",
    ].join("\n"));
    await chmod(fakeAmp, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "amp-code",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_AMP_BIN: fakeAmp },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("amp exited with 2: amp auth failed");
  });

  test("CLI runs a workflow through the Claude Code worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "claude-calls.jsonl");
    const fakeClaude = join(root, "fake-claude.mjs");
    await writeFile(file, workerModelWorkflowSource("claude-code"));
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const outputFormatIndex = process.argv.indexOf('--output-format');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const outputFormat = outputFormatIndex >= 0 ? process.argv[outputFormatIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ print: process.argv.includes('--print'), outputFormat, noSession: process.argv.includes('--no-session-persistence'), model, cwd: process.cwd() }) + '\\n');`,
      "console.log(JSON.stringify({ result: JSON.stringify({ summary: model }), is_error: false, session_id: 'claude-session', total_cost_usd: 0.01, duration_ms: 12, num_turns: 1 }));",
      "",
    ].join("\n"));
    await chmod(fakeClaude, 0o755);

    const run = async () => {
      const processHandle = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          join(process.cwd(), "src", "cli.ts"),
          "workflow",
          "run",
          file,
          "--worker",
          "claude-code",
          "--store",
          storeFile,
          "--model",
          "sonnet",
        ],
        cwd: root,
        env: { ...process.env, PRISM_WORKFLOW_CLAUDE_BIN: fakeClaude },
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
      return JSON.parse(stdout) as {
        tasks: Array<{ output: { summary: string }; cached: boolean; metadata?: { adapter?: string; model?: string; sessionId?: string; totalCostUsd?: number } }>;
      };
    };

    const result = await run();
    const cachedResult = await run();
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "sonnet"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["claude-code", "claude-code"]);
    expect(result.tasks[0]?.metadata?.sessionId).toBe("claude-session");
    expect(result.tasks[0]?.metadata?.totalCostUsd).toBe(0.01);
    expect(cachedResult.tasks.map((task) => task.cached)).toEqual([true, true]);
    expect(cachedResult.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "sonnet"]);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
      print: boolean;
      outputFormat: string;
      noSession: boolean;
      model: string;
      cwd: string;
    });
    expect(calls).toEqual([
      { print: true, outputFormat: "json", noSession: true, model: "grok-build", cwd: expectedCwd },
      { print: true, outputFormat: "json", noSession: true, model: "sonnet", cwd: expectedCwd },
    ]);
  });

  test("CLI fails Claude runs when the JSON envelope reports an error", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeClaude = join(root, "fake-claude-error.mjs");
    await writeFile(file, workflowSource("default", { worker: "claude-code" }));
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ result: 'Not logged in', is_error: true }));",
      "",
    ].join("\n"));
    await chmod(fakeClaude, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "claude-code",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_CLAUDE_BIN: fakeClaude },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("claude returned an error: Not logged in");
  });

  test("CLI fails Claude runs when the JSON envelope result is not task text", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeClaude = join(root, "fake-claude-non-string-result.mjs");
    await writeFile(file, workflowSource("default", { worker: "claude-code" }));
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ result: { summary: 'not task text' }, is_error: false }));",
      "",
    ].join("\n"));
    await chmod(fakeClaude, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "claude-code",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_CLAUDE_BIN: fakeClaude },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("claude JSON envelope did not contain a string result");
  });

  test("CLI runs a workflow through the Codex worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "codex-calls.jsonl");
    const fakeCodex = join(root, "fake-codex.mjs");
    await writeFile(file, workerModelWorkflowSource("codex-cli"));
    await writeFile(fakeCodex, [
      "#!/usr/bin/env node",
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const outputIndex = process.argv.indexOf('--output-last-message');",
      "const cdIndex = process.argv.indexOf('--cd');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;",
      "const cwd = cdIndex >= 0 ? process.argv[cdIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command: process.argv[2], model, cwd, ephemeral: process.argv.includes('--ephemeral') }) + '\\n');`,
      "if (!outputPath) throw new Error('missing --output-last-message');",
      "writeFileSync(outputPath, JSON.stringify({ summary: model }));",
      "console.error('codex noisy stderr ' + 'x'.repeat(5000) + ' tail-marker');",
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
    const result = JSON.parse(stdout) as {
      tasks: Array<{
        output: { summary: string };
        metadata?: {
          adapter?: string;
          model?: string;
          stderr?: string;
          stderrBytes?: number;
          stderrExcerpt?: string;
          stderrSha256?: string;
          stderrTruncated?: boolean;
        };
      }>;
    };
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "missing"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["codex-cli", "codex-cli"]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["grok-build", undefined]);
    expect(result.tasks[0]?.metadata?.stderr).toBeUndefined();
    expect(result.tasks[0]?.metadata?.stderrBytes).toBeGreaterThan(4096);
    expect(result.tasks[0]?.metadata?.stderrExcerpt?.length).toBeLessThanOrEqual(4096);
    expect(result.tasks[0]?.metadata?.stderrExcerpt).toContain("tail-marker");
    expect(result.tasks[0]?.metadata?.stderrSha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(result.tasks[0]?.metadata?.stderrTruncated).toBe(true);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { command: string; model: string; cwd: string; ephemeral: boolean });
    expect(calls).toEqual([
      { command: "exec", model: "grok-build", cwd: expectedCwd, ephemeral: true },
      { command: "exec", model: "missing", cwd: expectedCwd, ephemeral: true },
    ]);
  });

  test("CLI fails Codex runs when --output-last-message is missing", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeCodex = join(root, "fake-codex-missing-output.mjs");
    await writeFile(file, workflowSource("default", { worker: "codex-cli" }));
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

  test("CLI runs a workflow through the Hermes worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "hermes-calls.jsonl");
    const fakeHermes = join(root, "fake-hermes.mjs");
    await writeFile(file, workerModelWorkflowSource("hermes"));
    await writeFile(fakeHermes, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const queryIndex = process.argv.indexOf('--query');",
      "const sourceIndex = process.argv.indexOf('--source');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const query = queryIndex >= 0 ? process.argv[queryIndex + 1] : '';",
      "const source = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command: process.argv[2], model, quiet: process.argv.includes('--quiet'), source, hasInstruction: query.includes('Prism workflow task') }) + '\\n');`,
      "console.error('session_id: hermes-session-123');",
      "console.log(JSON.stringify({ summary: model }));",
      "",
    ].join("\n"));
    await chmod(fakeHermes, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "hermes",
        "--store",
        storeFile,
        "--model",
        "nous/qwen3-coder",
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_HERMES_BIN: fakeHermes },
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
      tasks: Array<{ output: { summary: string }; metadata?: { adapter?: string; model?: string; sessionId?: string } }>;
    };
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "nous/qwen3-coder"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["hermes", "hermes"]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["grok-build", "nous/qwen3-coder"]);
    expect(result.tasks.map((task) => task.metadata?.sessionId)).toEqual(["hermes-session-123", "hermes-session-123"]);

    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
      command: string;
      model: string;
      quiet: boolean;
      source: string;
      hasInstruction: boolean;
    });
    expect(calls).toEqual([
      { command: "chat", model: "grok-build", quiet: true, source: "prism-workflow", hasInstruction: true },
      { command: "chat", model: "nous/qwen3-coder", quiet: true, source: "prism-workflow", hasInstruction: true },
    ]);
  });

  test("CLI fails Hermes runs when chat exits non-zero", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeHermes = join(root, "fake-hermes-error.mjs");
    await writeFile(file, workflowSource("default", { worker: "hermes" }));
    await writeFile(fakeHermes, [
      "#!/usr/bin/env node",
      "console.error('Hermes auth missing');",
      "process.exit(2);",
      "",
    ].join("\n"));
    await chmod(fakeHermes, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "hermes",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_HERMES_BIN: fakeHermes },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("hermes exited with 2: Hermes auth missing");
  });

  test("CLI kills Hermes runs that exceed the Prism process timeout", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeHermes = join(root, "fake-hermes-hangs.mjs");
    await writeFile(file, workflowSource("default", { worker: "hermes" }));
    await writeFile(fakeHermes, [
      "#!/usr/bin/env node",
      "console.log('starting hermes hang');",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await chmod(fakeHermes, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "hermes",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: {
        ...process.env,
        PRISM_WORKFLOW_HERMES_BIN: fakeHermes,
        PRISM_WORKFLOW_HERMES_PROCESS_TIMEOUT_MS: "250",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("hermes exceeded Prism process timeout after 250ms");
  });

  test("CLI runs a workflow through the OpenCode worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "opencode-calls.jsonl");
    const fakeOpenCode = join(root, "fake-opencode.mjs");
    await writeFile(file, workerModelWorkflowSource("opencode"));
    await writeFile(fakeOpenCode, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const dirIndex = process.argv.indexOf('--dir');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const cwd = dirIndex >= 0 ? process.argv[dirIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command: process.argv[2], model, cwd }) + '\\n');`,
      "console.log(JSON.stringify({ summary: model }));",
      "",
    ].join("\n"));
    await chmod(fakeOpenCode, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "opencode",
        "--store",
        storeFile,
        "--model",
        "github-copilot/gpt-5.1",
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_OPENCODE_BIN: fakeOpenCode },
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
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "github-copilot/gpt-5.1"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["opencode-cli", "opencode-cli"]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["grok-build", "github-copilot/gpt-5.1"]);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { command: string; model: string; cwd: string });
    expect(calls).toEqual([
      { command: "run", model: "grok-build", cwd: expectedCwd },
      { command: "run", model: "github-copilot/gpt-5.1", cwd: expectedCwd },
    ]);
  });

  test("CLI omits OpenCode --model when no model is configured", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "opencode-no-model-calls.jsonl");
    const fakeOpenCode = join(root, "fake-opencode-no-model.mjs");
    await writeFile(file, workflowSource("default", { worker: "opencode" }));
    await writeFile(fakeOpenCode, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const dirIndex = process.argv.indexOf('--dir');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const cwd = dirIndex >= 0 ? process.argv[dirIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ hasModelFlag: modelIndex >= 0, model, cwd }) + '\\n');`,
      "console.log(JSON.stringify({ summary: model }));",
      "",
    ].join("\n"));
    await chmod(fakeOpenCode, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "opencode",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_OPENCODE_BIN: fakeOpenCode },
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
    const result = JSON.parse(stdout) as { tasks: Array<{ output: { summary: string } }> };
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["missing"]);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { hasModelFlag: boolean; model: string; cwd: string });
    expect(calls).toEqual([{ hasModelFlag: false, model: "missing", cwd: expectedCwd }]);
  });

  test("CLI routes mixed task-level workers in one workflow run", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "mixed-worker-calls.jsonl");
    const fakeGrok = join(root, "fake-grok.mjs");
    const fakeOpenCode = join(root, "fake-opencode.mjs");
    await writeFile(file, workerRoutingWorkflowSource());
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const cwdIndex = process.argv.indexOf('--cwd');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const cwd = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ worker: 'grok', model, cwd }) + '\\n');`,
      "console.log(JSON.stringify({ summary: `grok:${model}` }));",
      "",
    ].join("\n"));
    await writeFile(fakeOpenCode, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const dirIndex = process.argv.indexOf('--dir');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const cwd = dirIndex >= 0 ? process.argv[dirIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ worker: 'opencode', model, cwd }) + '\\n');`,
      "console.log(JSON.stringify({ summary: `opencode:${model}` }));",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);
    await chmod(fakeOpenCode, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "grok",
        "--store",
        storeFile,
        "--model",
        "grok-build",
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_GROK_BIN: fakeGrok, PRISM_WORKFLOW_OPENCODE_BIN: fakeOpenCode },
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
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["opencode:github-copilot/gpt-5.1", "grok:grok-build"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["opencode-cli", "grok-cli"]);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { worker: string; model: string; cwd: string });
    expect(calls).toEqual([
      { worker: "opencode", model: "github-copilot/gpt-5.1", cwd: expectedCwd },
      { worker: "grok", model: "grok-build", cwd: expectedCwd },
    ]);
  });

  test("CLI runs a mixed workflow with only task-level workers", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "all-task-workers-calls.jsonl");
    const fakeGrok = join(root, "fake-grok.mjs");
    const fakeOpenCode = join(root, "fake-opencode.mjs");
    await writeFile(file, allTaskWorkersWorkflowSource());
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const cwdIndex = process.argv.indexOf('--cwd');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const cwd = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ worker: 'grok', model, cwd }) + '\\n');`,
      "console.log(JSON.stringify({ summary: `grok:${model}` }));",
      "",
    ].join("\n"));
    await writeFile(fakeOpenCode, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const dirIndex = process.argv.indexOf('--dir');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const cwd = dirIndex >= 0 ? process.argv[dirIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ worker: 'opencode', model, cwd }) + '\\n');`,
      "console.log(JSON.stringify({ summary: `opencode:${model}` }));",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);
    await chmod(fakeOpenCode, 0o755);

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
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_GROK_BIN: fakeGrok, PRISM_WORKFLOW_OPENCODE_BIN: fakeOpenCode },
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
    const result = JSON.parse(stdout) as { tasks: Array<{ output: { summary: string }; metadata?: { adapter?: string } }> };
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["opencode:github-copilot/gpt-5.1", "grok:grok-build"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["opencode-cli", "grok-cli"]);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { worker: string; model: string; cwd: string });
    expect(calls).toEqual([
      { worker: "opencode", model: "github-copilot/gpt-5.1", cwd: expectedCwd },
      { worker: "grok", model: "grok-build", cwd: expectedCwd },
    ]);
  });

  test("CLI detaches a workflow run and leaves it inspectable by run id", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "detached-grok-calls.txt");
    const fakeGrok = join(root, "fake-grok.mjs");
    await writeFile(file, workflowSource("default", { worker: "grok" }));
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
    expect(Date.now() - started).toBeLessThan(1_200);
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
        "--worker",
        "grok",
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
    const limitedListResult = await cli(["workflow", "runs", "list", "--store", storeFile, "--limit", "1"]) as {
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
      events: Array<{ sequence: number; type: string; taskId: string | null }>;
    };
    const cursorResult = await cli([
      "workflow",
      "runs",
      "events",
      runResult.runId,
      "--store",
      storeFile,
      "--after-sequence",
      "2",
      "--limit",
      "3",
    ]) as {
      events: Array<{ sequence: number; type: string }>;
    };

    expect(listResult.runs).toEqual([
      { runId: runResult.runId, workflow: "loader-smoke", status: "completed", finishedAt: expect.any(String) },
    ]);
    expect(limitedListResult.runs).toEqual(listResult.runs);
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
      "task.finish.completed",
      "task.cache_write.completed",
      "task.completed",
      "run.completed",
    ]);
    expect(cursorResult.events.map((event) => ({ sequence: event.sequence, type: event.type }))).toEqual([
      { sequence: 3, type: "task.cache_lookup.miss" },
      { sequence: 4, type: "task.executor.started" },
      { sequence: 5, type: "task.executor.completed" },
    ]);
  });

  test("CLI can reconcile stale running workflow runs while listing history", async () => {
    const root = await createTempRoot();
    const storeFile = join(root, "workflows.sqlite");
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

    const db = new Database(storeFile);
    db.exec(`
      create table workflow_runs (
        run_id text primary key,
        workflow text not null,
        status text not null default 'running',
        finished_at text,
        handoff_token text,
        created_at text not null default (datetime('now'))
      );
      create table workflow_events (
        run_id text not null,
        sequence integer not null,
        task_id text,
        type text not null,
        payload_json text not null,
        created_at text not null default (datetime('now')),
        primary key (run_id, sequence)
      );
      insert into workflow_runs (run_id, workflow, status, created_at)
      values ('stale-run', 'stale-smoke', 'running', '2026-01-01 00:00:00');
      insert into workflow_events (run_id, sequence, task_id, type, payload_json, created_at)
      values ('stale-run', 0, null, 'run.started', '{"workflow":"stale-smoke"}', '2026-01-01 00:00:00');
    `);
    db.close();

    const before = await cli(["workflow", "runs", "list", "--store", storeFile]) as {
      runs: Array<{ runId: string; workflow: string; status: string; finishedAt: string | null }>;
    };
    const after = await cli(["workflow", "runs", "list", "--store", storeFile, "--fail-stale-after-ms", "1"]) as {
      runs: Array<{ runId: string; workflow: string; status: string; finishedAt: string | null }>;
    };
    const events = await cli(["workflow", "runs", "events", "stale-run", "--store", storeFile]) as {
      events: Array<{ type: string; payload: unknown }>;
    };

    expect(before.runs).toEqual([{ runId: "stale-run", workflow: "stale-smoke", status: "running", finishedAt: null }]);
    expect(after.runs.map((run) => ({ runId: run.runId, workflow: run.workflow, status: run.status }))).toEqual([
      { runId: "stale-run", workflow: "stale-smoke", status: "failed" },
    ]);
    expect(typeof after.runs[0]?.finishedAt).toBe("string");
    expect(events.events.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
    expect(events.events.at(-1)?.payload).toMatchObject({
      reason: "stale-running-run",
      staleAfterMs: 1,
      createdAt: "2026-01-01 00:00:00",
    });
  });

  test("CLI can reconcile stale running workflow runs while showing details and events", async () => {
    const root = await createTempRoot();
    const storeFile = join(root, "workflows.sqlite");
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

    const db = new Database(storeFile);
    db.exec(`
      create table workflow_runs (
        run_id text primary key,
        workflow text not null,
        status text not null default 'running',
        finished_at text,
        handoff_token text,
        created_at text not null default (datetime('now'))
      );
      create table workflow_events (
        run_id text not null,
        sequence integer not null,
        task_id text,
        type text not null,
        payload_json text not null,
        created_at text not null default (datetime('now')),
        primary key (run_id, sequence)
      );
      insert into workflow_runs (run_id, workflow, status, created_at)
      values ('stale-show-run', 'stale-smoke', 'running', '2026-01-01 00:00:00');
      insert into workflow_events (run_id, sequence, task_id, type, payload_json, created_at)
      values ('stale-show-run', 0, null, 'run.started', '{"workflow":"stale-smoke"}', '2026-01-01 00:00:00');
    `);
    db.close();

    const show = await cli(["workflow", "runs", "show", "stale-show-run", "--store", storeFile, "--fail-stale-after-ms", "1"]) as {
      runId: string;
      tasks: unknown[];
    };
    const afterShow = await cli(["workflow", "runs", "list", "--store", storeFile]) as {
      runs: Array<{ runId: string; workflow: string; status: string; finishedAt: string | null }>;
    };
    const events = await cli(["workflow", "runs", "events", "stale-show-run", "--store", storeFile, "--fail-stale-after-ms", "1"]) as {
      events: Array<{ type: string; payload: unknown }>;
    };

    expect(show).toEqual({ runId: "stale-show-run", tasks: [] });
    expect(afterShow.runs).toEqual([
      { runId: "stale-show-run", workflow: "stale-smoke", status: "failed", finishedAt: expect.any(String) },
    ]);
    expect(events.events.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
  });

  test("CLI waits for a detached workflow run to complete", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeGrok = join(root, "fake-grok.mjs");
    await writeFile(file, workflowSource("default", { worker: "grok" }));
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "await new Promise((resolve) => setTimeout(resolve, 400));",
      "console.log(JSON.stringify({ summary: 'waited' }));",
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

    const detached = await cli(["workflow", "run", file, "--detach", "--store", storeFile]) as { runId: string };
    const waited = await cli([
      "workflow",
      "runs",
      "wait",
      detached.runId,
      "--store",
      storeFile,
      "--timeout-ms",
      "5000",
      "--interval-ms",
      "50",
    ]) as {
      run: { runId: string; status: string };
      tasks: Array<{ taskId: string; output: { summary: string } }>;
    };

    expect(waited.run).toMatchObject({ runId: detached.runId, status: "completed" });
    expect(waited.tasks).toMatchObject([{ taskId: "build", output: { summary: "waited" } }]);
  });

  test("CLI wait returns failed runs and times out running runs", async () => {
    const root = await createTempRoot();
    const storeFile = join(root, "workflows.sqlite");
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
      return { exitCode, stdout, stderr };
    };

    const db = new Database(storeFile);
    db.exec(`
      create table workflow_runs (
        run_id text primary key,
        workflow text not null,
        status text not null default 'running',
        finished_at text,
        handoff_token text,
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
        metadata_json text,
        created_at text not null default (datetime('now')),
        primary key (run_id, ordinal)
      );
      insert into workflow_runs (run_id, workflow, status, finished_at)
      values ('failed-run', 'wait-smoke', 'failed', datetime('now'));
      insert into workflow_runs (run_id, workflow, status)
      values ('running-run', 'wait-smoke', 'running');
    `);
    db.close();

    const failed = await cli(["workflow", "runs", "wait", "failed-run", "--store", storeFile, "--timeout-ms", "100"]);
    const running = await cli(["workflow", "runs", "wait", "running-run", "--store", storeFile, "--timeout-ms", "50", "--interval-ms", "10"]);

    expect(failed.exitCode).toBe(0);
    expect(failed.stderr).toBe("");
    expect((JSON.parse(failed.stdout) as { run: { status: string }; tasks: unknown[] }).run.status).toBe("failed");
    expect(running.exitCode).toBe(1);
    expect(running.stderr).toContain("timed out waiting for workflow run running-run");
  });
});
