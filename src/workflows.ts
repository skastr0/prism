import { Schema } from "effect";

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

export const defineTask = <
  const Id extends string,
  const Agent extends WorkflowAgentRef,
  const Output extends WorkflowOutputSchema,
>(definition: WorkflowTaskDefinition<Id, Agent, Output>): WorkflowTask<Id, Agent, Output> => ({
  kind: "workflow-task",
  ...definition,
});

export const defineWorkflow = <const Name extends string, const Tasks extends ReadonlyArray<AnyWorkflowTask>>(
  definition: { readonly name: Name; readonly tasks: Tasks },
): WorkflowDefinition<Name, Tasks> => ({
  kind: "workflow",
  ...definition,
});

export const decodeTaskOutput = <Task extends AnyWorkflowTask>(
  task: Task,
  value: unknown,
) => Schema.decodeUnknownEither(task.output)(value);
