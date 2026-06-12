# 08 — AgentRun Ledger and Replay Spec

This document is normative for WS2. The previous docs describe the product
shape; this one defines the invariants an implementation swarm must not invent
differently.

## Product invariant

An AgentRun is a durable fact of completed local agent labor:

```text
stable key + semantic fingerprint + decoded output + transcript/artifacts + provenance + lineage
```

It is **not** proof that the current workspace or external world is still the
same. Reuse is safe only for the AgentRun record itself. If downstream work
needs code, data, web pages, generated files, or prior reviews, it must depend on
explicit refs to those surfaces. Git commits/ranges are the preferred truth
carrier for code because Git can make the reviewed world stable and shareable
across sandboxes.

## Stable key and immutable revision

Each `wf.agentRun(key, agent, spec)` resolves to one of two outcomes:

1. Existing completed AgentRun with `(scope_key, key, semantic_hash)` exists →
   load and re-decode output with the caller's schema.
2. No completed match exists → reserve one AgentRun revision, run one or more
   attempts under that revision according to retry policy, decode output, then
   mark completed. Retries never create sibling revisions for the same semantic
   hash.

The stable key is human-readable and local to a workflow scope. The scope is a
caller-chosen namespace, not necessarily one Git repository. A Hermes profile may
run a workflow that spans several repos; that mission should choose one explicit
scope key rather than inheriting a repo identity by accident. The semantic hash is a
canonical hash over the execution-relevant inputs. A changed semantic input
creates a new immutable revision under the same stable key.

The ledger location follows the scope, not the current working directory. A
multi-repo scope must resolve to one SQLite database path before the first run;
otherwise the same `scope_key` launched from two repo roots would create two
independent histories. V1 may default to `<workspace>/.prism/workflows/` for
single-repo scopes, but the `scope_key -> ledger_path` resolver is an explicit
runtime service.

## Semantic fingerprint v1

Hash algorithm: `sha256(canonicalJson(FingerprintV1))`.

Canonical JSON rules:

- UTF-8 JSON.
- Object keys sorted lexicographically at every level.
- No undefined values.
- Paths normalized relative to workspace root where possible.
- Newlines normalized to `\n`.
- Schema hashes derived from canonical JSON Schema or another deterministic
  Effect Schema export, never from object identity.
- Prompt, schema, `needs`, and refs all hash through named canonical helpers
  with golden test vectors. Do not let individual implementers choose their own
  stringification.

Shape:

```typescript
interface FingerprintV1 {
  readonly version: 1;
  readonly scopeKey: string;
  readonly stableKey: string;
  readonly agent: {
    readonly class: "attested" | "declared";
    readonly refHash?: string;        // class A generated ref hash
    readonly manifestHash?: string;   // class A composed policy hash
    readonly descriptorHash?: string; // class B descriptor/profile hash
  };
  readonly harness: {
    readonly id: string;
    readonly model?: string;
    readonly effort?: string;
    readonly capabilityMode: string;
  };
  readonly prompt: {
    readonly textHash: string;
    readonly templateHash?: string;
    readonly argsHash?: string;
  };
  readonly outputSchemaHash: string;
  readonly needsHash: string;
  readonly cwd?: string;              // advisory execution location, not truth
  readonly refs: ReadonlyArray<AgentRunInputRef>;
  readonly sessionLineage?: SessionLineageRef;
  readonly forkMode: "seed" | "provider-copy" | "continue" | "none";
}

type AgentRunInputRef =
  | { readonly kind: "agent-run-output"; readonly stableKey: string; readonly agentRunId: string; readonly semanticHash: string; readonly outputHash: string }
  | { readonly kind: "git-commit"; readonly repo: string; readonly commit: string; readonly remote?: string }
  | { readonly kind: "git-range"; readonly repo: string; readonly base: string; readonly head: string; readonly diffHash: string; readonly remote?: string }
  | { readonly kind: "dirty-worktree"; readonly repo: string; readonly base: string; readonly statusHash: string; readonly diffHash: string }
  | { readonly kind: "file-set"; readonly root: string; readonly paths: ReadonlyArray<string>; readonly contentHash: string }
  | { readonly kind: "artifact"; readonly artifactId: string; readonly sha256: string }
  | { readonly kind: "external"; readonly url: string; readonly capturedAt: string; readonly contentHash?: string };

interface SessionLineageRef {
  readonly sourceAgentRunId: string;
  readonly mode: "seed" | "provider-copy" | "continue";
  readonly providerSessionId?: string;
}
```

Ref rules:

- The runtime does not infer broad truth from `cwd`.
- If a run needs to be cache-invalidated by repo state, the workflow provides a
  Git or file-set ref.
- Dirty worktree refs are allowed for local-first workflows, but committed Git
  refs/ranges are preferred for scalable review across sandboxes.
- Dirty worktree refs are weak refs. Their hash must include untracked files when
  requested, file mode changes when relevant, and line-ending normalization rules;
  otherwise the CLI labels them as local/weak evidence.
- Downstream reviews depend on evidence refs, not session family relationships.
- Session lineage is only for provider/session continuation mechanics.
- `forkRun` with `forkMode: "seed"` or `"provider-copy"` still records pinned
  refs for any source output, transcript excerpt, or artifact content injected
  into the new prompt. Lineage records provider mechanics; refs record data
  dependency.

## Output grounding

Decoding proves shape, not truth. Store and display the grounding lane:

```typescript
type OutputGrounding =
  | "native-schema"
  | "prompted-json"
  | "extracted-json"
  | "human-approved";
```

Every `agent-runs show` response includes `outputGrounding`. The runtime never
silently upgrades extracted JSON into stronger truth.

## SQLite schema v1 sketch

The exact SQL can evolve, but these tables and constraints are mandatory.

```sql
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  workflow_file TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','waiting','completed','failed','crashed','cancelled')),
  runner_pid INTEGER,
  runner_start_token TEXT,
  heartbeat_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','running','completed','failed','crashed','cancelled')),
  attestation TEXT NOT NULL CHECK(attestation IN ('attested','declared')),
  output_schema_hash TEXT NOT NULL,
  output_grounding TEXT,
  provenance_json TEXT NOT NULL,
  created_by_workflow_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(scope_key, stable_key, semantic_hash),
  FOREIGN KEY(created_by_workflow_run_id) REFERENCES workflow_runs(id)
);

CREATE TABLE agent_run_attempts (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','killed')),
  worker_target TEXT NOT NULL,
  request_json TEXT NOT NULL,
  transcript_ref TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(agent_run_id, attempt)
);

CREATE TABLE agent_run_outputs (
  agent_run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
  output_json TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  output_schema_hash TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE agent_run_refs (
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  ref_kind TEXT NOT NULL,
  ref_json TEXT NOT NULL,
  ref_hash TEXT NOT NULL,
  PRIMARY KEY(agent_run_id, ref_hash)
);

CREATE TABLE agent_run_session_lineage (
  agent_run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
  source_agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  mode TEXT NOT NULL CHECK(mode IN ('seed','provider-copy','continue')),
  provider_session_id TEXT
);

CREATE TABLE workflow_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id TEXT NOT NULL,
  agent_run_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY(agent_run_id) REFERENCES agent_runs(id)
);

CREATE TABLE agent_run_locks (
  lock_key TEXT PRIMARY KEY,
  locked_by_workflow_run_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_agent_runs_scope_key ON agent_runs(scope_key, stable_key, status);
CREATE INDEX idx_agent_attempts_run ON agent_run_attempts(agent_run_id, status);
CREATE INDEX idx_events_workflow_seq ON workflow_events(workflow_run_id, seq);
CREATE INDEX idx_refs_hash ON agent_run_refs(ref_hash);
```

Completed invariant:

```text
agent_runs.status = completed
=> exists agent_run_outputs row
=> output_schema_hash matches
=> output_json decodes under that schema hash at write time
```

## Transaction algorithm for `agentRun`

SQLite settings:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

`SQLITE_BUSY` is retryable with bounded exponential backoff. Long provider work
never happens inside a database transaction; transactions reserve or complete
rows and then release the lock.

Algorithm:

1. Compute `semantic_hash` before touching the worker.
2. `BEGIN IMMEDIATE`.
3. Query completed `(scope_key, stable_key, semantic_hash)`.
4. If found, commit and return the existing resource after schema re-decode.
5. If absent, insert `agent_runs(status='reserved')` under the unique constraint.
6. If unique violation occurs, another process won the race: commit/rollback,
   wait for that row to complete or fail, then load or retry according to status.
7. Commit reservation before spawning provider subprocess.
8. Insert attempt row; dispatch worker.
9. On output: decode; in one transaction insert output, refs/session lineage,
   completion event, and mark `completed`.
10. On decode/spawn/error: mark attempt and AgentRun failed/crashed; never insert
    a completed output row.

This prevents duplicate provider spend when two fibers or processes ask for the
same resource concurrently.

## Reuse path vs live path

Reuse still runs checks, but not the same checks:

| Check | Reuse | Live dispatch |
|---|---:|---:|
| Stable key exists | yes | n/a |
| Semantic hash match | yes | computed |
| Output schema re-decode | yes | yes before store |
| Evidence/world refs display | yes | yes |
| Current install attestation | warning/refuse by mode | yes, required for class A |
| Policy subsumption | compare stored needs + current requested needs | yes |
| Budget spend | no provider spend; count as reused work | yes |
| Capability check | only if using provider session/fork | yes |

Resource reuse must never be presented as “current verification.” It is “this
past agent labor matches the declared semantic inputs.”

## Artifacts, refs, and side effects

An AgentRun output can refer to files, patches, images, transcripts, Git ranges,
or external captures. The ledger stores descriptors with content hashes, but the
workflow runtime does not own restoration of the world. Git, artifact stores, and
explicit tools carry that responsibility.

```typescript
interface AgentRunArtifact {
  readonly kind: "file" | "patch" | "transcript" | "media" | "external";
  readonly path?: string;       // project-relative when local
  readonly sha256?: string;
  readonly casRef?: string;
  readonly mimeType?: string;
}
```

When a downstream AgentRun depends on an artifact or world ref, that ref's hash
participates in the downstream semantic fingerprint. If the ref cannot be
resolved, the downstream run fails with a typed missing-ref error or the author
chooses a new ref. Reusing an AgentRun never silently restores files or patches.

## Fork semantics

Evidence refs are pinned by exact version/hash. A downstream AgentRun never
implicitly follows another run's new `@latest` revision. If the author wants to
review a newer build or a newer Git range, the workflow must resolve a new ref
and materialize a distinct semantic hash.

Session fork/continue is separate from evidence dependency. `forkMode:
"continue"` is mutating and requires a cross-process lock on the
provider session id. Parallel continue from one source session is a terminal
capability error unless the adapter proves provider-copy semantics.

## Crash and orphan recovery

Workflow runners heartbeat. On startup, the runtime scans `running` workflow runs
and AgentRuns. Dead PID plus stale `runner_start_token` or expired heartbeat
marks live attempts `crashed`; PID alone is not enough because operating systems
reuse process ids. Orphan recovery also deletes expired `agent_run_locks` owned
by crashed runs. Completed AgentRuns remain valid; crashed/in-flight attempts are
not durable and may rerun.

## Mandatory fake-worker tests before real adapters

1. Same fingerprint twice → second run makes zero worker calls.
2. Same key, prompt changed → new revision; history lists both.
3. Workflow v1 builds; workflow v2 adds reviewers → builder reused.
4. Evidence refs pinned → downstream run does not drift when an upstream
   AgentRun `@latest` changes.
5. Parallel duplicate key/spec → one reservation, one worker call.
6. Decode failure → no completed output row.
7. Schema change on `useRun` → re-decode failure is surfaced.
8. Git range/file-set ref changes → downstream semantic hash changes.
9. Missing evidence/artifact ref for downstream run → typed error; no implicit
   restoration.
10. Crash mid-attempt → status reclaimed; no false completion.
11. Duplicate scope launched from two repo roots → resolves to one ledger path or
    fails before dispatch.
12. Dangling continue lock after crash → orphan recovery deletes the lock.
13. Concurrent reservation under SQLite lock pressure → bounded retry, one worker
    call.
