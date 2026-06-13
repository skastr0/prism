import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput } from "./workflow-grok-worker.js";
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

const jsonInstruction = (task: AnyWorkflowTask): string => `

You are running inside a Prism workflow task.

Task id: ${task.id}
Agent identity: ${task.agent.plugin}.${task.agent.name}

Return exactly one JSON value and nothing else. The Prism workflow runtime will parse
that JSON and validate it with the task's Effect Schema before any downstream task can
see it. Do not wrap the JSON in Markdown fences.
`;

export const runOpenCodeWorkflowTask = async (
  task: AnyWorkflowTask,
  options: OpenCodeWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_OPENCODE_BIN ?? "opencode";
  const prompt = `${task.prompt}${jsonInstruction(task)}`;
  const args = [
    "run",
    "--dir",
    options.cwd,
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
      model: options.model,
      durationMs,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
