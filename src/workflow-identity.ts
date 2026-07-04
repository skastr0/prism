import { stableJsonHash, type StableJsonValue } from "@skastr0/prism-core/stable-json";
import { resolveWorkflowTaskModel, type AnyWorkflowTask, type WorkflowRuntimeOptions } from "./workflows.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";

export interface WorkflowTaskIdentity {
  readonly workflow: string;
  readonly taskId: string;
  readonly cacheKey: string;
  readonly promptHash: string;
  readonly agentManifestHash: string;
}

export interface WorkflowJudgeIdentity {
  readonly workflow: string;
  readonly taskId: string;
  readonly taskCacheKey: string;
  readonly criterion: string;
  readonly cacheKey: string;
}

export interface WorkflowRunTaskSnapshot {
  readonly runId: string;
  readonly ordinal: number;
  readonly taskId: string;
  readonly phase?: string;
  readonly prompt: string;
  readonly cacheKey: string;
  readonly promptHash: string;
  readonly agentManifestHash: string;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
    readonly description: string;
    readonly sourceHash: string;
    readonly manifestHash: string;
  };
  readonly worker?: {
    readonly worker?: string;
    readonly model?: string;
    readonly profile?: string;
  };
  readonly outputSchema?: unknown;
  readonly finishCriteria: ReadonlyArray<string>;
  readonly createdAt: string;
}

const WORKFLOW_TASK_IDENTITY_VERSION = 2;

const workflowWorkerSemanticsVersion = (worker: string | null): string => {
  switch (worker) {
    case "claude-code":
    case "grok":
    case "opencode":
      return "native-agent-v1";
    case "amp-code":
    case "codex-cli":
    case "hermes":
    case "kimi-code":
      return "prompt-agent-v1";
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
): WorkflowTaskIdentity => {
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
      outputSchema: ((task.output as { readonly ast?: unknown }).ast ?? null) as StableJsonValue,
      finish: {
        maxRepairs: task.finish?.maxRepairs ?? 0,
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
    agentManifestHash: task.agent.manifestHash,
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

const taskFinishCriteria = (task: AnyWorkflowTask): ReadonlyArray<string> =>
  task.finish?.criteria?.map((criterion) => criterion.name) ?? [];

const taskWorkerSnapshot = (
  task: AnyWorkflowTask,
  runtimeOptions: WorkflowRuntimeOptions,
): WorkflowRunTaskSnapshot["worker"] => {
  const worker = task.worker?.worker ?? runtimeOptions.fallbackWorker;
  const model = resolveWorkflowTaskModel(task, { worker, fallbackModel: runtimeOptions.fallbackModel });
  const profile = task.worker?.profile;
  if (worker === undefined && model === undefined && profile === undefined) return undefined;
  return {
    ...(worker !== undefined ? { worker } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(profile !== undefined ? { profile } : {}),
  };
};

export const workflowRunTaskSnapshotForTask = (input: {
  readonly runId: string;
  readonly ordinal: number;
  readonly workflow: string;
  readonly task: AnyWorkflowTask;
  readonly runtimeOptions?: WorkflowRuntimeOptions;
}): Omit<WorkflowRunTaskSnapshot, "createdAt"> => {
  const runtimeOptions = input.runtimeOptions ?? {};
  const identity = workflowTaskIdentity(input.workflow, input.task, runtimeOptions);
  const phase = taskPhase(input.task);
  const worker = taskWorkerSnapshot(input.task, runtimeOptions);
  return {
    runId: input.runId,
    ordinal: input.ordinal,
    taskId: input.task.id,
    ...(phase !== undefined ? { phase } : {}),
    prompt: input.task.prompt,
    cacheKey: identity.cacheKey,
    promptHash: identity.promptHash,
    agentManifestHash: identity.agentManifestHash,
    agent: {
      plugin: input.task.agent.plugin,
      name: input.task.agent.name,
      description: input.task.agent.description,
      sourceHash: input.task.agent.sourceHash,
      manifestHash: input.task.agent.manifestHash,
    },
    ...(worker !== undefined ? { worker } : {}),
    outputSchema: taskOutputSchemaSnapshot(input.task),
    finishCriteria: taskFinishCriteria(input.task),
  };
};
