import { Effect, Schema } from "effect";

export interface WorkflowModelRef {
  readonly modelspace?: string;
  readonly profile?: string;
}

export interface WorkflowAgentRef {
  readonly kind: "agent-ref";
  readonly plugin: string;
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly manifestHash: string;
  readonly model?: WorkflowModelRef;
  readonly installs: ReadonlyArray<string>;
}

export type WorkflowOutputSchema = Schema.Schema.AnyNoContext;

export interface WorkflowTaskWorkerOptions {
  readonly worker?: string;
  readonly model?: string;
  readonly profile?: string;
}

export interface WorkflowFinishCriterionContext<Output> {
  readonly output: Output;
  readonly rawOutput: unknown;
  readonly metadata?: Record<string, unknown>;
}

export interface WorkflowFinishCriterion<Output> {
  readonly name: string;
  readonly check: (context: WorkflowFinishCriterionContext<Output>) => Effect.Effect<void, unknown>;
  readonly repairPrompt?: (error: unknown, context: WorkflowFinishCriterionContext<Output>) => string;
}

export interface WorkflowFinishOptions<Output> {
  readonly maxRepairs?: number;
  readonly criteria?: ReadonlyArray<WorkflowFinishCriterion<Output>>;
}

export interface WorkflowTaskDefinition<
  Id extends string,
  Agent extends WorkflowAgentRef,
  Output extends WorkflowOutputSchema,
> {
  readonly id: Id;
  readonly agent: Agent;
  readonly prompt: string;
  readonly output: Output;
  readonly cacheKey?: string;
  readonly worker?: WorkflowTaskWorkerOptions;
  readonly finish?: WorkflowFinishOptions<Schema.Schema.Type<Output>>;
}

export interface WorkflowTask<
  Id extends string = string,
  Agent extends WorkflowAgentRef = WorkflowAgentRef,
  Output extends WorkflowOutputSchema = WorkflowOutputSchema,
> extends WorkflowTaskDefinition<Id, Agent, Output> {
  readonly kind: "workflow-task";
}

export type AnyWorkflowTask = WorkflowTask<string, WorkflowAgentRef, WorkflowOutputSchema>;

export type WorkflowTaskOutput<Task extends AnyWorkflowTask> = Schema.Schema.Type<Task["output"]>;

export interface WorkflowDefinition<Name extends string, Tasks extends ReadonlyArray<AnyWorkflowTask>> {
  readonly kind: "workflow";
  readonly name: Name;
  readonly tasks: Tasks;
}

export interface WorkflowRuntime {
  runTask: <Task extends AnyWorkflowTask>(task: Task) => Effect.Effect<WorkflowTaskOutput<Task>, unknown>;
}

export interface WorkflowRuntimeOptions {
  readonly fallbackWorker?: string;
  readonly fallbackModel?: string;
}

export interface DynamicWorkflowDefinition<Name extends string> {
  readonly kind: "workflow";
  readonly name: Name;
  readonly tasks: readonly [];
  readonly run: (runtime: WorkflowRuntime) => Effect.Effect<unknown, unknown>;
}

export type AnyWorkflowDefinition =
  | WorkflowDefinition<string, ReadonlyArray<AnyWorkflowTask>>
  | DynamicWorkflowDefinition<string>;

export const defineTask = <
  const Id extends string,
  const Agent extends WorkflowAgentRef,
  const Output extends WorkflowOutputSchema,
>(definition: WorkflowTaskDefinition<Id, Agent, Output>): WorkflowTask<Id, Agent, Output> => ({
  kind: "workflow-task",
  ...definition,
});

export function defineWorkflow<const Name extends string, const Tasks extends ReadonlyArray<AnyWorkflowTask>>(
  definition: { readonly name: Name; readonly tasks: Tasks },
): WorkflowDefinition<Name, Tasks>;
export function defineWorkflow<const Name extends string>(
  definition: { readonly name: Name; readonly run: (runtime: WorkflowRuntime) => Effect.Effect<unknown, unknown> },
): DynamicWorkflowDefinition<Name>;
export function defineWorkflow<const Name extends string>(
  definition:
    | { readonly name: Name; readonly tasks: ReadonlyArray<AnyWorkflowTask> }
    | { readonly name: Name; readonly run: (runtime: WorkflowRuntime) => Effect.Effect<unknown, unknown> },
): WorkflowDefinition<Name, ReadonlyArray<AnyWorkflowTask>> | DynamicWorkflowDefinition<Name> {
  if ("run" in definition) {
    return {
      kind: "workflow",
      name: definition.name,
      tasks: [],
      run: definition.run,
    };
  }
  return {
  kind: "workflow",
  ...definition,
  };
}

export const decodeTaskOutput = <Task extends AnyWorkflowTask>(
  task: Task,
  value: unknown,
) => Schema.decodeUnknownEither(task.output)(value);
