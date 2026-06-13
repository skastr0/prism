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

const agyPrintFailureMessage = (input: {
  readonly printedError: string;
  readonly printTimeout: string;
  readonly model?: string;
}): string => {
  const model = input.model ?? "<default>";
  return `agy print mode failed before Prism worker JSON (printTimeout: ${input.printTimeout}, model: ${model}): ${input.printedError}`;
};

const antigravityMetadata = (input: {
  readonly task: AnyWorkflowTask;
  readonly model?: string;
  readonly durationMs: number;
  readonly printTimeout: string;
  readonly processTimeoutMs: number;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly recoveredAfterTimeout?: boolean;
}) => ({
  adapter: "antigravity-cli",
  prompted: true,
  agentSelection: "prompted-contract",
  agent: {
    plugin: input.task.agent.plugin,
    name: input.task.agent.name,
    manifestHash: input.task.agent.manifestHash,
  },
  model: input.model,
  durationMs: input.durationMs,
  printTimeout: input.printTimeout,
  processTimeoutMs: input.processTimeoutMs,
  ...(input.timedOut === true ? { timedOut: true } : {}),
  ...(input.recoveredAfterTimeout === true ? { recoveredAfterTimeout: true } : {}),
  ...summarizeWorkflowWorkerStderr(input.stderr),
});

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
    try {
      return {
        output: parseWorkflowWorkerJsonOutput(stdout),
        metadata: antigravityMetadata({
          task,
          model: options.model,
          durationMs,
          printTimeout,
          processTimeoutMs,
          stderr,
          timedOut: true,
          recoveredAfterTimeout: true,
        }),
      };
    } catch {
      // Preserve the existing timeout failure unless AGY printed a complete Prism worker JSON value before stalling.
    }
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
      throw new AntigravityWorkflowWorkerError(agyPrintFailureMessage({
        printedError,
        printTimeout,
        model: options.model,
      }));
    }
    throw error;
  }
  return {
    output,
    metadata: antigravityMetadata({
      task,
      model: options.model,
      durationMs,
      printTimeout,
      processTimeoutMs,
      stderr,
    }),
  };
};
