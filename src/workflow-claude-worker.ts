import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatedPluginIdForOwner } from "./compile/generated-plugin.js";
import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskRepairContext } from "./workflow-runner.js";

export interface ClaudeWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
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
  readonly allowedTools?: readonly string[];
}

interface ClaudeJsonEnvelope {
  readonly result?: unknown;
  readonly is_error?: boolean;
  readonly session_id?: string;
  readonly total_cost_usd?: number;
  readonly duration_ms?: number;
  readonly num_turns?: number;
}

interface ClaudeStreamSummary {
  readonly envelope: ClaudeJsonEnvelope;
  readonly toolCallNames: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseClaudeJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch (cause) {
    throw new ClaudeWorkflowWorkerError(`claude returned invalid JSON envelope: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
};

const collectToolUseNames = (event: unknown): readonly string[] => {
  const record = isRecord(event) ? event : undefined;
  const message = isRecord(record?.message) ? record.message : record;
  const content = Array.isArray(message?.content) ? message.content : [];
  const names: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "tool_use" && typeof item.name === "string" && item.name.length > 0) {
      names.push(item.name);
    }
  }
  return names;
};

const parseClaudeStream = (stdout: string): ClaudeStreamSummary => {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new ClaudeWorkflowWorkerError("claude returned empty JSON stream");
  }

  let envelope: ClaudeJsonEnvelope | undefined;
  const toolCallNames: string[] = [];
  for (const line of lines) {
    const parsed = parseClaudeJsonLine(line);
    toolCallNames.push(...collectToolUseNames(parsed));
    if (isRecord(parsed) && parsed.type === "result") {
      envelope = parsed as ClaudeJsonEnvelope;
    }
  }

  if (envelope === undefined) {
    throw new ClaudeWorkflowWorkerError("claude JSON stream did not contain a result event");
  }

  return { envelope, toolCallNames };
};

const claudeRoot = (): string =>
  process.env.PRISM_WORKFLOW_CLAUDE_ROOT ?? join(homedir(), ".claude");

const CLAUDE_MCP_TOOL_PATTERN = /\bmcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+\b/gu;

const extractClaudeMcpToolNames = (source: string): readonly string[] =>
  [...new Set(source.match(CLAUDE_MCP_TOOL_PATTERN) ?? [])].sort();

const unexpectedClaudeMcpToolCalls = (
  toolCallNames: readonly string[],
  allowedTools: readonly string[] | undefined,
  enforceGeneratedPluginAllowList: boolean,
): readonly string[] => {
  if (!enforceGeneratedPluginAllowList) return [];
  const mcpToolCallNames = [...new Set(toolCallNames.filter((name) => name.startsWith("mcp__")))].sort();
  if (allowedTools === undefined || allowedTools.length === 0) return mcpToolCallNames;
  const allowed = new Set(allowedTools);
  return mcpToolCallNames.filter((name) => !allowed.has(name));
};

export const discoverClaudeGeneratedPlugin = (
  task: AnyWorkflowTask,
): ClaudeGeneratedPluginDiscovery => {
  const pluginDir = join(claudeRoot(), "skills", generatedPluginIdForOwner(task.agent.plugin));
  if (!existsSync(pluginDir)) return {};

  const mcpConfig = join(pluginDir, ".mcp.json");
  const agentFile = join(pluginDir, "agents", `${task.agent.name}.md`);
  const agentToolNames = existsSync(agentFile)
    ? extractClaudeMcpToolNames(readFileSync(agentFile, "utf8"))
    : [];
  if (!existsSync(mcpConfig) && agentToolNames.length > 0) {
    throw new ClaudeWorkflowWorkerError(
      `generated Claude plugin '${pluginDir}' for agent '${task.agent.plugin}:${task.agent.name}' references MCP tools but is missing '${mcpConfig}'`,
    );
  }
  return {
    pluginDir,
    ...(existsSync(mcpConfig) ? { mcpConfig } : {}),
    ...(agentToolNames.length > 0 ? { allowedTools: agentToolNames } : {}),
  };
};

const assertClaudePermission = (
  mode: WorkflowPermissionMode,
  restrictedTools?: readonly string[],
): void => {
  switch (mode) {
    case "legacy":
    case "permissive":
    case "full-access":
      return;
    case "restricted":
      if (restrictedTools === undefined || restrictedTools.length === 0) {
        throw new WorkflowPermissionError(
          "claude-code",
          mode,
          "Claude Code restricted mode requires a tools list via --allowedTools. Provide a comma-separated list of allowed tool names or choose 'permissive' or 'legacy' instead.",
        );
      }
      return;
    case "interactive":
      throw new WorkflowPermissionError(
        "claude-code",
        mode,
        "Claude Code interactive mode is incompatible with Prism workflow execution. Spawning without --print blocks the process indefinitely. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-read-only":
      throw new WorkflowPermissionError(
        "claude-code",
        mode,
        "Claude Code exposes no built-in sandbox flag. Apply host-level process isolation outside the harness. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-workspace-write":
      throw new WorkflowPermissionError(
        "claude-code",
        mode,
        "Claude Code exposes no workspace-write sandbox mode. Apply host-level process isolation outside the harness. Choose 'permissive' or 'legacy' instead.",
      );
  }
  return assertNeverWorkflowPermissionMode("claude-code", mode);
};

export const buildClaudeArgs = (input: {
  readonly agent: string;
  readonly model?: string;
  readonly prompt: string;
  readonly resumeSessionId?: string;
  readonly generatedPlugin?: ClaudeGeneratedPluginDiscovery;
  readonly permission?: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
}): ReadonlyArray<string> => {
  const mode = input.permission ?? "permissive";
  assertClaudePermission(mode, input.restrictedTools);

  const permissionArgs: string[] = [];
  if (mode === "permissive" || mode === "full-access") {
    // Claude exposes no separate stronger full-access flag; both modes map to the documented bypass.
    permissionArgs.push("--dangerously-skip-permissions");
  }
  if (mode === "restricted" && input.restrictedTools !== undefined && input.restrictedTools.length > 0) {
    permissionArgs.push(`--allowedTools=${input.restrictedTools.join(",")}`);
  }

  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(input.resumeSessionId !== undefined ? ["--resume", input.resumeSessionId] : ["--agent", input.agent]),
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(input.generatedPlugin?.pluginDir !== undefined ? ["--plugin-dir", input.generatedPlugin.pluginDir] : []),
    ...(input.generatedPlugin?.mcpConfig !== undefined ? [`--mcp-config=${input.generatedPlugin.mcpConfig}`] : []),
    ...(input.generatedPlugin?.mcpConfig !== undefined ? ["--strict-mcp-config"] : []),
    ...(input.generatedPlugin?.allowedTools !== undefined && input.generatedPlugin.allowedTools.length > 0
      ? [`--allowedTools=${input.generatedPlugin.allowedTools.join(",")}`]
      : []),
    ...permissionArgs,
    input.prompt,
  ];
};

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
  const generatedPlugin = discoverClaudeGeneratedPlugin(task);
  const args = buildClaudeArgs({
    agent: task.agent.name,
    model: options.model,
    resumeSessionId,
    generatedPlugin,
    prompt,
    permission: options.resolvedPermission,
    restrictedTools: options.restrictedTools,
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

  const { envelope, toolCallNames } = parseClaudeStream(stdout);
  const unexpectedMcpToolCalls = unexpectedClaudeMcpToolCalls(
    toolCallNames,
    generatedPlugin.allowedTools,
    generatedPlugin.pluginDir !== undefined,
  );
  if (unexpectedMcpToolCalls.length > 0) {
    throw new ClaudeWorkflowWorkerError(
      `claude called MCP tools outside generated agent allow-list: ${unexpectedMcpToolCalls.join(", ")}`,
    );
  }
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
      claudeToolCallNames: toolCallNames,
      claudeMcpToolCallCount: toolCallNames.filter((name) => name.startsWith("mcp__")).length,
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
