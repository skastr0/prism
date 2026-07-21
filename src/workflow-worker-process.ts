import { currentCliCommand } from "./workflow-cli-command.js";
import { encodeWorkflowProcessGuardRequest } from "./workflow-process-guard.js";
import { spawnWorkflowProcess } from "./workflow-runtime.js";

export interface WorkflowWorkerProcessOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly abortSignal?: AbortSignal;
  readonly processTimeoutMs?: number;
  readonly env?: Record<string, string>;
  readonly onOutputActivity?: (stream: WorkflowWorkerOutputStream) => void;
  readonly earlyExitPatterns?: ReadonlyArray<{
    readonly name: string;
    readonly pattern: RegExp;
  }>;
}

export type WorkflowWorkerOutputStream = "stdout" | "stderr";

export interface WorkflowWorkerProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly earlyExit?: string;
}

export const parsePositiveInteger = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};

export const workflowWorkerProcessExcerpt = (stdout: string, stderr: string): string => {
  const transcript = `${stdout}\n${stderr}`.trim();
  return transcript.length > 0 ? `: ${transcript.slice(-512)}` : "";
};

export const runWorkflowWorkerProcess = async (
  options: WorkflowWorkerProcessOptions,
): Promise<WorkflowWorkerProcessResult> => {
  const started = Date.now();
  const guard = spawnWorkflowProcess({
    cmd: [
      ...currentCliCommand(),
      "__workflow-process-guard",
      ...encodeWorkflowProcessGuardRequest({
        cwd: options.cwd,
        command: options.command,
        args: options.args,
      }),
    ],
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let aborted = false;
  let earlyExit: string | undefined;
  let leaseClosed = false;
  const closeLease = (): void => {
    if (leaseClosed) return;
    leaseClosed = true;
    try {
      guard.stdin.end();
    } catch {
      guard.kill("SIGTERM");
    }
  };
  let observedOutput = "";
  const observeOutput = (text: string): void => {
    if (earlyExit !== undefined || options.earlyExitPatterns === undefined || text.length === 0) return;
    observedOutput = `${observedOutput}${text}`.slice(-4096);
    const matched = options.earlyExitPatterns.find((candidate) => candidate.pattern.test(observedOutput));
    if (matched === undefined) return;
    earlyExit = matched.name;
    closeLease();
  };
  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    source: WorkflowWorkerOutputStream,
  ): Promise<string> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      if (read.value.byteLength > 0) options.onOutputActivity?.(source);
      const text = decoder.decode(read.value, { stream: true });
      output += text;
      observeOutput(text);
    }
    const tail = decoder.decode();
    output += tail;
    observeOutput(tail);
    return output;
  };
  const onAbort = (): void => {
    aborted = true;
    closeLease();
  };
  if (options.abortSignal?.aborted === true) {
    onAbort();
  } else {
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = options.processTimeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true;
      closeLease();
    }, options.processTimeoutMs);
  const exit = guard.exited;
  const stdout = readStream(guard.stdout, "stdout").catch((error: unknown) => {
    closeLease();
    throw error;
  });
  const stderr = readStream(guard.stderr, "stderr").catch((error: unknown) => {
    closeLease();
    throw error;
  });
  try {
    const [exitCode, stdoutText, stderrText] = await Promise.all([exit, stdout, stderr]);
    return {
      exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      durationMs: Date.now() - started,
      timedOut,
      aborted,
      ...(earlyExit !== undefined ? { earlyExit } : {}),
    };
  } catch (error) {
    closeLease();
    await Promise.allSettled([exit, stdout, stderr]);
    throw error;
  } finally {
    closeLease();
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
};
