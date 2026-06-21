import { resolveWorkflowTaskModel, type AnyWorkflowTask, type WorkflowPermissionMode, type WorkflowWorkerId } from "./workflows.js";
import { runAmpWorkflowTask } from "./workflow-amp-worker.js";
import { runClaudeWorkflowTask } from "./workflow-claude-worker.js";
import { runCodexWorkflowTask } from "./workflow-codex-worker.js";
import { runGrokWorkflowTask } from "./workflow-grok-worker.js";
import { runHermesWorkflowTask } from "./workflow-hermes-worker.js";
import { runKimiWorkflowTask } from "./workflow-kimi-worker.js";
import { runOpenCodeWorkflowTask } from "./workflow-opencode-worker.js";
import type { WorkflowTaskExecution, WorkflowTaskExecutionContext, WorkflowTaskExecutor } from "./workflow-runner.js";

export { WorkflowPermissionError } from "./workflow-permissions.js";

export interface WorkflowWorkerAdapterOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly profile?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
  readonly abortSignal?: AbortSignal;
  readonly context?: WorkflowTaskExecutionContext;
}

export interface WorkflowWorkerAdapter {
  readonly id: string;
  readonly runTask: (
    task: AnyWorkflowTask,
    options: WorkflowWorkerAdapterOptions,
  ) => Promise<WorkflowTaskExecution>;
  readonly continueTask?: (
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
  "amp-code": {
    id: "amp-code",
    runTask: (task, options) => runAmpWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "amp-code", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
    }),
  },
  "claude-code": {
    id: "claude-code",
    runTask: (task, options) => runClaudeWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "claude-code", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      restrictedTools: options.restrictedTools,
      abortSignal: options.abortSignal,
    }),
    continueTask: (task, options) => runClaudeWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "claude-code", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      restrictedTools: options.restrictedTools,
      abortSignal: options.abortSignal,
      repair: options.context?.repair,
    }),
  },
  "codex-cli": {
    id: "codex-cli",
    runTask: (task, options) => runCodexWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "codex-cli", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
    }),
  },
  grok: {
    id: "grok",
    runTask: (task, options) => runGrokWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "grok", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
    }),
  },
  hermes: {
    id: "hermes",
    runTask: (task, options) => runHermesWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "hermes", fallbackModel: options.model }),
      profile: task.worker?.profile ?? options.profile,
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
    }),
  },
  "kimi-code": {
    id: "kimi-code",
    runTask: (task, options) => runKimiWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "kimi-code", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
    }),
  },
  opencode: {
    id: "opencode",
    runTask: (task, options) => runOpenCodeWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "opencode", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
    }),
  },
} as const satisfies Record<WorkflowWorkerId, WorkflowWorkerAdapter>;

export const supportedWorkflowWorkers = (): ReadonlyArray<string> =>
  Object.keys(workflowWorkerAdapters).sort();

export const getWorkflowWorkerAdapter = (worker: string): WorkflowWorkerAdapter => {
  const adapter = workflowWorkerAdapters[worker as keyof typeof workflowWorkerAdapters];
  if (adapter === undefined) {
    throw new UnsupportedWorkflowWorkerError(worker, supportedWorkflowWorkers());
  }
  return adapter;
};

export const resolveWorkflowTaskPermission = (
  task: AnyWorkflowTask,
  fallbackPermission?: WorkflowPermissionMode,
): WorkflowPermissionMode =>
  task.worker?.permission ?? fallbackPermission ?? "permissive";

export const createWorkflowWorkerExecutor = (input: {
  readonly worker?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly fallbackPermission?: WorkflowPermissionMode;
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
    const resolvedPermission = resolveWorkflowTaskPermission(task, input.fallbackPermission);
    const options = {
      cwd: input.cwd,
      model: input.model,
      resolvedPermission,
      restrictedTools: task.worker?.restrictedTools,
      abortSignal: context?.abortSignal,
      context,
    };
    if (context?.repair?.mode === "native-continuation" && adapter.continueTask !== undefined) {
      return adapter.continueTask(task, options);
    }
    return adapter.runTask(task, options);
  };
};
