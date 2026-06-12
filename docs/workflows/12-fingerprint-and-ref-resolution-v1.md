# 12 — Fingerprint and Ref Resolution v1

This document is **normative** for WS2. It is the canonical contract referenced
by `09-adversarial-review.md` finding 12 ("Ref/world-ref hashing needs golden
vectors") and finding 11 ("Scope keys need a ledger resolver"). It locks down the
exact byte-level rules a single implementer or an implementation swarm must
follow so that every producer of a semantic hash agrees with every other one.
`08-agentrun-ledger-spec.md` defines the `FingerprintV1` shape; this document
defines how each field is *materialized and hashed*, how `scope_key` resolves to
a ledger path, and how reuse is described to humans.

If `08` and `12` disagree on a field, that is a bug to be reconciled before
WS2 coding; neither may be silently reinterpreted.

## Non-negotiable truth posture

These invariants outrank every convenience below. An implementation that hashes
perfectly but violates one of these is wrong.

1. **A reused AgentRun is a record of past labor, not a claim about current
   truth.** A semantic-hash match proves "an agent previously did this work under
   these declared inputs." It never proves the workspace, the repository, the
   filesystem, or the external world still matches. Reuse language must say so
   (see "Reuse status language").
2. **No artifact restoration.** Resolving or reusing an AgentRun never writes,
   restores, or recreates files, patches, worktrees, or any world state. The
   ledger stores *descriptors with content hashes*; Git, artifact stores, and
   explicit tools own restoration. A downstream run that needs world state
   depends on an explicit ref and fails with a typed missing-ref error if it
   cannot be resolved.
3. **No parent/child truth semantics.** Stable keys are flat scope-local names.
   There is no hierarchy in which a "parent" run vouches for a "child" run, and
   no run inherits validity from another. Dependency is expressed *only* through
   explicit refs in the `refs` array, each pinned by exact hash.
4. **Session lineage is separate from dependency refs.** `sessionLineage` /
   `forkMode` describe provider/session continuation mechanics only. They are
   never a substitute for an evidence ref and never imply that the source run's
   world is current. A downstream review depends on `evidenceRefs`, not on being
   forked from another session.
   If `seed` or `provider-copy` injects source output, transcript excerpts, or
   artifacts into the next prompt, those injected values are also pinned as refs;
   lineage alone is insufficient.

## scope_key -> ledger_path resolution

The ledger location follows the **scope**, not the current working directory.
This is an explicit runtime service, not an implicit `process.cwd()` lookup.

### Resolution contract

```typescript
interface LedgerPathResolver {
  readonly resolve: (
    scopeKey: string,
  ) => Effect.Effect<ResolvedLedger, ScopeResolutionError>;
}

interface ResolvedLedger {
  readonly scopeKey: string;
  readonly ledgerPath: string;   // absolute path to the SQLite file
  readonly source: "default-single-repo" | "explicit-config";
}

type ScopeResolutionError =
  | { readonly _tag: "AmbiguousScopeLedger"; readonly scopeKey: string; readonly candidates: ReadonlyArray<string> }
  | { readonly _tag: "UnresolvedScope"; readonly scopeKey: string }
  | { readonly _tag: "LedgerPathUnavailable"; readonly scopeKey: string; readonly ledgerPath: string; readonly reason: string };
```

### Rules

1. Resolution happens **once, before the first dispatch** of a workflow run, and
   the resolved absolute `ledgerPath` is fixed for the entire run.
2. A single-repo scope **may** default to
   `<workspace>/.prism/workflows/workflow-ledger.sqlite`. This default is the
   only implicit behavior allowed, and only when no explicit mapping exists and
   the scope is launched from exactly one repo root.
3. A multi-repo scope **must** be mapped explicitly (config or workflow input)
   to one absolute `ledgerPath` before dispatch. There is no auto-discovery of a
   shared path across repos.
4. The same `scope_key` launched from two different repo roots **must** resolve
   to the same `ledgerPath` or fail with `AmbiguousScopeLedger` before any
   provider work. Splitting history silently is forbidden (matches `08` test 11).
5. `scope_key` is a caller-chosen namespace string. It is **not** derived from,
   and does not encode, a repository identity. `scope_key` is part of the
   `FingerprintV1` (so two scopes never collide on identical keys), but the
   ledger *file* it resolves to is determined solely by this resolver.
6. The resolver never creates a ledger outside the resolved path and never
   migrates rows between paths.

## Stable key identity

The stable key is a human-readable name local to a workflow scope.

- Identity tuple for an AgentRun resource: `(scope_key, stable_key, semantic_hash)`.
  This is the unique constraint in `agent_runs` (`08` SQLite schema).
- `stable_key` is scope-local and flat. It carries no path semantics, no
  parent/child relationship, and no ordering.
- Same `(scope_key, stable_key)` with the **same** `semantic_hash` → reuse the
  same immutable resource.
- Same `(scope_key, stable_key)` with a **different** `semantic_hash` → a new
  immutable revision under the same stable key. Prior revisions are preserved
  and surfaced in CLI/status output; nothing is overwritten or deleted.
- The stable key is the unit authors reference with `wf.useRun(key, schema)`.
  Resolving by key alone returns the latest completed revision; resolving with
  `{ revision: "sha256:..." }` pins an exact one.

Normalization of `stable_key` and `scope_key` strings before hashing:

- UTF-8, NFC-normalized.
- No trimming, no case folding (keys are case-sensitive and exact).
- Empty string is invalid for both.

## Immutable revision via semantic fingerprint

A revision is identified by `revision_hash = semantic_hash =
sha256(canonicalJson(FingerprintV1))`. The `FingerprintV1` shape is defined in
`08`. A revision is immutable: once a completed output row exists for
`(scope_key, stable_key, semantic_hash)`, that triple is never mutated. Any
change to a semantic input produces a *new* triple and therefore a new revision,
never an edit of the old one.

Downstream workflow code changes never alter an upstream run's fingerprint
(matches `03` and `08`). Changing prompt, schema, agent, harness, model/effort,
capability mode, cwd identity, declared needs, evidence/world refs, session seed,
fork mode, or the runtime key `version` creates a new revision.

## Canonicalization rules

All hashing in this contract goes through one canonical JSON encoder,
`canonicalJson`. No implementer may choose their own stringification.

`canonicalJson(value) -> string`:

1. Output is UTF-8 JSON.
2. Object keys sorted lexicographically by Unicode code point at every nesting
   level.
3. No `undefined` values are emitted. A key whose value is `undefined` is omitted
   entirely (it is **not** rendered as `null`). `null` is a distinct, preserved
   value.
4. No insignificant whitespace: no spaces after `:` or `,`, no indentation, no
   trailing newline.
5. Numbers are emitted in canonical form: integers without a decimal point,
   no leading zeros, no `+` exponent sign, no trailing zeros in fractions.
   `NaN`/`Infinity` are forbidden and must raise an encoder error.
6. Strings are JSON-escaped with lowercase `\uXXXX` for control characters; no
   non-required escaping (e.g. `/` is not escaped).
7. Arrays preserve their given order. Order is therefore semantically
   significant; producers of arrays (notably `refs`) must apply the array
   ordering rule defined below before encoding.
8. Booleans and `null` are literal.

`canonicalText(text) -> string` (the pre-hash normalizer for free text such as
prompts and diffs):

1. Decode to UTF-8, NFC-normalize.
2. Normalize all newline sequences (`\r\n`, `\r`) to `\n`.
3. Do **not** trim, do **not** collapse internal whitespace, do **not** strip a
   final newline. Text content is otherwise byte-faithful.

All `*Hash` fields are `sha256` over the UTF-8 bytes of either `canonicalJson`
(structured input) or `canonicalText` (free text), expressed as
`"sha256:" + lowercaseHex`.

Path normalization (`canonicalPath`):

1. Express relative to the workspace root when the path is inside it; use POSIX
   separators (`/`).
2. Paths outside the workspace are recorded as resolved absolute POSIX paths and
   flagged; such refs are weak (see dirty-worktree weakness below).
3. No symlink resolution beyond what the ref kind explicitly specifies.

## Fields included in / excluded from the fingerprint

### Included (semantic inputs)

- `version` (runtime fingerprint key version, currently `1`).
- `scopeKey`, `stableKey`.
- `agent`: `class` plus the class-appropriate hash — `refHash` + `manifestHash`
  for `attested` (class A), `descriptorHash` for `declared` (class B).
- `harness`: `id`, `model?`, `effort?`, `capabilityMode`.
- `prompt`: `textHash`, plus `templateHash?` and `argsHash?` (see materialization).
- `outputSchemaHash`.
- `needsHash` (declared permission needs).
- `cwd?` — included as an **advisory execution location**, hashed via
  `canonicalPath`. It is part of the fingerprint but the runtime never infers
  broad world truth from it (see `08` ref rules).
- `refs` — the ordered, hashed evidence/world/AgentRun-output refs.
- `sessionLineage?` and `forkMode`.

### Excluded (must never affect the hash)

- Display-only labels and human titles (e.g. the first string arg to
  `wf.approve`, phase labels, the descriptive `key` display text beyond the
  stable key itself).
- Downstream workflow code, control flow, and any task constructed *after* this
  one.
- Wall-clock time, timestamps, run ids, attempt numbers, PIDs,
  `runner_start_token`, heartbeat fields.
- Token/cost/usage figures and durations.
- Environment variable **values** (only env var *names* may appear in the stored
  request record, never in the fingerprint).
- Provider-assigned session ids as raw values, except where carried inside
  `sessionLineage.providerSessionId` for continuation mechanics — and even there
  they describe session continuity, not dependency truth.
- `outputGrounding` and any post-execution result metadata.

## Schema hash

`outputSchemaHash` identifies the output contract independent of object identity.

- Derived from a **deterministic structural export of the supported Effect Schema
  subset** — canonical JSON Schema (AST) or an equivalent stable serialization —
  then `sha256` over its `canonicalJson`. Never from JS object identity,
  function reference, or import path.
- Field order in the serialized schema must be canonicalized (keys sorted) so
  that re-ordering struct fields in source does not change the hash unless the
  contract actually changed.
- Two schemas with the same supported structural shape (field names,
  optionality, literal values, and primitive/composite types) must hash equal.
  A change to field name, optionality, type, refinement identity, or struct
  membership must change the hash.
- Arbitrary refinements/transforms are not solved by semantic equivalence. Any
  refinement or transform that affects accepted output must carry an explicit,
  stable identity/version in the schema export; otherwise workflow validation
  refuses it as non-canonical for AgentRun output.
- The same `outputSchemaHash` is stored on `agent_runs`,
  `agent_run_outputs`, and is the value `useRun` re-decodes against. A `useRun`
  whose caller schema hashes differently still re-decodes the stored output and
  surfaces a typed decode error if incompatible (`08` test 7).

## Prompt materialization hash

Prompts are hashed after materialization, never as raw template fragments.

- `prompt.textHash = sha256(canonicalText(finalPromptString))`. The *final*
  prompt — after all interpolation — is the authoritative semantic input. Two
  authoring expressions that produce byte-identical final text hash equal.
- `prompt.templateHash?` is the hash of the static template *before*
  interpolation, when a structured template is used. It is informational for
  diffing/provenance and is included in the fingerprint when present.
- `prompt.argsHash?` is `sha256(canonicalJson(templateArgs))` when a structured
  template+args pair is used. Included when present.
- When the author supplies only a plain string, only `textHash` is set;
  `templateHash` and `argsHash` are omitted (and, per canonicalization rule 3,
  do not appear in the encoded object at all).
- Prompt text is normalized only by `canonicalText` (newline + NFC). Meaningful
  whitespace inside the prompt is preserved and is part of identity.

## refs / evidence / world refs hashing

Every dependency is an `AgentRunInputRef` (shape in `08`). Each ref carries its
own `ref_hash` and the array participates in the fingerprint.

### Per-ref hashing

`refHash(ref) = sha256(canonicalJson(ref))` after each kind's required fields are
populated. Required hashed fields per kind:

| kind | identity-bearing fields (all included) |
|---|---|
| `agent-run-output` | `stableKey`, `agentRunId`, `semanticHash`, `outputHash` |
| `git-commit` | `repo`, `commit`, `remote?` |
| `git-range` | `repo`, `base`, `head`, `diffHash`, `remote?` |
| `dirty-worktree` | `repo`, `base`, `statusHash`, `diffHash` |
| `file-set` | `root` (canonicalPath), `paths` (each canonicalPath, sorted), `contentHash` |
| `artifact` | `artifactId`, `sha256` |
| `external` | `url`, `capturedAt`, `contentHash?` |

Notes:

- `agent-run-output` refs are pinned by `semanticHash` **and** `outputHash`. A
  downstream run never implicitly follows an upstream `@latest`; following a new
  upstream revision requires the author to resolve a new ref, which changes the
  downstream semantic hash (`08` fork semantics, test 4).
- `git-range.diffHash` and `dirty-worktree.diffHash` are
  `sha256(canonicalText(unifiedDiff))` where the diff is produced with a fixed,
  documented Git invocation (stable format flags, no color, no ext-diff). The
  exact invocation is part of the golden fixtures.
- `file-set.contentHash` is `sha256` over the `canonicalJson` of an array of
  `{ path: canonicalPath, sha256 }` entries sorted by `path`. File bytes are
  hashed raw (no text normalization).
- `external.contentHash` is over the raw captured bytes when capture is
  available; when absent, the ref is weak (`url` + `capturedAt` only) and labeled
  as such.

### dirty-worktree weakness

Dirty-worktree refs are **weak refs**. Per `08`, their hash MUST account for:

- untracked files when the author requests their inclusion,
- file mode changes when relevant,
- line-ending normalization rules (documented and applied via `canonicalText`
  for text diffs).

If any of these is unspecified, the CLI labels the ref as **local/weak
evidence** and reuse language must reflect that the evidence is not portable
across sandboxes. Committed Git commits/ranges are preferred for scalable,
shareable review.

### Array ordering and the refs hash contribution

- Before encoding the `FingerprintV1`, the `refs` array is sorted
  deterministically by `(kind, refHash)` ascending (Unicode code point order on
  the concatenation `kind + "\u0000" + refHash`). This makes ref order in author
  source irrelevant to identity while keeping the encoding stable.
- Duplicate refs (identical `refHash`) are de-duplicated before sorting.
- The sorted, de-duplicated array is embedded directly in `FingerprintV1.refs`,
  so the fingerprint hash already covers all ref hashes; there is no separate
  top-level "refs digest" field.

## needsHash

`needsHash = sha256(canonicalJson(normalizedNeeds))` over the declared permission
needs for the run.

- `normalizedNeeds` is the canonical form of the run's declared capability/
  permission requirements (filesystem, network, write-access, tool grants, etc.)
  as defined by the gate/policy layer (`05`).
- If the author omits `needs`, normalization uses the minimal
  read/no-network/no-write/no-extra-tools default from `05`; it never expands to
  "whatever the agent has."
- Normalization: each need is reduced to a canonical record; the set of needs is
  sorted deterministically (by a stable per-need key) and de-duplicated before
  encoding, so authoring order never affects the hash.
- `needsHash` captures *declared* needs (what the run says it requires). It is a
  semantic input because changing what a run is permitted to do changes its
  identity. Policy **subsumption** comparison on reuse (`08` reuse matrix) is a
  separate check performed against current requested needs; it does not mutate
  the stored `needsHash`.

## Golden vector fixtures

To prevent cross-implementer drift (finding 12), every named canonical helper
ships with golden test vectors that are part of the WS2 acceptance bar.

Required fixture sets (input → expected output, byte-exact):

1. `canonicalJson` — nested objects, key ordering, omitted `undefined` vs
   preserved `null`, number canonicalization, string escaping, arrays.
2. `canonicalText` — CRLF/CR/LF mixing, NFC normalization, preserved internal
   whitespace, preserved trailing newline.
3. `canonicalPath` — in-workspace relativization, outside-workspace absolute +
   weak flag, POSIX separator coercion.
4. `outputSchemaHash` — equal hash under field re-ordering; changed hash under
   field rename / optionality / type / refinement change.
5. `prompt` materialization — `textHash` from final interpolated string;
   `templateHash` + `argsHash` presence/absence cases.
6. Per-ref `refHash` — at least one vector per `AgentRunInputRef` kind, including
   `git-range.diffHash` from a fixed Git invocation and a weak dirty-worktree
   case.
7. `refs` array ordering + de-duplication → stable embedded array.
8. `needsHash` — order independence and de-duplication.
9. Full `FingerprintV1` → `semantic_hash` — at least one complete end-to-end
   vector exercising every field, plus minimal-field and maximal-field variants.

Golden vectors are the source of truth. If a vector and an implementation
disagree, the implementation is wrong until the vector is changed by an explicit,
reviewed contract revision (which also bumps the `version` field when the change
is not backward-compatible).

## Invalidation semantics

"Invalidation" here means *a new revision is created*, never *an old revision is
edited or deleted*.

- A change to any included field (above) yields a new `semantic_hash` →
  `agentRun` finds no completed match → live dispatch creates a new immutable
  revision. The prior revision remains valid as a record of past labor.
- A change to an excluded field changes nothing about identity; reuse continues.
- A change to a depended-on world surface (Git range, file-set, artifact,
  external capture) only invalidates downstream reuse **if** that surface is
  carried as an explicit ref. If the author did not pin the surface, reuse will
  match and the CLI must present it as past labor, not current verification
  (this is the stale-world Goodhart trap from finding 2 — the contract's answer
  is explicit refs, not implicit cwd inference).
- Missing/unresolvable refs do not "invalidate" silently: a downstream run that
  requires an unresolvable ref fails with a typed missing-ref error and performs
  **no** restoration (`08` test 9).
- Failed / in-flight / crashed attempts are not durable and are never treated as
  reusable; they rerun. Only `status = completed` rows with a matching output row
  are reuse candidates.

## Reuse status language

Reuse must never be presented as current verification. The following language is
normative for CLI, status, events, and any MCP wrapper.

- A reused resource is described as **past labor that matches the declared
  semantic inputs** — e.g. *"reused: matches declared inputs (past labor; not a
  current check)"*. Never *"verified"*, *"passing"*, *"up to date"*, or
  *"current"*.
- Reuse output MUST surface:
  - that the result is reused (`agent_run_reused` event; `03` vocabulary),
  - the `outputGrounding` lane (`native-schema` | `prompted-json` |
    `extracted-json` | `human-approved`) without upgrading it,
  - the evidence/world refs the run depended on and whether any are weak
    (dirty-worktree / uncaptured external),
  - the revision (`semantic_hash`) and that prior revisions may exist.
- Weak-ref reuse additionally states that the evidence is local/non-portable and
  not a claim about other sandboxes or the current tree.
- Session lineage, when present, is described purely as *session continuation
  mechanics* and explicitly **not** as evidence that the source run's world is
  current.
- Nothing in reuse language may imply parent/child trust, artifact restoration,
  or that one run's validity flows to another. Each run stands on its own
  explicit refs.

## Relationship to other docs

- `02-authoring-dsl.md` — author surface (`agentRun`, `useRun`, `forkRun`,
  `evidenceRefs`, `gitRange`) whose calls feed this fingerprint.
- `03-runtime-and-execution.md` — lifecycle, replay, and the AgentRun ledger
  tables that store these hashes.
- `08-agentrun-ledger-spec.md` — the `FingerprintV1` / `AgentRunInputRef` shapes,
  SQLite constraints, transaction algorithm, and reuse-vs-live gate matrix this
  document makes byte-deterministic.
- `09-adversarial-review.md` — findings 11 and 12 that mandate this contract and
  its golden vectors before WS2.
