# Workflow production-readiness audit — 2026-07-21

This document is the release disposition for the workflow failures recovered
from Quasar across multiple independent Prism dogfood sessions. It is not a list
of anecdotes. Every row must end in one of four states before release:

- **verified** — a deterministic regression and the final packaged smoke pass;
- **deployed proof** — source is covered, but the installed binary or generated
  fleet surface still needs a live acceptance check;
- **contract** — the behavior is intentional, documented, and tested at its
  actual ownership boundary;
- **open** — the release remains blocked.

The 60-row source register is the raw council session
`claude:70a30f0de9b5f428d274b2f7dee7f162`. It synthesized eight independent
Quasar searches while retaining the underlying session ids and quotes. The
historical live snapshot in that session contained 82 workflow runs: 52
completed and 30 failed. That is incident evidence, not a current success-rate
claim.

## Non-negotiable interpretation

“It worked after rerunning” is a failure. Seven audited Plinth reruns used the
old `--no-cache` escape hatch; other sessions switched detach to foreground,
raised concurrency, killed orphaned workers, rebuilt Prism, or retried until a
harness finally returned evidence. Those actions diagnose defects. They are not
valid operating instructions.

The Grok incident needs especially precise language. Quasar session
`claude:64fdc6fb4359a5e04e40139dd65e05c2` records 337
`auto_compact_completed` events in each affected session. They were not 337
successful normal compactions. They were repeated ineffective recovery cycles:
median context reduction was about 2%, cycles fired roughly every 29 seconds,
and 674 of 674 cycles across the two sessions reclaimed less than 5%. The fixed
preload was about 1.4 MB / 353k tokens, including 158 full skill bodies, before
the task began; workers outlived the runner by roughly 42 minutes. The release
gate is therefore prompt-topology removal plus bounded descendants and live
canaries—not better wording around compaction.

## Required end-to-end acceptance

1. A clean-home scaffold validates and runs on its first invocation; no
   repo-local workflow file and no preliminary `git add` are required.
2. Foreground and detached runs have truthful lifecycle, liveness, progress,
   error, stop, wait, update, and resume behavior. A returned run id always
   names a recoverable run.
3. Every built-in worker preserves the exact current-invocation session id and
   planned/actual agent, harness, model, provider, variant, and resolution
   source. Repair resumes that exact session or fails before a second provider
   call.
4. Prompt, output, wall-time, no-progress, fan-out, attempt, token, cost, and
   compaction policy is bounded or fails closed when authoritative provider
   evidence is unavailable.
5. The ledger is atomic enough for concurrent observers, redacts before every
   persistence/export boundary, uses restrictive permissions, and supports
   inspect/export/delete/prune without manual SQLite deletion.
6. Multiple agents may share one checkout: read-only and explicitly disjoint
   write lanes may run in parallel; overlapping writes are dependency-ordered;
   each writer stages only its declared paths and commits atomically. Worktrees
   and blanket single-writer locks are not required.
7. Generated Grok project agents are direct native files, contain no `skills:`
   preload list, stay below the configured byte ceiling, and replace stale
   generated bundles during refresh.
8. `--no-cache` is absent from run/update/resume help, schemas, managed skills,
   and examples, and each invocation rejects it as an unknown option. A fresh
   store is the explicit isolation mechanism; cache correctness is not bypassed.

## Open release blockers at audit time

- Most adapters do not yet expose authoritative token or compaction usage.
  Host-side prompt/output/time/no-progress/fan-out containment is implemented,
  but a requested token/compaction gate must either use authoritative harness
  evidence or fail before claiming enforcement.
- Ledger governance and event/attempt transaction ordering are still being
  integrated and must pass migration, redaction, permission, export, delete,
  prune, and concurrent-observer tests.
- Grok's auth diagnostic classifier still accepts overly broad plain prose.
- Source closure is not deployed closure. The packed binary, installed
  `prism-dev`, generated workflow tools, actual Grok tree, and live harness
  canaries have not yet completed the final release-candidate matrix.
- Antigravity has extensive deterministic containment tests but retains enough
  prior intermittent live failures that repeated end-to-end canaries are a
  release gate.

## Full Quasar finding register

The status below is deliberately conservative. **Source covered** still becomes
**verified** only after the release candidate is built, packed, installed as
`prism-dev`, and exercised outside the checkout.

| # | Historical defect | Current disposition / release falsifier |
|---:|---|---|
| 1 | Grok/OpenCode schema repair lost the exact session id | Source covered by exact-continuation matrix; packaged ten-adapter repair matrix pending. |
| 2 | Detached child died before `runner.started`, leaving a zombie running row | Source covered: detach returns only after persisted readiness and captures pre-readiness crash output; packaged crash smoke pending. |
| 3 | Grok short-name dispatch plus MCP use produced exit-0 empty output | Source covered by native agent-path dispatch, unattended permission mode, error forensics, and direct Grok project lowering; live refreshed-home canary pending. |
| 4 | Codex process timeout was not enforced | Source covered by shared process supervisor and descendant-reap regressions; packaged timeout smoke pending. |
| 5 | A failed task retained a limiter slot and starved queued siblings | Source covered by limiter release/fault-isolation regression proving queued siblings continue. |
| 6 | Workflow MCP tools lacked CLI parameters and project cwd | Source and plugin covered for cwd and lifecycle/budget parity; generated tool refresh and live MCP proof pending. |
| 7 | `runs stop` left workers alive and `runs wait` disagreed with terminal state | Source covered by process-group stop, bounded wait, and terminal-state regressions. |
| 8 | Antigravity setup/spawn errors were flattened to empty output | Source covered by typed preflight/setup errors and no-retry regression; live canary pending. |
| 9 | Amp rejected the inherited `smart` fallback before dispatch | Source covered: registry default and worker validation use Amp-native `deep`/`rush`; package smoke pending. |
| 10 | Project-keyed refs lost resolvable `prism.d.ts` | Source covered by strict typecheck and per-project refs tests; installed-package proof pending. |
| 11 | Repo staging made untracked workflows fail or disappear | Contract closed: scaffold/source home is `~/.prism/workflows`; the target repo is no longer the workflow source store. First-run clean-home proof pending. |
| 12 | Shipped authoring guidance contradicted itself about workflow location and `git add` | Plugin guidance consolidated to home-root-only; two tracked repo-local production workflows retired. Generated skill refresh pending. |
| 13 | Source `defineTask` types and shipped declarations diverged | Release gate: packed declarations must validate the same fixture as source before publish. |
| 14 | Compiled binary could resolve refs/effect but not the Prism DSL declaration | Source covered; outside-checkout packed-binary typecheck is a release gate. |
| 15 | Dynamic validation misleadingly returned only `tasks: []` | Contract closed: validation marks the workflow dynamic and reports statically discoverable worker/model runnability; runtime tasks remain data-dependent. |
| 16 | One `finish.maxRepairs` budget silently controlled decode and finish repair | Source covered by independent decode/finish budgets and no-finish default decode repair regressions. |
| 17 | Docs incorrectly described Prism as `@effect/workflow` durable execution | Contract corrected: Prism owns an Effect-based DAG/runtime; it does not claim the separate package/runtime. |
| 18 | Workflow MCP refs/catalog used the daemon cwd and selected another project | Same closure as #6; generated MCP cross-project cwd proof pending. |
| 19 | Scaffold validated but lacked a runnable concrete worker/model | Source covered by installed-worker selection, registry defaults, and validate-time worker/model rows. Clean-home first-run proof pending. |
| 20 | `catalog --orbit ... --json` ignored the filter | Source covered by orbit JSON-filter regression. |
| 21 | Globally installed Prism lacked commands expected by the source checkout | Deployed proof: release version, `prism-dev`, packed binary, and production binary must report the same command surface. |
| 22 | Dev-symlink typecheck degraded to a warning because paths were not realpathed | Source covered by strict dev-binary resolution/typecheck regressions; outside-checkout proof pending. |
| 23 | Stopping a terminal run could signal a stale or reused PID | Source covered: signaling occurs only for a successful running-to-stopped transition. |
| 24 | Detached pre-readiness death had no pid, heartbeat, or self-healing path | Source covered by readiness handshake, handoff consumption, crash log, and fail-closed parent result; packaged smoke pending. |
| 25 | Detached MCP `workflow_run` returned a JSON envelope as `run_id` | Plugin covered by structured stdout parsing; generated tool proof pending. |
| 26 | MCP callers could start but not observe/recover a run | Plugin covered for list/show/summary/events/trace/wait/stop/update/resume and run controls; live generated tool proof pending. |
| 27 | Antigravity timeout/stop killed only the direct `agy` process | Source covered by process-group PTY cleanup and overflow/timeout regressions; live descendant canary pending. |
| 28 | Detach paid typecheck twice and missed the fast-return budget | Source covered by parent/child handoff lifecycle; packaged timing smoke pending. |
| 29 | Claude explicit `--allowedTools` removed built-in file/shell tools | Source covered: permissive mode preserves built-ins and restricted mode is explicit; worker-args regressions pass. |
| 30 | Grok unattended MCP prompts exited 0 with empty stdout | Source covered by unattended permission arguments, early classification, and worker forensics; live tool-call canary pending. |
| 31 | Codex inherited open stdin and waited forever for EOF | Source covered by closed stdin and timeout/process regressions. |
| 32 | Stop/abort/timeout left harness descendants alive | Source covered by process-group ownership across normal exit, timeout, early exit, overflow, stop, and update. |
| 33 | Duplicate detached-child silent-death observation | Same closure and packaged falsifier as #2/#24. |
| 34 | A fusion failure aborted the run instead of becoming evidence | Source covered by task fault isolation and partial-result/fusion regressions; authors still choose fail-fast versus `Effect.either`. |
| 35 | Grok tool config rejected a task until a full rebuild | Source topology fixed; actual project/global refresh plus clean Grok canary is required to rule out stale generated config. |
| 36 | Antigravity could report timeout/error as exit 0, orphan children, or return empty output | Source covered by sentinel, retry, PTY, setup, deadline, and process-group tests; live repeated canaries remain required. |
| 37 | Codex task timeout override did not reach the worker | Source covered by run/update/resume controls and Codex process-timeout regression. |
| 38 | Fusion output often needed a schema repair for a missing field | Contract closed: bounded decode repair is intentional and independently budgeted; exhausted repair is terminal and auditable. |
| 39 | Claude restricted tools might serialize incorrectly | Checked against the installed Claude CLI help: comma- or space-separated variadic values are accepted. Restricted-worker args remain regression-covered. |
| 40 | Transformed plugin tree cached a stale cache-busted refs URL | Source covered: each load receives a fresh transformed tree and cleanup; consecutive-load regression proves changed refs. |
| 41 | Workflow MCP cached `PRISM_BIN` candidates before environment overrides | Plugin covered by resettable runtime resolution; hermetic generated-tool proof pending. |
| 42 | `workflow_cache show` deferred required-field errors to raw CLI usage | Plugin covered by boundary validation and typed errors. |
| 43 | Default run ledger changed with the invoking subdirectory | Source covered by project-keyed Prism-home store resolution and cross-directory tests. |
| 44 | Event rows could precede durable attempt state; decode event evidence was empty | Open until schema/store integration commits atomic ordering and the decode-evidence regression passes. |
| 45 | Cache identity was workflow/task-position scoped and had no world-state model | Content-addressed cache is now cross-workflow. Contract: external state that affects output belongs in the prompt/hash via narrow stable fields; Prism does not invent hidden `world_refs`. |
| 46 | Static cache keys caused stale reuse; store deletion erased evidence; `--no-cache` caused rerun thrash | Cache identity includes prompt/agent/schema/worker semantics; authoring guidance requires stable inputs. Data governance and safe delete/export are open until integrated. `--no-cache` is removed and negatively tested. |
| 47 | Duplicate MCP cwd/project-context defect | Same closure and live generated-tool falsifier as #6/#18. |
| 48 | Duplicate MCP parameter-parity defect | Same closure and live generated-tool falsifier as #6/#26. |
| 49 | Duplicate detached MCP `run_id` envelope defect | Same closure as #25. |
| 50 | Duplicate cache-show boundary-validation defect | Same closure as #42. |
| 51 | Duplicate detached silent-death/status defect | Same closure and packaged falsifier as #2/#24. |
| 52 | Duplicate Grok unattended permission defect | Same closure and live tool-call falsifier as #30. |
| 53 | `prism-dev` crashed outside the repo because native TUI packages were externalized | Source build is covered; final release gate executes `--help`, status, and monitor/trace entrypoints outside the checkout from the packed binary. |
| 54 | Dynamic HTTP MCP ports, idle timeout, and leaked daemons made Grok unusable | Architecture migrated to bounded UDS/stdio shims with singleton/idle-reap behavior, capped logs, and closed one-shot tool sessions. Live process/socket census and tool-call proof pending. |
| 55 | Orbit phase `workflow` metadata disappeared during normalization | Source covered by compile projection/golden tests; refreshed generated skill proof pending. |
| 56 | Model type required a target for model-free Amp surfaces | Source type/capability registry corrected; full `refresh --all` and packed declaration proof pending. |
| 57 | Antigravity was unreliable end to end | Same source closure as #36; production acceptance requires repeated live success and clean descendant census, not one lucky run. |
| 58 | Grok auth regex treated reviewer prose containing “requires login” as OAuth failure | Open until the classifier requires an actual auth diagnostic and negative prose regression passes. |
| 59 | Duplicate coupled-repair budget plus loose worker-id defect | Source covered by independent budgets and the capability-derived worker literal union; source and packed typecheck both gate release. |
| 60 | Agents repeatedly created workflow files in project repos because the skill taught it | Plugin guidance and scaffold corrected; tracked repo-local production scripts retired; refreshed-fleet search must find no contrary instruction. |

## Release decision rule

No aggregate “mostly fixed” percentage can override an open blocker. The release
is ready only when every open row above is either verified or deliberately
reclassified as a tested contract, the deployed-proof rows pass on the exact
artifact to be published, the actual Grok output tree is healed, and a second
independent check confirms the evidence.
