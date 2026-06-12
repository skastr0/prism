# Prism Workflows — Vision and Decided Shape

Status: planned (POC validated 2026-06-11, preserved in `13-poc-disposition.md`)
Origin: Forge signal `sig_905c410397ec224978b18721` + three-session architecture discussion.

## What this is

A typed, Effect-powered workflow system where the workflow program, the agents it
dispatches, the permissions those agents hold, and the models they run on are all
**one type system**, owned end to end by Prism.

More precisely: Prism Workflows is a **durable agent-run resource ledger** with a
typed orchestration language on top. The workflow file is not the durable unit of
value. The durable unit of value is the completed agent run: its stable key,
immutable semantic revision, typed output, transcript, provider session metadata,
provenance, usage, refs, session lineage, and artifacts. Workflows are programs
that create, reference, and compose those resources.

```typescript
const exploration = yield* wf.agentRun("explore", agents.explorer, {
  harness: "grok",
  prompt: `Goal: ${goal} ...`,
  output: Exploration,           // Effect Schema; decoded before the value crosses phases
});
```

A workflow author (human or agent) gets:

- **Author-time**: `tsc` rejects unknown agents, mistyped phase handoffs, wrong
  schemas. Generated refs are literal-typed deep enough that compiler errors
  document the fleet ("Did you mean 'simplicityReviewer'?" plus the agent's
  description in the error).
- **Pre-dispatch**: a gate proves the ref's provenance (source hash vs registry),
  install attestation (artifact present in the target harness root), and policy
  subsumption (requested access ⊆ the agent's compiled grants) before a single
  provider token is spent.
- **Runtime**: every agent result is Schema-decoded at the boundary. Every
  completed agent run is stored in a SQLite ledger as an immutable resource keyed
  by explicit stable id plus semantic fingerprint; event logs/transcripts are
  supporting artifacts, not the source of truth.
- **After runtime**: every completed agent run becomes an addressable local
  resource. Another workflow, another harness session, or another human can later
  reference `agent-run://.../ws1-build@sha256:...`, inspect its transcript,
  reuse its typed output, or fork new sessions from it without rerunning the
  original work.

## The core product: AgentRun resources

The central type is not `TaskResult`. It is `AgentRun<A>`:

```typescript
interface AgentRun<A> {
  readonly ref: AgentRunRef;          // stable local address
  readonly output: A;                 // Schema-decoded value
  readonly transcript: TranscriptRef; // full harness transcript / stream artifact
  readonly session: SessionRef;       // provider/harness session metadata
  readonly provenance: Provenance;    // agent ref, manifest hash, prompt hash, schema hash
  readonly usage: Usage;              // tokens/cost/duration when available
}
```

The stable key is human-chosen and scope-local:

```typescript
const build = yield* wf.agentRun("ws1-build", agents.builder, {
  harness: "claude-code",
  prompt,
  output: PatchReport,
});
```

The key behaves like an infrastructure-as-code resource name. If a matching
resource revision already exists, the runtime returns it. If the semantic inputs
change — agent ref, prompt, output schema, harness, model/effort, cwd/worktree,
permission needs, evidence refs, or session seed — the runtime creates a new
immutable revision.
The stable name remains useful while exact revisions stay auditable:

```text
agent-run://<scope>/ws1-build@latest
agent-run://<scope>/ws1-build@sha256:abc123...
```

This is why "cache" is an implementation detail, not the product language. The
ledger records durable facts of local agent labor. The typed output is one
projection of the resource; the transcript, refs, and provenance are equally
important.

## Workflows as resource programs

Workflow source is intentionally ephemeral and rewriteable. A human or agent can
write a small workflow, run one important builder, inspect the result, then edit
the workflow to add reviewers, synthesis, or fix loops. The original builder run
does not disappear into a chat context; it remains addressable in the project
ledger and can be reused by stable key or exact revision.

Example evolution:

1. `missions/ws1.workflow.ts` creates `ws1-build`.
2. The builder completes; `ws1-build@abc123` is stored with output and transcript.
3. The workflow is edited to add `ws1-review-simplicity` and
   `ws1-review-reliability`, both seeded from `ws1-build`.
4. Re-running the workflow returns `ws1-build@abc123` from the ledger and only
   dispatches the new reviewers.
5. If the builder prompt changes, `ws1-build@def456` is created; downstream
   prompts that reference the new output or Git range naturally create new
   resources.

The runtime is therefore not merely a synchronous script runner. It is a local,
typed, replayable resource materializer for agent sessions.

## Why Prism wins this category

Smithers and omegacode (studied as references — see provenance below) treat agent
identity as an inline option bag: model strings, instruction strings, tool-name
allowlists passed per call. Neither can verify "this task's access is within this
agent's grants" because neither owns the agent definition.

Prism owns both sides of the contract:

- agents/traits/tools/modelspaces are **compiled artifacts** with content hashes
- they are **installed into the harnesses themselves** (`.claude/plugins/...`,
  `.grok/plugins/...`, `.codex/agents/...`) and snapshot-attested
- the workflow ref and the harness runtime artifact are **the same compiled
  object**, verified by hash at both ends

Identity lives in the install, not the invocation. Dispatch becomes thin:
`{harness, installed agent ref, prompt, output schema, cwd}`.

Additional moats no reference tool has:

- **Model intelligence**: tasks reference modelspace profiles; Prism resolves
  per-harness model ids, effort, and capability honesty.
- **Orbit-compiled workflows** (later): orbits already declare phases and agents
  in the Prism DSL; the same source can compile to a typed workflow skeleton —
  `orbits.forge.mission(goal)`.

## Decided architecture (settled in discussion, validated by POC)

1. **Authoring model**: arbitrary Effect TypeScript over typed runtime
   primitives — NOT a constrained static IR, NOT smithers-style JSX
   reconciliation. The declarative form (if ever wanted) compiles TO the
   imperative form, not beside it.
2. **Validation model**: per-dispatch gate replaces whole-graph preflight.
   Cycles are a non-issue (control flow is the program); fanout is bounded by
   budget + semaphore; cost preflight is estimated for static subgraphs and
   metered with hard ceilings for the rest.
3. **Resource identity model**: every agent run has a stable, human-chosen key
   and an immutable semantic revision hash. Re-running workflow code reuses
   matching resources across workflow runs and across workflow files.
4. **Session immutability model**: completed sessions are immutable. Continuing a
   conversation means creating a new run seeded or provider-forked from the
   source session, never mutating the source by default. Mutating resume is an explicit,
   exclusive-lock adapter capability.
5. **Determinism model**: deterministic resource keys matter more than replaying
   every JavaScript expression. Effect `Clock`/`Random` remain injectable when
   workflow code needs them, but the durable guarantee is: same resource key +
   same semantic fingerprint returns the same completed AgentRun.
6. **AgentRun identity**: explicit ids/keys, declared at the call site — never
   inferred from call structure (omegacode's hardest bug was inferred journal
   keys under parallelism).
7. **Ownership**: built native. Reference projects contribute solved-problem
   patterns and inspiration only; no code, types, or product contracts are
   reused from them.

## Worker classes (Hermes decision)

Two classes of dispatch target, honestly distinguished:

- **Class A — attested workers**: prism-compiled agents installed into coding
  harnesses (Claude Code, Grok CLI, Codex, Antigravity). Full gate: provenance +
  attestation + policy subsumption.
- **Class B — declared workers**: runtime-registered endpoints that Prism does
  not compile — Hermes profiles foremost. The workflow side stays fully typed
  (typed I/O schemas, ledger events, budget, retries), but provenance is recorded
  as `declared`, not `attested`. No Hermes→Prism type-generation bridge is built.

This unlocks Hermes-orchestrating-Hermes: a workflow dispatching multiple Hermes
profile sessions headlessly (`hermes -z`), optionally driven BY a Hermes agent
through the workflows MCP tools — a capability that does not exist today.

## Non-goals (accretion guard — every one of these will look reasonable later)

- No context management, session UI, or memory layer — harnesses harness.
- No prompt optimization / eval-driven self-improvement (smithers' GEPA lane).
- No built-in workflow catalog beyond examples.
- No replacement of Prism's compile/install pipeline; workflows consume it.
- No Tower/board identifiers in any source, schema, runtime field, or fixture.
- No remote/distributed execution in v1 — local machine only (it needs local
  harness auth and the user's filesystem).
- The `@skastr0/prism` npm CLI package stays a distribution surface, never the SDK.
- No Smithers-scale hot reload, time travel, rewind, schema migration, or web UI
  in v1. The first magic is durable, typed AgentRun resources.
- No heroic structured-output repair loop in v1. Native schema support and basic
  extract/parse/decode are enough until real failures justify more machinery.
- No mandatory provider session recovery. A failed or crashed in-flight attempt
  can rerun; completed AgentRuns are the durable boundary.

## Reference provenance (what we took, from where)

| Source | Taken | Explicitly not taken |
|---|---|---|
| omegacode (github.com/SawyerHood/omegacode) | journal/resume mental model, fail-closed capability policy, retryable-error taxonomy, two-stream observability (events + per-agent transcripts), budget-inside-semaphore | the DSL, node:vm sandboxing approach, inferred journal keys |
| smithers (smithers.sh) | explicit task ids, schema-retry-not-counting-as-task-retry, approval-as-typed-decision-node vs gate, session fork semantics, agent fallback chains | JSX/React reconciler model, AgentLike option-bag contract, harness-adjacent features |
| flare (in-house) | policy-as-orthogonal-mode concern, planned-step materialization for static subsets, artifact store patterns (later) | static-IR-only authoring, per-kind binding validators |
| background-tasks (in-house) | Effect.Service patterns, attempt-id isolation, JSON envelope CLI, PubSub + SubscriptionRef dual state, supervised detached runs | n/a (same author, patterns lift directly) |

## Document map

- `01-type-system-and-codegen.md` — refs emitter, provenance tiers, compile manifest, agent I/O contracts
- `02-authoring-dsl.md` — the facade, Effect program model, control flow, full examples
- `03-runtime-and-execution.md` — where and how workflows execute, AgentRun ledger, replay, CLI
- `04-worker-gateway.md` — adapter contract, capability matrix, per-harness adapters, structured output
- `05-gate-and-policy.md` — the validation stack, policy subsumption, budgets, approvals
- `06-distribution-meta-plugin.md` — packages, the workflows meta-plugin, agents-using-workflows
- `07-roadmap.md` — workstreams, milestones, glyph seeding
- `08-agentrun-ledger-spec.md` — normative AgentRun ledger, fingerprint, reuse, fork, and concurrency invariants
- `09-adversarial-review.md` — Grok/AGY adversarial review synthesis and go/no-go gates
- `10-public-runtime-types.md` — normative library/CLI runtime type catalog for WS2
- `11-compile-manifest-v1.md` — compile-manifest schema, writer, reader, and gate contract for WS1
- `12-fingerprint-and-ref-resolution-v1.md` — canonical hashing, scope resolution, ref hashing, and golden-vector contract
- `13-poc-disposition.md` — POC proof extraction, artifact mapping, and deletion rationale
