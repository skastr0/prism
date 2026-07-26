import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatedPluginIdForOwner } from "./compile/generated-plugin.js";
import type {
  AnyWorkflowTask,
  WorkflowPermissionMode,
  WorkflowSessionPersistence,
} from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import {
  summarizeWorkflowWorkerStderrForSession,
  workflowWorkerFailureMetadata,
} from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import { tryWorkflowJsonSchemaFromEffectSchema, type WorkflowJsonSchema } from "./workflow-output-schema.js";
import type { WorkflowTaskExecution, WorkflowTaskProgressReporter, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";
import { stableSessionIdFromJsonLines } from "./workflow-session.js";

export type ClaudeWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly sessionPersistence?: WorkflowSessionPersistence;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
} & WorkflowTaskRepairLoopOption<"claude-code">;

export class ClaudeWorkflowWorkerError extends Error {
  override readonly name = "ClaudeWorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

// Best-effort session id capture on a failure path (OBS-006): claude's stream-json format
// emits a system/init event carrying session_id before the final result event, so even a
// stream that failed partway through (non-zero exit, timeout) may have printed one. Falls
// back to the known repair-loop continuation id, if any.
const claudeFailureSessionId = (stdout: string, fallback: string | undefined): string | undefined =>
  stableSessionIdFromJsonLines(stdout, ["session_id"]) ?? fallback;

export interface ClaudeGeneratedPluginDiscovery {
  readonly pluginDir?: string;
}

interface ClaudeJsonEnvelope {
  readonly result?: unknown;
  readonly structured_output?: unknown;
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

const claudeEnvelopeOutput = (envelope: ClaudeJsonEnvelope): unknown => {
  if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
    return envelope.structured_output;
  }
  if (typeof envelope.result !== "string") {
    throw new ClaudeWorkflowWorkerError("claude JSON envelope did not contain a string result");
  }
  return parseWorkflowWorkerJsonOutput(envelope.result);
};

// Hardcode Claude's config root to ~/.claude (where `prism sync` installs the generated
// plugin/skill). Tests redirect by spawning with HOME set. (homedir() honors $HOME.)
const claudeRoot = (): string => join(homedir(), ".claude");

export const discoverClaudeGeneratedPlugin = (
  task: AnyWorkflowTask,
): ClaudeGeneratedPluginDiscovery => {
  const pluginDir = join(claudeRoot(), "skills", generatedPluginIdForOwner(task.agent.plugin));
  if (!existsSync(pluginDir)) return {};
  return { pluginDir };
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

type ClaudeWorkflowSessionArgs =
  | {
    readonly sessionPersistence?: "persistent";
    readonly resumeSessionId?: string;
  }
  | {
    readonly sessionPersistence: "ephemeral";
    readonly resumeSessionId?: never;
  };

export const buildClaudeArgs = (input: {
  readonly agent: string;
  readonly model?: string;
  readonly prompt: string;
  readonly generatedPlugin?: ClaudeGeneratedPluginDiscovery;
  readonly outputSchema?: WorkflowJsonSchema;
  readonly permission?: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
} & ClaudeWorkflowSessionArgs): ReadonlyArray<string> => {
  const mode = input.permission ?? "permissive";
  assertClaudePermission(mode, input.restrictedTools);

  const permissionArgs: string[] = [];
  if (mode === "permissive" || mode === "full-access") {
    // Claude exposes no separate stronger full-access flag; both modes map to the documented bypass.
    permissionArgs.push("--dangerously-skip-permissions");
  }
  if (mode === "restricted" && input.restrictedTools !== undefined && input.restrictedTools.length > 0) {
    // Claude Code 2.1.185 accepts this equals/comma form on the noninteractive --print path.
    permissionArgs.push(`--allowedTools=${input.restrictedTools.join(",")}`);
  }

  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(input.sessionPersistence === "ephemeral" ? ["--no-session-persistence"] : []),
    ...(input.resumeSessionId !== undefined ? ["--resume", input.resumeSessionId] : ["--agent", input.agent]),
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(input.generatedPlugin?.pluginDir !== undefined ? ["--plugin-dir", input.generatedPlugin.pluginDir] : []),
    ...(input.outputSchema !== undefined ? ["--json-schema", JSON.stringify(input.outputSchema)] : []),
    ...permissionArgs,
    input.prompt,
  ];
};

export const runClaudeWorkflowTask = async (
  task: AnyWorkflowTask,
  options: ClaudeWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const sessionPersistence = options.sessionPersistence ?? "persistent";
  if (sessionPersistence === "ephemeral" && options.repair?.mode === "native-continuation") {
    throw new ClaudeWorkflowWorkerError(
      "ephemeral Claude Code workflow tasks cannot use native session continuation",
      { adapter: "claude-code", sessionPersistence },
    );
  }
  const command = options.bin ?? process.env.PRISM_WORKFLOW_CLAUDE_BIN ?? "claude";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_CLAUDE_PROCESS_TIMEOUT_MS);
  const resumeSessionId = options.repair?.mode === "native-continuation"
    ? options.repair.continuation.sessionId
    : undefined;
  const prompt = options.repair?.mode === "native-continuation"
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const generatedPlugin = discoverClaudeGeneratedPlugin(task);
  const outputSchema = tryWorkflowJsonSchemaFromEffectSchema(task.output);
  const args = buildClaudeArgs({
    agent: task.agent.name,
    model: options.model,
    generatedPlugin,
    outputSchema,
    prompt,
    ...(sessionPersistence === "ephemeral"
      ? { sessionPersistence }
      : { sessionPersistence, ...(resumeSessionId !== undefined ? { resumeSessionId } : {}) }),
    permission: options.resolvedPermission,
    restrictedTools: options.restrictedTools,
  });

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
    onOutputActivity: (stream) => options.reportProgress?.(`worker-${stream}`),
  });
  const failureMetadata = (): Record<string, unknown> => workflowWorkerFailureMetadata({
    adapter: "claude-code",
    stderr,
    sessionPersistence,
    ...(sessionPersistence === "persistent"
      ? { sessionId: claudeFailureSessionId(stdout, resumeSessionId) }
      : {}),
  });
  if (aborted) {
    throw new ClaudeWorkflowWorkerError(
      "claude was aborted by Prism workflow stop",
      failureMetadata(),
    );
  }
  if (timedOut) {
    throw new ClaudeWorkflowWorkerError(
      `claude exceeded Prism process timeout after ${processTimeoutMs}ms`,
      failureMetadata(),
    );
  }
  if (exitCode !== 0) {
    throw new ClaudeWorkflowWorkerError(
      `claude exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      failureMetadata(),
    );
  }

  let claudeStream: ClaudeStreamSummary;
  try {
    claudeStream = parseClaudeStream(stdout);
  } catch (error) {
    if (error instanceof ClaudeWorkflowWorkerError) {
      throw new ClaudeWorkflowWorkerError(
        error.message,
        failureMetadata(),
      );
    }
    throw error;
  }
  const { envelope, toolCallNames } = claudeStream;
  if (envelope.is_error !== undefined && envelope.is_error !== false) {
    throw new ClaudeWorkflowWorkerError(
      `claude returned an error: ${typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result)}`,
      workflowWorkerFailureMetadata({
        adapter: "claude-code",
        stderr,
        sessionPersistence,
        ...(sessionPersistence === "persistent"
          ? { sessionId: envelope.session_id ?? resumeSessionId }
          : {}),
      }),
    );
  }
  const sessionId = sessionPersistence === "persistent"
    ? envelope.session_id ?? resumeSessionId
    : undefined;
  return {
    output: claudeEnvelopeOutput(envelope),
    metadata: {
      adapter: "claude-code",
      nativeAgent: task.agent.name,
      model: options.model,
      durationMs,
      processTimeoutMs,
      sessionPersistence,
      ...summarizeWorkflowWorkerStderrForSession(stderr, sessionPersistence),
      ...(sessionId !== undefined ? { sessionId } : {}),
      claudeDurationMs: envelope.duration_ms,
      totalCostUsd: envelope.total_cost_usd,
      numTurns: envelope.num_turns,
      claudeToolCallNames: toolCallNames,
      claudeNativeOutputSchema: outputSchema !== undefined,
      ...(options.repair !== undefined
        ? {
          repairExecution: {
            attempt: options.repair.attempt,
            criterion: options.repair.criterion,
            mode: options.repair.mode,
            ...(options.repair.mode === "native-continuation"
              ? { continuation: options.repair.continuation }
              : { fallbackReason: options.repair.fallbackReason }),
          },
        }
        : {}),
    },
  };
};
