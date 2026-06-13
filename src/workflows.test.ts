import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";
import {
  decodeTaskOutput,
  defineTask,
  defineWorkflow,
  type WorkflowAgentRef,
  type WorkflowTaskOutput,
} from "./workflows.js";

const builder = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourcePath: "/plugins/forge/agents/builder.agent.ts",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["grok", "codex-cli"],
} as const satisfies WorkflowAgentRef;

const PatchReport = Schema.Struct({
  summary: Schema.String,
  filesChanged: Schema.Array(Schema.String),
});

describe("workflow authoring primitives", () => {
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

  test("dynamic workflows expose decoded task outputs to later code", async () => {
    const discover = defineTask({
      id: "discover",
      agent: builder,
      prompt: "Return a patch report.",
      output: PatchReport,
    });
    const workflow = defineWorkflow({
      name: "dynamic-typed",
      run: async (wf) => {
        const report = await wf.runTask(discover);
        return report.filesChanged.join(",");
      },
    });

    expect(workflow.kind).toBe("workflow");
    expect(workflow.tasks).toEqual([]);
    expect(await workflow.run({
      runTask: async () => ({ summary: "typed", filesChanged: ["src/workflows.ts"] }) as never,
    })).toBe("src/workflows.ts");
  });
});
