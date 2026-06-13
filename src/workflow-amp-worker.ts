import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput } from "./workflow-grok-worker.js";
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

const jsonInstruction = (task: AnyWorkflowTask): string => `

You are running inside a Prism workflow task.

Task id: ${task.id}
Agent identity: ${task.agent.plugin}.${task.agent.name}

Return exactly one JSON value and nothing else. The Prism workflow runtime will parse
that JSON and validate it with the task's Effect Schema before any downstream task can
see it. Do not wrap the JSON in Markdown fences.
`;

export const runAmpWorkflowTask = async (
  task: AnyWorkflowTask,
  options: AmpWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_AMP_BIN ?? "amp";
  const prompt = `${task.prompt}${jsonInstruction(task)}`;
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
