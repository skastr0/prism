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

export type AmpWorkflowMode = "deep" | "rush";

export const assertAmpWorkflowMode = (mode: string | undefined): AmpWorkflowMode | undefined => {
  if (mode === undefined) return undefined;
  if (mode === "deep" || mode === "rush") return mode;
  throw new AmpWorkflowWorkerError(`unsupported Amp workflow mode '${mode}'. Supported modes: deep, rush`);
};

export const buildAmpArgs = (input: {
  readonly mode?: string;
  readonly prompt: string;
}): ReadonlyArray<string> => {
  const mode = assertAmpWorkflowMode(input.mode);
  return [
    "--no-ide",
    "--no-notifications",
    "--no-color",
    "--no-archive-after-execute",
    ...(mode !== undefined ? ["--mode", mode] : []),
    "--execute",
    input.prompt,
  ];
};

export const runAmpWorkflowTask = async (
  task: AnyWorkflowTask,
  options: AmpWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_AMP_BIN ?? "amp";
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const args = buildAmpArgs({ mode: options.model, prompt });

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
