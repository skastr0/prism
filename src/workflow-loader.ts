import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import { expandPath } from "./fs.js";
import type { AnyWorkflowTask, WorkflowDefinition, WorkflowAgentRef } from "./workflows.js";

export interface WorkflowTaskSummary {
  readonly id: string;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly cacheKey?: string;
}

export interface WorkflowValidationSummary {
  readonly path: string;
  readonly name: string;
  readonly tasks: ReadonlyArray<WorkflowTaskSummary>;
}

export class WorkflowLoadError extends Error {
  override readonly name = "WorkflowLoadError";
}

type WorkflowModule = {
  readonly default?: unknown;
  readonly workflow?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isWorkflowAgentRef = (value: unknown): value is WorkflowAgentRef =>
  isRecord(value) &&
  value.kind === "agent-ref" &&
  typeof value.plugin === "string" &&
  typeof value.name === "string" &&
  typeof value.description === "string" &&
  typeof value.sourcePath === "string" &&
  typeof value.sourceHash === "string" &&
  typeof value.manifestHash === "string" &&
  isStringArray(value.installs);

const isWorkflowTask = (value: unknown): value is AnyWorkflowTask =>
  isRecord(value) &&
  value.kind === "workflow-task" &&
  typeof value.id === "string" &&
  isWorkflowAgentRef(value.agent) &&
  typeof value.prompt === "string" &&
  Schema.isSchema(value.output) &&
  (value.cacheKey === undefined || typeof value.cacheKey === "string");

export const isWorkflowDefinition = (
  value: unknown,
): value is WorkflowDefinition<string, ReadonlyArray<AnyWorkflowTask>> =>
  isRecord(value) &&
  value.kind === "workflow" &&
  typeof value.name === "string" &&
  Array.isArray(value.tasks) &&
  value.tasks.every(isWorkflowTask);

export const workflowSummary = (
  path: string,
  workflow: WorkflowDefinition<string, ReadonlyArray<AnyWorkflowTask>>,
): WorkflowValidationSummary => ({
  path,
  name: workflow.name,
  tasks: workflow.tasks.map((task) => ({
    id: task.id,
    agent: {
      plugin: task.agent.plugin,
      name: task.agent.name,
    },
    ...(task.cacheKey ? { cacheKey: task.cacheKey } : {}),
  })),
});

export const loadWorkflowFile = async (
  filePath: string,
): Promise<WorkflowDefinition<string, ReadonlyArray<AnyWorkflowTask>>> => {
  const resolved = expandPath(filePath);
  const module = (await import(`${pathToFileURL(resolved).href}?t=${Date.now()}`)) as WorkflowModule;
  const candidate = module.workflow ?? module.default;
  if (!isWorkflowDefinition(candidate)) {
    throw new WorkflowLoadError(
      "workflow module must export a WorkflowDefinition as `workflow` or default",
    );
  }
  return candidate;
};

export const validateWorkflowFile = async (filePath: string): Promise<WorkflowValidationSummary> => {
  const resolved = expandPath(filePath);
  const workflow = await loadWorkflowFile(resolved);
  return workflowSummary(resolved, workflow);
};
