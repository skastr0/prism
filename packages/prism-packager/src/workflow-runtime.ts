import { createRequire } from "node:module";
import {
  workflowBunRuntime,
  type WorkflowBunPipedSpawnOptions,
  type WorkflowBunPipedSpawnedProcess,
  type WorkflowBunSpawnedProcess,
  type WorkflowBunSpawnOptions,
} from "./workflow-bun-runtime.js";
import { WorkflowBunRuntimeUnavailableError } from "./workflow-errors.js";

const require = createRequire(import.meta.url);

export interface WorkflowDatabaseQuery<Row, Params extends ReadonlyArray<unknown>> {
  get(...params: Params): Row | null;
  all(...params: Params): Row[];
  run(...params: Params): unknown;
}

export interface WorkflowDatabase {
  exec(statement: string): unknown;
  close(): void;
  query<Row = unknown, Params extends ReadonlyArray<unknown> = ReadonlyArray<unknown>>(
    statement: string,
  ): WorkflowDatabaseQuery<Row, Params>;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

export interface WorkflowSpawnOptions extends WorkflowBunSpawnOptions {
  readonly cwd: string;
}

export interface WorkflowPipedSpawnOptions extends WorkflowBunPipedSpawnOptions {
  readonly cwd: string;
}

export interface WorkflowSpawnedProcess extends WorkflowBunSpawnedProcess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  unref(): void;
}

export interface WorkflowPipedSpawnedProcess extends WorkflowBunPipedSpawnedProcess {
  readonly pid: number;
  readonly stderr: ReadableStream<Uint8Array>;
  unref(): void;
}

const loadBunSqlite = (): { readonly Database: new (path: string) => WorkflowDatabase } => {
  try {
    return require("bun:sqlite") as { readonly Database: new (path: string) => WorkflowDatabase };
  } catch (error) {
    throw new WorkflowBunRuntimeUnavailableError("persistent store", error);
  }
};

export const openWorkflowDatabase = (path: string): WorkflowDatabase => {
  const { Database } = loadBunSqlite();
  return new Database(path);
};

export function spawnWorkflowProcess(options: WorkflowPipedSpawnOptions): WorkflowPipedSpawnedProcess;
export function spawnWorkflowProcess(options: WorkflowSpawnOptions): WorkflowSpawnedProcess;
export function spawnWorkflowProcess(
  options: WorkflowSpawnOptions | WorkflowPipedSpawnOptions,
): WorkflowSpawnedProcess | WorkflowPipedSpawnedProcess {
  const spawnOptions = {
    cmd: [...options.cmd],
    cwd: options.cwd,
    env: options.env,
    ...(options.detached !== undefined ? { detached: options.detached } : {}),
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  };
  if (spawnOptions.stdin === "pipe") {
    return workflowBunRuntime("process spawning").spawn(
      spawnOptions as WorkflowBunPipedSpawnOptions,
    ) as WorkflowPipedSpawnedProcess;
  }
  return workflowBunRuntime("process spawning").spawn(
    spawnOptions as WorkflowBunSpawnOptions,
  ) as WorkflowSpawnedProcess;
}

export const findWorkflowExecutable = (name: string): string | undefined => {
  const found = workflowBunRuntime("executable discovery").which(name);
  return found ?? undefined;
};
