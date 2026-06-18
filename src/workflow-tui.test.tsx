import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { Schema } from "effect";
import { runWorkflow } from "./workflow-runner.js";
import { WorkflowStore } from "./workflow-store.js";
import { defineTask, defineWorkflow, type WorkflowAgentRef } from "./workflows.js";
import { WorkflowMonitorApp } from "./workflow-tui.js";

const Output = Schema.Struct({ summary: Schema.String });

const agent: WorkflowAgentRef = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["grok"],
};

test("workflow monitor renders persisted run task data and refreshes", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-tui-"));
  const storePath = join(root, "workflows.sqlite");
  const workflowFile = join(root, "monitor.workflow.ts");
  const store = await WorkflowStore.open(storePath);
  const task = defineTask({
    id: "build",
    phase: "Build",
    agent,
    prompt: "Build the monitored slice.",
    output: Output,
    cacheKey: "monitor-build",
    worker: { worker: "grok", model: "grok-build" },
  });
  const workflow = defineWorkflow({ name: "monitor-smoke", tasks: [task] as const });
  const run = await runWorkflow(workflow, {
    store,
    executeTask: async () => ({ summary: "rendered output" }),
  });
  store.recordRunSnapshot({
    runId: run.runId!,
    workflowFile,
    options: { worker: "grok", model: "grok-build" },
  });
  store.close();

  const setup = await testRender(
    <WorkflowMonitorApp storePath={storePath} pollMs={60_000} />,
    { width: 120, height: 48 },
  );
  try {
    const frame = await setup.waitForFrame((candidate) =>
      candidate.includes("monitor-smoke")
      && candidate.includes("Build")
      && candidate.includes("build completed")
      && candidate.includes("miss fresh write")
      && candidate.includes("rendered output")
      && candidate.includes("cache key monitor-build"),
    );
    expect(frame).toContain("workflow file");

    setup.mockInput.pressKey("r");
    await setup.waitForFrame((candidate) => candidate.includes("monitor-smoke"));
  } finally {
    setup.renderer.destroy();
  }
});
