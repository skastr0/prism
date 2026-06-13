import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput } from "./workflow-grok-worker.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface AntigravityWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly printTimeout?: string;
  readonly processTimeoutMs?: number;
}

export class AntigravityWorkflowWorkerError extends Error {
  override readonly name = "AntigravityWorkflowWorkerError";
}

const jsonInstruction = (task: AnyWorkflowTask): string => `

You are running inside a Prism workflow task.

Task id: ${task.id}
Agent identity: ${task.agent.plugin}.${task.agent.name}

Return exactly one JSON value and nothing else. The Prism workflow runtime will parse
that JSON and validate it with the task's Effect Schema before any downstream task can
see it. Do not wrap the JSON in Markdown fences.
`;

const agyErrorText = (stdout: string, stderr: string): string | undefined => {
  const text = `${stdout}\n${stderr}`.trim();
  const errorIndex = text.indexOf("Error:");
  if (errorIndex >= 0) return text.slice(errorIndex);
  return undefined;
};

const parsePositiveInteger = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};

export const runAntigravityWorkflowTask = async (
  task: AnyWorkflowTask,
  options: AntigravityWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_ANTIGRAVITY_BIN ?? "agy";
  const prompt = `${task.prompt}${jsonInstruction(task)}`;
  const printTimeout = options.printTimeout ?? process.env.PRISM_WORKFLOW_ANTIGRAVITY_PRINT_TIMEOUT ?? "5m";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const args = [
    "--print",
    "--dangerously-skip-permissions",
    "--sandbox",
    "--print-timeout",
    printTimeout,
    "--add-dir",
    options.cwd,
    ...(options.model !== undefined ? ["--model", options.model] : []),
    prompt,
  ];

  const started = Date.now();
  const child = Bun.spawn({
    cmd: [command, ...args],
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, processTimeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  const durationMs = Date.now() - started;
  if (timedOut) {
    const transcript = `${stdout}\n${stderr}`.trim();
    const excerpt = transcript.length > 0 ? `: ${transcript.slice(-512)}` : "";
    throw new AntigravityWorkflowWorkerError(`agy exceeded Prism process timeout after ${processTimeoutMs}ms${excerpt}`);
  }
  if (exitCode !== 0) {
    throw new AntigravityWorkflowWorkerError(`agy exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }

  let output: unknown;
  try {
    output = parseWorkflowWorkerJsonOutput(stdout);
  } catch (error) {
    const printedError = agyErrorText(stdout, stderr);
    if (printedError !== undefined) {
      throw new AntigravityWorkflowWorkerError(`agy exited with ${exitCode}: ${printedError}`);
    }
    throw error;
  }
  return {
    output,
    metadata: {
      adapter: "antigravity-cli",
      model: options.model,
      durationMs,
      printTimeout,
      processTimeoutMs,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
