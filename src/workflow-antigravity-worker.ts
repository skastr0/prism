import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { AntigravityWorkflowPermissionMode, AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, WorkflowOutputParseError, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess, workflowWorkerProcessExcerpt } from "./workflow-worker-process.js";
import { runAntigravityPtyProcess } from "./workflow-antigravity-pty.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskProgressReporter, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";

/**
 * Environment-variable overrides for the Antigravity workflow worker:
 *
 * - PRISM_WORKFLOW_ANTIGRAVITY_BIN: path to the `agy` executable.
 * - PRISM_WORKFLOW_ANTIGRAVITY_PRINT_TIMEOUT: value passed to `agy --print-timeout`.
 * - PRISM_WORKFLOW_ANTIGRAVITY_PROCESS_TIMEOUT_MS: outer watchdog before Prism kills `agy`.
 * - PRISM_WORKFLOW_ANTIGRAVITY_PTY: set to "1" or "true" to force a Python PTY wrapper.
 *   Useful when `agy --print` drops stdout because stdin is not a TTY.
 * - PRISM_WORKFLOW_ANTIGRAVITY_PTY_PYTHON: path to a Python 3 interpreter (default: `python3` on PATH).
 * - PRISM_WORKFLOW_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: retries on sentinel/empty output (default: 3).
 * - PRISM_WORKFLOW_ANTIGRAVITY_RETRY_BACKOFF_MS: delay between retries (default: 2000).
 */

export type AntigravityWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly resolvedPermission: AntigravityWorkflowPermissionMode;
  readonly printTimeout?: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
  /** Override the default retry budget. Mostly useful in tests. */
  readonly maxAttempts?: number;
  /** Override the default retry backoff. Mostly useful in tests. */
  readonly backoffMs?: number;
  /** Disable the executable capability probe. Tests with minimal fake binaries only. */
  readonly preflight?: boolean;
} & WorkflowTaskRepairLoopOption<"antigravity-cli">;

export class AntigravityWorkflowWorkerError extends Error {
  override readonly name = "AntigravityWorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

export const DEFAULT_ANTIGRAVITY_MODEL = "Gemini 3.5 Flash (Medium)";

export type AgyConversationId = string & { readonly __brand: "AgyConversationId" };

type AgyValue<Kind extends string> = string & { readonly __agyValue: Kind };

type AgyLogFile = AgyValue<"log-file">;
type AgyPrintTimeout = AgyValue<"print-timeout">;
type AgyWorkspaceDir = AgyValue<"workspace-dir">;
type AgyModel = AgyValue<"model">;
type AgyPrompt = AgyValue<"prompt">;
type AgyLogFileArgs = readonly ["--log-file", AgyLogFile];
type AgyConversationArgs = readonly ["--conversation", AgyConversationId];
type AgyPermissionArgs = readonly ["--dangerously-skip-permissions", "--sandbox"];
type AgyTimeoutArgs = readonly ["--print-timeout", AgyPrintTimeout];
type AgyWorkspaceArgs = readonly ["--add-dir", AgyWorkspaceDir];
type AgyModelArgs = readonly ["--model", AgyModel];
type AgyOptionalLogFileArgs = readonly [] | AgyLogFileArgs;
type AgyOptionalConversationArgs = readonly [] | AgyConversationArgs;
type AgyRequiredPrintArgs = readonly [
  ...AgyPermissionArgs,
  ...AgyTimeoutArgs,
  ...AgyWorkspaceArgs,
  ...AgyModelArgs,
  "--print",
  AgyPrompt,
];

export type AgyForbiddenWorkflowFlag = "--continue" | "-c";
export type AgyPrintArgs =
  | AgyRequiredPrintArgs
  | readonly [...AgyLogFileArgs, ...AgyRequiredPrintArgs]
  | readonly [...AgyConversationArgs, ...AgyRequiredPrintArgs]
  | readonly [...AgyLogFileArgs, ...AgyConversationArgs, ...AgyRequiredPrintArgs];

export const AGY_FORBIDDEN_WORKFLOW_FLAGS = new Set<AgyForbiddenWorkflowFlag>(["--continue", "-c"]);

const agyValue = <Kind extends string>(value: string): AgyValue<Kind> => value as AgyValue<Kind>;

export const assertAgyPrintArgsWorkflowSafe = (args: readonly string[]): void => {
  const printIndex = args.indexOf("--print");
  const flags = printIndex >= 0 ? args.slice(0, printIndex) : args;
  const forbiddenFlag = flags.find((arg): arg is AgyForbiddenWorkflowFlag =>
    AGY_FORBIDDEN_WORKFLOW_FLAGS.has(arg as AgyForbiddenWorkflowFlag));
  if (forbiddenFlag !== undefined) {
    throw new AntigravityWorkflowWorkerError(
      `agy ${forbiddenFlag} is banned in Prism workflows; use an explicit --conversation id instead.`,
    );
  }
};

type AgyAttemptResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
};

type AgyRetryResult = AgyAttemptResult & {
  readonly sessionId?: AgyConversationId;
  readonly attemptCount: number;
  readonly transport: "pipe" | "pty";
};

const AGY_REQUIRED_WORKFLOW_FLAGS = [
  "--add-dir",
  "--conversation",
  "--dangerously-skip-permissions",
  "--log-file",
  "--model",
  "--print",
  "--print-timeout",
  "--sandbox",
] as const;

export const assertAntigravityWorkflowCapabilities = (helpText: string): void => {
  const missing = AGY_REQUIRED_WORKFLOW_FLAGS.filter((flag) => !helpText.includes(flag));
  if (missing.length === 0) return;
  throw new AntigravityWorkflowWorkerError(
    `agy is incompatible with Prism workflows; missing required flags: ${missing.join(", ")}. Upgrade agy, or set PRISM_WORKFLOW_ANTIGRAVITY_BIN to a compatible executable.`,
    { adapter: "antigravity-cli", stage: "capability-preflight", missingFlags: missing },
  );
};

const preflightAgyCommand = async (input: {
  readonly command: string;
  readonly cwd: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
}): Promise<void> => {
  const result = await runWorkflowWorkerProcess({
    command: input.command,
    args: ["--help"],
    cwd: input.cwd,
    processTimeoutMs: input.processTimeoutMs,
    abortSignal: input.abortSignal,
    onOutputActivity: (stream) => input.reportProgress?.(`worker-${stream}`),
  });
  const metadata = {
    adapter: "antigravity-cli",
    stage: "capability-preflight",
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted,
    exitCode: result.exitCode,
    ...summarizeWorkflowWorkerStderr(result.stderr),
  };
  if (result.aborted) {
    throw new AntigravityWorkflowWorkerError("agy capability preflight was aborted by Prism workflow stop", metadata);
  }
  if (result.timedOut) {
    throw new AntigravityWorkflowWorkerError(
      `agy capability preflight exceeded Prism process timeout after ${input.processTimeoutMs}ms`,
      metadata,
    );
  }
  if (result.exitCode !== 0) {
    throw new AntigravityWorkflowWorkerError(
      `agy capability preflight exited with ${result.exitCode}${workflowWorkerProcessExcerpt(result.stdout, result.stderr)}`,
      metadata,
    );
  }
  try {
    assertAntigravityWorkflowCapabilities(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    if (error instanceof AntigravityWorkflowWorkerError) {
      throw new AntigravityWorkflowWorkerError(error.message, { ...metadata, ...(error.metadata ?? {}) });
    }
    throw error;
  }
};
// Both wordings observed live: agy in the wild emits "Error: timeout waiting
// for response" (dominant Jul-9 failure class, WFE-005) while older builds and
// our own failure message use "timed out". The sentinel must match both or the
// retry path never fires.
const AGY_PRINT_TIMEOUT_PATTERN = /(?:^|\n)Error:\s*(?:timed out|timeout) waiting for response\s*$/iu;

export const detectAgyPrintTimeout = (stdout: string, stderr: string): boolean =>
  AGY_PRINT_TIMEOUT_PATTERN.test(stdout.trim()) || AGY_PRINT_TIMEOUT_PATTERN.test(stderr.trim());

const agyPrintFailureMessage = (input: {
  readonly printedError: string;
  readonly printTimeout: string;
  readonly model: string;
}): string => {
  return `agy print mode failed before Prism worker JSON (printTimeout: ${input.printTimeout}, model: ${input.model}): ${input.printedError}`;
};

const antigravityMetadata = (input: {
  readonly task: AnyWorkflowTask;
  readonly model: string;
  readonly durationMs: number;
  readonly printTimeout: string;
  readonly processTimeoutMs?: number;
  readonly stderr: string;
  readonly stdout?: string;
  readonly sessionId?: AgyConversationId;
  readonly attemptCount?: number;
  readonly transport?: "pipe" | "pty";
  readonly timedOut?: boolean;
  readonly recoveredAfterTimeout?: boolean;
}) => ({
  adapter: "antigravity-cli",
  prompted: true,
  agentSelection: "prompted-contract",
  agent: {
    plugin: input.task.agent.plugin,
    name: input.task.agent.name,
    manifestHash: input.task.agent.manifestHash,
  },
  model: input.model,
  durationMs: input.durationMs,
  printTimeout: input.printTimeout,
  processTimeoutMs: input.processTimeoutMs,
  attemptCount: input.attemptCount,
  transport: input.transport,
  sessionId: input.sessionId,
  conversationId: input.sessionId,
  continuationStrategy: input.sessionId !== undefined ? "explicit-conversation-id" : "pending-conversation-id-capture",
  ...(input.timedOut === true ? { timedOut: true } : {}),
  ...(input.recoveredAfterTimeout === true ? { recoveredAfterTimeout: true } : {}),
  ...(input.timedOut === true && input.stdout?.trim()
    ? { outputExcerpt: input.stdout.trim().slice(-512) }
    : {}),
  ...summarizeWorkflowWorkerStderr(input.stderr),
});

const envBoolean = (value: string | undefined): boolean =>
  value === "1" || value === "true";

const envPositiveInteger = (value: string | undefined, fallback: number): number =>
  parsePositiveInteger(value) ?? fallback;

export const resolveAntigravityPermission = (mode: WorkflowPermissionMode): AntigravityWorkflowPermissionMode => {
  switch (mode) {
    case "legacy":
    case "permissive":
    case "full-access":
      return mode;
    case "restricted":
      throw new WorkflowPermissionError(
        "antigravity-cli",
        mode,
        "Antigravity CLI has no per-invocation allow/deny tool restriction flag. Choose 'legacy' or 'permissive' instead.",
      );
    case "interactive":
      throw new WorkflowPermissionError(
        "antigravity-cli",
        mode,
        "Antigravity CLI interactive prompt mode is incompatible with Prism workflow execution. Workflow tasks run headless and cannot participate in interactive prompts. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-read-only":
      throw new WorkflowPermissionError(
        "antigravity-cli",
        mode,
        "Antigravity CLI only exposes a coarse --sandbox flag, not a read-only sandbox mode. Choose 'legacy' or 'permissive' instead.",
      );
    case "sandbox-workspace-write":
      throw new WorkflowPermissionError(
        "antigravity-cli",
        mode,
        "Antigravity CLI only exposes a coarse --sandbox flag, not a workspace-write sandbox mode. Choose 'legacy' or 'permissive' instead.",
      );
  }
  return assertNeverWorkflowPermissionMode("antigravity-cli", mode);
};

export const buildAgyArgs = (input: {
  readonly cwd: string;
  readonly model: string;
  readonly permission?: AntigravityWorkflowPermissionMode;
  readonly printTimeout: string;
  readonly prompt: string;
  readonly conversationId?: AgyConversationId;
  readonly logFile?: string;
}): AgyPrintArgs => {
  const mode = input.permission ?? "permissive";
  resolveAntigravityPermission(mode);
  const logFileArgs: AgyOptionalLogFileArgs = input.logFile !== undefined
    ? ["--log-file", agyValue<"log-file">(input.logFile)]
    : [];
  const conversationArgs: AgyOptionalConversationArgs = input.conversationId !== undefined
    ? ["--conversation", input.conversationId]
    : [];
  return [
    ...logFileArgs,
    ...conversationArgs,
    "--dangerously-skip-permissions",
    "--sandbox",
    "--print-timeout",
    agyValue<"print-timeout">(input.printTimeout),
    "--add-dir",
    agyValue<"workspace-dir">(input.cwd),
    "--model",
    agyValue<"model">(input.model),
    "--print",
    agyValue<"prompt">(input.prompt),
  ];
};

const AGY_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const parseAgyConversationId = (value: string | undefined): AgyConversationId | undefined => {
  if (value === undefined) return undefined;
  return new RegExp(`^${AGY_UUID_PATTERN}$`, "iu").test(value)
    ? value as AgyConversationId
    : undefined;
};

export const extractAgyConversationId = (logText: string): AgyConversationId | undefined => {
  const streaming = logText.match(new RegExp(`\\bPrint mode: conversation=(${AGY_UUID_PATTERN}), sending message`, "iu"));
  const streamed = parseAgyConversationId(streaming?.[1]);
  if (streamed !== undefined) return streamed;
  const created = logText.match(new RegExp(`\\bCreated conversation (${AGY_UUID_PATTERN})\\b`, "iu"));
  const createdId = parseAgyConversationId(created?.[1]);
  if (createdId !== undefined) return createdId;
  const explicit = logText.match(new RegExp(`\\bconversationID="(${AGY_UUID_PATTERN})"`, "iu"));
  return parseAgyConversationId(explicit?.[1]);
};

const readAgyLog = async (logFile: string): Promise<string> => {
  try {
    return await readFile(logFile, "utf8");
  } catch {
    return "";
  }
};

const runAgyOnce = async (input: {
  readonly command: string;
  readonly args: AgyPrintArgs;
  readonly cwd: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
  readonly printTimeout: string;
  readonly usePty: boolean;
}): Promise<AgyAttemptResult> => {
  try {
    assertAgyPrintArgsWorkflowSafe(input.args);
    if (input.usePty) {
      return await runAntigravityPtyProcess({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        processTimeoutMs: input.processTimeoutMs,
        abortSignal: input.abortSignal,
        onOutputActivity: (stream) => input.reportProgress?.(`worker-${stream}`),
        printTimeout: input.printTimeout,
      });
    }
    return await runWorkflowWorkerProcess({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      processTimeoutMs: input.processTimeoutMs,
      abortSignal: input.abortSignal,
      onOutputActivity: (stream) => input.reportProgress?.(`worker-${stream}`),
    });
  } catch (error) {
    return {
      stdout: "",
      stderr: String(error),
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      aborted: false,
    };
  }
};

type AgyAttemptClassification =
  | { readonly kind: "ok" }
  | { readonly kind: "retryable"; readonly reason: "print-timeout-sentinel" | "empty-output" }
  | { readonly kind: "terminal"; readonly reason: string };

const classifyAgyAttempt = (result: AgyAttemptResult): AgyAttemptClassification => {
  if (result.aborted) {
    return { kind: "terminal", reason: "aborted" };
  }
  if (detectAgyPrintTimeout(result.stdout, result.stderr)) {
    return { kind: "retryable", reason: "print-timeout-sentinel" };
  }
  if (result.timedOut) {
    // Process-level timeouts are handled by the caller so it can attempt to
    // recover JSON that was emitted before the watchdog fired.
    return { kind: "ok" };
  }
  const trimmedStdout = result.stdout.trim();
  const trimmedStderr = result.stderr.trim();
  if (result.exitCode === null && trimmedStderr.length > 0) {
    return { kind: "terminal", reason: "process-error" };
  }
  if (result.exitCode !== 0 && result.exitCode !== null) {
    return { kind: "terminal", reason: "non-zero-exit" };
  }
  if (trimmedStdout.length === 0) {
    return { kind: "retryable", reason: "empty-output" };
  }
  return { kind: "ok" };
};

const terminalErrorMessage = (input: {
  readonly result: AgyAttemptResult;
  readonly reason: string;
  readonly processTimeoutMs?: number;
}): string => {
  const excerpt = workflowWorkerProcessExcerpt(input.result.stdout, input.result.stderr);
  if (input.reason === "aborted") {
    return "agy was aborted by Prism workflow stop";
  }
  if (input.reason === "non-zero-exit") {
    return `agy exited with ${input.result.exitCode}: ${input.result.stderr.trim() || input.result.stdout.trim()}`;
  }
  if (input.reason === "process-error") {
    return `agy process setup failed before Prism worker JSON${excerpt}`;
  }
  return `agy print mode failed (${input.reason})${excerpt}`;
};

/**
 * Remaining time until an (optionally infinite) deadline, shaped for spread into
 * a worker-process call: an infinite deadline contributes no timeout at all.
 */
const remainingTimeoutMs = (deadlineAt: number): { processTimeoutMs?: number } =>
  Number.isFinite(deadlineAt)
    ? { processTimeoutMs: Math.max(1, deadlineAt - Date.now()) }
    : {};

const agyDeadlineError = (
  processTimeoutMs: number | undefined,
  metadata?: Record<string, unknown>,
): AntigravityWorkflowWorkerError =>
  new AntigravityWorkflowWorkerError(
    `agy exceeded Prism process timeout after ${processTimeoutMs}ms`,
    metadata,
  );

const waitForAgyBackoff = async (input: {
  readonly delayMs: number;
  readonly deadlineAt: number;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}): Promise<void> => {
  if (input.abortSignal?.aborted === true) {
    throw new AntigravityWorkflowWorkerError("agy was aborted by Prism workflow stop");
  }
  const remainingMs = input.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw agyDeadlineError(input.processTimeoutMs);
  }
  if (input.delayMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const delayMs = Math.min(input.delayMs, remainingMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      input.abortSignal?.removeEventListener("abort", onAbort);
      reject(new AntigravityWorkflowWorkerError("agy was aborted by Prism workflow stop"));
    };
    const timer = setTimeout(() => {
      input.abortSignal?.removeEventListener("abort", onAbort);
      if (Date.now() >= input.deadlineAt) {
        reject(agyDeadlineError(input.processTimeoutMs));
        return;
      }
      resolve();
    }, delayMs);
    input.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (input.abortSignal?.aborted === true) {
      onAbort();
    }
  });
};

const runAgyWithRetry = (input: {
  readonly command: string;
  readonly cwd: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
  readonly printTimeout: string;
  readonly model: string;
  readonly permission: AntigravityWorkflowPermissionMode;
  readonly prompt: string;
  readonly initialConversationId?: AgyConversationId;
  readonly logRoot: string;
  readonly usePty: boolean;
  readonly preflight: boolean;
  readonly maxAttempts: number;
  readonly backoffMs: number;
}): Effect.Effect<AgyRetryResult, AntigravityWorkflowWorkerError, never> =>
  Effect.tryPromise({
    try: async () => {
      const startedAt = Date.now();
      // No configured timeout => an infinite deadline: every remaining-time
      // computation below stays correct and no watchdog is armed.
      const deadlineAt = input.processTimeoutMs === undefined
        ? Number.POSITIVE_INFINITY
        : startedAt + input.processTimeoutMs;
      let conversationId = input.initialConversationId;
      let usePty = input.usePty;
      if (input.preflight) {
        await preflightAgyCommand({
          command: input.command,
          cwd: input.cwd,
          ...remainingTimeoutMs(deadlineAt),
          abortSignal: input.abortSignal,
          reportProgress: input.reportProgress,
        });
      }
      for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
        if (input.abortSignal?.aborted === true) {
          throw new AntigravityWorkflowWorkerError("agy was aborted by Prism workflow stop");
        }
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          throw agyDeadlineError(input.processTimeoutMs);
        }
        const logFile = join(input.logRoot, `agy-attempt-${attempt}.log`);
        const args = buildAgyArgs({
          cwd: input.cwd,
          model: input.model,
          permission: input.permission,
          printTimeout: input.printTimeout,
          prompt: input.prompt,
          conversationId,
          logFile,
        });
        const result = await runAgyOnce({
          command: input.command,
          args,
          cwd: input.cwd,
          ...remainingTimeoutMs(deadlineAt),
          abortSignal: input.abortSignal,
          reportProgress: input.reportProgress,
          printTimeout: input.printTimeout,
          usePty,
        });
        const agyLog = await readAgyLog(logFile);
        const attemptConversationId = extractAgyConversationId(agyLog) ?? conversationId;
        const classification = classifyAgyAttempt(result);
        if (classification.kind === "ok") {
          return {
            ...result,
            durationMs: Date.now() - startedAt,
            sessionId: attemptConversationId,
            attemptCount: attempt,
            transport: usePty ? "pty" : "pipe",
          };
        }
        if (classification.kind === "terminal") {
          throw new AntigravityWorkflowWorkerError(
            terminalErrorMessage({ result, reason: classification.reason, processTimeoutMs: input.processTimeoutMs }),
          );
        }
        if (attemptConversationId === undefined) {
          throw new AntigravityWorkflowWorkerError(
            `agy retry blocked after attempt ${attempt}: no conversation UUID was captured; refusing to start a fresh conversation`,
          );
        }
        if (classification.reason === "empty-output") {
          usePty = true;
        }
        conversationId = attemptConversationId;
        if (attempt >= input.maxAttempts) {
          if (classification.reason === "print-timeout-sentinel") {
            throw new AntigravityWorkflowWorkerError(
              agyPrintFailureMessage({
                printedError: "Error: timed out waiting for response",
                printTimeout: input.printTimeout,
                model: input.model,
              }),
            );
          }
          throw new AntigravityWorkflowWorkerError(
            `agy print mode returned empty output after ${input.maxAttempts} attempt${input.maxAttempts === 1 ? "" : "s"}`,
          );
        }
        await waitForAgyBackoff({
          delayMs: input.backoffMs,
          deadlineAt,
          processTimeoutMs: input.processTimeoutMs,
          abortSignal: input.abortSignal,
        });
      }
      throw new AntigravityWorkflowWorkerError("agy print mode failed after exhausting all retry attempts");
    },
    catch: (error) => error instanceof AntigravityWorkflowWorkerError
      ? error
      : new AntigravityWorkflowWorkerError(String(error)),
  });

export const runAntigravityWorkflowTask = async (
  task: AnyWorkflowTask,
  options: AntigravityWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_ANTIGRAVITY_BIN ?? "agy";
  const model = options.model ?? DEFAULT_ANTIGRAVITY_MODEL;
  const resumeConversationId = parseAgyConversationId(options.repair?.continuation?.sessionId);
  const prompt = options.repair !== undefined && resumeConversationId !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  // agy requires a value for --print-timeout; "24h" is its practical off switch.
  const printTimeout = options.printTimeout ?? process.env.PRISM_WORKFLOW_ANTIGRAVITY_PRINT_TIMEOUT ?? "24h";
  // No default process timeout: a wall-clock kill is not a safety mechanism for
  // a long-running agent. It applies only when asked for explicitly.
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_PROCESS_TIMEOUT_MS);
  const usePty = envBoolean(process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY) ?? false;
  const maxAttempts = options.maxAttempts
    ?? envPositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_RETRY_MAX_ATTEMPTS, 3);
  const backoffMs = options.backoffMs
    ?? envPositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_RETRY_BACKOFF_MS, 2_000);
  const taskStartedAt = Date.now();
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-workflow-agy-"));

  try {
    const attempted = await Effect.runPromise(Effect.either(runAgyWithRetry({
      command,
      cwd: options.cwd,
      processTimeoutMs,
      abortSignal: options.abortSignal,
      reportProgress: options.reportProgress,
      printTimeout,
      model,
      permission: options.resolvedPermission,
      prompt,
      initialConversationId: resumeConversationId,
      logRoot: tempRoot,
      usePty,
      maxAttempts,
      backoffMs,
      preflight: options.preflight !== false,
    })));
    if (attempted._tag === "Left") throw attempted.left;
    const result = attempted.right;
    const sessionId = result.sessionId;

    if (result.timedOut) {
      const timeoutMetadata = antigravityMetadata({
        task,
        model,
        durationMs: result.durationMs,
        printTimeout,
        processTimeoutMs,
        stderr: result.stderr,
        stdout: result.stdout,
        sessionId,
        attemptCount: result.attemptCount,
        transport: result.transport,
        timedOut: true,
      });
      try {
        return {
          output: parseWorkflowWorkerJsonOutput(result.stdout),
          metadata: { ...timeoutMetadata, recoveredAfterTimeout: true },
        };
      } catch {
        throw agyDeadlineError(processTimeoutMs, timeoutMetadata);
      }
    }

    const metadata = antigravityMetadata({
      task,
      model,
      durationMs: result.durationMs,
      printTimeout,
      processTimeoutMs,
      stderr: result.stderr,
      sessionId,
      attemptCount: result.attemptCount,
      transport: result.transport,
    });
    let output: unknown;
    try {
      output = parseWorkflowWorkerJsonOutput(result.stdout);
    } catch (error) {
      if (detectAgyPrintTimeout(result.stdout, result.stderr)) {
        throw new AntigravityWorkflowWorkerError(
          agyPrintFailureMessage({
            printedError: "Error: timed out waiting for response",
            printTimeout,
            model,
          }),
        );
      }
      if (error instanceof WorkflowOutputParseError) {
        throw new WorkflowOutputParseError(error.message, error.rawText, metadata);
      }
      throw error;
    }

    return {
      output,
      metadata,
    };
  } catch (error) {
    if (error instanceof AntigravityWorkflowWorkerError && error.metadata === undefined) {
      throw new AntigravityWorkflowWorkerError(error.message, antigravityMetadata({
        task,
        model,
        durationMs: Date.now() - taskStartedAt,
        printTimeout,
        processTimeoutMs,
        stderr: "",
        sessionId: resumeConversationId,
      }));
    }
    throw error;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};
