import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr, workflowWorkerFailureMetadata } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskProgressReporter, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";


export type DevinWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
} & WorkflowTaskRepairLoopOption<"devin">;

export class DevinWorkflowWorkerError extends Error {
  override readonly name = "DevinWorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

const DEVIN_AUTH_OUTPUT_PATTERN =
  /(^|\n)\s*(?:error:\s*)?(?:not authenticated|login required|requires login|run `?devin auth login`?)/iu;

const DEVIN_AUTH_PROMPT_PATTERNS = [
  {
    name: "devin-auth-login-required",
    pattern: DEVIN_AUTH_OUTPUT_PATTERN,
  },
] as const;

export const isDevinAuthOutput = (output: string): boolean =>
  DEVIN_AUTH_OUTPUT_PATTERN.test(output);

const devinAuthErrorMessage =
  "devin requires authentication before workflow run; run `devin auth login`, then retry";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const mapDevinPermissionMode = (
  mode: WorkflowPermissionMode,
): "auto" | "accept-edits" | "smart" | "dangerous" | undefined => {
  switch (mode) {
    case "legacy":
      return undefined;
    case "permissive":
      return "accept-edits";
    case "full-access":
      return "dangerous";
    case "restricted":
      return "auto";
    case "interactive":
      throw new WorkflowPermissionError(
        "devin",
        mode,
        "Devin interactive mode is incompatible with Prism workflow execution. Choose 'permissive' or 'full-access' instead.",
      );
    case "sandbox-read-only":
      throw new WorkflowPermissionError(
        "devin",
        mode,
        "Devin sandbox-read-only is not mapped until OS sandbox semantics are live-proven. Choose 'restricted' (auto) or 'permissive' instead.",
      );
    case "sandbox-workspace-write":
      throw new WorkflowPermissionError(
        "devin",
        mode,
        "Devin sandbox-workspace-write is not mapped until OS sandbox semantics are live-proven. Choose 'permissive' or 'full-access' instead.",
      );
  }
  return assertNeverWorkflowPermissionMode("devin", mode);
};

export const buildDevinArgs = (input: {
  readonly model?: string;
  readonly permission?: WorkflowPermissionMode;
  readonly sessionId?: string;
  readonly promptFilePath: string;
  readonly exportPath: string;
}): ReadonlyArray<string> => {
  const permissionMode = mapDevinPermissionMode(input.permission ?? "permissive");
  return [
    "-p",
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(permissionMode !== undefined ? ["--permission-mode", permissionMode] : []),
    ...(input.sessionId !== undefined ? ["-r", input.sessionId] : []),
    "--prompt-file",
    input.promptFilePath,
    "--export",
    input.exportPath,
  ];
};

const AGENT_STEP_SOURCES = new Set(["agent", "assistant", "model", "llm"]);
const AGENT_ROLES = new Set(["agent", "assistant", "model"]);

const textFromUnknown = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (!isRecord(item)) return undefined;
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
        return undefined;
      })
      .filter((part): part is string => part !== undefined && part.trim().length > 0);
    if (parts.length > 0) return parts.join("");
  }
  if (isRecord(value)) {
    for (const key of ["content", "text", "output", "message"] as const) {
      const nested = textFromUnknown(value[key]);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};

const extractAgentTextFromAtif = (exportJson: unknown): string => {
  if (!isRecord(exportJson)) {
    throw new DevinWorkflowWorkerError("devin ATIF export was not a JSON object");
  }
  const collections = [exportJson.steps, exportJson.messages, exportJson.turns, exportJson.events]
    .filter(Array.isArray);
  if (collections.length === 0) {
    const topLevel = textFromUnknown(exportJson.output ?? exportJson.result ?? exportJson.message);
    if (topLevel !== undefined) return topLevel;
    throw new DevinWorkflowWorkerError("devin ATIF export missing steps array");
  }
  for (const collection of collections) {
    for (let i = collection.length - 1; i >= 0; i -= 1) {
      const step = collection[i];
      if (!isRecord(step)) continue;
      const source = typeof step.source === "string" ? step.source : undefined;
      const role = typeof step.role === "string" ? step.role : undefined;
      if (
        source !== undefined && !AGENT_STEP_SOURCES.has(source)
        && role !== undefined && !AGENT_ROLES.has(role)
      ) continue;
      if (source === undefined && role === undefined) continue;
      const message = textFromUnknown(step.message ?? step);
      if (message !== undefined) return message;
    }
  }
  const topLevel = textFromUnknown(exportJson.output ?? exportJson.result ?? exportJson.message);
  if (topLevel !== undefined) return topLevel;
  throw new DevinWorkflowWorkerError("devin ATIF export did not contain an agent message");
};

const sessionIdFromAtif = (exportJson: unknown): string | undefined => {
  if (!isRecord(exportJson)) return undefined;
  const raw = exportJson.session_id ?? exportJson.sessionId;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
};

// Best-effort session id capture on a failure path (OBS-006): devin may have written a
// partial ATIF export before crashing, or this attempt may already be resuming a known
// session (the repair-loop continuation id). Never throws — an unreadable/absent export
// just falls back to whatever session id the caller already knew, if any.
const bestEffortDevinSessionId = async (
  path: string,
  fallback: string | undefined,
): Promise<string | undefined> => {
  try {
    const exportJson = JSON.parse(await readFile(path, "utf8")) as unknown;
    return sessionIdFromAtif(exportJson) ?? fallback;
  } catch {
    return fallback;
  }
};

export const runDevinWorkflowTask = async (
  task: AnyWorkflowTask,
  options: DevinWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_DEVIN_BIN ?? "devin";
  const sessionId =
    options.repair?.mode === "native-continuation"
      ? options.repair.continuation.sessionId
      : undefined;
  const basePrompt =
    options.repair !== undefined
      ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
      : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;


  const workDir = await mkdtemp(join(tmpdir(), "prism-devin-workflow-"));
  const promptFilePath = join(workDir, "prompt.md");
  const exportPath = join(workDir, "export.atif.json");

  try {
    await writeFile(promptFilePath, basePrompt, "utf8");

    const args = buildDevinArgs({
      model: options.model,
      permission: options.resolvedPermission,
      sessionId,
      promptFilePath,
      exportPath,
    });

    const { exitCode, stdout, stderr, durationMs, aborted, earlyExit } =
      await runWorkflowWorkerProcess({
        command,
        args,
        cwd: options.cwd,
        abortSignal: options.abortSignal,
        onOutputActivity: (stream) => options.reportProgress?.(`worker-${stream}`),
        earlyExitPatterns: DEVIN_AUTH_PROMPT_PATTERNS,
      });

    if (aborted) {
      throw new DevinWorkflowWorkerError(
        "devin was aborted by Prism workflow stop",
        workflowWorkerFailureMetadata({
          adapter: "devin",
          stderr,
          sessionId: await bestEffortDevinSessionId(exportPath, sessionId),
        }),
      );
    }
    if (earlyExit === "devin-auth-login-required") {
      throw new DevinWorkflowWorkerError(
        devinAuthErrorMessage,
        workflowWorkerFailureMetadata({ adapter: "devin", stderr, sessionId }),
      );
    }
    if (exitCode !== 0 && isDevinAuthOutput(`${stdout}\n${stderr}`)) {
      throw new DevinWorkflowWorkerError(
        devinAuthErrorMessage,
        workflowWorkerFailureMetadata({ adapter: "devin", stderr, sessionId }),
      );
    }
    if (exitCode !== 0) {
      const stderrMetadata = summarizeWorkflowWorkerStderr(stderr);
      const errorExcerpt =
        stderrMetadata.stderrExcerpt ??
        summarizeWorkflowWorkerStderr(stdout).stderrExcerpt ??
        "";
      throw new DevinWorkflowWorkerError(
        `devin exited with ${exitCode}: ${errorExcerpt}`,
        workflowWorkerFailureMetadata({
          adapter: "devin",
          stderr,
          sessionId: await bestEffortDevinSessionId(exportPath, sessionId),
        }),
      );
    }

    let exportJson: unknown | undefined;
    let agentText: string;
    try {
      exportJson = JSON.parse(await readFile(exportPath, "utf8")) as unknown;
      agentText = extractAgentTextFromAtif(exportJson);
    } catch (error) {
      const fallbackText = stdout.trim();
      if (fallbackText.length === 0) {
        const failureMetadata = workflowWorkerFailureMetadata({
          adapter: "devin",
          stderr,
          sessionId: (exportJson !== undefined ? sessionIdFromAtif(exportJson) : undefined) ?? sessionId,
        });
        throw error instanceof DevinWorkflowWorkerError
          ? new DevinWorkflowWorkerError(error.message, failureMetadata)
          : new DevinWorkflowWorkerError(
              "devin finished without a readable ATIF export or stdout text",
              failureMetadata,
            );
      }
      agentText = fallbackText;
    }

    const capturedSessionId =
      (exportJson !== undefined ? sessionIdFromAtif(exportJson) : undefined) ?? sessionId;

    return {
      output: parseWorkflowWorkerJsonOutput(agentText),
      metadata: {
        adapter: "devin",
        prompted: true,
        source: "prism-workflow",
        model: options.model,
        durationMs,
        sessionId: capturedSessionId,
        ...summarizeWorkflowWorkerStderr(stderr),
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};
