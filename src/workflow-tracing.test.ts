import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { WorkflowStore } from "./workflow-store.js";
import { runWorkflow } from "./workflow-runner.js";
import {
  defineTask,
  defineWorkflow,
  type PhaseContract,
  type WorkflowAgentRef,
  type WorkflowRuntime,
} from "./workflows.js";
import {
  buildWorkflowSpanTree,
  createWorkflowTraceRecorder,
  renderWorkflowTraceHuman,
  workflowSpansToOtlpJson,
  type WorkflowSpanRecord,
} from "./workflow-tracing.js";
import {
  listRegisteredWorkflowStores,
  registerWorkflowStore,
  workflowStoreRegistryPath,
} from "./workflow-store-registry.js";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["grok"],
} as const satisfies WorkflowAgentRef;

const Report = Schema.Struct({ summary: Schema.String });

const withStore = async (
  fn: (store: WorkflowStore, root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "prism-tracing-"));
  const store = await WorkflowStore.open(join(root, "workflows.sqlite"));
  try {
    await fn(store, root);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
};

describe("workflow trace recorder", () => {
  test("no-op recorder when the run is not persisted", () => {
    const recorder = createWorkflowTraceRecorder({ runId: null });
    expect(recorder.enabled).toBe(false);
    const span = recorder.startSpan("anything");
    span.annotate("k", "v");
    span.end("ok");
  });

  test("spans round-trip through the store with duration, status, and attributes", async () => {
    await withStore(async (store) => {
      const runId = store.createRun("trace-smoke");
      const recorder = createWorkflowTraceRecorder({ store, runId });
      const parent = recorder.startSpan("workflow.run", { attributes: { workflow: "trace-smoke" } });
      const child = recorder.startSpan("workflow.task", {
        parentSpanId: parent.spanId,
        taskId: "t1",
        attributes: { "task.id": "t1" },
      });
      child.annotate("task.status", "completed");
      child.end("ok");
      parent.end("error", new Error("boom"));

      const spans = store.listSpans(runId);
      expect(spans).toHaveLength(2);
      const root = spans.find((span) => span.name === "workflow.run");
      const task = spans.find((span) => span.name === "workflow.task");
      expect(root?.status).toBe("error");
      expect(root?.errorMessage).toBe("boom");
      expect(root?.parentSpanId).toBeNull();
      expect(task?.parentSpanId).toBe(root?.spanId ?? "");
      expect(task?.taskId).toBe("t1");
      expect(task?.status).toBe("ok");
      expect(task?.attributes["task.status"]).toBe("completed");
      expect(task?.endNs).not.toBeNull();
      expect(task !== undefined && task.endNs !== null && task.endNs >= task.startNs).toBe(true);
      expect(root?.traceId).toBe(recorder.traceId);
      expect(task?.traceId).toBe(recorder.traceId);
    });
  });
});

describe("workflow runner tracing", () => {
  test("static run records workflow.run -> workflow.task -> task.executor with worker attributes", async () => {
    await withStore(async (store) => {
      const build = defineTask({ id: "build", agent, prompt: "Build it.", output: Report });
      const workflow = defineWorkflow({ name: "trace-static", tasks: [build] as const });
      const result = await runWorkflow(workflow, {
        store,
        executeTask: async () => ({
          output: { summary: "done" },
          metadata: { adapter: "grok-cli", model: "grok-4" },
        }),
      });
      expect(result.runId).not.toBeNull();
      const spans = store.listSpans(result.runId ?? "");
      const names = spans.map((span) => span.name);
      expect(names).toContain("workflow.run");
      expect(names).toContain("workflow.task");
      expect(names).toContain("task.executor");

      const root = spans.find((span) => span.name === "workflow.run");
      const task = spans.find((span) => span.name === "workflow.task");
      const executor = spans.find((span) => span.name === "task.executor");
      expect(root?.status).toBe("ok");
      expect(root?.attributes["run.status"]).toBe("completed");
      expect(task?.parentSpanId).toBe(root?.spanId ?? "");
      expect(task?.attributes["task.status"]).toBe("completed");
      expect(executor?.parentSpanId).toBe(task?.spanId ?? "");
      expect(executor?.attributes["worker.adapter"]).toBe("grok-cli");
      expect(executor?.attributes["worker.model"]).toBe("grok-4");
      expect(spans.every((span) => span.traceId === root?.traceId)).toBe(true);
    });
  });

  test("cached task re-run records the task span without an executor span", async () => {
    await withStore(async (store) => {
      const build = defineTask({ id: "build", agent, prompt: "Build it.", output: Report });
      const workflow = defineWorkflow({ name: "trace-cache", tasks: [build] as const });
      const executeTask = async () => ({ summary: "done" });
      const first = await runWorkflow(workflow, { store, executeTask });
      const second = await runWorkflow(workflow, { store, executeTask });
      const spans = store.listSpans(second.runId ?? "");
      const task = spans.find((span) => span.name === "workflow.task");
      expect(first.runId).not.toBe(second.runId);
      expect(task?.attributes["task.cached"]).toBe(true);
      expect(spans.some((span) => span.name === "task.executor")).toBe(false);
    });
  });

  test("failed task records error spans and the run root reflects the failure", async () => {
    await withStore(async (store) => {
      const build = defineTask({ id: "build", agent, prompt: "Build it.", output: Report });
      const workflow = defineWorkflow({ name: "trace-fail", tasks: [build] as const });
      await expect(runWorkflow(workflow, {
        store,
        executeTask: async () => {
          throw new Error("worker exploded");
        },
      })).rejects.toThrow("worker exploded");
      const runs = store.listRuns();
      const runId = runs.at(-1)?.runId ?? "";
      const spans = store.listSpans(runId);
      const root = spans.find((span) => span.name === "workflow.run");
      const task = spans.find((span) => span.name === "workflow.task");
      const executor = spans.find((span) => span.name === "task.executor");
      expect(executor?.status).toBe("error");
      expect(executor?.errorMessage).toBe("worker exploded");
      expect(task?.status).toBe("error");
      expect(root?.status).toBe("error");
      expect(root?.attributes["run.status"]).toBe("failed");
    });
  });

  test("dynamic run: wf.phase spans land in the trace with orbit and phase attributes", async () => {
    await withStore(async (store) => {
      const exploreContract = {
        name: "explore",
        orbit: "delivery",
        plugin: "core",
        agents: { explorer: agent },
        output: Report,
        framing: { telos: "Reduce ambiguity." },
      } as const satisfies PhaseContract<"explore", { readonly explorer: typeof agent }, typeof Report>;

      const workflow = defineWorkflow({
        name: "trace-phase",
        run: (wf) => wf.phase(exploreContract, (ctx) => ctx.task({
          id: "scope",
          agent: ctx.agents.explorer,
          prompt: "Explore.",
        })),
      });

      const result = await runWorkflow(workflow, {
        store,
        executeTask: async () => ({ summary: "done" }),
      });

      const spans = store.listSpans(result.runId ?? "");
      const root = spans.find((span) => span.name === "workflow.run");
      const program = spans.find((span) => span.name === "workflow.program");
      const phaseSpan = spans.find((span) => span.name === "workflow.phase.delivery:explore");
      const task = spans.find((span) => span.name === "workflow.task");
      expect(root).toBeDefined();
      expect(program?.parentSpanId).toBe(root?.spanId ?? "");
      expect(phaseSpan?.parentSpanId).toBe(program?.spanId ?? "");
      expect(phaseSpan?.status).toBe("ok");
      expect(phaseSpan?.attributes.orbit).toBe("delivery");
      expect(phaseSpan?.attributes.phase).toBe("explore");
      expect(task?.parentSpanId).toBe(phaseSpan?.spanId ?? "");
      expect(phaseSpan?.attributes["agent.plugin"]).toBeUndefined();
      expect(phaseSpan?.attributes["agent.name"]).toBeUndefined();
      expect(task?.attributes["agent.plugin"]).toBe("forge");
      expect(task?.attributes["agent.name"]).toBe("builder");
      expect(spans.every((span) => span.traceId === root?.traceId)).toBe(true);
    });
  });

  test("dynamic run: author Effect.withSpan spans land in the trace and parent the task spans", async () => {
    await withStore(async (store) => {
      const build = defineTask({ id: "build", agent, prompt: "Build it.", output: Report });
      const workflow = defineWorkflow({
        name: "trace-dynamic",
        run: (runtime: WorkflowRuntime) =>
          runtime.runTask(build).pipe(Effect.withSpan("author.phase", { attributes: { phase: "one" } })),
      });
      const result = await runWorkflow(workflow, {
        store,
        executeTask: async () => ({ summary: "done" }),
      });
      const spans = store.listSpans(result.runId ?? "");
      const root = spans.find((span) => span.name === "workflow.run");
      const program = spans.find((span) => span.name === "workflow.program");
      const author = spans.find((span) => span.name === "author.phase");
      const task = spans.find((span) => span.name === "workflow.task");
      expect(root).toBeDefined();
      expect(program?.parentSpanId).toBe(root?.spanId ?? "");
      expect(author?.parentSpanId).toBe(program?.spanId ?? "");
      expect(author?.status).toBe("ok");
      expect(author?.attributes["phase"]).toBe("one");
      expect(task?.parentSpanId).toBe(author?.spanId ?? "");
      expect(spans.every((span) => span.traceId === root?.traceId)).toBe(true);
    });
  });

  test("unpersisted run records no spans and still succeeds", async () => {
    const build = defineTask({ id: "build", agent, prompt: "Build it.", output: Report });
    const workflow = defineWorkflow({ name: "trace-unpersisted", tasks: [build] as const });
    const result = await runWorkflow(workflow, { executeTask: async () => ({ summary: "done" }) });
    expect(result.tasks[0]?.status).toBe("completed");
  });
});

describe("trace tree rendering", () => {
  const span = (overrides: Partial<WorkflowSpanRecord>): WorkflowSpanRecord => ({
    runId: "r",
    traceId: "t".repeat(32),
    spanId: "s1",
    parentSpanId: null,
    taskId: null,
    name: "workflow.run",
    kind: "internal",
    startNs: 1_000_000n,
    endNs: 2_000_000n,
    status: "ok",
    errorMessage: null,
    attributes: {},
    ...overrides,
  });

  test("builds parent/child tree and orphans become roots", () => {
    const spans = [
      span({ spanId: "a" }),
      span({ spanId: "b", parentSpanId: "a", name: "workflow.task" }),
      span({ spanId: "c", parentSpanId: "missing", name: "task.executor" }),
    ];
    const tree = buildWorkflowSpanTree(spans);
    expect(tree).toHaveLength(2);
    expect(tree[0]?.children[0]?.span.spanId).toBe("b");
  });

  test("human render shows durations, statuses, and worker labels", () => {
    const spans = [
      span({ spanId: "a", attributes: { workflow: "demo" }, startNs: 0n, endNs: 65_000_000_000n }),
      span({
        spanId: "b",
        parentSpanId: "a",
        name: "workflow.task",
        taskId: "extract",
        startNs: 0n,
        endNs: 1_500_000_000n,
        attributes: { "agent.plugin": "survey", "agent.name": "context-forensics" },
      }),
      span({
        spanId: "c",
        parentSpanId: "b",
        name: "task.executor",
        status: "error",
        errorMessage: "spawn failed",
        attributes: { "executor.attempt": 0, "worker.adapter": "antigravity-cli" },
      }),
    ];
    const rendered = renderWorkflowTraceHuman(spans);
    expect(rendered).toContain("workflow.run · demo · 1m05s");
    expect(rendered).toContain("workflow.task · extract · survey/context-forensics · 1.5s");
    expect(rendered).toContain("task.executor · attempt 0 · antigravity-cli");
    expect(rendered).toContain("spawn failed");
    expect(rendered).toContain(`trace: ${"t".repeat(32)}`);
  });

  test("running span renders as running", () => {
    const rendered = renderWorkflowTraceHuman([span({ endNs: null, status: "unset" })]);
    expect(rendered).toContain("running");
  });
});

describe("otlp serialization", () => {
  test("serializes spans as OTLP resource spans with typed attributes", () => {
    const record: WorkflowSpanRecord = {
      runId: "run-1",
      traceId: "ab".repeat(16),
      spanId: "cd".repeat(8),
      parentSpanId: "ef".repeat(8),
      taskId: "build",
      name: "workflow.task",
      kind: "internal",
      startNs: 1_700_000_000_000_000_000n,
      endNs: 1_700_000_001_000_000_000n,
      status: "error",
      errorMessage: "boom",
      attributes: { "task.ordinal": 0, "task.cached": false, "agent.plugin": "forge" },
    };
    const payload = workflowSpansToOtlpJson([record], { serviceName: "prism-workflow" }) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
        scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
      }>;
    };
    const otlpSpan = payload.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(payload.resourceSpans[0]?.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "prism-workflow" },
    });
    expect(otlpSpan?.["traceId"]).toBe("ab".repeat(16));
    expect(otlpSpan?.["parentSpanId"]).toBe("ef".repeat(8));
    expect(otlpSpan?.["startTimeUnixNano"]).toBe("1700000000000000000");
    expect(otlpSpan?.["endTimeUnixNano"]).toBe("1700000001000000000");
    expect(otlpSpan?.["status"]).toEqual({ code: 2, message: "boom" });
    const attributes = otlpSpan?.["attributes"] as Array<{ key: string; value: Record<string, unknown> }>;
    expect(attributes).toContainEqual({ key: "task.ordinal", value: { intValue: "0" } });
    expect(attributes).toContainEqual({ key: "task.cached", value: { boolValue: false } });
    expect(attributes).toContainEqual({ key: "prism.run_id", value: { stringValue: "run-1" } });
    expect(attributes).toContainEqual({ key: "prism.task_id", value: { stringValue: "build" } });
  });
});

describe("workflow store registry", () => {
  test("registers stores, dedupes by path, and drops missing paths on read", async () => {
    const home = await mkdtemp(join(tmpdir(), "prism-registry-"));
    try {
      const storeRoot = await mkdtemp(join(tmpdir(), "prism-registry-store-"));
      const storePath = join(storeRoot, "workflows.sqlite");
      const store = await WorkflowStore.open(storePath);
      store.close();

      registerWorkflowStore(home, storePath);
      registerWorkflowStore(home, storePath);
      registerWorkflowStore(home, join(storeRoot, "missing.sqlite"));

      expect(existsSync(workflowStoreRegistryPath(home))).toBe(true);
      const entries = listRegisteredWorkflowStores(home);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.path).toBe(storePath);
      await rm(storeRoot, { recursive: true, force: true });
      expect(listRegisteredWorkflowStores(home)).toHaveLength(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
