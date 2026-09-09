import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatedCursorPluginId } from "./compile/generated-plugin.js";
import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import {
  summarizeWorkflowWorkerStderrForSession,
  workflowWorkerFailureMetadata,
} from "./workflow-worker-metadata.js";
import { runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskProgressReporter, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";
import { stableSessionIdFromJsonLines } from "./workflow-session.js";

export type CursorWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
} & WorkflowTaskRepairLoopOption<"cursor">;

export class CursorWorkflowWorkerError extends Error {
  override readonly name = "CursorWorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

const cursorRoot = (): string => join(homedir(), ".cursor");

export interface CursorGeneratedPluginDiscovery {
  readonly pluginDir?: string;
}

export const discoverCursorGeneratedPlugin = (
  task: AnyWorkflowTask,
): CursorGeneratedPluginDiscovery => {
  const pluginDir = join(cursorRoot(), "plugins", "local", generatedCursorPluginId(task.agent.plugin));
  if (!existsSync(pluginDir)) return {};
  return { pluginDir };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface CursorJsonEnvelope {
  readonly result?: unknown;
  readonly is_error?: boolean;
  readonly session_id?: string;
  readonly duration_ms?: number;
}

interface CursorStreamSummary {
  readonly envelope: CursorJsonEnvelope;
  readonly toolCallCount: number;
}

const parseCursorJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch (cause) {
    throw new CursorWorkflowWorkerError(
      `cursor agent returned invalid JSON envelope: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

const parseCursorStream = (stdout: string): CursorStreamSummary => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new CursorWorkflowWorkerError("cursor agent returned empty JSON stream");
  }

  const lines = trimmed.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  let envelope: CursorJsonEnvelope | undefined;
  let toolCallCount = 0;

  const consider = (parsed: unknown): void => {
    if (!isRecord(parsed)) return;
    if (parsed.type === "tool_call") toolCallCount += 1;
    if (parsed.type === "result") envelope = parsed as CursorJsonEnvelope;
  };

  if (lines.length === 1 && trimmed.startsWith("{") && !trimmed.includes("\n")) {
    consider(parseCursorJsonLine(trimmed));
  } else {
    for (const line of lines) {
      if (!line.startsWith("{") && !line.startsWith("[")) continue;
      consider(parseCursorJsonLine(line));
    }
  }

  if (envelope === undefined) {
    throw new CursorWorkflowWorkerError("cursor agent JSON stream did not contain a result event");
  }
  return { envelope, toolCallCount };
};

const cursorEnvelopeOutput = (envelope: CursorJsonEnvelope): unknown => {
  if (typeof envelope.result !== "string") {
    throw new CursorWorkflowWorkerError("cursor agent JSON envelope did not contain a string result");
  }
  return parseWorkflowWorkerJsonOutput(envelope.result);
};

export const cursorSessionIdFromStream = (stdout: string): string | undefined =>
  stableSessionIdFromJsonLines(stdout, ["session_id", "sessionId", "sessionID"]);

const assertCursorPermission = (mode: WorkflowPermissionMode): void => {
  switch (mode) {
    case "legacy":
    case "permissive":
    case "full-access":
    case "sandbox-workspace-write":
      return;
    case "sandbox-read-only":
      throw new WorkflowPermissionError(
        "cursor",
        mode,
        "Cursor Agent CLI sandbox is enabled/disabled (workspace write), not read-only. Choose 'legacy', 'permissive', or 'sandbox-workspace-write'.",
      );
    case "restricted":
      throw new WorkflowPermissionError(
        "cursor",
        mode,
        "Cursor Agent CLI has no per-invocation tool allowlist flag. Use cli-config.json permissions or choose 'legacy', 'permissive', or 'sandbox-workspace-write'.",
      );
    case "interactive":
      throw new WorkflowPermissionError(
        "cursor",
        mode,
        "Cursor Agent interactive mode is incompatible with Prism workflow execution. Spawning without --print blocks the process. Choose 'permissive' or 'legacy' instead.",
      );
  }
  return assertNeverWorkflowPermissionMode("cursor", mode);
};

export const buildCursorArgs = (input: {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly resumeSessionId?: string;
  readonly generatedPlugin?: CursorGeneratedPluginDiscovery;
  readonly permission?: WorkflowPermissionMode;
}): ReadonlyArray<string> => {
  const mode = input.permission ?? "permissive";
  assertCursorPermission(mode);

  const permissionArgs: string[] = [];
  if (mode === "permissive" || mode === "full-access" || mode === "sandbox-workspace-write") {
    permissionArgs.push("--force");
  }
  if (mode === "full-access") {
    permissionArgs.push("--approve-mcps");
  }
  if (mode === "sandbox-workspace-write") {
    permissionArgs.push("--sandbox", "enabled");
  }

  return [
    "--print",
    "--output-format",
    "stream-json",
    "--trust",
    "--workspace",
    input.cwd,
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(input.resumeSessionId !== undefined ? ["--resume", input.resumeSessionId] : []),
    ...(input.generatedPlugin?.pluginDir !== undefined
      ? ["--plugin-dir", input.generatedPlugin.pluginDir]
      : []),
    ...permissionArgs,
    input.prompt,
  ];
};

export const runCursorWorkflowTask = async (
  task: AnyWorkflowTask,
  options: CursorWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_CURSOR_BIN ?? "agent";
  const resumeSessionId = options.repair?.mode === "native-continuation"
    ? options.repair.continuation.sessionId
    : undefined;
  const prompt = options.repair?.mode === "native-continuation"
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `You are assigned the Prism agent ${task.agent.plugin}.${task.agent.name} role. ${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const generatedPlugin = discoverCursorGeneratedPlugin(task);
  const args = buildCursorArgs({
    prompt,
    cwd: options.cwd,
    model: options.model,
    generatedPlugin,
    permission: options.resolvedPermission,
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
  });

  const { exitCode, stdout, stderr, durationMs, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    onOutputActivity: (stream) => options.reportProgress?.(`worker-${stream}`),
  });
  const failureMetadata = (): Record<string, unknown> => workflowWorkerFailureMetadata({
    adapter: "cursor",
    stderr,
    sessionId: cursorSessionIdFromStream(stdout) ?? resumeSessionId,
  });
  if (aborted) {
    throw new CursorWorkflowWorkerError(
      "cursor agent was aborted by Prism workflow stop",
      failureMetadata(),
    );
  }
  if (exitCode !== 0) {
    throw new CursorWorkflowWorkerError(
      `cursor agent exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      failureMetadata(),
    );
  }

  let cursorStream: CursorStreamSummary;
  try {
    cursorStream = parseCursorStream(stdout);
  } catch (error) {
    if (error instanceof CursorWorkflowWorkerError) {
      throw new CursorWorkflowWorkerError(error.message, failureMetadata());
    }
    throw error;
  }
  const { envelope, toolCallCount } = cursorStream;
  if (envelope.is_error !== undefined && envelope.is_error !== false) {
    throw new CursorWorkflowWorkerError(
      `cursor agent returned an error: ${typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result)}`,
      failureMetadata(),
    );
  }
  const sessionId = envelope.session_id ?? resumeSessionId;
  return {
    output: cursorEnvelopeOutput(envelope),
    metadata: {
      adapter: "cursor",
      prompted: true,
      agentSelection: "prompted-contract",
      source: "prism-workflow",
      nativeAgent: task.agent.name,
      agent: {
        plugin: task.agent.plugin,
        name: task.agent.name,
        manifestHash: task.agent.manifestHash,
      },
      model: options.model,
      durationMs,
      ...summarizeWorkflowWorkerStderrForSession(stderr, "persistent"),
      ...(sessionId !== undefined ? { sessionId } : {}),
      cursorDurationMs: envelope.duration_ms,
      cursorToolCallCount: toolCallCount,
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
