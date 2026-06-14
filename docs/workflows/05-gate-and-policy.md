# 05 — Gate, Policy, Budgets, Approvals

The product promise in one sentence: **no provider token is spent past an
unverified ref, and no completed agent labor is stored without typed provenance.**
This document is that promise, mechanized.

## The validation stack (in execution order)

| # | Layer | When | Catches | Cost |
|---|---|---|---|---|
| 0 | TypeScript over generated refs | author time | unknown agents, mistyped handoffs, wrong schemas | free (`tsc`) |
| 1 | `defineWorkflow` input decode | run start | malformed input | free |
| 2 | **Resource lookup** | per `agentRun` / `useRun` / `forkRun` | existing completed AgentRun with same stable key + semantic fingerprint | SQLite lookup |
| 3 | **Provenance** | before live dispatch or reuse | generated ref's `sourceHash`/`manifestHash` ≠ current compile state (stale refs, tampered source) | hash compare |
| 4 | **Attestation** | before live dispatch (class A) | agent not actually installed in the target harness root | file stat + snapshot check |
| 5 | **Policy subsumption** | before live dispatch | AgentRun requesting capabilities beyond the agent's composed grants | manifest lookup |
| 6 | **Budget** | before dispatch + during run | token/cost/fanout ceilings | counter check |
| 7 | Capability check | before dispatch | options the adapter can't honestly provide | matrix lookup |
| 8 | Output decode | before storing completed resource | schema-violating agent output | Schema.decodeUnknown |

Layers 3–7 are the **live-dispatch gate**; they run inside `wf.agentRun` before
the gateway is touched. Layer 2 is the ledger fast path. Layer 8 is the storage
gate: invalid output can be observed as a failed attempt, but it never becomes a
completed AgentRun resource. Every pass/fail is a ledger event with the check
vector.

POC status: layers 2, 3, 7 implemented and live-verified (tampered ref →
`RefDriftError` before dispatch). Layers 4–6 are WS2, dependent on the compile
manifest (01).

## Policy subsumption (layer 5)

The task declares what it needs; the manifest knows what the agent has:

```typescript
yield* wf.agentRun("build", agents.builder, {
  harness: "claude-code",
  needs: { write: true, network: false, tools: ["run_shell"] },
  ...
});
```

Check: `needs ⊆ manifest.agents["demo:builder"].composed.grants` for the
target harness. A reviewer agent asked to write, or a task requesting a tool
outside the agent's toolspace grants, fails with `PolicyViolation` naming the
missing grant and the trait that would provide it.

`needs` is optional only for no-extra-capability tasks. Omitted normalizes to the
minimal read/no-network/no-write/no-extra-tools default, and that normalized
value is what gets hashed and recorded. Any write, network, tool, worktree, or
dangerous sandbox request must be declared explicitly. Declared (`class B`)
workers skip Prism manifest subsumption — recorded, not pretended — but still
record normalized needs for budget, audit, and replay identity.

## Budgets

`BudgetService` enforces three ceilings, any of which may be set per run or per
task group:

- `maxCostUsd` (where adapters report cost — claude full, codex tokens with
  pricing table, others estimated)
- `maxTasks` / `maxFanoutItems` (runaway-loop backstop; fanout checks at
  expansion time, inside the concurrency slot — never before queueing, so a
  failed sibling's budget returns to the pool)
- `maxWallMs`

Exceeding a ceiling fails *new* live dispatches with `BudgetExceeded`; in-flight
attempts finish. Reusing an existing completed AgentRun does not spend provider
budget, but it still counts in run totals as reused work so the CLI can explain
why a workflow completed cheaply. Preflight estimation (static subgraphs ×
modelspace pricing) is a WS6 nicety; runtime metering is the v1 guarantee.

## Approvals

Two shapes, both ledgered as events, both replayable (smithers' distinction, kept):

- **Gate**: `approval: true` on a task — run pauses before dispatch,
  `approval_requested` recorded, runner waits (foreground: inline prompt;
  detached: `prism-workflow approve <runId> <id>` / MCP tool / notification
  hook). Deny policies: `fail` | `skip-task` | `continue`.
- **Decision node**: `wf.approve(id, payload)` — produces a typed
  `ApprovalDecision` the program branches on. This is data, not ceremony.

Approval state lives in the ledger — a detached run crashed while waiting
resumes still-waiting.

Agent-authored workflow execution is trusted local code. The MCP/plugin client is
not a sandbox or approval authority; it is only another client over the CLI. Do
not add fake hash-bound approval rituals here. Safety comes from reviewable
workflow source plus the `wf.*` gate around agentic effects.

## Containment posture (honest)

The workflow module is **trusted local code** in v1 — same trust level as any
script the user runs with bun. We do not sandbox the orchestrator (no node:vm —
meaningless for an Effect program that needs service implementations; no
subprocess isolation in v1).

What is actually contained:

- every *agentic* capability flows through `wf.*` → gate → gateway;
- worker subprocesses run under each harness's own sandbox/permission model,
  which prism configured at install time (that's the point);
- write-access AgentRuns get worktree isolation (`wf.worktree`), keep-on-failure;
- completed resources are immutable; forked runs never mutate source
  sessions by default.

What is not: raw `fs`/network from workflow TS itself. Single-user dev phase
accepts this; the seam for hardening later is running the runner under an OS
sandbox profile with only the ledger dir + worker binaries exposed — noted,
not built. Authoring agents writing workflows is the realistic threat model,
and their output is reviewable text in the project tree, gated by the same
review flow as any code.

## Drift windows (named, bounded, not hidden)

- **Attestation ≠ behavior**: the snapshot proves prism-managed files are
  installed unmodified; it cannot prove the harness will behave as compiled
  (user settings, harness version, other plugins). Scope every claim
  accordingly.
- **TOCTOU**: source can change between gate and dispatch. Accepted for v1
  (single user); the ledger records the verified hashes, so post-hoc audit is
  exact.
- **Codex/agy projection**: identity is injected per call rather than resident
  in the harness — attestation covers the artifact the projection was read
  from; the projection string itself is stored in request.json for audit.
- **Resource reuse ≠ proof of current world**: a reused AgentRun proves what a
  prior agent did under its recorded provenance. It does not prove the repository
  or external world is unchanged today unless the workflow includes those facts
  in the semantic fingerprint or performs a fresh verification run.
