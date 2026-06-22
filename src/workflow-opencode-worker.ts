import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";
import { stableSessionIdFromJsonLines, stableSessionIdFromRegex } from "./workflow-session.js";

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
    ...(input.sessionId !== undefined ? ["-s", input.sessionId] : []),
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...permissionArgs,
    input.prompt,
  ];
};

export const openCodeSessionId = (stdout: string, stderr: string): string | undefined =>
  stableSessionIdFromJsonLines(`${stdout}\n${stderr}`, ["sessionID", "sessionId", "session_id"])
    ?? stableSessionIdFromRegex(`${stdout}\n${stderr}`, [
      /\bsessionID["':=\s]+([A-Za-z0-9._:-]+)/u,
      /\bsession[_\s-]*id["':=\s]+([A-Za-z0-9._:-]+)/iu,
    ]);

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
    throw new OpenCodeWorkflowWorkerError("opencode was aborted by Prism workflow stop");
  }
  if (timedOut) {
    throw new OpenCodeWorkflowWorkerError(`opencode exceeded Prism process timeout after ${processTimeoutMs}ms`);
  }
  if (exitCode !== 0) {
    throw new OpenCodeWorkflowWorkerError(`opencode exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return {
    output: parseWorkflowWorkerJsonOutput(stdout),
    metadata: {
      adapter: "opencode-cli",
      nativeAgent: task.agent.name,
      model: options.model,
      durationMs,
      processTimeoutMs,
      sessionId: openCodeSessionId(stdout, stderr) ?? sessionId,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
