import { Database } from "bun:sqlite";

export type WorkflowDatabase = Database;

export interface WorkflowSpawnOptions {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdin: "ignore";
  readonly stdout: "ignore" | "pipe";
  readonly stderr: "ignore" | "pipe";
}

export interface WorkflowSpawnedProcess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals | number): void;
  unref(): void;
}

export const openWorkflowDatabase = (path: string): WorkflowDatabase =>
  new Database(path);

export const spawnWorkflowProcess = (options: WorkflowSpawnOptions): WorkflowSpawnedProcess =>
  Bun.spawn({
    cmd: [...options.cmd],
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  }) as WorkflowSpawnedProcess;

export const findWorkflowExecutable = (name: string): string | undefined => {
  const found = Bun.which(name);
  return found ?? undefined;
};
