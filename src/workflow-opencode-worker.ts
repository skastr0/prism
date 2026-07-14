import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr, workflowWorkerFailureMetadata } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";

export type OpenCodeWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
} & WorkflowTaskRepairLoopOption<"opencode">;

export class OpenCodeWorkflowWorkerError extends Error {
  override readonly name = "OpenCodeWorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

const assertOpenCodePermission = (mode: WorkflowPermissionMode): void => {
  switch (mode) {
    case "legacy":
    case "permissive":
    case "full-access":
      return;
    case "restricted":
      throw new WorkflowPermissionError(
        "opencode",
        mode,
        "OpenCode has no CLI flag to restrict permissions beyond the user's config. Restricted mode requires pre-configuring opencode.json with specific 'deny' entries, which is a config-management concern, not a runtime flag. Choose 'legacy' or 'permissive' instead.",
      );
    case "interactive":
      throw new WorkflowPermissionError(
        "opencode",
        mode,
        "OpenCode interactive mode (-i/--interactive) is incompatible with Prism workflow execution. Workflow tasks run headless and cannot participate in interactive prompts. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-read-only":
      throw new WorkflowPermissionError(
        "opencode",
        mode,
        "OpenCode has no --sandbox or read-only execution mode. Apply host-level process isolation (Docker, macOS sandbox-exec) outside the harness. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-workspace-write":
      throw new WorkflowPermissionError(
        "opencode",
        mode,
        "OpenCode has no workspace-write sandbox mode. Apply host-level process isolation outside the harness. Choose 'permissive' or 'legacy' instead.",
      );
  }
  return assertNeverWorkflowPermissionMode("opencode", mode);
};

export const buildOpenCodeArgs = (input: {
  readonly cwd: string;
  readonly agent: string;
  readonly model?: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly permission?: WorkflowPermissionMode;
}): ReadonlyArray<string> => {
  const mode = input.permission ?? "permissive";
  assertOpenCodePermission(mode);
  const permissionArgs: string[] = mode === "permissive" || mode === "full-access" ? ["--dangerously-skip-permissions"] : [];
  return [
    "run",
    "--dir",
    input.cwd,
    "--agent",
    input.agent,
    // `--format json` emits a newline-delimited event stream that carries the session id on
    // every event: the only race-free source for the repair-loop continuation id.
    "--format",
    "json",
    ...(input.sessionId !== undefined ? ["-s", input.sessionId] : []),
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...permissionArgs,
    input.prompt,
  ];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface OpenCodeStreamResult {
  readonly sessionId?: string;
  readonly text: string;
}

/**
 * `opencode run --format json` prints newline-delimited JSON events. Every event carries a
 * top-level `sessionID`; the assistant's contract output arrives as `{type:"text", part:{text}}`
 * events. The session id therefore comes from the run's OWN output: deterministic and
 * race-free, with no `session list` lookup or title heuristic.
 *
 * Fallback: if stdout contains no recognizable events (no object with a string `type`), treat
 * the whole stdout as the assistant text. That covers a downgraded/plain run and leaves no
 * session id, which the runner reads as "no continuation" rather than resuming the wrong session.
 */
const parseOpenCodeJsonStream = (stdout: string): OpenCodeStreamResult => {
  let sessionId: string | undefined;
  const textParts: string[] = [];
  let sawEvent = false;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event) || typeof event.type !== "string") continue;
    sawEvent = true;
    if (sessionId === undefined && typeof event.sessionID === "string" && event.sessionID.length > 0) {
      sessionId = event.sessionID;
    }
    if (event.type === "text" && isRecord(event.part) && typeof event.part.text === "string") {
      textParts.push(event.part.text);
    }
  }
  if (!sawEvent) return { text: stdout };
  return sessionId !== undefined ? { sessionId, text: textParts.join("") } : { text: textParts.join("") };
};

export const runOpenCodeWorkflowTask = async (
  task: AnyWorkflowTask,
  options: OpenCodeWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_OPENCODE_BIN ?? "opencode";
  const sessionId = options.repair?.mode === "native-continuation" ? options.repair.continuation.sessionId : undefined;
  const prompt = options.repair !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_OPENCODE_PROCESS_TIMEOUT_MS)
    ?? 180_000;
  const args = buildOpenCodeArgs({
    cwd: options.cwd,
    agent: task.agent.name,
    model: options.model,
    prompt,
    sessionId,
    permission: options.resolvedPermission,
  });

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
  });
  if (aborted) {
    throw new OpenCodeWorkflowWorkerError(
      "opencode was aborted by Prism workflow stop",
      workflowWorkerFailureMetadata({ adapter: "opencode-cli", stderr, sessionId: parseOpenCodeJsonStream(stdout).sessionId ?? sessionId }),
    );
  }
  if (timedOut) {
    throw new OpenCodeWorkflowWorkerError(
      `opencode exceeded Prism process timeout after ${processTimeoutMs}ms`,
      workflowWorkerFailureMetadata({ adapter: "opencode-cli", stderr, sessionId: parseOpenCodeJsonStream(stdout).sessionId ?? sessionId }),
    );
  }
  if (exitCode !== 0) {
    throw new OpenCodeWorkflowWorkerError(
      `opencode exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      workflowWorkerFailureMetadata({ adapter: "opencode-cli", stderr, sessionId: parseOpenCodeJsonStream(stdout).sessionId ?? sessionId }),
    );
  }

  const stream = parseOpenCodeJsonStream(stdout);
  return {
    output: parseWorkflowWorkerJsonOutput(stream.text),
    metadata: {
      adapter: "opencode-cli",
      nativeAgent: task.agent.name,
      model: options.model,
      durationMs,
      processTimeoutMs,
      sessionId: sessionId ?? stream.sessionId,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
