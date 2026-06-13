import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput } from "./workflow-grok-worker.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface ClaudeWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly abortSignal?: AbortSignal;
}

export class ClaudeWorkflowWorkerError extends Error {
  override readonly name = "ClaudeWorkflowWorkerError";
}

interface ClaudeJsonEnvelope {
  readonly result?: unknown;
  readonly is_error?: boolean;
  readonly session_id?: string;
  readonly total_cost_usd?: number;
  readonly duration_ms?: number;
  readonly num_turns?: number;
}

const jsonInstruction = (task: AnyWorkflowTask): string => `

You are running inside a Prism workflow task.

Task id: ${task.id}
Agent identity: ${task.agent.plugin}.${task.agent.name}

Return exactly one JSON value and nothing else. The Prism workflow runtime will parse
that JSON and validate it with the task's Effect Schema before any downstream task can
see it. Do not wrap the JSON in Markdown fences.
`;

const parseClaudeEnvelope = (stdout: string): ClaudeJsonEnvelope => {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new ClaudeWorkflowWorkerError("claude returned a non-object JSON envelope");
    }
    return parsed as ClaudeJsonEnvelope;
  } catch (cause) {
    if (cause instanceof ClaudeWorkflowWorkerError) throw cause;
    throw new ClaudeWorkflowWorkerError(`claude returned invalid JSON envelope: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
};

export const runClaudeWorkflowTask = async (
  task: AnyWorkflowTask,
  options: ClaudeWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_CLAUDE_BIN ?? "claude";
  const prompt = `${task.prompt}${jsonInstruction(task)}`;
  const args = [
    "--print",
    "--output-format",
    "json",
    "--no-session-persistence",
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
    throw new ClaudeWorkflowWorkerError("claude was aborted by Prism workflow stop");
  }
  if (exitCode !== 0) {
    throw new ClaudeWorkflowWorkerError(`claude exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }

  const envelope = parseClaudeEnvelope(stdout);
  if (envelope.is_error !== undefined && envelope.is_error !== false) {
    throw new ClaudeWorkflowWorkerError(`claude returned an error: ${typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result)}`);
  }
  if (typeof envelope.result !== "string") {
    throw new ClaudeWorkflowWorkerError("claude JSON envelope did not contain a string result");
  }

  return {
    output: parseWorkflowWorkerJsonOutput(envelope.result),
    metadata: {
      adapter: "claude-code",
      model: options.model,
      durationMs,
      ...summarizeWorkflowWorkerStderr(stderr),
      sessionId: envelope.session_id,
      claudeDurationMs: envelope.duration_ms,
      totalCostUsd: envelope.total_cost_usd,
      numTurns: envelope.num_turns,
    },
  };
};
