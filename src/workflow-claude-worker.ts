import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatedPluginIdForOwner } from "./compile/generated-plugin.js";
import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution, WorkflowTaskRepairContext } from "./workflow-runner.js";

export interface ClaudeWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly repair?: WorkflowTaskRepairContext;
}

export class ClaudeWorkflowWorkerError extends Error {
  override readonly name = "ClaudeWorkflowWorkerError";
}

export interface ClaudeGeneratedPluginDiscovery {
  readonly pluginDir?: string;
  readonly mcpConfig?: string;
}

interface ClaudeJsonEnvelope {
  readonly result?: unknown;
  readonly is_error?: boolean;
  readonly session_id?: string;
  readonly total_cost_usd?: number;
  readonly duration_ms?: number;
  readonly num_turns?: number;
}

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

const claudeRoot = (): string =>
  process.env.PRISM_WORKFLOW_CLAUDE_ROOT ?? join(homedir(), ".claude");

export const discoverClaudeGeneratedPlugin = (
  task: AnyWorkflowTask,
): ClaudeGeneratedPluginDiscovery => {
  const pluginDir = join(claudeRoot(), "skills", generatedPluginIdForOwner(task.agent.plugin));
  if (!existsSync(pluginDir)) return {};

  const mcpConfig = join(pluginDir, ".mcp.json");
  return {
    pluginDir,
    ...(existsSync(mcpConfig) ? { mcpConfig } : {}),
  };
};

export const buildClaudeArgs = (input: {
  readonly agent: string;
  readonly model?: string;
  readonly prompt: string;
  readonly resumeSessionId?: string;
  readonly generatedPlugin?: ClaudeGeneratedPluginDiscovery;
}): ReadonlyArray<string> => [
  "--print",
  "--output-format",
  "json",
  ...(input.resumeSessionId !== undefined ? ["--resume", input.resumeSessionId] : ["--agent", input.agent]),
  ...(input.model !== undefined ? ["--model", input.model] : []),
  ...(input.generatedPlugin?.pluginDir !== undefined ? ["--plugin-dir", input.generatedPlugin.pluginDir] : []),
  ...(input.generatedPlugin?.mcpConfig !== undefined ? [`--mcp-config=${input.generatedPlugin.mcpConfig}`] : []),
  ...(input.generatedPlugin?.mcpConfig !== undefined ? ["--strict-mcp-config"] : []),
  input.prompt,
];

export const runClaudeWorkflowTask = async (
  task: AnyWorkflowTask,
  options: ClaudeWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_CLAUDE_BIN ?? "claude";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_CLAUDE_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const resumeSessionId = options.repair?.continuation?.sessionId;
  const prompt = options.repair !== undefined && resumeSessionId !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const args = buildClaudeArgs({
    agent: task.agent.name,
    model: options.model,
    resumeSessionId,
    generatedPlugin: discoverClaudeGeneratedPlugin(task),
    prompt,
  });

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
  });
  if (aborted) {
    throw new ClaudeWorkflowWorkerError("claude was aborted by Prism workflow stop");
  }
  if (timedOut) {
    throw new ClaudeWorkflowWorkerError(`claude exceeded Prism process timeout after ${processTimeoutMs}ms`);
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
      nativeAgent: task.agent.name,
      model: options.model,
      durationMs,
      processTimeoutMs,
      ...summarizeWorkflowWorkerStderr(stderr),
      sessionId: envelope.session_id,
      claudeDurationMs: envelope.duration_ms,
      totalCostUsd: envelope.total_cost_usd,
      numTurns: envelope.num_turns,
      ...(options.repair !== undefined
        ? {
          repairExecution: {
            attempt: options.repair.attempt,
            criterion: options.repair.criterion,
            mode: resumeSessionId !== undefined ? "native-continuation" : "fresh-executor-invocation",
            ...(resumeSessionId !== undefined
              ? { continuation: { adapter: "claude-code", sessionId: resumeSessionId } }
              : { fallbackReason: "missing-session-id" }),
          },
        }
        : {}),
    },
  };
};
