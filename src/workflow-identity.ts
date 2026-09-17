import { stableJsonHash, type StableJsonValue } from "@skastr0/prism-sdk/stable-json";
import {
  DEFAULT_WORKFLOW_DECODE_REPAIRS,
  isJevTask,
  resolveWorkflowTaskSessionPersistence,
  resolveWorkflowTaskModel,
  type AnyJevTask,
  type AnyWorkflowTask,
  type AnyWorkflowWorkerTask,
  type WorkflowSessionPersistence,
  type WorkflowRuntimeOptions,
} from "./workflows.js";
import { JEV_RESULT_CONTRACT_VERSION, type JevQuestions, type JevEntry } from "./jev.js";
import type { JevPublicConfig } from "./services/jev.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";

/**
 * `cacheKey` and `promptHash` AND together in the cache primary key
 * (workflow-store.ts) — `cacheKey` never substitutes for `promptHash`, and
 * there is no override/terminal-marker mechanism to make a stale prompt hash
 * replay anyway. `promptHash` hashes the literal rendered `task.prompt`
 * string, so interpolating volatile upstream text (judge prose, logs, whole
 * objects) into a downstream prompt guarantees resume misses by construction.
 * Authoring discipline: interpolate only narrow, stable upstream fields —
 * ids, hashes, short enums (e.g. `build.commitSha`) — never freeform upstream
 * text. There is no `--no-cache` bypass (removed; cache is mandatory) — the
 * sanctioned no-reuse path is a fresh `--store`.
 */
export interface WorkflowTaskIdentity {
  readonly workflow: string;
  readonly taskId: string;
  readonly cacheKey: string;
  readonly promptHash: string;
}

export interface WorkflowJudgeIdentity {
  readonly workflow: string;
  readonly taskId: string;
  readonly taskCacheKey: string;
  readonly criterion: string;
  readonly cacheKey: string;
}

interface WorkflowRunTaskSnapshotBase {
  readonly runId: string;
  readonly ordinal: number;
  readonly taskId: string;
  readonly phase?: string;
  readonly cacheKey: string;
  readonly promptHash: string;
  readonly outputSchema?: unknown;
  readonly createdAt: string;
}

export interface WorkflowWorkerRunTaskSnapshot extends WorkflowRunTaskSnapshotBase {
  readonly kind: "workflow-task";
  readonly prompt: string;
  readonly worker?: {
    readonly worker?: string;
    readonly model?: string;
    readonly profile?: string;
    readonly sessionPersistence?: WorkflowSessionPersistence;
  };
  readonly finishCriteria: ReadonlyArray<string>;
}

/**
 * Persisted record of one native Jev decision: the exact request that was
 * identity-hashed and executed, with the effective (non-secret) endpoint and
 * model. Never contains the API key.
 */
export interface JevRunTaskSnapshot extends WorkflowRunTaskSnapshotBase {
  readonly kind: "jev";
  readonly request: {
    readonly state: JevEntry;
    readonly questions: JevQuestions;
    readonly model: string;
    readonly baseURL: string;
  };
}

export type WorkflowRunTaskSnapshot =
  | WorkflowWorkerRunTaskSnapshot
  | JevRunTaskSnapshot;

/**
 * Distributive snapshot-input union. Plain `Omit<Union, "createdAt">` would
 * collapse variant-specific properties (`prompt`, `request`), so each
 * variant's input form is spelled out.
 */
export type WorkflowRunTaskSnapshotInput =
  | Omit<WorkflowWorkerRunTaskSnapshot, "createdAt">
  | Omit<JevRunTaskSnapshot, "createdAt">;

const WORKFLOW_TASK_IDENTITY_VERSION = 4;

const workflowWorkerSemanticsVersion = (worker: string | null): string => {
  switch (worker) {
    case "claude-code":
    case "grok":
    case "opencode":
      return "native-cli-v1";
    case "opencode2":
      return "native-cli-v2";
    case "amp-code":
    case "codex-cli":
    case "devin":
    case "hermes":
    case "kimi-code":
      return "prompt-cli-v1";
    case null:
      return "mock-or-custom-v1";
    default:
      return `custom:${worker}`;
  }
};

export const workflowTaskIdentity = (
  workflow: string,
  task: AnyWorkflowTask,
  runtimeOptions: WorkflowRuntimeOptions = {},
  jev?: JevPublicConfig,
): WorkflowTaskIdentity => {
  if (isJevTask(task)) {
    if (jev === undefined) {
      throw new Error(
        `workflow task '${task.id}' is a jev decision: identity requires the resolved JevClient config ` +
          "(the runner supplies it from the provisioned service, never from an independent env read)",
      );
    }
    return {
      workflow,
      taskId: task.id,
      cacheKey: task.cacheKey ?? task.id,
      // The historical `promptHash` column doubles as the semantic request
      // hash for native tasks: `(cacheKey, promptHash)` stays the cache
      // primary key for every task kind.
      promptHash: stableJsonHash({
        kind: "jev",
        jevIdentityVersion: 1,
        api: "systemone",
        baseURL: jev.baseURL,
        model: task.model ?? jev.defaultModel,
        state: task.state,
        questions: task.questions,
        resultContractVersion: JEV_RESULT_CONTRACT_VERSION,
      } as unknown as StableJsonValue),
    };
  }
  const worker = task.worker?.worker ?? runtimeOptions.fallbackWorker ?? null;
  const model = resolveWorkflowTaskModel(task, {
    worker: worker ?? undefined,
    fallbackModel: runtimeOptions.fallbackModel,
  });
  return {
    workflow,
    taskId: task.id,
    cacheKey: task.cacheKey ?? task.id,
    promptHash: stableJsonHash({
      identityVersion: WORKFLOW_TASK_IDENTITY_VERSION,
      workerJsonContractVersion: WORKFLOW_WORKER_JSON_CONTRACT_VERSION,
      workerJsonInstructionSource: WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE,
      prompt: task.prompt,
      worker,
      workerSemantics: workflowWorkerSemanticsVersion(worker),
      model: model ?? null,
      profile: task.worker?.profile ?? null,
      // Harness session retention changes persistence, not task output semantics.
      // Keep it out of the content address so persistent and ephemeral executions share
      // Prism's completed-result cache.
      outputSchema: ((task.output as { readonly ast?: unknown }).ast ?? null) as StableJsonValue,
      finish: {
        maxRepairs: task.finish?.maxRepairs ?? 0,
        maxDecodeRepairs: task.finish?.maxDecodeRepairs ?? DEFAULT_WORKFLOW_DECODE_REPAIRS,
        criteria: task.finish?.criteria?.map((criterion) => ({
          kind: criterion.kind ?? "deterministic",
          name: criterion.name,
          ...(criterion.kind === "judge"
            ? {
              goal: typeof criterion.goal === "function" ? criterion.goal.toString() : criterion.goal ?? null,
              selectEvidence: criterion.selectEvidence?.toString() ?? null,
              evaluate: criterion.evaluate.toString(),
            }
            : {
              check: criterion.check.toString(),
              repairPrompt: criterion.repairPrompt?.toString() ?? null,
            }),
        })) ?? [],
      },
    } as StableJsonValue),
  };
};

const taskPhase = (task: AnyWorkflowTask): string | undefined => {
  const value = (task as { readonly phase?: unknown }).phase;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const taskOutputSchemaSnapshot = (task: AnyWorkflowTask): unknown => {
  const ast = (task.output as { readonly ast?: unknown }).ast;
  return ast ?? null;
};

const taskFinishCriteria = (task: AnyWorkflowWorkerTask): ReadonlyArray<string> =>
  task.finish?.criteria?.map((criterion) => criterion.name) ?? [];

const taskWorkerSnapshot = (
  task: AnyWorkflowWorkerTask,
  runtimeOptions: WorkflowRuntimeOptions,
): WorkflowWorkerRunTaskSnapshot["worker"] => {
  const worker = task.worker?.worker ?? runtimeOptions.fallbackWorker;
  const model = resolveWorkflowTaskModel(task, { worker, fallbackModel: runtimeOptions.fallbackModel });
  const profile = task.worker?.profile;
  const sessionPersistence = resolveWorkflowTaskSessionPersistence(task, worker);
  if (worker === undefined && model === undefined && profile === undefined && sessionPersistence === undefined) return undefined;
  return {
    ...(worker !== undefined ? { worker } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(sessionPersistence !== undefined ? { sessionPersistence } : {}),
  };
};

export const workflowRunTaskSnapshotForTask = (input: {
  readonly runId: string;
  readonly ordinal: number;
  readonly workflow: string;
  readonly task: AnyWorkflowTask;
  readonly runtimeOptions?: WorkflowRuntimeOptions;
  readonly jev?: JevPublicConfig;
}): WorkflowRunTaskSnapshotInput => {
  const runtimeOptions = input.runtimeOptions ?? {};
  const phase = taskPhase(input.task);
  if (isJevTask(input.task)) {
    const identity = workflowTaskIdentity(input.workflow, input.task, runtimeOptions, input.jev);
    const jev = input.jev!;
    return {
      runId: input.runId,
      ordinal: input.ordinal,
      taskId: input.task.id,
      kind: "jev",
      ...(phase !== undefined ? { phase } : {}),
      cacheKey: identity.cacheKey,
      promptHash: identity.promptHash,
      outputSchema: taskOutputSchemaSnapshot(input.task),
      request: {
        state: input.task.state,
        questions: input.task.questions,
        model: input.task.model ?? jev.defaultModel,
        baseURL: jev.baseURL,
      },
    };
  }
  const identity = workflowTaskIdentity(input.workflow, input.task, runtimeOptions);
  const worker = taskWorkerSnapshot(input.task, runtimeOptions);
  return {
    runId: input.runId,
    ordinal: input.ordinal,
    taskId: input.task.id,
    kind: "workflow-task",
    ...(phase !== undefined ? { phase } : {}),
    prompt: input.task.prompt,
    cacheKey: identity.cacheKey,
    promptHash: identity.promptHash,
    ...(worker !== undefined ? { worker } : {}),
    outputSchema: taskOutputSchemaSnapshot(input.task),
    finishCriteria: taskFinishCriteria(input.task),
  };
};
