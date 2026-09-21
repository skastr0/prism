import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import {
  choice,
  JEV_RESULT_CONTRACT_VERSION,
  noul,
  type JevAnswers,
  type JevResult,
} from "./jev.js";
import {
  JevClient,
  JevClientTest,
  JevError,
  type JevPublicConfig,
} from "./services/jev.js";
import {
  defineTask,
  defineWorkflow,
  isJevTask,
  isWorkflowWorkerTask,
  jev,
  phase,
  type AnyWorkflowTask,
  type AnyWorkflowWorkerTask,
  type JevTask,
  type PhaseContract,
  type WorkflowRuntime,
} from "./workflows.js";
import { createWorkflowTaskExecutor } from "./workflow-executors.js";
import {
  WorkflowJevExecutionError,
} from "./workflow-jev.js";
import {
  runWorkflow,
  WorkflowTaskDecodeError,
} from "./workflow-runner.js";
import { workflowTaskIdentity } from "./workflow-identity.js";
import { WorkflowStore } from "./workflow-store.js";

const questions = {
  route: choice({
    instructions: "Choose the next action.",
    criteria: {
      act: "The request is clear and safe to execute.",
      clarify: "Important information is missing.",
    },
  }),
  destructive: noul({ instructions: "Would the action destroy user data?" }),
} as const;

const answers: JevAnswers<typeof questions> = {
  route: {
    type: "choice",
    choice: "act",
    confidence: 0.9,
    probabilities: { act: 0.9, clarify: 0.1 },
  },
  destructive: { type: "noul", noul: 0.02 },
};

const cannedResult: JevResult<typeof questions> = {
  model: "jev-test",
  answers,
  usage: { input_tokens: 12, output_tokens: 7 },
};

const jevConfig: JevPublicConfig = { baseURL: "https://jev.test", defaultModel: "jev-test" };

const routeTask = () =>
  jev({
    id: "route",
    state: { ticket: "Rename the CLI flag", risk: "low" },
    questions,
  });

const tempStores: string[] = [];
const openStore = async (): Promise<WorkflowStore> => {
  const dir = await mkdtemp(join(tmpdir(), "prism-jev-runner-"));
  tempStores.push(dir);
  return await WorkflowStore.open(join(dir, "workflows.sqlite"));
};

const cleanupStores = async (): Promise<void> => {
  while (tempStores.length > 0) {
    const dir = tempStores.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
};

describe("workflow jev dispatch executor", () => {
  test("routes jev tasks to the JevClient layer and worker tasks to the worker executor", async () => {
    const workerIds: string[] = [];
    const executor = createWorkflowTaskExecutor({
      executeWorkflowTask: (task) => {
        workerIds.push(task.id);
        return Promise.resolve({ summary: "worker ran" });
      },
      jev: JevClientTest(questions, answers, { usage: { input_tokens: 12, output_tokens: 7 } }),
    });

    const workerResult = await executor(defineTask({
      id: "build",
      prompt: "Build.",
      output: Schema.Struct({ summary: Schema.String }),
    }));
    expect(workerIds).toEqual(["build"]);
    expect(workerResult).toEqual({ summary: "worker ran" });

    const jevExecution = await executor(routeTask());
    expect(workerIds).toEqual(["build"]);
    expect(jevExecution).toMatchObject({
      output: cannedResult,
      metadata: {
        taskKind: "jev",
        adapter: "jev",
        api: "systemone",
        jevContractVersion: JEV_RESULT_CONTRACT_VERSION,
        model: "jev-test",
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    });
    const metadata = (jevExecution as { metadata: Record<string, unknown> }).metadata;
    expect(typeof metadata.durationMs).toBe("number");
  });

  test("a jev task without a JevClient layer fails loudly instead of reaching a worker adapter", async () => {
    const executor = createWorkflowTaskExecutor({
      executeWorkflowTask: () => Promise.resolve({ should: "never happen" }),
    });
    await expect(executor(routeTask())).rejects.toThrow(WorkflowJevExecutionError);
    await expect(executor(routeTask())).rejects.toThrow(/no JevClient layer was provided/);
  });

  test("JevClient failures surface as WorkflowJevExecutionError carrying the typed kind", async () => {
    const failing = Layer.sync(JevClient, () => ({
      config: jevConfig,
      systemOne: () =>
        Effect.fail(new JevError({ kind: "rate-limit", message: "slow down", retryAfterMs: 250 })),
    }));
    const executor = createWorkflowTaskExecutor({
      executeWorkflowTask: () => Promise.resolve({}),
      jev: failing,
    });
    const error = await executor(routeTask()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkflowJevExecutionError);
    expect((error as WorkflowJevExecutionError).jevError.kind).toBe("rate-limit");
    expect((error as Error).message).toContain("rate-limit");
  });
});

describe("workflowTaskIdentity for jev tasks", () => {
  // The cache primary key is (cacheKey, promptHash); request semantics live in
  // promptHash. A jev task's promptHash is the semantic hash of its full
  // System One request plus the public service config.
  test("a jev task and a worker task with the same id never share request semantics", () => {
    const worker = defineTask({
      id: "route",
      prompt: "Choose the next action.",
      output: Schema.Struct({ summary: Schema.String }),
    });
    const jevIdentity = workflowTaskIdentity("wf", routeTask(), {}, jevConfig);
    const workerIdentity = workflowTaskIdentity("wf", worker, {});
    expect(jevIdentity.cacheKey).toBe(workerIdentity.cacheKey);
    expect(jevIdentity.promptHash).not.toBe(workerIdentity.promptHash);
  });

  test("question wording and public config are part of the request hash, timeoutMs is not", () => {
    const base = workflowTaskIdentity("wf", routeTask(), {}, jevConfig);
    const reworded = workflowTaskIdentity("wf", jev({
      id: "route",
      state: { ticket: "Rename the CLI flag", risk: "low" },
      questions: {
        route: choice({
          instructions: "Choose the next action, carefully.",
          criteria: questions.route.criteria,
        }),
        destructive: questions.destructive,
      },
    }), {}, jevConfig);
    expect(reworded.promptHash).not.toBe(base.promptHash);

    const otherBaseURL = workflowTaskIdentity("wf", routeTask(), {}, {
      ...jevConfig,
      baseURL: "https://jev.other",
    });
    expect(otherBaseURL.promptHash).not.toBe(base.promptHash);

    const otherModel = workflowTaskIdentity("wf", routeTask(), {}, {
      ...jevConfig,
      defaultModel: "jev-other-model",
    });
    expect(otherModel.promptHash).not.toBe(base.promptHash);

    const withTimeout = workflowTaskIdentity("wf", jev({
      id: "route",
      state: { ticket: "Rename the CLI flag", risk: "low" },
      questions,
      timeoutMs: 5_000,
    }), {}, jevConfig);
    expect(withTimeout.promptHash).toBe(base.promptHash);
    expect(withTimeout.cacheKey).toBe(base.cacheKey);
  });

  test("identity requires the public jev config for jev tasks", () => {
    expect(() => workflowTaskIdentity("wf", routeTask(), {})).toThrow(/jev/);
  });

  test("an own __proto__ key in state changes the request hash", () => {
    // JSON.parse creates "__proto__" as an own data property; a hash that
    // loses it would silently reuse an unrelated cached answer.
    const empty = workflowTaskIdentity(
      "wf",
      jev({ id: "route", state: {}, questions }),
      {},
      jevConfig,
    );
    const withProto = workflowTaskIdentity(
      "wf",
      jev({
        id: "route",
        state: JSON.parse('{"__proto__":{"risk":"high"}}'),
        questions,
      }),
      {},
      jevConfig,
    );
    expect(withProto.promptHash).not.toBe(empty.promptHash);
  });
});

describe("workflow runner jev tasks", () => {
  test("runs a jev task end-to-end: typed output, stamped metadata, persisted jev snapshot", async () => {
    await cleanupStores();
    const store = await openStore();
    const workflow = defineWorkflow({
      name: "jev-e2e",
      run: (wf) => Effect.gen(function* () {
        const result = yield* wf.runTask(routeTask());
        return { next: result.answers.route.choice };
      }),
    });
    const executor = createWorkflowTaskExecutor({
      executeWorkflowTask: () => Promise.resolve({ unreachable: true }),
      jev: JevClientTest(questions, answers, { usage: { input_tokens: 3, output_tokens: 2 } }),
    });

    const result = await runWorkflow(workflow, { store, executeTask: executor, jev: jevConfig });
    expect(result.output).toEqual({ next: "act" });
    expect(result.tasks).toHaveLength(1);
    const taskResult = result.tasks[0]!;
    expect(taskResult.status).toBe("completed");
    expect(taskResult.cached).toBe(false);
    expect(taskResult.output).toMatchObject({
      model: "jev-test",
      answers: { route: { choice: "act" } },
    });
    expect(taskResult.metadata).toMatchObject({
      taskKind: "jev",
      adapter: "jev",
      api: "systemone",
      jevContractVersion: JEV_RESULT_CONTRACT_VERSION,
      usage: { input_tokens: 3, output_tokens: 2 },
    });

    const snapshots = store.listRunTaskSnapshots(result.runId!);
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.kind).toBe("jev");
    if (snapshot.kind === "jev") {
      expect(snapshot.request.model).toBe("jev-test");
      expect(snapshot.request.baseURL).toBe("https://jev.test");
      expect(Object.keys(snapshot.request.questions)).toEqual(["route", "destructive"]);
    }
    const attempts = store.listRunTaskAttempts(result.runId!);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, status: "completed" });
    store.close();
  });

  test("static pipelines sequence worker and jev tasks, each on its own executor half", async () => {
    const build = defineTask({
      id: "build",
      prompt: "Build.",
      output: Schema.Struct({ summary: Schema.String }),
    });
    const workflow = defineWorkflow({
      name: "jev-static-mixed",
      tasks: [build, routeTask()] as const,
    });
    const order: string[] = [];
    const executor = createWorkflowTaskExecutor({
      executeWorkflowTask: (task) => {
        order.push(`worker:${task.id}`);
        return Promise.resolve({ summary: "built" });
      },
      jev: JevClientTest(questions, answers),
    });

    // Interleave a marker by wrapping: the dispatch executor resolves jev second.
    const seen: string[] = [];
    const wrapping = async (task: AnyWorkflowTask): Promise<unknown> => {
      seen.push(isJevTask(task) ? `jev:${task.id}` : `wf:${task.id}`);
      return await executor(task);
    };
    const result = await runWorkflow(workflow, { executeTask: wrapping, jev: jevConfig });
    expect(seen).toEqual(["wf:build", "jev:route"]);
    expect(order).toEqual(["worker:build"]);
    expect(result.tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
  });

  test("a second run reuses the jev cache and never re-invokes the service", async () => {
    await cleanupStores();
    const store = await openStore();
    const workflow = defineWorkflow({
      name: "jev-cache",
      tasks: [routeTask()] as const,
    });
    let jevCalls = 0;
    const counting = Layer.sync(JevClient, () => ({
      config: jevConfig,
      systemOne: () => {
        jevCalls += 1;
        return Effect.succeed(cannedResult) as unknown as Effect.Effect<never, JevError>;
      },
    }));
    const executor = createWorkflowTaskExecutor({
      executeWorkflowTask: () => Promise.resolve({}),
      jev: counting,
    });

    const first = await runWorkflow(workflow, { store, executeTask: executor, jev: jevConfig });
    expect(jevCalls).toBe(1);
    expect(first.tasks[0]?.cached).toBe(false);

    const second = await runWorkflow(workflow, { store, executeTask: executor, jev: jevConfig });
    expect(jevCalls).toBe(1);
    expect(second.tasks[0]?.cached).toBe(true);
    expect(second.tasks[0]?.output).toEqual(first.tasks[0]?.output);
    store.close();
  });

  test("a __proto__ question id and choice label survive run, cache write, and cache replay", async () => {
    await cleanupStores();
    const store = await openStore();
    // JSON.parse: "__proto__" lands as an own data property (an object
    // literal would silently set the prototype instead).
    const protoQuestions = JSON.parse(
      '{"__proto__":{"type":"noul","instructions":"Is proto mentioned?"},' +
        '"pick":{"type":"choice","instructions":"Pick one.",' +
        '"criteria":{"__proto__":"the proto label","other":"the other label"}}}',
    );
    const protoAnswers = JSON.parse(
      '{"__proto__":{"type":"noul","noul":0.87},' +
        '"pick":{"type":"choice","choice":"__proto__","confidence":0.8,' +
        '"probabilities":{"__proto__":0.8,"other":0.2}}}',
    );
    const task = jev({ id: "proto", state: { ticket: "odd key" }, questions: protoQuestions });
    const workflow = defineWorkflow({ name: "jev-proto-cache", tasks: [task] as const });
    let jevCalls = 0;
    const counting = Layer.sync(JevClient, () => ({
      config: jevConfig,
      systemOne: () => {
        jevCalls += 1;
        return Effect.succeed({
          model: "jev-test",
          answers: protoAnswers,
          usage: { input_tokens: 1, output_tokens: 1 },
        }) as unknown as Effect.Effect<never, JevError>;
      },
    }));
    const executor = createWorkflowTaskExecutor({
      executeWorkflowTask: () => Promise.resolve({}),
      jev: counting,
    });

    const first = await runWorkflow(workflow, { store, executeTask: executor, jev: jevConfig });
    expect(jevCalls).toBe(1);
    expect(first.tasks[0]?.status).toBe("completed");

    // Second run replays the persisted payload through the strict result
    // codec: if persistence dropped the own "__proto__" answer, this decode
    // would fail instead of serving the cache hit.
    const second = await runWorkflow(workflow, { store, executeTask: executor, jev: jevConfig });
    expect(jevCalls).toBe(1);
    expect(second.tasks[0]?.cached).toBe(true);
    const replayed = second.tasks[0]?.output as {
      answers: Record<string, unknown> & { pick: { choice: string } };
    };
    expect(Object.prototype.hasOwnProperty.call(replayed.answers, "__proto__")).toBe(true);
    expect(replayed.answers.pick.choice).toBe("__proto__");
    expect(JSON.parse(JSON.stringify(replayed.answers))).toEqual(protoAnswers);
    store.close();
  });

  test("a JevClient failure becomes an isolated task failure with a single executor attempt", async () => {
    await cleanupStores();
    const store = await openStore();
    const failing = Layer.sync(JevClient, () => ({
      config: jevConfig,
      systemOne: () => Effect.fail(new JevError({ kind: "timeout", message: "deadline exceeded" })),
    }));
    const executor = createWorkflowTaskExecutor({
      executeWorkflowTask: () => Promise.resolve({}),
      jev: failing,
    });

    const exit = await runWorkflow(defineWorkflow({
      name: "jev-fail",
      run: (wf) => Effect.gen(function* () {
        const outcome = yield* Effect.exit(wf.runTask(routeTask()));
        return Exit.isFailure(outcome) ? "recovered" : "unexpected";
      }),
    }), { store, executeTask: executor, jev: jevConfig })
      .then(() => ({ ok: true as const }))
      .catch(() => ({ ok: false as const }));
    expect(exit.ok).toBe(true);

    const history = await runWorkflow(defineWorkflow({
      name: "jev-fail-hard",
      run: (wf) => Effect.gen(function* () {
        yield* wf.runTask(routeTask());
      }),
    }), { store, executeTask: executor, jev: jevConfig })
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    expect(history.ok).toBe(false);
    if (!history.ok) {
      const error = history.error as WorkflowJevExecutionError;
      expect(error).toBeInstanceOf(WorkflowJevExecutionError);
      expect(error.jevError.kind).toBe("timeout");
      expect(error.message).toContain("deadline exceeded");
    }
    store.close();
  });

  test("a malformed jev result fails decode terminally with exactly one attempt (no re-prompt)", async () => {
    await cleanupStores();
    const store = await openStore();
    let calls = 0;
    const workflow = defineWorkflow({ name: "jev-decode-terminal", tasks: [routeTask()] as const });

    await expect(runWorkflow(workflow, {
      store,
      jev: jevConfig,
      executeTask: () => {
        calls += 1;
        return Promise.resolve({ model: "jev-test", answers: { route: { type: "choice", choice: "not-a-criterion" } } });
      },
    })).rejects.toThrow(WorkflowTaskDecodeError);
    expect(calls).toBe(1);

    const runs = store.listRuns();
    const run = runs.find((entry) => entry.workflow === "jev-decode-terminal");
    expect(run?.status).toBe("failed");
    const attempts = store.listRunTaskAttempts(run!.runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, status: "failed" });
    store.close();
  });

  test("mock-output executors reach the same decode path as live jev calls", async () => {
    const workflow = defineWorkflow({ name: "jev-mock", tasks: [routeTask()] as const });
    const outputs: Record<string, unknown> = { route: cannedResult };
    const result = await runWorkflow(workflow, {
      mockOutput: true,
      jev: jevConfig,
      executeTask: (task) => {
        if (!Object.prototype.hasOwnProperty.call(outputs, task.id)) {
          throw new Error(`missing mock output for workflow task ${task.id}`);
        }
        return Promise.resolve(outputs[task.id]);
      },
    });
    expect(result.tasks[0]?.status).toBe("completed");
    expect(result.tasks[0]?.output).toEqual(cannedResult);
  });
});

describe("phase ctx.jev", () => {
  const RouteInput = Schema.Struct({ ticket: Schema.String });

  const routeContract = {
    name: "route",
    sop: "triage",
    plugin: "core",
    input: RouteInput,
  } as const satisfies PhaseContract<"route", typeof RouteInput, undefined>;

  const mockRuntime = (
    runTask: WorkflowRuntime["runTask"],
  ): WorkflowRuntime => ({
    runTask,
    phase: (contract, fn) => phase({ runTask }, contract, fn),
  });

  test("ctx.jev decodes the state against the phase input and stamps the phase name", async () => {
    const captured: AnyWorkflowTask[] = [];
    const workflow = defineWorkflow({
      name: "phase-jev",
      run: (wf) => phase(wf, routeContract, (ctx) => Effect.gen(function* () {
        return yield* ctx.jev({
          id: "triage",
          state: { ticket: "Rename the CLI flag" },
          questions,
        });
      })),
    });

    const result = await Effect.runPromise(workflow.run!(mockRuntime(
      (task) => Effect.sync(() => {
        captured.push(task);
        return cannedResult;
      }) as never,
    )));
    expect(result).toEqual(cannedResult);
    expect(captured).toHaveLength(1);
    const task = captured[0]!;
    expect(isJevTask(task)).toBe(true);
    if (isJevTask(task)) {
      expect(task.state).toEqual({ ticket: "Rename the CLI flag" });
      expect(task.phase).toBe("triage:route");
    }
  });

  test("ctx.jev fails when the state does not satisfy the phase input contract", async () => {
    const workflow = defineWorkflow({
      name: "phase-jev-bad-state",
      run: (wf) => phase(wf, routeContract, (ctx) => Effect.gen(function* () {
        return yield* ctx.jev({
          id: "triage",
          state: { wrong: 1 } as never,
          questions,
        });
      })),
    });
    const exit = await Effect.runPromiseExit(workflow.run!(mockRuntime(
      () => Effect.die("must not execute") as never,
    )));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(Cause.squash(exit.cause))).toMatch(/task input failed schema decode/);
    }
  });
});

const InspectReport = Schema.Struct({
  ticket: Schema.String,
  risk: Schema.String,
  files: Schema.Array(Schema.String),
});
const ActReport = Schema.Struct({
  action: Schema.Literals(["renamed"]),
  ticket: Schema.String,
});
const ClarifyReport = Schema.Struct({
  action: Schema.Literals(["asked"]),
  missing: Schema.String,
});

const workerTask = (task: AnyWorkflowTask): AnyWorkflowWorkerTask => {
  if (!isWorkflowWorkerTask(task)) {
    throw new Error(`test executor received unexpected task kind '${task.kind}' for task '${task.id}'`);
  }
  return task;
};

type MixedCall =
  | { readonly kind: "worker"; readonly id: string; readonly prompt: string }
  | { readonly kind: "jev"; readonly id: string; readonly state: unknown; readonly questions: unknown };

/**
 * Instrument a mixed executor so worker prompts and Jev `systemOne` requests
 * can be asserted independently. Asymmetric synthetic values (west/east,
 * alpha/omega, inspect vs act vs clarify) make any cross-arm contamination
 * fail the test instead of cancelling out.
 */
const instrumentMixedPipeline = (input: {
  readonly inspect: { readonly ticket: string; readonly risk: string; readonly files: ReadonlyArray<string> };
  readonly route?: JevAnswers<typeof questions>;
  readonly act?: { readonly action: "renamed"; readonly ticket: string };
  readonly clarify?: { readonly action: "asked"; readonly missing: string };
  readonly failInspect?: boolean;
  readonly failJev?: JevError;
}) => {
  const calls: MixedCall[] = [];
  const chosenAnswers = input.route ?? answers;
  const jevLayer = Layer.effect(
    JevClient,
    Effect.gen(function* () {
      const inner = yield* JevClient;
      return {
        config: inner.config,
        systemOne: (request, options) => {
          calls.push({
            kind: "jev",
            id: "route",
            state: request.state,
            questions: request.questions,
          });
          if (input.failJev !== undefined) return Effect.fail(input.failJev);
          return inner.systemOne(request, options);
        },
      };
    }),
  ).pipe(Layer.provide(JevClientTest(questions, chosenAnswers, { config: jevConfig })));
  const executor = createWorkflowTaskExecutor({
    executeWorkflowTask: (task) => {
      const worker = workerTask(task);
      calls.push({ kind: "worker", id: worker.id, prompt: worker.prompt });
      if (input.failInspect === true && worker.id === "inspect") {
        return Promise.reject(new Error("inspect worker unavailable"));
      }
      if (worker.id === "inspect") return Promise.resolve(input.inspect);
      if (worker.id === "act") {
        return Promise.resolve(input.act ?? { action: "renamed" as const, ticket: "unused-act" });
      }
      if (worker.id === "clarify") {
        return Promise.resolve(input.clarify ?? { action: "asked" as const, missing: "unused-clarify" });
      }
      throw new Error(`unexpected worker task '${worker.id}'`);
    },
    jev: jevLayer,
  });
  return { calls, executor };
};

const mixedPipelineWorkflow = (inspectPrompt: string, inspectCacheKey?: string) =>
  defineWorkflow({
    name: "mixed-agent-jev-pipeline",
    run: (wf) => Effect.gen(function* () {
      const inspect = yield* wf.runTask(defineTask({
        id: "inspect",
        prompt: inspectPrompt,
        output: InspectReport,
        worker: { worker: "amp-code", model: "medium" },
        ...(inspectCacheKey !== undefined ? { cacheKey: inspectCacheKey } : {}),
      }));
      const decision = yield* wf.runTask(jev({
        id: "route",
        state: {
          ticket: inspect.ticket,
          risk: inspect.risk,
          files: inspect.files,
        },
        questions,
      }));
      if (decision.answers.route.choice === "act") {
        const acted = yield* wf.runTask(defineTask({
          id: "act",
          prompt: `Rename flag for ${inspect.ticket} on ${inspect.files.join(",")}`,
          output: ActReport,
          worker: { worker: "amp-code", model: "low" },
        }));
        return { branch: "act" as const, ticket: acted.ticket, action: acted.action };
      }
      const clarified = yield* wf.runTask(defineTask({
        id: "clarify",
        prompt: `Ask for missing context on ${inspect.ticket} at risk ${inspect.risk}`,
        output: ClarifyReport,
        worker: { worker: "amp-code", model: "high" },
      }));
      return { branch: "clarify" as const, missing: clarified.missing, action: clarified.action };
    }),
  });

describe("dynamic agent -> jev -> conditional agent pipeline", () => {
  afterAll(cleanupStores);

  test("upstream inspect output is the Jev state, and only the selected act branch runs", async () => {
    await cleanupStores();
    const store = await openStore();
    const inspect = {
      ticket: "west-ticket-α",
      risk: "asymmetric-low",
      files: ["src/west.ts", "docs/omega.md"],
    };
    const { calls, executor } = instrumentMixedPipeline({
      inspect,
      route: answers,
      act: { action: "renamed", ticket: "west-ticket-α" },
      clarify: { action: "asked", missing: "must-not-run" },
    });

    const result = await runWorkflow(
      mixedPipelineWorkflow("Inspect west-ticket-α at asymmetric-low."),
      { store, executeTask: executor, jev: jevConfig },
    );

    expect(result.output).toEqual({
      branch: "act",
      ticket: "west-ticket-α",
      action: "renamed",
    });
    expect(calls.map((call) => `${call.kind}:${call.id}`)).toEqual([
      "worker:inspect",
      "jev:route",
      "worker:act",
    ]);
    const jevCall = calls.find((call) => call.kind === "jev");
    expect(jevCall).toEqual({
      kind: "jev",
      id: "route",
      state: inspect,
      questions,
    });
    expect(result.tasks.map((task) => task.id)).toEqual(["inspect", "route", "act"]);
    expect(result.tasks.every((task) => task.status === "completed" && task.cached === false)).toBe(true);
    store.close();
  });

  test("the clarify branch runs when Jev selects it, and act never executes", async () => {
    await cleanupStores();
    const store = await openStore();
    const inspect = {
      ticket: "east-ticket-ω",
      risk: "asymmetric-high",
      files: ["src/east.ts"],
    };
    const clarifyAnswers: JevAnswers<typeof questions> = {
      route: {
        type: "choice",
        choice: "clarify",
        confidence: 0.81,
        probabilities: { act: 0.19, clarify: 0.81 },
      },
      destructive: { type: "noul", noul: 0.44 },
    };
    const { calls, executor } = instrumentMixedPipeline({
      inspect,
      route: clarifyAnswers,
      act: { action: "renamed", ticket: "must-not-run" },
      clarify: { action: "asked", missing: "owner-signoff-east" },
    });

    const result = await runWorkflow(
      mixedPipelineWorkflow("Inspect east-ticket-ω at asymmetric-high."),
      { store, executeTask: executor, jev: jevConfig },
    );

    expect(result.output).toEqual({
      branch: "clarify",
      missing: "owner-signoff-east",
      action: "asked",
    });
    expect(calls.map((call) => `${call.kind}:${call.id}`)).toEqual([
      "worker:inspect",
      "jev:route",
      "worker:clarify",
    ]);
    const jevCall = calls.find((call) => call.kind === "jev");
    expect(jevCall).toMatchObject({ kind: "jev", state: inspect });
    expect(result.tasks.map((task) => task.id)).toEqual(["inspect", "route", "clarify"]);
    store.close();
  });

  test("an inspect failure never calls Jev or a downstream agent", async () => {
    await cleanupStores();
    const store = await openStore();
    const { calls, executor } = instrumentMixedPipeline({
      inspect: { ticket: "dead", risk: "x", files: ["nope.ts"] },
      failInspect: true,
    });

    await expect(runWorkflow(
      mixedPipelineWorkflow("Inspect a ticket that the worker cannot see."),
      { store, executeTask: executor, jev: jevConfig },
    )).rejects.toThrow(/inspect worker unavailable/);

    expect(calls).toEqual([{
      kind: "worker",
      id: "inspect",
      prompt: "Inspect a ticket that the worker cannot see.",
    }]);
    store.close();
  });

  test("a Jev failure never calls the selected downstream agent", async () => {
    await cleanupStores();
    const store = await openStore();
    const inspect = {
      ticket: "north-ticket",
      risk: "blocked",
      files: ["src/north.ts"],
    };
    const { calls, executor } = instrumentMixedPipeline({
      inspect,
      failJev: new JevError({ kind: "timeout", message: "systemone deadline" }),
    });

    const error = await runWorkflow(
      mixedPipelineWorkflow("Inspect north-ticket."),
      { store, executeTask: executor, jev: jevConfig },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkflowJevExecutionError);
    expect((error as WorkflowJevExecutionError).jevError.kind).toBe("timeout");
    expect(calls.map((call) => `${call.kind}:${call.id}`)).toEqual([
      "worker:inspect",
      "jev:route",
    ]);
    store.close();
  });

  test("exact cached replay of the mixed pipeline makes zero worker and zero Jev calls", async () => {
    await cleanupStores();
    const store = await openStore();
    const inspect = {
      ticket: "west-ticket-α",
      risk: "asymmetric-low",
      files: ["src/west.ts", "docs/omega.md"],
    };
    const { calls, executor } = instrumentMixedPipeline({
      inspect,
      route: answers,
      act: { action: "renamed", ticket: "west-ticket-α" },
    });
    const workflow = mixedPipelineWorkflow("Inspect west-ticket-α at asymmetric-low.");

    const first = await runWorkflow(workflow, { store, executeTask: executor, jev: jevConfig });
    expect(calls.map((call) => `${call.kind}:${call.id}`)).toEqual([
      "worker:inspect",
      "jev:route",
      "worker:act",
    ]);
    expect(first.tasks.every((task) => task.cached === false)).toBe(true);

    calls.length = 0;
    const second = await runWorkflow(workflow, { store, executeTask: executor, jev: jevConfig });
    expect(calls).toEqual([]);
    expect(second.tasks.map((task) => ({ id: task.id, cached: task.cached }))).toEqual([
      { id: "inspect", cached: true },
      { id: "route", cached: true },
      { id: "act", cached: true },
    ]);
    expect(second.output).toEqual(first.output);
    store.close();
  });

  test("changed upstream inspect output invalidates Jev and the selected downstream cache only", async () => {
    await cleanupStores();
    const store = await openStore();
    // Two inspect prompts share one author cacheKey so the inspect *slot* can
    // miss independently of Jev/act. After the first run, a second inspect
    // prompt under the same cacheKey writes a new inspect payload; Jev state
    // and the act prompt (which embeds `files`) must miss, while a later
    // replay of the original prompt still hits the original inspect/Jev/act
    // identities — proving the mutated run did not clobber them.
    const firstInspect = {
      ticket: "west-ticket-α",
      risk: "asymmetric-low",
      files: ["src/west.ts"],
    };
    const mutatedInspect = {
      ticket: "west-ticket-α",
      risk: "asymmetric-low",
      files: ["src/west.ts", "src/mutated-omega.ts"],
    };
    let inspectOutput = firstInspect;
    const { calls, executor } = instrumentMixedPipeline({
      get inspect() {
        return inspectOutput;
      },
      route: answers,
      act: { action: "renamed", ticket: "west-ticket-α" },
    });
    const original = mixedPipelineWorkflow(
      "Inspect west-ticket-α at asymmetric-low.",
      "inspect-west-v1",
    );

    const first = await runWorkflow(original, { store, executeTask: executor, jev: jevConfig });
    expect(first.tasks.map((task) => task.id)).toEqual(["inspect", "route", "act"]);
    expect(first.tasks.every((task) => task.cached === false)).toBe(true);

    calls.length = 0;
    inspectOutput = mutatedInspect;
    const mutated = mixedPipelineWorkflow(
      "Inspect west-ticket-α including mutated-omega.",
      "inspect-west-v1",
    );
    const second = await runWorkflow(mutated, { store, executeTask: executor, jev: jevConfig });

    expect(calls.map((call) => `${call.kind}:${call.id}`)).toEqual([
      "worker:inspect",
      "jev:route",
      "worker:act",
    ]);
    const jevCall = calls.find((call) => call.kind === "jev");
    expect(jevCall).toMatchObject({ kind: "jev", state: mutatedInspect });
    expect(second.tasks.map((task) => ({ id: task.id, cached: task.cached }))).toEqual([
      { id: "inspect", cached: false },
      { id: "route", cached: false },
      { id: "act", cached: false },
    ]);

    calls.length = 0;
    const replayOriginal = await runWorkflow(original, { store, executeTask: executor, jev: jevConfig });
    expect(calls).toEqual([]);
    expect(replayOriginal.tasks.map((task) => ({ id: task.id, cached: task.cached }))).toEqual([
      { id: "inspect", cached: true },
      { id: "route", cached: true },
      { id: "act", cached: true },
    ]);
    expect(replayOriginal.output).toEqual(first.output);
    store.close();
  });
});
