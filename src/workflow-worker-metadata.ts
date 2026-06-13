import { createHash } from "node:crypto";

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
