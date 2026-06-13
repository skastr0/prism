export interface WorkflowWorkerProcessOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly abortSignal?: AbortSignal;
  readonly processTimeoutMs?: number;
}

export interface WorkflowWorkerProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
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
  const child = Bun.spawn({
    cmd: [options.command, ...options.args],
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let aborted = false;
  const kill = () => child.kill("SIGKILL");
  const onAbort = () => {
    aborted = true;
    kill();
  };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timeout = options.processTimeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true;
      kill();
    }, options.processTimeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      timedOut,
      aborted,
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
};
