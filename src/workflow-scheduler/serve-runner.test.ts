import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { WorkflowStore } from "../workflow-store.js";
import { runSchedulerServe } from "./serve.js";
import { ScheduledRunHostLive, SchedulerStoreServiceLive } from "./services.js";
import { SchedulerStore } from "./store.js";

const tempRoots: string[] = [];
const previousPrismHome = process.env.PRISM_HOME;

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-scheduler-serve-runner-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  if (previousPrismHome === undefined) delete process.env.PRISM_HOME;
  else process.env.PRISM_HOME = previousPrismHome;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const NOW = Date.parse("2026-09-16T12:10:00.000Z");
const DECLARATION = `{ cron: "*/10 * * * *", timezone: "UTC", overlap: "skip", missedRuns: "skip" }`;

const jevRouteMock = {
  model: "jev-mock",
  answers: {
    next: {
      type: "choice",
      choice: "act",
      confidence: 0.9,
      probabilities: { act: 0.9, wait: 0.1 },
    },
  },
  usage: { input_tokens: 1, output_tokens: 1 },
};

const writeWorkflow = async (root: string, name: string, source: string): Promise<string> => {
  const path = join(root, `${name}.workflow.ts`);
  await writeFile(path, source);
  return path;
};

const installDue = (
  store: SchedulerStore,
  input: {
    readonly name: string;
    readonly workflowFile: string;
    readonly cwd: string;
    readonly storePath: string;
    readonly mockOutput: string;
  },
) =>
  store.upsertSchedule({
    name: input.name,
    workflowFile: input.workflowFile,
    cwd: input.cwd,
    storePath: input.storePath,
    cron: "*/10 * * * *",
    timezone: "UTC",
    overlap: "skip",
    missedRuns: "skip",
    options: { mockOutput: input.mockOutput },
    nextDueAt: "2026-09-16T12:10:00.000Z",
  }).schedule;

const serveOnce = (store: SchedulerStore) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        return yield* runSchedulerServe({
          instanceId: "instance-1",
          version: "0.7.0",
          instanceMode: "manual",
          once: true,
        });
      }),
    ).pipe(
      Effect.provide(SchedulerStoreServiceLive(store)),
      Effect.provide(ScheduledRunHostLive),
      Effect.provide(TestClock.layer()),
    ),
  );

describe("scheduler --once awaits a real runner for jev and mixed workflows", () => {
  test("pure jev --once records the child's completed ledger, not merely a launch", async () => {
    const root = await createTempRoot();
    process.env.PRISM_HOME = join(root, "home");
    const workflowFile = await writeWorkflow(
      root,
      "pure-jev",
      `
import { defineWorkflow, jev, choice } from "prism";

export default defineWorkflow({
  name: "pure-jev",
  schedule: ${DECLARATION},
  tasks: [
    jev({
      id: "route",
      state: { ticket: "Rename the CLI flag" },
      questions: {
        next: choice({ criteria: { act: "act on it now", wait: "leave it parked" } }),
      },
    }),
  ],
});
`,
    );
    const mockOutput = join(root, "mocks.json");
    await writeFile(mockOutput, `${JSON.stringify({ route: jevRouteMock })}\n`);
    const storePath = join(root, "workflows.sqlite");
    const scheduler = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    try {
      const schedule = installDue(scheduler, {
        name: "pure-jev",
        workflowFile,
        cwd: root,
        storePath,
        mockOutput,
      });
      const report = await serveOnce(scheduler);
      expect(report.launched).toBe(1);
      expect(report.failed).toBe(0);
      expect(report.skippedOverlap).toBe(0);

      const execution = scheduler.listExecutions(schedule.scheduleId, 10)[0];
      expect(execution?.status).toBe("completed");
      expect(execution?.observedExitCode).toBe(0);
      expect(scheduler.occupyingExecution(schedule.scheduleId)).toBeNull();
      expect(scheduler.getSchedule(schedule.scheduleId)?.nextDueAt).toBe("2026-09-16T12:20:00.000Z");

      const workflowStore = await WorkflowStore.open(storePath);
      try {
        const runId = execution?.runId;
        expect(runId).toBeTruthy();
        const run = workflowStore.getRun(runId!);
        expect(run?.status).toBe("completed");
        expect(run?.workflow).toBe("pure-jev");
        const tasks = workflowStore.listRunTasks(runId!);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
          taskId: "route",
          status: "completed",
          cached: false,
        });
        expect(tasks[0]?.output).toEqual(jevRouteMock);
      } finally {
        workflowStore.close();
      }
    } finally {
      scheduler.close();
    }
  }, 30_000);

  test("mixed agent/jev --once awaits both tasks and treats a failing run as a real failure", async () => {
    const root = await createTempRoot();
    process.env.PRISM_HOME = join(root, "home");
    const workflowFile = await writeWorkflow(
      root,
      "mixed",
      `
import { Schema } from "effect";
import { defineTask, defineWorkflow, jev, choice } from "prism";

export default defineWorkflow({
  name: "mixed-router",
  schedule: ${DECLARATION},
  tasks: [
    defineTask({
      id: "draft",
      prompt: "Draft the change.",
      output: Schema.Struct({ summary: Schema.String }),
    }),
    jev({
      id: "route",
      state: { ticket: "Rename the CLI flag" },
      questions: {
        next: choice({ criteria: { act: "act on it now", wait: "leave it parked" } }),
      },
    }),
  ],
});
`,
    );
    const mockOutput = join(root, "mocks.json");
    // Missing the jev task on purpose: --once must wait for the child to fail,
    // then record that failure on the execution rather than reporting a launch.
    await writeFile(mockOutput, `${JSON.stringify({ draft: { summary: "drafted" } })}\n`);
    const storePath = join(root, "workflows.sqlite");
    const scheduler = await SchedulerStore.open(join(root, "scheduler.sqlite"));
    try {
      const schedule = installDue(scheduler, {
        name: "mixed-router",
        workflowFile,
        cwd: root,
        storePath,
        mockOutput,
      });
      const report = await serveOnce(scheduler);
      expect(report.launched).toBe(1);
      expect(report.failed).toBe(1);

      const execution = scheduler.listExecutions(schedule.scheduleId, 10)[0];
      expect(execution?.status).toBe("failed");
      expect(execution?.observedExitCode).not.toBe(0);
      expect(scheduler.occupyingExecution(schedule.scheduleId)).toBeNull();

      const workflowStore = await WorkflowStore.open(storePath);
      try {
        const run = workflowStore.getRun(execution!.runId!);
        expect(run?.status).toBe("failed");
        const tasks = workflowStore.listRunTasks(execution!.runId!);
        expect(tasks.some((task) => task.taskId === "draft" && task.status === "completed")).toBe(true);
        expect(tasks.some((task) => task.taskId === "route" && task.status === "failed")).toBe(true);
      } finally {
        workflowStore.close();
      }
    } finally {
      scheduler.close();
    }
  }, 30_000);
});
