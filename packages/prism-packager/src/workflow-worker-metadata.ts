import { createHash } from "node:crypto";
import type { WorkflowSessionPersistence } from "./workflows.js";

export const DEFAULT_WORKFLOW_WORKER_STDERR_EXCERPT_BYTES = 4096;

export interface WorkflowWorkerStderrMetadata {
  readonly stderrBytes?: number;
  readonly stderrSha256?: string;
  readonly stderrExcerpt?: string;
  readonly stderrTruncated?: boolean;
}

const utf8Tail = (text: string, maxBytes: number): string => {
  let tail = text;
  while (Buffer.byteLength(tail, "utf8") > maxBytes) {
    tail = tail.slice(1);
  }
  return tail;
};

export const summarizeWorkflowWorkerStderr = (
  stderr: string,
  maxExcerptBytes = DEFAULT_WORKFLOW_WORKER_STDERR_EXCERPT_BYTES,
): WorkflowWorkerStderrMetadata => {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return {};
  const bytes = Buffer.byteLength(trimmed, "utf8");
  if (bytes <= maxExcerptBytes) {
    return {
      stderrBytes: bytes,
      stderrSha256: createHash("sha256").update(trimmed).digest("hex"),
      stderrExcerpt: trimmed,
      stderrTruncated: false,
    };
  }
  const excerpt = utf8Tail(trimmed, maxExcerptBytes);
  return {
    stderrBytes: bytes,
    stderrSha256: createHash("sha256").update(trimmed).digest("hex"),
    stderrExcerpt: excerpt,
    stderrTruncated: true,
  };
};

export const summarizeWorkflowWorkerStderrForSession = (
  stderr: string,
  sessionPersistence: WorkflowSessionPersistence,
  maxExcerptBytes = DEFAULT_WORKFLOW_WORKER_STDERR_EXCERPT_BYTES,
): WorkflowWorkerStderrMetadata => {
  const summary = summarizeWorkflowWorkerStderr(stderr, maxExcerptBytes);
  if (sessionPersistence === "persistent") return summary;
  const { stderrExcerpt: _stderrExcerpt, ...safeSummary } = summary;
  return safeSummary;
};

/**
 * Forensics attached to a worker adapter's thrown error on the failure path (OBS-006).
 * On success, every adapter already returns `{ adapter, ..., sessionId, ...stderr summary }`
 * as its `WorkflowTaskExecution.metadata`. On failure, that same shape was previously
 * discarded entirely — the runner persisted only `{contractVersion, instructionSource}` —
 * so a failed task could not be joined to its harness session or its stderr tail. Adapters
 * attach this to their custom Error's `metadata` property at each failure throw site; the
 * runner merges `error.metadata` into both the `task.executor.failed` event and the
 * persisted task record.
 */
export const workflowWorkerFailureMetadata = (input: {
  readonly adapter: string;
  readonly stderr: string;
  readonly sessionId?: string;
  readonly sessionPersistence?: WorkflowSessionPersistence;
  readonly maxExcerptBytes?: number;
}): Record<string, unknown> => ({
  adapter: input.adapter,
  ...(input.sessionPersistence === undefined
    ? summarizeWorkflowWorkerStderr(input.stderr, input.maxExcerptBytes)
    : summarizeWorkflowWorkerStderrForSession(
      input.stderr,
      input.sessionPersistence,
      input.maxExcerptBytes,
    )),
  ...(input.sessionPersistence !== undefined
    ? { sessionPersistence: input.sessionPersistence }
    : {}),
  ...(input.sessionPersistence !== "ephemeral" && input.sessionId !== undefined
    ? { sessionId: input.sessionId }
    : {}),
});
