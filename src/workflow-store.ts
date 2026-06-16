import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureDir } from "./fs.js";
import { stableJsonHash, type StableJsonValue } from "@skastr0/prism-core/stable-json";
import type { AnyWorkflowTask, WorkflowJudgeVerdict, WorkflowRuntimeOptions } from "./workflows.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";

export interface WorkflowTaskIdentity {
  readonly workflow: string;
  readonly taskId: string;
  readonly cacheKey: string;
  readonly promptHash: string;
  readonly agentManifestHash: string;
}

export interface WorkflowJudgeIdentity {
  readonly workflow: string;
  readonly taskId: string;
  readonly taskCacheKey: string;
  readonly criterion: string;
  readonly cacheKey: string;
}

const WORKFLOW_TASK_IDENTITY_VERSION = 2;

const workflowWorkerSemanticsVersion = (worker: string | null): string => {
  switch (worker) {
    case "claude-code":
    case "grok":
    case "opencode":
      return "native-agent-v1";
    case "amp-code":
    case "codex-cli":
    case "hermes":
    case "kimi-code":
      return "prompt-agent-v1";
    case "antigravity-cli":
      return "prompt-agent-timeout-recovery-v1";
    case null:
      return "mock-or-custom-v1";
    default:
      return `custom:${worker}`;
  }
};

export interface CompletedWorkflowTaskRecord {
  readonly identity: WorkflowTaskIdentity;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly output: unknown;
  readonly metadata?: Record<string, unknown>;
}

export interface WorkflowCacheRecord extends CompletedWorkflowTaskRecord {
  readonly status: string;
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

export type WorkflowRunTaskStatus = "completed" | "failed" | "escalated";

export interface WorkflowRunTaskRecord {
  readonly runId: string;
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

export type WorkflowRunTaskProgressStatus = "running" | "completed" | "failed" | "escalated";

export type WorkflowRunTaskCacheLookup = "hit" | "miss" | "skipped";

export interface WorkflowRunTaskProgress {
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

export interface WorkflowRunRecord {
  readonly runId: string;
  readonly workflow: string;
  readonly status: WorkflowRunStatus;
  readonly finishedAt: string | null;
  readonly runnerPid?: number;
  readonly heartbeatAt?: string;
}

export type WorkflowRunStatus = "running" | "completed" | "failed" | "escalated" | "unknown";

export interface WorkflowEventRecord {
  readonly sequence: number;
  readonly runId: string;
  readonly taskId: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: string;
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

export const defaultWorkflowStorePath = (projectPath: string): string =>
  join(projectPath, ".prism", "workflows", "workflows.sqlite");

const sqliteDateTime = (date: Date): string =>
  date.toISOString().slice(0, 19).replace("T", " ");

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

const objectPayload = (payload: unknown): Record<string, unknown> | null =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;

const stringMetadata = (metadata: Record<string, unknown> | undefined, key: string): string | null => {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const numberMetadata = (metadata: Record<string, unknown> | undefined, key: string): number | null => {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const externalSessionPointer = (metadata: Record<string, unknown> | undefined): string | null =>
  stringMetadata(metadata, "externalSessionPointer")
    ?? stringMetadata(metadata, "sessionId")
    ?? stringMetadata(metadata, "sessionID")
    ?? stringMetadata(metadata, "session_id");

const objectMetadata = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const repairModeMetadata = (metadata: Record<string, unknown> | undefined): string | null => {
  const finish = objectMetadata(metadata?.finish);
  const repairMode = finish?.repairMode;
  return typeof repairMode === "string" ? repairMode : null;
};

const repairCountMetadata = (metadata: Record<string, unknown> | undefined): number | null => {
  const finish = objectMetadata(metadata?.finish);
  const repairs = finish?.repairs;
  return typeof repairs === "number" && Number.isInteger(repairs) && repairs >= 0 ? repairs : null;
};

const eventRepairMode = (payload: Record<string, unknown> | null): string | null => {
  const mode = payload?.mode ?? payload?.repairMode;
  return typeof mode === "string" && mode.length > 0 ? mode : null;
};

const eventRepairCount = (payload: Record<string, unknown> | null): number | null => {
  const repairs = payload?.repairs;
  return typeof repairs === "number" && Number.isInteger(repairs) && repairs >= 0 ? repairs : null;
};

const sqliteTimestampMs = (timestamp: string | undefined): number | null => {
  if (timestamp === undefined) return null;
  const parsed = Date.parse(`${timestamp.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
};

const elapsedMs = (start: string | undefined, finish: string | undefined): number | null => {
  const startMs = sqliteTimestampMs(start);
  const finishMs = sqliteTimestampMs(finish);
  if (startMs === null || finishMs === null || finishMs < startMs) return null;
  return finishMs - startMs;
};

export const workflowTaskIdentity = (
  workflow: string,
  task: AnyWorkflowTask,
  runtimeOptions: WorkflowRuntimeOptions = {},
): WorkflowTaskIdentity => {
  const worker = task.worker?.worker ?? runtimeOptions.fallbackWorker ?? null;
  return {
    workflow,
    taskId: task.id,
    cacheKey: task.cacheKey ?? task.id,
    promptHash: stableJsonHash({
      identityVersion: WORKFLOW_TASK_IDENTITY_VERSION,
      workerJsonContractVersion: WORKFLOW_WORKER_JSON_CONTRACT_VERSION,
      workerJsonInstructionSource: WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE,
      prompt: task.prompt,
      worker,
      workerSemantics: workflowWorkerSemanticsVersion(worker),
      model: task.worker?.model ?? runtimeOptions.fallbackModel ?? null,
      profile: task.worker?.profile ?? null,
      outputSchema: ((task.output as { readonly ast?: unknown }).ast ?? null) as StableJsonValue,
      finish: {
        maxRepairs: task.finish?.maxRepairs ?? 0,
        criteria: task.finish?.criteria?.map((criterion) => ({
          kind: criterion.kind ?? "deterministic",
          name: criterion.name,
          ...(criterion.kind === "judge"
            ? {
              goal: typeof criterion.goal === "function" ? criterion.goal.toString() : criterion.goal ?? null,
              selectEvidence: criterion.selectEvidence?.toString() ?? null,
              evaluate: criterion.evaluate.toString(),
            }
            : {
              check: criterion.check.toString(),
              repairPrompt: criterion.repairPrompt?.toString() ?? null,
            }),
        })) ?? [],
      },
    } as StableJsonValue),
    agentManifestHash: task.agent.manifestHash,
  };
};

const addColumnIfMissing = (db: Database, statement: string): void => {
  try {
    db.exec(statement);
  } catch (error) {
    if (error instanceof Error && error.message.includes("duplicate column name")) {
      return;
    }
    throw error;
  }
};

const enableConcurrentWorkflowAccess = (db: Database): void => {
  db.exec("pragma busy_timeout = 5000;");
  try {
    db.exec("pragma journal_mode = WAL;");
  } catch (error) {
    if (error instanceof Error && error.message.includes("database is locked")) {
      return;
    }
    throw error;
  }
};

export class WorkflowStore {
  constructor(private readonly db: Database) {}

  static async open(path: string): Promise<WorkflowStore> {
    await ensureDir(dirname(path));
    const db = new Database(path);
    enableConcurrentWorkflowAccess(db);
    db.exec(`
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
    `);
    addColumnIfMissing(db, "alter table workflow_runs add column status text not null default 'unknown'");
    addColumnIfMissing(db, "alter table workflow_runs add column finished_at text");
    addColumnIfMissing(db, "alter table workflow_runs add column handoff_token text");
    addColumnIfMissing(db, "alter table workflow_runs add column runner_pid integer");
    addColumnIfMissing(db, "alter table workflow_runs add column heartbeat_at text");
    addColumnIfMissing(db, "alter table workflow_task_records add column metadata_json text");
    addColumnIfMissing(db, "alter table workflow_run_tasks add column metadata_json text");
    // Legacy ledgers did not know the workflow's full task count, so completed
    // task rows are not proof that the whole run finished. Only failed task rows
    // carry enough evidence to safely backfill a terminal status.
    db.exec(`
      update workflow_runs
      set status = 'failed', finished_at = coalesce(finished_at, datetime('now'))
      where status in ('running', 'unknown')
        and exists (
          select 1 from workflow_run_tasks
          where workflow_run_tasks.run_id = workflow_runs.run_id
            and workflow_run_tasks.status = 'failed'
        );
    `);
    return new WorkflowStore(db);
  }

  close(): void {
    this.db.close();
  }

  getCompleted(identity: WorkflowTaskIdentity): CompletedWorkflowTaskRecord | null {
    const row = this.db.query<TaskRecordRow, [string, string, string, string, string]>(`
      select workflow, task_id, cache_key, prompt_hash, agent_manifest_hash,
             agent_plugin, agent_name, status, output_json, metadata_json, created_at, updated_at
      from workflow_task_records
      where workflow = ?
        and task_id = ?
        and cache_key = ?
        and prompt_hash = ?
        and agent_manifest_hash = ?
        and status = 'completed'
    `).get(
      identity.workflow,
      identity.taskId,
      identity.cacheKey,
      identity.promptHash,
      identity.agentManifestHash,
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
  }): void {
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
      "feedback" in input.verdict ? input.verdict.feedback ?? null : null,
      JSON.stringify(input.evidence),
      JSON.stringify(input.output),
      JSON.stringify(input.taskMetadata),
      input.verdict.metadata === undefined ? null : JSON.stringify(input.verdict.metadata),
    );
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
             agent_plugin, agent_name, status, output_json, metadata_json, created_at, updated_at
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
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  createRun(workflow: string, runId: string = randomUUID()): string {
    this.db.query("insert into workflow_runs (run_id, workflow, status) values (?, ?, 'running')").run(runId, workflow);
    this.recordEvent({ runId, type: "run.started", payload: { workflow } });
    return runId;
  }

  setRunHandoffToken(runId: string, token: string): void {
    this.db.query("update workflow_runs set handoff_token = ? where run_id = ?").run(token, runId);
  }

  consumeRunHandoffToken(runId: string, token: string): boolean {
    const row = this.db.query<HandoffTokenRow, [string]>(
      "select handoff_token from workflow_runs where run_id = ?"
    ).get(runId);
    if (row?.handoff_token !== token) return false;
    this.db.query("update workflow_runs set handoff_token = null where run_id = ?").run(runId);
    return true;
  }

  markRunRunnerStarted(runId: string, runnerPid: number): void {
    this.db.query(`
      update workflow_runs
      set runner_pid = ?, heartbeat_at = datetime('now')
      where run_id = ? and status = 'running'
    `).run(runnerPid, runId);
    this.recordEvent({ runId, type: "runner.started", payload: { runnerPid } });
  }

  heartbeatRun(runId: string): void {
    this.db.query(`
      update workflow_runs
      set heartbeat_at = datetime('now')
      where run_id = ? and status = 'running'
    `).run(runId);
  }

  finishRun(runId: string, status: Exclude<WorkflowRunStatus, "running" | "unknown">): void {
    const updated = this.db.query<{ readonly run_id: string }, [WorkflowRunStatus, string]>(`
      update workflow_runs
      set status = ?, finished_at = datetime('now')
      where run_id = ? and status = 'running'
      returning run_id
    `).get(status, runId);
    if (updated != null) {
      this.recordEvent({ runId, type: `run.${status}`, payload: {} });
    }
  }

  stopRun(runId: string, reason: string = "stop-requested"): WorkflowRunRecord | null {
    this.failDeadPidRuns();
    const stop = this.db.transaction(() => {
      const stopped = this.db.query<RunRow, [string]>(`
        update workflow_runs
        set status = 'failed', finished_at = datetime('now')
        where run_id = ? and status = 'running'
        returning run_id, workflow, status, finished_at, runner_pid, heartbeat_at
      `).get(runId);
      if (stopped != null) {
        this.recordEvent({ runId, type: "run.stop_requested", payload: { reason } });
        this.recordEvent({ runId, type: "run.failed", payload: { reason } });
        return stopped;
      }
      return this.db.query<RunRow, [string]>(`
        select run_id, workflow, status, finished_at
             , runner_pid, heartbeat_at
        from workflow_runs
        where run_id = ?
      `).get(runId);
    });
    const row = stop();
    if (row == null) return null;
    return {
      runId: row.run_id,
      workflow: row.workflow,
      status: row.status,
      finishedAt: row.finished_at,
      ...(row.runner_pid !== null ? { runnerPid: row.runner_pid } : {}),
      ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
    };
  }

  stopRunningRun(runId: string, reason: string = "stop-requested"): WorkflowRunRecord | null {
    this.failDeadPidRuns();
    const stop = this.db.transaction(() => {
      const row = this.db.query<RunRow, [string]>(`
        update workflow_runs
        set status = 'failed', finished_at = datetime('now')
        where run_id = ? and status = 'running'
        returning run_id, workflow, status, finished_at, runner_pid, heartbeat_at
      `).get(runId);
      if (row == null) return null;
      this.recordEvent({ runId, type: "run.stop_requested", payload: { reason } });
      this.recordEvent({ runId, type: "run.failed", payload: { reason } });
      return row;
    });
    const row = stop();
    if (row == null) return null;
    return {
      runId: row.run_id,
      workflow: row.workflow,
      status: row.status,
      finishedAt: row.finished_at,
      ...(row.runner_pid !== null ? { runnerPid: row.runner_pid } : {}),
      ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
    };
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
      const row = this.db.query<RunRow, [string]>(`
        update workflow_runs
        set status = 'failed', finished_at = datetime('now')
        where run_id = ? and status = 'running'
        returning run_id, workflow, status, finished_at, runner_pid, heartbeat_at
      `).get(input.previousRunId);
      if (row == null) return null;
      const reason = input.reason ?? "update-requested";
      this.recordEvent({ runId: input.previousRunId, type: "run.stop_requested", payload: { reason } });
      this.recordEvent({ runId: input.previousRunId, type: "run.failed", payload: { reason } });
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
    if (row == null) return null;
    return {
      runId: row.run_id,
      workflow: row.workflow,
      status: row.status,
      finishedAt: row.finished_at,
      ...(row.runner_pid !== null ? { runnerPid: row.runner_pid } : {}),
      ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
    };
  }

  getRun(runId: string): WorkflowRunRecord | null {
    this.failDeadPidRuns();
    const row = this.db.query<RunRow, [string]>(`
      select run_id, workflow, status, finished_at, runner_pid, heartbeat_at
      from workflow_runs
      where run_id = ?
    `).get(runId);
    if (row == null) return null;
    return {
      runId: row.run_id,
      workflow: row.workflow,
      status: row.status,
      finishedAt: row.finished_at,
      ...(row.runner_pid !== null ? { runnerPid: row.runner_pid } : {}),
      ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
    };
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
      JSON.stringify(input.payload),
    );
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
      select run_id, workflow, status, finished_at, runner_pid, heartbeat_at, created_at
      from workflow_runs
      where status = 'running'
        and runner_pid is not null
    `).all();
    const dead = candidates.filter((row) => row.runner_pid !== null && !processIsAlive(row.runner_pid));
    if (dead.length === 0) return [];
    const fail = this.db.transaction(() => {
      const failed: WorkflowRunRecord[] = [];
      for (const row of dead) {
        const updated = this.db.query<RunRow, [string]>(`
          update workflow_runs
          set status = 'failed', finished_at = datetime('now')
          where run_id = ? and status = 'running'
          returning run_id, workflow, status, finished_at, runner_pid, heartbeat_at
        `).get(row.run_id);
        if (updated === null) continue;
        const payload = {
          reason: "dead-runner-pid",
          runnerPid: row.runner_pid,
          createdAt: row.created_at,
          ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
        };
        this.recordEvent({ runId: row.run_id, type: "run.stale_dead_pid", payload });
        this.recordEvent({ runId: row.run_id, type: "run.failed", payload });
        failed.push({
          runId: updated.run_id,
          workflow: updated.workflow,
          status: "failed",
          finishedAt: updated.finished_at,
          ...(updated.runner_pid !== null ? { runnerPid: updated.runner_pid } : {}),
          ...(updated.heartbeat_at !== null ? { heartbeatAt: updated.heartbeat_at } : {}),
        });
      }
      return failed;
    });
    return fail();
  }

  failStaleRuns(olderThanMs: number, now: Date = new Date()): WorkflowRunRecord[] {
    if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
      throw new Error("olderThanMs must be a positive number");
    }
    const staleBefore = sqliteDateTime(new Date(now.getTime() - olderThanMs));
    const fail = this.db.transaction(() => {
      const updated = this.db.query<StaleRunRow, [string]>(`
        update workflow_runs
        set status = 'failed', finished_at = datetime('now')
        where status = 'running'
          and datetime(coalesce(heartbeat_at, created_at)) < datetime(?)
        returning run_id, workflow, status, finished_at, runner_pid, heartbeat_at, created_at
      `).all(staleBefore);
      for (const row of updated) {
        const payload = {
          reason: "stale-running-run",
          staleAfterMs: olderThanMs,
          staleBefore,
          createdAt: row.created_at,
          ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
        };
        this.recordEvent({
          runId: row.run_id,
          type: "run.stale_reconciled",
          payload,
        });
        this.recordEvent({
          runId: row.run_id,
          type: "run.failed",
          payload,
        });
      }
      return updated;
    });
    const failedRuns = fail();
    return failedRuns.map((row) => ({
      runId: row.run_id,
      workflow: row.workflow,
      status: "failed" as const,
      finishedAt: row.finished_at,
      ...(row.runner_pid !== null ? { runnerPid: row.runner_pid } : {}),
      ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
    }));
  }

  listRuns(): WorkflowRunRecord[] {
    this.failDeadPidRuns();
    const rows = this.db.query<RunRow, []>(`
      select run_id, workflow, status, finished_at, runner_pid, heartbeat_at
      from workflow_runs
      order by created_at asc, run_id asc
    `).all();
    return rows.map((row) => ({
      runId: row.run_id,
      workflow: row.workflow,
      status: row.status,
      finishedAt: row.finished_at,
      ...(row.runner_pid !== null ? { runnerPid: row.runner_pid } : {}),
      ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
    }));
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
        JSON.stringify(input.output),
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      );
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
        this.finishRun(input.runId, input.finishRunStatus);
      }
    };
    if (input.finishRunStatus === undefined) {
      insert();
      return;
    }
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
    const upsert = (taskId: string, patch: WorkflowRunTaskProgressPatch): void => {
      const existing = summaries.get(taskId);
      summaries.set(taskId, {
        taskId,
        status: existing?.status ?? "running",
        repairs: existing?.repairs ?? 0,
        ...existing,
        ...patch,
      });
    };

    for (const task of this.listRunTasks(runId)) {
      upsert(task.taskId, {
        status: task.status,
        cacheKey: task.cacheKey,
        cached: task.cached,
        agent: task.agent,
      });
    }

    for (const event of this.listRunEvents(runId)) {
      if (event.taskId === null) continue;
      const taskId = event.taskId;
      const payload = objectPayload(event.payload);
      const existing = summaries.get(taskId);
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
      upsert(taskId, patch);
    }

    return Array.from(summaries.values());
  }

  compactRunSummary(runId: string): WorkflowRunCompactSummary | null {
    const run = this.getRun(runId);
    if (run === null) return null;

    const summaries = new Map<string, WorkflowRunTaskCompactAccumulator>();
    const upsert = (taskId: string, patch: WorkflowRunTaskCompactPatch): void => {
      const existing = summaries.get(taskId);
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
        status: patch.status ?? existing?.status ?? "running",
        execution: patch.execution ?? existing?.execution ?? "unknown",
        evidenceSource: patch.evidenceSource ?? existing?.evidenceSource ?? "unknown",
        cached: patch.cached ?? existing?.cached ?? null,
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
      summaries.set(taskId, next);
    };

    for (const [index, task] of this.listRunTasks(runId).entries()) {
      upsert(task.taskId, {
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
      if (event.taskId === null) {
        if (event.type === "run.started") runStartedAt = event.createdAt;
        if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.escalated") {
          runFinishedAt = event.createdAt;
        }
        continue;
      }
      const taskId = event.taskId;
      const payload = objectPayload(event.payload);
      const existing = summaries.get(taskId);
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
      upsert(taskId, patch);
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
      },
      tasks,
    };
  }

  recordCompleted(input: {
    readonly identity: WorkflowTaskIdentity;
    readonly agent: { readonly plugin: string; readonly name: string };
    readonly output: unknown;
    readonly metadata?: Record<string, unknown>;
  }): void {
    this.db.query(`
      insert into workflow_task_records (
        workflow, task_id, cache_key, prompt_hash, agent_manifest_hash,
        agent_plugin, agent_name, status, output_json, metadata_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, datetime('now'))
      on conflict(workflow, task_id, cache_key, prompt_hash, agent_manifest_hash)
      do update set
        agent_plugin = excluded.agent_plugin,
        agent_name = excluded.agent_name,
        status = excluded.status,
        output_json = excluded.output_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      input.identity.workflow,
      input.identity.taskId,
      input.identity.cacheKey,
      input.identity.promptHash,
      input.identity.agentManifestHash,
      input.agent.plugin,
      input.agent.name,
      JSON.stringify(input.output),
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    );
  }
}
