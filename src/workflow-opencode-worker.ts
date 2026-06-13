import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface OpenCodeWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly abortSignal?: AbortSignal;
}

export class OpenCodeWorkflowWorkerError extends Error {
  override readonly name = "OpenCodeWorkflowWorkerError";
}

export const runOpenCodeWorkflowTask = async (
  task: AnyWorkflowTask,
  options: OpenCodeWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_OPENCODE_BIN ?? "opencode";
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const args = [
    "run",
    "--dir",
    options.cwd,
    "--agent",
    task.agent.name,
    ...(options.model !== undefined ? ["--model", options.model] : []),
    prompt,
  ];

  const { exitCode, stdout, stderr, durationMs, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    abortSignal: options.abortSignal,
  });
  if (aborted) {
    throw new OpenCodeWorkflowWorkerError("opencode was aborted by Prism workflow stop");
  }
  if (exitCode !== 0) {
    throw new OpenCodeWorkflowWorkerError(`opencode exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return {
    output: parseWorkflowWorkerJsonOutput(stdout),
    metadata: {
      adapter: "opencode-cli",
      nativeAgent: task.agent.name,
      model: options.model,
      durationMs,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
