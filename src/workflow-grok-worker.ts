import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface GrokWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly abortSignal?: AbortSignal;
}

export class WorkflowWorkerError extends Error {
  override readonly name = "WorkflowWorkerError";
}

export const runGrokWorkflowTask = async (
  task: AnyWorkflowTask,
  options: GrokWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-workflow-grok-"));
  const promptPath = join(tempRoot, "prompt.md");
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  await writeFile(promptPath, prompt);
  const command = options.bin ?? process.env.PRISM_WORKFLOW_GROK_BIN ?? "grok";
  const args = [
    "--model",
    options.model ?? "grok-build",
    "--agent",
    task.agent.name,
    "--cwd",
    options.cwd,
    "--no-alt-screen",
    "--output-format",
    "plain",
    "--prompt-file",
    promptPath,
    ...(options.effort ? ["--effort", options.effort] : []),
  ];

  try {
    const { exitCode, stdout, stderr, durationMs, aborted } = await runWorkflowWorkerProcess({
      command,
      args,
      cwd: options.cwd,
      abortSignal: options.abortSignal,
    });
    if (aborted) {
      throw new WorkflowWorkerError("grok was aborted by Prism workflow stop");
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
        ...summarizeWorkflowWorkerStderr(stderr),
      },
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

export { parseWorkflowWorkerJsonOutput, WorkflowOutputParseError } from "./workflow-worker-contract.js";
