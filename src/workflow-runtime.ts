import { createRequire } from "node:module";
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

interface BunRuntime {
  which(name: string): string | null;
  spawn(options: WorkflowSpawnOptions): WorkflowSpawnedProcess;
}

const bunRuntime = (capability: string): BunRuntime => {
  const bun = (globalThis as typeof globalThis & { readonly Bun?: Partial<BunRuntime> }).Bun;
  if (bun?.spawn === undefined || bun.which === undefined) {
    throw new WorkflowBunRuntimeUnavailableError(capability);
  }
  return bun as BunRuntime;
};

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

export const spawnWorkflowProcess = (options: WorkflowSpawnOptions): WorkflowSpawnedProcess =>
  bunRuntime("process spawning").spawn({
    cmd: [...options.cmd],
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  }) as WorkflowSpawnedProcess;

export const findWorkflowExecutable = (name: string): string | undefined => {
  const found = bunRuntime("executable discovery").which(name);
  return found ?? undefined;
};
