import { join } from "node:path";
import { exists, expandPath } from "./fs.js";
import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import {
  parseWorkflowWorkerJsonOutput,
  workflowWorkerJsonInstruction,
} from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr, workflowWorkerFailureMetadata } from "./workflow-worker-metadata.js";
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
  readonly thinking?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
  readonly processTimeoutMs?: number;
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

export const buildOmpArgs = (input: {
  readonly cwd: string;
  readonly systemPromptPath: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly thinking?: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly permission?: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
}): ReadonlyArray<string> => {
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
    "--cwd",
    input.cwd,
    "--append-system-prompt",
    input.systemPromptPath,
    "--no-title",
    ...(input.profile !== undefined ? ["--profile", input.profile] : []),
    ...(input.provider !== undefined ? ["--provider", input.provider] : []),
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(input.thinking !== undefined ? ["--thinking", input.thinking] : []),
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

export interface OmpJsonStreamResult {
  readonly sessionId?: string;
  readonly text: string;
}

export const parseOmpJsonStream = (stdout: string): OmpJsonStreamResult => {
  let sessionId: string | undefined;
  let finalText: string | undefined;
  let fallbackText: string | undefined;
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
    }
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      for (const message of event.messages) {
        const messageText = textFromMessage(message);
        if (messageText !== undefined) fallbackText = messageText;
      }
    }
  }

  const text = finalText ?? fallbackText ?? (sawEvent ? "" : stdout);
  return sessionId !== undefined ? { sessionId, text } : { text };
};

const resolveInstalledAgentPrompt = async (
  cwd: string,
  agentName: string,
): Promise<string> => {
  const candidates = [
    join(expandPath(cwd), ".omp", "agents", `${agentName}.md`),
    join(expandPath("~/.omp/agent"), "agents", `${agentName}.md`),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new OmpWorkflowWorkerError(
    `compiled OMP agent '${agentName}' is not installed. Expected ${candidates.join(" or ")}. Run prism refresh <plugin> --harness omp for this project or globally before running the workflow.`,
  );
};

export const runOmpWorkflowTask = async (
  task: AnyWorkflowTask,
  options: OmpWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_OMP_BIN ?? "omp";
  const sessionId =
    options.repair?.mode === "native-continuation"
      ? options.repair.continuation.sessionId
      : undefined;
  const prompt = options.repair !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const processTimeoutMs =
    options.processTimeoutMs ??
    parsePositiveInteger(process.env.PRISM_WORKFLOW_OMP_PROCESS_TIMEOUT_MS) ??
    180_000;
  const systemPromptPath = await resolveInstalledAgentPrompt(options.cwd, task.agent.name);
  const args = buildOmpArgs({
    cwd: options.cwd,
    systemPromptPath,
    model: options.model,
    provider: options.provider,
    profile: options.profile,
    thinking: options.thinking,
    prompt,
    sessionId,
    permission: options.resolvedPermission,
    restrictedTools: options.restrictedTools,
  });

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } =
    await runWorkflowWorkerProcess({
      command,
      args,
      cwd: options.cwd,
      processTimeoutMs,
      abortSignal: options.abortSignal,
      onOutputActivity: (stream) => options.reportProgress?.(`worker-${stream}`),
    });
  if (aborted) {
    throw new OmpWorkflowWorkerError(
      "omp was aborted by Prism workflow stop",
      workflowWorkerFailureMetadata({ adapter: "omp-cli", stderr, sessionId: parseOmpJsonStream(stdout).sessionId ?? sessionId }),
    );
  }
  if (timedOut) {
    throw new OmpWorkflowWorkerError(
      `omp exceeded Prism process timeout after ${processTimeoutMs}ms`,
      workflowWorkerFailureMetadata({ adapter: "omp-cli", stderr, sessionId: parseOmpJsonStream(stdout).sessionId ?? sessionId }),
    );
  }
  if (exitCode !== 0) {
    throw new OmpWorkflowWorkerError(
      `omp exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      workflowWorkerFailureMetadata({ adapter: "omp-cli", stderr, sessionId: parseOmpJsonStream(stdout).sessionId ?? sessionId }),
    );
  }

  const stream = parseOmpJsonStream(stdout);
  return {
    output: parseWorkflowWorkerJsonOutput(stream.text),
    metadata: {
      adapter: "omp-cli",
      nativeAgent: task.agent.name,
      model: options.model,
      durationMs,
      processTimeoutMs,
      sessionId: sessionId ?? stream.sessionId,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
