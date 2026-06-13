import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureDir } from "./fs.js";
import { computeContentHash } from "./content-hash.js";
import type { AnyWorkflowTask, WorkflowRuntimeOptions } from "./workflows.js";

export interface WorkflowTaskIdentity {
  readonly workflow: string;
  readonly taskId: string;
  readonly cacheKey: string;
  readonly promptHash: string;
  readonly agentManifestHash: string;
}

export interface CompletedWorkflowTaskRecord {
  readonly identity: WorkflowTaskIdentity;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly output: unknown;
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

export interface WorkflowRunRecord {
  readonly runId: string;
  readonly workflow: string;
  readonly status: WorkflowRunStatus;
  readonly finishedAt: string | null;
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
  readonly output_json: string;
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

export const workflowTaskIdentity = (
  workflow: string,
  task: AnyWorkflowTask,
  runtimeOptions: WorkflowRuntimeOptions = {},
): WorkflowTaskIdentity => ({
  workflow,
  taskId: task.id,
  cacheKey: task.cacheKey ?? task.id,
  promptHash: computeContentHash(JSON.stringify({
    prompt: task.prompt,
    worker: task.worker?.worker ?? runtimeOptions.fallbackWorker ?? null,
    model: task.worker?.model ?? runtimeOptions.fallbackModel ?? null,
  })),
  agentManifestHash: task.agent.manifestHash,
});

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
             agent_plugin, agent_name, output_json
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
    };
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

  finishRun(runId: string, status: Exclude<WorkflowRunStatus, "running" | "unknown">): void {
    this.db.query("update workflow_runs set status = ?, finished_at = datetime('now') where run_id = ?")
      .run(status, runId);
    this.recordEvent({ runId, type: `run.${status}`, payload: {} });
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
          and datetime(created_at) < datetime(?)
        returning run_id, workflow, status, finished_at, created_at
      `).all(staleBefore);
      for (const row of updated) {
        this.recordEvent({
          runId: row.run_id,
          type: "run.failed",
          payload: {
            reason: "stale-running-run",
            staleAfterMs: olderThanMs,
            staleBefore,
            createdAt: row.created_at,
          },
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
    }));
  }

  listRuns(): WorkflowRunRecord[] {
    const rows = this.db.query<RunRow, []>(`
      select run_id, workflow, status, finished_at
      from workflow_runs
      order by created_at asc, run_id asc
    `).all();
    return rows.map((row) => ({
      runId: row.run_id,
      workflow: row.workflow,
      status: row.status,
      finishedAt: row.finished_at,
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
        payload: { cached: input.cached, cacheKey: input.identity.cacheKey },
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

  recordCompleted(input: {
    readonly identity: WorkflowTaskIdentity;
    readonly agent: { readonly plugin: string; readonly name: string };
    readonly output: unknown;
  }): void {
    this.db.query(`
      insert into workflow_task_records (
        workflow, task_id, cache_key, prompt_hash, agent_manifest_hash,
        agent_plugin, agent_name, status, output_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, 'completed', ?, datetime('now'))
      on conflict(workflow, task_id, cache_key, prompt_hash, agent_manifest_hash)
      do update set
        agent_plugin = excluded.agent_plugin,
        agent_name = excluded.agent_name,
        status = excluded.status,
        output_json = excluded.output_json,
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
    );
  }
}
