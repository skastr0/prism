import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr, workflowWorkerFailureMetadata } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskProgressReporter, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";

export type HermesWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
} & WorkflowTaskRepairLoopOption<"hermes">;

export class HermesWorkflowWorkerError extends Error {
  override readonly name = "HermesWorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

const hermesSessionId = (stderr: string): string | undefined => {
  const match = stderr.match(/\bsession_id:\s*([^\s]+)/u);
  return match?.[1];
};

const assertHermesPermission = (mode: WorkflowPermissionMode): void => {
  switch (mode) {
    case "legacy":
    case "permissive":
    case "full-access":
      return;
    case "restricted":
      throw new WorkflowPermissionError(
        "hermes",
        mode,
        "Hermes has no CLI flag to restrict permissions per invocation. Permission restriction is config-scoped (approvals.mode, permissions.allow/deny in config.yaml), not a runtime override. Choose 'legacy' or 'permissive' instead.",
      );
    case "interactive":
      throw new WorkflowPermissionError(
        "hermes",
        mode,
        "Hermes interactive mode is incompatible with Prism workflow execution. Non-interactive chat (-q) cannot complete interactive approval prompts. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-read-only":
      throw new WorkflowPermissionError(
        "hermes",
        mode,
        "Hermes has no read-only sandbox CLI flag. Read-only isolation would require terminal.backend/docker image policy changes outside per-task argv mapping. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-workspace-write":
      throw new WorkflowPermissionError(
        "hermes",
        mode,
        "Hermes has no workspace-write sandbox mode on chat. Docker terminal backend is a persistent sandbox boundary configured in config.yaml, not a per-workflow-task spawn argument. Choose 'permissive' or 'legacy' instead.",
      );
  }
  return assertNeverWorkflowPermissionMode("hermes", mode);
};

export const buildHermesArgs = (input: {
  readonly profile?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly prompt: string;
  readonly resumeSessionId?: string;
  readonly permission?: WorkflowPermissionMode;
}): ReadonlyArray<string> => {
  const mode = input.permission ?? "permissive";
  assertHermesPermission(mode);
  const permissionArgs: string[] = mode === "permissive" || mode === "full-access" ? ["--yolo"] : [];
  return [
    ...(input.profile !== undefined ? ["--profile", input.profile] : []),
    "chat",
    ...(input.resumeSessionId !== undefined ? ["--resume", input.resumeSessionId] : []),
    "--query",
    input.prompt,
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(input.provider !== undefined ? ["--provider", input.provider] : []),
    // Programmatic output: without -Q the TUI renderer line-wraps the final
    // response inside 80-col boxes, corrupting JSON mid-string before the
    // worker's extractor sees it.
    "-Q",
    ...permissionArgs,
  ];
};

export const runHermesWorkflowTask = async (
  task: AnyWorkflowTask,
  options: HermesWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_HERMES_BIN ?? "hermes";
  const resumeSessionId = options.repair?.mode === "native-continuation" ? options.repair.continuation.sessionId : undefined;
  const prompt = options.repair !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_HERMES_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const args = buildHermesArgs({
    profile: options.profile,
    model: options.model,
    provider: options.provider,
    prompt,
    resumeSessionId,
    permission: options.resolvedPermission,
  });

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
    onOutputActivity: (stream) => options.reportProgress?.(`worker-${stream}`),
  });
  if (aborted) {
    throw new HermesWorkflowWorkerError(
      "hermes was aborted by Prism workflow stop",
      workflowWorkerFailureMetadata({ adapter: "hermes", stderr, sessionId: hermesSessionId(stderr) ?? resumeSessionId }),
    );
  }
  if (timedOut) {
    throw new HermesWorkflowWorkerError(
      `hermes exceeded Prism process timeout after ${processTimeoutMs}ms`,
      workflowWorkerFailureMetadata({ adapter: "hermes", stderr, sessionId: hermesSessionId(stderr) ?? resumeSessionId }),
    );
  }
  if (exitCode !== 0) {
    throw new HermesWorkflowWorkerError(
      `hermes exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      workflowWorkerFailureMetadata({ adapter: "hermes", stderr, sessionId: hermesSessionId(stderr) ?? resumeSessionId }),
    );
  }
  return {
    output: parseWorkflowWorkerJsonOutput(stdout),
    metadata: {
      adapter: "hermes",
      prompted: options.profile === undefined,
      agentSelection: options.profile === undefined ? "prompted-contract" : "profile",
      source: "prism-workflow",
      profile: options.profile,
      agent: {
        plugin: task.agent.plugin,
        name: task.agent.name,
        manifestHash: task.agent.manifestHash,
      },
      model: options.model,
      provider: options.provider,
      durationMs,
      processTimeoutMs,
      sessionId: hermesSessionId(stderr) ?? resumeSessionId,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
