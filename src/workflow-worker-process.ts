import { spawnWorkflowProcess } from "./workflow-runtime.js";

export interface WorkflowWorkerProcessOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly abortSignal?: AbortSignal;
  readonly processTimeoutMs?: number;
  readonly env?: Record<string, string>;
  readonly earlyExitPatterns?: ReadonlyArray<{
    readonly name: string;
    readonly pattern: RegExp;
  }>;
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

export const workflowWorkerProcessExcerpt = (stdout: string, stderr: string): string => {
  const transcript = `${stdout}\n${stderr}`.trim();
  return transcript.length > 0 ? `: ${transcript.slice(-512)}` : "";
};

export const runWorkflowWorkerProcess = async (
  options: WorkflowWorkerProcessOptions,
): Promise<WorkflowWorkerProcessResult> => {
  const started = Date.now();
  const child = spawnWorkflowProcess({
    cmd: [options.command, ...options.args],
    cwd: options.cwd,
    env: options.env === undefined ? undefined : { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let aborted = false;
  let earlyExit: string | undefined;
  const kill = () => child.kill("SIGKILL");
  let observedOutput = "";
  const observeOutput = (text: string): void => {
    if (earlyExit !== undefined || options.earlyExitPatterns === undefined || text.length === 0) return;
    observedOutput = `${observedOutput}${text}`.slice(-4096);
    const matched = options.earlyExitPatterns.find((candidate) => candidate.pattern.test(observedOutput));
    if (matched === undefined) return;
    earlyExit = matched.name;
    kill();
  };
  const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      const text = decoder.decode(read.value, { stream: true });
      output += text;
      observeOutput(text);
    }
    const tail = decoder.decode();
    output += tail;
    observeOutput(tail);
    return output;
  };
  const onAbort = () => {
    aborted = true;
    kill();
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
      kill();
    }, options.processTimeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readStream(child.stdout),
      readStream(child.stderr),
    ]);
    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      timedOut,
      aborted,
      ...(earlyExit !== undefined ? { earlyExit } : {}),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
};
