# 03 — Runtime and Execution Model

Answers: where does it run, in what process, what persists, how replay works,
and why completed agent runs are durable resources rather than disposable task
results.

## Where it runs: locally, always (v1)

The runtime executes on the user's machine because everything it needs is
local: harness binaries and their auth (`claude`, `grok`, `codex`, `agy`,
`hermes` logins), the prism-managed harness roots it attests against, the
project filesystem, and worktrees. There is no server component, no REPL, no
remote scheduler. (Remote/sandboxed workers are a possible WS6+ lane behind the
worker gateway interface; nothing in v1 should preclude them, nothing in v1
builds them.)

## Process model

```
prism workflow CLI (bun)
└── runner process (one per run, bun)
    ├── loads the workflow module (plain TS import — trusted local code)
    ├── provides the runtime Layer: WorkflowRuntime | Clock | Random
    │     WorkflowRuntime = Gate ∘ WorkerGateway ∘ AgentRunLedger ∘ Budget ∘ Approvals ∘ Worktrees
    ├── spawns worker subprocesses per live agent run (Bun.spawn: claude/grok/codex/agy/hermes)
    │     structured concurrency: fiber-per-agent-run, Scope-tied — runner death kills workers,
    │     SIGTERM → grace → SIGKILL, no orphans ever
    └── writes AgentRun ledger rows + transcripts + events
```

Two run modes, same runner:

- **Foreground**: `prism workflow run missions/x.workflow.ts --input '{...}'` —
  streams progress to the terminal, exits with the workflow result.
- **Detached**: `--detach` starts the runner supervised in the style of
  `background-tasks` (this is the "runtime similar to background tasks"
  question — yes, exactly that supervision shape, and on macOS we evaluate
  reusing `background-tasks` itself as the supervisor before building any
  bespoke daemonization): `status`, `wait`, `events`, `stop` against a workflow
  run id. An agent kicks off a long mission, polls `wait`, gets a JSON envelope.

The execution model is **runner-owns-live-work**: no shared daemon is required to
execute a run, but completed AgentRuns persist in the project ledger and can be
reused by future runner processes. Two live workflow runs never share a process.
They may, however, share immutable completed AgentRun resources by stable key and
semantic revision. Cross-run concurrency control (e.g. "only one repo-writer at a
time") is expressed as SQLite-backed named locks in the same ledger as the
AgentRun resources. Files may mirror diagnostics, but SQLite owns liveness,
heartbeats, stop/status state, and concurrency locks in v1.

## Storage layout: SQLite ledger first

The primary v1 store is SQLite under Prism home, project-keyed by repository or
cwd identity. There is no JSONL replay mode.
Provider transcripts may be stored as rows or content-addressed artifacts, but
SQLite is the only runtime source of truth.

The filesystem tree is a convenience/artifact cache. If it disagrees with the
SQLite ledger, the ledger wins. Crash recovery, lock cleanup, status, wait, and
stop never depend on a filesystem lease being present.

Implementation checkpoint (2026-07-04): the dogfood runtime stores workflow
runs, task rows, events, and cache records in
`~/.prism/workflows/<project-key>/workflows.sqlite` by default. That store proves
the local runtime loop, cache replay, detached inspection, stop/cancel, and
finish repair. It is not yet the final AgentRun-resource ledger sketched below;
current task records should be treated as durable evidence for the dogfood
wedge, not as the full resource model with refs, lineage, attempts, and
cross-scope locks.

### Joining a failed task to its harness session id (OBS-006)

The dogfood store's `workflow_run_tasks` table (`src/workflow-store.ts`) has no
dedicated session-id column — `metadata_json` carries `adapter`, `sessionId`,
`stderrExcerpt`, `stderrTruncated`, `stderrBytes`, and `stderrSha256` as JSON
keys, for both completed and failed rows. Every worker adapter attaches this
to its failure error's `metadata` property, and the runner merges it into both
the persisted row and the `task.executor.failed` event the same way it already
merges an adapter's metadata on the completion path. Query it with SQLite's
`json_extract`:

```sql
-- One failed task row, forensics pulled out of metadata_json.
select
  run_id,
  task_id,
  agent_plugin,
  agent_name,
  json_extract(metadata_json, '$.adapter')         as adapter,
  json_extract(metadata_json, '$.sessionId')       as harness_session_id,
  json_extract(metadata_json, '$.stderrExcerpt')   as stderr_excerpt,
  json_extract(metadata_json, '$.stderrTruncated') as stderr_truncated,
  created_at
from workflow_run_tasks
where status = 'failed'
order by created_at desc;

-- Same join, widened to every task.executor.failed event for that task (the event
-- payload carries the identical metadata keys, recorded at the moment of failure —
-- useful when a task retried through repair before landing on its final row).
select
  t.run_id,
  t.task_id,
  json_extract(t.metadata_json, '$.sessionId') as harness_session_id,
  e.type,
  json_extract(e.payload_json, '$.stderrExcerpt') as event_stderr_excerpt,
  e.created_at as failed_at
from workflow_run_tasks t
join workflow_events e
  on e.run_id = t.run_id and e.task_id = t.task_id and e.type = 'task.executor.failed'
where t.status = 'failed'
order by e.created_at desc;
```

Once `harness_session_id` and `adapter` are known, join against the harness's own
transcript store (e.g. a quasar-ingested session) to recover the full worker
transcript for a task that never returned a decodable result.

```
~/.prism/workflows/<project-key>/
  workflow-ledger.sqlite   # AgentRun/resources/runs/events index
  runs/<workflowRunId>/
    input.json             # decoded defineWorkflow input
  agent-runs/<agentRunId>/
    attempts/<n>/
      request.json         # exact worker invocation (argv, env names — not values, cwd)
      transcript           # optional provider stream artifact
      output.json          # decoded result mirror (post-Schema)
```

Minimal v1 tables:

```text
workflow_runs
  id, workflow_path, workflow_hash, input_hash, status,
  root_output_ref, created_at, updated_at

agent_runs
  id, scope_key, stable_key, revision_hash, semantic_hash, status,
  agent_ref_json, harness, prompt_hash, schema_hash,
  refs_json, session_lineage_json, created_at, completed_at

agent_run_outputs
  agent_run_id, schema_hash, output_json

agent_run_attempts
  agent_run_id, attempt, status, request_json, transcript_path,
  provider_session_json, usage_json, error_json

agent_run_refs
  agent_run_id, ref_kind, ref_json, ref_hash

agent_run_session_lineage
  agent_run_id, source_agent_run_id, mode, provider_session_id

workflow_events
  seq, workflow_run_id, event_type, payload_json, at
```

The workflow run is secondary: it records one execution of one workflow module.
The AgentRun ledger is primary: it records durable facts of local agent labor.
Future workflow runs can refer to prior AgentRuns without depending on the prior
workflow's source file or conversation context.

## AgentRun resource lifecycle

Each `wf.agentRun(key, agent, spec)` follows the same algorithm:

1. Compute the semantic fingerprint from:
   - stable key
   - generated agent ref + manifest hash
   - harness and adapter capability mode
   - model profile / concrete model / effort
   - prompt hash
   - output schema hash
   - cwd/worktree identity as an execution hint
   - declared permission needs
   - evidence/world/artifact refs
   - session lineage and fork mode, if intentionally using provider session context
   - runtime key version
2. Look up an existing completed AgentRun with the same stable key and semantic
   fingerprint.
3. If found, re-decode the stored output with the current Effect Schema and
   return `AgentRun<A>` without touching the provider.
4. If not found, insert a new immutable run revision, execute the provider
   attempt, decode output, persist output/transcript/session/provenance, and
   return `AgentRun<A>`.

Changing downstream workflow code does not change an upstream AgentRun's
fingerprint. Changing the prompt, schema, agent, harness, permissions, cwd,
model, evidence refs, or session seed creates a new revision.

Stable key collision is not silent. Same key + same fingerprint is reuse. Same
key + different fingerprint creates a new revision and surfaces prior revisions
in CLI/status output so authors know the resource has history.

## Event vocabulary

```
workflow_started   {runId, workflow, inputHash, generatedRefsHash, manifestHash}
agent_run_reused   {key, agentRunId, revisionHash, sourceWorkflowRunId?}
agent_run_started  {key, agentRunId, revisionHash, agentRef, harness, attempt}
gate_passed        {key, agentRunId, checks: {provenance, attestation, policy, budget}, attestation: "attested"|"declared"}
gate_failed        {key, error}                          # typed: RefDrift | NotInstalled | PolicyViolation | BudgetExceeded
worker_spawned     {key, harness, sessionId?}
agent_run_output   {key, agentRunId, outputHash, usage?, costUsd?, durationMs}
agent_run_failed   {key, agentRunId, error, retryable, nextAttemptAt?}
decode_retry       {key, parseError, retryIndex}         # does NOT consume task retries
approval_requested {approvalId, payload}
approval_decided   {approvalId, approved, by, at}
clock_read         {value}    random_read {value}        # optional deterministic workflow services
fanout_expanded    {id, count}
workflow_finished  {result | error, totals: {agentRuns, reused, tokens?, costUsd?, wallMs}}
```

## Replay semantics

`prism workflow run <file>` and `prism workflow resume <workflowRunId>` both
execute the workflow module from the top. The important behavior is not process
resumption; it is AgentRun resource reuse.

1. Load the workflow module and decode input.
2. For each `wf.agentRun` / `wf.useRun` / `wf.forkRun`, resolve the AgentRun
   resource from the ledger or create a new immutable revision.
3. Completed matching resources return instantly and do not spend provider
   tokens.
4. Missing or changed resources run live.
5. Failed/in-flight attempts are not treated as durable work; they rerun unless
   the author explicitly inspects and pins a failed artifact.

This supports the desired edit loop:

1. Write a workflow with only `wf.agentRun("ws1-build", ...)`.
2. Run it; the builder completes and becomes `ws1-build@abc123`.
3. Edit the workflow to add reviewers that reference `ws1-build` output and the
   actual review surface, preferably a Git commit/range.
4. Run it again; `ws1-build@abc123` is reused, reviewers run live.
5. Edit the builder prompt; `ws1-build@def456` is created and downstream
   resources depending on it naturally create new revisions.

Honest tier for v1: **durable completed-agent-run ledger, retryable live
attempts**. No time-travel, no hot reload, no provider-session resurrection.
Those are future features over the same ledger, not prerequisites.

## Session and fork semantics

Provider sessions are valuable but immutable after completion. A completed
AgentRun may be used in three ways:

- `useRun` — read its typed output and metadata.
- `forkRun(..., forkMode: "seed")` — portable default: include source output and
  optional transcript excerpts as context for a new provider session.
- `forkRun(..., forkMode: "provider-copy")` — use native copy/fork session APIs
  when an adapter proves they are immutable and parallel-safe.

Mutating continuation (`forkMode: "continue"`) is not the default. It requires
an adapter capability, an exclusive lock on the source session, and fails closed
under parallel fanout. If a harness crashes mid-session, v1 records the failed
attempt and reruns that AgentRun revision; it does not over-invest in recovering
ambiguous in-flight provider state.

## Effect runtime requirements

- Single Effect version across prism-core / prism-workflow / runner. The
  current tree has 3.21.1 + 3.21.3 + a 4.0.0-beta via `@opencode-ai/plugin` —
  **dedupe is WS0, before the runtime package exists.** Service identity bugs
  from dual Effect graphs would be misattributed to the new runtime.
- `Layer`-provided fakes for every service: `FakeWorkerGateway` (canned
  responses) makes workflow tests free and CI-runnable with zero provider
  calls. This is the `--fake` lane the reference projects both needed.

## CLI surface (JSON-first, agent-native)

```
prism workflow run <file|name> [--input @file.json] [--detach]
prism workflow validate <file>            # debug/preflight lane; run performs required checks too
prism workflow status <workflowRunId> | list | wait <workflowRunId> [--timeout]
prism workflow events <workflowRunId> [--follow]
prism workflow approve <workflowRunId> <approvalId> [--deny] [--by <who>]
prism workflow stop <workflowRunId>

prism workflow runs list
prism workflow agent-runs list [--key <stableKey>]
prism workflow agent-runs show <stableKey|agentRunId> [--revision <hash>]
prism workflow agent-runs output <stableKey|agentRunId> [--revision <hash>]
prism workflow agent-runs transcript <stableKey|agentRunId> [--revision <hash>]
prism workflow agent-runs refs <stableKey|agentRunId>
```

Every command returns the `{ok, command, data|error}` envelope
(background-tasks convention). `validate` is the cheap pre-flight agents run
after authoring: it executes the module under a gate-only runtime where every
`wf.agentRun` resolves generated refs, manifest state, policy, and resource key
shape without provider dispatch. Tasks whose construction depends on prior live
outputs validate as far as reachable; that is a documented limitation of the
imperative model.

The CLI is the primary product client. A Prism plugin can expose MCP tools that
shell to the CLI, but MCP is not part of the runtime's core architecture.
