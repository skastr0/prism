# Workflow ledger data governance

Checked: 2026-07-21

Prism workflow stores contain operational evidence: authored prompts, decoded
task outputs, task and judge metadata, failure excerpts, events, spans, run
snapshots, cache entries, and exact-continuation session identifiers. Treat a
store as sensitive local operator data.

## One redaction policy

`src/workflow-data-policy.ts` is the only workflow-ledger redaction policy.
Every durable run, task, attempt, event, span, snapshot, and export passes
through it before serialization. The policy:

- replaces values under credential-bearing keys such as `authorization`,
  `apiKey`, `accessToken`, `refreshToken`, `password`, `clientSecret`, private
  keys, cookies, and detached handoff tokens;
- removes common bearer, provider-token, credential-assignment, private-key,
  and URL-password forms embedded in free text and dynamic object keys;
- never persists a raw detached handoff token: only its SHA-256 digest is
  stored;
- deliberately preserves `sessionId`, `externalSessionPointer`,
  `conversationId`, and `threadId`, plus execution provenance. Those opaque
  identifiers are required to prove and perform exact same-session
  continuation and are not authentication credentials;
- does not mutate cache values. If a completed task or judge cache candidate
  contains sensitive data, Prism skips that cache write and records a
  content-free `*.cache_write.skipped_sensitive` event. The live task result is
  unchanged; only replay is disabled for that result.

Finding reports contain paths and reason classes only. They never repeat the
secret value.

The same policy runs again at the export edge, including OTLP span export. That
defense is intentional: it protects exports from stores created by an older
Prism version as well as current writes.

Prism does not ingest provider-owned full conversation transcripts. It keeps
the exact session pointer and bounded worker failure excerpts. Provider-side
transcript retention remains the provider harness's responsibility. The
Prism-owned detached runner log is governed as a run sidecar. It is a bounded
crash channel, not part of the structured ledger: while a detached child is
running its stdout/stderr can exist as raw owner-only (`0600`) text. Normal
child shutdown redacts it in place. A `SIGKILL` can bypass that finalizer, so
every subsequent store open terminalizes dead runner PIDs and redacts every
exact terminal sidecar before the observer reads the store; live logs are not
rewritten under their writer. Export applies redaction again. This is an
explicit raw-capture window; Prism does not claim pre-persistence redaction for
the active sidecar.

## Retention

The production default is **30 days** for every Prism-owned workflow record:

| data | cutoff | cleanup behavior |
|---|---|---|
| terminal runs | terminal/creation time | deletes run, tasks, attempts, events, spans, snapshots, prompts, outputs, and runner-log sidecar |
| running runs | never automatic | must become terminal before age pruning |
| terminal run with a live runner PID | deferred | waits for process reaping so cleanup never rewrites or unlinks a live sidecar |
| completed task cache | last update | deletes the content-addressed cache row |
| judge cache | last update | deletes the judge cache row |

Opening a store applies the bounded default cleanup. `prism workflow runs
prune` runs the same operation explicitly and reports exact row and sidecar
counts. Repeating cleanup is safe: already-removed rows and sidecars report
zero/missing and no unrelated path is traversed or recursively removed.

Run-row deletion queues the exact sidecar id in the same SQLite transaction.
After commit Prism removes the file and clears the queue; every later store
open drains any queue entry left by a crash. Ledger rows are rechecked and
committed before their sidecar is touched, so a concurrent cleanup cannot
delete the log for a preserved run.

Export evidence before the cutoff when a run must be retained longer.

## Operator commands

```bash
# Inventory one run and its governed record/sidecar counts
prism workflow runs inspect <run-id> [--store <path>]

# Export one redacted evidence envelope to stdout or an owner-only file
prism workflow runs export <run-id> [--store <path>] [--out <path>]

# Delete one terminal run and its detached runner-log sidecar
prism workflow runs delete <run-id> [--store <path>]

# Prune terminal runs and caches older than an explicit age (default: 30d)
prism workflow runs prune [--store <path>] [--older-than 30d]
```

Deleting a running run, or a terminal row whose runner PID is still alive,
fails closed. Stop it first, wait for runner shutdown, verify the terminal state,
then delete it. Deleting a run does not delete the shared content-addressed task
or judge caches because another run may reference the same semantic result;
age pruning owns cache lifecycle.

## Local access boundary

- SQLite database, WAL, and SHM files: mode `0600`.
- Detached runner-log files and exported evidence files: mode `0600`.
- Prism-created workflow and runner-log directories: mode `0700`.
- An explicit custom `--store` file is secured, but Prism does not change the
  permissions of a pre-existing user-owned parent directory.

Prism removes only rows belonging to the exact run id and the deterministic
`runner-logs/<run-id>.log` sibling. Run ids containing path separators or
traversal segments cannot address a sidecar. Cleanup never recursively removes
the store directory, registry, another store, or an unrelated user file.
