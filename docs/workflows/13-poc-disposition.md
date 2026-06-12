# 13 — POC Disposition and Implementation Extraction

This document preserves the useful evidence from the local `poc/workflows/`
experiment so the POC folder can be deleted before production workflow code
starts. The POC was proof, not scaffolding. Real implementation must absorb the
lessons below into `@skastr0/prism-core`, `@skastr0/prism-workflow`, and the
CLI without copying the disposable dispatcher shape.

## What the POC proved

### 1. Prism registry data can become literal TypeScript refs

POC artifact: `poc/workflows/codegen.ts` and
`poc/workflows/generated/refs.ts`.

The POC loaded the Forge plugin through Prism's compile loader, read the agent
registry, hashed each agent source file, and emitted an `agents` object whose
properties were literal-typed. That made agent references inspectable by `tsc`:
mistyping `agents.simplicityReviewer` as `agents.simplicityRevewer` failed at
author time and surfaced the real agent names and descriptions in the compiler
error.

Real destination:

- WS1.1 extracts the registry/contracts into `@skastr0/prism-core`.
- WS1.2 serializes the compile manifest that owns hashes, grants, model
  bindings, and install provenance.
- WS1.3 emits generated workflow refs through Prism's sync/managed-file engine,
  not an ad hoc script.

Discarded POC shape:

- direct writes into `poc/workflows/generated/`;
- direct source hashing as the only provenance source;
- hard-coded local plugin path (`~/Projects/prism-plugins/forge`).

### 2. Effect Schema handoffs make phase boundaries type-checkable

POC artifact: `poc/workflows/forge-mission.workflow.ts`.

The POC declared `Exploration`, `PatchReport`, and `ReviewVerdict` as Effect
Schemas and used decoded values to construct downstream prompts. Mistyping a
field such as `exploration.assumption` caused a TypeScript error before any
worker process could run.

Real destination:

- WS2.1 introduces the public workflow authoring envelope and `defineWorkflow`.
- WS2.4 introduces `wf.agentRun`, `wf.useRun`, and `wf.forkRun` as resource
  primitives.
- WS2.12 keeps runtime boundary validation: provider-side structured output is
  an optimization, while client-side `Schema.decodeUnknown` remains mandatory.

Discarded POC shape:

- task results as plain decoded values only;
- `dispatchTask` as the central abstraction;
- no durable `AgentRun<A>` resource wrapper with refs, lineage, provenance, and
  transcript pointers.

### 3. Gate-before-dispatch is practical

POC artifact: `poc/workflows/runtime.ts` and `poc/workflows/gate-demo.ts`.

The POC checked source-hash provenance and target-harness artifact presence
before invoking provider CLIs. A doctored source hash failed before dispatch,
proving the product promise is mechanically reachable: no provider token should
be spent past an unverified ref.

Real destination:

- WS1.2/WS1.3 provide manifest-backed refs and generated types.
- WS2.6 ports provenance, attestation, and output decode errors into production
  typed errors.
- WS2.7 adds policy subsumption against the compile manifest.

Discarded POC shape:

- checking only a live source hash and filesystem artifact;
- no compile-manifest policy layer;
- no capability-grant proof;
- no class-A fail-closed manifest requirement.

### 4. Multiple harnesses can be driven from one typed ref shape

POC artifact: `poc/workflows/hello.workflow.ts` and `poc/workflows/runtime.ts`.

The POC sketched dispatch to Grok, Claude Code, and Codex CLI from the same
agent ref. It also proved the adapter contracts are not identical: Claude has a
named-agent call shape, Grok used an installed artifact path, and Codex needed a
projection of agent identity into the prompt/config path.

Real destination:

- WS2.9 defines the worker gateway interface and subprocess hygiene.
- WS2.10 implements adapters only after fake-worker replay is proven.
- WS3.2/WS3.3 deepen structured-output and Antigravity support from live
  verification.

Discarded POC shape:

- ad hoc command arrays embedded in a runtime file;
- fixed Grok `--max-turns 8`;
- temp-file Codex output handling without a ledger;
- JSONL journal as runtime state.

### 5. Forge-shaped orchestration can remain ordinary TypeScript

POC artifact: `poc/workflows/forge-mission.workflow.ts`.

The POC implemented explore → build → parallel review → fix-round logic as an
ordinary Effect program. The useful lesson is not the exact code; it is that the
workflow language can be TypeScript control flow with typed resource primitives
at the boundaries.

Real destination:

- WS2 runtime primitives own caching/reuse, dependency refs, and replay.
- WS5 compiles orbit source into workflow skeletons such as
  `orbits.forge.mission(goal)`.

Discarded POC shape:

- workflow-local task ids as the only identity;
- no semantic fingerprint;
- no resource reuse across workflow edits;
- no SQLite AgentRun ledger.

## What the POC did not prove

The POC must not be copied as production architecture because it did **not**
prove:

- durable AgentRun resources;
- SQLite schema, migrations, locks, or crash recovery;
- semantic fingerprint stability;
- stable-key revision behavior;
- dependency refs/reactive invalidation;
- compile manifest policy subsumption;
- full install attestation against manifest-backed generated artifacts;
- detached supervision;
- worktree/sandbox isolation;
- adapter lifecycle safety;
- class-B Hermes profile dispatch;
- Antigravity headless behavior;
- session fork/continuation semantics;
- budget accounting;
- approvals;
- production structured-output capability detection.

## Commands that constituted the POC proof

The useful proof commands were:

```sh
bunx tsc --noEmit --strict --target esnext --module preserve --moduleResolution bundler --allowImportingTsExtensions \
  poc/workflows/hello.workflow.ts \
  poc/workflows/forge-mission.workflow.ts \
  poc/workflows/gate-demo.ts \
  poc/workflows/runtime.ts \
  poc/workflows/generated/refs.ts

# deliberate breakage proved author-time failures:
# - exploration.assumption -> exploration.assumptions
# - agents.simplicityReviewer -> agents.simplicityRevewer
```

The POC also produced disposable run journals under `poc/workflows/runs/`. Those
files are not part of the durable design and should not be preserved.

## Artifact disposition

| POC artifact | Preserve as | Real implementation destination | Disposition |
|---|---|---|---|
| `codegen.ts` | registry-to-ref emitter proof | WS1.3 refs emitter through sync engine | Delete |
| `generated/refs.ts` | literal typed ref shape proof | generated `.prism/generated/workflows/refs.ts` | Delete |
| `runtime.ts` | gate/adapters/decode sketch | WS2.6, WS2.9, WS2.10 | Delete |
| `hello.workflow.ts` | three-harness smoke shape | WS2.10 adapter tests after fake gateway | Delete |
| `gate-demo.ts` | tampered ref fail-closed proof | WS2.6 gate tests | Delete |
| `forge-mission.workflow.ts` | typed orbit-shaped workflow proof | WS5 orbit skeleton compiler | Delete |
| `runs/*.jsonl` | none | SQLite events/attempt tables | Delete |

## Implementation warning for swarms

Do not start by "productionizing" `poc/workflows/runtime.ts`. That path recreates
a better dispatcher and misses the product wedge. The first runtime milestone is
not "run a worker"; it is **replay an edited workflow against a SQLite AgentRun
ledger without re-spending completed upstream work**.

The mandatory order remains:

1. WS1 types/provenance/manifest/ref emission.
2. WS2 fake-worker AgentRun ledger and semantic fingerprint replay.
3. Only then: real Claude/Grok/Codex/Antigravity adapters.

## Deletion decision

The POC folder is safe to delete once this document lands. All durable facts are
now in the docs set, and every POC artifact has a planned destination or a
discarded status.
