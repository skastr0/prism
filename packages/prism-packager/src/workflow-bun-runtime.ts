import { WorkflowBunRuntimeUnavailableError } from "./workflow-errors.js";

interface WorkflowBunSpawnBaseOptions {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly detached?: boolean;
  /** A `number` redirects to that open file descriptor (e.g. a log file opened before spawn). */
  readonly stdout: "ignore" | "pipe" | number;
  readonly stderr: "ignore" | "pipe" | number;
}

export interface WorkflowBunSpawnOptions extends WorkflowBunSpawnBaseOptions {
  readonly stdin: "ignore";
}

export interface WorkflowBunPipedSpawnOptions extends WorkflowBunSpawnBaseOptions {
  readonly stdin: "pipe";
  readonly stdout: "pipe";
  readonly stderr: "pipe";
}

export interface WorkflowBunWritableStdin {
  end(error?: Error): number | Promise<number>;
}

export interface WorkflowBunSpawnedProcess {
  readonly pid?: number;
  readonly stdout?: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals | number): void;
  unref?(): void;
}

export interface WorkflowBunPipedSpawnedProcess extends WorkflowBunSpawnedProcess {
  readonly stdin: WorkflowBunWritableStdin;
  readonly stdout: ReadableStream<Uint8Array>;
}

export interface WorkflowBunRuntime {
  which(name: string): string | null;
  spawn(options: WorkflowBunSpawnOptions): WorkflowBunSpawnedProcess;
  spawn(options: WorkflowBunPipedSpawnOptions): WorkflowBunPipedSpawnedProcess;
}

export const workflowBunRuntime = (capability: string): WorkflowBunRuntime => {
  const bun = (globalThis as typeof globalThis & { readonly Bun?: Partial<WorkflowBunRuntime> }).Bun;
  if (bun?.spawn === undefined || bun.which === undefined) {
    throw new WorkflowBunRuntimeUnavailableError(capability);
  }
  return bun as WorkflowBunRuntime;
};
