import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureDir } from "./fs.js";
import { computeContentHash } from "./content-hash.js";
import type { AnyWorkflowTask } from "./workflows.js";

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
}

export interface WorkflowRunRecord {
  readonly runId: string;
  readonly workflow: string;
  readonly status: WorkflowRunStatus;
  readonly finishedAt: string | null;
}

export type WorkflowRunStatus = "running" | "completed" | "failed" | "unknown";

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
}

interface RunRow {
  readonly run_id: string;
  readonly workflow: string;
  readonly status: WorkflowRunStatus;
  readonly finished_at: string | null;
}

export const defaultWorkflowStorePath = (projectPath: string): string =>
  join(projectPath, ".prism", "workflows", "workflows.sqlite");

export const workflowTaskIdentity = (
  workflow: string,
  task: AnyWorkflowTask,
): WorkflowTaskIdentity => ({
  workflow,
  taskId: task.id,
  cacheKey: task.cacheKey ?? task.id,
  promptHash: computeContentHash(task.prompt),
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

export class WorkflowStore {
  constructor(private readonly db: Database) {}

  static async open(path: string): Promise<WorkflowStore> {
    await ensureDir(dirname(path));
    const db = new Database(path);
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
        created_at text not null default (datetime('now')),
        primary key (run_id, ordinal)
      );
    `);
    addColumnIfMissing(db, "alter table workflow_runs add column status text not null default 'unknown'");
    addColumnIfMissing(db, "alter table workflow_runs add column finished_at text");
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
    return runId;
  }

  finishRun(runId: string, status: Exclude<WorkflowRunStatus, "running" | "unknown">): void {
    this.db.query("update workflow_runs set status = ?, finished_at = datetime('now') where run_id = ?")
      .run(status, runId);
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
    readonly finishRunStatus?: Exclude<WorkflowRunStatus, "running" | "unknown">;
  }): void {
    const insert = () => {
      this.db.query(`
        insert into workflow_run_tasks (
          run_id, ordinal, workflow, task_id, cache_key, prompt_hash, agent_manifest_hash,
          agent_plugin, agent_name, status, cached, output_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );
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
      select run_id, task_id, cache_key, status, cached, agent_plugin, agent_name, output_json
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
