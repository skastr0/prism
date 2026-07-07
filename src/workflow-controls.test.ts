import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDetachedWorkflowRun } from "./workflow-controls.js";
import { WorkflowStore } from "./workflow-store.js";

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

test("detached workflow update preserves prior no-cache options and records child pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-controls-"));
  try {
    const workflowPath = join(root, "update.workflow.ts");
    const mockOutputPath = join(root, "mock-output.json");
    const storePath = join(root, "workflows.sqlite");
    await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

const Output = Schema.Struct({ summary: Schema.String });

export default defineWorkflow({
  name: "update-control-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Build with previous options.",
    output: Output,
  })],
});
`);
    await writeFile(mockOutputPath, `${JSON.stringify({ build: { summary: "updated" } })}\n`);
    await mkdir(join(root, ".prism"), { recursive: true });

    const store = await WorkflowStore.open(storePath);
    const previousRunId = store.createRun("update-control-smoke");
    store.recordRunSnapshot({
      runId: previousRunId,
      workflowFile: workflowPath,
      options: { cache: false, mockOutput: mockOutputPath, maxConcurrentTasks: 1 },
    });
    store.close();

    const originalEntrypoint = process.argv[1];
    let result: Awaited<ReturnType<typeof updateDetachedWorkflowRun>>;
    try {
      process.argv[1] = join(process.cwd(), "src", "cli.ts");
      result = await updateDetachedWorkflowRun({
        runId: previousRunId,
        file: workflowPath,
        storePath,
        options: {},
      });
    } finally {
      process.argv[1] = originalEntrypoint ?? "";
    }

    const updatedStore = await WorkflowStore.open(storePath);
    try {
      expect(updatedStore.getRun(previousRunId)?.status).toBe("failed");
      expect(updatedStore.getRun(result.runId)).toEqual(expect.objectContaining({
        status: expect.any(String),
        runnerPid: expect.any(Number),
      }));
      expect(updatedStore.getRunSnapshot(result.runId)?.options).toMatchObject({
        cache: false,
        mockOutput: mockOutputPath,
        maxConcurrentTasks: 1,
      });
    } finally {
      updatedStore.stopRunningRun(result.runId, "test-cleanup");
      updatedStore.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume (allowTerminalPreviousRun) starts a fresh run from an already-terminal previous run", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-controls-resume-"));
  try {
    const workflowPath = join(root, "resume.workflow.ts");
    const mockOutputPath = join(root, "mock-output.json");
    const storePath = join(root, "workflows.sqlite");
    await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

const Output = Schema.Struct({ summary: Schema.String });

export default defineWorkflow({
  name: "resume-control-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Build after resume.",
    output: Output,
  })],
});
`);
    await writeFile(mockOutputPath, `${JSON.stringify({ build: { summary: "resumed" } })}\n`);
    await mkdir(join(root, ".prism"), { recursive: true });

    const store = await WorkflowStore.open(storePath);
    const previousRunId = store.createRun("resume-control-smoke");
    store.recordRunSnapshot({
      runId: previousRunId,
      workflowFile: workflowPath,
      options: { cache: false, mockOutput: mockOutputPath, maxConcurrentTasks: 1 },
    });
    // Move the previous run to a terminal status before resuming — the exact
    // case `update` rejects and `resume` must tolerate.
    store.stopRunningRun(previousRunId, "test-setup");
    expect(store.getRun(previousRunId)?.status).toBe("failed");
    store.close();

    const originalEntrypoint = process.argv[1];
    let result: Awaited<ReturnType<typeof updateDetachedWorkflowRun>>;
    try {
      process.argv[1] = join(process.cwd(), "src", "cli.ts");
      result = await updateDetachedWorkflowRun({
        runId: previousRunId,
        file: workflowPath,
        storePath,
        options: {},
        allowTerminalPreviousRun: true,
      });
    } finally {
      process.argv[1] = originalEntrypoint ?? "";
    }

    const updatedStore = await WorkflowStore.open(storePath);
    try {
      // The previous run stays exactly as it was (already terminal) — resume never re-stops it.
      expect(updatedStore.getRun(previousRunId)?.status).toBe("failed");
      expect(updatedStore.getRun(result.runId)).toEqual(expect.objectContaining({
        status: expect.any(String),
        runnerPid: expect.any(Number),
      }));
      expect(updatedStore.getRunSnapshot(result.runId)?.options).toMatchObject({
        cache: false,
        mockOutput: mockOutputPath,
        maxConcurrentTasks: 1,
      });
      const events = updatedStore.listRunEvents(result.runId);
      expect(events.some((event) => event.type === "run.updated_from")).toBe(true);
    } finally {
      updatedStore.stopRunningRun(result.runId, "test-cleanup");
      updatedStore.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update (without allowTerminalPreviousRun) still rejects a previous run that is already terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-controls-reject-"));
  try {
    const workflowPath = join(root, "reject.workflow.ts");
    const storePath = join(root, "workflows.sqlite");
    await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

const Output = Schema.Struct({ summary: Schema.String });

export default defineWorkflow({
  name: "reject-control-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Never runs.",
    output: Output,
  })],
});
`);
    await mkdir(join(root, ".prism"), { recursive: true });

    const store = await WorkflowStore.open(storePath);
    const previousRunId = store.createRun("reject-control-smoke");
    store.stopRunningRun(previousRunId, "test-setup");
    store.close();

    await expect(
      updateDetachedWorkflowRun({ runId: previousRunId, file: workflowPath, storePath, options: {} }),
    ).rejects.toThrow("workflow run is not running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
