import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Buffer } from "node:buffer";
import { constants as osConstants } from "node:os";
import { type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

const TERM_GRACE_MS = 1_000;
const KILL_CONFIRMATION_MS = 1_000;
const PROCESS_POLL_MS = 20;

export interface WorkflowProcessGuardRequest {
  readonly cwd: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

type GuardedChild = ChildProcessByStdio<null, Readable, Readable>;

type ChildOutcome =
  | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly error: Error };

export class WorkflowProcessGuardError extends Error {
  override readonly name = "WorkflowProcessGuardError";
}

const encodeArgument = (value: string): string =>
  `v${Buffer.from(value, "utf8").toString("base64url")}`;

const decodeArgument = (value: string): string => {
  if (!/^v[A-Za-z0-9_-]*$/u.test(value)) {
    throw new WorkflowProcessGuardError("invalid workflow process guard argument encoding");
  }
  return Buffer.from(value.slice(1), "base64url").toString("utf8");
};

export const encodeWorkflowProcessGuardRequest = (
  request: WorkflowProcessGuardRequest,
): ReadonlyArray<string> => [
  encodeArgument(request.cwd),
  encodeArgument(request.command),
  ...request.args.map(encodeArgument),
];

export const decodeWorkflowProcessGuardRequest = (
  encodedCwd: string,
  encodedCommand: string,
  encodedArgs: ReadonlyArray<string>,
): WorkflowProcessGuardRequest => ({
  cwd: decodeArgument(encodedCwd),
  command: decodeArgument(encodedCommand),
  args: encodedArgs.map(decodeArgument),
});

export const workflowProcessGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw error;
  }
};

const signalProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw new WorkflowProcessGuardError(
      `failed to send ${signal} to workflow process group ${pid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const waitForWorkflowProcessGroupAbsence = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (workflowProcessGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(PROCESS_POLL_MS);
  }
  return true;
};

export interface WorkflowProcessGroupTerminationResult {
  readonly escalated: boolean;
  readonly alreadyAbsent: boolean;
}

export interface WorkflowProcessGroupTerminationOptions {
  readonly termGraceMs?: number;
  readonly killConfirmationMs?: number;
  readonly onEscalated?: () => void;
}

export const terminateWorkflowProcessGroup = async (
  pid: number,
  options: WorkflowProcessGroupTerminationOptions = {},
): Promise<WorkflowProcessGroupTerminationResult> => {
  if (!workflowProcessGroupExists(pid)) {
    return { escalated: false, alreadyAbsent: true };
  }

  signalProcessGroup(pid, "SIGTERM");
  if (await waitForWorkflowProcessGroupAbsence(pid, options.termGraceMs ?? TERM_GRACE_MS)) {
    return { escalated: false, alreadyAbsent: false };
  }

  signalProcessGroup(pid, "SIGKILL");
  let observerError: unknown;
  try {
    options.onEscalated?.();
  } catch (error) {
    observerError = error;
  }
  if (!(await waitForWorkflowProcessGroupAbsence(pid, options.killConfirmationMs ?? KILL_CONFIRMATION_MS))) {
    throw new WorkflowProcessGuardError(
      `workflow process group ${pid} remained present after SIGKILL confirmation`,
    );
  }
  if (observerError !== undefined) throw observerError;
  return { escalated: true, alreadyAbsent: false };
};

const waitForDirectChild = async (outcome: Promise<ChildOutcome>, pid: number): Promise<ChildOutcome> => {
  const timeout = Promise.withResolvers<ChildOutcome>();
  const timer = setTimeout(() => {
    timeout.reject(new WorkflowProcessGuardError(`workflow process ${pid} could not be reaped after group termination`));
  }, KILL_CONFIRMATION_MS);
  try {
    return await Promise.race([outcome, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
};

const terminateGuardedChild = async (
  child: GuardedChild,
  outcome: Promise<ChildOutcome>,
): Promise<void> => {
  const pid = child.pid;
  if (pid === undefined) {
    const directOutcome = await outcome;
    if ("error" in directOutcome) throw directOutcome.error;
    return;
  }

  await terminateWorkflowProcessGroup(pid);
  const directOutcome = await waitForDirectChild(outcome, pid);
  if ("error" in directOutcome) throw directOutcome.error;
};

const childExitCode = (outcome: Exclude<ChildOutcome, { readonly error: Error }>): number => {
  if (outcome.code !== null) return outcome.code;
  if (outcome.signal === null) return 1;
  return 128 + (osConstants.signals[outcome.signal] ?? 1);
};

/**
 * Own a detached workload process group for exactly as long as the caller keeps
 * this guard's stdin open. Every shutdown cause shares the same bounded group
 * termination and direct-child reap operation.
 */
export const runWorkflowProcessGuard = async (request: WorkflowProcessGuardRequest): Promise<number> => {
  const child = spawn(request.command, [...request.args], {
    cwd: request.cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const spawned = Promise.withResolvers<void>();
  const outcome = Promise.withResolvers<ChildOutcome>();
  child.once("spawn", spawned.resolve);
  child.once("error", (error) => {
    spawned.reject(error);
    outcome.resolve({ error });
  });
  child.once("exit", (code, signal) => outcome.resolve({ code, signal }));

  const terminationFailed = Promise.withResolvers<never>();
  let termination: Promise<void> | undefined;
  const requestTermination = (): void => {
    termination ??= terminateGuardedChild(child, outcome.promise);
    void termination.catch(terminationFailed.reject);
  };

  let leaseError: Error | undefined;
  const onLeaseEnd = (): void => requestTermination();
  const onLeaseError = (error: Error): void => {
    leaseError = error;
    requestTermination();
  };
  const onSignal = (): void => requestTermination();

  process.stdin.once("end", onLeaseEnd);
  process.stdin.once("close", onLeaseEnd);
  process.stdin.once("error", onLeaseError);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  process.once("SIGQUIT", onSignal);
  process.stdin.resume();

  try {
    await spawned.promise;

    const stdoutProxy = pipeline(child.stdout, process.stdout, { end: false }).then(
      () => undefined,
      (error: unknown) => {
        requestTermination();
        return error instanceof Error ? error : new Error(String(error));
      },
    );
    const stderrProxy = pipeline(child.stderr, process.stderr, { end: false }).then(
      () => undefined,
      (error: unknown) => {
        requestTermination();
        return error instanceof Error ? error : new Error(String(error));
      },
    );

    let directOutcome: ChildOutcome;
    try {
      directOutcome = await Promise.race([outcome.promise, terminationFailed.promise]);
    } catch (error) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      throw error;
    }
    requestTermination();

    let terminationError: unknown;
    try {
      await termination;
    } catch (error) {
      terminationError = error;
    }

    if (terminationError !== undefined) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      throw terminationError;
    }
    const [stdoutError, stderrError] = await Promise.all([stdoutProxy, stderrProxy]);
    if (stdoutError !== undefined) throw stdoutError;
    if (stderrError !== undefined) throw stderrError;
    if (leaseError !== undefined) throw leaseError;
    if ("error" in directOutcome) throw directOutcome.error;
    return childExitCode(directOutcome);
  } finally {
    process.stdin.removeListener("end", onLeaseEnd);
    process.stdin.removeListener("close", onLeaseEnd);
    process.stdin.removeListener("error", onLeaseError);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    process.removeListener("SIGQUIT", onSignal);
    process.stdin.pause();
  }
};
