import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open as openFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stableJsonHash, stableJsonStringify, type StableJsonValue } from "@skastr0/prism-sdk/stable-json";
import { exists } from "./fs.js";
import { deriveProjectKey } from "./project-key.js";
import {
  DEFAULT_WORKFLOW_RETENTION_MS,
  addWorkflowRunArtifactCounts,
  emptyWorkflowRunArtifactCounts,
  workflowRetentionCutoff,
  type WorkflowCacheArtifactCounts,
  type WorkflowRetentionCleanupReport,
  type WorkflowRunArtifactCounts,
  type WorkflowRunDeletionReport,
} from "./workflow-data-governance.js";
import {
  WORKFLOW_DATA_POLICY_VERSION,
  WORKFLOW_SECRET_DIGEST_PREFIX,
  applyWorkflowDataPolicy,
  digestWorkflowSecret,
  inspectWorkflowSensitiveData,
  redactWorkflowData,
  redactWorkflowText,
} from "./workflow-data-policy.js";
import type { WorkflowJudgeVerdict } from "./workflows.js";
import type { WorkflowJudgeIdentity, WorkflowRunTaskSnapshot, WorkflowTaskIdentity } from "./workflow-identity.js";
export { workflowRunTaskSnapshotForTask, workflowTaskIdentity, type WorkflowJudgeIdentity, type WorkflowRunTaskSnapshot, type WorkflowTaskIdentity } from "./workflow-identity.js";
import { openWorkflowDatabase, type WorkflowDatabase } from "./workflow-runtime.js";
import {
  readRedactedWorkflowRunnerLog,
  redactWorkflowRunnerLogInPlace,
  removeWorkflowRunnerLog,
  workflowRunnerLogPath,
  type WorkflowRunnerLogRemoval,
} from "./workflow-runner-log.js";
import type { WorkflowSpanRecord } from "./workflow-tracing.js";
import { normalizeWorkflowSessionMetadata, workflowStableSessionFromMetadata } from "./workflow-session.js";
import {
  addWorkflowReuse,
  addWorkflowUsage,
  emptyWorkflowUsageTotals,
  workflowUsageFromMetadata,
  type WorkflowUsage,
  type WorkflowUsageTotals,
} from "./workflow-usage.js";

export type WorkflowTaskOutputSource = "mock-output";

export interface CompletedWorkflowTaskRecord {
  readonly identity: WorkflowTaskIdentity;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly output: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly outputSource?: WorkflowTaskOutputSource;
}

export interface WorkflowCacheRecord extends CompletedWorkflowTaskRecord {
  readonly status: string;
  readonly outputSource?: WorkflowTaskOutputSource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowJudgeRecord {
  readonly identity: WorkflowJudgeIdentity;
  readonly verdict: WorkflowJudgeVerdict["verdict"];
  readonly feedback?: string;
  readonly evidence: unknown;
  readonly output: unknown;
  readonly taskMetadata: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkflowCacheWriteResult =
  | { readonly stored: true }
  | {
      readonly stored: false;
      readonly reason: "sensitive-data";
      readonly findingCount: number;
      readonly findingPaths: ReadonlyArray<string>;
    };

export type WorkflowRunTaskStatus = "completed" | "failed" | "escalated";

export interface WorkflowRunTaskRecord {
  readonly runId: string;
  readonly ordinal: number;
  readonly taskId: string;
  readonly cacheKey: string;
  readonly status: WorkflowRunTaskStatus;
  readonly cached: boolean;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly output: unknown;
  readonly metadata?: Record<string, unknown>;
}

export type WorkflowRunTaskProgressStatus = "running" | "completed" | "failed" | "escalated" | "stopped" | "crashed";

export type WorkflowRunTaskCacheLookup = "hit" | "miss" | "skipped";

export interface WorkflowRunTaskProgress {
  readonly ordinal?: number;
  readonly taskId: string;
  readonly status: WorkflowRunTaskProgressStatus;
  readonly cacheKey?: string;
  readonly cached?: boolean;
  readonly cacheLookup?: WorkflowRunTaskCacheLookup;
  readonly repairs: number;
  readonly agent?: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly lastEventType?: string;
  readonly lastEventAt?: string;
}

export type WorkflowRunTaskExecutionSource = "cached" | "fresh" | "unknown";
export type WorkflowRunTaskEvidenceSource = "this-run" | "prior-cache-record" | "run-events" | "unknown";

export interface WorkflowRunTaskCompactSummary {
  readonly ordinal?: number;
  readonly taskId: string;
  readonly status: WorkflowRunTaskProgressStatus;
  readonly execution: WorkflowRunTaskExecutionSource;
  readonly evidenceSource: WorkflowRunTaskEvidenceSource;
  readonly cached: boolean | null;
  readonly cacheLookup?: WorkflowRunTaskCacheLookup;
  readonly agent?: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly workerAdapter: string | null;
  readonly model: string | null;
  readonly nativeAgent: string | null;
  readonly repairCount: number;
  readonly repairMode: string | null;
  readonly durationMs: number | null;
  readonly externalSessionPointer: string | null;
  readonly lastEventType?: string;
  readonly lastEventAt?: string;
  readonly attempts: ReadonlyArray<WorkflowTaskAttemptRecord>;
}

export interface WorkflowRunSnapshot {
  readonly runId: string;
  readonly workflowFile: string;
  readonly options?: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}


export type WorkflowCacheBadge =
  | "hit"
  | "miss"
  | "skipped"
  | "cached"
  | "fresh"
  | "write"
  | "mock"
  | `repair ${number}`;

export interface WorkflowMonitorTask extends WorkflowRunTaskCompactSummary {
  readonly phase?: string;
  readonly cacheKey?: string;
  readonly prompt?: string;
  readonly output?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly badges: ReadonlyArray<WorkflowCacheBadge>;
  readonly snapshot?: WorkflowRunTaskSnapshot;
}

export interface WorkflowMonitorRun {
  readonly run: WorkflowRunRecord;
  readonly snapshot?: WorkflowRunSnapshot;
  readonly totals: WorkflowRunCompactSummary["totals"];
  readonly cacheBadges: ReadonlyArray<WorkflowCacheBadge>;
}

export interface WorkflowMonitorRunDetail extends WorkflowMonitorRun {
  readonly tasks: ReadonlyArray<WorkflowMonitorTask>;
  readonly events: ReadonlyArray<WorkflowEventRecord>;
  readonly canUpdate: boolean;
}

export interface WorkflowMonitorState {
  readonly runs: ReadonlyArray<WorkflowMonitorRun>;
  readonly selectedRun: WorkflowMonitorRunDetail | null;
}

export interface WorkflowRunCompactSummary {
  readonly kind: "workflow-execution-evidence";
  readonly semanticCorrectness: "not-evaluated";
  readonly disclaimer: string;
  readonly run: WorkflowRunRecord;
  readonly totals: {
    readonly totalTasks: number;
    readonly freshExecutions: number;
    readonly cacheHits: number;
    readonly repairs: number;
    readonly status: WorkflowRunStatus;
    readonly durationMs: number | null;
    readonly usage: WorkflowUsageTotals;
  };
  readonly tasks: WorkflowRunTaskCompactSummary[];
}

type WorkflowRunTaskProgressPatch = Partial<{
  -readonly [Key in keyof WorkflowRunTaskProgress]: WorkflowRunTaskProgress[Key];
}>;

type WorkflowRunTaskCompactPatch = Partial<{
  -readonly [Key in keyof WorkflowRunTaskCompactSummary]: WorkflowRunTaskCompactSummary[Key];
}> & {
  metadata?: Record<string, unknown>;
  startedAt?: string;
  firstEventSequence?: number;
  orderIndex?: number;
};

interface WorkflowRunTaskCompactAccumulator extends WorkflowRunTaskCompactSummary {
  readonly metadata?: Record<string, unknown>;
  readonly startedAt?: string;
  readonly firstEventSequence?: number;
  readonly orderIndex?: number;
}

export type WorkflowRunCompletedCause = {
  readonly kind: "completed";
};

export type WorkflowRunTaskFailureCause = {
  readonly kind: "task-failed" | "task-escalated";
  readonly taskId: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly errorName: string;
  readonly message: string;
};

export type WorkflowRunFailureCause = {
  readonly kind: "workflow-failed";
  readonly errorName: string;
  readonly message: string;
};

export type WorkflowRunStoppedCause = {
  readonly kind: "stopped";
  readonly reason: string;
  readonly signal?: string;
};

export type WorkflowRunCrashedCause = {
  readonly kind: "crashed";
  readonly reason: string;
  readonly runnerPid?: number;
  readonly heartbeatAt?: string;
};
export type WorkflowRunTimeoutCause = {
  readonly kind: "workflow-timeout";
  readonly limitMs: number;
};

export type WorkflowRunFanoutExceededCause = {
  readonly kind: "workflow-fanout-exceeded";
  readonly limit: number;
  readonly observed: number;
};

export type WorkflowRunCostExceededCause = {
  readonly kind: "workflow-cost-exceeded";
  readonly limitUsd: number;
  readonly observedUsd: number;
};

export type WorkflowRunCostUnavailableCause = {
  readonly kind: "workflow-cost-unavailable";
  readonly limitUsd: number;
};

export type WorkflowRunPromptLimitCause = {
  readonly kind: "workflow-prompt-limit-exceeded";
  readonly taskId: string;
  readonly limitBytes: number;
  readonly observedBytes: number;
};


export type WorkflowRunTerminalCause =
  | WorkflowRunCompletedCause
  | WorkflowRunTaskFailureCause
  | WorkflowRunFailureCause
  | WorkflowRunStoppedCause
  | WorkflowRunCrashedCause
  | WorkflowRunTimeoutCause
  | WorkflowRunFanoutExceededCause
  | WorkflowRunCostExceededCause
  | WorkflowRunCostUnavailableCause
  | WorkflowRunPromptLimitCause;

export interface WorkflowRunRecord {
  readonly runId: string;
  readonly workflow: string;
  readonly status: WorkflowRunStatus;
  readonly terminalCause: WorkflowRunTerminalCause | null;
  readonly finishedAt: string | null;
  readonly runnerPid?: number;
  readonly heartbeatAt?: string;
  readonly liveness: WorkflowRunLiveness;
  readonly createdAt?: string;
  readonly usage: WorkflowUsageTotals;
}

export type WorkflowRunLiveness = "alive" | "stale" | "unknown";

// The CLI persists a heartbeat every two seconds. Five missed beats is enough to
// distinguish a live local runner from a process that exists but has stopped advancing.
export const WORKFLOW_RUN_LIVENESS_STALE_AFTER_MS = 10_000;

export type WorkflowRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "escalated"
  | "stopped"
  | "crashed"
  | "unknown";

/**
 * A run's persisted status can read "completed" while carrying isolated task failures: the
 * dynamic runtime's fault-isolation contract (PQ-166) lets an author's `run` program finish
 * successfully after recovering from a task that itself failed or escalated (e.g. via
 * `Effect.either`). That is not a caller-visible success — a caller gating on `$?` (the CLI)
 * must still see the partial failure. Success requires both: the run itself reached
 * "completed", and every recorded task did too.
 */
export function isWorkflowRunOutcomeSuccessful(
  runStatus: WorkflowRunStatus,
  taskStatuses: ReadonlyArray<WorkflowRunTaskProgressStatus>,
): boolean {
  return runStatus === "completed" && taskStatuses.every((status) => status === "completed");
}

export interface WorkflowEventRecord {
  readonly sequence: number;
  readonly runId: string;
  readonly taskId: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface WorkflowRunInspection {
  readonly schema: "prism.workflow-run-inspection.v1";
  readonly dataPolicyVersion: number;
  readonly store: {
    readonly path: string;
    readonly schemaVersion: number;
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly present: boolean;
      readonly mode: number | null;
      readonly bytes: number | null;
    }>;
  };
  readonly run: WorkflowRunRecord;
  readonly rows: WorkflowRunArtifactCounts;
  readonly runnerLog: {
    readonly path: string | null;
    readonly present: boolean;
    readonly bytes: number | null;
  };
}

export interface WorkflowRunExport {
  readonly schema: "prism.workflow-run-export.v1";
  readonly dataPolicyVersion: number;
  readonly exportedAt: string;
  readonly run: WorkflowRunRecord;
  readonly snapshot: WorkflowRunSnapshot | null;
  readonly tasks: ReadonlyArray<WorkflowRunTaskRecord>;
  readonly taskSnapshots: ReadonlyArray<WorkflowRunTaskSnapshot>;
  readonly attempts: ReadonlyArray<WorkflowTaskAttemptRecord>;
  readonly events: ReadonlyArray<WorkflowEventRecord>;
  readonly spans: ReadonlyArray<Omit<WorkflowSpanRecord, "startNs" | "endNs"> & {
    readonly startNs: string;
    readonly endNs: string | null;
  }>;
  readonly runnerLog: {
    readonly path: string;
    readonly bytes: number;
    readonly content: string;
  } | null;
}
export type WorkflowTaskAttemptStatus = "running" | "completed" | "failed" | "stopped" | "crashed";

export type WorkflowTaskAttemptFailureKind = "executor" | "decode" | "finish" | "stopped" | "crashed";

export interface WorkflowTaskAttemptFailure {
  readonly kind: WorkflowTaskAttemptFailureKind;
  readonly message: string;
}

export interface WorkflowTaskAttemptStartedInput {
  readonly runId: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly taskId: string;
  readonly metadata?: Record<string, unknown>;
}

export interface WorkflowTaskAttemptFinishedInput {
  readonly runId: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly status: Exclude<WorkflowTaskAttemptStatus, "running">;
  readonly metadata?: Record<string, unknown>;
  readonly failure?: WorkflowTaskAttemptFailure;
}

export interface WorkflowTaskAttemptRecord {
  readonly runId: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly taskId: string;
  readonly status: WorkflowTaskAttemptStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly adapter?: string;
  readonly model?: string;
  readonly nativeAgent?: string;
  readonly sessionId?: string;
  readonly failure?: WorkflowTaskAttemptFailure;
  readonly usage?: WorkflowUsage;
  readonly metadata?: Record<string, unknown>;
}

interface TaskRecordRow {
  readonly workflow: string;
  readonly task_id: string;
  readonly cache_key: string;
  readonly prompt_hash: string;
  readonly agent_manifest_hash: string;
  readonly agent_plugin: string;
  readonly agent_name: string;
  readonly status: string;
  readonly output_json: string;
  readonly metadata_json: string | null;
  readonly output_source: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface JudgeRecordRow {
  readonly workflow: string;
  readonly task_id: string;
  readonly task_cache_key: string;
  readonly criterion: string;
  readonly judge_cache_key: string;
  readonly verdict: WorkflowJudgeVerdict["verdict"];
  readonly feedback: string | null;
  readonly evidence_json: string;
  readonly output_json: string;
  readonly task_metadata_json: string;
  readonly metadata_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RunTaskRow {
  readonly run_id: string;
  readonly ordinal: number;
  readonly task_id: string;
  readonly cache_key: string;
  readonly status: WorkflowRunTaskStatus;
  readonly cached: 0 | 1;
  readonly agent_plugin: string;
  readonly agent_name: string;
  readonly output_json: string;
  readonly metadata_json: string | null;
}

interface RunRow {
  readonly run_id: string;
  readonly workflow: string;
  readonly status: WorkflowRunStatus;
  readonly finished_at: string | null;
  readonly runner_pid: number | null;
  readonly heartbeat_at: string | null;
  readonly terminal_cause_json: string | null;
  readonly usage_agent_runs: number;
  readonly usage_reused: number;
  readonly usage_tokens_in: number;
  readonly usage_tokens_out: number;
  readonly usage_cost_usd: number;
  readonly usage_duration_ms: number;
}

interface TaskAttemptRow {
  readonly run_id: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly task_id: string;
  readonly status: WorkflowTaskAttemptStatus;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly adapter: string | null;
  readonly model: string | null;
  readonly native_agent: string | null;
  readonly session_id: string | null;
  readonly failure_kind: WorkflowTaskAttemptFailureKind | null;
  readonly failure_message: string | null;
  readonly metadata_json: string | null;
  readonly usage_json: string | null;
}
interface StaleRunRow extends RunRow {
  readonly created_at: string;
}

interface HandoffTokenRow {
  readonly handoff_token: string | null;
}

interface EventRow {
  readonly sequence: number;
  readonly run_id: string;
  readonly task_id: string | null;
  readonly type: string;
  readonly payload_json: string;
  readonly created_at: string;
}

interface SpanRow {
  readonly run_id: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly task_id: string | null;
  readonly name: string;
  readonly kind: string;
  readonly start_ns: string;
  readonly end_ns: string | null;
  readonly status: string;
  readonly error_message: string | null;
  readonly attributes_json: string;
}

interface RunSnapshotRow {
  readonly run_id: string;
  readonly workflow_file: string;
  readonly options_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RunTaskSnapshotRow {
  readonly run_id: string;
  readonly ordinal: number;
  readonly task_id: string;
  readonly phase: string | null;
  readonly prompt: string;
  readonly cache_key: string;
  readonly prompt_hash: string;
  readonly agent_manifest_hash: string;
  readonly agent_plugin: string;
  readonly agent_name: string;
  readonly agent_description: string;
  readonly agent_source_hash: string;
  readonly worker_json: string | null;
  readonly output_schema_json: string | null;
  readonly finish_criteria_json: string;
  readonly created_at: string;
}

export const projectWorkflowStoreDir = (prismHome: string, cwd: string = process.cwd()): string =>
  join(prismHome, "workflows", deriveProjectKey(cwd).key);

export const defaultWorkflowStorePath = (prismHome: string, cwd: string = process.cwd()): string =>
  join(projectWorkflowStoreDir(prismHome, cwd), "workflows.sqlite");

export const WORKFLOW_STORE_SCHEMA_VERSION = 5;

/**
 * AR-001: the task-cache resource identity used to key `workflow_task_records`
 * is a GLOBAL content-addressed id — `(scopeKey, stableKey, semanticHash)` —
 * decoupled from the producing workflow, mirroring the `agent_runs` ledger
 * design (docs/workflows/08-agentrun-ledger-spec.md, captured then deleted at
 * 794f151; `git show ccc32a1:docs/workflows/08-agentrun-ledger-spec.md`).
 * `scopeKey` is a fixed namespace constant for now — external caller-chosen
 * scoping, `agent-run://` addressing, lineage, and world_refs are AR-002+
 * (out of scope here). `stableKey` folds `(taskId, cacheKey)` and
 * `semanticHash` folds `(promptHash, agentManifestHash)`, so identical
 * agent+prompt+schema+harness+model content yields the same resource id
 * regardless of which workflow produced it, while every dimension the old
 * 5-column primary key ANDed together still participates in the new one —
 * no existing per-workflow cache hit stops hitting.
 */
const WORKFLOW_TASK_CACHE_SCOPE_KEY = "workflow-task-cache-v1";

interface WorkflowTaskResourceKey {
  readonly scopeKey: string;
  readonly stableKey: string;
  readonly semanticHash: string;
}

const workflowTaskResourceKey = (identity: WorkflowTaskIdentity): WorkflowTaskResourceKey => ({
  scopeKey: WORKFLOW_TASK_CACHE_SCOPE_KEY,
  stableKey: stableJsonHash({ taskId: identity.taskId, cacheKey: identity.cacheKey }),
  semanticHash: stableJsonHash({ promptHash: identity.promptHash, agentManifestHash: identity.agentManifestHash }),
});

/**
 * Surfaces the one-time soft-divergence direction (WFE-007): a pre-existing store opened at a
 * schema version older than the binary's `WORKFLOW_STORE_SCHEMA_VERSION` migrates in place inside
 * `WorkflowStore.open`, silently by design, but callers reporting on the store (`runs list`,
 * `runs show`) surface that a migration just ran. The other direction — a store newer than this
 * binary supports — is not migratable and is already a hard error in `open`. Never populated for
 * a brand-new store (nothing to diverge from).
 */
export interface WorkflowStoreSchemaNotice {
  readonly severity: "info";
  readonly openedVersion: number;
  readonly currentVersion: number;
  readonly message: string;
}

const WORKFLOW_STORE_FILE_MODE = 0o600;
const WORKFLOW_STORE_DIRECTORY_MODE = 0o700;

const redactedJson = (value: unknown): string =>
  JSON.stringify(redactWorkflowData(value)) ?? "null";

const redactedStableJson = (value: unknown): string =>
  stableJsonStringify(redactWorkflowData(value) as StableJsonValue);

const redactPersistedJson = (value: string): string => {
  try {
    return redactedJson(JSON.parse(value) as unknown);
  } catch {
    // A malformed legacy JSON field was already unreadable. Preserve its
    // evidence as a valid JSON string while still removing embedded secrets.
    return JSON.stringify(redactWorkflowText(value));
  }
};

const cachePayloadIsSafe = (...values: ReadonlyArray<unknown>): boolean =>
  inspectWorkflowSensitiveData(values).length === 0;

const secureWorkflowStoreFiles = async (path: string): Promise<void> => {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      await chmod(candidate, WORKFLOW_STORE_FILE_MODE);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
};

const sqliteDateTime = (date: Date): string =>
  date.toISOString().slice(0, 19).replace("T", " ");

const sqliteTimestampMs = (timestamp: string | undefined): number | null => {
  if (timestamp === undefined) return null;
  const parsed = Date.parse(`${timestamp.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
};

const pickContractMetadata = (metadata: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (metadata === undefined) return {};
  const contractVersion = metadata.contractVersion;
  const instructionSource = metadata.instructionSource;
  return {
    ...(contractVersion !== undefined ? { contractVersion } : {}),
    ...(instructionSource !== undefined ? { instructionSource } : {}),
  };
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
};

export const workflowRunLiveness = (
  run: Pick<WorkflowRunRecord, "status" | "runnerPid" | "heartbeatAt">,
  nowMs: number = Date.now(),
): WorkflowRunLiveness => {
  if (run.status !== "running") return "unknown";
  if (run.runnerPid === undefined || run.heartbeatAt === undefined) return "unknown";
  const heartbeatMs = sqliteTimestampMs(run.heartbeatAt);
  if (heartbeatMs === null || heartbeatMs > nowMs) return "unknown";
  if (!processIsAlive(run.runnerPid)) return "stale";
  return nowMs - heartbeatMs > WORKFLOW_RUN_LIVENESS_STALE_AFTER_MS ? "stale" : "alive";
};

const objectPayload = (payload: unknown): Record<string, unknown> | null =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
const serializeAttemptMetadata = (
  metadata: Record<string, unknown> | undefined,
): {
  readonly metadata: Record<string, unknown> | undefined;
  readonly json: string | null;
  readonly adapter: string | null;
  readonly model: string | null;
  readonly nativeAgent: string | null;
  readonly sessionId: string | null;
} => {
  const normalized = normalizeWorkflowSessionMetadata(metadata);
  if (normalized === undefined) {
    return {
      metadata: undefined,
      json: null,
      adapter: null,
      model: null,
      nativeAgent: null,
      sessionId: null,
    };
  }
  const persisted = redactWorkflowData(normalized);
  // Attempt metadata is persisted whole: a verbose harness attempt is evidence
  // to keep, not a store violation to reject.
  const json = stableJsonStringify(persisted as unknown as StableJsonValue);
  const stableSession = workflowStableSessionFromMetadata(persisted);
  return {
    metadata: persisted,
    json,
    adapter: stableSession?.adapter ?? stringMetadata(normalized, "adapter"),
    model: stringMetadata(persisted, "model"),
    nativeAgent: stringMetadata(persisted, "nativeAgent"),
    sessionId: stableSession?.sessionId ?? externalSessionPointer(persisted),
  };
};

const terminalCauseForStatus = (
  status: Exclude<WorkflowRunStatus, "running" | "unknown">,
  cause: WorkflowRunTerminalCause | undefined,
): WorkflowRunTerminalCause => {
  const resolved = cause ?? (status === "completed" ? { kind: "completed" as const } : undefined);
  if (resolved === undefined) {
    throw new Error(`Workflow run status ${status} requires a terminal cause`);
  }
  const valid = (
    (status === "completed" && resolved.kind === "completed")
    || (status === "failed" && (
      resolved.kind === "task-failed"
      || resolved.kind === "workflow-failed"
      || resolved.kind === "workflow-timeout"
      || resolved.kind === "workflow-fanout-exceeded"
      || resolved.kind === "workflow-cost-exceeded"
      || resolved.kind === "workflow-cost-unavailable"
      || resolved.kind === "workflow-prompt-limit-exceeded"
    ))
    || (status === "escalated" && resolved.kind === "task-escalated")
    || (status === "stopped" && resolved.kind === "stopped")
    || (status === "crashed" && resolved.kind === "crashed")
  );
  if (!valid) {
    throw new Error(`Workflow run status ${status} is incompatible with terminal cause ${resolved.kind}`);
  }
  return resolved;
};

const taskAttemptFailureMessageFromRunCause = (cause: WorkflowRunTerminalCause): string => {
  switch (cause.kind) {
    case "task-failed":
    case "task-escalated":
    case "workflow-failed":
      return cause.message;
    case "workflow-timeout":
      return `workflow exceeded maxWallMs of ${cause.limitMs}ms`;
    case "workflow-fanout-exceeded":
      return `workflow live task dispatch ${cause.observed} exceeds maxTasks ${cause.limit}`;
    case "workflow-cost-exceeded":
      return `workflow cost ${cause.observedUsd} USD exceeds maxCostUsd ${cause.limitUsd} USD`;
    case "workflow-cost-unavailable":
      return `workflow maxCostUsd ${cause.limitUsd} USD cannot be enforced because a live task attempt did not report costUsd; use a worker/provider that reports cost or omit --max-cost-usd`;
    case "workflow-prompt-limit-exceeded":
      return `workflow task ${cause.taskId} prompt context is ${cause.observedBytes} bytes, exceeding maxPromptBytes ${cause.limitBytes}; shorten the task/repair prompt or raise --max-prompt-bytes deliberately`;
    default:
      return cause.kind;
  }
};

const taskAttemptTerminalFromRun = (
  status: Exclude<WorkflowRunStatus, "running" | "unknown">,
  cause: WorkflowRunTerminalCause,
): {
  readonly status: Exclude<WorkflowTaskAttemptStatus, "running">;
  readonly failure: WorkflowTaskAttemptFailure | null;
} => {
  if (status === "completed") return { status: "completed", failure: null };
  if (status === "stopped") {
    return { status: "stopped", failure: { kind: "stopped", message: cause.kind === "stopped" ? cause.reason : cause.kind } };
  }
  if (status === "crashed") {
    return { status: "crashed", failure: { kind: "crashed", message: cause.kind === "crashed" ? cause.reason : cause.kind } };
  }
  return {
    status: "failed",
    failure: {
      kind: "executor",
      message: taskAttemptFailureMessageFromRunCause(cause),
    },
  };
};

const workflowUsageTotalsFromRow = (row: RunRow): WorkflowUsageTotals => ({
  agentRuns: row.usage_agent_runs,
  reused: row.usage_reused,
  tokensIn: row.usage_tokens_in,
  tokensOut: row.usage_tokens_out,
  costUsd: row.usage_cost_usd,
  durationMs: row.usage_duration_ms,
});

const runRecordFromRow = (row: RunRow & { readonly created_at?: string }): WorkflowRunRecord => {
  const durable = {
    status: row.status,
    ...(row.runner_pid !== null ? { runnerPid: row.runner_pid } : {}),
    ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
  };
  return {
    runId: row.run_id,
    workflow: row.workflow,
    ...durable,
    liveness: workflowRunLiveness(durable),
    terminalCause: row.terminal_cause_json === null
      ? null
      : JSON.parse(row.terminal_cause_json) as WorkflowRunTerminalCause,
    finishedAt: row.finished_at,
    ...(row.created_at !== undefined ? { createdAt: row.created_at } : {}),
    usage: workflowUsageTotalsFromRow(row),
  };
};

const stringMetadata = (metadata: Record<string, unknown> | undefined, key: string): string | null => {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const numberMetadata = (metadata: Record<string, unknown> | undefined, key: string): number | null => {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const externalSessionPointer = (metadata: Record<string, unknown> | undefined): string | null =>
  workflowStableSessionFromMetadata(metadata)?.sessionId
    ?? stringMetadata(metadata, "externalSessionPointer")
    ?? stringMetadata(metadata, "sessionId")
    ?? stringMetadata(metadata, "sessionID")
    ?? stringMetadata(metadata, "session_id");

const objectMetadata = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const repairModeMetadata = (metadata: Record<string, unknown> | undefined): string | null => {
  const finishMode = objectMetadata(metadata?.finish)?.repairMode;
  if (typeof finishMode === "string") return finishMode;
  const executionMode = objectMetadata(metadata?.repairExecution)?.mode;
  return typeof executionMode === "string" ? executionMode : null;
};

const nonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const repairCountMetadata = (metadata: Record<string, unknown> | undefined): number | null => {
  const finish = objectMetadata(metadata?.finish);
  const decodeRepairs = nonNegativeInteger(finish?.decodeRepairs);
  const finishRepairs = nonNegativeInteger(finish?.finishRepairs);
  if (decodeRepairs !== null || finishRepairs !== null) {
    return (decodeRepairs ?? 0) + (finishRepairs ?? 0);
  }
  const legacyRepairs = nonNegativeInteger(finish?.repairs);
  if (legacyRepairs !== null) return legacyRepairs;
  return nonNegativeInteger(objectMetadata(metadata?.repairExecution)?.attempt);
};

const eventRepairMode = (payload: Record<string, unknown> | null): string | null => {
  const mode = payload?.mode ?? payload?.repairMode;
  return typeof mode === "string" && mode.length > 0 ? mode : null;
};

const eventRepairCount = (payload: Record<string, unknown> | null): number | null => {
  const repairs = payload?.repairs;
  return typeof repairs === "number" && Number.isInteger(repairs) && repairs >= 0 ? repairs : null;
};

const elapsedMs = (start: string | undefined, finish: string | undefined): number | null => {
  const startMs = sqliteTimestampMs(start);
  const finishMs = sqliteTimestampMs(finish);
  if (startMs === null || finishMs === null || finishMs < startMs) return null;
  return finishMs - startMs;
};

const uniqueBadges = (badges: ReadonlyArray<WorkflowCacheBadge>): WorkflowCacheBadge[] =>
  Array.from(new Set(badges));

const eventPayloadRecord = (event: WorkflowEventRecord): Record<string, unknown> | null =>
  objectPayload(event.payload);

const taskBadges = (
  summary: WorkflowRunTaskCompactSummary,
  events: ReadonlyArray<WorkflowEventRecord>,
): WorkflowCacheBadge[] => {
  const badges: WorkflowCacheBadge[] = [];
  if (summary.cacheLookup !== undefined) badges.push(summary.cacheLookup);
  if (summary.execution === "cached") badges.push("cached");
  if (summary.execution === "fresh") badges.push("fresh");
  if (summary.repairCount > 0) badges.push(`repair ${summary.repairCount}`);
  if (events.some((event) => event.type === "task.cache_write.completed")) badges.push("write");
  if (events.some((event) => eventPayloadRecord(event)?.outputSource === "mock-output")) {
    badges.push("mock");
  }
  return uniqueBadges(badges);
};

const runBadges = (summary: WorkflowRunCompactSummary): WorkflowCacheBadge[] => {
  const badges: WorkflowCacheBadge[] = [];
  if (summary.totals.cacheHits > 0) badges.push("hit");
  if (summary.totals.freshExecutions > 0) badges.push("fresh");
  if (summary.totals.repairs > 0) badges.push(`repair ${summary.totals.repairs}`);
  if (summary.tasks.some((task) => task.cacheLookup === "miss")) badges.push("miss");
  if (summary.tasks.some((task) => task.cacheLookup === "skipped")) badges.push("skipped");
  return uniqueBadges(badges);
};

const taskRecordKey = (task: { readonly taskId: string; readonly ordinal: number }): string =>
  `task:${task.ordinal}:${task.taskId}`;

const eventTaskKey = (
  taskId: string,
  rowKeysByTaskId: ReadonlyMap<string, ReadonlyArray<string>>,
): string => {
  const keys = rowKeysByTaskId.get(taskId);
  return keys?.[0] ?? `event:${taskId}`;
};

const addColumnIfMissing = (db: WorkflowDatabase, statement: string): void => {
  try {
    db.exec(statement);
  } catch (error) {
    if (error instanceof Error && error.message.includes("duplicate column name")) {
      return;
    }
    throw error;
  }
};

const enableConcurrentWorkflowAccess = (db: WorkflowDatabase): void => {
  db.exec("pragma busy_timeout = 5000;");
  db.exec("pragma secure_delete = on;");
  try {
    db.exec("pragma journal_mode = WAL;");
  } catch (error) {
    if (error instanceof Error && error.message.includes("database is locked")) {
      return;
    }
    throw error;
  }
};

const readWorkflowStoreSchemaVersion = (db: WorkflowDatabase): number => {
  const row = db.query<{ readonly user_version: number }, []>("pragma user_version;").get();
  return row?.user_version ?? 0;
};

const migrateWorkflowStoreToVersion1 = (db: WorkflowDatabase): void => {
  db.transaction(() => {
    db.exec(`
      -- cache_key ANDs with prompt_hash in the primary key below (never a
      -- substitute for it) — see the authoring discipline documented on
      -- WorkflowTaskIdentity in workflow-identity.ts.
      create table if not exists workflow_task_records (
        workflow text not null,
        task_id text not null,
        cache_key text not null,
        prompt_hash text not null,
        agent_manifest_hash text not null,
        agent_plugin text not null,
        agent_name text not null,
        status text not null,
        output_json text not null,
        metadata_json text,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now')),
        primary key (workflow, task_id, cache_key, prompt_hash, agent_manifest_hash)
      );

      create table if not exists workflow_judge_records (
        workflow text not null,
        task_id text not null,
        task_cache_key text not null,
        criterion text not null,
        judge_cache_key text not null primary key,
        verdict text not null,
        feedback text,
        evidence_json text not null,
        output_json text not null,
        task_metadata_json text not null,
        metadata_json text,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );

      create table if not exists workflow_runs (
        run_id text primary key,
        workflow text not null,
        status text not null default 'running',
        finished_at text,
        handoff_token text,
        runner_pid integer,
        heartbeat_at text,
        created_at text not null default (datetime('now'))
      );

      create table if not exists workflow_run_tasks (
        run_id text not null,
        ordinal integer not null,
        workflow text not null,
        task_id text not null,
        cache_key text not null,
        prompt_hash text not null,
        agent_manifest_hash text not null,
        agent_plugin text not null,
        agent_name text not null,
        status text not null,
        cached integer not null,
        output_json text not null,
        metadata_json text,
        created_at text not null default (datetime('now')),
        primary key (run_id, ordinal)
      );

      create table if not exists workflow_events (
        run_id text not null,
        sequence integer not null,
        task_id text,
        type text not null,
        payload_json text not null,
        created_at text not null default (datetime('now')),
        primary key (run_id, sequence)
      );

      create table if not exists workflow_run_snapshots (
        run_id text primary key,
        workflow_file text not null,
        options_json text,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );

      create table if not exists workflow_run_task_snapshots (
        run_id text not null,
        ordinal integer not null,
        task_id text not null,
        phase text,
        prompt text not null,
        cache_key text not null,
        prompt_hash text not null,
        agent_manifest_hash text not null,
        agent_plugin text not null,
        agent_name text not null,
        agent_description text not null,
        agent_source_hash text not null,
        worker_json text,
        output_schema_json text,
        finish_criteria_json text not null,
        created_at text not null default (datetime('now')),
        primary key (run_id, ordinal)
      );

      create table if not exists workflow_spans (
        run_id text not null,
        trace_id text not null,
        span_id text primary key,
        parent_span_id text,
        task_id text,
        name text not null,
        kind text not null default 'internal',
        start_ns text not null,
        end_ns text,
        duration_ms real,
        status text not null default 'unset',
        error_message text,
        attributes_json text not null default '{}',
        created_at text not null default (datetime('now'))
      );

      create index if not exists workflow_spans_run_idx on workflow_spans (run_id, start_ns);
    `);
    addColumnIfMissing(db, "alter table workflow_runs add column status text not null default 'unknown'");
    addColumnIfMissing(db, "alter table workflow_runs add column finished_at text");
    addColumnIfMissing(db, "alter table workflow_runs add column handoff_token text");
    addColumnIfMissing(db, "alter table workflow_runs add column runner_pid integer");
    addColumnIfMissing(db, "alter table workflow_runs add column heartbeat_at text");
    addColumnIfMissing(db, "alter table workflow_task_records add column metadata_json text");
    addColumnIfMissing(db, "alter table workflow_run_tasks add column metadata_json text");
    addColumnIfMissing(db, "alter table workflow_task_records add column output_source text");
    // Legacy ledgers did not know the workflow's full task count, so completed
    // task rows are not proof that the whole run finished. Only failed task rows
    // carry enough evidence to safely backfill a terminal status.
    db.exec(`
      update workflow_runs
      set status = 'failed', finished_at = coalesce(finished_at, datetime('now'))
      where status = 'unknown'
        and exists (
          select 1 from workflow_run_tasks
          where workflow_run_tasks.run_id = workflow_runs.run_id
            and workflow_run_tasks.status = 'failed'
        );
    `);
    db.exec("pragma user_version = 1;");
  })();
};
const migrateWorkflowStoreToVersion2 = (db: WorkflowDatabase): void => {
  db.transaction(() => {
    addColumnIfMissing(db, "alter table workflow_runs add column terminal_cause_json text");
    db.exec(`
      create table if not exists workflow_task_attempts (
        run_id text not null,
        ordinal integer not null,
        attempt integer not null,
        task_id text not null,
        status text not null check (status in ('running', 'completed', 'failed', 'stopped', 'crashed')),
        started_at text not null default (datetime('now')),
        finished_at text,
        adapter text,
        model text,
        native_agent text,
        session_id text,
        failure_kind text check (failure_kind is null or failure_kind in ('executor', 'decode', 'finish', 'stopped', 'crashed')),
        failure_message text,
        metadata_json text,
        primary key (run_id, ordinal, attempt)
      );
      create index if not exists workflow_task_attempts_run_idx
        on workflow_task_attempts (run_id, ordinal, attempt);
    `);
    db.exec("pragma user_version = 2;");
  })();
};

const migrateWorkflowStoreToVersion3 = (db: WorkflowDatabase): void => {
  db.transaction(() => {
    addColumnIfMissing(db, "alter table workflow_runs add column usage_agent_runs integer not null default 0");
    addColumnIfMissing(db, "alter table workflow_runs add column usage_reused integer not null default 0");
    addColumnIfMissing(db, "alter table workflow_runs add column usage_tokens_in real not null default 0");
    addColumnIfMissing(db, "alter table workflow_runs add column usage_tokens_out real not null default 0");
    addColumnIfMissing(db, "alter table workflow_runs add column usage_cost_usd real not null default 0");
    addColumnIfMissing(db, "alter table workflow_runs add column usage_duration_ms real not null default 0");
    addColumnIfMissing(db, "alter table workflow_task_attempts add column usage_json text");

    const totalsByRun = new Map<string, WorkflowUsageTotals>();
    const runs = db.query<{ readonly run_id: string }, []>("select run_id from workflow_runs").all();
    for (const run of runs) totalsByRun.set(run.run_id, emptyWorkflowUsageTotals());

    const attempts = db.query<{
      readonly run_id: string;
      readonly ordinal: number;
      readonly attempt: number;
      readonly metadata_json: string | null;
    }, []>(`
      select run_id, ordinal, attempt, metadata_json
      from workflow_task_attempts
      where status != 'running'
    `).all();
    for (const attempt of attempts) {
      const metadata = attempt.metadata_json === null
        ? undefined
        : JSON.parse(attempt.metadata_json) as Record<string, unknown>;
      const usage = workflowUsageFromMetadata(metadata);
      db.query(`
        update workflow_task_attempts
        set usage_json = ?
        where run_id = ? and ordinal = ? and attempt = ?
      `).run(
        stableJsonStringify(usage as unknown as StableJsonValue),
        attempt.run_id,
        attempt.ordinal,
        attempt.attempt,
      );
      const current = totalsByRun.get(attempt.run_id);
      if (current !== undefined) totalsByRun.set(attempt.run_id, addWorkflowUsage(current, usage));
    }

    const cachedTasks = db.query<{ readonly run_id: string }, []>(`
      select run_id from workflow_run_tasks where cached = 1
    `).all();
    for (const task of cachedTasks) {
      const current = totalsByRun.get(task.run_id);
      if (current !== undefined) totalsByRun.set(task.run_id, addWorkflowReuse(current));
    }

    const updateRun = db.query(`
      update workflow_runs
      set usage_agent_runs = ?,
          usage_reused = ?,
          usage_tokens_in = ?,
          usage_tokens_out = ?,
          usage_cost_usd = ?,
          usage_duration_ms = ?
      where run_id = ?
    `);
    for (const [runId, totals] of totalsByRun) {
      updateRun.run(
        totals.agentRuns,
        totals.reused,
        totals.tokensIn,
        totals.tokensOut,
        totals.costUsd,
        totals.durationMs,
        runId,
      );
    }
    db.exec("pragma user_version = 3;");
  })();
};

interface LegacyWorkflowTaskRecordRow {
  readonly workflow: string;
  readonly task_id: string;
  readonly cache_key: string;
  readonly prompt_hash: string;
  readonly agent_manifest_hash: string;
  readonly agent_plugin: string;
  readonly agent_name: string;
  readonly status: string;
  readonly output_json: string;
  readonly metadata_json: string | null;
  readonly output_source: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * AR-001: migrate `workflow_task_records` from the workflow-scoped primary
 * key `(workflow, task_id, cache_key, prompt_hash, agent_manifest_hash)` to
 * the global content-addressed `(scope_key, stable_key, semantic_hash)` — see
 * `workflowTaskResourceKey` above. SQLite cannot alter a primary key in
 * place, so this rebuilds the table and replays every existing row through
 * the same resource-key derivation the runtime now uses, applying the exact
 * mock-output-override upsert rule `recordCompleted` applies at runtime (see
 * below) so a legacy dataset that already contains two rows which collide
 * under the new global key resolves identically to two live writers racing
 * on the same key today. Some pre-v1-complete ledgers (and hand-built test
 * fixtures that stamp `user_version` directly) never created
 * `workflow_task_records` at all, so the source table is optional — its
 * absence just means there is nothing to replay.
 */
const migrateWorkflowStoreToVersion4 = (db: WorkflowDatabase): void => {
  db.transaction(() => {
    const legacyTableExists = db.query<{ readonly name: string }, []>(`
      select name from sqlite_master where type = 'table' and name = 'workflow_task_records'
    `).get() !== null;
    const legacyRows = legacyTableExists
      ? db.query<LegacyWorkflowTaskRecordRow, []>(`
          select workflow, task_id, cache_key, prompt_hash, agent_manifest_hash,
                 agent_plugin, agent_name, status, output_json, metadata_json, output_source, created_at, updated_at
          from workflow_task_records
          order by created_at asc, rowid asc
        `).all()
      : [];

    db.exec(`
      create table workflow_task_records_ar001_v4 (
        scope_key text not null,
        stable_key text not null,
        semantic_hash text not null,
        workflow text not null,
        task_id text not null,
        cache_key text not null,
        prompt_hash text not null,
        agent_manifest_hash text not null,
        agent_plugin text not null,
        agent_name text not null,
        status text not null,
        output_json text not null,
        metadata_json text,
        output_source text,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now')),
        primary key (scope_key, stable_key, semantic_hash)
      );
    `);

    const insert = db.query(`
      insert into workflow_task_records_ar001_v4 (
        scope_key, stable_key, semantic_hash, workflow, task_id, cache_key,
        prompt_hash, agent_manifest_hash, agent_plugin, agent_name, status,
        output_json, metadata_json, output_source, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(scope_key, stable_key, semantic_hash)
      do update set
        agent_plugin = excluded.agent_plugin,
        agent_name = excluded.agent_name,
        status = excluded.status,
        output_json = excluded.output_json,
        metadata_json = excluded.metadata_json,
        output_source = excluded.output_source,
        updated_at = excluded.updated_at
      where workflow_task_records_ar001_v4.output_source = 'mock-output'
        and excluded.output_source is null
    `);

    for (const row of legacyRows) {
      const key = workflowTaskResourceKey({
        workflow: row.workflow,
        taskId: row.task_id,
        cacheKey: row.cache_key,
        promptHash: row.prompt_hash,
        agentManifestHash: row.agent_manifest_hash,
      });
      insert.run(
        key.scopeKey,
        key.stableKey,
        key.semanticHash,
        row.workflow,
        row.task_id,
        row.cache_key,
        row.prompt_hash,
        row.agent_manifest_hash,
        row.agent_plugin,
        row.agent_name,
        row.status,
        row.output_json,
        row.metadata_json,
        row.output_source,
        row.created_at,
        row.updated_at,
      );
    }

    db.exec("drop table if exists workflow_task_records;");
    db.exec("alter table workflow_task_records_ar001_v4 rename to workflow_task_records;");
    db.exec("pragma user_version = 4;");
  })();
};

/**
 * PRD-010: establish the workflow ledger's durable-data boundary. Historical
 * evidence is redacted in place, whereas cache entries containing secrets are
 * removed instead of rewritten because rewriting would change cache semantics.
 */
const migrateWorkflowStoreToVersion5 = (db: WorkflowDatabase): void => {
  db.transaction(() => {
    // Some early ledgers and hand-built integrations stamped a schema version
    // while omitting unused tables. Version 5 makes the current schema whole so
    // governance commands can count and clean every artifact deterministically.
    db.exec(`
      create table if not exists workflow_judge_records (
        workflow text not null,
        task_id text not null,
        task_cache_key text not null,
        criterion text not null,
        judge_cache_key text not null primary key,
        verdict text not null,
        feedback text,
        evidence_json text not null,
        output_json text not null,
        task_metadata_json text not null,
        metadata_json text,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );
      create table if not exists workflow_run_tasks (
        run_id text not null,
        ordinal integer not null,
        workflow text not null,
        task_id text not null,
        cache_key text not null,
        prompt_hash text not null,
        agent_manifest_hash text not null,
        agent_plugin text not null,
        agent_name text not null,
        status text not null,
        cached integer not null,
        output_json text not null,
        metadata_json text,
        created_at text not null default (datetime('now')),
        primary key (run_id, ordinal)
      );
      create table if not exists workflow_events (
        run_id text not null,
        sequence integer not null,
        task_id text,
        type text not null,
        payload_json text not null,
        created_at text not null default (datetime('now')),
        primary key (run_id, sequence)
      );
      create table if not exists workflow_run_snapshots (
        run_id text primary key,
        workflow_file text not null,
        options_json text,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );
      create table if not exists workflow_run_task_snapshots (
        run_id text not null,
        ordinal integer not null,
        task_id text not null,
        phase text,
        prompt text not null,
        cache_key text not null,
        prompt_hash text not null,
        agent_manifest_hash text not null,
        agent_plugin text not null,
        agent_name text not null,
        agent_description text not null,
        agent_source_hash text not null,
        worker_json text,
        output_schema_json text,
        finish_criteria_json text not null,
        created_at text not null default (datetime('now')),
        primary key (run_id, ordinal)
      );
      create table if not exists workflow_spans (
        run_id text not null,
        trace_id text not null,
        span_id text primary key,
        parent_span_id text,
        task_id text,
        name text not null,
        kind text not null default 'internal',
        start_ns text not null,
        end_ns text,
        duration_ms real,
        status text not null default 'unset',
        error_message text,
        attributes_json text not null default '{}',
        created_at text not null default (datetime('now'))
      );
      create index if not exists workflow_spans_run_idx on workflow_spans (run_id, start_ns);
      create table if not exists workflow_task_attempts (
        run_id text not null,
        ordinal integer not null,
        attempt integer not null,
        task_id text not null,
        status text not null check (status in ('running', 'completed', 'failed', 'stopped', 'crashed')),
        started_at text not null default (datetime('now')),
        finished_at text,
        adapter text,
        model text,
        native_agent text,
        session_id text,
        failure_kind text check (failure_kind is null or failure_kind in ('executor', 'decode', 'finish', 'stopped', 'crashed')),
        failure_message text,
        metadata_json text,
        usage_json text,
        primary key (run_id, ordinal, attempt)
      );
      create index if not exists workflow_task_attempts_run_idx
        on workflow_task_attempts (run_id, ordinal, attempt);
      create table if not exists workflow_runner_log_cleanup (
        run_id text primary key,
        queued_at text not null default (datetime('now'))
      );
    `);
    const tableExists = (name: string): boolean => db.query<{ readonly name: string }, [string]>(
      "select name from sqlite_master where type = 'table' and name = ?",
    ).get(name) !== null;

    const taskCacheRows = db.query<{
      readonly row_id: number;
      readonly workflow: string;
      readonly task_id: string;
      readonly cache_key: string;
      readonly agent_plugin: string;
      readonly agent_name: string;
      readonly output_json: string;
      readonly metadata_json: string | null;
    }, []>(`
      select rowid as row_id, workflow, task_id, cache_key, agent_plugin,
             agent_name, output_json, metadata_json
      from workflow_task_records
    `).all();
    const deleteTaskCache = db.query("delete from workflow_task_records where rowid = ?");
    for (const row of taskCacheRows) {
      let safe = false;
      try {
        safe = cachePayloadIsSafe(
          {
            workflow: row.workflow,
            taskId: row.task_id,
            cacheKey: row.cache_key,
            agent: { plugin: row.agent_plugin, name: row.agent_name },
          },
          JSON.parse(row.output_json) as unknown,
          row.metadata_json === null ? undefined : JSON.parse(row.metadata_json) as unknown,
        );
      } catch {
        // Invalid JSON cannot be a trustworthy cache hit.
      }
      if (!safe) deleteTaskCache.run(row.row_id);
    }

    if (tableExists("workflow_judge_records")) {
      const judgeCacheRows = db.query<{
        readonly row_id: number;
        readonly workflow: string;
        readonly task_id: string;
        readonly task_cache_key: string;
        readonly criterion: string;
        readonly judge_cache_key: string;
        readonly feedback: string | null;
        readonly evidence_json: string;
        readonly output_json: string;
        readonly task_metadata_json: string;
        readonly metadata_json: string | null;
      }, []>(`
        select rowid as row_id, workflow, task_id, task_cache_key, criterion,
               judge_cache_key, feedback, evidence_json, output_json,
               task_metadata_json, metadata_json
        from workflow_judge_records
      `).all();
      const deleteJudgeCache = db.query("delete from workflow_judge_records where rowid = ?");
      for (const row of judgeCacheRows) {
        let safe = false;
        try {
          safe = cachePayloadIsSafe(
            {
              workflow: row.workflow,
              taskId: row.task_id,
              taskCacheKey: row.task_cache_key,
              criterion: row.criterion,
              cacheKey: row.judge_cache_key,
            },
            row.feedback,
            JSON.parse(row.evidence_json) as unknown,
            JSON.parse(row.output_json) as unknown,
            JSON.parse(row.task_metadata_json) as unknown,
            row.metadata_json === null ? undefined : JSON.parse(row.metadata_json) as unknown,
          );
        } catch {
          // Invalid JSON cannot be a trustworthy cache hit.
        }
        if (!safe) deleteJudgeCache.run(row.row_id);
      }
    }

    const runs = db.query<{
      readonly run_id: string;
      readonly workflow: string;
      readonly terminal_cause_json: string | null;
      readonly handoff_token: string | null;
    }, []>(`
      select run_id, workflow, terminal_cause_json, handoff_token
      from workflow_runs
    `).all();
    const updateRun = db.query(`
      update workflow_runs
      set workflow = ?, terminal_cause_json = ?, handoff_token = ?
      where run_id = ?
    `);
    for (const row of runs) {
      const handoffToken = row.handoff_token === null
        ? null
        : row.handoff_token.startsWith(WORKFLOW_SECRET_DIGEST_PREFIX)
          ? row.handoff_token
          : digestWorkflowSecret(row.handoff_token);
      updateRun.run(
        redactWorkflowText(row.workflow),
        row.terminal_cause_json === null ? null : redactPersistedJson(row.terminal_cause_json),
        handoffToken,
        row.run_id,
      );
    }

    if (tableExists("workflow_run_tasks")) {
      const runTasks = db.query<{
      readonly run_id: string;
      readonly ordinal: number;
      readonly workflow: string;
      readonly output_json: string;
      readonly metadata_json: string | null;
    }, []>(`
      select run_id, ordinal, workflow, output_json, metadata_json
      from workflow_run_tasks
    `).all();
      const updateRunTask = db.query(`
      update workflow_run_tasks
      set workflow = ?, output_json = ?, metadata_json = ?
      where run_id = ? and ordinal = ?
    `);
      for (const row of runTasks) {
        updateRunTask.run(
          redactWorkflowText(row.workflow),
          redactPersistedJson(row.output_json),
          row.metadata_json === null ? null : redactPersistedJson(row.metadata_json),
          row.run_id,
          row.ordinal,
        );
      }
    }

    if (tableExists("workflow_task_attempts")) {
      const attempts = db.query<{
      readonly run_id: string;
      readonly ordinal: number;
      readonly attempt: number;
      readonly failure_message: string | null;
      readonly metadata_json: string | null;
    }, []>(`
      select run_id, ordinal, attempt, failure_message, metadata_json
      from workflow_task_attempts
    `).all();
      const updateAttempt = db.query(`
      update workflow_task_attempts
      set failure_message = ?, metadata_json = ?
      where run_id = ? and ordinal = ? and attempt = ?
    `);
      for (const row of attempts) {
        updateAttempt.run(
          row.failure_message === null ? null : redactWorkflowText(row.failure_message),
          row.metadata_json === null ? null : redactPersistedJson(row.metadata_json),
          row.run_id,
          row.ordinal,
          row.attempt,
        );
      }
    }

    if (tableExists("workflow_events")) {
      const events = db.query<{
      readonly run_id: string;
      readonly sequence: number;
      readonly payload_json: string;
    }, []>("select run_id, sequence, payload_json from workflow_events").all();
      const updateEvent = db.query(`
      update workflow_events set payload_json = ? where run_id = ? and sequence = ?
    `);
      for (const row of events) {
        updateEvent.run(redactPersistedJson(row.payload_json), row.run_id, row.sequence);
      }
    }

    if (tableExists("workflow_run_snapshots")) {
      const runSnapshots = db.query<{
      readonly run_id: string;
      readonly workflow_file: string;
      readonly options_json: string | null;
    }, []>("select run_id, workflow_file, options_json from workflow_run_snapshots").all();
      const updateRunSnapshot = db.query(`
      update workflow_run_snapshots set workflow_file = ?, options_json = ? where run_id = ?
    `);
      for (const row of runSnapshots) {
        updateRunSnapshot.run(
          redactWorkflowText(row.workflow_file),
          row.options_json === null ? null : redactPersistedJson(row.options_json),
          row.run_id,
        );
      }
    }

    if (tableExists("workflow_run_task_snapshots")) {
      const taskSnapshots = db.query<{
      readonly run_id: string;
      readonly ordinal: number;
      readonly prompt: string;
      readonly agent_description: string;
      readonly worker_json: string | null;
      readonly output_schema_json: string | null;
      readonly finish_criteria_json: string;
    }, []>(`
      select run_id, ordinal, prompt, agent_description, worker_json,
             output_schema_json, finish_criteria_json
      from workflow_run_task_snapshots
    `).all();
      const updateTaskSnapshot = db.query(`
      update workflow_run_task_snapshots
      set prompt = ?, agent_description = ?, worker_json = ?,
          output_schema_json = ?, finish_criteria_json = ?
      where run_id = ? and ordinal = ?
    `);
      for (const row of taskSnapshots) {
        updateTaskSnapshot.run(
          redactWorkflowText(row.prompt),
          redactWorkflowText(row.agent_description),
          row.worker_json === null ? null : redactPersistedJson(row.worker_json),
          row.output_schema_json === null ? null : redactPersistedJson(row.output_schema_json),
          redactPersistedJson(row.finish_criteria_json),
          row.run_id,
          row.ordinal,
        );
      }
    }

    if (tableExists("workflow_spans")) {
      const spans = db.query<{
      readonly span_id: string;
      readonly error_message: string | null;
      readonly attributes_json: string;
    }, []>("select span_id, error_message, attributes_json from workflow_spans").all();
      const updateSpan = db.query(`
      update workflow_spans set error_message = ?, attributes_json = ? where span_id = ?
    `);
      for (const row of spans) {
        updateSpan.run(
          row.error_message === null ? null : redactWorkflowText(row.error_message),
          redactPersistedJson(row.attributes_json),
          row.span_id,
        );
      }
    }

    db.exec("pragma user_version = 5;");
  })();
};

export class WorkflowStore {
  initialRetentionCleanup: WorkflowRetentionCleanupReport | null = null;

  constructor(
    private readonly db: WorkflowDatabase,
    readonly path: string,
    readonly schemaNotice: WorkflowStoreSchemaNotice | null = null,
  ) {}
  private updateRunUsageInCurrentTransaction(
    runId: string,
    update: (current: WorkflowUsageTotals) => WorkflowUsageTotals,
  ): void {
    const row = this.db.query<RunRow, [string]>(`
      select run_id, workflow, status, terminal_cause_json, finished_at,
             runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
             usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms
      from workflow_runs
      where run_id = ?
    `).get(runId);
    if (row === null) throw new Error(`Workflow run ${runId} does not exist`);
    const usage = update(workflowUsageTotalsFromRow(row));
    this.db.query(`
      update workflow_runs
      set usage_agent_runs = ?,
          usage_reused = ?,
          usage_tokens_in = ?,
          usage_tokens_out = ?,
          usage_cost_usd = ?,
          usage_duration_ms = ?
      where run_id = ?
    `).run(
      usage.agentRuns,
      usage.reused,
      usage.tokensIn,
      usage.tokensOut,
      usage.costUsd,
      usage.durationMs,
      runId,
    );
  }


  static async open(
    path: string,
    options: { readonly applyDefaultRetention?: boolean } = {},
  ): Promise<WorkflowStore> {
    const directory = dirname(path);
    const directoryPreexisting = await exists(directory);
    await mkdir(directory, { recursive: true, mode: WORKFLOW_STORE_DIRECTORY_MODE });
    if (!directoryPreexisting) await chmod(directory, WORKFLOW_STORE_DIRECTORY_MODE);
    const preexisting = await exists(path);
    const handle = await openFile(path, "a", WORKFLOW_STORE_FILE_MODE);
    await handle.close();
    await chmod(path, WORKFLOW_STORE_FILE_MODE);

    let db: WorkflowDatabase | undefined;
    let schemaVersion = 0;
    const previousUmask = process.umask(0o077);
    try {
      db = openWorkflowDatabase(path);
      schemaVersion = readWorkflowStoreSchemaVersion(db);
      if (schemaVersion > WORKFLOW_STORE_SCHEMA_VERSION) {
        throw new Error(
          `Workflow store schema version ${schemaVersion} is newer than supported version ${WORKFLOW_STORE_SCHEMA_VERSION}. Upgrade Prism before opening ${path}.`,
        );
      }
      enableConcurrentWorkflowAccess(db);
      if (schemaVersion === 0) {
        migrateWorkflowStoreToVersion1(db);
      }
      if (schemaVersion <= 1) {
        migrateWorkflowStoreToVersion2(db);
      }
      if (schemaVersion <= 2) {
        migrateWorkflowStoreToVersion3(db);
      }
      if (schemaVersion <= 3) {
        migrateWorkflowStoreToVersion4(db);
      }
      if (schemaVersion <= 4) {
        migrateWorkflowStoreToVersion5(db);
      }
    } catch (error) {
      db?.close();
      throw error;
    } finally {
      process.umask(previousUmask);
    }

    const schemaNotice: WorkflowStoreSchemaNotice | null = preexisting && schemaVersion < WORKFLOW_STORE_SCHEMA_VERSION
      ? {
          severity: "info",
          openedVersion: schemaVersion,
          currentVersion: WORKFLOW_STORE_SCHEMA_VERSION,
          message: `Workflow store at ${path} was schema version ${schemaVersion}; migrated to ${WORKFLOW_STORE_SCHEMA_VERSION} on open.`,
        }
      : null;
    const store = new WorkflowStore(db, path, schemaNotice);
    try {
      await store.flushQueuedRunnerLogCleanup();
      // Detached runners write their crash channel outside SQLite. A hard kill
      // can bypass the child's terminal redaction, so every observer open
      // first terminalizes dead runner pids, then reconciles exact terminal
      // sidecars. Live logs are never rewritten underneath their writer.
      store.failDeadPidRuns();
      const observedRuns = db.query<{
        readonly run_id: string;
        readonly runner_pid: number | null;
      }, []>(
        "select run_id, runner_pid from workflow_runs where status != 'running' order by run_id asc",
      ).all();
      for (const run of observedRuns) {
        if (run.runner_pid !== null && processIsAlive(run.runner_pid)) continue;
        await redactWorkflowRunnerLogInPlace(path, run.run_id);
      }
      if (options.applyDefaultRetention !== false) {
        store.initialRetentionCleanup = await store.pruneByAge({ olderThanMs: DEFAULT_WORKFLOW_RETENTION_MS });
      }
      await secureWorkflowStoreFiles(path);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  // WFE-008: checkpoint without disrupting a detached runner sharing the
  // store. PASSIVE first moves every immediately available frame. When it
  // proves the WAL is fully checkpointed and no persisted foreign runner is
  // active, a zero-timeout TRUNCATE removes the empty sidecar; a concurrent
  // reader/writer makes that attempt report busy immediately instead of
  // blocking or failing the other process. Best-effort:
  // cleanup must never prevent close.
  close(): void {
    try {
      const checkpoint = this.db.query<{
        readonly busy: number;
        readonly log: number;
        readonly checkpointed: number;
      }, []>("pragma wal_checkpoint(passive);").get();
      const foreignRunner = this.db.query<{ readonly count: number }, [number]>(`
        select count(*) as count
        from workflow_runs
        where status = 'running' and runner_pid is not null and runner_pid != ?
      `).get(process.pid)?.count ?? 0;
      if (foreignRunner === 0 && checkpoint?.busy === 0 && checkpoint.log === checkpoint.checkpointed) {
        this.db.exec("pragma busy_timeout = 0;");
        this.db.exec("pragma wal_checkpoint(truncate);");
      }
    } catch {
      // best-effort by contract — see comment above
    }
    this.db.close();
  }

  private countRunArtifacts(runId: string): WorkflowRunArtifactCounts {
    const count = (table: string): number => {
      const row = this.db.query<{ readonly count: number }, [string]>(
        `select count(*) as count from ${table} where run_id = ?`,
      ).get(runId);
      return row?.count ?? 0;
    };
    return {
      runs: count("workflow_runs"),
      tasks: count("workflow_run_tasks"),
      attempts: count("workflow_task_attempts"),
      events: count("workflow_events"),
      spans: count("workflow_spans"),
      runSnapshots: count("workflow_run_snapshots"),
      taskSnapshots: count("workflow_run_task_snapshots"),
    };
  }

  private deleteRunRowsInCurrentTransaction(runId: string): WorkflowRunArtifactCounts {
    const counts = this.countRunArtifacts(runId);
    if (counts.runs > 0) {
      this.db.query(`
        insert into workflow_runner_log_cleanup (run_id) values (?)
        on conflict(run_id) do nothing
      `).run(runId);
    }
    this.db.query("delete from workflow_spans where run_id = ?").run(runId);
    this.db.query("delete from workflow_events where run_id = ?").run(runId);
    this.db.query("delete from workflow_task_attempts where run_id = ?").run(runId);
    this.db.query("delete from workflow_run_task_snapshots where run_id = ?").run(runId);
    this.db.query("delete from workflow_run_tasks where run_id = ?").run(runId);
    this.db.query("delete from workflow_run_snapshots where run_id = ?").run(runId);
    this.db.query("delete from workflow_runs where run_id = ?").run(runId);
    return counts;
  }

  private async removeQueuedRunnerLog(runId: string): Promise<WorkflowRunnerLogRemoval> {
    const runnerLog = await removeWorkflowRunnerLog(this.path, runId);
    this.db.query("delete from workflow_runner_log_cleanup where run_id = ?").run(runId);
    return runnerLog;
  }

  private async flushQueuedRunnerLogCleanup(): Promise<void> {
    const queued = this.db.query<{ readonly run_id: string }, []>(`
      select run_id from workflow_runner_log_cleanup order by queued_at asc, run_id asc
    `).all();
    for (const entry of queued) await this.removeQueuedRunnerLog(entry.run_id);
  }

  async inspectRun(runId: string): Promise<WorkflowRunInspection> {
    const run = this.getRun(runId);
    if (run === null) throw new Error(`Workflow run ${runId} does not exist`);
    const fileDetails = async (path: string) => {
      try {
        const file = await stat(path);
        return { path, present: true, mode: file.mode & 0o777, bytes: file.size } as const;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return { path, present: false, mode: null, bytes: null } as const;
        }
        throw error;
      }
    };
    let runnerLogPath: string | null = null;
    try {
      runnerLogPath = workflowRunnerLogPath(this.path, runId);
    } catch {
      // Historical stores may contain run ids that predate sidecar path safety.
    }
    const runnerLog = runnerLogPath === null
      ? { path: null, present: false, bytes: null } as const
      : await fileDetails(runnerLogPath).then((file) => ({
          path: file.path,
          present: file.present,
          bytes: file.bytes,
        }));
    return {
      schema: "prism.workflow-run-inspection.v1",
      dataPolicyVersion: WORKFLOW_DATA_POLICY_VERSION,
      store: {
        path: this.path,
        schemaVersion: readWorkflowStoreSchemaVersion(this.db),
        files: await Promise.all([this.path, `${this.path}-wal`, `${this.path}-shm`].map(fileDetails)),
      },
      run,
      rows: this.countRunArtifacts(runId),
      runnerLog,
    };
  }

  async exportRun(runId: string): Promise<WorkflowRunExport> {
    const run = this.getRun(runId);
    if (run === null) throw new Error(`Workflow run ${runId} does not exist`);
    let runnerLog: WorkflowRunExport["runnerLog"] = null;
    try {
      runnerLog = await readRedactedWorkflowRunnerLog(this.path, runId);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("cannot address a runner log path"))) {
        throw error;
      }
    }
    const spans = this.listSpans(runId).map((span) => ({
      ...span,
      startNs: span.startNs.toString(),
      endNs: span.endNs?.toString() ?? null,
    }));
    return redactWorkflowData({
      schema: "prism.workflow-run-export.v1",
      dataPolicyVersion: WORKFLOW_DATA_POLICY_VERSION,
      exportedAt: new Date().toISOString(),
      run,
      snapshot: this.getRunSnapshot(runId),
      tasks: this.listRunTasks(runId),
      taskSnapshots: this.listRunTaskSnapshots(runId),
      attempts: this.listRunTaskAttempts(runId),
      events: this.listRunEvents(runId),
      spans,
      runnerLog,
    });
  }

  async deleteRun(runId: string): Promise<WorkflowRunDeletionReport> {
    const run = this.getRun(runId);
    if (run?.status === "running") {
      throw new Error(`Workflow run ${runId} is running; stop it before deletion`);
    }
    if (run?.runnerPid !== undefined && processIsAlive(run.runnerPid)) {
      throw new Error(`Workflow run ${runId} still has live runner pid ${run.runnerPid}; wait for runner shutdown before deletion`);
    }
    const rows = this.db.transaction(() => this.deleteRunRowsInCurrentTransaction(runId))();
    const runnerLog = rows.runs > 0
      ? await this.removeQueuedRunnerLog(runId)
      : await removeWorkflowRunnerLog(this.path, runId);
    return {
      runId,
      status: rows.runs === 0 ? "missing" : "deleted",
      rows,
      runnerLog,
    };
  }

  async pruneByAge(options: {
    readonly olderThanMs?: number;
    readonly now?: Date;
  } = {}): Promise<WorkflowRetentionCleanupReport> {
    const olderThanMs = options.olderThanMs ?? DEFAULT_WORKFLOW_RETENTION_MS;
    const cutoff = workflowRetentionCutoff(olderThanMs, options.now);
    const cutoffSql = sqliteDateTime(cutoff);
    const candidates = this.db.query<{ readonly run_id: string }, [string]>(`
      select run_id
      from workflow_runs
      where status != 'running'
        and coalesce(finished_at, created_at) < ?
      order by coalesce(finished_at, created_at) asc, run_id asc
    `).all(cutoffSql);
    const taskCacheCandidates = this.db.query<{ readonly count: number }, [string]>(`
      select count(*) as count from workflow_task_records where updated_at < ?
    `).get(cutoffSql)?.count ?? 0;
    const judgeCacheCandidates = this.db.query<{ readonly count: number }, [string]>(`
      select count(*) as count from workflow_judge_records where updated_at < ?
    `).get(cutoffSql)?.count ?? 0;
    if (candidates.length === 0 && taskCacheCandidates === 0 && judgeCacheCandidates === 0) {
      return {
        policy: "workflow-ledger-retention-v1",
        olderThanMs,
        cutoff: cutoff.toISOString(),
        runs: { matched: 0, deleted: 0, rows: emptyWorkflowRunArtifactCounts() },
        caches: { taskCache: 0, judgeCache: 0 },
        runnerLogs: { deleted: 0, missing: 0, skippedUnsafeRunId: 0 },
      };
    }

    const result = this.db.transaction(() => {
      let rows = emptyWorkflowRunArtifactCounts();
      const deletedRunIds: string[] = [];
      for (const candidate of candidates) {
        const current = this.db.query<{
          readonly status: WorkflowRunStatus;
          readonly expired: number;
          readonly runner_pid: number | null;
        }, [string, string]>(`
          select status, coalesce(finished_at, created_at) < ? as expired, runner_pid
          from workflow_runs
          where run_id = ?
        `).get(cutoffSql, candidate.run_id);
        if (current === null || current.status === "running" || current.expired !== 1) continue;
        if (current.runner_pid !== null && processIsAlive(current.runner_pid)) continue;
        const deleted = this.deleteRunRowsInCurrentTransaction(candidate.run_id);
        rows = addWorkflowRunArtifactCounts(rows, deleted);
        if (deleted.runs > 0) deletedRunIds.push(candidate.run_id);
      }
      const taskCache = this.db.query<{ readonly count: number }, [string]>(`
        select count(*) as count from workflow_task_records where updated_at < ?
      `).get(cutoffSql)?.count ?? 0;
      const judgeCache = this.db.query<{ readonly count: number }, [string]>(`
        select count(*) as count from workflow_judge_records where updated_at < ?
      `).get(cutoffSql)?.count ?? 0;
      this.db.query("delete from workflow_task_records where updated_at < ?").run(cutoffSql);
      this.db.query("delete from workflow_judge_records where updated_at < ?").run(cutoffSql);
      return { rows, taskCache, judgeCache, deletedRunIds };
    })();

    let runnerLogsDeleted = 0;
    let runnerLogsMissing = 0;
    let runnerLogsSkippedUnsafeRunId = 0;
    for (const runId of result.deletedRunIds) {
      const removal = await this.removeQueuedRunnerLog(runId);
      if (removal.status === "deleted") runnerLogsDeleted += 1;
      else if (removal.status === "missing") runnerLogsMissing += 1;
      else runnerLogsSkippedUnsafeRunId += 1;
    }

    return {
      policy: "workflow-ledger-retention-v1",
      olderThanMs,
      cutoff: cutoff.toISOString(),
      runs: {
        matched: candidates.length,
        deleted: result.rows.runs,
        rows: result.rows,
      },
      caches: {
        taskCache: result.taskCache,
        judgeCache: result.judgeCache,
      },
      runnerLogs: {
        deleted: runnerLogsDeleted,
        missing: runnerLogsMissing,
        skippedUnsafeRunId: runnerLogsSkippedUnsafeRunId,
      },
    };
  }

  getCompleted(identity: WorkflowTaskIdentity, options: { readonly allowMockSourced?: boolean } = {}): CompletedWorkflowTaskRecord | null {
    const allowMockSourced = options.allowMockSourced === true;
    const key = workflowTaskResourceKey(identity);
    const row = this.db.query<TaskRecordRow, [string, string, string]>(`
      select workflow, task_id, cache_key, prompt_hash, agent_manifest_hash,
             agent_plugin, agent_name, status, output_json, metadata_json, output_source, created_at, updated_at
      from workflow_task_records
      where scope_key = ?
        and stable_key = ?
        and semantic_hash = ?
        and status = 'completed'
        ${allowMockSourced ? "" : "and (output_source is null or output_source != 'mock-output')"}
    `).get(
      key.scopeKey,
      key.stableKey,
      key.semanticHash,
    );
    if (!row) return null;
    return {
      identity: {
        workflow: row.workflow,
        taskId: row.task_id,
        cacheKey: row.cache_key,
        promptHash: row.prompt_hash,
        agentManifestHash: row.agent_manifest_hash,
      },
      agent: {
        plugin: row.agent_plugin,
        name: row.agent_name,
      },
      output: JSON.parse(row.output_json) as unknown,
      ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {}),
      ...(row.output_source === "mock-output" ? { outputSource: "mock-output" as WorkflowTaskOutputSource } : {}),
    };
  }

  getJudgeRecord(identity: WorkflowJudgeIdentity): WorkflowJudgeRecord | null {
    const row = this.db.query<JudgeRecordRow, [string]>(`
      select workflow, task_id, task_cache_key, criterion, judge_cache_key,
             verdict, feedback, evidence_json, output_json, task_metadata_json,
             metadata_json, created_at, updated_at
      from workflow_judge_records
      where judge_cache_key = ?
    `).get(identity.cacheKey);
    if (!row) return null;
    return {
      identity: {
        workflow: row.workflow,
        taskId: row.task_id,
        taskCacheKey: row.task_cache_key,
        criterion: row.criterion,
        cacheKey: row.judge_cache_key,
      },
      verdict: row.verdict,
      ...(row.feedback !== null ? { feedback: row.feedback } : {}),
      evidence: JSON.parse(row.evidence_json) as unknown,
      output: JSON.parse(row.output_json) as unknown,
      taskMetadata: JSON.parse(row.task_metadata_json) as unknown,
      ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  recordJudge(input: {
    readonly identity: WorkflowJudgeIdentity;
    readonly verdict: WorkflowJudgeVerdict;
    readonly evidence: unknown;
    readonly output: unknown;
    readonly taskMetadata: unknown;
  }): WorkflowCacheWriteResult {
    const policy = applyWorkflowDataPolicy({
      identity: input.identity,
      feedback: "feedback" in input.verdict ? input.verdict.feedback : undefined,
      evidence: input.evidence,
      output: input.output,
      taskMetadata: input.taskMetadata,
      metadata: input.verdict.metadata,
    });
    if (policy.findings.length > 0) {
      return {
        stored: false,
        reason: "sensitive-data",
        findingCount: policy.findings.length,
        findingPaths: policy.findings.map((finding) => finding.path),
      };
    }
    const persisted = policy.value;
    this.db.query(`
      insert into workflow_judge_records (
        workflow, task_id, task_cache_key, criterion, judge_cache_key,
        verdict, feedback, evidence_json, output_json, task_metadata_json,
        metadata_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      on conflict(judge_cache_key)
      do update set
        verdict = excluded.verdict,
        feedback = excluded.feedback,
        evidence_json = excluded.evidence_json,
        output_json = excluded.output_json,
        task_metadata_json = excluded.task_metadata_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      input.identity.workflow,
      input.identity.taskId,
      input.identity.taskCacheKey,
      input.identity.criterion,
      input.identity.cacheKey,
      input.verdict.verdict,
      persisted.feedback ?? null,
      JSON.stringify(persisted.evidence),
      JSON.stringify(persisted.output),
      JSON.stringify(persisted.taskMetadata),
      persisted.metadata === undefined ? null : JSON.stringify(persisted.metadata),
    );
    return { stored: true };
  }

  listJudgeRecords(options: {
    readonly workflow?: string;
    readonly taskId?: string;
    readonly criterion?: string;
  } = {}): WorkflowJudgeRecord[] {
    const rows = this.db.query<JudgeRecordRow, []>(`
      select workflow, task_id, task_cache_key, criterion, judge_cache_key,
             verdict, feedback, evidence_json, output_json, task_metadata_json,
             metadata_json, created_at, updated_at
      from workflow_judge_records
      order by updated_at desc, created_at desc, workflow asc, task_id asc, criterion asc
    `).all();
    return rows
      .filter((row) => options.workflow === undefined || row.workflow === options.workflow)
      .filter((row) => options.taskId === undefined || row.task_id === options.taskId)
      .filter((row) => options.criterion === undefined || row.criterion === options.criterion)
      .map((row) => ({
        identity: {
          workflow: row.workflow,
          taskId: row.task_id,
          taskCacheKey: row.task_cache_key,
          criterion: row.criterion,
          cacheKey: row.judge_cache_key,
        },
        verdict: row.verdict,
        ...(row.feedback !== null ? { feedback: row.feedback } : {}),
        evidence: JSON.parse(row.evidence_json) as unknown,
        output: JSON.parse(row.output_json) as unknown,
        taskMetadata: JSON.parse(row.task_metadata_json) as unknown,
        ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  listCompletedCache(options: {
    readonly workflow?: string;
    readonly taskId?: string;
    readonly cacheKey?: string;
    readonly promptHash?: string;
    readonly agentManifestHash?: string;
  } = {}): WorkflowCacheRecord[] {
    const rows = this.db.query<TaskRecordRow, []>(`
      select workflow, task_id, cache_key, prompt_hash, agent_manifest_hash,
             agent_plugin, agent_name, status, output_json, metadata_json, output_source, created_at, updated_at
      from workflow_task_records
      where status = 'completed'
      order by updated_at desc, created_at desc, workflow asc, task_id asc
    `).all();
    return rows
      .filter((row) => options.workflow === undefined || row.workflow === options.workflow)
      .filter((row) => options.taskId === undefined || row.task_id === options.taskId)
      .filter((row) => options.cacheKey === undefined || row.cache_key === options.cacheKey)
      .filter((row) => options.promptHash === undefined || row.prompt_hash === options.promptHash)
      .filter((row) => options.agentManifestHash === undefined || row.agent_manifest_hash === options.agentManifestHash)
      .map((row) => ({
        identity: {
          workflow: row.workflow,
          taskId: row.task_id,
          cacheKey: row.cache_key,
          promptHash: row.prompt_hash,
          agentManifestHash: row.agent_manifest_hash,
        },
        agent: {
          plugin: row.agent_plugin,
          name: row.agent_name,
        },
        status: row.status,
        output: JSON.parse(row.output_json) as unknown,
        ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {}),
        ...(row.output_source === "mock-output" ? { outputSource: "mock-output" as WorkflowTaskOutputSource } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  createRun(workflow: string, runId: string = randomUUID()): string {
    const persistedWorkflow = redactWorkflowText(workflow);
    this.db.query("insert into workflow_runs (run_id, workflow, status) values (?, ?, 'running')").run(runId, persistedWorkflow);
    this.recordEvent({ runId, type: "run.started", payload: { workflow: persistedWorkflow } });
    return runId;
  }

  recordRunSnapshot(input: {
    readonly runId: string;
    readonly workflowFile: string;
    readonly options?: Record<string, unknown>;
  }): void {
    this.db.query(`
      insert into workflow_run_snapshots (run_id, workflow_file, options_json, updated_at)
      values (?, ?, ?, datetime('now'))
      on conflict(run_id)
      do update set
        workflow_file = excluded.workflow_file,
        options_json = excluded.options_json,
        updated_at = excluded.updated_at
    `).run(
      input.runId,
      redactWorkflowText(input.workflowFile),
      input.options === undefined ? null : redactedJson(input.options),
    );
  }

  getRunSnapshot(runId: string): WorkflowRunSnapshot | null {
    const row = this.db.query<RunSnapshotRow, [string]>(`
      select run_id, workflow_file, options_json, created_at, updated_at
      from workflow_run_snapshots
      where run_id = ?
    `).get(runId);
    if (row == null) return null;
    return {
      runId: row.run_id,
      workflowFile: row.workflow_file,
      ...(row.options_json !== null ? { options: JSON.parse(row.options_json) as Record<string, unknown> } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  recordRunTaskSnapshot(input: Omit<WorkflowRunTaskSnapshot, "createdAt">): void {
    this.db.query(`
      insert into workflow_run_task_snapshots (
        run_id, ordinal, task_id, phase, prompt, cache_key, prompt_hash,
        agent_manifest_hash, agent_plugin, agent_name, agent_description,
        agent_source_hash, worker_json, output_schema_json, finish_criteria_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(run_id, ordinal)
      do update set
        task_id = excluded.task_id,
        phase = excluded.phase,
        prompt = excluded.prompt,
        cache_key = excluded.cache_key,
        prompt_hash = excluded.prompt_hash,
        agent_manifest_hash = excluded.agent_manifest_hash,
        agent_plugin = excluded.agent_plugin,
        agent_name = excluded.agent_name,
        agent_description = excluded.agent_description,
        agent_source_hash = excluded.agent_source_hash,
        worker_json = excluded.worker_json,
        output_schema_json = excluded.output_schema_json,
        finish_criteria_json = excluded.finish_criteria_json
    `).run(
      input.runId,
      input.ordinal,
      input.taskId,
      input.phase ?? null,
      redactWorkflowText(input.prompt),
      input.cacheKey,
      input.promptHash,
      input.agentManifestHash,
      input.agent.plugin,
      input.agent.name,
      redactWorkflowText(input.agent.description),
      input.agent.sourceHash,
      input.worker === undefined ? null : redactedJson(input.worker),
      input.outputSchema === undefined ? null : redactedJson(input.outputSchema),
      redactedJson(input.finishCriteria),
    );
  }

  listRunTaskSnapshots(runId: string): WorkflowRunTaskSnapshot[] {
    const rows = this.db.query<RunTaskSnapshotRow, [string]>(`
      select run_id, ordinal, task_id, phase, prompt, cache_key, prompt_hash,
             agent_manifest_hash, agent_plugin, agent_name, agent_description,
             agent_source_hash, worker_json, output_schema_json,
             finish_criteria_json, created_at
      from workflow_run_task_snapshots
      where run_id = ?
      order by ordinal asc
    `).all(runId);
    return rows.map((row) => ({
      runId: row.run_id,
      ordinal: row.ordinal,
      taskId: row.task_id,
      ...(row.phase !== null ? { phase: row.phase } : {}),
      prompt: row.prompt,
      cacheKey: row.cache_key,
      promptHash: row.prompt_hash,
      agentManifestHash: row.agent_manifest_hash,
      agent: {
        plugin: row.agent_plugin,
        name: row.agent_name,
        description: row.agent_description,
        sourceHash: row.agent_source_hash,
        manifestHash: row.agent_manifest_hash,
      },
      ...(row.worker_json !== null ? { worker: JSON.parse(row.worker_json) as WorkflowRunTaskSnapshot["worker"] } : {}),
      ...(row.output_schema_json !== null ? { outputSchema: JSON.parse(row.output_schema_json) as unknown } : {}),
      finishCriteria: JSON.parse(row.finish_criteria_json) as string[],
      createdAt: row.created_at,
    }));
  }

  setRunHandoffToken(runId: string, token: string): void {
    this.db.query("update workflow_runs set handoff_token = ? where run_id = ?").run(digestWorkflowSecret(token), runId);
  }

  consumeRunHandoffToken(runId: string, token: string): boolean {
    const row = this.db.query<HandoffTokenRow, [string]>(
      "select handoff_token from workflow_runs where run_id = ?"
    ).get(runId);
    if (row?.handoff_token === null || row?.handoff_token === undefined) return false;
    const expected = Buffer.from(row.handoff_token, "utf8");
    const provided = Buffer.from(digestWorkflowSecret(token), "utf8");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return false;
    this.db.query("update workflow_runs set handoff_token = null where run_id = ?").run(runId);
    return true;
  }

  markRunRunnerStarted(runId: string, runnerPid: number): void {
    const started = this.db.transaction(() => {
      const row = this.db.query<{ readonly run_id: string }, [number, string]>(`
        update workflow_runs
        set runner_pid = ?, heartbeat_at = datetime('now')
        where run_id = ? and status = 'running'
        returning run_id
      `).get(runnerPid, runId);
      if (row === null) return false;
      this.recordEvent({ runId, type: "runner.started", payload: { runnerPid } });
      return true;
    })();
    if (!started) {
      throw new Error(`Workflow run ${runId} does not exist or is already terminal`);
    }
  }

  heartbeatRun(runId: string): void {
    this.db.query(`
      update workflow_runs
      set heartbeat_at = datetime('now')
      where run_id = ? and status = 'running'
    `).run(runId);
  }

  recordTaskAttemptStarted(input: WorkflowTaskAttemptStartedInput): void {
    if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
      throw new Error("Workflow task attempt ordinal must be a non-negative integer");
    }
    if (!Number.isInteger(input.attempt) || input.attempt < 1) {
      throw new Error("Workflow task attempt number must be a positive integer");
    }
    if (input.taskId.trim().length === 0) {
      throw new Error("Workflow task attempt taskId must not be empty");
    }
    const metadata = serializeAttemptMetadata(input.metadata);
    this.db.transaction(() => {
      const run = this.db.query<{ readonly status: WorkflowRunStatus }, [string]>(
        "select status from workflow_runs where run_id = ?",
      ).get(input.runId);
      if (run === null) {
        throw new Error(`Workflow run ${input.runId} does not exist`);
      }
      if (run.status !== "running") {
        throw new Error(`Cannot start task attempt for terminal workflow run ${input.runId}`);
      }
      const latest = this.db.query<{
        readonly attempt: number;
        readonly task_id: string;
        readonly status: WorkflowTaskAttemptStatus;
      }, [string, number]>(`
        select attempt, task_id, status
        from workflow_task_attempts
        where run_id = ? and ordinal = ?
        order by attempt desc
        limit 1
      `).get(input.runId, input.ordinal);
      const expectedAttempt = (latest?.attempt ?? 0) + 1;
      if (input.attempt !== expectedAttempt) {
        throw new Error(
          `Workflow task attempt ${input.runId}/${input.ordinal}/${input.attempt} is not monotonic; expected ${expectedAttempt}`,
        );
      }
      if (latest?.status === "running") {
        throw new Error(
          `Workflow task attempt ${input.runId}/${input.ordinal}/${latest.attempt} is still running`,
        );
      }
      if (latest !== null && latest.task_id !== input.taskId) {
        throw new Error(
          `Workflow task attempt ordinal ${input.ordinal} belongs to task ${latest.task_id}, not ${input.taskId}`,
        );
      }
      this.db.query(`
        insert into workflow_task_attempts (
          run_id, ordinal, attempt, task_id, status,
          adapter, model, native_agent, session_id, metadata_json
        ) values (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
      `).run(
        input.runId,
        input.ordinal,
        input.attempt,
        input.taskId,
        metadata.adapter,
        metadata.model,
        metadata.nativeAgent,
        metadata.sessionId,
        metadata.json,
      );
      this.recordEvent({
        runId: input.runId,
        taskId: input.taskId,
        type: "task.attempt.started",
        payload: { ordinal: input.ordinal, attempt: input.attempt },
      });
    })();
  }

  recordTaskAttemptFinished(input: WorkflowTaskAttemptFinishedInput): void {
    const requiresFailure = input.status !== "completed";
    if (requiresFailure !== (input.failure !== undefined)) {
      throw new Error(
        input.status === "completed"
          ? "Completed workflow task attempts must not include a failure"
          : `${input.status} workflow task attempts require a failure`,
      );
    }
    const metadata = serializeAttemptMetadata(input.metadata);
    this.db.transaction(() => {
      const row = this.db.query<TaskAttemptRow, [
        WorkflowTaskAttemptFinishedInput["status"],
        string | null,
        string | null,
        string | null,
        string | null,
        WorkflowTaskAttemptFailureKind | null,
        string | null,
        number,
        string | null,
        string,
        number,
        number,
      ]>(`
        update workflow_task_attempts
        set status = ?,
            finished_at = datetime('now'),
            adapter = coalesce(?, adapter),
            model = coalesce(?, model),
            native_agent = coalesce(?, native_agent),
            session_id = coalesce(?, session_id),
            failure_kind = ?,
            failure_message = ?,
            metadata_json = case when ? = 1 then ? else metadata_json end
        where run_id = ? and ordinal = ? and attempt = ? and status = 'running'
        returning run_id, ordinal, attempt, task_id, status, started_at, finished_at,
                  adapter, model, native_agent, session_id, failure_kind,
                  failure_message, metadata_json, usage_json
      `).get(
        input.status,
        metadata.adapter,
        metadata.model,
        metadata.nativeAgent,
        metadata.sessionId,
        input.failure?.kind ?? null,
        input.failure === undefined ? null : redactWorkflowText(input.failure.message),
        input.metadata === undefined ? 0 : 1,
        metadata.json,
        input.runId,
        input.ordinal,
        input.attempt,
      );
      if (row === null) {
        throw new Error(
          `Workflow task attempt ${input.runId}/${input.ordinal}/${input.attempt} does not exist or is already terminal`,
        );
      }
      const finishedMetadata = row.metadata_json === null
        ? undefined
        : JSON.parse(row.metadata_json) as Record<string, unknown>;
      const usage = workflowUsageFromMetadata(finishedMetadata);
      this.db.query(`
        update workflow_task_attempts
        set usage_json = ?
        where run_id = ? and ordinal = ? and attempt = ?
      `).run(
        stableJsonStringify(usage as unknown as StableJsonValue),
        input.runId,
        input.ordinal,
        input.attempt,
      );
      this.updateRunUsageInCurrentTransaction(input.runId, (current) => addWorkflowUsage(current, usage));
      this.recordEvent({
        runId: input.runId,
        taskId: row.task_id,
        type: `task.attempt.${input.status}`,
        payload: {
          ordinal: input.ordinal,
          attempt: input.attempt,
          ...(input.failure !== undefined ? { failure: input.failure } : {}),
        },
      });
    })();
  }

  listRunTaskAttempts(runId: string): WorkflowTaskAttemptRecord[] {
    this.failDeadPidRuns();
    const rows = this.db.query<TaskAttemptRow, [string]>(`
      select run_id, ordinal, attempt, task_id, status, started_at, finished_at,
             adapter, model, native_agent, session_id, failure_kind,
             failure_message, metadata_json, usage_json
      from workflow_task_attempts
      where run_id = ?
      order by ordinal asc, attempt asc
    `).all(runId);
    return rows.map((row) => ({
      runId: row.run_id,
      ordinal: row.ordinal,
      attempt: row.attempt,
      taskId: row.task_id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      ...(row.adapter !== null ? { adapter: row.adapter } : {}),
      ...(row.model !== null ? { model: row.model } : {}),
      ...(row.native_agent !== null ? { nativeAgent: row.native_agent } : {}),
      ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
      ...(row.failure_kind !== null && row.failure_message !== null
        ? { failure: { kind: row.failure_kind, message: row.failure_message } }
        : {}),
      ...(row.usage_json !== null
        ? { usage: JSON.parse(row.usage_json) as WorkflowUsage }
        : {}),
      ...(row.metadata_json !== null
        ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }
        : {}),
    }));
  }

  private finishRunInCurrentTransaction(
    runId: string,
    status: Exclude<WorkflowRunStatus, "running" | "unknown">,
    terminalCause: WorkflowRunTerminalCause,
  ): RunRow | null {
    const terminalCauseJson = redactedStableJson(terminalCause);
    const updated = this.db.query<RunRow, [WorkflowRunStatus, string, string]>(`
      update workflow_runs
      set status = ?, terminal_cause_json = ?, finished_at = datetime('now')
      where run_id = ? and status = 'running'
      returning run_id, workflow, status, terminal_cause_json, finished_at,
                runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
                usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms
    `).get(status, terminalCauseJson, runId);
    if (updated === null) return null;

    const attemptTerminal = taskAttemptTerminalFromRun(status, terminalCause);
    const reconciled = this.db.query<TaskAttemptRow, [
      Exclude<WorkflowTaskAttemptStatus, "running">,
      WorkflowTaskAttemptFailureKind | null,
      string | null,
      string,
    ]>(`
      update workflow_task_attempts
      set status = ?,
          finished_at = datetime('now'),
          failure_kind = ?,
          failure_message = ?
      where run_id = ? and status = 'running'
      returning run_id, ordinal, attempt, task_id, status, started_at, finished_at,
                adapter, model, native_agent, session_id, failure_kind,
                failure_message, metadata_json, usage_json
    `).all(
      attemptTerminal.status,
      attemptTerminal.failure?.kind ?? null,
      attemptTerminal.failure === null ? null : redactWorkflowText(attemptTerminal.failure.message),
      runId,
    );
    for (const attempt of reconciled) {
      const metadata = attempt.metadata_json === null
        ? undefined
        : JSON.parse(attempt.metadata_json) as Record<string, unknown>;
      const usage = workflowUsageFromMetadata(metadata);
      this.db.query(`
        update workflow_task_attempts
        set usage_json = ?
        where run_id = ? and ordinal = ? and attempt = ?
      `).run(
        stableJsonStringify(usage as unknown as StableJsonValue),
        runId,
        attempt.ordinal,
        attempt.attempt,
      );
      this.updateRunUsageInCurrentTransaction(runId, (current) => addWorkflowUsage(current, usage));
      this.recordEvent({
        runId,
        taskId: attempt.task_id,
        type: `task.attempt.${attemptTerminal.status}`,
        payload: {
          ordinal: attempt.ordinal,
          attempt: attempt.attempt,
          reconciled: true,
          ...(attemptTerminal.failure !== null ? { failure: attemptTerminal.failure } : {}),
        },
      });
    }
    this.recordEvent({ runId, type: `run.${status}`, payload: terminalCause });
    return this.db.query<RunRow, [string]>(`
      select run_id, workflow, status, terminal_cause_json, finished_at,
             runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
             usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms
      from workflow_runs
      where run_id = ?
    `).get(runId);
  }

  finishRun(
    runId: string,
    status: Exclude<WorkflowRunStatus, "running" | "unknown">,
    terminalCause?: WorkflowRunTerminalCause,
  ): void {
    const cause = terminalCauseForStatus(status, terminalCause);
    const updated = this.db.transaction(() =>
      this.finishRunInCurrentTransaction(runId, status, cause)
    )();
    if (updated === null) {
      throw new Error(`Workflow run ${runId} does not exist or is already terminal`);
    }
  }

  stopRun(runId: string, reason: string = "stop-requested"): WorkflowRunRecord | null {
    this.failDeadPidRuns();
    const stop = this.db.transaction(() => {
      const current = this.db.query<RunRow, [string]>(`
        select run_id, workflow, status, terminal_cause_json, finished_at,
               runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
               usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms
        from workflow_runs
        where run_id = ?
      `).get(runId);
      if (current === null || current.status !== "running") return current;
      const cause: WorkflowRunStoppedCause = { kind: "stopped", reason };
      this.recordEvent({ runId, type: "run.stop_requested", payload: cause });
      return this.finishRunInCurrentTransaction(runId, "stopped", cause);
    });
    const row = stop();
    return row === null ? null : runRecordFromRow(row);
  }

  stopRunningRun(runId: string, reason: string = "stop-requested"): WorkflowRunRecord | null {
    this.failDeadPidRuns();
    const stop = this.db.transaction(() => {
      const current = this.db.query<RunRow, [string]>(`
        select run_id, workflow, status, terminal_cause_json, finished_at,
               runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
               usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms
        from workflow_runs
        where run_id = ?
      `).get(runId);
      if (current === null || current.status !== "running") return null;
      const cause: WorkflowRunStoppedCause = { kind: "stopped", reason };
      this.recordEvent({ runId, type: "run.stop_requested", payload: cause });
      return this.finishRunInCurrentTransaction(runId, "stopped", cause);
    });
    const row = stop();
    return row === null ? null : runRecordFromRow(row);
  }

  restartRunningRun(input: {
    readonly previousRunId: string;
    readonly nextRunId: string;
    readonly nextWorkflow: string;
    readonly handoffToken: string;
    readonly reason?: string;
    readonly mode?: string;
  }): WorkflowRunRecord | null {
    this.failDeadPidRuns();
    const restart = this.db.transaction(() => {
      const current = this.db.query<RunRow, [string]>(`
        select run_id, workflow, status, terminal_cause_json, finished_at,
               runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
               usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms
        from workflow_runs
        where run_id = ?
      `).get(input.previousRunId);
      if (current === null || current.status !== "running") return null;
      const cause: WorkflowRunStoppedCause = {
        kind: "stopped",
        reason: input.reason ?? "update-requested",
      };
      this.recordEvent({ runId: input.previousRunId, type: "run.stop_requested", payload: cause });
      const row = this.finishRunInCurrentTransaction(input.previousRunId, "stopped", cause);
      if (row === null) return null;
      this.createRun(input.nextWorkflow, input.nextRunId);
      this.recordEvent({
        runId: input.nextRunId,
        type: "run.updated_from",
        payload: { previousRunId: input.previousRunId, mode: input.mode ?? "restart-with-cache" },
      });
      this.setRunHandoffToken(input.nextRunId, input.handoffToken);
      return row;
    });
    const row = restart();
    return row === null ? null : runRecordFromRow(row);
  }

  getRun(runId: string): WorkflowRunRecord | null {
    this.failDeadPidRuns();
    const row = this.db.query<RunRow, [string]>(`
      select run_id, workflow, status, terminal_cause_json, finished_at,
             runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
             usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms
      from workflow_runs
      where run_id = ?
    `).get(runId);
    return row === null ? null : runRecordFromRow(row);
  }

  recordEvent(input: {
    readonly runId: string;
    readonly taskId?: string;
    readonly type: string;
    readonly payload: unknown;
  }): void {
    this.db.query(`
      insert into workflow_events (run_id, sequence, task_id, type, payload_json)
      values (
        ?,
        coalesce((select max(sequence) + 1 from workflow_events where run_id = ?), 0),
        ?,
        ?,
        ?
      )
    `).run(
      input.runId,
      input.runId,
      input.taskId ?? null,
      input.type,
      redactedJson(input.payload),
    );
  }

  recordSpanStart(span: WorkflowSpanRecord): void {
    this.db.query(`
      insert into workflow_spans (run_id, trace_id, span_id, parent_span_id, task_id, name, kind, start_ns, end_ns, duration_ms, status, error_message, attributes_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, null, ?)
      on conflict (span_id) do nothing
    `).run(
      span.runId,
      span.traceId,
      span.spanId,
      span.parentSpanId,
      span.taskId,
      span.name,
      span.kind,
      span.startNs.toString(),
      span.status,
      redactedJson(span.attributes),
    );
  }

  recordSpanEnd(input: {
    readonly spanId: string;
    readonly endNs: bigint;
    readonly status: "ok" | "error";
    readonly errorMessage: string | null;
    readonly attributes: Record<string, unknown>;
  }): void {
    this.db.query(`
      update workflow_spans
      set end_ns = ?,
          duration_ms = (cast(? as real) - cast(start_ns as real)) / 1000000.0,
          status = ?,
          error_message = ?,
          attributes_json = ?
      where span_id = ?
    `).run(
      input.endNs.toString(),
      input.endNs.toString(),
      input.status,
      input.errorMessage === null ? null : redactWorkflowText(input.errorMessage),
      redactedJson(input.attributes),
      input.spanId,
    );
  }

  listSpans(runId: string): WorkflowSpanRecord[] {
    const rows = this.db.query<SpanRow, [string]>(`
      select run_id, trace_id, span_id, parent_span_id, task_id, name, kind, start_ns, end_ns, status, error_message, attributes_json
      from workflow_spans
      where run_id = ?
      order by cast(start_ns as real) asc, span_id asc
    `).all(runId);
    return rows.map((row) => ({
      runId: row.run_id,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      taskId: row.task_id,
      name: row.name,
      kind: row.kind,
      startNs: BigInt(row.start_ns),
      endNs: row.end_ns === null ? null : BigInt(row.end_ns),
      status: row.status as WorkflowSpanRecord["status"],
      errorMessage: row.error_message,
      attributes: JSON.parse(row.attributes_json) as Record<string, unknown>,
    }));
  }

  listRunEvents(runId: string): WorkflowEventRecord[] {
    this.failDeadPidRuns();
    const rows = this.db.query<EventRow, [string]>(`
      select sequence, run_id, task_id, type, payload_json, created_at
      from workflow_events
      where run_id = ?
      order by sequence asc
    `).all(runId);
    return rows.map((row) => ({
      sequence: row.sequence,
      runId: row.run_id,
      taskId: row.task_id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
  }

  failDeadPidRuns(): WorkflowRunRecord[] {
    const candidates = this.db.query<StaleRunRow, []>(`
      select run_id, workflow, status, terminal_cause_json, finished_at,
             runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
             usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms,
             created_at
      from workflow_runs
      where status = 'running'
        and runner_pid is not null
    `).all();
    const dead = candidates.filter((row) => row.runner_pid !== null && !processIsAlive(row.runner_pid));
    if (dead.length === 0) return [];
    return this.db.transaction(() => {
      const crashed: WorkflowRunRecord[] = [];
      for (const row of dead) {
        const current = this.db.query<StaleRunRow, [string, number]>(`
          select run_id, workflow, status, terminal_cause_json, finished_at,
                 runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
                 usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms,
                 created_at
          from workflow_runs
          where run_id = ? and status = 'running' and runner_pid = ?
        `).get(row.run_id, row.runner_pid!);
        if (current === null || current.runner_pid === null || processIsAlive(current.runner_pid)) continue;
        const cause: WorkflowRunCrashedCause = {
          kind: "crashed",
          reason: "dead-runner-pid",
          runnerPid: current.runner_pid,
          ...(current.heartbeat_at !== null ? { heartbeatAt: current.heartbeat_at } : {}),
        };
        this.recordEvent({
          runId: current.run_id,
          type: "run.stale_dead_pid",
          payload: {
            ...cause,
            createdAt: current.created_at,
          },
        });
        const updated = this.finishRunInCurrentTransaction(current.run_id, "crashed", cause);
        if (updated !== null) crashed.push(runRecordFromRow(updated));
      }
      return crashed;
    })();
  }

  failStaleRuns(olderThanMs: number, now: Date = new Date()): WorkflowRunRecord[] {
    if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
      throw new Error("olderThanMs must be a positive number");
    }
    const staleBefore = sqliteDateTime(new Date(now.getTime() - olderThanMs));
    return this.db.transaction(() => {
      const candidates = this.db.query<StaleRunRow, [string]>(`
        select run_id, workflow, status, terminal_cause_json, finished_at,
               runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
               usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms,
               created_at
        from workflow_runs
        where status = 'running'
          and datetime(coalesce(heartbeat_at, created_at)) < datetime(?)
        order by created_at asc, run_id asc
      `).all(staleBefore);
      const crashed: WorkflowRunRecord[] = [];
      for (const row of candidates) {
        const cause: WorkflowRunCrashedCause = {
          kind: "crashed",
          reason: "stale-running-run",
          ...(row.runner_pid !== null ? { runnerPid: row.runner_pid } : {}),
          ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
        };
        this.recordEvent({
          runId: row.run_id,
          type: "run.stale_reconciled",
          payload: {
            ...cause,
            staleAfterMs: olderThanMs,
            staleBefore,
            createdAt: row.created_at,
          },
        });
        const updated = this.finishRunInCurrentTransaction(row.run_id, "crashed", cause);
        if (updated !== null) crashed.push(runRecordFromRow(updated));
      }
      return crashed;
    })();
  }

  listRuns(): WorkflowRunRecord[] {
    this.failDeadPidRuns();
    const rows = this.db.query<RunRow & { readonly created_at: string }, []>(`
      select run_id, workflow, status, terminal_cause_json, finished_at,
             runner_pid, heartbeat_at, usage_agent_runs, usage_reused,
             usage_tokens_in, usage_tokens_out, usage_cost_usd, usage_duration_ms,
             created_at
      from workflow_runs
      order by created_at asc, run_id asc
    `).all();
    return rows.map(runRecordFromRow);
  }

  recordRunTask(input: {
    readonly runId: string;
    readonly ordinal: number;
    readonly identity: WorkflowTaskIdentity;
    readonly agent: { readonly plugin: string; readonly name: string };
    readonly status: WorkflowRunTaskStatus;
    readonly cached: boolean;
    readonly output: unknown;
    readonly metadata?: Record<string, unknown>;
    readonly finishRunStatus?: Exclude<WorkflowRunStatus, "running" | "unknown">;
  }): void {
    const insert = () => {
      const run = this.db.query<{ readonly status: WorkflowRunStatus }, [string]>(`
        select status from workflow_runs where run_id = ?
      `).get(input.runId);
      if (run?.status !== "running") {
        throw new Error(`Workflow run ${input.runId} does not exist or is already terminal`);
      }
      this.db.query(`
        insert into workflow_run_tasks (
          run_id, ordinal, workflow, task_id, cache_key, prompt_hash, agent_manifest_hash,
          agent_plugin, agent_name, status, cached, output_json, metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.runId,
        input.ordinal,
        input.identity.workflow,
        input.identity.taskId,
        input.identity.cacheKey,
        input.identity.promptHash,
        input.identity.agentManifestHash,
        input.agent.plugin,
        input.agent.name,
        input.status,
        input.cached ? 1 : 0,
        redactedJson(input.output),
        input.metadata === undefined ? null : redactedJson(input.metadata),
      );
      if (input.cached) {
        this.updateRunUsageInCurrentTransaction(input.runId, addWorkflowReuse);
      }
      this.recordEvent({
        runId: input.runId,
        taskId: input.identity.taskId,
        type: `task.${input.status}`,
        payload: {
          cached: input.cached,
          cacheKey: input.identity.cacheKey,
          ...pickContractMetadata(input.metadata),
        },
      });
      if (input.finishRunStatus !== undefined) {
        const cause = terminalCauseForStatus(input.finishRunStatus, undefined);
        const updated = this.finishRunInCurrentTransaction(input.runId, input.finishRunStatus, cause);
        if (updated === null) {
          throw new Error(`Workflow run ${input.runId} does not exist or is already terminal`);
        }
      }
    };
    this.db.transaction(insert)();
  }

  listRunTasks(runId: string): WorkflowRunTaskRecord[] {
    this.failDeadPidRuns();
    const rows = this.db.query<RunTaskRow, [string]>(`
      select run_id, ordinal, task_id, cache_key, status, cached, agent_plugin, agent_name, output_json, metadata_json
      from workflow_run_tasks
      where run_id = ?
      order by ordinal asc
    `).all(runId);
    return rows.map((row) => ({
      runId: row.run_id,
      ordinal: row.ordinal,
      taskId: row.task_id,
      cacheKey: row.cache_key,
      status: row.status,
      cached: row.cached === 1,
      agent: {
        plugin: row.agent_plugin,
        name: row.agent_name,
      },
      output: JSON.parse(row.output_json) as unknown,
      ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {}),
    }));
  }

  summarizeRunTasks(runId: string): WorkflowRunTaskProgress[] {
    const summaries = new Map<string, WorkflowRunTaskProgress>();
    const taskRows = this.listRunTasks(runId);
    const rowKeysByTaskId = new Map<string, string[]>();
    for (const task of taskRows) {
      rowKeysByTaskId.set(task.taskId, [...(rowKeysByTaskId.get(task.taskId) ?? []), taskRecordKey(task)]);
    }
    const upsert = (key: string, taskId: string, patch: WorkflowRunTaskProgressPatch): void => {
      const existing = summaries.get(key);
      summaries.set(key, {
        taskId,
        status: existing?.status ?? "running",
        repairs: existing?.repairs ?? 0,
        ...existing,
        ...patch,
      });
    };

    for (const task of taskRows) {
      upsert(taskRecordKey(task), task.taskId, {
        ordinal: task.ordinal,
        status: task.status,
        cacheKey: task.cacheKey,
        cached: task.cached,
        agent: task.agent,
      });
    }

    for (const event of this.listRunEvents(runId)) {
      if (event.taskId === null) continue;
      if (event.type.startsWith("task.attempt.")) continue;
      const taskId = event.taskId;
      const payload = objectPayload(event.payload);
      const key = eventTaskKey(taskId, rowKeysByTaskId);
      const existing = summaries.get(key);
      const patch: WorkflowRunTaskProgressPatch = {
        lastEventType: event.type,
        lastEventAt: event.createdAt,
      };
      if (event.type === "task.started") {
        patch.status = existing?.status ?? "running";
      }
      if (event.type === "task.cache_lookup.hit") patch.cacheLookup = "hit";
      if (event.type === "task.cache_lookup.miss") patch.cacheLookup = "miss";
      if (event.type === "task.cache_lookup.skipped") patch.cacheLookup = "skipped";
      if (event.type === "task.cache_lookup.started" || event.type === "task.started") {
        if (payload !== null && typeof payload.cacheKey === "string") {
          patch.cacheKey = payload.cacheKey;
        }
      }
      if (event.type === "task.repair.started") {
        patch.repairs = (existing?.repairs ?? 0) + 1;
      }
      if (event.type === "task.completed") {
        patch.status = "completed";
        if (payload !== null && typeof payload.cached === "boolean") patch.cached = payload.cached;
        if (payload !== null && typeof payload.cacheKey === "string") patch.cacheKey = payload.cacheKey;
      }
      if (event.type === "task.failed" || event.type === "task.escalated") {
        patch.status = event.type === "task.escalated" ? "escalated" : "failed";
        if (payload !== null && typeof payload.cached === "boolean") patch.cached = payload.cached;
        if (payload !== null && typeof payload.cacheKey === "string") patch.cacheKey = payload.cacheKey;
      }
      upsert(key, taskId, patch);
    }

    const attemptsByTask = new Map<string, WorkflowTaskAttemptRecord[]>();
    for (const attempt of this.listRunTaskAttempts(runId)) {
      const key = taskRecordKey(attempt);
      const attempts = [...(attemptsByTask.get(key) ?? []), attempt];
      attemptsByTask.set(key, attempts);
      const existing = summaries.get(key);
      upsert(key, attempt.taskId, {
        ordinal: attempt.ordinal,
        status: existing !== undefined && existing.status !== "running"
          ? existing.status
          : attempt.status,
        cached: false,
        repairs: Math.max(0, attempts.length - 1),
      });
    }

    return Array.from(summaries.values());
  }

  compactRunSummary(runId: string): WorkflowRunCompactSummary | null {
    const run = this.getRun(runId);
    if (run === null) return null;

    const summaries = new Map<string, WorkflowRunTaskCompactAccumulator>();
    const taskRows = this.listRunTasks(runId);
    const rowKeysByTaskId = new Map<string, string[]>();
    for (const task of taskRows) {
      rowKeysByTaskId.set(task.taskId, [...(rowKeysByTaskId.get(task.taskId) ?? []), taskRecordKey(task)]);
    }
    const upsert = (key: string, taskId: string, patch: WorkflowRunTaskCompactPatch): void => {
      const existing = summaries.get(key);
      const metadata = patch.metadata !== undefined
        && (existing?.metadata === undefined || existing.evidenceSource === "run-events" || existing.evidenceSource === "unknown")
        ? patch.metadata
        : existing?.metadata ?? patch.metadata;
      const startedAt = patch.startedAt ?? existing?.startedAt;
      const lastEventAt = patch.lastEventAt ?? existing?.lastEventAt;
      const firstEventSequence = patch.firstEventSequence !== undefined && existing?.firstEventSequence !== undefined
        ? Math.min(patch.firstEventSequence, existing.firstEventSequence)
        : patch.firstEventSequence ?? existing?.firstEventSequence;
      const durationMs = patch.durationMs
        ?? numberMetadata(metadata, "durationMs")
        ?? elapsedMs(startedAt, lastEventAt)
        ?? existing?.durationMs
        ?? null;
      const next: WorkflowRunTaskCompactAccumulator = {
        taskId,
        ...(patch.ordinal !== undefined || existing?.ordinal !== undefined ? { ordinal: patch.ordinal ?? existing?.ordinal } : {}),
        status: patch.status ?? existing?.status ?? "running",
        execution: patch.execution ?? existing?.execution ?? "unknown",
        evidenceSource: patch.evidenceSource ?? existing?.evidenceSource ?? "unknown",
        cached: patch.cached ?? existing?.cached ?? null,
        attempts: patch.attempts ?? existing?.attempts ?? [],
        repairCount: patch.repairCount ?? repairCountMetadata(metadata) ?? existing?.repairCount ?? 0,
        workerAdapter: stringMetadata(metadata, "adapter") ?? patch.workerAdapter ?? existing?.workerAdapter ?? null,
        model: stringMetadata(metadata, "model") ?? patch.model ?? existing?.model ?? null,
        nativeAgent: stringMetadata(metadata, "nativeAgent") ?? patch.nativeAgent ?? existing?.nativeAgent ?? null,
        repairMode: repairModeMetadata(metadata) ?? patch.repairMode ?? existing?.repairMode ?? null,
        externalSessionPointer: externalSessionPointer(metadata) ?? patch.externalSessionPointer ?? existing?.externalSessionPointer ?? null,
        durationMs,
        ...(patch.cacheLookup !== undefined || existing?.cacheLookup !== undefined ? { cacheLookup: patch.cacheLookup ?? existing?.cacheLookup } : {}),
        ...(patch.agent !== undefined || existing?.agent !== undefined ? { agent: patch.agent ?? existing?.agent } : {}),
        ...(patch.lastEventType !== undefined || existing?.lastEventType !== undefined ? { lastEventType: patch.lastEventType ?? existing?.lastEventType } : {}),
        ...(lastEventAt !== undefined ? { lastEventAt } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(firstEventSequence !== undefined ? { firstEventSequence } : {}),
        ...(patch.orderIndex !== undefined || existing?.orderIndex !== undefined ? { orderIndex: patch.orderIndex ?? existing?.orderIndex } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      };
      summaries.set(key, next);
    };

    for (const [index, task] of taskRows.entries()) {
      upsert(taskRecordKey(task), task.taskId, {
        ordinal: task.ordinal,
        status: task.status,
        execution: task.cached ? "cached" : "fresh",
        evidenceSource: task.cached ? "prior-cache-record" : "this-run",
        cached: task.cached,
        agent: task.agent,
        metadata: task.metadata,
        repairCount: repairCountMetadata(task.metadata) ?? 0,
        durationMs: numberMetadata(task.metadata, "durationMs"),
        orderIndex: index,
      });
    }

    const events = this.listRunEvents(runId);
    let runStartedAt: string | undefined;
    let runFinishedAt: string | undefined;
    for (const event of events) {
      if (event.type.startsWith("task.attempt.")) continue;
      if (event.taskId === null) {
        if (event.type === "run.started") runStartedAt = event.createdAt;
        if (
          event.type === "run.completed"
          || event.type === "run.failed"
          || event.type === "run.escalated"
          || event.type === "run.stopped"
          || event.type === "run.crashed"
        ) {
          runFinishedAt = event.createdAt;
        }
        continue;
      }
      const taskId = event.taskId;
      const payload = objectPayload(event.payload);
      const key = eventTaskKey(taskId, rowKeysByTaskId);
      const existing = summaries.get(key);
      const patch: WorkflowRunTaskCompactPatch = {
        evidenceSource: existing?.evidenceSource ?? "run-events",
        firstEventSequence: event.sequence,
        lastEventType: event.type,
        lastEventAt: event.createdAt,
      };
      if (event.type === "task.started") {
        patch.status = existing?.status ?? "running";
        patch.startedAt = existing?.startedAt ?? event.createdAt;
        patch.execution = existing?.execution ?? "fresh";
        patch.cached = existing?.cached ?? false;
      }
      if (event.type === "task.cache_lookup.hit") {
        patch.cacheLookup = "hit";
        patch.execution = "cached";
        patch.cached = true;
      }
      if (event.type === "task.cache_lookup.miss") {
        patch.cacheLookup = "miss";
        patch.execution = existing?.execution === "cached" ? "cached" : "fresh";
        patch.cached = existing?.cached ?? false;
      }
      if (event.type === "task.cache_lookup.skipped") {
        patch.cacheLookup = "skipped";
        patch.execution = existing?.execution === "cached" ? "cached" : "fresh";
        patch.cached = existing?.cached ?? false;
      }
      if (event.type === "task.executor.started") {
        patch.execution = existing?.execution === "cached" ? "cached" : "fresh";
        patch.cached = existing?.cached ?? false;
      }
      if (event.type === "task.executor.completed" && payload !== null) {
        patch.metadata = payload;
        patch.execution = existing?.execution === "cached" ? "cached" : "fresh";
        patch.cached = existing?.cached ?? false;
      }
      if (event.type === "task.repair.started") {
        patch.repairCount = repairCountMetadata(existing?.metadata) ?? (existing?.repairCount ?? 0) + 1;
        const repairMode = eventRepairMode(payload);
        if (repairMode !== null) patch.repairMode = repairMode;
      }
      if (event.type === "task.finish.completed" || event.type === "task.finish.failed") {
        const repairCount = eventRepairCount(payload);
        if (repairCount !== null) patch.repairCount = repairCount;
        const repairMode = eventRepairMode(payload);
        if (repairMode !== null) patch.repairMode = repairMode;
      }
      if (event.type === "task.completed") {
        patch.status = "completed";
        if (payload !== null && typeof payload.cached === "boolean") {
          patch.cached = payload.cached;
          patch.execution = payload.cached ? "cached" : "fresh";
        }
      }
      if (event.type === "task.failed" || event.type === "task.escalated") {
        patch.status = event.type === "task.escalated" ? "escalated" : "failed";
        if (payload !== null && typeof payload.cached === "boolean") {
          patch.cached = payload.cached;
          patch.execution = payload.cached ? "cached" : "fresh";
        }
      }
      upsert(key, taskId, patch);
    }

    const attemptsByTask = new Map<string, WorkflowTaskAttemptRecord[]>();
    for (const attempt of this.listRunTaskAttempts(runId)) {
      const key = taskRecordKey(attempt);
      attemptsByTask.set(key, [...(attemptsByTask.get(key) ?? []), attempt]);
    }
    for (const [key, attempts] of attemptsByTask) {
      const latest = attempts.at(-1)!;
      const latestFinished = attempts.findLast((attempt) => attempt.status !== "running");
      const existing = summaries.get(key);
      const durationMs = numberMetadata(latestFinished?.metadata, "durationMs")
        ?? attempts.reduce<number | null>((total, attempt) => {
          const duration = elapsedMs(attempt.startedAt, attempt.finishedAt ?? undefined);
          return duration === null ? total : (total ?? 0) + duration;
        }, null);
      upsert(key, latest.taskId, {
        ordinal: latest.ordinal,
        status: existing !== undefined && existing.status !== "running"
          ? existing.status
          : latest.status,
        execution: "fresh",
        evidenceSource: "this-run",
        cached: false,
        attempts,
        repairCount: Math.max(0, attempts.length - 1),
        workerAdapter: latest.adapter ?? null,
        model: latest.model ?? null,
        nativeAgent: latest.nativeAgent ?? null,
        externalSessionPointer: latest.sessionId ?? null,
        metadata: latest.metadata,
        repairMode: repairModeMetadata(latest.metadata),
        durationMs,
      });
    }

    const tasks = Array.from(summaries.values()).sort((left, right) => {
      const leftOrder = left.firstEventSequence ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.firstEventSequence ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return (left.orderIndex ?? Number.MAX_SAFE_INTEGER) - (right.orderIndex ?? Number.MAX_SAFE_INTEGER);
    }).map((summary): WorkflowRunTaskCompactSummary => {
      const {
        metadata: _metadata,
        startedAt: _startedAt,
        firstEventSequence: _firstEventSequence,
        orderIndex: _orderIndex,
        ...taskSummary
      } = summary;
      return taskSummary;
    });
    const durationMs = elapsedMs(runStartedAt, runFinishedAt ?? events.at(-1)?.createdAt);
    return {
      kind: "workflow-execution-evidence",
      semanticCorrectness: "not-evaluated",
      disclaimer: "This summary is execution evidence only; it does not prove workflow side effects were semantically correct.",
      run,
      totals: {
        totalTasks: tasks.length,
        freshExecutions: tasks.filter((task) => task.execution === "fresh").length,
        cacheHits: tasks.filter((task) => task.execution === "cached").length,
        repairs: tasks.reduce((total, task) => total + task.repairCount, 0),
        status: run.status,
        durationMs,
        usage: run.usage,
      },
      tasks,
    };
  }

  workflowMonitorState(selectedRunId?: string): WorkflowMonitorState {
    const runs = this.listRuns()
      .map((run): WorkflowMonitorRun => {
        const summary = this.compactRunSummary(run.runId);
        const totals = summary?.totals ?? {
          totalTasks: 0,
          freshExecutions: 0,
          cacheHits: 0,
          repairs: 0,
          status: run.status,
          durationMs: null,
          usage: run.usage,
        };
        const snapshot = this.getRunSnapshot(run.runId);
        return {
          run,
          ...(snapshot !== null ? { snapshot } : {}),
          totals,
          cacheBadges: summary === null ? [] : runBadges(summary),
        };
      })
      .reverse();

    const selectedId = selectedRunId ?? runs[0]?.run.runId;
    const selectedRun = selectedId === undefined ? null : this.workflowMonitorRunDetail(selectedId);
    return { runs, selectedRun };
  }

  workflowMonitorRunDetail(runId: string): WorkflowMonitorRunDetail | null {
    const summary = this.compactRunSummary(runId);
    if (summary === null) return null;
    const events = this.listRunEvents(runId);
    const taskRows = this.listRunTasks(runId);
    const snapshots = this.listRunTaskSnapshots(runId);
    const taskByOrdinal = new Map(taskRows.map((task) => [task.ordinal, task]));
    const snapshotByOrdinal = new Map(snapshots.map((snapshot) => [snapshot.ordinal, snapshot]));
    const eventsByTask = new Map<string, WorkflowEventRecord[]>();
    for (const event of events) {
      if (event.taskId === null) continue;
      eventsByTask.set(event.taskId, [...(eventsByTask.get(event.taskId) ?? []), event]);
    }
    const tasks = summary.tasks.map((task): WorkflowMonitorTask => {
      const snapshot = task.ordinal !== undefined ? snapshotByOrdinal.get(task.ordinal) : undefined;
      const row = task.ordinal !== undefined ? taskByOrdinal.get(task.ordinal) : undefined;
      const taskEvents = eventsByTask.get(task.taskId) ?? [];
      const ordinal = snapshot?.ordinal ?? row?.ordinal ?? task.ordinal;
      return {
        ...task,
        ...(ordinal !== undefined ? { ordinal } : {}),
        ...(snapshot?.phase !== undefined ? { phase: snapshot.phase } : {}),
        ...(snapshot?.cacheKey !== undefined ? { cacheKey: snapshot.cacheKey } : {}),
        ...(snapshot?.prompt !== undefined ? { prompt: snapshot.prompt } : {}),
        ...(row !== undefined ? { output: row.output } : {}),
        ...(row?.metadata !== undefined ? { metadata: row.metadata } : {}),
        badges: taskBadges(task, taskEvents),
        ...(snapshot !== undefined ? { snapshot } : {}),
      };
    }).sort((left, right) => {
      const leftOrder = left.ordinal ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.ordinal ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.taskId.localeCompare(right.taskId);
    });
    const snapshot = this.getRunSnapshot(runId);
    return {
      run: summary.run,
      ...(snapshot !== null ? { snapshot } : {}),
      totals: summary.totals,
      cacheBadges: runBadges(summary),
      tasks,
      events,
      canUpdate: summary.run.status === "running" && snapshot !== null,
    };
  }

  recordCompleted(input: {
    readonly identity: WorkflowTaskIdentity;
    readonly agent: { readonly plugin: string; readonly name: string };
    readonly output: unknown;
    readonly metadata?: Record<string, unknown>;
    readonly outputSource?: WorkflowTaskOutputSource;
  }): WorkflowCacheWriteResult {
    const metadata = normalizeWorkflowSessionMetadata(input.metadata);
    const policy = applyWorkflowDataPolicy({
      identity: input.identity,
      agent: input.agent,
      output: input.output,
      ...(metadata !== undefined ? { metadata } : {}),
    });
    if (policy.findings.length > 0) {
      return {
        stored: false,
        reason: "sensitive-data",
        findingCount: policy.findings.length,
        findingPaths: policy.findings.map((finding) => finding.path),
      };
    }
    const persisted = policy.value;
    const key = workflowTaskResourceKey(input.identity);
    this.db.query(`
      insert into workflow_task_records (
        scope_key, stable_key, semantic_hash, workflow, task_id, cache_key, prompt_hash, agent_manifest_hash,
        agent_plugin, agent_name, status, output_json, metadata_json, output_source, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, datetime('now'))
      on conflict(scope_key, stable_key, semantic_hash)
      do update set
        agent_plugin = excluded.agent_plugin,
        agent_name = excluded.agent_name,
        status = excluded.status,
        output_json = excluded.output_json,
        metadata_json = excluded.metadata_json,
        output_source = excluded.output_source,
        updated_at = excluded.updated_at
      where workflow_task_records.output_source = 'mock-output'
        and excluded.output_source is null
    `).run(
      key.scopeKey,
      key.stableKey,
      key.semanticHash,
      input.identity.workflow,
      input.identity.taskId,
      input.identity.cacheKey,
      input.identity.promptHash,
      input.identity.agentManifestHash,
      input.agent.plugin,
      input.agent.name,
      JSON.stringify(persisted.output),
      persisted.metadata === undefined ? null : JSON.stringify(persisted.metadata),
      input.outputSource ?? null,
    );
    return { stored: true };
  }
}
