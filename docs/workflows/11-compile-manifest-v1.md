# 11 — Compile Manifest v1 (Normative Implementation Contract)

Status: contract draft (WS1.2 gate per `09`, "Compile manifest v1 schema
drafted"). This document is normative for the writer in `@skastr0/prism` and the
schema + reader in `@skastr0/prism-core`. Where it uses MUST / MUST NOT / SHOULD,
read them in the RFC 2119 sense.

The compile manifest is the **Compile** provenance tier from
`01-type-system-and-codegen.md`: a durable, regenerable record of what `prism
compile` *composed* — agents with resolved grants, model bindings, and content
hashes — so the gate (`05`) can perform provenance and policy subsumption against
a stable surface instead of re-deriving compose-phase state at dispatch.

## 1. Purpose

The manifest exists because today nothing durable records "what was composed."
The install snapshot (`src/state/snapshot.ts`) records only what was *lowered and
installed*, and is disposable by design. Policy subsumption (`05`, layer 5)
operates on **composed grants** — traits expanded, toolspace access resolved,
per-harness allowlists computed — which exist only transiently inside the compile
pipeline's compose phase (`src/compile/compose.ts`, `composeAgent`) and are
thrown away after lowering.

The manifest serializes exactly those results. Its consumers:

1. **The gate** (`05`): provenance check (layer 3) compares a workflow ref's
   `manifestHash` against the agent's current composed entry; policy subsumption
   (layer 5) checks `needs ⊆ composed.grants` for the target harness.
2. **The AgentRun ledger** (`08`): a completed AgentRun records the exact
   `manifestHash` of the composed policy surface that authorized it, so an audit
   can answer "under which composed grants was this labor performed."
3. **The refs emitter** (`01`): `WorkflowAgentRef.manifestHash` and
   `installs: HarnessId[]` are read from the manifest at codegen.

Non-purpose: the manifest is **not** an install attestation. "Is the agent
actually installed in the target harness root" is the **Install** tier (layer 4),
answered against the snapshot at dispatch. The manifest answers "what would a
correctly-installed agent be allowed to do," nothing about on-disk presence.

## 2. Writer

`@skastr0/prism` (the CLI) writes the manifest. It is the only writer. No other
package, MCP tool, or hand-edit mutates it.

The writer runs **on every compile**, as an additive serialization step after the
compose phase produces `ComposedAgent[]` and after orbit grants are applied
(`applyOrbitGrantsAndAssertCapabilities`, the `composedForLowering` value in
`src/compile/pipeline.ts`). It MUST serialize only results that already exist; it
MUST NOT trigger a compose refactor or recompute grants independently (roadmap
risk 2: "serialize existing results only; no compose refactor in WS1").

### 2.1 Per-target compile, whole-fleet manifest (read-merge-write)

`compilePluginForTarget` runs once per `(target, scope)`. `ComposedAgent`
including its per-harness `model` resolution and `allowedTools`/`allowedSkills`
allowlists is therefore computed **per target**. The manifest spans all
harnesses, so the writer MUST perform a deterministic **read-merge-write** keyed
by `(plugin, agentName)`:

- Load the existing manifest if present and version-compatible (§7); otherwise
  start empty.
- For the agent entries produced by this compile, replace the **per-harness
  slice** for this `target` (model resolution, allowlists) and union `target`
  into the agent's `compileTargets` set.
- For this same `target`, remove the target slice from any prior agent entry
  that is not present in the current compile result. If an agent has no remaining
  `perTarget` slices after removal, remove the agent entry entirely.
- Recompute top-level `compileTargets` from actual `perTarget` coverage after
  pruning; it is never an append-only union.
- Recompute the agent's `manifestHash` from the merged entry (§5.6).
- Sort and write atomically (§4).

A single `prism refresh` over a multi-target project therefore converges on a
manifest carrying every compiled harness. Recompiling one target updates only
that target's slice and the affected agents' hashes; untouched slices stay
byte-stable unless pruning removes now-retired entries. The writer is serialized
by the same project/run lock discipline as other Prism state writes; concurrent
manifest writers must not interleave read-merge-write cycles.

### 2.2 Determinism

Like the snapshot, the manifest MUST be deterministic so converged recompiles
produce byte-identical files and `manifestHash` values are reproducible:

- All maps serialized as JSON objects with keys sorted by Unicode code point
  order over NFC-normalized strings; all arrays sorted by a stable documented
  key. Locale-sensitive comparison is forbidden.
- Use the shared canonical-JSON discipline exported by
  `@skastr0/prism-core/stable-json` (`stableJsonStringify` /
  `stableJsonHash`). The manifest schema and hashes MUST hash through that same
  canonicalizer. `src/compile/cache.ts` remains the legacy cache fingerprint
  surface until it is separately migrated; manifest content must not depend on a
  locale-sensitive string sort.
- No timestamp or local machine field belongs in the manifest. If humans need
  timing diagnostics, the CLI prints them or records them in the run output, not
  in this deterministic policy file.

## 3. Location

```
.prism/state/compile-manifest.json
```

One file per project, alongside the snapshot's `.prism/state/` home. Path
resolution threads from the CLI edge (`prismHome` / project root), never from an
env fallback, consistent with `CompileOptions.prismHome`.

## 4. Regeneration & disposable-derived-state posture

The manifest is **derived state with a durable retention policy** — a deliberate
middle position between the two existing tiers, and the subtlest part of this
contract:

- **Source of truth remains plugin source + `prism compile`.** The manifest is a
  serialization of compose results. It is fully reconstructible by recompiling
  every target. It is never hand-authored project state.
- **Unlike the snapshot, it is retained, not treated as a throwaway cache.** The
  snapshot answers "may I skip this write?" and converges trivially on refresh.
  The manifest is an **audit anchor**: AgentRun resources reference its hashes,
  so a deleted manifest loses the ability to *re-verify historical authorizations
  by hash* until regenerated. Regeneration restores verifiability for current
  source; it does not retroactively re-prove a past world (that lives in the
  ledger's recorded hashes).
- **Absent or stale manifest is a typed, recoverable condition, never a crash.**
  If the manifest is missing or too old, Prism regenerates it by recompiling. If
  a workflow run cannot prove the `manifestHash` it was authored against, class-A
  live dispatch MUST refuse with a typed remediation. Historical AgentRuns may
  still be inspected as past labor, but new provider dispatch does not proceed
  without manifest-backed policy subsumption.

Atomic write: write to a temp path and rename, matching the sync engine's
atomic-write discipline, so a crashed writer never leaves a half-written
manifest the gate would reject.

Posture summary: **derived (regenerable), single-writer, durable (retained as an
audit anchor), disposable-on-demand (safe to delete; recompile rebuilds).**

## 5. Schema (v1)

Top-level shape. Encoded via an Effect `Schema.Struct` in `@skastr0/prism-core`,
decoded with `Schema.decodeUnknownEither(Schema.parseJson(...))`, mirroring
`src/state/snapshot.ts`. The schema is a **versioned union**; v1 is the only
member today.

```jsonc
{
  "version": 1,
  "plugins": { /* §5.2 */ },
  "compileTargets": [ /* §5.3 */ ],
  "agents": { /* §5.4 */ },
  "manifestHash": "sha256…"                    // §5.6, hash of {plugins, compileTargets, agents}
}
```

### 5.1 `version`

- `version`: `Schema.Literal(1)`. Decode failure on any other value is the
  versioning contract (§7), not a parse bug.
- There is deliberately no `compiledAt`. The manifest is byte-deterministic
  across converged recompiles. Timing diagnostics live in CLI output or
  workflow-run events, not in the compile policy anchor.

### 5.2 `plugins` — plugin provenance (Source tier anchor)

Keyed by plugin name. Records the source identity each composed agent was built
from, so the gate can cheaply detect that a plugin's source moved.

```jsonc
"plugins": {
  "demo": {
    "version": "1.4.0",          // from PluginRegistry.pluginVersion (optional)
    "sourceHash": "sha256…"      // stable hash over the plugin's contributing source files
  }
}
```

`sourceHash` MUST be derived from the same `CacheInputFile` content hashes the
compile cache already computes (`computeContentHash` over file bytes), aggregated
deterministically. It is the manifest's Source-tier anchor; it is distinct from
any agent's `manifestHash` (Compile tier).

### 5.3 `compileTargets` — what was compiled, for which surface

The set of `(harness, scope)` pairs this manifest covers, so a reader knows the
manifest's coverage without scanning every agent.

```jsonc
"compileTargets": [
  { "harness": "claude-code", "scope": "global" },
  { "harness": "grok",        "scope": "project" }
]
```

`harness` is a `HarnessId` from the existing target vocabulary
(`src/compile/pipeline.ts` `SUPPORTED_TARGETS`). Sorted by
`(harness, scope)`. A target appears here iff at least one agent has a slice for
it.

### 5.4 `agents` — composed agent entries

Keyed by **canonical agent id** `"<plugin>:<agentName>"` (e.g. `"demo:builder"`),
matching the `agents["demo:builder"]` form used throughout `05`. Each entry:

```jsonc
"demo:builder": {
  "name": "builder",
  "plugin": "demo",
  "description": "…",                 // surfaces in refs/tsc errors
  "sourceHash": "sha256…",            // = AgentCacheDescriptor.sourceHash (agent + resolved refs)
  "traits": [ /* §5.5 */ ],
  "skills": ["demo:explore", …],     // recommended skills (composed.skills)
  "composed": {
    "grants": { /* §5.5 */ },
    "modelBindings": { /* §5.5 */ },
    "perTarget": { /* §5.5 */ }
  },
  "manifestHash": "sha256…"           // §5.6, hash of this entry minus manifestHash
}
```

`sourceHash` MUST equal the `AgentCacheDescriptor.sourceHash` already computed by
`computeAgentCacheDescriptor` (`src/compile/cache.ts`) — the hash over the agent
source plus all resolved references (identity, personality, model, traits, tools,
toolspaces, skillspaces). Reusing it keeps the Source tier single-sourced; the
manifest MUST NOT invent a parallel agent-source hash.

### 5.5 Traits, tools, model bindings, grants (the policy surface)

This is the load-bearing section: it is what layer-5 subsumption reads.

**`traits`** — the expanded trait set that contributed grants, recorded so a
`PolicyViolation` can name "the trait that would provide it" (`05`):

```jsonc
"traits": [
  { "id": "demo:writes-code", "ref": "writes-code" }
]
```

`id` is the canonical trait id `"<ownerPlugin>:<traitName>"`
(`ResolvedTrait.canonicalId`). Sorted by `id`.

**`composed.grants`** — the resolved, harness-agnostic capability surface. These
are the *logical* grants; per-harness allowlists live in `perTarget` (below).

```jsonc
"grants": {
  "tools": [
    "demo:workspace-tools/run_shell",   // canonical tool refs, sorted
    "demo:fs-tools/read_file"
  ],
  "skills": ["demo:explore", "demo:review"]   // grantable skills, sorted
}
```

Tool grants MUST be expressed as **canonical tool references**, derived from each
`ResolvedContractBinding` as `"<toolPluginName>:<toolName>"` (or the
toolspace-qualified `"<plugin>:<toolspace>/<tool>"` form already used in refs).
See §6 for why these are tool refs and not transport names.

**`composed.modelBindings`** — the resolved modelspace binding, harness-agnostic
identity plus per-harness resolution:

```jsonc
"modelBindings": {
  "modelspace": "demo:default",   // the modelspace ref, if any
  "profile": "balanced"            // selected profile, if the source declares one
}
```

The concrete resolved model block per harness (the `resolvedModel` Record that
`composeAgent` carries) lives in `perTarget`, because model resolution is
target-specific (e.g. opencode pool strategy, claude-code block shape per
`resolve.ts`).

**`composed.perTarget`** — the per-harness resolved slice, keyed by `HarnessId`:

```jsonc
"perTarget": {
  "claude-code": {
    "scope": "global",
    "model": { /* resolvedModel Record for this harness, or null */ },
    "toolGrants": ["demo:workspace/run_shell"],       // canonical tool refs active in this slice
    "allowedTools": ["run_shell", "read_file"],   // composed.allowedTools, sorted
    "allowedSkills": ["explore", "review"]        // composed.allowedSkills, sorted
  },
  "grok": { … }
}
```

`toolGrants` records the canonical tool refs that contributed to this target
slice. `allowedTools` / `allowedSkills` are the per-harness allowlists
`composeAgent` already emits (`ComposedAgent.allowedTools`, `.allowedSkills`).
The top-level `composed.grants` is recomputed as the union of the remaining
`perTarget[*].toolGrants` and `perTarget[*].allowedSkills` after every merge or
prune. It is never last-target-wins and never append-only. Subsumption for a
dispatch to harness H reads `agents[id].composed.perTarget[H]` for target
coverage, then checks requested canonical tools against `composed.grants.tools`.
An agent with no slice for H was not compiled for H; the gate MUST treat a
dispatch to H as **uncompiled-target** and refuse (distinct from a policy
violation).

`installs` for the refs emitter (`WorkflowAgentRef.installs`) is exactly
`Object.keys(perTarget)`.

### 5.6 Content hashes & `manifestHash`

Two hash scopes, both via the canonical stringifier (§2.2):

- **Per-agent `manifestHash`** = `computeStableHash(entry)` over the agent entry
  with its own `manifestHash` field omitted. This
  is the value a `WorkflowAgentRef.manifestHash` binds to and the gate compares.
  It MUST change iff the agent's composed policy surface, grants, model bindings,
  per-target slices, traits, or `sourceHash` change.
- **Top-level `manifestHash`** = `computeStableHash({ plugins, compileTargets,
  agents })` with each agent entry already carrying its per-agent hash. A
  whole-file integrity anchor; the ledger MAY record it for a workflow run's
  global compile fingerprint.

## 6. No MCP coupling (normative)

Earlier sketch (`01`) showed a `grants.mcpServers: { "prism-generated-demo":
[…] }` shape. v1 **rejects** that. The manifest MUST NOT contain MCP server
names, generated server identifiers (`generatedMcpServerName`), exposure profiles
(`mcpExposureProfileForTarget`), bearer tokens, ports, or any MCP transport
detail.

Rationale (simplicity / policy-vs-mechanism, per the braids doctrine):

- **Policy is "which tools/skills may this agent use."** That is the grant. It is
  expressed as canonical tool refs (§5.5), which are stable across harnesses.
- **MCP is one lowering/transport** for those tools on some harnesses. Whether a
  tool reaches a harness as a generated MCP server, a native tool, or a CLI shim
  is a mechanism decided per target by the lowerers and recorded in the
  **snapshot** (install tier), not the policy surface.
- Baking MCP server names into the durable policy record would braid policy with
  transport: a transport rename or a harness that exposes the same tool natively
  would spuriously churn `manifestHash` and break subsumption that should be
  transport-agnostic.

Subsumption therefore checks `needs.tools ⊆ composed.grants.tools` using
canonical tool refs. Mapping a granted tool to its concrete MCP tool name on a
given harness is the gateway/lowerer's job at dispatch, off the manifest.

## 7. Compatibility & versioning

- `version` is an integer major. The reader decodes the versioned union and, on
  an **unknown major**, fails closed with a typed error ("compile manifest
  version N unsupported; re-run `prism refresh`") — matching `06`: "The compile
  manifest is versioned independently; gate refuses unknown major."
- No compatibility layers in the single-user phase (consolidation stance):
  breaking schema changes bump the major and regenerate via recompile. Version
  stamps exist from day one so refusals are typed, not mysterious.
- The manifest version is **independent** of: `SNAPSHOT_MANIFEST_VERSION`, the
  refs emitter version, the ledger/event `v`, and `CACHE_FORMAT_VERSION` /
  `COMPILER_SEMANTICS_VERSION`. A compiler-semantics bump that changes composed
  output changes `manifestHash` values (correctly invalidating stale refs)
  without necessarily bumping the manifest schema major.
- Forward-incompat is one-directional: an older `prism-workflow` MUST refuse a
  newer-major manifest rather than partial-read it.

## 8. Cross-package reader expectations

The schema and a pure reader live in `@skastr0/prism-core` (`06` package map: "No
CLI deps"). Reader contract:

- **Pure decode + typed accessors, no I/O policy.** The reader exposes
  `decodeCompileManifest(json) → Either<DecodeError, CompileManifest>` and
  accessors: `getAgent(manifest, "demo:builder")`,
  `getAgentForTarget(manifest, id, harness)`, `verifyManifestHash(entry)`.
- **No `prism/src/*` imports anywhere in the consumer.** The WS1 exit criterion
  (`01`, `07`): "An external bun script consumes `@skastr0/prism-core` (load
  registry, read manifest, verify a hash) without importing `prism/src/*`." This
  reader MUST satisfy that script.
- **Readers treat the manifest as read-only.** Only the CLI writer (§2) mutates
  it. `@skastr0/prism-workflow` reads it for gate layers 3/5 and never writes.
- **Hash verification is the reader's, recompilation is the CLI's.** The reader
  can prove an entry's `manifestHash` is self-consistent and compare a ref's hash
  against it; it cannot and must not recompile to "fix" a mismatch — that is the
  CLI's regeneration path (§4).
- **Unknown keys.** Decode is strict on v1 required fields; the reader MUST NOT
  silently accept a newer major by ignoring fields (§7).

## 9. Golden tests (acceptance)

The following MUST be green before WS2 consumes the manifest. They are the
draft-acceptance gate from `09` ("Compile manifest v1 schema drafted") promoted
to executable contract.

1. **Determinism / byte-stability.** Compile the deterministic fixture plugin
   (`07` WS1.6) twice; the manifest is byte-identical and all `manifestHash`
   values match.
2. **Grants reflect compose, verified against lowered output.** For the fixture
   (and a representative fixture), every `composed.grants.tools` / `allowedTools` entry corresponds
   to what the lowerers actually installed for that harness (`01` AC: "composed
   grants for a real plugin or fixture, verified against what the lowerers actually
   installed"). No grant present that the agent cannot use; no usable tool
   missing.
3. **Per-target merge.** Compile target A, then target B for the same project;
   the agent entry carries both slices under `perTarget`, `compileTargets` lists
   both, and recompiling A leaves B's slice byte-stable.
4. **Per-target prune.** Delete or stop compiling one fixture agent for target A;
   recompiling A removes A's stale slice, removes the agent if no slices remain,
   and recomputes `compileTargets` from remaining coverage.
5. **Hash sensitivity.** Mutating a trait's tool grant changes the affected
   agent's `manifestHash` and the top-level hash; recompiling unchanged inputs
   changes neither file bytes nor hashes.
6. **Subsumption fixtures.** `needs.tools ⊆ grants.tools` passes; a `needs`
   requesting a tool outside grants fails with a violation naming the missing
   grant and the providing trait (`05`); a dispatch to a harness absent from
   `perTarget` fails as uncompiled-target.
7. **No MCP identifiers.** A structural assertion that the serialized manifest
   contains no MCP server name, exposure profile, bearer token, or port (§6) —
   echoing `01` AC "No Tower/board identifiers anywhere in generated output,"
   extended to transport identifiers.
8. **Versioning refusal.** A manifest with an unknown major decodes to a typed
   refusal, not a partial read or throw.
9. **Cross-package reader.** An external bun script importing only
   `@skastr0/prism-core` decodes the manifest, reads an agent entry, and verifies
   a `manifestHash` — with a test asserting no `prism/src/*` import in its
   dependency graph.
10. **Source-hash single-sourcing.** Each agent entry's `sourceHash` equals the
   `AgentCacheDescriptor.sourceHash` from the cache path for the same input, so
   the Source tier is not duplicated.
