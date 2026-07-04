import type { AnyWorkflowTask } from "./workflows.js";

export const WORKFLOW_WORKER_JSON_CONTRACT_VERSION = "v1";
export const WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE = "workflow-worker-json-instruction-v1";

export class WorkflowOutputParseError extends Error {
  override readonly name = "WorkflowOutputParseError";
  readonly rawText?: string;
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, rawText?: string, metadata?: Record<string, unknown>) {
    super(message);
    if (rawText !== undefined) {
      this.rawText = rawText;
    }
    if (metadata !== undefined) {
      this.metadata = metadata;
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

const jsonParseErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseJsonCandidate = (candidate: string, rawText: string): unknown => {
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    throw new WorkflowOutputParseError(
      `workflow worker output contained invalid JSON: ${jsonParseErrorMessage(error)}`,
      rawText,
    );
  }
};

interface JsonSpan {
  readonly start: number;
  readonly end: number;
}

interface JsonSpanScan {
  readonly spans: ReadonlyArray<JsonSpan>;
  readonly sawOpenBracket: boolean;
}

/**
 * Scans `text` once, string/escape aware, and records every span that opens a
 * `{`/`[` at bracket depth 0 and closes back to depth 0 later (a "complete"
 * top-level JSON-shaped value). Braces inside JSON strings (e.g. a receipt
 * field containing literal `{`/`}` text) do not affect depth. Non-JSON
 * brace-bearing content that happens to be balanced (a printed diff, a
 * `Schema.Struct({ ... })` snippet) also produces a span here; it is filtered
 * out later because it fails `JSON.parse`, not because this scan understands
 * JSON grammar.
 */
const findTopLevelJsonSpans = (text: string): JsonSpanScan => {
  const spans: JsonSpan[] = [];
  let depth = 0;
  let spanStart = -1;
  let inString = false;
  let escaped = false;
  let sawOpenBracket = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      sawOpenBracket = true;
      if (depth === 0) spanStart = index;
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      if (depth === 0) continue; // stray close with no matching open; ignore
      depth -= 1;
      if (depth === 0 && spanStart >= 0) {
        spans.push({ start: spanStart, end: index });
        spanStart = -1;
      }
    }
  }

  return { spans, sawOpenBracket };
};

export const parseWorkflowWorkerJsonOutput = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new WorkflowOutputParseError("workflow worker returned empty output", trimmed);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
    if (fenced?.[1]) return parseJsonCandidate(fenced[1], trimmed);

    const { spans, sawOpenBracket } = findTopLevelJsonSpans(trimmed);
    if (!sawOpenBracket) {
      throw new WorkflowOutputParseError("workflow worker output did not contain JSON", trimmed);
    }
    if (spans.length === 0) {
      throw new WorkflowOutputParseError("workflow worker output contained incomplete JSON", trimmed);
    }

    // Try the LAST complete top-level value first: workers append their JSON
    // receipt after any prose/diff/tool output, so the last balanced span is
    // the receipt far more often than the first.
    let lastError: unknown;
    for (let index = spans.length - 1; index >= 0; index -= 1) {
      const span = spans[index]!;
      const candidate = trimmed.slice(span.start, span.end + 1);
      try {
        return JSON.parse(candidate) as unknown;
      } catch (error) {
        lastError = error;
      }
    }
    throw new WorkflowOutputParseError(
      `workflow worker output contained invalid JSON: ${jsonParseErrorMessage(lastError)}`,
      trimmed,
    );
  }
};
