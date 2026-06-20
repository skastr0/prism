import { Effect } from "effect";
import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess, workflowWorkerProcessExcerpt } from "./workflow-worker-process.js";
import { runAntigravityPtyProcess } from "./workflow-antigravity-pty.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

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

export interface AntigravityWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly printTimeout?: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  /** Override the default retry budget. Mostly useful in tests. */
  readonly maxAttempts?: number;
  /** Override the default retry backoff. Mostly useful in tests. */
  readonly backoffMs?: number;
}

export class AntigravityWorkflowWorkerError extends Error {
  override readonly name = "AntigravityWorkflowWorkerError";
}

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
  readonly model?: string;
}): string => {
  const model = input.model ?? "<default>";
  return `agy print mode failed before Prism worker JSON (printTimeout: ${input.printTimeout}, model: ${model}): ${input.printedError}`;
};

const antigravityMetadata = (input: {
  readonly task: AnyWorkflowTask;
  readonly model?: string;
  readonly durationMs: number;
  readonly printTimeout: string;
  readonly processTimeoutMs: number;
  readonly stderr: string;
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
  ...(input.timedOut === true ? { timedOut: true } : {}),
  ...(input.recoveredAfterTimeout === true ? { recoveredAfterTimeout: true } : {}),
  ...summarizeWorkflowWorkerStderr(input.stderr),
});

const envBoolean = (value: string | undefined): boolean =>
  value === "1" || value === "true";

const envPositiveInteger = (value: string | undefined, fallback: number): number =>
  parsePositiveInteger(value) ?? fallback;

export const buildAgyArgs = (input: {
  readonly cwd: string;
  readonly model?: string;
  readonly printTimeout: string;
  readonly prompt: string;
}): ReadonlyArray<string> => [
  "--print",
  "--dangerously-skip-permissions",
  "--sandbox",
  "--print-timeout",
  input.printTimeout,
  "--add-dir",
  input.cwd,
  ...(input.model !== undefined ? ["--model", input.model] : []),
  input.prompt,
];

const runAgyOnce = async (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly processTimeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly printTimeout: string;
  readonly usePty: boolean;
}): Promise<AgyAttemptResult> => {
  try {
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
    return `agy was aborted by Prism workflow stop${excerpt}`;
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
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly processTimeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly printTimeout: string;
  readonly model?: string;
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
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const printTimeout = options.printTimeout ?? process.env.PRISM_WORKFLOW_ANTIGRAVITY_PRINT_TIMEOUT ?? "5m";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const usePty = envBoolean(process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY) ?? false;
  const maxAttempts = options.maxAttempts
    ?? envPositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_RETRY_MAX_ATTEMPTS, 3);
  const backoffMs = options.backoffMs
    ?? envPositiveInteger(process.env.PRISM_WORKFLOW_ANTIGRAVITY_RETRY_BACKOFF_MS, 2_000);
  const args = buildAgyArgs({ cwd: options.cwd, model: options.model, printTimeout, prompt });

  const program = Effect.gen(function* () {
    const result = yield* runAgyWithRetry({
      command,
      args,
      cwd: options.cwd,
      processTimeoutMs,
      abortSignal: options.abortSignal,
      printTimeout,
      model: options.model,
      usePty,
      maxAttempts,
      backoffMs,
    });

    if (result.timedOut) {
      try {
        return {
          output: parseWorkflowWorkerJsonOutput(result.stdout),
          metadata: antigravityMetadata({
            task,
            model: options.model,
            durationMs: result.durationMs,
            printTimeout,
            processTimeoutMs,
            stderr: result.stderr,
            timedOut: true,
            recoveredAfterTimeout: true,
          }),
        };
      } catch {
        // Preserve the existing timeout failure unless AGY printed a complete Prism worker JSON value before stalling.
      }
      return yield* Effect.fail(
        new AntigravityWorkflowWorkerError(`agy exceeded Prism process timeout after ${processTimeoutMs}ms${workflowWorkerProcessExcerpt(result.stdout, result.stderr)}`),
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
              model: options.model,
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
        model: options.model,
        durationMs: result.durationMs,
        printTimeout,
        processTimeoutMs,
        stderr: result.stderr,
      }),
    };
  });

  const result = await Effect.runPromise(program);
  return result;
};
