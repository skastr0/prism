import { resolveWorkflowTaskModel, type AnyWorkflowTask, type WorkflowPermissionMode, type WorkflowWorkerId } from "./workflows.js";
import { runAmpWorkflowTask } from "./workflow-amp-worker.js";
import { resolveAntigravityPermission, runAntigravityWorkflowTask } from "./workflow-antigravity-worker.js";
import { runClaudeWorkflowTask } from "./workflow-claude-worker.js";
import { runCodexWorkflowTask } from "./workflow-codex-worker.js";
import { runGrokWorkflowTask } from "./workflow-grok-worker.js";
import { runHermesWorkflowTask } from "./workflow-hermes-worker.js";
import { runKimiWorkflowTask } from "./workflow-kimi-worker.js";
import { runOpenCodeWorkflowTask } from "./workflow-opencode-worker.js";
import type { WorkflowTaskExecution, WorkflowTaskExecutionContext, WorkflowTaskExecutor } from "./workflow-runner.js";
import { workflowContinuationAdapterForWorker } from "./workflow-session.js";

export { WorkflowPermissionError } from "./workflow-permissions.js";

export interface WorkflowWorkerAdapterOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly profile?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly context?: WorkflowTaskExecutionContext;
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

export class WorkflowWorkerContinuationError extends Error {
  override readonly name = "WorkflowWorkerContinuationError";
}

const workflowWorkerAdapters = {
  "amp-code": {
    id: "amp-code",
    runTask: (task, options) => runAmpWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "amp-code", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      processTimeoutMs: task.worker?.processTimeoutMs ?? options.processTimeoutMs,
      abortSignal: options.abortSignal,
      repair: options.context?.repair,
    }),
  },
  "antigravity-cli": {
    id: "antigravity-cli",
    runTask: (task, options) => runAntigravityWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "antigravity-cli", fallbackModel: options.model }),
      resolvedPermission: resolveAntigravityPermission(options.resolvedPermission),
      processTimeoutMs: task.worker?.processTimeoutMs ?? options.processTimeoutMs,
      abortSignal: options.abortSignal,
      repair: options.context?.repair,
    }),
  },
  "claude-code": {
    id: "claude-code",
    runTask: (task, options) => runClaudeWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "claude-code", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      restrictedTools: options.restrictedTools,
      processTimeoutMs: task.worker?.processTimeoutMs ?? options.processTimeoutMs,
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
      processTimeoutMs: task.worker?.processTimeoutMs ?? options.processTimeoutMs,
      abortSignal: options.abortSignal,
      repair: options.context?.repair,
    }),
  },
  grok: {
    id: "grok",
    runTask: (task, options) => runGrokWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "grok", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      processTimeoutMs: task.worker?.processTimeoutMs ?? options.processTimeoutMs,
      abortSignal: options.abortSignal,
      repair: options.context?.repair,
    }),
  },
  hermes: {
    id: "hermes",
    runTask: (task, options) => runHermesWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "hermes", fallbackModel: options.model }),
      profile: task.worker?.profile ?? options.profile,
      resolvedPermission: options.resolvedPermission,
      processTimeoutMs: task.worker?.processTimeoutMs ?? options.processTimeoutMs,
      abortSignal: options.abortSignal,
      repair: options.context?.repair,
    }),
  },
  "kimi-code": {
    id: "kimi-code",
    runTask: (task, options) => runKimiWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "kimi-code", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      processTimeoutMs: task.worker?.processTimeoutMs ?? options.processTimeoutMs,
      abortSignal: options.abortSignal,
      repair: options.context?.repair,
    }),
  },
  opencode: {
    id: "opencode",
    runTask: (task, options) => runOpenCodeWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "opencode", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      processTimeoutMs: task.worker?.processTimeoutMs ?? options.processTimeoutMs,
      abortSignal: options.abortSignal,
      repair: options.context?.repair,
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
  readonly taskTimeoutMs?: number;
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
      processTimeoutMs: task.worker?.processTimeoutMs ?? input.taskTimeoutMs,
      abortSignal: context?.abortSignal,
      context,
    };
    if (context?.repair !== undefined && context.repair.mode !== "native-continuation") {
      throw new WorkflowWorkerContinuationError(
        `workflow worker '${worker}' repair requires stable sessionId (${context.repair.fallbackReason})`,
      );
    }
    if (context?.repair?.mode === "native-continuation") {
      const expectedAdapter = workflowContinuationAdapterForWorker(worker);
      if (expectedAdapter !== undefined && context.repair.continuation.adapter !== expectedAdapter) {
        throw new WorkflowWorkerContinuationError(
          `workflow worker '${worker}' cannot continue adapter '${context.repair.continuation.adapter}' session '${context.repair.continuation.sessionId}'`,
        );
      }
    }
    return adapter.runTask(task, options);
  };
};
