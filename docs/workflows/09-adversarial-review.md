# 09 — Adversarial Review Synthesis

This records the pre-implementation adversarial panel run through Grok Build,
Grok Composer 2.5, and Antigravity/Gemini Flash on 2026-06-12. Raw outputs were
captured in `/tmp/prism-workflow-adversarial-*.out` during the session.

## Review setup

Reviewers were asked to attack the plan in `00`–`07` under these assumptions:

- Core product is TypeScript library + CLI.
- MCP/plugin is only a client wrapper.
- Durable unit is AgentRun resource in SQLite.
- Stable key + semantic fingerprint produce immutable revisions.
- Workflow facade centers `wf.agentRun`, `wf.useRun`, and `wf.forkRun`.
- The plan may be handed to an agent swarm for implementation.

Grok completed cleanly. AGY/Gemini produced substantive review output but did
not terminate cleanly in print mode; it emitted repeated “Standing by” text until
timeout. Treat AGY as usable with external timeout and output-file capture until
the CLI lifecycle is understood.

## Findings that changed the plan

### 1. Semantic fingerprint was underspecified

Risk: different implementers hash different things, producing incompatible
reuse, duplicate provider spend, or stale reuse.

Resolution: `08-agentrun-ledger-spec.md` defines `FingerprintV1`, canonical JSON
rules, schema hashing, explicit refs/world refs, session-lineage separation, and
declared worker descriptor hashing.

### 2. AgentRun reuse can become a stale-world Goodhart trap

Risk: a cached builder run from yesterday can be reused after the repo changed
because prompt/agent/schema stayed constant. The workflow appears fast and typed
while answering the wrong world.

Resolution: fingerprint includes explicit refs when the run depends on code,
artifacts, external captures, or prior AgentRuns. CLI output must show reuse as
past labor, not current verification. Git commits/ranges are preferred for
reviewable code surfaces; dirty-worktree refs remain possible for local-first
flows.

### 3. SQLite had to be the linearizable resource boundary, not just storage

Risk: parallel fibers or separate workflow processes can dispatch the same key at
the same time unless reservation is transactional.

Resolution: WS2 requires `BEGIN IMMEDIATE`, WAL, unique
`(scope_key, stable_key, semantic_hash)`, reserved rows before spawn, and
winner-load behavior on uniqueness races.

### 4. Reuse path vs live-dispatch path needed a gate matrix

Risk: reuse can bypass policy, schema, or drift checks; or conversely require
live install attestation unnecessarily and make reuse fragile.

Resolution: `08` defines which checks run on reuse vs live dispatch. Reuse always
re-decodes and surfaces refs/grounding; live dispatch requires
attestation/policy/capability.

### 5. Prompted structured output can create false structured truth

Risk: Schema decode proves shape, not grounding. Extracted JSON can look official
while being model-confabulated.

Resolution: ledger records `outputGrounding` (`native-schema`, `prompted-json`,
`extracted-json`, `human-approved`) and CLI surfaces it.

### 6. Side-effecting AgentRuns need refs, not restoration

Risk: cached output says “build completed,” but the code or files being reviewed
live in Git/worktrees/artifact stores, not inside workflow state.

Resolution: downstream runs depend on explicit refs to Git ranges, AgentRun
outputs, artifacts, or external captures. Workflow reuse never silently restores
files or patches.

### 7. Adapter lifecycle is a tar pit

Risk: headless CLIs can hang on auth prompts, tool approvals, idle “standing by”
loops, global config DB locks, orphan grandchildren, or unclear session ids.

Resolution: no real adapter enters WS2 until fake-worker ledger tests pass. Every
adapter later needs smoke fixtures for headless completion, auth prompt
detection, process-group cleanup, timeout/cancellation, global config locking,
and session id/fork semantics.

### 8. Class B/Hermes can erode honesty

Risk: product narrative says “typed handoffs,” readers infer Prism-controlled
permissions. Hermes profiles are declared workers with unknown runtime grants.

Resolution: class B stores `attestation: declared`, descriptor hash, and explicit
warnings/opt-ins under safety policies.

### 9. Agent-authored workflow execution is trusted local code

Risk: arbitrary TS is trusted local code. Pretending a hash-bound approval gate
solves that would add ceremony without meaningful protection.

Resolution: CLI and MCP wrappers are clients over the same trusted local runtime.
Safety comes from the `wf.*` gate around agentic effects, clear user intent, and
reviewable workflow source, not from a fake approval ritual.

### 10. POC could mislead a swarm

Risk: the POC validates typed refs and decode boundaries, not the durable ledger.
A swarm could copy the POC and produce a better dispatcher instead of the
resource system.

Resolution: document POC scope explicitly before implementation.

## POC facts and artifact disposition

Canonical POC facts, proof commands, artifact mapping, and deletion rationale
live in `13-poc-disposition.md`. Do not duplicate the proved/not-proved lists in
this adversarial review; the POC is evidence, not production scaffolding, and
its local artifacts are deleted after extraction.

### 11. Scope keys need a ledger resolver

Risk: a workflow scope can span multiple repos, but a ledger stored under the
current repo creates split history when the same scope is launched from another
root.

Resolution: scope resolution is explicit: `scope_key -> ledger_path` is a
runtime service. Single-repo scopes can default to local `.prism`; multi-repo
missions must choose one ledger path before dispatch.

### 12. Ref/world-ref hashing needs golden vectors

Risk: prompt, schema, needs, dirty-worktree, and ref hashing can diverge across
implementers while all still seem reasonable.

Resolution: add a `fingerprint-and-ref-resolution-v1` contract with canonical
helpers and golden test vectors before WS2.

### 13. Adapter/process lifecycle remains a hard gate

Risk: headless CLIs can hang after output, orphan grandchildren, or collide on
global config DBs.

Resolution: every adapter needs smoke tests for final-answer termination,
auth/prompt detection, process-group cleanup, and global config lock behavior.

## Go/no-go gates before swarm implementation

### Before WS1

- Effect version skew resolved.
- POC learnings extracted and POC deletion path documented.
- Dirty/unrelated repo changes separated from workflow work.

### Before WS2 coding beyond package scaffold

- `08-agentrun-ledger-spec.md` accepted.
- Public type catalog drafted: `AgentRun`, `AgentRunRef`, `TaskRequest`,
  `TaskResult`, `DispatchError`, `WorkflowEvent`, `WorkerCapabilities`.
- Compile manifest v1 schema drafted.
- Fingerprint/ref resolver golden vectors drafted.
- Scope-key ledger resolver contract drafted.

### Before first real adapter

- FakeWorkerGateway test suite green for all mandatory `08` tests.
- Headless adapter smoke protocol exists.
- Process-group cleanup fixture exists.
- Auth/permission prompt detection fixture exists.

### Before meta-plugin/MCP client

- CLI envelopes and MCP tool envelopes are proven isomorphic.
- Class B/Hermes honesty language is visible in validate/status output.

## Strengths confirmed by the panel

- AgentRun as durable resource is the right core unit.
- Library + CLI first, MCP wrapper second is the right package shape.
- TypeScript over generated Prism refs is a real differentiator.
- Per-dispatch gate fits imperative Effect workflows better than whole-graph IR.
- Client-side Schema decode regardless of provider-native structured output is
  correct.
- FakeWorkerGateway before real adapters is the right sequencing.
- Explicit non-goals prevent Smithers-scale hot reload/time travel/reconciler
  accretion.
