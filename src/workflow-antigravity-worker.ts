import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { AntigravityWorkflowPermissionMode, AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess, workflowWorkerProcessExcerpt } from "./workflow-worker-process.js";
import { runAntigravityPtyProcess } from "./workflow-antigravity-pty.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";

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
  /** Override the default retry budget. Mostly useful in tests. */
  readonly maxAttempts?: number;
  /** Override the default retry backoff. Mostly useful in tests. */
  readonly backoffMs?: number;
} & WorkflowTaskRepairLoopOption<"antigravity-cli">;

export class AntigravityWorkflowWorkerError extends Error {
  override readonly name = "AntigravityWorkflowWorkerError";
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

export const detectAgyPrintTimeout = (stdout: string, stderr: string): boolean =>
  /(?:^|\n)Error:\s*timed out waiting for response\s*$/iu.test(`${stdout}\n${stderr}`.trim());

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
  readonly processTimeoutMs: number;
  readonly stderr: string;
  readonly sessionId?: AgyConversationId;
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
  sessionId: input.sessionId,
  conversationId: input.sessionId,
  continuationStrategy: input.sessionId !== undefined ? "explicit-conversation-id" : "pending-conversation-id-capture",
  ...(input.timedOut === true ? { timedOut: true } : {}),
  ...(input.recoveredAfterTimeout === true ? { recoveredAfterTimeout: true } : {}),
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
  readonly processTimeoutMs: number;
  readonly abortSignal?: AbortSignal;
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
        printTimeout: input.printTimeout,
      });
    }
    return await runWorkflowWorkerProcess({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      processTimeoutMs: input.processTimeoutMs,
      abortSignal: input.abortSignal,
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
  if (trimmedStdout.length === 0 && trimmedStderr.length === 0) {
    return { kind: "retryable", reason: "empty-output" };
  }
  return { kind: "ok" };
};

const terminalErrorMessage = (input: {
  readonly result: AgyAttemptResult;
  readonly reason: string;
  readonly processTimeoutMs: number;
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

const runAgyWithRetry = (input: {
  readonly command: string;
  readonly args: AgyPrintArgs;
  readonly cwd: string;
  readonly processTimeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly printTimeout: string;
  readonly model: string;
  readonly usePty: boolean;
  readonly maxAttempts: number;
  readonly backoffMs: number;
}): Effect.Effect<AgyAttemptResult, AntigravityWorkflowWorkerError, never> =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      const result = yield* Effect.promise(() => runAgyOnce({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        processTimeoutMs: input.processTimeoutMs,
        abortSignal: input.abortSignal,
        printTimeout: input.printTimeout,
        usePty: input.usePty,
      }));
      const classification = classifyAgyAttempt(result);
      if (classification.kind === "ok") {
        return result;
      }
      if (classification.kind === "terminal") {
        return yield* Effect.fail(
          new AntigravityWorkflowWorkerError(
            terminalErrorMessage({ result, reason: classification.reason, processTimeoutMs: input.processTimeoutMs }),
          ),
        );
      }
      if (attempt >= input.maxAttempts) {
        if (classification.reason === "print-timeout-sentinel") {
          return yield* Effect.fail(
            new AntigravityWorkflowWorkerError(
              agyPrintFailureMessage({
                printedError: "Error: timed out waiting for response",
                printTimeout: input.printTimeout,
                model: input.model,
              }),
            ),
          );
        }
        return yield* Effect.fail(
          new AntigravityWorkflowWorkerError(
            `agy print mode returned empty output after ${input.maxAttempts} attempt${input.maxAttempts === 1 ? "" : "s"}`,
          ),
        );
      }
      yield* Effect.sleep(`${input.backoffMs} millis`);
    }
    // Unreachable, but keeps the compiler happy.
    return yield* Effect.fail(
      new AntigravityWorkflowWorkerError("agy print mode failed after exhausting all retry attempts"),
    );
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
  const printTimeout = options.printTimeout ?? process.env.PRISM_WORKFLOW_ANTIGRAVITY_PRINT_TIMEOUT ?? "5m";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const usePty = envBoolean(process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY) ?? false;
  const maxAttempts = options.maxAttempts
    ?? envPositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_RETRY_MAX_ATTEMPTS, 3);
  const backoffMs = options.backoffMs
    ?? envPositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_RETRY_BACKOFF_MS, 2_000);
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-workflow-agy-"));
  const logFile = join(tempRoot, "agy.log");
  const args = buildAgyArgs({
    cwd: options.cwd,
    model,
    permission: options.resolvedPermission,
    printTimeout,
    prompt,
    conversationId: resumeConversationId,
    logFile,
  });

  const program = Effect.gen(function* () {
    const result = yield* runAgyWithRetry({
      command,
      args,
      cwd: options.cwd,
      processTimeoutMs,
      abortSignal: options.abortSignal,
      printTimeout,
      model,
      usePty,
      maxAttempts,
      backoffMs,
    });
    const agyLog = yield* Effect.promise(() => readAgyLog(logFile));
    const sessionId = extractAgyConversationId(agyLog);

    if (result.timedOut) {
      try {
        return {
          output: parseWorkflowWorkerJsonOutput(result.stdout),
          metadata: antigravityMetadata({
            task,
            model,
            durationMs: result.durationMs,
            printTimeout,
            processTimeoutMs,
            stderr: result.stderr,
            sessionId,
            timedOut: true,
            recoveredAfterTimeout: true,
          }),
        };
      } catch {
        // Preserve the existing timeout failure unless AGY printed a complete Prism worker JSON value before stalling.
      }
      return yield* Effect.fail(
        new AntigravityWorkflowWorkerError(`agy exceeded Prism process timeout after ${processTimeoutMs}ms`),
      );
    }

    let output: unknown;
    try {
      output = parseWorkflowWorkerJsonOutput(result.stdout);
    } catch (error) {
      if (detectAgyPrintTimeout(result.stdout, result.stderr)) {
        return yield* Effect.fail(
          new AntigravityWorkflowWorkerError(
            agyPrintFailureMessage({
              printedError: "Error: timed out waiting for response",
              printTimeout,
              model,
            }),
          ),
        );
      }
      return yield* Effect.fail(error);
    }

    return {
      output,
      metadata: antigravityMetadata({
        task,
        model,
        durationMs: result.durationMs,
        printTimeout,
        processTimeoutMs,
        stderr: result.stderr,
        sessionId,
      }),
    };
  });

  try {
    const result = await Effect.runPromise(program);
    return result;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};
