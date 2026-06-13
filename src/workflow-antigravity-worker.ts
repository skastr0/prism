import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess, workflowWorkerProcessExcerpt } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface AntigravityWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly printTimeout?: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

export class AntigravityWorkflowWorkerError extends Error {
  override readonly name = "AntigravityWorkflowWorkerError";
}

const agyErrorText = (stdout: string, stderr: string): string | undefined => {
  const text = `${stdout}\n${stderr}`.trim();
  const errorIndex = text.indexOf("Error:");
  if (errorIndex >= 0) return text.slice(errorIndex);
  return undefined;
};

export const runAntigravityWorkflowTask = async (
  task: AnyWorkflowTask,
  options: AntigravityWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_ANTIGRAVITY_BIN ?? "agy";
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const printTimeout = options.printTimeout ?? process.env.PRISM_WORKFLOW_ANTIGRAVITY_PRINT_TIMEOUT ?? "5m";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const args = [
    "--print",
    "--dangerously-skip-permissions",
    "--sandbox",
    "--print-timeout",
    printTimeout,
    "--add-dir",
    options.cwd,
    ...(options.model !== undefined ? ["--model", options.model] : []),
    prompt,
  ];

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
  });
  if (aborted) {
    throw new AntigravityWorkflowWorkerError(`agy was aborted by Prism workflow stop${workflowWorkerProcessExcerpt(stdout, stderr)}`);
  }
  if (timedOut) {
    const excerpt = workflowWorkerProcessExcerpt(stdout, stderr);
    throw new AntigravityWorkflowWorkerError(`agy exceeded Prism process timeout after ${processTimeoutMs}ms${excerpt}`);
  }
  if (exitCode !== 0) {
    throw new AntigravityWorkflowWorkerError(`agy exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }

  let output: unknown;
  try {
    output = parseWorkflowWorkerJsonOutput(stdout);
  } catch (error) {
    const printedError = agyErrorText(stdout, stderr);
    if (printedError !== undefined) {
      throw new AntigravityWorkflowWorkerError(`agy exited with ${exitCode}: ${printedError}`);
    }
    throw error;
  }
  return {
    output,
    metadata: {
      adapter: "antigravity-cli",
      model: options.model,
      durationMs,
      printTimeout,
      processTimeoutMs,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
