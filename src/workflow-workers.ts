import type { AnyWorkflowTask } from "./workflows.js";
import { runAntigravityWorkflowTask } from "./workflow-antigravity-worker.js";
import { runAmpWorkflowTask } from "./workflow-amp-worker.js";
import { runClaudeWorkflowTask } from "./workflow-claude-worker.js";
import { runCodexWorkflowTask } from "./workflow-codex-worker.js";
import { runGrokWorkflowTask } from "./workflow-grok-worker.js";
import { runHermesWorkflowTask } from "./workflow-hermes-worker.js";
import { runKimiWorkflowTask } from "./workflow-kimi-worker.js";
import { runOpenCodeWorkflowTask } from "./workflow-opencode-worker.js";
import type { WorkflowTaskExecution, WorkflowTaskExecutionContext, WorkflowTaskExecutor } from "./workflow-runner.js";

export interface WorkflowWorkerAdapterOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly profile?: string;
  readonly abortSignal?: AbortSignal;
}

export interface WorkflowWorkerAdapter {
  readonly id: string;
  readonly runTask: (
    task: AnyWorkflowTask,
    options: WorkflowWorkerAdapterOptions,
  ) => Promise<WorkflowTaskExecution>;
}

export class UnsupportedWorkflowWorkerError extends Error {
  override readonly name = "UnsupportedWorkflowWorkerError";
  constructor(
    readonly worker: string,
    readonly supportedWorkers: ReadonlyArray<string>,
  ) {
    super(`unsupported workflow worker '${worker}'. Supported workers: ${supportedWorkers.join(", ")}`);
  }
}

const workflowWorkerAdapters = {
  "antigravity-cli": {
    id: "antigravity-cli",
    runTask: (task, options) => runAntigravityWorkflowTask(task, {
      cwd: options.cwd,
      model: task.worker?.model ?? options.model,
      abortSignal: options.abortSignal,
    }),
  },
  "amp-code": {
    id: "amp-code",
    runTask: (task, options) => runAmpWorkflowTask(task, {
      cwd: options.cwd,
      model: task.worker?.model ?? options.model,
      abortSignal: options.abortSignal,
    }),
  },
  "claude-code": {
    id: "claude-code",
    runTask: (task, options) => runClaudeWorkflowTask(task, {
      cwd: options.cwd,
      model: task.worker?.model ?? options.model,
      abortSignal: options.abortSignal,
    }),
  },
  "codex-cli": {
    id: "codex-cli",
    runTask: (task, options) => runCodexWorkflowTask(task, {
      cwd: options.cwd,
      model: task.worker?.model ?? options.model,
      abortSignal: options.abortSignal,
    }),
  },
  grok: {
    id: "grok",
    runTask: (task, options) => runGrokWorkflowTask(task, {
      cwd: options.cwd,
      model: task.worker?.model ?? options.model,
      abortSignal: options.abortSignal,
    }),
  },
  hermes: {
    id: "hermes",
    runTask: (task, options) => runHermesWorkflowTask(task, {
      cwd: options.cwd,
      model: task.worker?.model ?? options.model,
      profile: task.worker?.profile ?? options.profile,
      abortSignal: options.abortSignal,
    }),
  },
  "kimi-code": {
    id: "kimi-code",
    runTask: (task, options) => runKimiWorkflowTask(task, {
      cwd: options.cwd,
      model: task.worker?.model ?? options.model,
      abortSignal: options.abortSignal,
    }),
  },
  opencode: {
    id: "opencode",
    runTask: (task, options) => runOpenCodeWorkflowTask(task, {
      cwd: options.cwd,
      model: task.worker?.model ?? options.model,
      abortSignal: options.abortSignal,
    }),
  },
} as const satisfies Record<string, WorkflowWorkerAdapter>;

export const supportedWorkflowWorkers = (): ReadonlyArray<string> =>
  Object.keys(workflowWorkerAdapters).sort();

export const getWorkflowWorkerAdapter = (worker: string): WorkflowWorkerAdapter => {
  const adapter = workflowWorkerAdapters[worker as keyof typeof workflowWorkerAdapters];
  if (adapter === undefined) {
    throw new UnsupportedWorkflowWorkerError(worker, supportedWorkflowWorkers());
  }
  return adapter;
};

export const createWorkflowWorkerExecutor = (input: {
  readonly worker?: string;
  readonly cwd: string;
  readonly model?: string;
}): WorkflowTaskExecutor => {
  if (input.worker !== undefined) {
    getWorkflowWorkerAdapter(input.worker);
  }
  return (task, context?: WorkflowTaskExecutionContext) => {
    const worker = task.worker?.worker ?? input.worker;
    if (worker === undefined) {
      throw new UnsupportedWorkflowWorkerError("<missing>", supportedWorkflowWorkers());
    }
    const adapter = getWorkflowWorkerAdapter(worker);
    return adapter.runTask(task, { cwd: input.cwd, model: input.model, abortSignal: context?.abortSignal });
  };
};
