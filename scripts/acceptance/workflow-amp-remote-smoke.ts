/**
 * Opt-in live smoke for the amp-orb and amp-runner workflow workers.
 * Spends tokens on the Amp project you point it at. Skipped entirely unless
 * PRISM_WORKFLOW_AMP_REMOTE_SMOKE=live is set (run-all and bun test stay
 * credential-free by default).
 *
 * PRISM_WORKFLOW_AMP_REMOTE_SMOKE=live \
 * PRISM_WORKFLOW_AMP_REMOTE_PROJECT=owner/disposable-repo \
 * bun scripts/acceptance/workflow-amp-remote-smoke.ts
 *
 * Optional: PRISM_WORKFLOW_AMP_RUNNER_ID=<id> (+ PRISM_AMP_RUNNER_DIR=<abs dir>)
 * enables the runner leg; PRISM_WORKFLOW_AMP_BIN overrides the amp binary.
 *
 * Checks, per the L6 design §8: create + attached stream with a typed JSON
 * output, session_id capture, same-thread repair continuation, the abort
 * probe (killing the local CLI cancels the remote turn), and thread cleanup.
 * It deletes every thread it creates. Run it against a disposable project.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { Schema } from "effect";
import { runAmpOrbWorkflowTask, runAmpRunnerWorkflowTask } from "../../src/workflow-amp-remote-worker.js";
import { AmpWorkflowWorkerError } from "../../src/workflow-amp-worker.js";
import type { AnyWorkflowWorkerTask } from "../../src/workflows.js";

const SMOKE_ENV = "PRISM_WORKFLOW_AMP_REMOTE_SMOKE";
const project = process.env.PRISM_WORKFLOW_AMP_REMOTE_PROJECT;
const runnerId = process.env.PRISM_WORKFLOW_AMP_RUNNER_ID;
const runnerDir = process.env.PRISM_AMP_RUNNER_DIR;
const cwd = process.cwd();
const lines: string[] = [];
const report = (line: string): void => {
  lines.push(line);
  console.log(line);
};

const define = (worker: "amp-orb" | "amp-runner", fields: Record<string, unknown>): AnyWorkflowWorkerTask =>
  ({
    kind: "workflow-task",
    id: "smoke",
    prompt: 'Reply with exactly the JSON object {"ok":true} and nothing else.',
    output: Schema.Struct({ ok: Schema.Boolean }),
    worker: { worker, ...fields },
  }) as unknown as AnyWorkflowWorkerTask;

const deleteThread = (threadId: string): Promise<void> =>
  new Promise((resolveCleanup) => {
    const child = spawn(process.env.PRISM_WORKFLOW_AMP_BIN ?? "amp", ["threads", "delete", threadId], {
      stdio: "ignore",
    });
    child.on("close", () => resolveCleanup());
    child.on("error", () => resolveCleanup());
  });

if (process.env[SMOKE_ENV] !== "live") {
  report(`SKIP ${SMOKE_ENV} is not "live": the amp remote smoke spends tokens and runs nothing.`);
  process.exit(0);
}
assert(project !== undefined && project.trim().length > 0, `Set PRISM_WORKFLOW_AMP_REMOTE_PROJECT=<owner/disposable-repo> to opt in.`);

let exitCode = 0;
const createdThreads: string[] = [];
try {
  // 1. Orb: create + attached stream + typed decode + session capture.
  const orbTask = define("amp-orb", { project, size: "a1.tiny" });
  const orb = await runAmpOrbWorkflowTask(orbTask, { cwd, resolvedPermission: "legacy" });
  const orbThread = orb.metadata?.sessionId;
  assert(typeof orbThread === "string" && orbThread.startsWith("T-"), `expected a T- thread id, got ${String(orbThread)}`);
  assert((orb.output as { readonly ok?: unknown }).ok === true, `orb output did not decode to {ok:true}: ${JSON.stringify(orb.output)}`);
  createdThreads.push(orbThread);
  report(`PASS orb: streamed, decoded {ok:true}, thread ${orbThread}`);

  // 2. Same-thread repair continuation on the orb thread.
  const repair = await runAmpOrbWorkflowTask(
    orbTask,
    {
      cwd,
      resolvedPermission: "legacy",
      repair: {
        attempt: 1,
        criterion: "smoke-followup",
        repairPrompt: "In one short sentence, confirm the previous turn succeeded and include the literal word CONFIRMED.",
        mode: "native-continuation",
        continuation: { adapter: "amp-orb", sessionId: orbThread },
      },
    },
  );
  assert(typeof repair.metadata?.sessionId === "string", "repair lost the session id");
  createdThreads.push(String(repair.metadata.sessionId));
  report(`PASS orb: same-thread continuation on ${String(repair.metadata.sessionId)}`);

  // 3. Abort probe: killing the local CLI cancels the remote turn.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 6_000);
  const aborted = await runAmpOrbWorkflowTask(
    define("amp-orb", { project, size: "a1.tiny" }),
    { cwd, resolvedPermission: "legacy", abortSignal: controller.signal },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert(aborted instanceof AmpWorkflowWorkerError, `abort probe expected AmpWorkflowWorkerError, got ${String(aborted)}`);
  assert(/aborted/.test((aborted as AmpWorkflowWorkerError).message), `abort error did not mention the abort: ${(aborted as AmpWorkflowWorkerError).message}`);
  report("PASS orb: abort cancelled the attached remote turn (typed error, no output consumed)");

  // 4. Runner leg (optional).
  if (runnerId !== undefined && runnerId.trim().length > 0) {
    const runnerTask = define("amp-runner", {
      runnerId: runnerId.trim(),
      ...(runnerDir !== undefined && runnerDir.trim().length > 0 ? { runnerDir: runnerDir.trim() } : {}),
    });
    const runner = await runAmpRunnerWorkflowTask(runnerTask, { cwd, resolvedPermission: "legacy" });
    const runnerThread = runner.metadata?.sessionId;
    assert(typeof runnerThread === "string" && runnerThread.startsWith("T-"), `expected a T- thread id, got ${String(runnerThread)}`);
    assert((runner.output as { readonly ok?: unknown }).ok === true, `runner output did not decode to {ok:true}: ${JSON.stringify(runner.output)}`);
    createdThreads.push(runnerThread);
    report(`PASS runner: streamed, decoded {ok:true}, thread ${runnerThread}`);
  } else {
    report("SKIP runner leg: set PRISM_WORKFLOW_AMP_RUNNER_ID to exercise the runner worker.");
  }

  // 5. Cleanup: every thread this smoke created (best effort, never fatal).
  for (const thread of new Set(createdThreads)) {
    if (thread.startsWith("T-")) await deleteThread(thread);
  }
  report("DONE amp remote smoke");
} catch (error) {
  exitCode = 1;
  report(`FAIL amp remote smoke: ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(exitCode);
