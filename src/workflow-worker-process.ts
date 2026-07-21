import { currentCliCommand } from "./workflow-cli-command.js";
import { encodeWorkflowProcessGuardRequest } from "./workflow-process-guard.js";
import { spawnWorkflowProcess } from "./workflow-runtime.js";

export interface WorkflowWorkerProcessOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly abortSignal?: AbortSignal;
  readonly processTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: Record<string, string>;
  readonly onOutputActivity?: (stream: WorkflowWorkerOutputStream) => void;
  readonly earlyExitPatterns?: ReadonlyArray<{
    readonly name: string;
    readonly pattern: RegExp;
  }>;
}

export type WorkflowWorkerOutputStream = "stdout" | "stderr";

export const DEFAULT_WORKFLOW_WORKER_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_WORKFLOW_WORKER_OUTPUT_EXCERPT_BYTES = 4096;

interface WorkflowWorkerOutputCaptureState {
  bytes: number;
  output: string;
  excerpt: string;
}

export interface WorkflowWorkerOutputLimitMetadata extends Record<string, unknown> {
  readonly outputLimitBytes: number;
  readonly outputBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutExcerpt?: string;
  readonly stderrExcerpt?: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export class WorkflowWorkerOutputLimitError extends Error {
  override readonly name = "WorkflowWorkerOutputLimitError";
  readonly metadata: WorkflowWorkerOutputLimitMetadata;

  constructor(
    readonly limitBytes: number,
    readonly observedBytes: number,
    metadata: WorkflowWorkerOutputLimitMetadata,
  ) {
    super(
      `workflow worker output exceeded ${limitBytes} bytes (observed ${observedBytes}); reduce worker output or raise PRISM_WORKFLOW_WORKER_OUTPUT_MAX_BYTES deliberately`,
    );
    this.metadata = metadata;
  }
}

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

const utf8Tail = (value: string, maxBytes: number): string => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  return encoded
    .subarray(encoded.byteLength - maxBytes)
    .toString("utf8")
    .replace(/^\uFFFD+/u, "");
};

export const resolveWorkflowWorkerOutputLimit = (explicit: number | undefined): number => {
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit) || !Number.isInteger(explicit) || explicit <= 0) {
      throw new RangeError("maxOutputBytes must be a finite positive integer");
    }
    return explicit;
  }
  const configured = process.env.PRISM_WORKFLOW_WORKER_OUTPUT_MAX_BYTES;
  if (configured === undefined) return DEFAULT_WORKFLOW_WORKER_OUTPUT_BYTES;
  const parsed = parsePositiveInteger(configured);
  if (parsed === undefined) {
    throw new RangeError("PRISM_WORKFLOW_WORKER_OUTPUT_MAX_BYTES must be a finite positive integer");
  }
  return parsed;
};

export class WorkflowWorkerOutputCapture {
  readonly maxBytes: number;
  private readonly onLimit: () => void;
  private readonly streams: Record<WorkflowWorkerOutputStream, WorkflowWorkerOutputCaptureState> = {
    stdout: { bytes: 0, output: "", excerpt: "" },
    stderr: { bytes: 0, output: "", excerpt: "" },
  };
  private totalBytes = 0;
  private exceeded = false;

  constructor(options: { readonly maxBytes?: number; readonly onLimit: () => void }) {
    this.maxBytes = resolveWorkflowWorkerOutputLimit(options.maxBytes);
    this.onLimit = options.onLimit;
  }

  append(source: WorkflowWorkerOutputStream, text: string, byteLength = Buffer.byteLength(text, "utf8")): void {
    const stream = this.streams[source];
    stream.bytes += byteLength;
    this.totalBytes += byteLength;
    stream.excerpt = utf8Tail(
      `${stream.excerpt}${text}`,
      DEFAULT_WORKFLOW_WORKER_OUTPUT_EXCERPT_BYTES,
    );
    if (!this.exceeded && this.totalBytes <= this.maxBytes) {
      stream.output += text;
      return;
    }
    if (this.exceeded) return;
    this.exceeded = true;
    this.onLimit();
  }

  output(source: WorkflowWorkerOutputStream): string {
    return this.streams[source].output;
  }

  limitError(): WorkflowWorkerOutputLimitError | undefined {
    if (!this.exceeded) return undefined;
    const stdout = this.streams.stdout;
    const stderr = this.streams.stderr;
    const metadata: WorkflowWorkerOutputLimitMetadata = {
      outputLimitBytes: this.maxBytes,
      outputBytes: this.totalBytes,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.bytes > Buffer.byteLength(stdout.excerpt, "utf8"),
      stderrTruncated: stderr.bytes > Buffer.byteLength(stderr.excerpt, "utf8"),
      ...(stdout.excerpt.length > 0 ? { stdoutExcerpt: stdout.excerpt } : {}),
      ...(stderr.excerpt.length > 0 ? { stderrExcerpt: stderr.excerpt } : {}),
    };
    return new WorkflowWorkerOutputLimitError(this.maxBytes, this.totalBytes, metadata);
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
  const maxOutputBytes = resolveWorkflowWorkerOutputLimit(options.maxOutputBytes);
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
  const outputCapture = new WorkflowWorkerOutputCapture({
    maxBytes: maxOutputBytes,
    onLimit: closeLease,
  });
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
    const [exitCode] = await Promise.all([exit, stdout, stderr]);
    const outputLimitError = outputCapture.limitError();
    if (outputLimitError !== undefined) throw outputLimitError;
    return {
      exitCode,
      stdout: outputCapture.output("stdout"),
      stderr: outputCapture.output("stderr"),
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
