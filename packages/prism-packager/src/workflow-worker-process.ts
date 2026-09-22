import { currentCliCommand } from "./workflow-cli-command.js";
import { parsePositiveInteger } from "./workflow-harness-detection.js";
import { encodeWorkflowProcessGuardRequest } from "./workflow-process-guard.js";
import { spawnWorkflowProcess } from "./workflow-runtime.js";

export { parsePositiveInteger };

export interface WorkflowWorkerProcessOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly abortSignal?: AbortSignal;
  readonly env?: Record<string, string>;
  readonly onOutputActivity?: (stream: WorkflowWorkerOutputStream) => void;
  readonly earlyExitPatterns?: ReadonlyArray<{
    readonly name: string;
    readonly pattern: RegExp;
  }>;
}

export type WorkflowWorkerOutputStream = "stdout" | "stderr";

interface WorkflowWorkerOutputCaptureState {
  bytes: number;
  output: string;
}

export interface WorkflowWorkerProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly aborted: boolean;
  readonly earlyExit?: string;
}

/**
 * Worker output is captured in full, without a byte ceiling. Harness workers are
 * long-running agents whose event streams routinely reach tens or hundreds of
 * megabytes; a size cap turned normal agent verbosity into a task failure and
 * forced callers to guess a number they cannot know in advance. Runaway workers
 * are bounded by run control (`workflow runs stop`), the opt-in inactivity
 * watchdog, and cost budgets \u2014 not by truncating their output.
 */
export class WorkflowWorkerOutputCapture {
  private readonly streams: Record<WorkflowWorkerOutputStream, WorkflowWorkerOutputCaptureState> = {
    stdout: { bytes: 0, output: "" },
    stderr: { bytes: 0, output: "" },
  };
  private totalBytes = 0;

  append(source: WorkflowWorkerOutputStream, text: string, byteLength = Buffer.byteLength(text, "utf8")): void {
    const stream = this.streams[source];
    stream.bytes += byteLength;
    this.totalBytes += byteLength;
    stream.output += text;
  }

  output(source: WorkflowWorkerOutputStream): string {
    return this.streams[source].output;
  }

  bytes(): number {
    return this.totalBytes;
  }
}

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
  const outputCapture = new WorkflowWorkerOutputCapture();
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
  ): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      if (read.value.byteLength > 0) options.onOutputActivity?.(source);
      const text = decoder.decode(read.value, { stream: true });
      outputCapture.append(source, text, read.value.byteLength);
      observeOutput(text);
    }
    const tail = decoder.decode();
    outputCapture.append(source, tail, 0);
    observeOutput(tail);
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
    const [exitCode] = await Promise.all([exit, stdout, stderr]);
    return {
      exitCode,
      stdout: outputCapture.output("stdout"),
      stderr: outputCapture.output("stderr"),
      durationMs: Date.now() - started,
      aborted,
      ...(earlyExit !== undefined ? { earlyExit } : {}),
    };
  } catch (error) {
    closeLease();
    await Promise.allSettled([exit, stdout, stderr]);
    throw error;
  } finally {
    closeLease();
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
};
