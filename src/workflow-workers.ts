import {
  resolveWorkflowTaskModel,
  resolveWorkflowTaskModelResolution,
  resolveWorkflowTaskEffort,
  resolveWorkflowTaskSessionPersistence,
  type AnyWorkflowWorkerTask,
  type WorkflowPermissionMode,
  type WorkflowWorkerId,
} from "./workflows.js";
import { assertAmpPermission, runAmpWorkflowTask } from "./workflow-amp-worker.js";
import { assertAmpRemotePermission, runAmpOrbWorkflowTask, runAmpRunnerWorkflowTask } from "./workflow-amp-remote-worker.js";
import { resolveAntigravityPermission, runAntigravityWorkflowTask } from "./workflow-antigravity-worker.js";
import { buildClaudeArgs, runClaudeWorkflowTask } from "./workflow-claude-worker.js";
import { buildCodexArgs, runCodexWorkflowTask } from "./workflow-codex-worker.js";
import { buildCursorArgs, runCursorWorkflowTask } from "./workflow-cursor-worker.js";
import { buildGrokArgs, runGrokWorkflowTask } from "./workflow-grok-worker.js";
import { buildHermesArgs, runHermesWorkflowTask } from "./workflow-hermes-worker.js";
import { mapDevinPermissionMode, runDevinWorkflowTask } from "./workflow-devin-worker.js";
import { buildKimiArgs, runKimiWorkflowTask } from "./workflow-kimi-worker.js";
import { buildOpenCodeArgs, runOpenCodeWorkflowTask } from "./workflow-opencode-worker.js";
import { buildOmpArgs, runOmpWorkflowTask } from "./workflow-omp-worker.js";
import type {
  WorkflowTaskExecution,
  WorkflowTaskExecutionContext,
  WorkflowTaskExecutionContextWithoutRepair,
  WorkflowWorkerTaskExecutor,
} from "./workflow-runner.js";
import {
  workflowContinuationAdapterForWorker,
  type WorkflowRepairLoopContinuationCapability,
  type WorkflowRepairLoopContinuationCapabilityForWorker,
} from "./workflow-session.js";

export { WorkflowPermissionError } from "./workflow-permissions.js";

export interface WorkflowWorkerAdapterOptionsBase {
  readonly cwd: string;
  readonly model?: string;
  readonly profile?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly restrictedTools?: readonly string[];
  readonly abortSignal?: AbortSignal;
}

export type WorkflowWorkerAdapterOptionsForCapability<Capability extends WorkflowRepairLoopContinuationCapability> =
  WorkflowWorkerAdapterOptionsBase & (
    Capability extends "stable-session-repair-loop"
      ? { readonly context?: WorkflowTaskExecutionContext }
      : { readonly context?: WorkflowTaskExecutionContextWithoutRepair }
  );

export type WorkflowWorkerAdapterOptions<Worker extends WorkflowWorkerId = WorkflowWorkerId> =
  WorkflowWorkerAdapterOptionsForCapability<WorkflowRepairLoopContinuationCapabilityForWorker<Worker>>;

export interface WorkflowWorkerAdapter<Worker extends WorkflowWorkerId = WorkflowWorkerId> {
  readonly id: Worker;
  readonly runTask: (
    task: AnyWorkflowWorkerTask,
    options: WorkflowWorkerAdapterOptions<Worker>,
  ) => Promise<WorkflowTaskExecution>;
}

type WorkflowWorkerAdapterRegistry = {
  readonly [Worker in WorkflowWorkerId]: WorkflowWorkerAdapter<Worker>;
};

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
      catalogModel: task.worker?.worker === "amp-code" ? task.worker.catalogModel : undefined,
      effort: resolveWorkflowTaskEffort(task, { worker: "amp-code", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
      reportProgress: options.context?.reportProgress,
      repair: options.context?.repair,
    }),
  },
  "amp-orb": {
    id: "amp-orb",
    runTask: (task, options) => runAmpOrbWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "amp-orb", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
      reportProgress: options.context?.reportProgress,
      repair: options.context?.repair,
    }),
  },
  "amp-runner": {
    id: "amp-runner",
    runTask: (task, options) => runAmpRunnerWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "amp-runner", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
      reportProgress: options.context?.reportProgress,
      repair: options.context?.repair,
    }),
  },
  "antigravity-cli": {
    id: "antigravity-cli",
    runTask: (task, options) => runAntigravityWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "antigravity-cli", fallbackModel: options.model }),
      effort: resolveWorkflowTaskEffort(task, { worker: "antigravity-cli", fallbackModel: options.model }),
      resolvedPermission: resolveAntigravityPermission(options.resolvedPermission),
      abortSignal: options.abortSignal,
      reportProgress: options.context?.reportProgress,
      repair: options.context?.repair,
    }),
  },
  "claude-code": {
    id: "claude-code",
    runTask: (task, options) => runClaudeWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "claude-code", fallbackModel: options.model }),
      effort: resolveWorkflowTaskEffort(task, { worker: "claude-code", fallbackModel: options.model }),
      sessionPersistence: resolveWorkflowTaskSessionPersistence(task, "claude-code"),
      resolvedPermission: options.resolvedPermission,
      restrictedTools: options.restrictedTools,
      abortSignal: options.abortSignal,
      reportProgress: options.context?.reportProgress,
      repair: options.context?.repair,
    }),
  },
  "codex-cli": {
    id: "codex-cli",
    runTask: (task, options) => {
      const resolution = resolveWorkflowTaskModelResolution(task, {
        worker: "codex-cli",
        fallbackModel: options.model,
      });
      return runCodexWorkflowTask(task, {
        cwd: options.cwd,
        model: resolution?.model,
        effort: resolveWorkflowTaskEffort(task, { worker: "codex-cli", fallbackModel: options.model }),
        sessionPersistence: resolveWorkflowTaskSessionPersistence(task, "codex-cli"),
        resolvedPermission: options.resolvedPermission,
        abortSignal: options.abortSignal,
        reportProgress: options.context?.reportProgress,
        repair: options.context?.repair,
      });
    },
  },
  cursor: {
    id: "cursor",
    runTask: (task, options) => runCursorWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "cursor", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
      reportProgress: options.context?.reportProgress,
      repair: options.context?.repair,
    }),
  },
  grok: {
    id: "grok",
    runTask: (task, options) => runGrokWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "grok", fallbackModel: options.model }),
      effort: resolveWorkflowTaskEffort(task, { worker: "grok", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
      reportProgress: options.context?.reportProgress,
      repair: options.context?.repair,
    }),
  },
  hermes: {
    id: "hermes",
    runTask: (task, options) => {
      const resolution = resolveWorkflowTaskModelResolution(task, { worker: "hermes", fallbackModel: options.model });
      return runHermesWorkflowTask(task, {
        cwd: options.cwd,
        model: resolution?.model,
        provider: resolution?.provider,
        profile: task.worker?.profile ?? options.profile,
        effort: resolveWorkflowTaskEffort(task, { worker: "hermes", fallbackModel: options.model }),
        resolvedPermission: options.resolvedPermission,
        abortSignal: options.abortSignal,
        reportProgress: options.context?.reportProgress,
        repair: options.context?.repair,
      });
    },
  },
  "kimi-code": {
    id: "kimi-code",
    runTask: (task, options) => runKimiWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "kimi-code", fallbackModel: options.model }),
      effort: resolveWorkflowTaskEffort(task, { worker: "kimi-code", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
      reportProgress: options.context?.reportProgress,
      repair: options.context?.repair,
    }),
  },
  devin: {
    id: "devin",
    runTask: (task, options) => runDevinWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "devin", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
      reportProgress: options.context?.reportProgress,
      repair: options.context?.repair,
    }),
  },
  opencode: {
    id: "opencode",
    runTask: (task, options) => runOpenCodeWorkflowTask(task, {
      cwd: options.cwd,
      model: resolveWorkflowTaskModel(task, { worker: "opencode", fallbackModel: options.model }),
      resolvedPermission: options.resolvedPermission,
      abortSignal: options.abortSignal,
      reportProgress: options.context?.reportProgress,
      repair: options.context?.repair,
    }),
  },
  omp: {
    id: "omp",
    runTask: (task, options) => {
      const resolution = resolveWorkflowTaskModelResolution(task, {
        worker: "omp",
        fallbackModel: options.model,
      });
      return runOmpWorkflowTask(task, {
        cwd: options.cwd,
        model: resolution?.model,
        provider: resolution?.provider,
        profile: task.worker?.profile ?? options.profile,
        effort: resolveWorkflowTaskEffort(task, { worker: "omp", fallbackModel: options.model }),
        sessionPersistence: resolveWorkflowTaskSessionPersistence(task, "omp"),
        resolvedPermission: options.resolvedPermission,
        restrictedTools: options.restrictedTools,
        abortSignal: options.abortSignal,
        reportProgress: options.context?.reportProgress,
        repair: options.context?.repair,
      });
    },
  },
} as const satisfies WorkflowWorkerAdapterRegistry;

export const supportedWorkflowWorkers = (): ReadonlyArray<string> =>
  Object.keys(workflowWorkerAdapters).sort();

export function getWorkflowWorkerAdapter<Worker extends WorkflowWorkerId>(worker: Worker): WorkflowWorkerAdapter<Worker>;
export function getWorkflowWorkerAdapter(worker: string): WorkflowWorkerAdapter;
export function getWorkflowWorkerAdapter(worker: string): WorkflowWorkerAdapter {
  const adapter = workflowWorkerAdapters[worker as keyof typeof workflowWorkerAdapters];
  if (adapter === undefined) {
    throw new UnsupportedWorkflowWorkerError(worker, supportedWorkflowWorkers());
  }
  return adapter as WorkflowWorkerAdapter;
}

export const resolveWorkflowTaskPermission = (
  task: AnyWorkflowWorkerTask,
  fallbackPermission?: WorkflowPermissionMode,
): WorkflowPermissionMode =>
  task.worker?.permission ?? fallbackPermission ?? "permissive";

/** Same argv interpreters run uses. Validate calls this so illegal pins fail before spend. */
export const assertWorkflowWorkerPermission = (
  worker: string,
  mode: WorkflowPermissionMode,
  restrictedTools?: readonly string[],
): void => {
  switch (worker) {
    case "amp-code":
      assertAmpPermission(mode);
      return;
    case "amp-orb":
    case "amp-runner":
      // Remote executors accept only `legacy`; other modes fail closed here so
      // validation rejects them before any dispatch.
      assertAmpRemotePermission(worker, mode);
      return;
    case "antigravity-cli":
      resolveAntigravityPermission(mode);
      return;
    case "claude-code":
      buildClaudeArgs({ prompt: "p", permission: mode, restrictedTools });
      return;
    case "codex-cli":
      buildCodexArgs({ cwd: "/", outputPath: "/tmp/o", prompt: "p", permission: mode });
      return;
    case "cursor":
      buildCursorArgs({ cwd: "/", prompt: "p", permission: mode });
      return;
    case "devin":
      mapDevinPermissionMode(mode);
      return;
    case "grok":
      buildGrokArgs({ cwd: "/", prompt: "p", permission: mode });
      return;
    case "hermes":
      buildHermesArgs({ prompt: "p", permission: mode });
      return;
    case "kimi-code":
      buildKimiArgs({ prompt: "p", permission: mode });
      return;
    case "omp":
      buildOmpArgs({
        cwd: "/",
        prompt: "p",
        permission: mode,
        restrictedTools,
      });
      return;
    case "opencode":
      buildOpenCodeArgs({ prompt: "p", permission: mode });
      return;
    default:
      return;
  }
};

export const createWorkflowWorkerExecutor = (input: {
  readonly worker?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly fallbackPermission?: WorkflowPermissionMode;
}): WorkflowWorkerTaskExecutor => {
  if (input.worker !== undefined) {
    getWorkflowWorkerAdapter(input.worker);
  }
  return (task, context?: WorkflowTaskExecutionContext) => {
    const worker = task.worker?.worker ?? input.worker;
    if (worker === undefined) {
      throw new UnsupportedWorkflowWorkerError("<missing>", supportedWorkflowWorkers());
    }
    const resolvedPermission = resolveWorkflowTaskPermission(task, input.fallbackPermission);
    const commonOptions = {
      cwd: input.cwd,
      model: input.model,
      resolvedPermission,
      restrictedTools: task.worker?.restrictedTools,
      abortSignal: context?.abortSignal,
    };
    if (context?.repair?.mode === "native-continuation") {
      const expectedAdapter = workflowContinuationAdapterForWorker(worker);
      if (expectedAdapter !== undefined && context.repair.continuation.adapter !== expectedAdapter) {
        throw new WorkflowWorkerContinuationError(
          `workflow worker '${worker}' cannot continue adapter '${context.repair.continuation.adapter}' session '${context.repair.continuation.sessionId}'`,
        );
      }
      return getWorkflowWorkerAdapter(worker).runTask(task, {
        ...commonOptions,
        context,
      });
    }

    // Fresh-executor-invocation fallback: continuation metadata is missing or the worker does
    // not advertise a resumable session, so re-prompt with a brand-new invocation instead of
    // aborting. The runner has already appended the original prompt, the malformed output, and
    // the repair instruction onto the task, so the adapter runs it as an ordinary fresh call —
    // no resume, no repair context. Continuation stays the preferred path when it works above.
    return getWorkflowWorkerAdapter(worker).runTask(task, {
      ...commonOptions,
      ...(context !== undefined
        ? { context: { abortSignal: context.abortSignal, reportProgress: context.reportProgress } }
        : {}),
    });
  };
};
