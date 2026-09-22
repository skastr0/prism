import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, expandPath } from "./fs.js";
import type {
  AnyWorkflowWorkerTask,
  WorkflowPermissionMode,
  WorkflowSessionPersistence,
} from "./workflows.js";
import {
  parseWorkflowWorkerJsonOutput,
  workflowWorkerJsonInstruction,
} from "./workflow-worker-contract.js";
import {
  summarizeWorkflowWorkerStderrForSession,
  workflowWorkerFailureMetadata,
} from "./workflow-worker-metadata.js";
import {
  parsePositiveInteger,
  runWorkflowWorkerProcess,
} from "./workflow-worker-process.js";
import {
  assertNeverWorkflowPermissionMode,
  WorkflowPermissionError,
} from "./workflow-permissions.js";
import type {
  WorkflowTaskExecution,
  WorkflowTaskProgressReporter,
  WorkflowTaskRepairLoopOption,
} from "./workflow-runner.js";

export type OmpWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly effort?: string;
  readonly sessionPersistence?: WorkflowSessionPersistence;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
} & WorkflowTaskRepairLoopOption<"omp">;

export class OmpWorkflowWorkerError extends Error {
  override readonly name = "OmpWorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

/** Console Go selectors 400 in workflow `--print` (no `x-opencode-session`). */
export const OMP_CONSOLE_GO_PREFIX = "opencode-go/";

export const ompConsoleGoPinError = (model: string): string =>
  `OMP worker.model ${JSON.stringify(model)} is Console Go. Workflow --print has no x-opencode-session and the provider returns 400 MissingSessionID. Pin a non-opencode-go selector from \`prism workflow models --worker omp\`.`;

export const assertOmpWorkflowModel = (model: string | undefined): void => {
  if (model === undefined || !model.startsWith(OMP_CONSOLE_GO_PREFIX)) return;
  throw new OmpWorkflowWorkerError(ompConsoleGoPinError(model), { adapter: "omp-cli" });
};

const assertOmpPermission = (mode: WorkflowPermissionMode): void => {
  switch (mode) {
    case "legacy":
    case "permissive":
    case "restricted":
    case "full-access":
      return;
    case "interactive":
      throw new WorkflowPermissionError(
        "omp",
        mode,
        "OMP interactive approval prompts are incompatible with Prism workflow execution. Choose 'restricted', 'permissive', 'full-access', or 'legacy' instead.",
      );
    case "sandbox-read-only":
      throw new WorkflowPermissionError(
        "omp",
        mode,
        "OMP has no read-only process sandbox flag. Apply host-level isolation outside the harness or choose 'restricted' with a read-only tool allowlist.",
      );
    case "sandbox-workspace-write":
      throw new WorkflowPermissionError(
        "omp",
        mode,
        "OMP has no workspace-write process sandbox flag. Apply host-level isolation outside the harness or choose 'restricted' with an explicit tool allowlist.",
      );
  }
  return assertNeverWorkflowPermissionMode("omp", mode);
};

type OmpWorkflowSessionArgs =
  | {
    readonly sessionPersistence?: "persistent";
    readonly sessionId?: string;
  }
  | {
    readonly sessionPersistence: "ephemeral";
    readonly sessionId?: never;
  };

export const buildOmpArgs = (input: {
  readonly cwd: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly effort?: string;
  readonly prompt: string;
  readonly permission?: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
} & OmpWorkflowSessionArgs): ReadonlyArray<string> => {
  const permission = input.permission ?? "permissive";
  assertOmpPermission(permission);
  const permissionArgs =
    permission === "permissive" || permission === "full-access"
      ? ["--approval-mode", "yolo"]
      : permission === "restricted"
        ? input.restrictedTools !== undefined && input.restrictedTools.length > 0
          ? ["--approval-mode", "yolo", "--tools", input.restrictedTools.join(",")]
          : ["--approval-mode", "yolo", "--no-tools"]
        : [];

  return [
    "--mode",
    "json",
    "--print",
    "--cwd",
    input.cwd,
    "--no-title",
    ...(input.sessionPersistence === "ephemeral" ? ["--no-session"] : []),
    ...(input.profile !== undefined ? ["--profile", input.profile] : []),
    ...(input.provider !== undefined ? ["--provider", input.provider] : []),
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(input.effort !== undefined ? ["--thinking", input.effort] : []),
    ...(input.sessionId !== undefined ? ["--resume", input.sessionId] : []),
    ...permissionArgs,
    "--",
    input.prompt,
  ];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textFromMessage = (value: unknown): string | undefined => {
  if (!isRecord(value) || value.role !== "assistant") return undefined;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return undefined;

  const parts: string[] = [];
  for (const item of value.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
};

const errorFromMessage = (value: unknown): string | undefined => {
  if (!isRecord(value) || value.role !== "assistant") return undefined;
  if (typeof value.errorMessage === "string" && value.errorMessage.trim().length > 0) {
    return value.errorMessage.trim();
  }
  return undefined;
};

export interface OmpJsonStreamResult {
  readonly sessionId?: string;
  readonly text: string;
  readonly error?: string;
}

export const parseOmpJsonStream = (stdout: string): OmpJsonStreamResult => {
  let sessionId: string | undefined;
  let finalText: string | undefined;
  let fallbackText: string | undefined;
  let error: string | undefined;
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

    if (
      event.type === "session" &&
      sessionId === undefined &&
      typeof event.id === "string" &&
      event.id.length > 0
    ) {
      sessionId = event.id;
    }
    if (event.type === "message_end") {
      const messageText = textFromMessage(event.message);
      if (messageText !== undefined) finalText = messageText;
      error = errorFromMessage(event.message) ?? error;
    }
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      for (const message of event.messages) {
        const messageText = textFromMessage(message);
        if (messageText !== undefined) fallbackText = messageText;
        error = errorFromMessage(message) ?? error;
      }
    }
  }

  const text = finalText ?? fallbackText ?? (sawEvent ? "" : stdout);
  return {
    text,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(error !== undefined ? { error } : {}),
  };
};

export const runOmpWorkflowTask = async (
  task: AnyWorkflowWorkerTask,
  options: OmpWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  assertOmpWorkflowModel(options.model);
  const sessionPersistence = options.sessionPersistence ?? "persistent";
  if (sessionPersistence === "ephemeral" && options.repair?.mode === "native-continuation") {
    throw new OmpWorkflowWorkerError(
      "ephemeral OMP workflow tasks cannot use native session continuation",
      { adapter: "omp-cli", sessionPersistence },
    );
  }
  const command = options.bin ?? process.env.PRISM_WORKFLOW_OMP_BIN ?? "omp";
  const sessionId =
    options.repair?.mode === "native-continuation"
      ? options.repair.continuation.sessionId
      : undefined;
  const prompt = options.repair?.mode === "native-continuation"
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  {
    const args = buildOmpArgs({
      cwd: options.cwd,
      model: options.model,
      provider: options.provider,
      profile: options.profile,
      effort: options.effort,
      prompt,
      ...(sessionPersistence === "ephemeral"
        ? { sessionPersistence }
        : { sessionPersistence, ...(sessionId !== undefined ? { sessionId } : {}) }),
      permission: options.resolvedPermission,
      restrictedTools: options.restrictedTools,
    });

    const { exitCode, stdout, stderr, durationMs, aborted } =
      await runWorkflowWorkerProcess({
        command,
        args,
        cwd: options.cwd,
        abortSignal: options.abortSignal,
        onOutputActivity: (stream) => options.reportProgress?.(`worker-${stream}`),
      });
    const failureSessionId = sessionPersistence === "persistent"
      ? parseOmpJsonStream(stdout).sessionId ?? sessionId
      : undefined;
    const failureMetadata = (): Record<string, unknown> => workflowWorkerFailureMetadata({
      adapter: "omp-cli",
      stderr,
      sessionPersistence,
      ...(failureSessionId !== undefined ? { sessionId: failureSessionId } : {}),
    });
    if (aborted) {
      throw new OmpWorkflowWorkerError(
        "omp was aborted by Prism workflow stop",
        failureMetadata(),
      );
    }
    if (exitCode !== 0) {
      throw new OmpWorkflowWorkerError(
        `omp exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
        failureMetadata(),
      );
    }

    const stream = parseOmpJsonStream(stdout);
    if (stream.error !== undefined) {
      throw new OmpWorkflowWorkerError(
        `omp provider error: ${stream.error}`,
        failureMetadata(),
      );
    }
    if (stream.text.trim().length === 0) {
      throw new OmpWorkflowWorkerError(
        "omp finished without an assistant message",
        failureMetadata(),
      );
    }
    const resultSessionId = sessionPersistence === "persistent"
      ? sessionId ?? stream.sessionId
      : undefined;
    return {
      output: parseWorkflowWorkerJsonOutput(stream.text),
      metadata: {
        adapter: "omp-cli",
        model: options.model,
        durationMs,
        sessionPersistence,
        ...(resultSessionId !== undefined ? { sessionId: resultSessionId } : {}),
        ...summarizeWorkflowWorkerStderrForSession(stderr, sessionPersistence),
      },
    };
  }
};
