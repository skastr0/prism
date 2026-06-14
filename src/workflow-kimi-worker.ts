import { homedir } from "node:os";
import { join } from "node:path";
import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess, workflowWorkerProcessExcerpt } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface KimiWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

export class KimiWorkflowWorkerError extends Error {
  override readonly name = "KimiWorkflowWorkerError";
}

export const runKimiWorkflowTask = async (
  task: AnyWorkflowTask,
  options: KimiWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin
    ?? process.env.PRISM_WORKFLOW_KIMI_BIN
    ?? join(homedir(), ".kimi-code", "bin", "kimi");
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_KIMI_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const args = [
    ...(options.model !== undefined ? ["--model", options.model] : []),
    "--prompt",
    prompt,
    "--output-format",
    "text",
  ];

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
  });
  if (aborted) {
    throw new KimiWorkflowWorkerError(`kimi-code was aborted by Prism workflow stop${workflowWorkerProcessExcerpt(stdout, stderr)}`);
  }
  if (timedOut) {
    const excerpt = workflowWorkerProcessExcerpt(stdout, stderr);
    throw new KimiWorkflowWorkerError(`kimi-code exceeded Prism process timeout after ${processTimeoutMs}ms${excerpt}`);
  }
  if (exitCode !== 0) {
    throw new KimiWorkflowWorkerError(`kimi-code exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return {
    output: parseWorkflowWorkerJsonOutput(stdout),
    metadata: {
      adapter: "kimi-code",
      prompted: true,
      agentSelection: "role-skill-contract",
      source: "prism-workflow",
      agent: {
        plugin: task.agent.plugin,
        name: task.agent.name,
        manifestHash: task.agent.manifestHash,
      },
      model: options.model,
      durationMs,
      processTimeoutMs,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
