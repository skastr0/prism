import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureDir } from "./fs.js";
import { computeContentHash } from "./content-hash.js";
import type { AnyWorkflowTask, WorkflowRuntimeOptions } from "./workflows.js";
import { WORKFLOW_WORKER_JSON_CONTRACT_VERSION, WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE } from "./workflow-worker-contract.js";

export interface WorkflowTaskIdentity {
  readonly workflow: string;
  readonly taskId: string;
  readonly cacheKey: string;
  readonly promptHash: string;
  readonly agentManifestHash: string;
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

export type WorkflowRunTaskStatus = "completed" | "failed";

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

export type WorkflowRunTaskProgressStatus = "running" | "completed" | "failed";

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

type WorkflowRunTaskProgressPatch = Partial<{
  -readonly [Key in keyof WorkflowRunTaskProgress]: WorkflowRunTaskProgress[Key];
}>;

export interface WorkflowRunRecord {
  readonly runId: string;
  readonly workflow: string;
  readonly status: WorkflowRunStatus;
  readonly finishedAt: string | null;
  readonly runnerPid?: number;
  readonly heartbeatAt?: string;
}

export type WorkflowRunStatus = "running" | "completed" | "failed" | "unknown";

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

interface RunTaskRow {
  readonly run_id: string;
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
    promptHash: computeContentHash(JSON.stringify({
      identityVersion: WORKFLOW_TASK_IDENTITY_VERSION,
      workerJsonContractVersion: WORKFLOW_WORKER_JSON_CONTRACT_VERSION,
      workerJsonInstructionSource: WORKFLOW_WORKER_JSON_INSTRUCTION_SOURCE,
      prompt: task.prompt,
      worker,
      workerSemantics: workflowWorkerSemanticsVersion(worker),
      model: task.worker?.model ?? runtimeOptions.fallbackModel ?? null,
      profile: task.worker?.profile ?? null,
      outputSchema: (task.output as { readonly ast?: unknown }).ast ?? null,
      finish: {
        maxRepairs: task.finish?.maxRepairs ?? 0,
        criteria: task.finish?.criteria?.map((criterion) => ({
          name: criterion.name,
          check: criterion.check.toString(),
          repairPrompt: criterion.repairPrompt?.toString() ?? null,
        })) ?? [],
      },
    })),
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
      select run_id, task_id, cache_key, status, cached, agent_plugin, agent_name, output_json, metadata_json
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
      if (event.type === "task.failed") {
        patch.status = "failed";
        if (payload !== null && typeof payload.cached === "boolean") patch.cached = payload.cached;
        if (payload !== null && typeof payload.cacheKey === "string") patch.cacheKey = payload.cacheKey;
      }
      upsert(taskId, patch);
    }

    return Array.from(summaries.values());
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
