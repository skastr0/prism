import { Database } from "bun:sqlite";
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
