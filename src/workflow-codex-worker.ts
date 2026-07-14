import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr, workflowWorkerFailureMetadata } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import { tryWorkflowJsonSchemaFromEffectSchema } from "./workflow-output-schema.js";
import type { WorkflowTaskExecution, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";
import { stableSessionIdFromJsonLines, stableSessionIdFromRecordKeys, stableSessionIdFromRegex } from "./workflow-session.js";

export type CodexWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
} & WorkflowTaskRepairLoopOption<"codex-cli">;

export class CodexWorkflowWorkerError extends Error {
  override readonly name = "CodexWorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

const assertCodexPermission = (mode: WorkflowPermissionMode): void => {
  switch (mode) {
    case "legacy":
    case "permissive":
    case "full-access":
    case "sandbox-read-only":
    case "sandbox-workspace-write":
      return;
    case "restricted":
      throw new WorkflowPermissionError(
        "codex-cli",
        mode,
        "Codex CLI restricted mode requires a specific --sandbox mode. Use 'sandbox-read-only', 'sandbox-workspace-write', or 'permissive' instead.",
      );
    case "interactive":
      throw new WorkflowPermissionError(
        "codex-cli",
        mode,
        "Codex CLI interactive mode is incompatible with Prism workflow execution. Choose 'permissive' or 'legacy' instead.",
      );
  }
  return assertNeverWorkflowPermissionMode("codex-cli", mode);
};

const codexPermissionArgs = (mode: WorkflowPermissionMode): ReadonlyArray<string> => {
  switch (mode) {
    case "legacy":
      return ["--sandbox", "workspace-write"];
    case "permissive":
    case "full-access":
      return ["--dangerously-bypass-approvals-and-sandbox"];
    case "sandbox-read-only":
      return ["--sandbox", "read-only"];
    case "sandbox-workspace-write":
      return ["--sandbox", "workspace-write"];
    case "restricted":
    case "interactive":
      throw new WorkflowPermissionError(
        "codex-cli",
        mode,
        `Codex CLI permission mode '${mode}' is not mapped to argv`,
      );
    default:
      return assertNeverWorkflowPermissionMode("codex-cli", mode);
  }
};

export const buildCodexArgs = (input: {
  readonly cwd: string;
  readonly model?: string;
  readonly variant?: string;
  readonly outputSchemaPath?: string;
  readonly outputPath: string;
  readonly prompt: string;
  readonly resumeSessionId?: string;
  readonly permission?: WorkflowPermissionMode;
}): ReadonlyArray<string> => {
  const mode = input.permission ?? "permissive";
  assertCodexPermission(mode);
  return [
    "exec",
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(input.variant !== undefined
      ? ["--config", `model_reasoning_effort=${JSON.stringify(input.variant)}`]
      : []),
    "--cd",
    input.cwd,
    ...codexPermissionArgs(mode),
    ...(input.outputSchemaPath !== undefined ? ["--output-schema", input.outputSchemaPath] : []),
    "--output-last-message",
    input.outputPath,
    ...(input.resumeSessionId !== undefined ? ["resume", input.resumeSessionId] : []),
    input.prompt,
  ];
};

export const codexSessionId = (stdout: string, stderr: string): string | undefined => {
  const text = `${stdout}\n${stderr}`;
  const jsonId = stableSessionIdFromJsonLines(text, ["sessionId", "sessionID", "session_id"]);
  if (jsonId !== undefined) return jsonId;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const metaId = stableSessionIdFromRecordKeys(parsed, ["id"]);
      if (
        metaId !== undefined &&
        typeof (parsed as { readonly type?: unknown }).type === "string" &&
        (parsed as { readonly type?: unknown }).type === "session_meta"
      ) {
        return metaId;
      }
    } catch {
      // Ignore non-JSON logging lines.
    }
  }
  return stableSessionIdFromRegex(text, [
    /\bsession[_\s-]*id["':=\s]+([A-Za-z0-9._:-]+)/iu,
    /\bconversation[_\s-]*id["':=\s]+([A-Za-z0-9._:-]+)/iu,
  ]);
};

export const runCodexWorkflowTask = async (
  task: AnyWorkflowTask,
  options: CodexWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-workflow-codex-"));
  const outputPath = join(tempRoot, "last-message.txt");
  const outputSchema = tryWorkflowJsonSchemaFromEffectSchema(task.output);
  const outputSchemaPath = outputSchema === undefined ? undefined : join(tempRoot, "output-schema.json");
  const command = options.bin ?? process.env.PRISM_WORKFLOW_CODEX_BIN ?? "codex";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_CODEX_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const resumeSessionId = options.repair?.mode === "native-continuation" ? options.repair.continuation.sessionId : undefined;
  const prompt = options.repair !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const args = buildCodexArgs({
    cwd: options.cwd,
    model: options.model,
    variant: options.variant,
    outputSchemaPath,
    outputPath,
    prompt,
    resumeSessionId,
    permission: options.resolvedPermission,
  });

  try {
    if (outputSchemaPath !== undefined) {
      await writeFile(outputSchemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, "utf8");
    }
    const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
      command,
      args,
      cwd: options.cwd,
      processTimeoutMs,
      abortSignal: options.abortSignal,
    });
    if (aborted) {
      throw new CodexWorkflowWorkerError(
        "codex was aborted by Prism workflow stop",
        workflowWorkerFailureMetadata({ adapter: "codex-cli", stderr, sessionId: codexSessionId(stdout, stderr) ?? resumeSessionId }),
      );
    }
    if (timedOut) {
      throw new CodexWorkflowWorkerError(
        `codex exceeded Prism process timeout after ${processTimeoutMs}ms`,
        workflowWorkerFailureMetadata({ adapter: "codex-cli", stderr, sessionId: codexSessionId(stdout, stderr) ?? resumeSessionId }),
      );
    }
    if (exitCode !== 0) {
      throw new CodexWorkflowWorkerError(
        `codex exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
        workflowWorkerFailureMetadata({ adapter: "codex-cli", stderr, sessionId: codexSessionId(stdout, stderr) ?? resumeSessionId }),
      );
    }
    const outputText = await readFile(outputPath, "utf8").catch((cause) => {
      throw new CodexWorkflowWorkerError(
        `codex did not write --output-last-message: ${cause instanceof Error ? cause.message : String(cause)}`,
        workflowWorkerFailureMetadata({ adapter: "codex-cli", stderr, sessionId: codexSessionId(stdout, stderr) ?? resumeSessionId }),
      );
    });
    return {
      output: parseWorkflowWorkerJsonOutput(outputText),
      metadata: {
        adapter: "codex-cli",
        model: options.model,
        modelVariant: options.variant,
        durationMs,
        processTimeoutMs,
        sessionId: codexSessionId(stdout, stderr) ?? resumeSessionId,
        codexNativeOutputSchema: outputSchemaPath !== undefined,
        ...summarizeWorkflowWorkerStderr(stderr),
      },
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};
