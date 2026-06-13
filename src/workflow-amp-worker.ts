import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface AmpWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly abortSignal?: AbortSignal;
}

export class AmpWorkflowWorkerError extends Error {
  override readonly name = "AmpWorkflowWorkerError";
}

export const runAmpWorkflowTask = async (
  task: AnyWorkflowTask,
  options: AmpWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_AMP_BIN ?? "amp";
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const args = [
    "--no-ide",
    "--no-notifications",
    "--no-color",
    "--no-archive-after-execute",
    ...(options.model !== undefined ? ["--mode", options.model] : []),
    "--execute",
    prompt,
  ];

  const { exitCode, stdout, stderr, durationMs, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    abortSignal: options.abortSignal,
  });
  if (aborted) {
    throw new AmpWorkflowWorkerError("amp was aborted by Prism workflow stop");
  }
  if (exitCode !== 0) {
    throw new AmpWorkflowWorkerError(`amp exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return {
    output: parseWorkflowWorkerJsonOutput(stdout),
    metadata: {
      adapter: "amp-code",
      model: options.model,
      durationMs,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
