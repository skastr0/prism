import { describe, expect, test } from "bun:test";
import { Effect, Either, Schema } from "effect";
import {
  decodeTaskOutput,
  defineTask,
  defineWorkflow,
  resolveWorkflowTaskModel,
  WorkflowModelResolutionError,
  type WorkflowAgentRef,
  type WorkflowModelProfileRef,
  type WorkflowPermissionMode,
  type WorkflowWorkerId,
  type WorkflowTaskOutput,
} from "./workflows.js";
import { resolveWorkflowTaskPermission } from "./workflow-workers.js";
import { buildOpenCodeArgs } from "./workflow-opencode-worker.js";
import { isWorkflowPermissionMode, WORKFLOW_PERMISSION_MODES, WorkflowPermissionError } from "./workflow-permissions.js";

const builder = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["grok", "codex-cli"],
} as const satisfies WorkflowAgentRef;

const modelProfile = {
  kind: "model-profile-ref",
  plugin: "agent-foundations",
  modelspace: "empirical-modelspaces",
  profile: "trusted-production",
  targets: {
    opencode: { strategy: "any-of", models: [{ model: "crof/kimi-k2.6" }, { model: "fallback/kimi" }] },
    "claude-code": { model: "claude-opus-4-8", effort: "max" },
  },
} as const satisfies WorkflowModelProfileRef;

const modelspaceBackedBuilder = {
  ...builder,
  model: {
    modelspace: "agent-foundations:empirical-modelspaces",
    profile: "trusted-production",
    targets: modelProfile.targets,
  },
} as const satisfies WorkflowAgentRef;

const PatchReport = Schema.Struct({
  summary: Schema.String,
  filesChanged: Schema.Array(Schema.String),
});

describe("workflow authoring primitives", () => {
  test("workflow worker id excludes quarantined antigravity", () => {
    const worker = "antigravity-cli";
    // @ts-expect-error Antigravity is quarantined from live workflow dispatch.
    const liveWorker: WorkflowWorkerId = worker;
    void liveWorker;
    expect(worker).toBe("antigravity-cli");
  });

  test("preserve literal task and agent refs", () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Implement the smallest useful slice.",
      output: PatchReport,
      cacheKey: "workflow-refs-build",
    });

    const workflow = defineWorkflow({ name: "workflow-refs", tasks: [build] as const });

    expect(workflow.kind).toBe("workflow");
    expect(workflow.tasks[0]?.kind).toBe("workflow-task");
    expect(workflow.tasks[0]?.agent.name).toBe("builder");
    expect(workflow.tasks[0]?.cacheKey).toBe("workflow-refs-build");
  });

  test("preserves task-level worker model selection", () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Use the build model.",
      output: PatchReport,
      worker: { model: "grok-build" },
    });

    expect(build.worker?.model).toBe("grok-build");
  });

  test("resolves task model refs through the selected workflow worker", () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Use the selected model profile.",
      output: PatchReport,
      worker: { worker: "opencode", model: modelProfile },
    });

    expect(resolveWorkflowTaskModel(build)).toBe("crof/kimi-k2.6");
  });

  test("resolved opencode modelspace target flows into worker args", () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Use the selected model profile.",
      output: PatchReport,
      worker: { worker: "opencode", model: modelProfile },
    });

    const model = resolveWorkflowTaskModel(build);
    const args = buildOpenCodeArgs({ cwd: "/tmp", agent: build.agent.name, model, prompt: build.prompt, permission: "legacy" });
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "crof/kimi-k2.6"]);
  });

  test("uses the agent modelspace before CLI fallback model", () => {
    const build = defineTask({
      id: "build",
      agent: modelspaceBackedBuilder,
      prompt: "Use the agent model profile.",
      output: PatchReport,
      worker: { worker: "claude-code" },
    });

    expect(resolveWorkflowTaskModel(build, { fallbackModel: "sonnet" })).toBe("claude-opus-4-8");
  });

  test("preserves raw task model strings as an escape hatch", () => {
    const build = defineTask({
      id: "build",
      agent: modelspaceBackedBuilder,
      prompt: "Use the raw model.",
      output: PatchReport,
      worker: { worker: "opencode", model: "provider/manual-model" },
    });

    expect(resolveWorkflowTaskModel(build)).toBe("provider/manual-model");
  });

  test("resolves modelResolver from the selected agent model target", () => {
    const build = defineTask({
      id: "build",
      agent: modelspaceBackedBuilder,
      prompt: "Pick a model from the target object.",
      output: PatchReport,
      worker: {
        worker: "opencode",
        modelResolver: (models) => {
          const first = models.kimiK26;
          if (Array.isArray(first)) return first[0]?.model ?? "";
          return first?.model ?? "";
        },
      },
    });

    expect(resolveWorkflowTaskModel(build)).toBe("crof/kimi-k2.6");
  });

  test("fails closed when a model ref does not support the selected worker", () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Use the selected model profile.",
      output: PatchReport,
      worker: { worker: "codex-cli", model: modelProfile },
    });

    expect(() => resolveWorkflowTaskModel(build)).toThrow(WorkflowModelResolutionError);
  });

  test("decodes task output at the workflow boundary", () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Return a patch report.",
      output: PatchReport,
    });

    const decoded = decodeTaskOutput(build, {
      summary: "emitted workflow refs",
      filesChanged: ["src/compile/workflow-refs-emitter.ts"],
    });
    expect(Either.isRight(decoded)).toBe(true);

    const rejected = decodeTaskOutput(build, {
      summary: "missing filesChanged",
    });
    expect(Either.isLeft(rejected)).toBe(true);
  });

  test("infers decoded output type from the task schema", () => {
    const build = defineTask({
      id: "build",
      agent: builder,
      prompt: "Return a patch report.",
      output: PatchReport,
    });

    const report: WorkflowTaskOutput<typeof build> = {
      summary: "typed",
      filesChanged: ["src/workflows.ts"],
    };

    expect(report.filesChanged).toEqual(["src/workflows.ts"]);

    // @ts-expect-error decoded output must match the Effect Schema, not prose.
    const invalid: WorkflowTaskOutput<typeof build> = { summary: "typed" };
    expect(invalid).toBeDefined();
  });

  test("workflow permission mode type includes all expected values", () => {
    const modes: WorkflowPermissionMode[] = [
      "legacy", "permissive", "restricted", "interactive",
      "sandbox-read-only", "sandbox-workspace-write", "full-access",
    ];
    expect(modes.length).toBe(7);
  });

  test("workflow permission mode runtime guard accepts only known modes", () => {
    expect(WORKFLOW_PERMISSION_MODES).toEqual([
      "legacy", "permissive", "restricted", "interactive",
      "sandbox-read-only", "sandbox-workspace-write", "full-access",
    ]);
    for (const mode of WORKFLOW_PERMISSION_MODES) {
      expect(isWorkflowPermissionMode(mode)).toBe(true);
    }
    expect(isWorkflowPermissionMode("danger-full-access")).toBe(false);
    expect(isWorkflowPermissionMode("")).toBe(false);
  });

  test("workflow task permission resolves task permission over runtime fallback", () => {
    const task = defineTask({
      id: "perm-test",
      agent: builder,
      prompt: "test",
      output: PatchReport,
      worker: { worker: "opencode", permission: "legacy" },
    });
    expect(resolveWorkflowTaskPermission(task, "permissive")).toBe("legacy");
  });

  test("workflow task permission defaults to permissive when both are undefined", () => {
    const task = defineTask({
      id: "perm-default",
      agent: builder,
      prompt: "test",
      output: PatchReport,
      worker: { worker: "opencode" },
    });
    expect(resolveWorkflowTaskPermission(task)).toBe("permissive");
  });

  test("workflow task permission uses runtime fallback when task has no permission", () => {
    const task = defineTask({
      id: "perm-pass",
      agent: builder,
      prompt: "test",
      output: PatchReport,
      worker: { worker: "opencode" },
    });
    expect(resolveWorkflowTaskPermission(task, "legacy")).toBe("legacy");
  });

  test("workflow task worker options preserve restricted tool lists", () => {
    const task = defineTask({
      id: "perm-restricted-tools",
      agent: builder,
      prompt: "test",
      output: PatchReport,
      worker: { worker: "claude-code", permission: "restricted", restrictedTools: ["Read", "Edit"] },
    });
    expect(task.worker?.restrictedTools).toEqual(["Read", "Edit"]);
  });

  test("unsupported resolved permission fails closed in the opencode interpreter", () => {
    const task = defineTask({
      id: "perm-fail",
      agent: builder,
      prompt: "test",
      output: PatchReport,
      worker: { worker: "opencode" },
    });
    const permission = resolveWorkflowTaskPermission(task, "sandbox-read-only");
    expect(() => buildOpenCodeArgs({ cwd: "/tmp", agent: task.agent.name, prompt: task.prompt, permission }))
      .toThrow(WorkflowPermissionError);
  });

  test("dynamic workflows expose decoded task outputs to later code", async () => {
    const discover = defineTask({
      id: "discover",
      agent: builder,
      prompt: "Return a patch report.",
      output: PatchReport,
    });
    const workflow = defineWorkflow({
      name: "dynamic-typed",
      run: (wf) => Effect.gen(function* () {
        const report = yield* wf.runTask(discover);
        return report.filesChanged.join(",");
      }),
    });

    expect(workflow.kind).toBe("workflow");
    expect(workflow.tasks).toEqual([]);
    expect(await Effect.runPromise(workflow.run({
      runTask: () => Effect.succeed({ summary: "typed", filesChanged: ["src/workflows.ts"] }) as never,
    }))).toBe("src/workflows.ts");
  });
});
