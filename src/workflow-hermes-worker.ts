import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface HermesWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

export class HermesWorkflowWorkerError extends Error {
  override readonly name = "HermesWorkflowWorkerError";
}

const hermesSessionId = (stderr: string): string | undefined => {
  const match = stderr.match(/\bsession_id:\s*([^\s]+)/u);
  return match?.[1];
};

export const runHermesWorkflowTask = async (
  task: AnyWorkflowTask,
  options: HermesWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_HERMES_BIN ?? "hermes";
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_HERMES_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const args = [
    ...(options.profile !== undefined ? ["--profile", options.profile] : []),
    "chat",
    "--query",
    prompt,
    "--quiet",
    "--source",
    "prism-workflow",
    ...(options.model !== undefined ? ["--model", options.model] : []),
  ];

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
  });
  if (aborted) {
    throw new HermesWorkflowWorkerError("hermes was aborted by Prism workflow stop");
  }
  if (timedOut) {
    throw new HermesWorkflowWorkerError(`hermes exceeded Prism process timeout after ${processTimeoutMs}ms`);
  }
  if (exitCode !== 0) {
    throw new HermesWorkflowWorkerError(`hermes exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return {
    output: parseWorkflowWorkerJsonOutput(stdout),
    metadata: {
      adapter: "hermes",
      prompted: options.profile === undefined,
      agentSelection: options.profile === undefined ? "prompted-contract" : "profile",
      source: "prism-workflow",
      profile: options.profile,
      agent: {
        plugin: task.agent.plugin,
        name: task.agent.name,
        manifestHash: task.agent.manifestHash,
      },
      model: options.model,
      durationMs,
      processTimeoutMs,
      sessionId: hermesSessionId(stderr),
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
