import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess, workflowWorkerProcessExcerpt } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface GrokWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

export class WorkflowWorkerError extends Error {
  override readonly name = "WorkflowWorkerError";
}

export const buildGrokArgs = (input: {
  readonly cwd: string;
  readonly agent: string;
  readonly model?: string;
  readonly effort?: string;
  readonly prompt: string;
}): ReadonlyArray<string> => [
  "--model",
  input.model ?? "grok-build",
  "--agent",
  input.agent,
  "--cwd",
  input.cwd,
  "--no-alt-screen",
  "--output-format",
  "plain",
  ...(input.effort ? ["--effort", input.effort] : []),
  "--single",
  input.prompt,
];

export const runGrokWorkflowTask = async (
  task: AnyWorkflowTask,
  options: GrokWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const command = options.bin ?? process.env.PRISM_WORKFLOW_GROK_BIN ?? "grok";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_GROK_PROCESS_TIMEOUT_MS)
    ?? 120_000;
  const args = buildGrokArgs({
    cwd: options.cwd,
    agent: task.agent.name,
    model: options.model,
    effort: options.effort,
    prompt,
  });

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
  });
  if (aborted) {
    throw new WorkflowWorkerError("grok was aborted by Prism workflow stop");
  }
  if (timedOut) {
    throw new WorkflowWorkerError(
      `grok exceeded Prism process timeout after ${processTimeoutMs}ms${workflowWorkerProcessExcerpt(stdout, stderr)}`,
    );
  }
  if (exitCode !== 0) {
    throw new WorkflowWorkerError(`grok exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return {
    output: parseWorkflowWorkerJsonOutput(stdout),
    metadata: {
      adapter: "grok-cli",
      nativeAgent: task.agent.name,
      model: options.model ?? "grok-build",
      durationMs,
      processTimeoutMs,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};

export { parseWorkflowWorkerJsonOutput, WorkflowOutputParseError } from "./workflow-worker-contract.js";
