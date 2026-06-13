import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput } from "./workflow-grok-worker.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface CodexWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly abortSignal?: AbortSignal;
}

export class CodexWorkflowWorkerError extends Error {
  override readonly name = "CodexWorkflowWorkerError";
}

const jsonInstruction = (task: AnyWorkflowTask): string => `

You are running inside a Prism workflow task.

Task id: ${task.id}
Agent identity: ${task.agent.plugin}.${task.agent.name}

Return exactly one JSON value and nothing else. The Prism workflow runtime will parse
that JSON and validate it with the task's Effect Schema before any downstream task can
see it. Do not wrap the JSON in Markdown fences.
`;

export const runCodexWorkflowTask = async (
  task: AnyWorkflowTask,
  options: CodexWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-workflow-codex-"));
  const outputPath = join(tempRoot, "last-message.txt");
  const command = options.bin ?? process.env.PRISM_WORKFLOW_CODEX_BIN ?? "codex";
  const prompt = `${task.prompt}${jsonInstruction(task)}`;
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
    const { exitCode, stdout, stderr, durationMs, aborted } = await runWorkflowWorkerProcess({
      command,
      args,
      cwd: options.cwd,
      abortSignal: options.abortSignal,
    });
    if (aborted) {
      throw new CodexWorkflowWorkerError("codex was aborted by Prism workflow stop");
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
        ...summarizeWorkflowWorkerStderr(stderr),
      },
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};
