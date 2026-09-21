/**
 * Plugin-free CLI smoke for pure Jev and agent -> Jev -> agent workflows.
 * No credentials/calls by default. Live mode spends tokens on synthetic data.
 *
 * bun scripts/acceptance/workflow-orb-smoke.ts
 * bun scripts/acceptance/workflow-orb-smoke.ts --live --worker claude-code
 * bun scripts/acceptance/workflow-orb-smoke.ts --live --worker amp-code
 * bun scripts/acceptance/workflow-orb-smoke.ts --live --worker none
 *
 * Build declarations first: bun scripts/build-dts.ts
 * Keeps harness HOME/auth in place; isolates PRISM_HOME, cwd, and SQLite stores.
 * This checks execution and exact cache replay, not orb pause/resume or cron.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { exists, writeFile } from "../../src/fs.js";
import { WorkflowStore } from "../../src/workflow-store.js";

const repo = resolve(import.meta.dir, "../..");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { live: { type: "boolean", default: false }, worker: { type: "string", default: "none" } },
  strict: true,
  allowPositionals: false,
});
const live = values.live;
const worker = values.worker;
assert(worker === "none" || worker === "amp-code" || worker === "claude-code", "--worker must be none, amp-code, or claude-code");
assert(await exists(join(repo, "dist/dts-tmp/index.d.ts")), "Run bun scripts/build-dts.ts first");

const root = await mkdtemp(join(tmpdir(), "prism-orb-smoke-"));
const env = { ...process.env, PRISM_HOME: join(root, "prism") };
const unavailable = {
  ...env,
  TYPESAFE_API_KEY: "",
  AMP_API_KEY: "",
  CLAUDE_CODE_OAUTH_TOKEN: "",
  ANTHROPIC_API_KEY: "",
  PRISM_WORKFLOW_AMP_BIN: join(root, "no-amp"),
  PRISM_WORKFLOW_CLAUDE_BIN: join(root, "no-claude"),
};

const state = {
  items: [
    { id: "a", text: "The backup failed with an error." },
    { id: "b", text: "The backup completed successfully." },
  ],
};
const questions = {
  a_status: {
    type: "choice",
    instructions: "Classify only item a in state.items.",
    criteria: { failure: "The backup failed.", success: "The backup succeeded." },
  },
  b_status: {
    type: "choice",
    instructions: "Classify only item b in state.items.",
    criteria: { failure: "The backup failed.", success: "The backup succeeded." },
  },
  failures: {
    type: "score",
    instructions: "Count the failed backups in state.items.",
    criteria: ["zero failed backups", "one failed backup", "two failed backups"],
  },
  needs_review: {
    type: "noul",
    instructions: "Does at least one backup in state.items have a failure?",
  },
};
const decision = {
  model: "orb-smoke-mock",
  answers: {
    a_status: { type: "choice", choice: "failure", confidence: 1, probabilities: { failure: 1, success: 0 } },
    b_status: { type: "choice", choice: "success", confidence: 1, probabilities: { failure: 0, success: 1 } },
    failures: { type: "score", score: 1, confidence: 1, legend: { "0": "zero failed backups", "1": "one failed backup", "2": "two failed backups" }, probabilities: { "0": 0, "1": 1, "2": 0 } },
    needs_review: { type: "noul", noul: 1 },
  },
  usage: { input_tokens: 0, output_tokens: 0 },
};

const source = (selectedWorker: "amp-code" | "claude-code" | undefined): string => `
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow, jev } from "prism";

const initial = ${JSON.stringify(state)};
const questions = ${JSON.stringify(questions)} as const;
export default defineWorkflow({
  name: ${JSON.stringify(`orb-smoke-${selectedWorker ?? "jev"}`)},
  run: (wf) => Effect.gen(function* () {
    const state = ${selectedWorker === undefined ? "initial" : `yield* wf.runTask(defineTask({
      id: "extract",
      prompt: "Return this data exactly as structured output. Do not use tools, read files, or modify anything: " + JSON.stringify(initial),
      worker: { worker: ${JSON.stringify(selectedWorker)}, permission: "legacy" },
      output: Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })) }),
      finish: { maxRepairs: 0, maxDecodeRepairs: 0 },
    }))`};
    if (JSON.stringify(state) !== JSON.stringify(initial)) {
      return yield* Effect.fail(new Error("Extraction changed the synthetic input"));
    }
    const decision = yield* wf.runTask(jev({ id: "decide", state, questions, timeoutMs: 15000 }));
    if (decision.answers.a_status.choice !== "failure" || decision.answers.b_status.choice !== "success"
      || decision.answers.failures.score < 0.75 || decision.answers.failures.score > 1.25
      || decision.answers.needs_review.noul < 0.75) {
      return yield* Effect.fail(new Error("Jev did not identify the one failed backup"));
    }
    ${selectedWorker === undefined ? "return decision;" : `
    if (decision.answers.a_status.choice === "failure") {
      const report = yield* wf.runTask(defineTask({
        id: "review-a",
        prompt: "The classifier found backup a failed and b succeeded. Return {failedId: 'a', successfulId: 'b'}. Do not use tools, read files, or modify anything.",
        worker: { worker: ${JSON.stringify(selectedWorker)}, permission: "legacy" },
        output: Schema.Struct({ failedId: Schema.String, successfulId: Schema.String }),
        finish: { maxRepairs: 0, maxDecodeRepairs: 0 },
      }));
      if (report.failedId !== "a" || report.successfulId !== "b") {
        return yield* Effect.fail(new Error("Report reversed the backup identities"));
      }
      return report;
    }
    return yield* Effect.fail(new Error("Unexpected route"));`}
  }),
});
`;

interface CliResult {
  readonly runId: string;
  readonly tasks: readonly { readonly id: string; readonly cached: boolean; readonly status: string; readonly output: unknown }[];
}

const run = async (file: string, storePath: string, replay: boolean): Promise<CliResult> => {
  const child = Bun.spawn([
    process.execPath, join(repo, "src/cli.ts"), "workflow", "run", file, "--store", storePath,
    ...(!live ? ["--mock-output", join(root, "mocks.json")] : []),
  ], { cwd: root, env: replay || !live ? unavailable : env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  assert.equal(exitCode, 0, `workflow run failed: ${stderr}`);
  return JSON.parse(stdout) as CliResult;
};

try {
  await writeFile(join(root, "mocks.json"), JSON.stringify({
    extract: state, decide: decision, "review-a": { failedId: "a", successfulId: "b" },
  }));
  const workers: readonly ("amp-code" | "claude-code" | undefined)[] = live
    ? worker === "none" ? [undefined] : [undefined, worker]
    : [undefined, "amp-code", "claude-code"];
  for (const selectedWorker of workers) {
    const name = selectedWorker ?? "jev";
    const file = join(root, `${name}.workflow.ts`);
    const storePath = join(root, `${name}.sqlite`);
    await writeFile(file, source(selectedWorker));
    const expectedIds = selectedWorker === undefined ? ["decide"] : ["extract", "decide", "review-a"];
    const first = await run(file, storePath, false);
    const replay = await run(file, storePath, true);
    assert.notEqual(first.runId, replay.runId);
    for (const [result, cached] of [[first, false], [replay, true]] as const) {
      assert.deepEqual(result.tasks.map((task) => task.id), expectedIds);
      assert(result.tasks.every((task) => task.status === "completed" && task.cached === cached));
      const store = await WorkflowStore.open(storePath);
      try {
        assert.equal(store.getRun(result.runId)?.status, "completed");
        const tasks = store.listRunTasks(result.runId);
        assert.deepEqual(tasks.map((task) => task.taskId), expectedIds);
        assert(tasks.every((task) => task.cached === cached));
      } finally {
        store.close();
      }
    }
    assert.deepEqual(replay.tasks.map((task) => task.output), first.tasks.map((task) => task.output));
    console.log(`PASS ${name}: ${live ? "live" : "mock"} typed output, routing, ledger, credential-free cache replay`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
