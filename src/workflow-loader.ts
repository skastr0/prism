import { Schema } from "effect";
import { expandPath } from "./fs.js";
// Importing from load.ts initializes the binary's Effect runtime bridge
// (globalThis.__prism_effect) as a module side-effect, so the workflow DSL
// runtime and the file's `from "effect"` rewrite resolve to the binary's
// Effect instance — making Schema.isSchema and decodeTaskOutput operate on
// the same Effect the runner uses.
import { prepareImportWrapper } from "./compile/load.js";
import type { AnyWorkflowDefinition, AnyWorkflowTask, WorkflowAgentRef } from "./workflows.js";

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
  readonly dynamic: boolean;
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
): value is AnyWorkflowDefinition =>
  isRecord(value) &&
  value.kind === "workflow" &&
  typeof value.name === "string" &&
  Array.isArray(value.tasks) &&
  value.tasks.every(isWorkflowTask) &&
  (value.run === undefined || typeof value.run === "function");

export const workflowSummary = (
  path: string,
  workflow: AnyWorkflowDefinition,
): WorkflowValidationSummary => ({
  path,
  name: workflow.name,
  dynamic: "run" in workflow,
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
): Promise<AnyWorkflowDefinition> => {
  const resolved = expandPath(filePath);
  const wrapper = await prepareImportWrapper(resolved, { workflow: true });
  let module: WorkflowModule;
  try {
    module = (await import(wrapper.specifier)) as WorkflowModule;
  } finally {
    await wrapper.cleanup();
  }
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
