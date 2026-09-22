import type { WorkflowRunnerLogRemoval } from "./workflow-runner-log.js";

export const DEFAULT_WORKFLOW_RETENTION_DAYS = 30;
export const DEFAULT_WORKFLOW_RETENTION_MS = DEFAULT_WORKFLOW_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const DEFAULT_WORKFLOW_RETENTION_AGE = `${DEFAULT_WORKFLOW_RETENTION_DAYS}d`;

const WORKFLOW_RETENTION_AGE_PATTERN = /^(\d+)(m|h|d)$/;

export const parseWorkflowRetentionAge = (input: string): number => {
  const match = WORKFLOW_RETENTION_AGE_PATTERN.exec(input.trim());
  if (match === null) {
    throw new Error("Workflow retention age must be a positive duration such as 30m, 24h, or 30d");
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Workflow retention age must be a positive duration such as 30m, 24h, or 30d");
  }
  const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const result = amount * unitMs;
  if (!Number.isSafeInteger(result)) {
    throw new Error("Workflow retention age exceeds the supported duration range");
  }
  return result;
};

export interface WorkflowRunArtifactCounts {
  readonly runs: number;
  readonly tasks: number;
  readonly attempts: number;
  readonly events: number;
  readonly spans: number;
  readonly runSnapshots: number;
  readonly taskSnapshots: number;
}

export interface WorkflowCacheArtifactCounts {
  readonly taskCache: number;
  readonly judgeCache: number;
}

export interface WorkflowRunDeletionReport {
  readonly runId: string;
  readonly status: "deleted" | "missing";
  readonly rows: WorkflowRunArtifactCounts;
  readonly runnerLog: WorkflowRunnerLogRemoval;
}

export interface WorkflowRetentionCleanupReport {
  readonly policy: "workflow-ledger-retention-v1";
  readonly olderThanMs: number;
  readonly cutoff: string;
  readonly runs: {
    readonly matched: number;
    readonly deleted: number;
    readonly rows: WorkflowRunArtifactCounts;
  };
  readonly caches: WorkflowCacheArtifactCounts;
  readonly runnerLogs: {
    readonly deleted: number;
    readonly missing: number;
    readonly skippedUnsafeRunId: number;
  };
}

export const emptyWorkflowRunArtifactCounts = (): WorkflowRunArtifactCounts => ({
  runs: 0,
  tasks: 0,
  attempts: 0,
  events: 0,
  spans: 0,
  runSnapshots: 0,
  taskSnapshots: 0,
});

export const addWorkflowRunArtifactCounts = (
  left: WorkflowRunArtifactCounts,
  right: WorkflowRunArtifactCounts,
): WorkflowRunArtifactCounts => ({
  runs: left.runs + right.runs,
  tasks: left.tasks + right.tasks,
  attempts: left.attempts + right.attempts,
  events: left.events + right.events,
  spans: left.spans + right.spans,
  runSnapshots: left.runSnapshots + right.runSnapshots,
  taskSnapshots: left.taskSnapshots + right.taskSnapshots,
});

export const workflowRetentionCutoff = (
  olderThanMs: number,
  now: Date = new Date(),
): Date => {
  if (!Number.isFinite(olderThanMs) || !Number.isInteger(olderThanMs) || olderThanMs <= 0) {
    throw new Error("Workflow retention age must be a positive integer number of milliseconds");
  }
  const cutoff = new Date(now.getTime() - olderThanMs);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new Error("Workflow retention cutoff is outside the supported date range");
  }
  return cutoff;
};
