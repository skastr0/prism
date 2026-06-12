# 10 — Public Runtime Types (Implementation Contract)

This document is **normative for WS2**. It defines the public TypeScript surface
the workflow runtime exports and the semantics each type carries. It is the type
catalog the adversarial review (`09`, "Before WS2 coding beyond package scaffold")
required before swarm implementation.

Where this document and `08-agentrun-ledger-spec.md` overlap (FingerprintV1,
`AgentRunInputRef`, `SessionLineageRef`, SQLite shapes), `08` is authoritative for
storage and hashing and this document is authoritative for the public, in-memory
API surface. They must not diverge; a divergence is a bug in this document.

## Settled premises these types must encode

1. **Library/CLI first, MCP wrapper only.** Every type here is part of the
   `@skastr0/prism-workflow` library surface. The CLI is a client of these types;
   any MCP tool is a client of the CLI. No type may assume an MCP or server
   context. (`00` non-goals; `09` strengths.)
2. **SQLite is the only source of truth.** In-memory values are projections of
   ledger rows. No type implies a JSONL replay log or an authoritative event
   stream; `WorkflowEvent` is observational, not a source of truth. (`03`, `08`.)
3. **AgentRun is past labor, not current truth.** An `AgentRun<A>` asserts "this
   agent labor was completed under these declared semantic inputs," never "the
   workspace or world still matches." Reuse re-decodes shape; it never re-verifies
   the world. (`08` product invariant; `09` finding 2.)
4. **Refs/evidence are explicit dependency truth, not parent/child structure.**
   Dependency between runs is carried only by explicit `AgentRunInputRef` values that
   participate in the downstream fingerprint. The runtime never infers a
   dependency from call structure, `cwd`, or session family. (`08` ref rules;
   `09` finding 6.)
5. **`forkRun` is session lineage only.** `SessionLineage` describes provider
   session continuation mechanics. It is *not* a data-dependency edge and is
   tracked separately from refs/evidence. (`02`, `08` fork semantics.)

Type style: all fields `readonly`; unions are string-literal discriminated;
hashes are lowercase hex `sha256:` strings unless noted; timestamps are ISO-8601
UTC strings; nothing here depends on a class hierarchy.

---

## 1. Identity and addressing primitives

### `ScopeKey`

```typescript
type ScopeKey = string;
```

A caller-chosen namespace for a body of agent labor. **Not** a Git repo identity;
a multi-repo Hermes mission picks one explicit `ScopeKey` rather than inheriting a
repo root. The `ScopeKey -> LedgerPath` mapping is an explicit runtime service
(`ScopeResolver`, below), not an implicit function of `cwd`. (`08` stable-key
section; `09` finding 11.)

### `LedgerPath`

```typescript
type LedgerPath = string; // absolute path to the SQLite ledger file
```

The resolved SQLite database path for a `ScopeKey`. Resolved once before the first
dispatch of a run. Two repo roots resolving the same `ScopeKey` to two paths is a
fail-before-dispatch error, never two silent histories.

### `StableKey`

```typescript
type StableKey = string;
```

The human-chosen, scope-local resource name passed at every `wf.agentRun` /
`wf.forkRun` / `wf.useRun` call site (`"ws1-build"`). It is declared, never
inferred from call structure (omegacode's hardest bug). The pair
`(ScopeKey, StableKey)` is a stable address whose concrete revision is selected by
`SemanticFingerprint`.

### `SemanticFingerprint`

```typescript
type SemanticFingerprint = string; // "sha256:..." over canonical FingerprintV1

interface FingerprintInputs {
  readonly version: 1;
  readonly scopeKey: ScopeKey;
  readonly stableKey: StableKey;
  readonly agent: {
    readonly class: "attested" | "declared";
    readonly refHash?: string;
    readonly manifestHash?: string;
    readonly descriptorHash?: string;
  };
  readonly harness: {
    readonly id: HarnessId;
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
  readonly needsHash: string;          // canonical hash of declared permission needs
  readonly cwd?: string;               // advisory execution hint, NOT truth
  readonly refs: ReadonlyArray<AgentRunInputRef>; // explicit dependency truth
  readonly sessionLineage?: SessionLineageRef;
  readonly forkMode: ForkMode;
}
```

The canonical hash over execution-relevant inputs. Computed **before** touching a
worker. Same `(ScopeKey, StableKey, SemanticFingerprint)` ⇒ reuse; same key,
different fingerprint ⇒ a new immutable revision with surfaced history. It
**excludes** display labels, phase labels, and downstream code. The canonical
serialization and golden vectors live in `08`/`fingerprint-and-ref-resolution-v1`;
this type must serialize identically to `FingerprintV1` there.

### `AgentRunRef`

```typescript
interface AgentRunRef {
  readonly kind: "agent-run";
  readonly scopeKey: ScopeKey;
  readonly stableKey: StableKey;
  readonly agentRunId: string;          // immutable revision id
  readonly semanticHash: SemanticFingerprint;
  readonly uri: string;                 // "agent-run://<scope>/<stableKey>@sha256:..."
}
```

The stable local address of one completed AgentRun revision. The `@latest`
form (`agent-run://<scope>/<stableKey>@latest`) is a CLI/lookup convenience only;
**a ref used as evidence is always pinned to an exact `semanticHash`/`agentRunId`**
so downstream reuse never silently follows a new `@latest` (`08` fork semantics).

### `AgentRunHandle`

```typescript
interface AgentRunHandle {
  readonly ref: AgentRunRef;
  readonly status: AgentRunStatus;
  readonly outputRef: OutputRef;        // address of the typed output, re-decodable
  readonly outputSchemaHash: string;
  readonly outputGrounding: OutputGrounding;
  readonly attestation: Attestation;    // "attested" | "declared"
}

type AgentRunStatus =
  | "reserved" | "running" | "completed" | "failed" | "crashed" | "cancelled";
```

A lightweight, output-value-free reference to an AgentRun. It is what the runtime
hands back when only addressing/metadata is needed (e.g. carrying a result forward
as evidence without re-decoding it). `AgentRun<A>` (below) is the decoded form;
`AgentRunHandle` is the undecoded one. `outputRef` is the thing placed into a
downstream `AgentRunInputRef` as evidence.

---

## 2. The core resource: `AgentRun<A>`

```typescript
interface AgentRun<A> {
  readonly ref: AgentRunRef;            // stable local address (exact revision)
  readonly output: A;                   // Effect Schema-decoded value
  readonly outputRef: OutputRef;        // pinned, re-decodable evidence address
  readonly outputGrounding: OutputGrounding;
  readonly transcript: TranscriptRef;   // provider stream artifact, supporting only
  readonly session: SessionRef;         // provider/harness session metadata
  readonly provenance: Provenance;
  readonly usage: Usage;
  readonly attestation: Attestation;
  readonly reused: boolean;             // true ⇒ loaded from ledger, no provider spend
}

type OutputGrounding =
  | "native-schema" | "prompted-json" | "extracted-json" | "human-approved";

type Attestation = "attested" | "declared";

interface OutputRef {
  readonly kind: "agent-run-output";
  readonly agentRunId: string;
  readonly stableKey: StableKey;
  readonly semanticHash: SemanticFingerprint;
  readonly outputHash: string;
}

interface WorkflowOutputRef {
  readonly kind: "workflow-output";
  readonly workflowRunId: string;
  readonly outputHash: string;
  readonly outputSchemaHash: string;
}

interface TranscriptRef { readonly kind: "transcript"; readonly path?: string; readonly casRef?: string; }
interface SessionRef    { readonly providerSessionId?: string; readonly harness: HarnessId; }

interface Provenance {
  readonly agentRefHash?: string;       // class A generated ref hash
  readonly manifestHash?: string;       // class A composed-policy hash
  readonly descriptorHash?: string;     // class B declared descriptor hash
  readonly promptHash: string;
  readonly outputSchemaHash: string;
  readonly compileManifestHash?: string;
}

interface Usage {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly costReporting: "full" | "tokens" | "none";
}
```

Semantics:

- `output` is **shape-proven, not truth-proven**. `outputGrounding` records *how*
  the shape was obtained; the runtime never silently upgrades `extracted-json`
  into a stronger lane (`09` finding 5).
- `reused: true` means "this past labor matches the declared semantic inputs,"
  presented as past labor, never as "current verification" (`08` reuse table).
- `transcript`/`session` are **supporting artifacts**, never the source of truth;
  the SQLite ledger is (`00`, `03`).
- The schema argument supplied at the call site re-decodes the stored output on
  every load. A stale or incompatible stored value fails at the boundary with a
  typed decode error (`02` `useRun`).

---

## 3. Refs, evidence, and world refs

```typescript
type AgentRunInputRef =
  | OutputRef                                                                   // prior AgentRun output
  | { readonly kind: "git-commit"; readonly repo: string; readonly commit: string; readonly remote?: string }
  | { readonly kind: "git-range";  readonly repo: string; readonly base: string; readonly head: string; readonly diffHash: string; readonly remote?: string }
  | { readonly kind: "dirty-worktree"; readonly repo: string; readonly base: string; readonly statusHash: string; readonly diffHash: string }
  | { readonly kind: "file-set";   readonly root: string; readonly paths: ReadonlyArray<string>; readonly contentHash: string }
  | { readonly kind: "artifact";   readonly artifactId: string; readonly sha256: string }
  | { readonly kind: "external";   readonly url: string; readonly capturedAt: string; readonly contentHash?: string };
```

This is the **only** dependency-truth carrier between runs.

- Every `AgentRunInputRef` participates in the downstream `SemanticFingerprint`. A changed ref
  breaks downstream reuse and forces a new revision (`02`, `08`).
- Refs are pinned by exact version/hash. A downstream run never implicitly follows
  another run's new `@latest`.
- `git-commit` / `git-range` are the **preferred** truth carriers for code because
  Git makes the reviewed world stable and shareable across sandboxes.
- `dirty-worktree` is a **weak/local** ref. Its hash must account for untracked
  files (when requested), relevant file-mode changes, and line-ending
  normalization; the CLI labels it as weak evidence (`08` ref rules).
- A missing/unresolvable ref for a downstream run is a **typed error**, never
  silent restoration. The workflow runtime does not own world restoration; Git,
  artifact stores, and explicit tools do (`08`; `09` finding 6).

Artifacts produced by a run are descriptors with content hashes, not restorable
state:

```typescript
interface AgentRunArtifact {
  readonly kind: "file" | "patch" | "transcript" | "media" | "external";
  readonly path?: string;     // project-relative when local
  readonly sha256?: string;
  readonly casRef?: string;
  readonly mimeType?: string;
}
```

---

## 4. Session lineage (`forkRun` only)

```typescript
type ForkMode = "seed" | "provider-copy" | "continue" | "none";

interface SessionLineageRef {
  readonly sourceAgentRunId: string;
  readonly mode: Exclude<ForkMode, "none">;   // "seed" | "provider-copy" | "continue"
  readonly providerSessionId?: string;
}

interface SessionLineage {
  readonly source: AgentRunRef;
  readonly mode: Exclude<ForkMode, "none">;
  readonly providerSessionId?: string;
  readonly immutableSource: boolean;          // false only for "continue"
}
```

Semantics:

- `SessionLineage` describes **provider/session continuation mechanics only**. It
  is explicitly *not* a data-dependency edge and lives in a separate ledger table
  (`agent_run_session_lineage`) from refs (`agent_run_refs`).
- `seed` is the portable, always-immutable default: source output/transcript
  excerpts supplied as ordinary context to a fresh session.
- `provider-copy` uses a native non-mutating copy when an adapter proves it.
- `continue` is **mutating**, requires an exclusive lock on the source session,
  and fails closed under parallel fanout (`02`, `08`, `04`).
- A downstream review depends on **evidence refs**, not on session family
  relationships. The two are never conflated.
- `seed` and `provider-copy` still record pinned refs for any source output,
  transcript excerpt, or artifact content injected into the new prompt. Lineage
  describes provider mechanics; refs describe the data that could influence the
  result.

---

## 5. Dispatch boundary: `TaskRequest`, `TaskResult`, `DispatchError`

These cross the `WorkerGateway`/`WorkerAdapter` seam (`04`). They are about a
single live provider attempt; they are *not* the durable resource (`AgentRun` is).

```typescript
type HarnessId =
  | "claude-code" | "grok" | "codex-cli" | "antigravity-cli" | "hermes" | (string & {});

interface TaskRequest {
  readonly scopeKey: ScopeKey;
  readonly stableKey: StableKey;
  readonly agentRunId: string;
  readonly attempt: number;
  readonly target: WorkerTarget;          // attested ref OR declared descriptor
  readonly harness: HarnessId;
  readonly prompt: string;
  readonly outputSchemaJson: string;      // JSON Schema derived from the Effect Schema
  readonly structuredOutput: "native-schema" | "prompted";
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;                   // worktree/cwd execution hint
  readonly needs: PermissionNeeds;         // requested access, gate-checked ⊆ grants
  readonly evidence: ReadonlyArray<AgentRunInputRef>;
  readonly sessionLineage?: SessionLineageRef;
  readonly forkMode: ForkMode;
  readonly timeoutMs?: number;
  readonly dangerouslyAllowFullAccess?: boolean;  // required when sandbox: "none"
}

interface TaskResult {
  readonly rawOutput: string;             // pre-decode provider text/JSON
  readonly outputGrounding: OutputGrounding;
  readonly providerSessionId?: string;
  readonly usage: Usage;
  readonly transcript?: TranscriptRef;
  readonly artifacts: ReadonlyArray<AgentRunArtifact>;
}
```

`TaskResult.rawOutput` is **always** re-decoded by the runtime with the original
Effect Schema regardless of provider-native structured output; provider-side
enforcement is an optimization, never validation (`04`). Decode happens above the
gateway, so the gateway returns raw + grounding, not a decoded `A`.

```typescript
type DispatchError =
  | { readonly _tag: "DispatchError"; readonly kind: "provider_busy"; readonly retryable: true;  readonly detail: string }
  | { readonly _tag: "DispatchError"; readonly kind: "auth";          readonly retryable: false; readonly detail: string }
  | { readonly _tag: "DispatchError"; readonly kind: "timeout";       readonly retryable: true;  readonly detail: string }
  | { readonly _tag: "DispatchError"; readonly kind: "unknown";       readonly retryable: boolean; readonly detail: string }
  | { readonly _tag: "OutputDecodeError"; readonly retryable: true;  readonly parseError: string; readonly retryIndex: number }
  | { readonly _tag: "CapabilityError";   readonly retryable: false; readonly capability: string; readonly remedy: string }
  | { readonly _tag: "GateError";         readonly retryable: false; readonly reason: GateFailureReason; readonly detail: string };

type GateFailureReason = "RefDrift" | "NotInstalled" | "PolicyViolation" | "BudgetExceeded";
```

Semantics (`04` taxonomy; `03` gate events):

- `OutputDecodeError` has its **own retry budget**; decode retries do **not**
  consume task retries (smithers' rule).
- `auth` is terminal and short-circuits retries; `provider_busy`/`timeout` are
  retryable with bounded backoff.
- `CapabilityError` and `GateError` are terminal and **name the remedy**; the
  runtime never silently degrades (fail-closed, from omegacode).

---

## 6. Worker capabilities and target

```typescript
type WorkerClass = "attested" | "declared";

type WorkerTarget =
  | { readonly class: "attested"; readonly agentRefHash: string; readonly manifestHash: string; readonly installs: ReadonlyArray<HarnessId>; readonly artifactPath?: string }
  | { readonly class: "declared"; readonly descriptorHash: string; readonly profile?: string; readonly toolsets?: ReadonlyArray<string> };

interface WorkerCapabilities {
  readonly agentSelection: "installed-artifact" | "named" | "projection" | "profile";
  readonly structuredOutput: "native-schema" | "prompted";  // runtime ALWAYS re-validates
  readonly fork: ForkMode;
  readonly sandbox: "native" | "flag-gated" | "none";       // "none" needs explicit danger opt-in
  readonly effort: boolean;
  readonly costReporting: "full" | "tokens" | "none";
  readonly concurrencySafe: boolean;                        // false ⇒ adapter-level mutex
}
```

The capability matrix is **fail-closed**: a `TaskRequest` asking for something a
`WorkerCapabilities` cannot honestly provide is rejected at the gate as a
`CapabilityError` with a remedy (`04`). `attestation` recorded on every AgentRun
follows `WorkerTarget.class`: class A is `attested`, class B (Hermes etc.) is
`declared` with descriptor hash and visible honesty warnings (`09` finding 8).

---

## 7. Workflow definition and run

```typescript
type WorkflowError =
  | DispatchError
  | GateFailure
  | DecodeFailure
  | ScopeResolutionError
  | LedgerError
  | BudgetExceeded
  | ApprovalDenied;

interface WorkflowDefinition<I, O> {
  readonly name: string;
  readonly input: Schema.Schema<I>;       // Effect Schema for CLI input validation
  readonly run: (input: I) => Effect.Effect<O, WorkflowError, WorkflowRuntime>;
}
```

`defineWorkflow` returns a `WorkflowDefinition`. It is a typed envelope (name,
input schema, run function) so the CLI/MCP surface can validate input, list
workflows, and record the decoded input value — **not** a constrained IR. The
program inside `run` is arbitrary Effect TypeScript; control flow *is* the
language (`02`).

```typescript
type WorkflowRunStatus =
  | "running" | "waiting" | "completed" | "failed" | "crashed" | "cancelled";

interface WorkflowRun {
  readonly id: string;                    // workflowRunId
  readonly scopeKey: ScopeKey;
  readonly workflowFile: string;
  readonly workflowHash: string;
  readonly inputHash: string;
  readonly status: WorkflowRunStatus;
  readonly rootOutputRef?: WorkflowOutputRef; // address of the workflow's decoded result
  readonly runner: RunnerLiveness;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

interface RunnerLiveness {
  readonly pid?: number;
  readonly startToken?: string;           // PID alone is insufficient (OS reuses PIDs)
  readonly heartbeatAt?: string;
}
```

Semantics (`03`, `08`):

- A `WorkflowRun` is **secondary** state: one execution of one workflow module.
  The AgentRun ledger is primary. Future runs reference prior AgentRuns without
  depending on this run's source file or conversation context.
- Crash detection requires dead PID **plus** stale `startToken`/expired heartbeat;
  PID alone is not enough because OSes reuse process ids.
- `WorkflowRun` is `runner-owns-live-work`: two live runs never share a process,
  but they share immutable completed AgentRuns by `(ScopeKey, StableKey,
  SemanticFingerprint)`.

---

## 8. Observability: `WorkflowEvent`

```typescript
interface WorkflowEventEnvelope {
  readonly seq: number;                   // global SQLite event sequence
  readonly workflowRunId: string;
  readonly agentRunId?: string;
  readonly at: string;
  readonly event: WorkflowEvent;
}

type WorkflowEvent =
  | { readonly type: "workflow_started"; readonly workflow: string; readonly inputHash: string; readonly generatedRefsHash: string; readonly manifestHash?: string }
  | { readonly type: "agent_run_reused"; readonly key: StableKey; readonly agentRunId: string; readonly revisionHash: SemanticFingerprint; readonly sourceWorkflowRunId?: string }
  | { readonly type: "agent_run_started"; readonly key: StableKey; readonly agentRunId: string; readonly revisionHash: SemanticFingerprint; readonly agentRef: string; readonly harness: HarnessId; readonly attempt: number }
  | { readonly type: "gate_passed"; readonly key: StableKey; readonly agentRunId: string; readonly checks: { readonly provenance: boolean; readonly attestation: boolean; readonly policy: boolean; readonly budget: boolean }; readonly attestation: Attestation }
  | { readonly type: "gate_failed"; readonly key: StableKey; readonly reason: GateFailureReason; readonly detail: string }
  | { readonly type: "worker_spawned"; readonly key: StableKey; readonly harness: HarnessId; readonly sessionId?: string }
  | { readonly type: "agent_run_output"; readonly key: StableKey; readonly agentRunId: string; readonly outputHash: string; readonly usage?: Usage }
  | { readonly type: "agent_run_failed"; readonly key: StableKey; readonly agentRunId: string; readonly error: DispatchError; readonly retryable: boolean; readonly nextAttemptAt?: string }
  | { readonly type: "decode_retry"; readonly key: StableKey; readonly parseError: string; readonly retryIndex: number }
  | { readonly type: "approval_requested"; readonly approvalId: string; readonly payload: unknown }
  | { readonly type: "approval_decided"; readonly approvalId: string; readonly approved: boolean; readonly by?: string }
  | { readonly type: "fanout_expanded"; readonly id: string; readonly count: number }
  | { readonly type: "clock_read"; readonly value: number }
  | { readonly type: "random_read"; readonly value: number }
  | { readonly type: "workflow_finished"; readonly totals: { readonly agentRuns: number; readonly reused: number; readonly tokens?: number; readonly costUsd?: number; readonly wallMs: number } };
```

`WorkflowEvent` is **observational**: a log for CLI `events`/`status` and
debugging. It is persisted in SQLite (`workflow_events`) but is **not** a replay
source of truth — replay re-executes the module and resolves AgentRun resources
from the ledger (`03` replay semantics). `decode_retry` events must not be counted
as task retries.

---

## 9. The runtime service surface

```typescript
type WorkflowRuntime =
  | Gate | WorkerGateway | AgentRunLedger | Budget | Approvals | Worktrees | ScopeResolver;

interface ScopeResolver {
  readonly resolve: (scopeKey: ScopeKey) => Effect.Effect<ResolvedLedger, ScopeResolutionError>;
}

interface ResolvedLedger {
  readonly scopeKey: ScopeKey;
  readonly ledgerPath: LedgerPath;
  readonly source: "default-single-repo" | "explicit-config";
}

type ScopeResolutionError =
  | { readonly _tag: "AmbiguousScopeLedger"; readonly scopeKey: ScopeKey; readonly candidates: ReadonlyArray<LedgerPath> }
  | { readonly _tag: "UnresolvedScope"; readonly scopeKey: ScopeKey }
  | { readonly _tag: "LedgerPathUnavailable"; readonly scopeKey: ScopeKey; readonly ledgerPath: LedgerPath; readonly reason: string };
```

The `run` function's environment is `WorkflowRuntime | Clock | Random` and nothing
else (`02` rule 3). `Clock`/`Random` stay injectable for reproducible workflow
code, but the durable replay guarantee lives at the AgentRun resource boundary,
not in replaying every JS expression. A `FakeWorkerGateway` (canned `TaskResult`s)
must satisfy this same surface so the mandatory `08` fake-worker tests run with
zero provider calls (`03`, `09`).

---

## Cross-reference map

| Type | Authoritative storage/hash spec |
|---|---|
| `SemanticFingerprint` / `FingerprintInputs` | `08` `FingerprintV1` + golden vectors |
| `AgentRunInputRef` | `08` `AgentRunInputRef` |
| `SessionLineageRef` / `SessionLineage` | `08` `SessionLineageRef`, `agent_run_session_lineage` |
| `OutputGrounding` | `08` Output grounding |
| `AgentRun` / `AgentRunHandle` / `AgentRunRef` / `WorkflowOutputRef` | `08` `agent_runs`, `agent_run_outputs`, `workflow_runs.root_output_ref` |
| `TaskRequest` / `TaskResult` / `DispatchError` / `WorkerCapabilities` | `04` adapter contract |
| `WorkflowRun` / `WorkflowEvent` | `03` process model, event vocabulary |
| `WorkflowDefinition` | `02` `defineWorkflow` |
