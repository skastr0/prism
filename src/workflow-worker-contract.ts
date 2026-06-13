import type { AnyWorkflowTask } from "./workflows.js";

export const WORKFLOW_WORKER_JSON_CONTRACT_VERSION = "v1";
export const WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE = "workflow-worker-json-instruction-v1";

export class WorkflowOutputParseError extends Error {
  override readonly name = "WorkflowOutputParseError";
  readonly rawText?: string;
  constructor(message: string, rawText?: string) {
    super(message);
    if (rawText !== undefined) {
      this.rawText = rawText;
    }
  }
}

export const workflowWorkerJsonInstruction = (task: AnyWorkflowTask): string => `

You are running inside a Prism workflow task.

Task id: ${task.id}
Agent identity: ${task.agent.plugin}.${task.agent.name}
Contract version: ${WORKFLOW_WORKER_JSON_CONTRACT_VERSION}

Return exactly one JSON value and nothing else. The Prism workflow runtime will parse
that JSON and validate it with the task's Effect Schema before any downstream task can
see it. Do not wrap the JSON in Markdown fences.
`;

export const parseWorkflowWorkerJsonOutput = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new WorkflowOutputParseError("workflow worker returned empty output", trimmed);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
    if (fenced?.[1]) return JSON.parse(fenced[1]) as unknown;

    const firstObject = trimmed.indexOf("{");
    const firstArray = trimmed.indexOf("[");
    const starts = [firstObject, firstArray].filter((index) => index >= 0);
    if (starts.length === 0) {
      throw new WorkflowOutputParseError("workflow worker output did not contain JSON", trimmed);
    }
    const start = Math.min(...starts);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (end < start) {
      throw new WorkflowOutputParseError("workflow worker output contained incomplete JSON", trimmed);
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
};
