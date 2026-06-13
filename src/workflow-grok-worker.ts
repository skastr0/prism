import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyWorkflowTask } from "./workflows.js";
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

export class WorkflowOutputParseError extends Error {
  override readonly name = "WorkflowOutputParseError";
}

const jsonInstruction = (task: AnyWorkflowTask): string => `

You are running inside a Prism workflow task.

Task id: ${task.id}
Agent identity: ${task.agent.plugin}.${task.agent.name}

Return exactly one JSON value and nothing else. The Prism workflow runtime will parse
that JSON and validate it with the task's Effect Schema before any downstream task can
see it. Do not wrap the JSON in Markdown fences.
`;

const extractJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new WorkflowOutputParseError("workflow worker returned empty output");
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
    if (fenced?.[1]) return JSON.parse(fenced[1]) as unknown;

    const firstObject = trimmed.indexOf("{");
    const firstArray = trimmed.indexOf("[");
    const starts = [firstObject, firstArray].filter((index) => index >= 0);
    if (starts.length === 0) {
      throw new WorkflowOutputParseError("workflow worker output did not contain JSON");
    }
    const start = Math.min(...starts);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (end < start) {
      throw new WorkflowOutputParseError("workflow worker output contained incomplete JSON");
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
};

export const runGrokWorkflowTask = async (
  task: AnyWorkflowTask,
  options: GrokWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-workflow-grok-"));
  const promptPath = join(tempRoot, "prompt.md");
  const prompt = `${task.prompt}${jsonInstruction(task)}`;
  await writeFile(promptPath, prompt);
  const command = options.bin ?? process.env.PRISM_WORKFLOW_GROK_BIN ?? "grok";
  const args = [
    "--model",
    options.model ?? "grok-build",
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
      output: extractJson(stdout),
      metadata: {
        adapter: "grok-cli",
        model: options.model ?? "grok-build",
        durationMs,
        ...summarizeWorkflowWorkerStderr(stderr),
      },
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

export const parseWorkflowWorkerJsonOutput = extractJson;
