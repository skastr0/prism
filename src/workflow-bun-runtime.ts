import { WorkflowBunRuntimeUnavailableError } from "./workflow-errors.js";

export interface WorkflowBunSpawnOptions {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdin: "ignore";
  readonly stdout: "ignore" | "pipe";
  readonly stderr: "ignore" | "pipe";
}

export interface WorkflowBunSpawnedProcess {
  readonly pid?: number;
  readonly stdout?: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals | number): void;
  unref?(): void;
}

export interface WorkflowBunRuntime {
  which(name: string): string | null;
  spawn(options: WorkflowBunSpawnOptions): WorkflowBunSpawnedProcess;
}

export const workflowBunRuntime = (capability: string): WorkflowBunRuntime => {
  const bun = (globalThis as typeof globalThis & { readonly Bun?: Partial<WorkflowBunRuntime> }).Bun;
  if (bun?.spawn === undefined || bun.which === undefined) {
    throw new WorkflowBunRuntimeUnavailableError(capability);
  }
  return bun as WorkflowBunRuntime;
};
