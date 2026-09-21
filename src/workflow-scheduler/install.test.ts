import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowScheduleInstallError } from "./errors.js";
import { installWorkflowSchedule } from "./install.js";
import { SchedulerStore, schedulerStorePath } from "./store.js";

const tempRoots: string[] = [];
const previousPrismHome = process.env.PRISM_HOME;

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-scheduler-install-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  if (previousPrismHome === undefined) delete process.env.PRISM_HOME;
  else process.env.PRISM_HOME = previousPrismHome;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DECLARATION = `{ cron: "*/10 * * * *", timezone: "UTC", overlap: "skip", missedRuns: "skip" }`;
const NOW = Date.parse("2026-09-16T12:09:59.000Z");

const writeWorkflow = async (root: string, name: string, source: string): Promise<string> => {
  const path = join(root, `${name}.workflow.ts`);
  await writeFile(path, source);
  return path;
};

const mixedSource = (name: string): string => `
import { Schema } from "effect";
import { defineTask, defineWorkflow, jev, choice } from "prism";

export default defineWorkflow({
  name: ${JSON.stringify(name)},
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
`;

describe("schedule install is the activation gate for jev and mixed workflows", () => {
  test("declaring a jev schedule writes nothing; installing registers it without running the workflow", async () => {
    const root = await createTempRoot();
    const prismHome = join(root, "home");
    process.env.PRISM_HOME = prismHome;
    const sentinel = join(root, "module-evaluated");
    const runSentinel = join(root, "run-executed");
    const workflowFile = await writeWorkflow(
      root,
      "pure-jev",
      `
import { writeFileSync } from "node:fs";
import { defineWorkflow, jev, choice } from "prism";

writeFileSync(${JSON.stringify(sentinel)}, "imported");

export default defineWorkflow({
  name: "pure-jev",
  schedule: ${DECLARATION},
  run: (wf) => {
    writeFileSync(${JSON.stringify(runSentinel)}, "executed");
    return wf.runTask(jev({
      id: "route",
      state: { ticket: "Rename the CLI flag" },
      questions: {
        next: choice({ criteria: { act: "act on it now", wait: "leave it parked" } }),
      },
    }));
  },
});
`,
    );

    expect(await readdir(root)).toEqual(expect.arrayContaining(["pure-jev.workflow.ts"]));
    expect(await readdir(prismHome).catch(() => [])).toEqual([]);

    const mockOutput = join(root, "mocks.json");
    await writeFile(mockOutput, "{}\n");
    const result = await installWorkflowSchedule({
      prismHome,
      workflowFile,
      cwd: root,
      storePath: join(root, "workflows.sqlite"),
      mockOutput,
      now: NOW,
    });

    expect(result.kind).toBe("installed");
    expect(result.schedule.name).toBe("pure-jev");
    expect(result.schedule.workflowFile).toBe(workflowFile);
    expect(result.schedule.nextDueAt).toBe("2026-09-16T12:10:00.000Z");
    expect(result.schedule.options).toEqual({ mockOutput });
    // Installing must import the module (the declaration lives there) but must
    // not launch a run: the occupancy slot stays empty.
    expect(await readdir(root)).toContain("module-evaluated");
    expect(await readdir(root)).not.toContain("run-executed");

    const store = await SchedulerStore.open(schedulerStorePath(prismHome));
    try {
      expect(store.listSchedules()).toHaveLength(1);
      expect(store.listSchedules()[0]?.name).toBe("pure-jev");
      expect(store.occupyingExecution(result.schedule.scheduleId)).toBeNull();
      expect(store.listExecutions(result.schedule.scheduleId, 10)).toEqual([]);
    } finally {
      store.close();
    }

    const again = await installWorkflowSchedule({
      prismHome,
      workflowFile,
      cwd: root,
      storePath: join(root, "workflows.sqlite"),
      mockOutput,
      now: NOW,
    });
    expect(again.kind).toBe("unchanged");
    expect(again.schedule.revision).toBe(1);
    expect(again.schedule.nextDueAt).toBe("2026-09-16T12:10:00.000Z");
  });

  test("installing a mixed agent/jev workflow records the same inert schedule as a pure jev one", async () => {
    const root = await createTempRoot();
    const prismHome = join(root, "home");
    process.env.PRISM_HOME = prismHome;
    const workflowFile = await writeWorkflow(root, "mixed", mixedSource("mixed-router"));

    const result = await installWorkflowSchedule({
      prismHome,
      workflowFile,
      cwd: root,
      storePath: join(root, "project.sqlite"),
      now: NOW,
    });

    expect(result.kind).toBe("installed");
    expect(result.schedule.name).toBe("mixed-router");
    expect(result.schedule.cron).toBe("*/10 * * * *");
    expect(result.schedule.overlap).toBe("skip");
    expect(result.schedule.options).toEqual({});
  });

  test("a workflow without a schedule cannot be installed", async () => {
    const root = await createTempRoot();
    const prismHome = join(root, "home");
    process.env.PRISM_HOME = prismHome;
    const workflowFile = await writeWorkflow(
      root,
      "plain-jev",
      `
import { defineWorkflow, jev, choice } from "prism";

export default defineWorkflow({
  name: "plain-jev",
  tasks: [
    jev({
      id: "route",
      state: { ticket: "x" },
      questions: { next: choice({ criteria: { act: "a", wait: "w" } }) },
    }),
  ],
});
`,
    );

    try {
      await installWorkflowSchedule({
        prismHome,
        workflowFile,
        cwd: root,
        storePath: join(root, "workflows.sqlite"),
        now: NOW,
      });
      throw new Error("expected install to refuse a workflow with no schedule");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowScheduleInstallError);
      expect((error as WorkflowScheduleInstallError).message).toContain("declares no schedule");
    }

    const store = await SchedulerStore.open(schedulerStorePath(prismHome));
    try {
      expect(store.listSchedules()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
