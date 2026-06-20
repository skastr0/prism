import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface CodexWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

export class CodexWorkflowWorkerError extends Error {
  override readonly name = "CodexWorkflowWorkerError";
}

export const runCodexWorkflowTask = async (
  task: AnyWorkflowTask,
  options: CodexWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-workflow-codex-"));
  const outputPath = join(tempRoot, "last-message.txt");
  const command = options.bin ?? process.env.PRISM_WORKFLOW_CODEX_BIN ?? "codex";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_CODEX_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const args = [
    "exec",
    ...(options.model !== undefined ? ["--model", options.model] : []),
    "--cd",
    options.cwd,
    "--sandbox",
    "workspace-write",
    "--ephemeral",
    "--output-last-message",
    outputPath,
    prompt,
  ];

  try {
    const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
      command,
      args,
      cwd: options.cwd,
      processTimeoutMs,
      abortSignal: options.abortSignal,
    });
    if (aborted) {
      throw new CodexWorkflowWorkerError("codex was aborted by Prism workflow stop");
    }
    if (timedOut) {
      throw new CodexWorkflowWorkerError(`codex exceeded Prism process timeout after ${processTimeoutMs}ms`);
    }
    if (exitCode !== 0) {
      throw new CodexWorkflowWorkerError(`codex exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }
    const outputText = await readFile(outputPath, "utf8").catch((cause) => {
      throw new CodexWorkflowWorkerError(`codex did not write --output-last-message: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    return {
      output: parseWorkflowWorkerJsonOutput(outputText),
      metadata: {
        adapter: "codex-cli",
        model: options.model,
        durationMs,
        processTimeoutMs,
        ...summarizeWorkflowWorkerStderr(stderr),
      },
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};
