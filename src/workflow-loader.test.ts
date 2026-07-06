import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ComposedAgent } from "./compile/compose.js";
import { planLowering } from "./compile/lowerers/grok.js";
import { generatedMcpWireServerName } from "./compile/mcp-runtime.js";
import type { DesiredFile } from "./sync/desired.js";
import { validateWorkflowFile, WorkflowLoadError, WorkflowValidationError } from "./workflow-loader.js";
import { WorkflowStore } from "./workflow-store.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";
import { runWorkflowWorkerProcess } from "./workflow-worker-process.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-loader-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const writeDesiredFiles = async (files: ReadonlyArray<DesiredFile>): Promise<void> => {
  await Promise.all(files.map((file) => writeText(file.targetPath, file.content)));
};

const workflowTestEnv = (overrides: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.GROK_HOME;
  return { ...env, ...overrides };
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const contractMetadata = {
  contractVersion: WORKFLOW_WORKER_JSON_CONTRACT_VERSION,
  instructionSource: WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE,
};

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error("timed out waiting for condition");
};

const deadPid = async (): Promise<number> => {
  const processHandle = Bun.spawn({ cmd: ["sh", "-c", "sleep 30"] });
  const pid = processHandle.pid;
  processHandle.kill("SIGKILL");
  await processHandle.exited;
  return pid;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const workflowSource = (
  exportKind: "default" | "named" = "default",
  options?: { readonly worker?: string; readonly model?: string; readonly plugin?: string },
) => {
  return `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const builder = {
  kind: "agent-ref" as const,
  plugin: ${JSON.stringify(options?.plugin ?? "forge")},
  name: "builder",
  description: "Build specialist",
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
  return `
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const builder = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
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

const failureCapturingWorkflowSource = () => {
  return `
import { Effect, Either, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const reviewer = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "verification-reviewer",
  description: "Verification reviewer",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["opencode"],
};

const reviewOutput = Schema.Struct({ verdict: Schema.Literal("pass") });
const fusionOutput = Schema.Struct({
  reviewerStatus: Schema.Literal("completed", "failed"),
  verdict: Schema.Literal("needs-work"),
});

export default defineWorkflow({
  name: "failure-capturing-review",
  run: (wf) => Effect.gen(function* () {
    const review = defineTask({
      id: "reviewer",
      agent: reviewer,
      prompt: "Review the packet.",
      output: reviewOutput,
      worker: { worker: "opencode" },
    });
    const reviewed = yield* Effect.either(wf.runTask(review));
    const reviewerStatus = Either.isRight(reviewed) ? "completed" as const : "failed" as const;
    const fusion = yield* wf.runTask(defineTask({
      id: "fusion",
      agent: reviewer,
      prompt: \`Fuse reviewer status: \${reviewerStatus}\`,
      output: fusionOutput,
      worker: { worker: "opencode" },
    }));
    return { reviewerStatus, fusion };
  }),
});
`;
};

const workerModelWorkflowSource = (worker?: string) => {
  return `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const builder = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
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
  return `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const builder = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
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

const workerRoutingWorkflowSource = () => {
  return `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const builder = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
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
  return `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const builder = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
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

const modelResolutionWorkflowSource = () => {
  return `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const explicitModelAgent = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "explicit-agent",
  description: "Explicit model agent",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["claude-code"],
};

const partialAgent = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "partial-agent",
  description: "Partial modelspace agent",
  sourceHash: "${"c".repeat(64)}",
  manifestHash: "${"d".repeat(64)}",
  model: {
    modelspace: "agent-foundations:empirical-modelspaces",
    profile: "deep-explorer",
    targets: {
      "claude-code": { model: "claude-opus-4-8" },
    },
  },
  installs: ["grok"],
};

const output = Schema.Struct({ summary: Schema.String });

const explicitTask = defineTask({
  id: "explicit",
  agent: explicitModelAgent,
  prompt: "Use explicit model.",
  output,
  worker: { worker: "claude-code", model: "claude-opus-4-8" },
});

const profileTask = defineTask({
  id: "profile",
  agent: partialAgent,
  prompt: "Use profile model.",
  output,
  worker: { worker: "claude-code" },
});

const defaultTask = defineTask({
  id: "default",
  agent: partialAgent,
  prompt: "Use the grok registry default.",
  output,
  worker: { worker: "grok" },
});

const deferredTask = defineTask({
  id: "deferred",
  agent: explicitModelAgent,
  prompt: "Worker chosen at run time.",
  output,
});

export default defineWorkflow({ name: "model-resolution-smoke", tasks: [explicitTask, profileTask, defaultTask, deferredTask] });
`;
};

const unknownWorkerWorkflowSource = () => {
  return `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const builder = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
};

const output = Schema.Struct({ summary: Schema.String });
const build = defineTask({
  id: "build",
  agent: builder,
  prompt: "Build.",
  output,
  worker: { worker: "not-a-real-worker" as any },
});

export default defineWorkflow({ name: "unknown-worker-smoke", tasks: [build] });
`;
};

const explicitProfileMissingTargetWorkflowSource = () => {
  return `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const builder = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["codex-cli"],
};

const opencodeOnlyProfile = {
  kind: "model-profile-ref" as const,
  plugin: "agent-foundations",
  modelspace: "empirical-modelspaces",
  profile: "trusted-production",
  targets: { opencode: { model: "crof/kimi-k2.6" } },
};

const output = Schema.Struct({ summary: Schema.String });
const build = defineTask({
  id: "build",
  agent: builder,
  prompt: "Build.",
  output,
  worker: { worker: "codex-cli", model: opencodeOnlyProfile },
});

export default defineWorkflow({ name: "explicit-profile-missing-target", tasks: [build] });
`;
};

const scaffoldLikeDynamicWorkflowSource = () => {
  return `
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

const explorer = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "explorer",
  description: "Exploration specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["claude-code", "grok"],
};

const Result = Schema.Struct({ worker: Schema.String, summary: Schema.String });

const probe = (id: string, worker: "claude-code" | "grok") =>
  defineTask({
    id,
    agent: explorer,
    prompt: \`Run under \${worker}.\`,
    output: Result,
    cacheKey: \`scaffold-\${worker}-v1\`,
    worker: { worker },
  });

export const workflow = defineWorkflow({
  name: "scaffold-like",
  run: (wf) =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        [wf.runTask(probe("a", "claude-code")), wf.runTask(probe("b", "grok"))],
        { concurrency: "unbounded" },
      );
      return { results };
    }),
});
`;
};

describe("workflow loader", () => {
  // Integration tests spawn the full CLI per test and compile plugins. The
  // default 5s timeout is too tight once workflow refs are also emitted.
  const test = (name: string, fn: () => void | Promise<void>) => bunTest(name, fn, 60000);

  test("worker process honors an already-aborted signal", async () => {
    const root = await createTempRoot();
    const fakeWorker = join(root, "fake-worker.mjs");
    await writeFile(fakeWorker, [
      "#!/usr/bin/env node",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await chmod(fakeWorker, 0o755);
    const controller = new AbortController();
    controller.abort();

    const result = await runWorkflowWorkerProcess({
      command: fakeWorker,
      args: [],
      cwd: root,
      abortSignal: controller.signal,
      processTimeoutMs: 5_000,
    });

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

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

  test("validate emits a worker->model resolution row for every task (WDX-009)", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, modelResolutionWorkflowSource());

    const summary = await validateWorkflowFile(file);

    expect(summary.modelResolution).toHaveLength(4);
    expect(summary.modelResolution).toEqual([
      { id: "explicit", worker: "claude-code", model: "claude-opus-4-8", source: "task" },
      { id: "profile", worker: "claude-code", model: "claude-opus-4-8", source: "profile" },
      { id: "default", worker: "grok", model: "grok-build", source: "default" },
      { id: "deferred" },
    ]);
  });

  test("validate fails with the allowed worker id list for an unknown worker (WDX-009)", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, unknownWorkerWorkflowSource());

    await expect(validateWorkflowFile(file)).rejects.toThrow(WorkflowValidationError);
    await expect(validateWorkflowFile(file)).rejects.toThrow(
      /unsupported workflow worker 'not-a-real-worker'\. Supported workers: amp-code, antigravity-cli, claude-code, codex-cli, grok, hermes, kimi-code, opencode/,
    );
  });

  test("validate fails naming task and worker when an explicit model profile has no target for the declared worker (WDX-009)", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, explicitProfileMissingTargetWorkflowSource());

    await expect(validateWorkflowFile(file)).rejects.toThrow(WorkflowValidationError);
    await expect(validateWorkflowFile(file)).rejects.toThrow(/task 'build'/);
    await expect(validateWorkflowFile(file)).rejects.toThrow(/worker 'codex-cli'/);
  });

  test("validate annotates a dynamic workflow with statically discoverable worker ids and registry defaults (WDX-009)", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, scaffoldLikeDynamicWorkflowSource());

    const summary = await validateWorkflowFile(file);

    expect(summary.dynamic).toBe(true);
    expect(summary.tasks).toEqual([]);
    expect(summary.modelResolution).toEqual([]);
    expect(summary.note).toBeDefined();
    expect(summary.note?.length ?? 0).toBeGreaterThan(0);
    expect(summary.staticWorkers).toEqual([
      { worker: "claude-code", defaultModel: "claude-haiku-4-5" },
      { worker: "grok", defaultModel: "grok-build" },
    ]);
  });

  test("CLI workflow validate --table prints a human-readable resolution table (WDX-009)", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    await writeFile(file, modelResolutionWorkflowSource());

    const processHandle = Bun.spawn({
      cmd: [process.execPath, "run", join(process.cwd(), "src", "cli.ts"), "workflow", "validate", file, "--table"],
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
    expect(stdout).toContain("task");
    expect(stdout).toContain("worker");
    expect(stdout).toContain("grok-build");
    expect(stdout).toContain("default");
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

  test("CLI dynamic workflows can capture reviewer task failures and continue to fusion", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const outputFile = join(root, "outputs.json");
    const storeFile = join(root, "workflows.sqlite");
    await writeFile(file, failureCapturingWorkflowSource());
    await writeFile(outputFile, JSON.stringify({
      fusion: { reviewerStatus: "failed", verdict: "needs-work" },
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
        "--no-cache",
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
      output: { reviewerStatus: string; fusion: { reviewerStatus: string; verdict: string } };
      tasks: Array<{ id: string; cached: boolean; status: string; error?: string; output: unknown }>;
    };
    expect(result.output).toEqual({
      reviewerStatus: "failed",
      fusion: { reviewerStatus: "failed", verdict: "needs-work" },
    });
    // PQ-166 decided semantic: an isolated task failure is recorded as a
    // WorkflowRunTaskResult and stays visible in run results — the failed
    // reviewer is surfaced alongside fusion, not dropped.
    expect(result.tasks.map((task) => task.id)).toEqual(["reviewer", "fusion"]);
    const [reviewerTask, fusionTask] = result.tasks;
    expect(reviewerTask?.status).toBe("failed");
    expect(typeof reviewerTask?.error).toBe("string");
    expect(reviewerTask?.error?.length).toBeGreaterThan(0);
    expect(fusionTask?.status).toBe("completed");
    expect(fusionTask?.output).toEqual({ reviewerStatus: "failed", verdict: "needs-work" });
    expect(fusionTask?.cached).toBe(false);
  });

  test("CLI dynamic workflows pass completed reviewer output into fusion", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const outputFile = join(root, "outputs.json");
    const storeFile = join(root, "workflows.sqlite");
    await writeFile(file, failureCapturingWorkflowSource());
    await writeFile(outputFile, JSON.stringify({
      reviewer: { verdict: "pass" },
      fusion: { reviewerStatus: "completed", verdict: "needs-work" },
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
        "--no-cache",
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
      output: { reviewerStatus: string; fusion: { reviewerStatus: string; verdict: string } };
      tasks: Array<{ id: string; cached: boolean; output: unknown }>;
    };
    expect(result.output).toEqual({
      reviewerStatus: "completed",
      fusion: { reviewerStatus: "completed", verdict: "needs-work" },
    });
    expect(result.tasks.map((task) => task.id)).toEqual(["reviewer", "fusion"]);
    expect(result.tasks[0]?.output).toEqual({ verdict: "pass" });
    expect(result.tasks[1]?.cached).toBe(false);
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

    const listHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "cache",
        "list",
        "--store",
        storeFile,
        "--workflow",
        "loader-smoke",
        "--cache-key",
        "workflow-loader-build",
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [listExitCode, listStdout, listStderr] = await Promise.all([
      listHandle.exited,
      new Response(listHandle.stdout).text(),
      new Response(listHandle.stderr).text(),
    ]);
    expect(listStderr).toBe("");
    expect(listExitCode).toBe(0);
    const listed = JSON.parse(listStdout) as {
      entries: Array<{
        identity: { taskId: string; cacheKey: string };
        metadata: Record<string, unknown>;
      }>;
    };
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.identity).toMatchObject({ taskId: "build", cacheKey: "workflow-loader-build" });
    expect(listed.entries[0]?.metadata).toMatchObject(contractMetadata);

    const showHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "cache",
        "show",
        "--store",
        storeFile,
        "--workflow",
        "loader-smoke",
        "--cache-key",
        "workflow-loader-build",
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [showExitCode, showStdout, showStderr] = await Promise.all([
      showHandle.exited,
      new Response(showHandle.stdout).text(),
      new Response(showHandle.stderr).text(),
    ]);
    expect(showStderr).toBe("");
    expect(showExitCode).toBe(0);
    const shown = JSON.parse(showStdout) as { entry: { metadata: Record<string, unknown> } };
    expect(shown.entry.metadata).toMatchObject(contractMetadata);
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
      "const agentIndex = process.argv.indexOf('--agent');",
      "const modelIndex = process.argv.indexOf('--model');",
      "const agent = agentIndex >= 0 ? process.argv[agentIndex + 1] : 'missing';",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ agent, model }) + '\\n');`,
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
        env: workflowTestEnv({ HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: fakeGrok }),
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
      return JSON.parse(stdout) as { tasks: Array<{ output: { summary: string }; cached: boolean; metadata?: { adapter?: string; nativeAgent?: string } }> };
    };

    const first = await run();
    const second = await run();
    const calls = await Bun.file(callsFile).text();

    expect(first.tasks[0]?.cached).toBe(false);
    expect(first.tasks[0]?.output.summary).toBe("from grok");
    expect(first.tasks[0]?.metadata?.adapter).toBe("grok-cli");
    expect(first.tasks[0]?.metadata?.nativeAgent).toBe("builder");
    expect(second.tasks[0]?.cached).toBe(true);
    expect(second.tasks[0]?.output.summary).toBe("from grok");
    expect(calls.trim().split("\n").map((line) => JSON.parse(line) as { agent: string; model: string })).toEqual([
      { agent: "builder", model: "grok-build" },
    ]);
  });

  test("CLI fails Grok auth prompts before process timeout without leaking device-login transcript", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeGrok = join(root, "fake-grok-auth.mjs");
    await writeFile(file, workflowSource("default", { worker: "grok" }));
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "console.log('To sign in, open this URL in your browser:');",
      "console.log('https://accounts.x.ai/oauth2/device?user_code=TEST-CODE');",
      "console.log('Waiting for authorization...');",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);

    const started = Date.now();
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
      env: workflowTestEnv({
        HOME: join(root, "home"),
        PRISM_WORKFLOW_GROK_BIN: fakeGrok,
        PRISM_WORKFLOW_GROK_PROCESS_TIMEOUT_MS: "20000",
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(Date.now() - started).toBeLessThan(15000);
    expect(stderr).toContain("grok requires xAI OAuth login before workflow run");
    expect(stderr).not.toContain("accounts.x.ai");
    expect(stderr).not.toContain("TEST-CODE");
  });

  test("CLI fails Grok unauthenticated output before process timeout", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeGrok = join(root, "fake-grok-unauthenticated.mjs");
    await writeFile(file, workflowSource("default", { worker: "grok" }));
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "console.log('You are not authenticated.');",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);

    const started = Date.now();
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
      env: workflowTestEnv({
        HOME: join(root, "home"),
        PRISM_WORKFLOW_GROK_BIN: fakeGrok,
        PRISM_WORKFLOW_GROK_PROCESS_TIMEOUT_MS: "20000",
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(stderr).toContain("grok requires xAI OAuth login before workflow run");
    expect(stderr).not.toContain("You are not authenticated");
  });

  test("CLI runs generated Grok agents against the persistent home so repairs can resume", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const home = join(root, "home");
    const grokHome = join(home, ".grok");
    const sourcePluginName = "forge.demo";
    const ownerPluginName = "tool.owner";
    const callsFile = join(root, "grok-calls.txt");
    const fakeGrok = join(root, "fake-grok.mjs");
    const consumerAgent: ComposedAgent = {
      name: "builder",
      description: "Build specialist",
      body: "# Builder\n\nUse the generated Grok plugin bundle.",
      color: undefined,
      model: {},
      targetOverride: {},
      skills: [],
      allowedSkills: [],
      allowedTools: [],
      toolBindings: [
        {
          kind: "permission",
          logicalName: "challenge_echo",
          toolPluginName: ownerPluginName,
          toolName: "challenge_echo",
          toolSourcePath: join(root, "tools", "challenge_echo.tool.ts"),
        },
      ],
    };

    await writeFile(file, workflowSource("default", { worker: "grok", plugin: sourcePluginName }));
    const { files: generatedFiles } = await planLowering({
      agents: [consumerAgent],
      orbits: [],
      skills: [],
      hooks: [],
      registry: undefined,
      target: {
        scope: "global",
        root: grokHome,
        sourcePluginName,
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: join(root, sourcePluginName),
        mcpExposureProfile: `prism-generated-${sourcePluginName}:grok`,
      },
    });
    await writeDesiredFiles(generatedFiles);
    const sourceAgentPath = generatedFiles.find((operation) => operation.targetPath.endsWith(join("agents", "builder.md")))?.targetPath;
    if (!sourceAgentPath) throw new Error("expected generated Grok builder agent");

    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { appendFileSync, existsSync } from 'node:fs';",
      "const arg = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };",
      "const agent = arg('--agent');",
      "appendFileSync(",
      `  ${JSON.stringify(callsFile)},`,
      "  JSON.stringify({",
      "    agent,",
      "    agentExists: existsSync(agent),",
      "    home: process.env.HOME,",
      "    grokHome: process.env.GROK_HOME,",
      "    grokAuthPath: process.env.GROK_AUTH_PATH ?? null,",
      "    cursorMcps: process.env.GROK_CURSOR_MCPS_ENABLED,",
      "    claudeMcps: process.env.GROK_CLAUDE_MCPS_ENABLED,",
      "    allow: process.argv.slice(process.argv.indexOf('--allow'), process.argv.indexOf('--allow') + 2),",
      "  }) + '\\n',",
      ");",
      "console.log(JSON.stringify({ summary: 'from grok' }));",
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
      ],
      cwd: process.cwd(),
      env: workflowTestEnv({
        HOME: home,
        PRISM_WORKFLOW_GROK_BIN: fakeGrok,
      }),
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

    const result = JSON.parse(stdout) as { tasks: Array<{ output: { summary: string }; metadata?: Record<string, unknown> }> };
    const call = JSON.parse(await Bun.file(callsFile).text()) as {
      agent: string;
      agentExists: boolean;
      home: string;
      grokHome: string;
      grokAuthPath: string | null;
      cursorMcps: string;
      claudeMcps: string;
      allow: string[];
    };
    expect(result.tasks[0]?.output.summary).toBe("from grok");
    // grok runs against the configured persistent home (not a throwaway overlay), so the
    // session written here survives for a `grok -r <sessionId>` repair on the next attempt.
    expect(call.grokHome).toBe(grokHome);
    expect(call.home).toBe(home);
    expect(call.agent).toBe(sourceAgentPath);
    expect(call.agentExists).toBe(true);
    // No GROK_AUTH_PATH indirection: auth is read/refreshed in place from the real home.
    expect(call.grokAuthPath).toBeNull();
    // Cursor/Claude MCP auto-import stays suppressed without fabricating a home.
    expect(call.cursorMcps).toBe("false");
    expect(call.claudeMcps).toBe("false");
    expect(call.allow).toEqual(["--allow", "MCPTool"]);
    // Overlay-only metadata is gone.
    expect(result.tasks[0]?.metadata?.grokHomeIsolated).toBeUndefined();
    expect(result.tasks[0]?.metadata?.grokMcpServerCount).toBeUndefined();
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
    expect(stderr).toContain("unsupported workflow worker 'not-real'. Supported workers: amp-code, antigravity-cli, claude-code, codex-cli, grok, hermes, kimi-code, opencode");
  });

  test("CLI runs a workflow through the Antigravity worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "agy-calls.jsonl");
    const fakeAgy = join(root, "fake-agy.mjs");
    await writeFile(file, workflowSource("default", { worker: "antigravity-cli", model: "Gemini 3.5 Flash (Low)" }));
    await writeFile(fakeAgy, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const modelIndex = args.indexOf('--model');",
      "const logIndex = args.indexOf('--log-file');",
      "const printIndex = args.indexOf('--print');",
      "const model = modelIndex >= 0 ? args[modelIndex + 1] : 'missing';",
      "const logFile = logIndex >= 0 ? args[logIndex + 1] : 'missing';",
      "if (logIndex >= 0) appendFileSync(logFile, 'I printmode.go:156] Print mode: conversation=103febcc-41a4-435b-a6ed-f6992fb1c3ff, sending message\\n');",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ model, hasLogFile: logIndex >= 0, printIndex, finalFlag: args.at(-2), promptTail: args.at(-1)?.includes('Prism workflow task') ?? false }) + '\\n');`,
      "console.log(JSON.stringify({ summary: model }));",
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
        "--store",
        storeFile,
      ],
      cwd: process.cwd(),
      env: workflowTestEnv({ HOME: join(root, "home"), PRISM_WORKFLOW_ANTIGRAVITY_BIN: fakeAgy }),
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
    const run = JSON.parse(stdout) as {
      tasks: Array<{ output: { summary: string }; metadata?: { adapter?: string; model?: string; sessionId?: string; conversationId?: string } }>;
    };
    expect(run.tasks.map((task) => task.output.summary)).toEqual(["Gemini 3.5 Flash (Low)"]);
    expect(run.tasks.map((task) => task.metadata?.adapter)).toEqual(["antigravity-cli"]);
    expect(run.tasks.map((task) => task.metadata?.model)).toEqual(["Gemini 3.5 Flash (Low)"]);
    expect(run.tasks[0]?.metadata?.sessionId).toBe("103febcc-41a4-435b-a6ed-f6992fb1c3ff");
    expect(run.tasks[0]?.metadata?.conversationId).toBe("103febcc-41a4-435b-a6ed-f6992fb1c3ff");
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
      model: string;
      hasLogFile: boolean;
      printIndex: number;
      finalFlag: string;
      promptTail: boolean;
    });
    expect(calls).toEqual([{
      model: "Gemini 3.5 Flash (Low)",
      hasLogFile: true,
      printIndex: 10,
      finalFlag: "--print",
      promptTail: true,
    }]);
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
          "rush",
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
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["deep", "rush"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["amp-code", "amp-code"]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["deep", "rush"]);
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
      { execute: true, noArchive: true, noIde: true, noNotifications: true, noColor: true, mode: "rush", cwd: expectedCwd },
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

  test("CLI kills Amp runs that exceed the Prism process timeout", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeAmp = join(root, "fake-amp-hangs.mjs");
    await writeFile(file, workflowSource("default", { worker: "amp-code" }));
    await writeFile(fakeAmp, [
      "#!/usr/bin/env node",
      "console.error('starting amp hang SECRET_TIMEOUT_TRANSCRIPT');",
      "setInterval(() => {}, 1000);",
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
      env: {
        ...process.env,
        PRISM_WORKFLOW_AMP_BIN: fakeAmp,
        PRISM_WORKFLOW_AMP_PROCESS_TIMEOUT_MS: "250",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("amp exceeded Prism process timeout after 250ms");
    expect(stderr).not.toContain("SECRET_TIMEOUT_TRANSCRIPT");
  });

  test("CLI runs a workflow through the Claude Code worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "claude-calls.jsonl");
    const fakeClaude = join(root, "fake-claude.mjs");
    const claudeRoot = join(root, ".claude");
    const generatedPluginRoot = join(claudeRoot, "skills", "prism-generated-forge");
    const generatedToolName = `mcp__${generatedMcpWireServerName("forge")}__prism_forge_build`;
    await writeFile(file, workerModelWorkflowSource("claude-code"));
    await mkdir(join(generatedPluginRoot, "agents"), { recursive: true });
    await writeFile(join(generatedPluginRoot, "agents", "builder.md"), [
      "---",
      "name: builder",
      "tools:",
      `  - "${generatedToolName}"`,
      "---",
      "",
    ].join("\n"));
    await writeFile(join(generatedPluginRoot, ".mcp.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const outputFormatIndex = process.argv.indexOf('--output-format');",
      "const agentIndex = process.argv.indexOf('--agent');",
      "const pluginDirIndex = process.argv.indexOf('--plugin-dir');",
      "const allowedToolsArg = process.argv.find((arg) => arg.startsWith('--allowedTools='));",
      "const mcpConfigArg = process.argv.find((arg) => arg.startsWith('--mcp-config='));",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const outputFormat = outputFormatIndex >= 0 ? process.argv[outputFormatIndex + 1] : 'missing';",
      "const agent = agentIndex >= 0 ? process.argv[agentIndex + 1] : 'missing';",
      "const pluginDir = pluginDirIndex >= 0 ? process.argv[pluginDirIndex + 1] : 'missing';",
      "const allowedTools = allowedToolsArg ? allowedToolsArg.slice('--allowedTools='.length) : 'missing';",
      "const mcpConfig = mcpConfigArg ? mcpConfigArg.slice('--mcp-config='.length) : 'missing';",
      "const strictMcpConfig = process.argv.includes('--strict-mcp-config');",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ print: process.argv.includes('--print'), outputFormat, noSession: process.argv.includes('--no-session-persistence'), model, agent, pluginDir, allowedTools, mcpConfig, strictMcpConfig, cwd: process.cwd() }) + '\\n');`,
      `console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: ${JSON.stringify(generatedToolName)} }] } }));`,
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ summary: model }), is_error: false, session_id: 'claude-session', total_cost_usd: 0.01, duration_ms: 12, num_turns: 1 }));",
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
        env: { ...process.env, HOME: root, PRISM_WORKFLOW_CLAUDE_BIN: fakeClaude },
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
        tasks: Array<{ output: { summary: string }; cached: boolean; metadata?: { adapter?: string; model?: string; nativeAgent?: string; sessionId?: string; totalCostUsd?: number; claudeMcpToolCallCount?: number } }>;
      };
    };

    const result = await run();
    const cachedResult = await run();
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "sonnet"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["claude-code", "claude-code"]);
    expect(result.tasks.map((task) => task.metadata?.nativeAgent)).toEqual(["builder", "builder"]);
    expect(result.tasks[0]?.metadata?.sessionId).toBe("claude-session");
    expect(result.tasks[0]?.metadata?.totalCostUsd).toBe(0.01);
    expect(result.tasks[0]?.metadata?.claudeMcpToolCallCount).toBe(1);
    expect(cachedResult.tasks.map((task) => task.cached)).toEqual([true, true]);
    expect(cachedResult.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "sonnet"]);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
      print: boolean;
      outputFormat: string;
      noSession: boolean;
      model: string;
      agent: string;
      pluginDir: string;
      allowedTools: string;
      mcpConfig: string;
      strictMcpConfig: boolean;
      cwd: string;
    });
    expect(calls).toEqual([
      { print: true, outputFormat: "stream-json", noSession: false, model: "grok-build", agent: "builder", pluginDir: generatedPluginRoot, allowedTools: generatedToolName, mcpConfig: join(generatedPluginRoot, ".mcp.json"), strictMcpConfig: true, cwd: expectedCwd },
      { print: true, outputFormat: "stream-json", noSession: false, model: "sonnet", agent: "builder", pluginDir: generatedPluginRoot, allowedTools: generatedToolName, mcpConfig: join(generatedPluginRoot, ".mcp.json"), strictMcpConfig: true, cwd: expectedCwd },
    ]);
  });

  test("CLI fails closed when generated Claude MCP config is missing for MCP-backed agents", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "claude-called");
    const fakeClaude = join(root, "fake-claude.mjs");
    const claudeRoot = join(root, ".claude");
    const generatedPluginRoot = join(claudeRoot, "skills", "prism-generated-forge");
    await writeFile(file, workerModelWorkflowSource("claude-code"));
    await mkdir(join(generatedPluginRoot, "agents"), { recursive: true });
    await writeFile(join(generatedPluginRoot, "agents", "builder.md"), [
      "---",
      "name: builder",
      "tools:",
      `  - "mcp__${generatedMcpWireServerName("forge")}__forge_echo"`,
      "---",
      "",
    ].join("\n"));
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(callsFile)}, 'called');`,
      "console.log(JSON.stringify({ result: JSON.stringify({ summary: 'unexpected' }), is_error: false }));",
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
        "--model",
        "sonnet",
      ],
      cwd: root,
      env: { ...process.env, HOME: root, PRISM_WORKFLOW_CLAUDE_BIN: fakeClaude },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("references MCP tools but is missing");
    expect(await Bun.file(callsFile).exists()).toBe(false);
  });

  test("CLI fails closed when Claude calls an MCP tool outside the generated agent allow-list", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeClaude = join(root, "fake-claude-unexpected-mcp.mjs");
    const claudeRoot = join(root, ".claude");
    const generatedPluginRoot = join(claudeRoot, "skills", "prism-generated-forge");
    const forgeWireServerName = generatedMcpWireServerName("forge");
    const allowedToolName = `mcp__${forgeWireServerName}__prism_forge_build`;
    const unexpectedToolName = `mcp__${forgeWireServerName}__prism_forge_delete`;
    await writeFile(file, workerModelWorkflowSource("claude-code"));
    await mkdir(join(generatedPluginRoot, "agents"), { recursive: true });
    await writeFile(join(generatedPluginRoot, "agents", "builder.md"), [
      "---",
      "name: builder",
      "tools:",
      `  - "${allowedToolName}"`,
      "---",
      "",
    ].join("\n"));
    await writeFile(join(generatedPluginRoot, ".mcp.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      `console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: ${JSON.stringify(unexpectedToolName)} }] } }));`,
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ summary: 'unexpected' }), is_error: false, session_id: 'claude-session' }));",
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
        "--model",
        "sonnet",
      ],
      cwd: root,
      env: { ...process.env, HOME: root, PRISM_WORKFLOW_CLAUDE_BIN: fakeClaude },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("called MCP tools outside generated agent allow-list");
    expect(stderr).toContain(unexpectedToolName);
  });

  test("CLI allows MCP calls for a generated agent with no declared MCP allow-list (per-agent MCP scoping degrades to inherit-all on Claude)", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeClaude = join(root, "fake-claude-empty-allow-list.mjs");
    const claudeRoot = join(root, ".claude");
    const generatedPluginRoot = join(claudeRoot, "skills", "prism-generated-forge");
    const unexpectedToolName = `mcp__${generatedMcpWireServerName("forge")}__prism_forge_build`;
    await writeFile(file, workerModelWorkflowSource("claude-code"));
    await mkdir(join(generatedPluginRoot, "agents"), { recursive: true });
    await writeFile(join(generatedPluginRoot, "agents", "builder.md"), [
      "---",
      "name: builder",
      "---",
      "",
    ].join("\n"));
    await writeFile(join(generatedPluginRoot, ".mcp.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      `console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: ${JSON.stringify(unexpectedToolName)} }] } }));`,
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ summary: 'unexpected' }), is_error: false, session_id: 'claude-session' }));",
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
        "--model",
        "sonnet",
      ],
      cwd: root,
      env: { ...process.env, HOME: root, PRISM_WORKFLOW_CLAUDE_BIN: fakeClaude },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    // Per-agent MCP scoping degraded to inherit-all on Claude: its `tools:` frontmatter is an
    // exclusive allowlist that would strip built-ins, so generated agents omit it. With no
    // declared allow-list the worker no longer rejects MCP calls; the run completes.
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("called MCP tools outside generated agent allow-list");
  });

  test("CLI fails Claude runs when the JSON envelope reports an error", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeClaude = join(root, "fake-claude-error.mjs");
    await writeFile(file, workflowSource("default", { worker: "claude-code" }));
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ type: 'result', result: 'Not logged in', is_error: true }));",
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
      "console.log(JSON.stringify({ type: 'result', result: { summary: 'not task text' }, is_error: false }));",
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

  test("CLI kills Claude runs that exceed the Prism process timeout", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeClaude = join(root, "fake-claude-hangs.mjs");
    await writeFile(file, workflowSource("default", { worker: "claude-code" }));
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "console.error('starting claude hang SECRET_TIMEOUT_TRANSCRIPT');",
      "setInterval(() => {}, 1000);",
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
      env: {
        ...process.env,
        PRISM_WORKFLOW_CLAUDE_BIN: fakeClaude,
        PRISM_WORKFLOW_CLAUDE_PROCESS_TIMEOUT_MS: "250",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("claude exceeded Prism process timeout after 250ms");
    expect(stderr).not.toContain("SECRET_TIMEOUT_TRANSCRIPT");
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
      { command: "exec", model: "grok-build", cwd: expectedCwd, ephemeral: false },
      { command: "exec", model: "missing", cwd: expectedCwd, ephemeral: false },
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

  test("CLI kills Codex runs that exceed the Prism process timeout", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeCodex = join(root, "fake-codex-hangs.mjs");
    await writeFile(file, workflowSource("default", { worker: "codex-cli" }));
    await writeFile(fakeCodex, [
      "#!/usr/bin/env node",
      "console.error('starting codex hang SECRET_TIMEOUT_TRANSCRIPT');",
      "setInterval(() => {}, 1000);",
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
      env: {
        ...process.env,
        PRISM_WORKFLOW_CODEX_BIN: fakeCodex,
        PRISM_WORKFLOW_CODEX_PROCESS_TIMEOUT_MS: "250",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("codex exceeded Prism process timeout after 250ms");
    expect(stderr).not.toContain("SECRET_TIMEOUT_TRANSCRIPT");
  });

  test("CLI runs a workflow through the Hermes worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "hermes-calls.jsonl");
    const fakeHermes = join(root, "fake-hermes.mjs");
    await writeFile(file, workerModelWorkflowSource("hermes").replace(
      `model: "grok-build"`,
      `model: "grok-build", profile: "ansel12"`,
    ));
    await writeFile(fakeHermes, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const queryIndex = process.argv.indexOf('--query');",
      "const sourceIndex = process.argv.indexOf('--source');",
      "const profileIndex = process.argv.indexOf('--profile');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const query = queryIndex >= 0 ? process.argv[queryIndex + 1] : '';",
      "const source = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : 'missing';",
      "const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : undefined;",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command: process.argv.includes('chat') ? 'chat' : process.argv[2], model, quiet: process.argv.includes('--quiet'), source, profile, hasInstruction: query.includes('Prism workflow task') || query.includes('Return exactly one JSON value'), hasProfileFlag: process.argv.includes('--profile'), hasAgentFlag: process.argv.includes('--agent') }) + '\\n');`,
      "console.error('session_id: hermes-session-123');",
      "console.log(JSON.stringify({ summary: model }));",
      "",
    ].join("\n"));
    await chmod(fakeHermes, 0o755);

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
      return JSON.parse(stdout) as {
        tasks: Array<{ output: { summary: string }; cached: boolean; metadata?: { adapter?: string; prompted?: boolean; agentSelection?: string; source?: string; profile?: string; agent?: { plugin?: string; name?: string; manifestHash?: string }; nativeAgent?: string; model?: string; sessionId?: string } }>;
      };
    };

    const result = await run();
    const cachedResult = await run();
    await writeFile(file, workerModelWorkflowSource("hermes").replace(
      `model: "grok-build"`,
      `model: "grok-build", profile: "ada07"`,
    ));
    const changedProfileResult = await run();
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "nous/qwen3-coder"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["hermes", "hermes"]);
    expect(result.tasks.map((task) => task.metadata?.prompted)).toEqual([false, true]);
    expect(result.tasks.map((task) => task.metadata?.agentSelection)).toEqual(["profile", "prompted-contract"]);
    expect(result.tasks.map((task) => task.metadata?.source)).toEqual(["prism-workflow", "prism-workflow"]);
    expect(result.tasks.map((task) => task.metadata?.profile)).toEqual(["ansel12", undefined]);
    expect(result.tasks.map((task) => task.metadata?.agent)).toEqual([
      { plugin: "forge", name: "builder", manifestHash: "b".repeat(64) },
      { plugin: "forge", name: "builder", manifestHash: "b".repeat(64) },
    ]);
    expect(result.tasks.map((task) => task.metadata?.nativeAgent)).toEqual([undefined, undefined]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["grok-build", "nous/qwen3-coder"]);
    expect(result.tasks.map((task) => task.metadata?.sessionId)).toEqual(["hermes-session-123", "hermes-session-123"]);
    expect(cachedResult.tasks.map((task) => task.cached)).toEqual([true, true]);
    expect(cachedResult.tasks.map((task) => task.metadata?.prompted)).toEqual([false, true]);
    expect(cachedResult.tasks.map((task) => task.metadata?.agentSelection)).toEqual(["profile", "prompted-contract"]);
    expect(cachedResult.tasks.map((task) => task.metadata?.source)).toEqual(["prism-workflow", "prism-workflow"]);
    expect(cachedResult.tasks.map((task) => task.metadata?.profile)).toEqual(["ansel12", undefined]);
    expect(cachedResult.tasks.map((task) => task.metadata?.agent)).toEqual([
      { plugin: "forge", name: "builder", manifestHash: "b".repeat(64) },
      { plugin: "forge", name: "builder", manifestHash: "b".repeat(64) },
    ]);
    expect(cachedResult.tasks.map((task) => task.metadata?.nativeAgent)).toEqual([undefined, undefined]);
    expect(changedProfileResult.tasks.map((task) => task.cached)).toEqual([false, true]);
    expect(changedProfileResult.tasks.map((task) => task.metadata?.profile)).toEqual(["ada07", undefined]);

    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
      command: string;
      model: string;
      quiet: boolean;
      source: string;
      profile?: string;
      hasInstruction: boolean;
      hasProfileFlag: boolean;
      hasAgentFlag: boolean;
    });
    expect(calls).toEqual([
      { command: "chat", model: "grok-build", quiet: false, source: "missing", profile: "ansel12", hasInstruction: true, hasProfileFlag: true, hasAgentFlag: false },
      { command: "chat", model: "nous/qwen3-coder", quiet: false, source: "missing", hasInstruction: true, hasProfileFlag: false, hasAgentFlag: false },
      { command: "chat", model: "grok-build", quiet: false, source: "missing", profile: "ada07", hasInstruction: true, hasProfileFlag: true, hasAgentFlag: false },
    ]);
  });

  test("CLI fails Hermes runs when oneshot exits non-zero", async () => {
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
      "console.log('starting hermes hang SECRET_TIMEOUT_TRANSCRIPT');",
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
    expect(stderr).not.toContain("SECRET_TIMEOUT_TRANSCRIPT");
  });

  test("CLI runs a workflow through the Kimi Code worker adapter", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "kimi-calls.jsonl");
    const fakeKimi = join(root, "fake-kimi.mjs");
    await writeFile(file, workerModelWorkflowSource("kimi-code"));
    await writeFile(fakeKimi, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const modelIndex = process.argv.indexOf('--model');",
      "const promptIndex = process.argv.indexOf('--prompt');",
      "const formatIndex = process.argv.indexOf('--output-format');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : '';",
      "const outputFormat = formatIndex >= 0 ? process.argv[formatIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ model, outputFormat, hasInstruction: prompt.includes('Prism workflow task'), hasAgentFlag: process.argv.includes('--agent') }) + '\\n');`,
      "console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({ summary: model }) }));",
      "",
    ].join("\n"));
    await chmod(fakeKimi, 0o755);

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
          "kimi-code",
          "--store",
          storeFile,
          "--model",
          "kimi-k2",
        ],
        cwd: root,
        env: { ...process.env, PRISM_WORKFLOW_KIMI_BIN: fakeKimi },
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
        tasks: Array<{ output: { summary: string }; cached: boolean; metadata?: { adapter?: string; prompted?: boolean; agentSelection?: string; source?: string; agent?: { plugin?: string; name?: string; manifestHash?: string }; nativeAgent?: string; model?: string } }>;
      };
    };

    const result = await run();
    const cachedResult = await run();
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "kimi-k2"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["kimi-code", "kimi-code"]);
    expect(result.tasks.map((task) => task.metadata?.prompted)).toEqual([true, true]);
    expect(result.tasks.map((task) => task.metadata?.agentSelection)).toEqual(["prompted-contract", "prompted-contract"]);
    expect(result.tasks.map((task) => task.metadata?.source)).toEqual(["prism-workflow", "prism-workflow"]);
    expect(result.tasks.map((task) => task.metadata?.agent)).toEqual([
      { plugin: "forge", name: "builder", manifestHash: "b".repeat(64) },
      { plugin: "forge", name: "builder", manifestHash: "b".repeat(64) },
    ]);
    expect(result.tasks.map((task) => task.metadata?.nativeAgent)).toEqual([undefined, undefined]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["grok-build", "kimi-k2"]);
    expect(cachedResult.tasks.map((task) => task.cached)).toEqual([true, true]);
    expect(cachedResult.tasks.map((task) => task.metadata?.adapter)).toEqual(["kimi-code", "kimi-code"]);

    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
      model: string;
      outputFormat: string;
      hasInstruction: boolean;
      hasAgentFlag: boolean;
    });
    expect(calls).toEqual([
      { model: "grok-build", outputFormat: "stream-json", hasInstruction: true, hasAgentFlag: false },
      { model: "kimi-k2", outputFormat: "stream-json", hasInstruction: true, hasAgentFlag: false },
    ]);
  });

  test("CLI resolves the Kimi Code worker from PATH by default", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const callsFile = join(root, "kimi-path-calls.jsonl");
    const fakeKimi = join(root, "kimi");
    await writeFile(file, workflowSource("default", { worker: "kimi-code" }));
    await writeFile(fakeKimi, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command: process.argv[1], prompt: process.argv.includes('--prompt') }) + '\\n');`,
      "console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({ summary: 'path-kimi' }) }));",
      "",
    ].join("\n"));
    await chmod(fakeKimi, 0o755);
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` };
    delete env.PRISM_WORKFLOW_KIMI_BIN;

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "kimi-code",
        "--store",
        storeFile,
      ],
      cwd: root,
      env,
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
    expect(JSON.parse(stdout)).toMatchObject({ tasks: [{ output: { summary: "path-kimi" } }] });
    expect((await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { command: fakeKimi, prompt: true },
    ]);
  });

  test("CLI fails Kimi Code runs when the worker exits non-zero", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeKimi = join(root, "fake-kimi-error.mjs");
    await writeFile(file, workflowSource("default", { worker: "kimi-code" }));
    await writeFile(fakeKimi, [
      "#!/usr/bin/env node",
      "console.error('Kimi auth missing');",
      "process.exit(2);",
      "",
    ].join("\n"));
    await chmod(fakeKimi, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "kimi-code",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: { ...process.env, PRISM_WORKFLOW_KIMI_BIN: fakeKimi },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("kimi-code exited with 2: Kimi auth missing");
  });

  test("CLI kills Kimi Code runs that exceed the Prism process timeout", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeKimi = join(root, "fake-kimi-hangs.mjs");
    await writeFile(file, workflowSource("default", { worker: "kimi-code" }));
    await writeFile(fakeKimi, [
      "#!/usr/bin/env node",
      "console.log('starting kimi hang SECRET_TIMEOUT_TRANSCRIPT');",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await chmod(fakeKimi, 0o755);

    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(process.cwd(), "src", "cli.ts"),
        "workflow",
        "run",
        file,
        "--worker",
        "kimi-code",
        "--store",
        storeFile,
      ],
      cwd: root,
      env: {
        ...process.env,
        PRISM_WORKFLOW_KIMI_BIN: fakeKimi,
        PRISM_WORKFLOW_KIMI_PROCESS_TIMEOUT_MS: "250",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("kimi-code exceeded Prism process timeout after 250ms");
    expect(stderr).not.toContain("SECRET_TIMEOUT_TRANSCRIPT");
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
      "const agentIndex = process.argv.indexOf('--agent');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const cwd = dirIndex >= 0 ? process.argv[dirIndex + 1] : 'missing';",
      "const agent = agentIndex >= 0 ? process.argv[agentIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command: process.argv[2], model, cwd, agent }) + '\\n');`,
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
    const result = JSON.parse(stdout) as { tasks: Array<{ output: { summary: string }; metadata?: { adapter?: string; model?: string; nativeAgent?: string } }> };
    expect(result.tasks.map((task) => task.output.summary)).toEqual(["grok-build", "github-copilot/gpt-5.1"]);
    expect(result.tasks.map((task) => task.metadata?.adapter)).toEqual(["opencode-cli", "opencode-cli"]);
    expect(result.tasks.map((task) => task.metadata?.model)).toEqual(["grok-build", "github-copilot/gpt-5.1"]);
    expect(result.tasks.map((task) => task.metadata?.nativeAgent)).toEqual(["builder", "builder"]);

    const expectedCwd = await realpath(root);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { command: string; model: string; cwd: string; agent: string });
    expect(calls).toEqual([
      { command: "run", model: "grok-build", cwd: expectedCwd, agent: "builder" },
      { command: "run", model: "github-copilot/gpt-5.1", cwd: expectedCwd, agent: "builder" },
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
      "const agentIndex = process.argv.indexOf('--agent');",
      "const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'missing';",
      "const cwd = dirIndex >= 0 ? process.argv[dirIndex + 1] : 'missing';",
      "const agent = agentIndex >= 0 ? process.argv[agentIndex + 1] : 'missing';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ hasModelFlag: modelIndex >= 0, model, cwd, agent }) + '\\n');`,
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
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as { hasModelFlag: boolean; model: string; cwd: string; agent: string });
    expect(calls).toEqual([{ hasModelFlag: false, model: "missing", cwd: expectedCwd, agent: "builder" }]);
  });

  test("CLI kills OpenCode runs that exceed the Prism process timeout", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const fakeOpenCode = join(root, "fake-opencode-hangs.mjs");
    await writeFile(file, workflowSource("default", { worker: "opencode" }));
    await writeFile(fakeOpenCode, [
      "#!/usr/bin/env node",
      "console.error('starting opencode hang SECRET_TIMEOUT_TRANSCRIPT');",
      "setInterval(() => {}, 1000);",
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
      env: {
        ...process.env,
        PRISM_WORKFLOW_OPENCODE_BIN: fakeOpenCode,
        PRISM_WORKFLOW_OPENCODE_PROCESS_TIMEOUT_MS: "250",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("opencode exceeded Prism process timeout after 250ms");
    expect(stderr).not.toContain("SECRET_TIMEOUT_TRANSCRIPT");
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
      env: workflowTestEnv({ HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: fakeGrok, PRISM_WORKFLOW_OPENCODE_BIN: fakeOpenCode }),
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
      env: workflowTestEnv({ HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: fakeGrok, PRISM_WORKFLOW_OPENCODE_BIN: fakeOpenCode }),
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
        env: workflowTestEnv({ HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: fakeGrok }),
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
      "--detach",
      "--store",
      storeFile,
    ]) as { runId: string; workflow: string; status: string; detached: boolean };
    expect(await Bun.file(callsFile).exists()).toBe(false);
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
      run: { runnerPid?: number; heartbeatAt?: string };
      tasks: Array<{ taskId: string; output: { summary: string } }>;
    };
    const eventsResult = await cli(["workflow", "runs", "events", runResult.runId, "--store", storeFile]) as {
      events: Array<{ type: string }>;
    };

    expect(showResult.run.runnerPid).toEqual(expect.any(Number));
    expect(showResult.run.heartbeatAt).toEqual(expect.any(String));
    expect(showResult.tasks).toMatchObject([{ taskId: "build", output: { summary: "detached" } }]);
    expect(eventsResult.events.map((event) => event.type)).toContain("runner.started");
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
    expect(forgedStderr).toContain("--run-id is reserved for Prism's internal detached runner");

    const matchingRunMarkerProcess = Bun.spawn({
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
      env: { ...process.env, PRISM_WORKFLOW_DETACHED_CHILD: "1", PRISM_WORKFLOW_DETACHED_RUN_ID: "manual-run-id" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [matchingRunMarkerExitCode, matchingRunMarkerStderr] = await Promise.all([
      matchingRunMarkerProcess.exited,
      new Response(matchingRunMarkerProcess.stderr).text(),
    ]);

    expect(matchingRunMarkerExitCode).not.toBe(0);
    expect(matchingRunMarkerStderr).toContain("invalid detached workflow run handoff");
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
      env: workflowTestEnv({ HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: fakeGrok }),
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
    const cliText = async (args: string[]) => {
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
      return stdout;
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
      run: { runnerPid?: number; heartbeatAt?: string };
      tasks: Array<{
        runId: string;
        taskId: string;
        cacheKey: string;
        status: string;
        cached: boolean;
        agent: { plugin: string; name: string };
        output: { summary: string };
        metadata: typeof contractMetadata;
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
    const followedEvents = (await cliText([
      "workflow",
      "runs",
      "events",
      runResult.runId,
      "--store",
      storeFile,
      "--after-sequence",
      "2",
      "--limit",
      "2",
      "--follow",
    ])).trim().split("\n").map((line) => JSON.parse(line) as {
      runId: string;
      event: { sequence: number; type: string };
    });
    const cacheResult = await cli([
      "workflow",
      "cache",
      "list",
      "--store",
      storeFile,
      "--workflow",
      "loader-smoke",
      "--cache-key",
      "workflow-loader-build",
    ]) as {
      entries: Array<{
        identity: { workflow: string; taskId: string; cacheKey: string; promptHash: string; agentManifestHash: string };
        agent: { plugin: string; name: string };
        status: string;
        output: { summary: string };
        metadata: Record<string, unknown>;
        outputSource?: string;
        createdAt: string;
        updatedAt: string;
      }>;
    };

    expect(listResult.runs).toMatchObject([
      { runId: runResult.runId, workflow: "loader-smoke", status: "completed", finishedAt: expect.any(String) },
    ]);
    expect(listResult.runs[0]).toMatchObject({ runnerPid: expect.any(Number), heartbeatAt: expect.any(String) });
    expect(limitedListResult.runs).toEqual(listResult.runs);
    expect(showResult.run.runnerPid).toEqual(expect.any(Number));
    expect(showResult.run.heartbeatAt).toEqual(expect.any(String));
    expect(showResult.tasks).toEqual([
      {
        runId: runResult.runId,
        taskId: "build",
        cacheKey: "workflow-loader-build",
        status: "completed",
        cached: false,
        agent: { plugin: "forge", name: "builder" },
        output: { summary: "history" },
        metadata: contractMetadata,
      },
    ]);
    expect(eventsResult.events.map((event) => event.type)).toEqual([
      "run.started",
      "runner.started",
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
      { sequence: 3, type: "task.cache_lookup.started" },
      { sequence: 4, type: "task.cache_lookup.miss" },
      { sequence: 5, type: "task.executor.started" },
    ]);
    expect(followedEvents).toEqual([
      { runId: runResult.runId, event: expect.objectContaining({ sequence: 3, type: "task.cache_lookup.started" }) },
      { runId: runResult.runId, event: expect.objectContaining({ sequence: 4, type: "task.cache_lookup.miss" }) },
    ]);
    expect(cacheResult.entries).toEqual([
      {
        identity: {
          workflow: "loader-smoke",
          taskId: "build",
          cacheKey: "workflow-loader-build",
          promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          agentManifestHash: "b".repeat(64),
        },
        agent: { plugin: "forge", name: "builder" },
        status: "completed",
        output: { summary: "history" },
        metadata: contractMetadata,
        outputSource: "mock-output",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
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
    expect(events.events.map((event) => event.type)).toEqual(["run.started", "run.stale_reconciled", "run.failed"]);
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
      run: { runId: string; workflow: string; status: string; finishedAt: string | null };
      taskSummary: unknown[];
      tasks: unknown[];
    };
    const afterShow = await cli(["workflow", "runs", "list", "--store", storeFile]) as {
      runs: Array<{ runId: string; workflow: string; status: string; finishedAt: string | null }>;
    };
    const events = await cli(["workflow", "runs", "events", "stale-show-run", "--store", storeFile, "--fail-stale-after-ms", "1"]) as {
      events: Array<{ type: string; payload: unknown }>;
    };

    expect(show).toEqual({
      run: { runId: "stale-show-run", workflow: "stale-smoke", status: "failed", finishedAt: expect.any(String) },
      taskSummary: [],
      tasks: [],
    });
    expect(afterShow.runs).toEqual([
      { runId: "stale-show-run", workflow: "stale-smoke", status: "failed", finishedAt: expect.any(String) },
    ]);
    expect(events.events.map((event) => event.type)).toEqual(["run.started", "run.stale_reconciled", "run.failed"]);
  });

  test("CLI can stop a running workflow run cooperatively", async () => {
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

    const store = await WorkflowStore.open(storeFile);
    store.createRun("stop-smoke", "stop-run");
    store.close();

    const stopped = await cli(["workflow", "runs", "stop", "stop-run", "--store", storeFile]) as {
      run: { runId: string; workflow: string; status: string; finishedAt: string | null };
    };
    const waited = await cli(["workflow", "runs", "wait", "stop-run", "--store", storeFile, "--timeout-ms", "1000"]) as {
      run: { runId: string; status: string };
      tasks: unknown[];
    };
    const events = await cli(["workflow", "runs", "events", "stop-run", "--store", storeFile]) as {
      events: Array<{ type: string; payload: unknown }>;
    };

    expect(stopped.run).toMatchObject({ runId: "stop-run", workflow: "stop-smoke", status: "failed" });
    expect(typeof stopped.run.finishedAt).toBe("string");
    expect(waited).toMatchObject({ run: { runId: "stop-run", status: "failed" }, tasks: [] });
    expect(events.events.map((event) => event.type)).toEqual(["run.started", "run.stop_requested", "run.failed"]);
    expect(events.events.at(-1)?.payload).toEqual({ reason: "stop-requested" });
  });

  test("CLI run inspection heals dead detached runner pids without the stale flag", async () => {
    const root = await createTempRoot();
    const storeFile = join(root, "workflows.sqlite");
    const pid = await deadPid();
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
    const store = await WorkflowStore.open(storeFile);
    store.createRun("dead-pid-smoke", "dead-pid-run");
    store.markRunRunnerStarted("dead-pid-run", pid);
    store.close();

    const listed = await cli(["workflow", "runs", "list", "--store", storeFile]) as {
      runs: Array<{ runId: string; workflow: string; status: string; finishedAt: string | null; runnerPid?: number; heartbeatAt?: string }>;
    };
    const shown = await cli(["workflow", "runs", "show", "dead-pid-run", "--store", storeFile]) as {
      run: { runId: string; status: string; finishedAt: string | null; runnerPid?: number };
    };
    const events = await cli(["workflow", "runs", "events", "dead-pid-run", "--store", storeFile]) as {
      events: Array<{ type: string; payload: unknown }>;
    };
    const stopped = await cli(["workflow", "runs", "stop", "dead-pid-run", "--store", storeFile]) as {
      run: { runId: string; status: string; finishedAt: string | null; runnerPid?: number };
    };

    expect(listed.runs).toEqual([
      { runId: "dead-pid-run", workflow: "dead-pid-smoke", status: "failed", finishedAt: expect.any(String), runnerPid: pid, heartbeatAt: expect.any(String) },
    ]);
    expect(shown.run).toMatchObject({ runId: "dead-pid-run", status: "failed", runnerPid: pid });
    expect(stopped.run).toMatchObject({ runId: "dead-pid-run", status: "failed", runnerPid: pid });
    expect(events.events.map((event) => event.type)).toEqual([
      "run.started",
      "runner.started",
      "run.stale_dead_pid",
      "run.failed",
    ]);
    expect(events.events.at(-1)?.payload).toMatchObject({ reason: "dead-runner-pid", runnerPid: pid });
  });

  test("CLI stop aborts an active detached worker process", async () => {
    const root = await createTempRoot();
    const file = join(root, "workflow.ts");
    const storeFile = join(root, "workflows.sqlite");
    const startedFile = join(root, "worker-started.txt");
    const fakeGrok = join(root, "fake-grok-hangs.mjs");
    await writeFile(file, workflowSource("default", { worker: "grok" }));
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(startedFile)}, 'started');`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);
    const cli = async (args: string[]) => {
      const processHandle = Bun.spawn({
        cmd: [process.execPath, "run", join(process.cwd(), "src", "cli.ts"), ...args],
        cwd: root,
        env: workflowTestEnv({ HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: fakeGrok }),
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
    await waitFor(async () => Bun.file(startedFile).exists(), 5_000);
    const stopped = await cli(["workflow", "runs", "stop", detached.runId, "--store", storeFile]) as {
      run: { runId: string; status: string };
    };
    await waitFor(async () => {
      const shown = await cli(["workflow", "runs", "show", detached.runId, "--store", storeFile]) as {
        tasks: Array<{ status: string }>;
      };
      return shown.tasks[0]?.status === "failed";
    }, 5_000);
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
      tasks: Array<{
        runId: string;
        taskId: string;
        cacheKey: string;
        status: string;
        cached: boolean;
        agent: { plugin: string; name: string };
        output: { error: string };
        metadata: typeof contractMetadata;
      }>;
    };

    expect(stopped.run).toMatchObject({ runId: detached.runId, status: "failed" });
    expect(waited.run).toMatchObject({ runId: detached.runId, status: "failed" });
    expect(waited.tasks).toEqual([
      {
        runId: detached.runId,
        taskId: "build",
        cacheKey: "workflow-loader-build",
        status: "failed",
        cached: false,
        agent: { plugin: "forge", name: "builder" },
        output: { error: "grok was aborted by Prism workflow stop" },
        metadata: contractMetadata,
      },
    ]);
    const events = await cli(["workflow", "runs", "events", detached.runId, "--store", storeFile]) as {
      events: Array<{ type: string; taskId: string | null; payload: unknown }>;
    };
    expect(events.events.map((event) => event.type)).toContain("run.stop_requested");
    expect(events.events.map((event) => event.type)).toContain("runner.termination_requested");
    expect(events.events).toContainEqual(expect.objectContaining({
      taskId: "build",
      type: "task.abort_monitor_triggered",
      payload: expect.objectContaining({ reason: expect.stringMatching(/^(run-not-running|runner-termination-signal)$/) }),
    }));
  });

  test("CLI update restarts a running workflow and does not reuse mock-sourced cache", async () => {
    const root = await createTempRoot();
    const storeFile = join(root, "workflows.sqlite");
    const seedFile = join(root, "seed-workflow.ts");
    const oldFile = join(root, "old-workflow.ts");
    const mockOutput = join(root, "mock-output.json");
    const startedFile = join(root, "old-worker-started.txt");
    const fakeGrokHangs = join(root, "fake-grok-hangs.mjs");
    const fakeGrokFast = join(root, "fake-grok-fast.mjs");
    await writeFile(seedFile, workflowSource());
    await writeFile(oldFile, workflowSource().replace('cacheKey: "workflow-loader-build"', 'cacheKey: "workflow-loader-old"'));
    await writeFile(mockOutput, JSON.stringify({ build: { summary: "seeded" } }));
    await writeFile(fakeGrokHangs, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(startedFile)}, 'started');`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await writeFile(fakeGrokFast, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ summary: 'from-real-worker' }));",
      "",
    ].join("\n"));
    await chmod(fakeGrokHangs, 0o755);
    await chmod(fakeGrokFast, 0o755);
    const cli = async (args: string[], grokBin: string) => {
      const processHandle = Bun.spawn({
        cmd: [process.execPath, "run", join(process.cwd(), "src", "cli.ts"), ...args],
        cwd: root,
        env: workflowTestEnv({ HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: grokBin }),
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

    // Seed the task cache via --mock-output (stored with outputSource = "mock-output")
    await cli(["workflow", "run", seedFile, "--store", storeFile, "--mock-output", mockOutput, "--worker", "grok"], fakeGrokFast);
    // Start a detached old run using a grok that hangs (different cache key)
    const oldRun = await cli(["workflow", "run", oldFile, "--detach", "--store", storeFile, "--worker", "grok"], fakeGrokHangs) as { runId: string };
    await waitFor(async () => Bun.file(startedFile).exists(), 5_000);
    // Restart with the seed workflow; the update run is a real (non-mock) run that must NOT reuse mock-sourced cache
    const update = await cli(["workflow", "runs", "update", oldRun.runId, seedFile, "--store", storeFile, "--worker", "grok"], fakeGrokFast) as {
      previousRun: { runId: string; status: string };
      runId: string;
      update: { previousRunId: string; mode: string };
    };
    const waited = await cli([
      "workflow",
      "runs",
      "wait",
      update.runId,
      "--store",
      storeFile,
      "--timeout-ms",
      "5000",
      "--interval-ms",
      "50",
    ], fakeGrokFast) as {
      run: { runId: string; status: string };
      tasks: Array<{ taskId: string; cached: boolean; output: { summary: string } }>;
    };
    const oldEvents = await cli(["workflow", "runs", "events", oldRun.runId, "--store", storeFile], fakeGrokFast) as {
      events: Array<{ type: string; payload: unknown }>;
    };
    const newEvents = await cli(["workflow", "runs", "events", update.runId, "--store", storeFile], fakeGrokFast) as {
      events: Array<{ type: string; payload: unknown }>;
    };

    expect(update.previousRun).toMatchObject({ runId: oldRun.runId, status: "failed" });
    expect(update.update).toEqual({ previousRunId: oldRun.runId, mode: "restart-with-cache" });
    expect(waited.run).toMatchObject({ runId: update.runId, status: "completed" });
    // Real (non-mock) run does not reuse mock-sourced cache; it calls the real worker
    expect(waited.tasks).toMatchObject([
      { taskId: "build", cached: false, output: { summary: "from-real-worker" } },
    ]);
    expect(oldEvents.events).toContainEqual(expect.objectContaining({
      type: "run.stop_requested",
      payload: { reason: "update-requested" },
    }));
    expect(oldEvents.events).toContainEqual(expect.objectContaining({
      type: "runner.termination_requested",
      payload: expect.objectContaining({ reason: "update-requested", signal: "SIGTERM" }),
    }));
    expect(newEvents.events).toContainEqual(expect.objectContaining({
      type: "run.updated_from",
      payload: { previousRunId: oldRun.runId, mode: "restart-with-cache" },
    }));
    // Mock-sourced cache entry is not reused by a real run: cache lookup should miss
    expect(newEvents.events.map((event) => event.type)).toContain("task.cache_lookup.miss");
    expect(newEvents.events.map((event) => event.type)).not.toContain("task.cache_lookup.hit");
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
        env: workflowTestEnv({ HOME: join(root, "home"), PRISM_WORKFLOW_GROK_BIN: fakeGrok }),
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
