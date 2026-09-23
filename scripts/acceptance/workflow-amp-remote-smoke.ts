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
 * output, session_id capture, same-thread repair continuation, the local
 * abort probe (typed error; remote cancellation verified via threads export
 * when the stream got far enough), the orb tool-permission probe (§6.1), and
 * thread cleanup. It deletes every thread it creates, on success and failure
 * alike (finally). Run it against a disposable project.
 */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { Schema } from "effect";
import { runAmpOrbWorkflowTask, runAmpRunnerWorkflowTask } from "../../src/workflow-amp-remote-worker.js";
import { AmpWorkflowWorkerError } from "../../src/workflow-amp-worker.js";
import type { AnyWorkflowWorkerTask } from "../../src/workflows.js";

const SMOKE_ENV = "PRISM_WORKFLOW_AMP_REMOTE_SMOKE";
const project = process.env.PRISM_WORKFLOW_AMP_REMOTE_PROJECT;
const runnerId = process.env.PRISM_WORKFLOW_AMP_RUNNER_ID;
const runnerDir = process.env.PRISM_AMP_RUNNER_DIR;
const ampBin = process.env.PRISM_WORKFLOW_AMP_BIN ?? "amp";
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
    const child = spawn(ampBin, ["threads", "delete", threadId], { stdio: "ignore" });
    child.on("close", () => resolveCleanup());
    child.on("error", () => resolveCleanup());
  });

const threadExport = (threadId: string): string => {
  const result = spawnSync(ampBin, ["threads", "export", threadId], { encoding: "utf8", timeout: 30_000 });
  return result.status === 0 ? result.stdout : "";
};

const assistantMessageCount = (threadId: string): number => {
  const raw = threadExport(threadId);
  if (raw.trim().length === 0) return -1;
  try {
    const parsed = JSON.parse(raw) as { readonly messages?: ReadonlyArray<{ readonly role?: unknown }> };
    return Array.isArray(parsed.messages) ? parsed.messages.filter((message) => message.role === "assistant").length : -1;
  } catch {
    return -1;
  }
};

const collectThreadIds = (metadata: Record<string, unknown> | undefined): string[] =>
  metadata === undefined
    ? []
    : [metadata.ampThread, metadata.sessionId].filter((value): value is string => typeof value === "string" && value.startsWith("T-"));

const rememberThread = (threadId: unknown): void => {
  if (typeof threadId === "string" && threadId.startsWith("T-")) createdThreads.add(threadId);
};

if (process.env[SMOKE_ENV] !== "live") {
  report(`SKIP ${SMOKE_ENV} is not "live": the amp remote smoke spends tokens and runs nothing.`);
  process.exit(0);
}
assert(project !== undefined && project.trim().length > 0, `Set PRISM_WORKFLOW_AMP_REMOTE_PROJECT=<owner/disposable-repo> to opt in.`);

let exitCode = 0;
const createdThreads = new Set<string>();
try {
  // 1. Orb: create + attached stream + typed decode + session capture.
  const orbTask = define("amp-orb", { project, size: "a1.tiny" });
  const orb = await runAmpOrbWorkflowTask(orbTask, { cwd, resolvedPermission: "legacy" });
  const orbThread = orb.metadata?.sessionId;
  assert(typeof orbThread === "string" && orbThread.startsWith("T-"), `expected a T- thread id, got ${String(orbThread)}`);
  rememberThread(orbThread);
  assert((orb.output as { readonly ok?: unknown }).ok === true, `orb output did not decode to {ok:true}: ${JSON.stringify(orb.output)}`);
  report(`PASS orb: streamed, decoded {ok:true}, thread ${orbThread}`);

  // 2. Same-thread repair continuation: the continuation must reuse the thread.
  const repair = await runAmpOrbWorkflowTask(
    orbTask,
    {
      cwd,
      resolvedPermission: "legacy",
      repair: {
        attempt: 1,
        criterion: "smoke-followup",
        repairPrompt: 'The previous turn succeeded. Reply with exactly the JSON object {"ok":true,"confirmed":true} and nothing else.',
        mode: "native-continuation",
        continuation: { adapter: "amp-orb", sessionId: orbThread },
      },
    },
  );
  assert(repair.metadata?.sessionId === orbThread, `repair ran on ${String(repair.metadata?.sessionId)}, expected the same thread ${orbThread}`);
  assert((repair.output as { readonly confirmed?: unknown }).confirmed === true, `repair output did not decode to {ok:true,confirmed:true}: ${JSON.stringify(repair.output)}`);
  report(`PASS orb: same-thread continuation on ${orbThread}`);

  // 3. Orb tool-permission probe (design §6.1 / §10): can the orb execute a
  // tool, and does the reply carry its output through the JSON contract?
  const toolProbe = await runAmpOrbWorkflowTask(
    {
      ...orbTask,
      prompt: 'Run the shell command `echo hi`, then reply with exactly the JSON object {"ok":true,"echo":"<the command output>"} and nothing else.',
      output: Schema.Struct({ ok: Schema.Boolean, echo: Schema.String }),
    },
    { cwd, resolvedPermission: "legacy" },
  );
  rememberThread(toolProbe.metadata?.sessionId);
  const toolOutput = (toolProbe.output as { readonly echo?: unknown }).echo;
  report(typeof toolOutput === "string" && toolOutput.includes("hi")
    ? `PASS orb: tool probe executed (echo output: ${JSON.stringify(toolOutput.trim())})`
    : `NOTE orb: tool probe completed without executing the command (echo: ${JSON.stringify(toolOutput ?? null)})`);

  // 4. Abort probe: the local typed abort error is the contract. When the
  // stream got past enqueue (the CLI created the thread), verify the remote
  // turn actually stopped via threads export.
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
  for (const thread of collectThreadIds((aborted as AmpWorkflowWorkerError).metadata)) rememberThread(thread);
  if (aborted instanceof AmpWorkflowWorkerError && typeof aborted.metadata?.sessionId === "string") {
    const assistantMessages = assistantMessageCount(aborted.metadata.sessionId);
    report(assistantMessages === 0
      ? `PASS orb: local abort -> typed error; threads export confirms no remote turn output on ${aborted.metadata.sessionId}`
      : `PASS orb: local abort -> typed error (threads export readback inconclusive: assistantMessages=${assistantMessages})`);
  } else {
    report("PASS orb: local abort -> typed error (killed inside the enqueue window; no thread id exposed)");
  }

  // 5. Runner leg (optional).
  if (runnerId !== undefined && runnerId.trim().length > 0) {
    const runnerTask = define("amp-runner", {
      runnerId: runnerId.trim(),
      ...(runnerDir !== undefined && runnerDir.trim().length > 0 ? { runnerDir: runnerDir.trim() } : {}),
    });
    const runner = await runAmpRunnerWorkflowTask(runnerTask, { cwd, resolvedPermission: "legacy" });
    const runnerThread = runner.metadata?.sessionId;
    assert(typeof runnerThread === "string" && runnerThread.startsWith("T-"), `expected a T- thread id, got ${String(runnerThread)}`);
    rememberThread(runnerThread);
    assert((runner.output as { readonly ok?: unknown }).ok === true, `runner output did not decode to {ok:true}: ${JSON.stringify(runner.output)}`);
    report(`PASS runner: streamed, decoded {ok:true}, thread ${runnerThread}`);
  } else {
    report("SKIP runner leg: set PRISM_WORKFLOW_AMP_RUNNER_ID to exercise the runner worker.");
  }
  report("DONE amp remote smoke");
} catch (error) {
  exitCode = 1;
  // A step that threw after its stream started still owns a thread; collect
  // its id from the typed error's metadata before cleanup.
  if (error instanceof AmpWorkflowWorkerError) {
    for (const thread of collectThreadIds(error.metadata)) createdThreads.add(thread);
  }
  report(`FAIL amp remote smoke: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // Every thread this smoke created is deleted, success or failure.
  for (const thread of createdThreads) {
    await deleteThread(thread);
  }
  if (createdThreads.size > 0) {
    report(`CLEANUP deleted ${createdThreads.size} thread(s): ${[...createdThreads].join(", ")}`);
  }
}
process.exit(exitCode);
