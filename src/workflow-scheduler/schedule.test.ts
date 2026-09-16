import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import {
  isWorkflowDefinition,
  isWorkflowSchedule,
  parseWorkflowSchedule,
  defineTask,
  defineWorkflow,
} from "../workflows.js";
import { WorkflowScheduleError } from "./errors.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-schedule-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const Output = Schema.Struct({ summary: Schema.String });

const task = defineTask({ id: "build", prompt: "Build it.", output: Output });

const declaration = {
  cron: "*/10 * * * *",
  timezone: "America/Sao_Paulo",
  overlap: "skip",
  missedRuns: "skip",
} as const;

const rejection = (value: unknown): WorkflowScheduleError => {
  try {
    parseWorkflowSchedule(value);
  } catch (error) {
    if (error instanceof WorkflowScheduleError) return error;
    throw error;
  }
  throw new Error("expected the schedule to be rejected");
};

describe("workflow schedule declaration", () => {
  test("a static workflow carries the declaration verbatim and stays plain data", () => {
    const workflow = defineWorkflow({ name: "inbox-router", tasks: [task], schedule: declaration });
    expect(workflow.schedule).toEqual(declaration);
    expect(workflow.kind).toBe("workflow");
    expect(workflow.name).toBe("inbox-router");
    // Inert means: no handle, no timer, no store — only the authored fields.
    expect(Object.keys(workflow).sort()).toEqual(["kind", "name", "schedule", "tasks"]);
  });

  test("a dynamic workflow preserves the declaration", () => {
    // The dynamic branch builds its return value explicitly rather than
    // spreading the definition, so this is the one place a new field can be
    // silently dropped.
    const workflow = defineWorkflow({
      name: "inbox-router",
      schedule: declaration,
      run: () => Effect.succeed("done"),
    });
    expect(workflow.schedule).toEqual(declaration);
    expect(Object.keys(workflow).sort()).toEqual(["kind", "name", "run", "schedule", "tasks"]);
  });

  test("a workflow without a schedule has no schedule key at all", () => {
    expect("schedule" in defineWorkflow({ name: "plain", tasks: [task] })).toBe(false);
    expect("schedule" in defineWorkflow({ name: "plain", run: () => Effect.succeed("x") })).toBe(false);
  });

  test("declaring a schedule writes nothing anywhere", async () => {
    // The activation gate is `prism workflow schedule install`; declaration is
    // inert. A definition that touched disk here would break that contract.
    const root = await createTempRoot();
    const previous = process.env.PRISM_HOME;
    process.env.PRISM_HOME = root;
    try {
      defineWorkflow({ name: "inbox-router", tasks: [task], schedule: declaration });
      defineWorkflow({ name: "inbox-router", schedule: declaration, run: () => Effect.succeed("x") });
      expect(await readdir(root)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PRISM_HOME;
      else process.env.PRISM_HOME = previous;
    }
  });

  test("rejects an unimplemented overlap or missedRuns policy as a hard error", () => {
    for (const [key, value] of [["overlap", "queue"], ["overlap", "parallel"], ["missedRuns", "run"], ["missedRuns", "catchup"]] as const) {
      const error = rejection({ ...declaration, [key]: value });
      expect(error.field).toBe(key);
      expect(error.message).toContain("not implemented");
      expect(error.hint).toContain("skip");
    }
  });

  test("rejects unknown keys instead of ignoring them", () => {
    const error = rejection({ ...declaration, retries: 2 });
    expect(error.field).toBe("retries");
    expect(error.message).toContain("unknown key");
  });

  test("rejects a non-object, a missing field, and a blank string", () => {
    expect(rejection(undefined).field).toBe("schedule");
    expect(rejection("*/10 * * * *").field).toBe("schedule");
    expect(rejection([]).field).toBe("schedule");
    const { timezone: _timezone, ...withoutTimezone } = declaration;
    expect(rejection(withoutTimezone).field).toBe("timezone");
    expect(rejection({ ...declaration, cron: "  " }).field).toBe("cron");
  });

  test("surfaces a dialect error from the cron adapter unchanged", () => {
    expect(rejection({ ...declaration, cron: "0 */10 * * * *" }).field).toBe("cron");
    expect(rejection({ ...declaration, timezone: "+03:00" }).field).toBe("timezone");
  });

  test("isWorkflowSchedule and isWorkflowDefinition agree with the parser", () => {
    expect(isWorkflowSchedule(declaration)).toBe(true);
    expect(isWorkflowSchedule({ ...declaration, overlap: "queue" })).toBe(false);
    expect(isWorkflowDefinition({ kind: "workflow", name: "n", tasks: [], schedule: declaration })).toBe(true);
    expect(isWorkflowDefinition({ kind: "workflow", name: "n", tasks: [], schedule: { cron: "x" } })).toBe(false);
    expect(isWorkflowDefinition({ kind: "workflow", name: "n", tasks: [] })).toBe(true);
  });
});
