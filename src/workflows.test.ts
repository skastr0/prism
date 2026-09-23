import { describe, expect, test } from "bun:test";
import { Context, Effect, Result, Schema, SchemaTransformation } from "effect";
import {
  decodeTaskOutput,
  defineTask,
  defineWorkflow,
  isWorkflowTask,
  phase,
  resolveWorkflowTaskModel,
  resolveWorkflowTaskModelResolution,
  workflowSummary,
  WorkflowModelResolutionError,
  type AnyWorkflowTask,
  type AnyWorkflowWorkerTask,
  type PhaseContract,
  type WorkflowModelProfileRef,
  type WorkflowPermissionMode,
  type WorkflowTaskWorkerOptions,
  type WorkflowWorkerId,
  type WorkflowWorkerIdWithoutRequiredOptions,
  type WorkflowRuntime,
  type WorkflowOutputSchema,
  type WorkflowTaskOutput,
  resolveWorkflowTaskEffort,
} from "./workflows.js";
import { workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { WORKFLOW_HARNESS_IDS, workflowHarnessDefaultModel } from "./workflow-harness-detection.js";
import { resolveWorkflowTaskPermission } from "./workflow-workers.js";
import { buildAmpArgs } from "./workflow-amp-worker.js";
import { buildAgyArgs } from "./workflow-antigravity-worker.js";
import { buildClaudeArgs } from "./workflow-claude-worker.js";
import { buildCodexArgs } from "./workflow-codex-worker.js";
import { buildGrokArgs } from "./workflow-grok-worker.js";
import { buildHermesArgs } from "./workflow-hermes-worker.js";
import { buildKimiArgs } from "./workflow-kimi-worker.js";
import { buildOpenCodeArgs } from "./workflow-opencode-worker.js";
import { isWorkflowPermissionMode, WORKFLOW_PERMISSION_MODES, WorkflowPermissionError } from "./workflow-permissions.js";

const modelProfile = {
  kind: "model-profile-ref",
  plugin: "agent-foundations",
  modelspace: "empirical-modelspaces",
  profile: "trusted-production",
  targets: {
    opencode: { strategy: "any-of", models: [{ model: "crof/kimi-k2.6" }, { model: "fallback/kimi" }] },
    "claude-code": { model: "claude-opus-4-8", effort: "max" },
    "codex-cli": { model: "gpt-5.1-codex", effort: "high" },
    grok: { model: "grok-build-fast" },
    hermes: { model: "openai/gpt-5.1-mini" },
    "kimi-code": { model: "moonshot/kimi-k2" },
    "amp-code": { model: "high" },
    "antigravity-cli": { model: "Gemini 3.5 Flash (Low)" },
  },
} as const satisfies WorkflowModelProfileRef;

const opencodeOnlyModelProfile = {
  ...modelProfile,
  targets: {
    opencode: modelProfile.targets.opencode,
  },
} as const satisfies WorkflowModelProfileRef;

const PatchReport = Schema.Struct({
  summary: Schema.String,
  filesChanged: Schema.Array(Schema.String),
});

const fixedEffortWorkerTypes = [
  defineTask({ id: "claude-effort-type", prompt: "p", output: PatchReport, worker: { worker: "claude-code", effort: "max" } }),
  defineTask({ id: "agy-effort-type", prompt: "p", output: PatchReport, worker: { worker: "antigravity-cli", effort: "high" } }),
  defineTask({ id: "hermes-effort-type", prompt: "p", output: PatchReport, worker: { worker: "hermes", effort: "ultra" } }),
  defineTask({ id: "omp-effort-type", prompt: "p", output: PatchReport, worker: { worker: "omp", effort: "auto" } }),
  defineTask({ id: "kimi-effort-type", prompt: "p", output: PatchReport, worker: { worker: "kimi-code", effort: "xhigh" } }),
];
void fixedEffortWorkerTypes;

// @ts-expect-error fixed CLI values come from the capability registry.
defineTask({ id: "invalid-claude-effort", prompt: "p", output: PatchReport, worker: { worker: "claude-code", effort: "ultra" } });
// @ts-expect-error Devin encodes effort in model slugs and has no worker.effort control.
defineTask({ id: "unsupported-devin-effort", prompt: "p", output: PatchReport, worker: { worker: "devin", effort: "high" } });
// @ts-expect-error OpenCode has model variants, not a per-task effort control.
defineTask({ id: "unsupported-opencode-effort", prompt: "p", output: PatchReport, worker: { worker: "opencode", effort: "high" } });
// @ts-expect-error Kimi Code's fixed effort values come from the capability registry.
defineTask({ id: "invalid-kimi-effort", prompt: "p", output: PatchReport, worker: { worker: "kimi-code", effort: "ultra" } });

const Exploration = Schema.Struct({
  assumption: Schema.String,
  options: Schema.Array(Schema.String),
});

class Multiplier extends Context.Service<Multiplier, number>()("test/Multiplier") {}

describe("workflow authoring primitives", () => {
  test("a heterogeneous task tuple keeps each task's concrete output type", () => {
    const build = defineTask({
      id: "build",
      prompt: "Build.",
      output: Schema.Struct({ summary: Schema.String }),
    });
    const review = defineTask({
      id: "review",
      prompt: "Review.",
      output: Schema.Struct({ verdict: Schema.Boolean }),
    });

    const workflow = defineWorkflow({ name: "heterogeneous", tasks: [build, review] as const });
    expect(workflow.tasks.map((task) => task.id)).toEqual(["build", "review"]);

    // The output erasure is confined to the task-collection bound: each task
    // still exposes its own decoded output type.
    const built: WorkflowTaskOutput<typeof build> = { summary: "ok" };
    const reviewed: WorkflowTaskOutput<typeof review> = { verdict: true };
    expect(built.summary).toBe("ok");
    expect(reviewed.verdict).toBe(true);

    const decoded = decodeTaskOutput(build, { summary: "ok" });
    expect(Result.isSuccess(decoded) && decoded.success.summary).toBe("ok");
  });

  test("the output schema bound requires never decoding and encoding services", () => {
    const serviceful = Schema.String.pipe(
      Schema.decodeTo(
        Schema.Number,
        SchemaTransformation.transformEffect({
          decode: (value: string) =>
            Effect.gen(function* () {
              const multiplier = yield* Multiplier;
              return Number(value) * multiplier;
            }),
          encode: (value: number) => Effect.succeed(String(value)),
        }),
      ),
    );

    // @ts-expect-error WorkflowOutputSchema requires never decoding and encoding services.
    const asOutput: WorkflowOutputSchema = serviceful;
    void asOutput;
  });

  test("workflow worker id includes antigravity", () => {
    const worker = "antigravity-cli";
    const liveWorker: WorkflowWorkerId = worker;
    expect(liveWorker).toBe("antigravity-cli");
  });

  test("workflow worker id includes cursor", () => {
    const worker = "cursor";
    const liveWorker: WorkflowWorkerId = worker;
    expect(liveWorker).toBe("cursor");
  });

  test("antigravity worker options reject unsupported permissions at type level", () => {
    const ok: WorkflowTaskWorkerOptions = { worker: "antigravity-cli", permission: "full-access" };
    expect(ok.permission).toBe("full-access");
    // @ts-expect-error Antigravity cannot enforce restricted permissions per invocation.
    const bad: WorkflowTaskWorkerOptions = { worker: "antigravity-cli", permission: "restricted" };
    void bad;
  });

  test("native no-save workers expose session persistence at the type level", () => {
    const ephemeralWorkers: ReadonlyArray<WorkflowTaskWorkerOptions> = [
      { worker: "claude-code", sessionPersistence: "ephemeral" },
      { worker: "codex-cli", sessionPersistence: "ephemeral" },
      { worker: "omp", sessionPersistence: "ephemeral" },
    ];
    const persistent: WorkflowTaskWorkerOptions = {
      worker: "codex-cli",
      sessionPersistence: "persistent",
    };
    expect(ephemeralWorkers.map((worker) => worker.sessionPersistence)).toEqual([
      "ephemeral",
      "ephemeral",
      "ephemeral",
    ]);
    expect(persistent.sessionPersistence).toBe("persistent");

    const unsupported: WorkflowTaskWorkerOptions = {
      worker: "grok",
      // @ts-expect-error Grok exposes no native no-save workflow mode.
      sessionPersistence: "ephemeral",
    };
    void unsupported;
  });

  test("workflow task runtime guard accepts native no-save workers and rejects the rest", () => {
    const base = defineTask({
      id: "build",
      prompt: "Build.",
      output: PatchReport,
    });
    for (const worker of ["claude-code", "codex-cli", "omp"] as const) {
      expect(isWorkflowTask({
        ...base,
        worker: { worker, sessionPersistence: "ephemeral" },
      })).toBe(true);
    }
    expect(isWorkflowTask({
      ...base,
      worker: { worker: "codex-cli", sessionPersistence: "temporary" },
    })).toBe(false);
    expect(isWorkflowTask({
      ...base,
      worker: { worker: "grok", sessionPersistence: "ephemeral" },
    })).toBe(false);
  });

  test("preserve literal task refs", () => {
    const build = defineTask({
      id: "build",
      prompt: "Implement the smallest useful slice.",
      output: PatchReport,
      cacheKey: "workflow-refs-build",
    });

    const workflow = defineWorkflow({ name: "workflow-refs", tasks: [build] as const });

    expect(workflow.kind).toBe("workflow");
    expect(workflow.tasks[0]?.kind).toBe("workflow-task");
    expect(workflow.tasks[0]?.cacheKey).toBe("workflow-refs-build");
  });

  test("preserves task-level worker model selection", () => {
    const build = defineTask({
      id: "build",
      prompt: "Use the build model.",
      output: PatchReport,
      worker: { model: "grok-build" },
    });

    expect(build.worker?.model).toBe("grok-build");
  });

  test("resolves task model refs through the selected workflow worker", () => {
    const build = defineTask({
      id: "build",
      prompt: "Use the selected model profile.",
      output: PatchReport,
      worker: { worker: "opencode", model: modelProfile },
    });

    expect(resolveWorkflowTaskModel(build)).toBe("crof/kimi-k2.6");
  });

  test("resolved opencode modelspace target flows into worker args", () => {
    const build = defineTask({
      id: "build",
      prompt: "Use the selected model profile.",
      output: PatchReport,
      worker: { worker: "opencode", model: modelProfile },
    });

    const model = resolveWorkflowTaskModel(build);
    const args = buildOpenCodeArgs({ model, prompt: build.prompt, permission: "legacy" });
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "crof/kimi-k2.6"]);
  });

  test("resolved modelspace targets flow into non-opencode worker args", () => {
    const taskFor = (worker: WorkflowWorkerIdWithoutRequiredOptions) =>
      defineTask({
        id: `build-${worker}`,
        prompt: "Use the selected model profile.",
        output: PatchReport,
        worker: { worker, model: modelProfile },
      });

    const claude = taskFor("claude-code");
    const claudeArgs = buildClaudeArgs({
      model: resolveWorkflowTaskModel(claude),
      prompt: claude.prompt,
      permission: "legacy",
    });
    expect(claudeArgs.slice(claudeArgs.indexOf("--model"), claudeArgs.indexOf("--model") + 2)).toEqual(["--model", "claude-opus-4-8"]);

    const codex = taskFor("codex-cli");
    const codexArgs = buildCodexArgs({
      cwd: "/tmp",
      model: resolveWorkflowTaskModel(codex),
      outputPath: "/tmp/out",
      prompt: codex.prompt,
      permission: "legacy",
    });
    expect(codexArgs.slice(codexArgs.indexOf("--model"), codexArgs.indexOf("--model") + 2)).toEqual(["--model", "gpt-5.1-codex"]);

    const grok = taskFor("grok");
    expect(buildGrokArgs({
      cwd: "/tmp",
      model: resolveWorkflowTaskModel(grok),
      prompt: grok.prompt,
      permission: "legacy",
    }).slice(0, 2)).toEqual(["--model", "grok-build-fast"]);

    const hermes = taskFor("hermes");
    const hermesArgs = buildHermesArgs({
      model: resolveWorkflowTaskModel(hermes),
      prompt: hermes.prompt,
      permission: "legacy",
    });
    expect(hermesArgs.slice(hermesArgs.indexOf("--model"), hermesArgs.indexOf("--model") + 2)).toEqual(["--model", "openai/gpt-5.1-mini"]);

    const kimi = taskFor("kimi-code");
    expect(buildKimiArgs({
      model: resolveWorkflowTaskModel(kimi),
      prompt: kimi.prompt,
      skillsDir: "/tmp/skills",
      permission: "legacy",
    }).slice(0, 2)).toEqual(["--model", "moonshot/kimi-k2"]);

    const amp = taskFor("amp-code");
    const ampArgs = buildAmpArgs({
      mode: resolveWorkflowTaskModel(amp),
      prompt: amp.prompt,
      permission: "legacy",
    });
    expect(ampArgs.slice(ampArgs.indexOf("--mode"), ampArgs.indexOf("--mode") + 2)).toEqual(["--mode", "high"]);

    const antigravity = taskFor("antigravity-cli");
    const antigravityModel = resolveWorkflowTaskModel(antigravity);
    expect(antigravityModel).toBe("Gemini 3.5 Flash (Low)");
    const agyArgs: readonly string[] = buildAgyArgs({
      cwd: "/tmp",
      model: antigravityModel!,
      prompt: antigravity.prompt,
      printTimeout: "5m",
      permission: "legacy",
    });
    const agyModelArgs = agyArgs.slice(agyArgs.indexOf("--model"), agyArgs.indexOf("--model") + 2) as readonly string[];
    expect(agyModelArgs).toEqual(["--model", "Gemini 3.5 Flash (Low)"]);
  });

  test("uses the worker model profile before CLI fallback model", () => {
    const build = defineTask({
      id: "build",
      prompt: "Use the worker model profile.",
      output: PatchReport,
      worker: { worker: "claude-code", model: modelProfile },
    });

    expect(resolveWorkflowTaskModel(build, { fallbackModel: "sonnet" })).toBe("claude-opus-4-8");
  });

  test("preserves raw task model strings as an escape hatch", () => {
    const build = defineTask({
      id: "build",
      prompt: "Use the raw model.",
      output: PatchReport,
      worker: { worker: "opencode", model: "provider/manual-model" },
    });

    expect(resolveWorkflowTaskModel(build)).toBe("provider/manual-model");
  });

  test("fails closed when a model ref does not support the selected worker", () => {
    const build = defineTask({
      id: "build",
      prompt: "Use the selected model profile.",
      output: PatchReport,
      worker: { worker: "codex-cli", model: opencodeOnlyModelProfile },
    });

    expect(() => resolveWorkflowTaskModel(build)).toThrow(WorkflowModelResolutionError);
  });

  test("preserves harness reasoning effort from model profiles", () => {
    const profiled = defineTask({
      id: "profiled",
      prompt: "Use the profile variant.",
      output: PatchReport,
      worker: { worker: "codex-cli", model: modelProfile },
    });
    expect(resolveWorkflowTaskModelResolution(profiled)).toEqual({
      model: "gpt-5.1-codex",
      effort: "high",
      source: "task",
    });
  });

  test("task worker effort overrides modelspace effort", () => {
    const profiled = defineTask({
      id: "profiled",
      prompt: "Use the profile effort unless overridden.",
      output: PatchReport,
      worker: {
        worker: "claude-code",
        effort: "low",
        model: {
          ...modelProfile,
          targets: { "claude-code": { model: "claude-opus-4-8", effort: "max" } },
        },
      },
    });
    expect(resolveWorkflowTaskEffort(profiled)).toBe("low");
  });

  test("an explicit CLI --model fallback resolves a task with no worker model", () => {
    const task = defineTask({
      id: "build",
      prompt: "Use the CLI fallback.",
      output: PatchReport,
      worker: { worker: "grok" },
    });

    const resolution = resolveWorkflowTaskModelResolution(task, { fallbackModel: "operator-supplied-model" });
    expect(resolution).toEqual({ model: "operator-supplied-model", source: "cli-fallback" });
  });

  test("decodes task output at the workflow boundary", () => {
    const build = defineTask({
      id: "build",
      prompt: "Return a patch report.",
      output: PatchReport,
    });

    const decoded = decodeTaskOutput(build, {
      summary: "emitted workflow refs",
      filesChanged: ["src/compile/workflow-refs-emitter.ts"],
    });
    expect(Result.isSuccess(decoded)).toBe(true);

    const rejected = decodeTaskOutput(build, {
      summary: "missing filesChanged",
    });
    expect(Result.isFailure(rejected)).toBe(true);
  });

  test("infers decoded output type from the task schema", () => {
    const build = defineTask({
      id: "build",
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

  test("claude-code rejects sandbox-read-only at the type", () => {
    defineTask({
      id: "claude-sandbox-type",
      prompt: "test",
      output: PatchReport,
      worker: {
        worker: "claude-code",
        // @ts-expect-error Claude Code has no sandbox permission flag
        permission: "sandbox-read-only",
      },
    });
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
      prompt: "test",
      output: PatchReport,
      worker: { worker: "opencode", permission: "legacy" },
    });
    expect(resolveWorkflowTaskPermission(task, "permissive")).toBe("legacy");
  });

  test("workflow task permission defaults to permissive when both are undefined", () => {
    const task = defineTask({
      id: "perm-default",
      prompt: "test",
      output: PatchReport,
      worker: { worker: "opencode" },
    });
    expect(resolveWorkflowTaskPermission(task)).toBe("permissive");
  });

  test("workflow task permission uses runtime fallback when task has no permission", () => {
    const task = defineTask({
      id: "perm-pass",
      prompt: "test",
      output: PatchReport,
      worker: { worker: "opencode" },
    });
    expect(resolveWorkflowTaskPermission(task, "legacy")).toBe("legacy");
  });

  test("workflow task worker options preserve restricted tool lists", () => {
    const task = defineTask({
      id: "perm-restricted-tools",
      prompt: "test",
      output: PatchReport,
      worker: { worker: "claude-code", permission: "restricted", restrictedTools: ["Read", "Edit"] },
    });
    expect(task.worker?.restrictedTools).toEqual(["Read", "Edit"]);
  });

  test("unsupported resolved permission fails closed in the opencode interpreter", () => {
    const task = defineTask({
      id: "perm-fail",
      prompt: "test",
      output: PatchReport,
      worker: { worker: "opencode" },
    });
    const permission = resolveWorkflowTaskPermission(task, "sandbox-read-only");
    expect(() => buildOpenCodeArgs({ prompt: task.prompt, permission }))
      .toThrow(WorkflowPermissionError);
  });

  test("dynamic workflows expose decoded task outputs to later code", async () => {
    const discover = defineTask({
      id: "discover",
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
      phase: () => Effect.die("unused in this test") as never,
    }))).toBe("src/workflows.ts");
  });
});

describe("workflow phase DSL", () => {
  const ExploreInput = Schema.Struct({ brief: Schema.String });

  const exploreContract = {
    name: "explore",
    sop: "beacon",
    plugin: "core",
    input: ExploreInput,
    output: Exploration,
    framing: { purpose: "Reduce ambiguity before build." },
    criteria: ["Surface at least one option", "Name the core assumption"],
  } as const satisfies PhaseContract<"explore", typeof ExploreInput, typeof Exploration>;

  const mockRuntime = (
    runTask: WorkflowRuntime["runTask"],
  ): WorkflowRuntime => ({
    runTask,
    phase: (contract, fn) => phase({ runTask }, contract, fn),
  });

  test("phase ctx.task defaults output schema to the contract output", async () => {
    const prompts: string[] = [];
    const workflow = defineWorkflow({
      name: "phase-default-output",
      run: (wf) => phase(wf, exploreContract, (ctx) => Effect.gen(function* () {
        return yield* ctx.task({
          id: "scope",
          input: { brief: "typed" },
          prompt: "Explore the goal.",
        });
      })),
    });

    const result = await Effect.runPromise(workflow.run!(mockRuntime((task) => Effect.sync(() => {
      prompts.push((task as AnyWorkflowWorkerTask).prompt);
      return { assumption: "typed default", options: ["a"] };
    }) as never)));

    expect(result).toEqual({ assumption: "typed default", options: ["a"] });
    expect(prompts[0]).toContain("## Phase beacon:explore");
    expect(prompts[0]).toContain("Purpose: Reduce ambiguity before build.");
    expect(prompts[0]).toContain("Explore the goal.");
    expect(prompts[0]).toContain("## Input");
    expect(prompts[0]).toContain('"brief": "typed"');
  });

  test("phase ctx.task allows explicit output overrides", async () => {
    const workflow = defineWorkflow({
      name: "phase-output-override",
      run: (wf) => phase(wf, exploreContract, (ctx) => Effect.gen(function* () {
        return yield* ctx.task({
          id: "summarize",
          input: { brief: "typed" },
          prompt: "Return a patch report.",
          output: PatchReport,
        });
      })),
    });

    const result = await Effect.runPromise(workflow.run!(mockRuntime(() =>
      Effect.succeed({ summary: "override", filesChanged: ["src/workflows.ts"] }) as never,
    )));
    expect(result).toEqual({ summary: "override", filesChanged: ["src/workflows.ts"] });
  });

  test("phase ctx.task injects sop:phase into dispatched tasks", async () => {
    let capturedPhase: string | undefined;
    const workflow = defineWorkflow({
      name: "phase-annotation",
      run: (wf) => phase(wf, exploreContract, (ctx) => ctx.task({
        id: "scope",
        input: { brief: "typed" },
        prompt: "go",
      })),
    });

    await Effect.runPromise(workflow.run!(mockRuntime((task) => Effect.sync(() => {
      capturedPhase = task.phase;
      return { assumption: "a", options: [] };
    }) as never)));
    expect(capturedPhase).toBe("beacon:explore");
  });

  test("phase ctx.task fails with a typed input error when the contract input does not decode", async () => {
    const workflow = defineWorkflow({
      name: "phase-bad-input",
      run: (wf) => phase(wf, exploreContract, (ctx) => ctx.task({
        id: "scope",
        // @ts-expect-error number is not assignable to the contract's `brief: string`
        input: { brief: 42 },
        prompt: "go",
      })),
    });

    const exit = await Effect.runPromiseExit(workflow.run!(mockRuntime(() =>
      Effect.succeed({ assumption: "a", options: [] }) as never,
    )));
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw new Error("expected failure");
    const failure = exit.cause;
    expect(JSON.stringify(failure)).toContain("WorkflowTaskInputError");
  });

  test("phase ctx.task inherits judge criteria from acceptance criteria", async () => {
    let capturedCriteria: ReadonlyArray<{ readonly name: string; readonly goal?: unknown }> = [];
    const workflow = defineWorkflow({
      name: "phase-inherit-criteria",
      run: (wf) => phase(wf, exploreContract, (ctx) => ctx.task({
        id: "scope",
        input: { brief: "typed" },
        prompt: "go",
      })),
    });

    await Effect.runPromise(workflow.run!(mockRuntime((task) => Effect.sync(() => {
      capturedCriteria = ((task as AnyWorkflowWorkerTask).finish?.criteria ?? []) as never;
      return { assumption: "a", options: [] };
    }) as never)));
    const inherited = capturedCriteria.find((criterion) => criterion.name === "phase-contract");
    expect(inherited).toBeDefined();
    expect(String(inherited?.goal)).toContain("Surface at least one option");
  });

  test("brief:false skips framing preamble injection but keeps the typed input block", async () => {
    const prompts: string[] = [];
    const workflow = defineWorkflow({
      name: "phase-brief",
      run: (wf) => phase(wf, exploreContract, (ctx) => ctx.task({
        id: "scope",
        input: { brief: "typed" },
        prompt: "Bare prompt only.",
        brief: false,
      })),
    });

    await Effect.runPromise(workflow.run!(mockRuntime((task) => Effect.sync(() => {
      prompts.push((task as AnyWorkflowWorkerTask).prompt);
      return { assumption: "a", options: [] };
    }) as never)));
    expect(prompts[0]).toBe("Bare prompt only.\n\n## Input\n\n```json\n{\n  \"brief\": \"typed\"\n}\n```");
  });
});

describe("agent-free workflow tasks", () => {
  test("defineTask accepts a task with only worker/prompt/output", () => {
    const bare = defineTask({
      id: "bare",
      prompt: "Do the work.",
      output: PatchReport,
      worker: { worker: "claude-code", model: "claude-opus-4-8" },
    });
    expect(isWorkflowTask(bare)).toBe(true);
    expect(bare.id).toBe("bare");
    expect(bare.worker?.worker).toBe("claude-code");
  });

  test("workflowSummary reports ids and cache keys without agent identity", () => {
    const bare = defineTask({ id: "bare", prompt: "Do the work.", output: PatchReport });
    const cached = defineTask({ id: "cached", prompt: "Do the work.", output: PatchReport, cacheKey: "bound-cache" });
    const summary = workflowSummary("/tmp/wf.ts", defineWorkflow({
      name: "mixed",
      tasks: [bare, cached] as const,
    }));
    expect(summary.tasks).toEqual([
      { id: "bare" },
      { id: "cached", cacheKey: "bound-cache" },
    ]);
  });

  test("workflowWorkerJsonInstruction carries no agent identity", () => {
    const task = defineTask({ id: "bare", prompt: "Do the work.", output: PatchReport });
    const instruction = workflowWorkerJsonInstruction(task);
    expect(instruction).toContain("Task id: bare");
    expect(instruction).not.toContain("Agent identity");
  });
});
