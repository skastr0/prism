/**
 * The scheduler's own SQLite store.
 *
 * This is deliberately a **separate, machine-global** database from the
 * per-project workflow ledger:
 *
 *   `<PRISM_HOME>/state/workflow-scheduler.sqlite`
 *
 * A schedule is a machine-level fact — one scheduler process watches one
 * catalog, and an installed schedule must stay visible even when its project
 * directory or its target workflow store is temporarily gone. Keeping the
 * catalog project-scoped would make "which schedules exist?" depend on which
 * directory you happened to run a command from.
 *
 * The workflow ledger keeps owning run history. `src/workflow-store-registry.ts`
 * is *not* used to discover schedules: its contract is explicitly best-effort
 * (it swallows registration failures and prunes missing paths on read), which
 * is fine for `runs list --all` and wrong for deciding what should run.
 *
 * Cross-database writes are not one transaction and are not pretended to be.
 * The launch protocol is staged so every intermediate state is recoverable —
 * see `docs/workflow-scheduling.md`.
 *
 * **Timestamps are ISO-8601 UTC strings**, written from JavaScript rather than
 * by SQLite's `datetime('now')`. One format, uniform length, so lexicographic
 * comparison is chronological comparison and no reader has to know which
 * convention a column used.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open as openFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists } from "../fs.js";
import { openWorkflowDatabase, type WorkflowDatabase } from "../workflow-runtime.js";
import { SchedulerStoreError } from "./errors.js";
import type { WorkflowScheduleMissedRuns, WorkflowScheduleOverlap } from "./schedule.js";

export const SCHEDULER_STORE_SCHEMA_VERSION = 1;

const SCHEDULER_STORE_FILE_MODE = 0o600;
const SCHEDULER_STORE_DIRECTORY_MODE = 0o700;

export const schedulerStorePath = (prismHome: string): string =>
  join(prismHome, "state", "workflow-scheduler.sqlite");

export const schedulerLockPath = (prismHome: string): string =>
  join(prismHome, "state", "workflow-scheduler.lock.sqlite");

export type SchedulerInstanceMode = "manual" | "launchd";

export interface SchedulerInstanceRecord {
  readonly instanceId: string;
  readonly pid: number;
  readonly bootId: string | null;
  readonly startId: string | null;
  readonly startedAt: string;
  readonly heartbeatAt: string | null;
  readonly closedAt: string | null;
  readonly version: string;
  readonly mode: SchedulerInstanceMode;
  readonly lastFatalCause: string | null;
}

export interface WorkflowScheduleRecord {
  readonly scheduleId: string;
  readonly name: string;
  readonly workflowFile: string;
  /** The directory the workflow must execute in. Persisted, never inherited. */
  readonly cwd: string;
  /** The project workflow ledger this schedule's runs are written to. */
  readonly storePath: string;
  readonly cron: string;
  readonly timezone: string;
  readonly overlap: WorkflowScheduleOverlap;
  readonly missedRuns: WorkflowScheduleMissedRuns;
  /** CLI fallbacks (`worker`, `model`, `permission`) applied to tasks that pin none. */
  readonly options: Record<string, unknown>;
  readonly enabled: boolean;
  readonly revision: number;
  /** The occurrence Prism intends to run next. The cursor, and the only due signal. */
  readonly nextDueAt: string | null;
  readonly lastExecutionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Execution lifecycle.
 *
 * `reserved` through `uncertain` occupy the schedule — the unique index in
 * `schedule_executions` enforces at most one of them per schedule, so overlap
 * is impossible rather than merely avoided. `skipped-overlap` and `cancelled`
 * are terminal outcomes that never had a worker.
 */
export type ScheduleExecutionStatus =
  | "reserved"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "uncertain"
  | "skipped-overlap"
  | "cancelled"
  | "launch-failed";

export const OCCUPYING_EXECUTION_STATUSES: ReadonlyArray<ScheduleExecutionStatus> = [
  "reserved",
  "running",
  "uncertain",
];

export const TERMINAL_EXECUTION_STATUSES: ReadonlyArray<ScheduleExecutionStatus> = [
  "completed",
  "failed",
  "interrupted",
  "skipped-overlap",
  "cancelled",
  "launch-failed",
];

export interface ScheduleExecutionRecord {
  readonly executionId: string;
  readonly scheduleId: string;
  readonly scheduleRevision: number;
  readonly status: ScheduleExecutionStatus;
  /** The occurrence this execution represents, as an ISO-8601 instant. */
  readonly scheduledFor: string | null;
  readonly schedulerInstanceId: string | null;
  readonly runId: string | null;
  readonly childPid: number | null;
  readonly childBootId: string | null;
  readonly childStartId: string | null;
  readonly authorizedAt: string | null;
  readonly leaseHeartbeatAt: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly observedExitCode: number | null;
  readonly outcome: Record<string, unknown> | null;
  readonly cause: Record<string, unknown> | null;
}

export interface SchedulerEventRecord {
  readonly sequence: number;
  readonly instanceId: string | null;
  readonly scheduleId: string | null;
  readonly executionId: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface ScheduleUpsert {
  readonly name: string;
  readonly workflowFile: string;
  readonly cwd: string;
  readonly storePath: string;
  readonly cron: string;
  readonly timezone: string;
  readonly overlap: WorkflowScheduleOverlap;
  readonly missedRuns: WorkflowScheduleMissedRuns;
  readonly options: Record<string, unknown>;
  /** The first occurrence after install time; computed by the caller's clock. */
  readonly nextDueAt: string;
}

export type ScheduleUpsertResult =
  | { readonly kind: "installed"; readonly schedule: WorkflowScheduleRecord }
  | { readonly kind: "unchanged"; readonly schedule: WorkflowScheduleRecord };

interface ScheduleRow {
  readonly schedule_id: string;
  readonly name: string;
  readonly workflow_file: string;
  readonly cwd: string;
  readonly store_path: string;
  readonly cron: string;
  readonly timezone: string;
  readonly overlap: string;
  readonly missed_runs: string;
  readonly options_json: string | null;
  readonly enabled: number;
  readonly revision: number;
  readonly next_due_at: string | null;
  readonly last_execution_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface InstanceRow {
  readonly instance_id: string;
  readonly pid: number;
  readonly boot_id: string | null;
  readonly start_id: string | null;
  readonly started_at: string;
  readonly heartbeat_at: string | null;
  readonly closed_at: string | null;
  readonly version: string;
  readonly mode: string;
  readonly last_fatal_cause: string | null;
}

interface ExecutionRow {
  readonly execution_id: string;
  readonly schedule_id: string;
  readonly schedule_revision: number;
  readonly status: string;
  readonly scheduled_for: string | null;
  readonly scheduler_instance_id: string | null;
  readonly run_id: string | null;
  readonly child_pid: number | null;
  readonly child_boot_id: string | null;
  readonly child_start_id: string | null;
  readonly authorized_at: string | null;
  readonly lease_heartbeat_at: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly observed_exit_code: number | null;
  readonly outcome_json: string | null;
  readonly cause_json: string | null;
}

const nowIso = (): string => new Date().toISOString();

const jsonOrNull = (value: Record<string, unknown> | null | undefined): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

const parseJsonObject = (value: string | null): Record<string, unknown> | null =>
  value === null ? null : JSON.parse(value) as Record<string, unknown>;

const storeError = (message: string, hint: string, path: string): SchedulerStoreError =>
  new SchedulerStoreError({ message, hint, path });

const instanceFromRow = (row: InstanceRow): SchedulerInstanceRecord => ({
  instanceId: row.instance_id,
  pid: row.pid,
  bootId: row.boot_id,
  startId: row.start_id,
  startedAt: row.started_at,
  heartbeatAt: row.heartbeat_at,
  closedAt: row.closed_at,
  version: row.version,
  mode: row.mode === "launchd" ? "launchd" : "manual",
  lastFatalCause: row.last_fatal_cause,
});

const scheduleFromRow = (row: ScheduleRow): WorkflowScheduleRecord => ({
  scheduleId: row.schedule_id,
  name: row.name,
  workflowFile: row.workflow_file,
  cwd: row.cwd,
  storePath: row.store_path,
  cron: row.cron,
  timezone: row.timezone,
  // Only implemented policies can be persisted; the closed unions in
  // schedule.ts are the single source for what those are, and install
  // re-validates before writing, so a narrowing read here is honest.
  overlap: "skip",
  missedRuns: "skip",
  options: parseJsonObject(row.options_json) ?? {},
  enabled: row.enabled === 1,
  revision: row.revision,
  nextDueAt: row.next_due_at,
  lastExecutionId: row.last_execution_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const executionFromRow = (row: ExecutionRow): ScheduleExecutionRecord => ({
  executionId: row.execution_id,
  scheduleId: row.schedule_id,
  scheduleRevision: row.schedule_revision,
  status: row.status as ScheduleExecutionStatus,
  scheduledFor: row.scheduled_for,
  schedulerInstanceId: row.scheduler_instance_id,
  runId: row.run_id,
  childPid: row.child_pid,
  childBootId: row.child_boot_id,
  childStartId: row.child_start_id,
  authorizedAt: row.authorized_at,
  leaseHeartbeatAt: row.lease_heartbeat_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  observedExitCode: row.observed_exit_code,
  outcome: parseJsonObject(row.outcome_json),
  cause: parseJsonObject(row.cause_json),
});

export class SchedulerStore {
  private constructor(
    private readonly db: WorkflowDatabase,
    readonly path: string,
  ) {}

  static async open(path: string): Promise<SchedulerStore> {
    const directory = dirname(path);
    const directoryPreexisting = await exists(directory);
    await mkdir(directory, { recursive: true, mode: SCHEDULER_STORE_DIRECTORY_MODE });
    if (!directoryPreexisting) await chmod(directory, SCHEDULER_STORE_DIRECTORY_MODE);
    const handle = await openFile(path, "a", SCHEDULER_STORE_FILE_MODE);
    await handle.close();
    await chmod(path, SCHEDULER_STORE_FILE_MODE);

    let db: WorkflowDatabase | undefined;
    const previousUmask = process.umask(0o077);
    try {
      db = openWorkflowDatabase(path);
      db.exec("pragma busy_timeout = 5000;");
      const version = db.query<{ readonly user_version: number }, []>("pragma user_version;").get()?.user_version ?? 0;
      if (version > SCHEDULER_STORE_SCHEMA_VERSION) {
        throw storeError(
          `Scheduler store schema version ${version} is newer than supported version ${SCHEDULER_STORE_SCHEMA_VERSION}`,
          "upgrade Prism before opening this store",
          path,
        );
      }
      if (version === 0) createSchedulerSchema(db);
    } catch (error) {
      db?.close();
      throw error;
    } finally {
      process.umask(previousUmask);
    }
    return new SchedulerStore(db, path);
  }

  close(): void {
    this.db.close();
  }

  // -- instances ------------------------------------------------------------

  registerInstance(input: {
    readonly instanceId: string;
    readonly pid: number;
    readonly bootId: string | null;
    readonly startId: string | null;
    readonly version: string;
    readonly mode: SchedulerInstanceMode;
  }): void {
    this.db.query(`
      insert into scheduler_instances
        (instance_id, pid, boot_id, start_id, started_at, heartbeat_at, version, mode)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(instance_id) do update set
        heartbeat_at = excluded.heartbeat_at,
        closed_at = null
    `).run(
      input.instanceId,
      input.pid,
      input.bootId,
      input.startId,
      nowIso(),
      nowIso(),
      input.version,
      input.mode,
    );
  }

  heartbeatInstance(instanceId: string): void {
    this.db.query("update scheduler_instances set heartbeat_at = ? where instance_id = ?")
      .run(nowIso(), instanceId);
  }

  closeInstance(instanceId: string, lastFatalCause?: string): void {
    this.db.query(`
      update scheduler_instances
      set closed_at = ?, last_fatal_cause = coalesce(?, last_fatal_cause)
      where instance_id = ?
    `).run(nowIso(), lastFatalCause ?? null, instanceId);
  }

  getInstance(instanceId: string): SchedulerInstanceRecord | null {
    const row = this.db.query<InstanceRow, [string]>(`
      select instance_id, pid, boot_id, start_id, started_at, heartbeat_at, closed_at,
             version, mode, last_fatal_cause
      from scheduler_instances where instance_id = ?
    `).get(instanceId);
    return row === null ? null : instanceFromRow(row);
  }

  listInstances(): SchedulerInstanceRecord[] {
    return this.db.query<InstanceRow, []>(`
      select instance_id, pid, boot_id, start_id, started_at, heartbeat_at, closed_at,
             version, mode, last_fatal_cause
      from scheduler_instances
      order by started_at desc
    `).all().map(instanceFromRow);
  }

  // -- schedules ------------------------------------------------------------

  /**
   * Install or update one schedule, keyed by workflow file.
   *
   * Reinstalling an unchanged declaration is a no-op that keeps the existing
   * revision and cursor, so a periodic reinstall cannot reset a running
   * schedule's due time. A changed declaration bumps the revision and resets
   * the cursor in the same transaction — a stale cursor firing the previous
   * plan is not a state this can reach.
   */
  upsertSchedule(input: ScheduleUpsert): ScheduleUpsertResult {
    return this.db.transaction((): ScheduleUpsertResult => {
      const existing = this.db.query<ScheduleRow, [string]>(`
        select schedule_id, name, workflow_file, cwd, store_path, cron, timezone, overlap,
               missed_runs, options_json, enabled, revision, next_due_at, last_execution_id,
               created_at, updated_at
        from schedules where workflow_file = ?
      `).get(input.workflowFile);

      if (existing !== null) {
        const unchanged =
          existing.name === input.name &&
          existing.cwd === input.cwd &&
          existing.store_path === input.storePath &&
          existing.cron === input.cron &&
          existing.timezone === input.timezone &&
          existing.overlap === input.overlap &&
          existing.missed_runs === input.missedRuns &&
          existing.options_json === jsonOrNull(input.options);
        if (unchanged) {
          return { kind: "unchanged", schedule: scheduleFromRow(existing) };
        }
        this.db.query(`
          update schedules
          set name = ?, cwd = ?, store_path = ?, cron = ?, timezone = ?, overlap = ?,
              missed_runs = ?, options_json = ?, revision = revision + 1,
              next_due_at = ?, updated_at = ?
          where schedule_id = ?
        `).run(
          input.name,
          input.cwd,
          input.storePath,
          input.cron,
          input.timezone,
          input.overlap,
          input.missedRuns,
          jsonOrNull(input.options),
          input.nextDueAt,
          nowIso(),
          existing.schedule_id,
        );
        this.recordEvent({
          scheduleId: existing.schedule_id,
          type: "schedule.updated",
          payload: { workflowFile: input.workflowFile, revision: existing.revision + 1, nextDueAt: input.nextDueAt },
        });
        const updated = this.getSchedule(existing.schedule_id);
        if (updated === null) throw new Error(`schedule disappeared during upsert: ${existing.schedule_id}`);
        return { kind: "installed", schedule: updated };
      }

      const scheduleId = randomUUID();
      this.db.query(`
        insert into schedules
          (schedule_id, name, workflow_file, cwd, store_path, cron, timezone, overlap,
           missed_runs, options_json, enabled, revision, next_due_at, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
      `).run(
        scheduleId,
        input.name,
        input.workflowFile,
        input.cwd,
        input.storePath,
        input.cron,
        input.timezone,
        input.overlap,
        input.missedRuns,
        jsonOrNull(input.options),
        input.nextDueAt,
        nowIso(),
        nowIso(),
      );
      this.recordEvent({
        scheduleId,
        type: "schedule.installed",
        payload: { workflowFile: input.workflowFile, cron: input.cron, timezone: input.timezone, nextDueAt: input.nextDueAt },
      });
      const created = this.getSchedule(scheduleId);
      if (created === null) throw new Error(`schedule disappeared during install: ${scheduleId}`);
      return { kind: "installed", schedule: created };
    })();
  }

  getSchedule(scheduleId: string): WorkflowScheduleRecord | null {
    const row = this.db.query<ScheduleRow, [string]>(`
      select schedule_id, name, workflow_file, cwd, store_path, cron, timezone, overlap,
             missed_runs, options_json, enabled, revision, next_due_at, last_execution_id,
             created_at, updated_at
      from schedules where schedule_id = ?
    `).get(scheduleId);
    return row === null ? null : scheduleFromRow(row);
  }

  getScheduleByWorkflowFile(workflowFile: string): WorkflowScheduleRecord | null {
    const row = this.db.query<ScheduleRow, [string]>(`
      select schedule_id, name, workflow_file, cwd, store_path, cron, timezone, overlap,
             missed_runs, options_json, enabled, revision, next_due_at, last_execution_id,
             created_at, updated_at
      from schedules where workflow_file = ?
    `).get(workflowFile);
    return row === null ? null : scheduleFromRow(row);
  }

  listSchedules(): WorkflowScheduleRecord[] {
    return this.db.query<ScheduleRow, []>(`
      select schedule_id, name, workflow_file, cwd, store_path, cron, timezone, overlap,
             missed_runs, options_json, enabled, revision, next_due_at, last_execution_id,
             created_at, updated_at
      from schedules
      order by name asc, schedule_id asc
    `).all().map(scheduleFromRow);
  }

  setScheduleEnabled(scheduleId: string, enabled: boolean): WorkflowScheduleRecord | null {
    return this.db.transaction(() => {
      const changed = this.db.query<{ readonly schedule_id: string }, [number, string, string]>(`
        update schedules set enabled = ?, updated_at = ?
        where schedule_id = ?
        returning schedule_id
      `).get(enabled ? 1 : 0, nowIso(), scheduleId);
      if (changed === null) return null;
      this.recordEvent({
        scheduleId,
        type: enabled ? "schedule.enabled" : "schedule.disabled",
        payload: {},
      });
      return this.getSchedule(scheduleId);
    })();
  }

  /**
   * Remove a schedule. Refuses while an execution still occupies it — including
   * an `uncertain` one — because deleting the row would silently discard the
   * evidence that a worker may still be running.
   */
  removeSchedule(scheduleId: string): { readonly kind: "removed" } | { readonly kind: "not-found" } | { readonly kind: "occupied"; readonly executionId: string } {
    return this.db.transaction((): { readonly kind: "removed" } | { readonly kind: "not-found" } | { readonly kind: "occupied"; readonly executionId: string } => {
      const existing = this.db.query<{ readonly schedule_id: string }, [string]>(
        "select schedule_id from schedules where schedule_id = ?",
      ).get(scheduleId);
      if (existing === null) return { kind: "not-found" };
      const occupying = this.occupyingExecution(scheduleId);
      if (occupying !== null) return { kind: "occupied", executionId: occupying.executionId };
      this.db.query("delete from schedules where schedule_id = ?").run(scheduleId);
      this.recordEvent({ scheduleId, type: "schedule.removed", payload: {} });
      return { kind: "removed" };
    })();
  }

  /**
   * Advance the cursor, optionally recording which execution consumed the
   * opportunity. Compare-and-set on the revision so a schedule edited between
   * the decision and the write cannot have its new cursor overwritten by the
   * old plan.
   */
  advanceCursor(input: {
    readonly scheduleId: string;
    readonly revision: number;
    readonly nextDueAt: string;
    readonly lastExecutionId?: string | null;
  }): boolean {
    const changed = this.db.query<{ readonly schedule_id: string }, [string, string | null, string, string, number]>(`
      update schedules
      set next_due_at = ?, last_execution_id = coalesce(?, last_execution_id), updated_at = ?
      where schedule_id = ? and revision = ?
      returning schedule_id
    `).get(input.nextDueAt, input.lastExecutionId ?? null, nowIso(), input.scheduleId, input.revision);
    return changed !== null;
  }

  // -- executions -----------------------------------------------------------

  /**
   * Reserve the schedule's single execution slot.
   *
   * The insert is guarded by the partial unique index on occupying statuses, so
   * a concurrent reservation raises `SQLITE_CONSTRAINT` rather than producing
   * two executions. Callers treat that as `occupied`, which is the honest
   * answer: something else already holds the slot.
   */
  reserveExecution(input: {
    readonly scheduleId: string;
    readonly scheduleRevision: number;
    readonly scheduledFor: string | null;
    readonly schedulerInstanceId: string;
  }): { readonly kind: "reserved"; readonly execution: ScheduleExecutionRecord } | { readonly kind: "occupied" } {
    const executionId = randomUUID();
    try {
      this.db.query(`
        insert into schedule_executions
          (execution_id, schedule_id, schedule_revision, status, scheduled_for,
           scheduler_instance_id, lease_heartbeat_at, started_at)
        values (?, ?, ?, 'reserved', ?, ?, ?, ?)
      `).run(
        executionId,
        input.scheduleId,
        input.scheduleRevision,
        input.scheduledFor,
        input.schedulerInstanceId,
        nowIso(),
        nowIso(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE constraint failed")) return { kind: "occupied" };
      throw error;
    }
    this.recordEvent({
      scheduleId: input.scheduleId,
      executionId,
      type: "execution.reserved",
      payload: { scheduledFor: input.scheduledFor, scheduleRevision: input.scheduleRevision },
    });
    const execution = this.getExecution(executionId);
    if (execution === null) throw new Error(`execution disappeared during reservation: ${executionId}`);
    return { kind: "reserved", execution };
  }

  getExecution(executionId: string): ScheduleExecutionRecord | null {
    const row = this.db.query<ExecutionRow, [string]>(`
      select execution_id, schedule_id, schedule_revision, status, scheduled_for,
             scheduler_instance_id, run_id, child_pid, child_boot_id, child_start_id,
             authorized_at, lease_heartbeat_at, started_at, finished_at,
             observed_exit_code, outcome_json, cause_json
      from schedule_executions where execution_id = ?
    `).get(executionId);
    return row === null ? null : executionFromRow(row);
  }

  occupyingExecution(scheduleId: string): ScheduleExecutionRecord | null {
    const row = this.db.query<ExecutionRow, [string, string, string, string]>(`
      select execution_id, schedule_id, schedule_revision, status, scheduled_for,
             scheduler_instance_id, run_id, child_pid, child_boot_id, child_start_id,
             authorized_at, lease_heartbeat_at, started_at, finished_at,
             observed_exit_code, outcome_json, cause_json
      from schedule_executions
      where schedule_id = ? and status in (?, ?, ?)
      limit 1
    `).get(scheduleId, ...OCCUPYING_EXECUTION_STATUSES as unknown as [string, string, string]);
    return row === null ? null : executionFromRow(row);
  }

  listOccupyingExecutions(): ScheduleExecutionRecord[] {
    return this.db.query<ExecutionRow, [string, string, string]>(`
      select execution_id, schedule_id, schedule_revision, status, scheduled_for,
             scheduler_instance_id, run_id, child_pid, child_boot_id, child_start_id,
             authorized_at, lease_heartbeat_at, started_at, finished_at,
             observed_exit_code, outcome_json, cause_json
      from schedule_executions
      where status in (?, ?, ?)
      order by started_at asc
    `).all(...OCCUPYING_EXECUTION_STATUSES as unknown as [string, string, string]).map(executionFromRow);
  }

  listExecutions(scheduleId: string, limit = 20): ScheduleExecutionRecord[] {
    return this.db.query<ExecutionRow, [string, number]>(`
      select execution_id, schedule_id, schedule_revision, status, scheduled_for,
             scheduler_instance_id, run_id, child_pid, child_boot_id, child_start_id,
             authorized_at, lease_heartbeat_at, started_at, finished_at,
             observed_exit_code, outcome_json, cause_json
      from schedule_executions
      where schedule_id = ?
      order by started_at desc, rowid desc
      limit ?
    `).all(scheduleId, limit).map(executionFromRow);
  }

  /**
   * Update an execution in place, keyed by the expected current status.
   *
   * The expected-status guard is what keeps two reconcilers from both acting on
   * the same execution: only the one whose expectation still holds writes.
   */
  updateExecution(input: {
    readonly executionId: string;
    readonly expectStatus: ScheduleExecutionStatus;
    readonly status: ScheduleExecutionStatus;
    readonly childPid?: number | null;
    readonly childBootId?: string | null;
    readonly childStartId?: string | null;
    readonly runId?: string | null;
    readonly authorizedAt?: string | null;
    readonly leaseHeartbeatAt?: string | null;
    readonly observedExitCode?: number | null;
    readonly outcome?: Record<string, unknown> | null;
    readonly cause?: Record<string, unknown> | null;
    readonly finishedAt?: string | null;
  }): boolean {
    const changed = this.db.query<{ readonly execution_id: string }, [
      string,
      number | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      number | null,
      string | null,
      string | null,
      string | null,
      string,
      string,
    ]>(`
      update schedule_executions
      set status = ?,
          child_pid = coalesce(?, child_pid),
          child_boot_id = coalesce(?, child_boot_id),
          child_start_id = coalesce(?, child_start_id),
          run_id = coalesce(?, run_id),
          authorized_at = coalesce(?, authorized_at),
          lease_heartbeat_at = coalesce(?, lease_heartbeat_at),
          observed_exit_code = coalesce(?, observed_exit_code),
          outcome_json = coalesce(?, outcome_json),
          cause_json = coalesce(?, cause_json),
          finished_at = coalesce(?, finished_at)
      where execution_id = ? and status = ?
      returning execution_id
    `).get(
      input.status,
      input.childPid ?? null,
      input.childBootId ?? null,
      input.childStartId ?? null,
      input.runId ?? null,
      input.authorizedAt ?? null,
      input.leaseHeartbeatAt ?? null,
      input.observedExitCode ?? null,
      jsonOrNull(input.outcome),
      jsonOrNull(input.cause),
      input.finishedAt ?? null,
      input.executionId,
      input.expectStatus,
    );
    return changed !== null;
  }

  heartbeatExecution(executionId: string): void {
    this.db.query("update schedule_executions set lease_heartbeat_at = ? where execution_id = ?")
      .run(nowIso(), executionId);
  }

  // -- events ---------------------------------------------------------------

  recordEvent(input: {
    readonly type: string;
    readonly payload: unknown;
    readonly instanceId?: string | null;
    readonly scheduleId?: string | null;
    readonly executionId?: string | null;
  }): void {
    this.db.query(`
      insert into scheduler_events (instance_id, schedule_id, execution_id, type, payload_json, created_at)
      values (?, ?, ?, ?, ?, ?)
    `).run(
      input.instanceId ?? null,
      input.scheduleId ?? null,
      input.executionId ?? null,
      input.type,
      JSON.stringify(input.payload ?? {}),
      nowIso(),
    );
  }

  listEvents(limit = 100): SchedulerEventRecord[] {
    return this.db.query<{
      readonly sequence: number;
      readonly instance_id: string | null;
      readonly schedule_id: string | null;
      readonly execution_id: string | null;
      readonly type: string;
      readonly payload_json: string;
      readonly created_at: string;
    }, [number]>(`
      select sequence, instance_id, schedule_id, execution_id, type, payload_json, created_at
      from scheduler_events
      order by sequence desc
      limit ?
    `).all(limit).map((row) => ({
      sequence: row.sequence,
      instanceId: row.instance_id,
      scheduleId: row.schedule_id,
      executionId: row.execution_id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
  }
}

const createSchedulerSchema = (db: WorkflowDatabase): void => {
  db.exec(`
    create table if not exists scheduler_instances (
      instance_id text primary key,
      pid integer not null,
      boot_id text,
      start_id text,
      started_at text not null,
      heartbeat_at text,
      closed_at text,
      version text not null,
      mode text not null,
      last_fatal_cause text
    );

    create table if not exists schedules (
      schedule_id text primary key,
      name text not null,
      workflow_file text not null,
      cwd text not null,
      store_path text not null,
      cron text not null,
      timezone text not null,
      overlap text not null,
      missed_runs text not null,
      options_json text,
      enabled integer not null default 1,
      revision integer not null default 1,
      next_due_at text,
      last_execution_id text,
      created_at text not null,
      updated_at text not null
    );
    create unique index if not exists schedules_workflow_file_idx on schedules (workflow_file);

    create table if not exists schedule_executions (
      execution_id text primary key,
      schedule_id text not null,
      schedule_revision integer not null,
      status text not null,
      scheduled_for text,
      scheduler_instance_id text,
      run_id text,
      child_pid integer,
      child_boot_id text,
      child_start_id text,
      authorized_at text,
      lease_heartbeat_at text,
      started_at text not null,
      finished_at text,
      observed_exit_code integer,
      outcome_json text,
      cause_json text
    );
    -- At most one unresolved execution per schedule, enforced by the database
    -- rather than by a flag two schedulers could both believe.
    create unique index if not exists schedule_executions_occupancy_idx
      on schedule_executions (schedule_id)
      where status in ('reserved', 'running', 'uncertain');
    create index if not exists schedule_executions_schedule_idx
      on schedule_executions (schedule_id, started_at);

    create table if not exists scheduler_events (
      sequence integer primary key autoincrement,
      instance_id text,
      schedule_id text,
      execution_id text,
      type text not null,
      payload_json text not null,
      created_at text not null
    );
  `);
  db.exec("pragma user_version = 1;");
};
