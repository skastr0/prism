# 01 — Type System, Codegen, and Provenance

The entire product promise rests on this layer: generated types that carry
provenance from Prism-managed sources into workflow authoring.

## Provenance tiers (do not conflate)

| Tier | Anchor | Lifetime | Used for |
|---|---|---|---|
| **Source** | sha256 of plugin source files, plugin name/version | as long as source exists | ref identity at codegen time |
| **Compile** | the **compile manifest** (new, durable): composed agents with resolved grants, model bindings, content hashes | per compile, durable artifact | gate: provenance + policy subsumption |
| **Install** | snapshot manifest entries per harness root (existing, disposable) | until next sync | gate: attestation ("is it actually installed where this task will run") |

Workflow refs bind at **compile** provenance. The install snapshot is a
disposable cache by design (deleted snapshot converges on next refresh) — refs
must not derive identity from it. Install state is checked at dispatch time as
attestation, not baked into refs.

Workflow refs also do **not** expose plugin source paths. Plugin source files are
compiler inputs, not workflow authoring or runtime inputs. The workflow surface
gets the falsifiable compile pointers (`sourceHash`, `manifestHash`, plugin name,
agent name, and install coverage) and never needs to inspect the source tree that
produced them.

## The refs emitter

A new **project-level emit target** on the existing sync engine. It is
lowerer-shaped (pure: registry → `DesiredFile[]`) but targets the project root,
not a harness root. This resolves the "is workflows just another lowerer"
question: the emitter reuses the sync machinery (atomic writes, drift repair,
prune, snapshot tracking); the runtime is a separate consumer and lowers nothing.

Output layout (per project, via `prism refresh` or a dedicated `prism workflows
gen`):

```
.prism/generated/
  workflows/
    agents.ts        # one literal-typed const per agent, per plugin
    models.ts        # modelspace profiles with per-harness resolutions
    schemas.ts       # workflow-declared schemas (later: agent I/O contracts)
    manifest.ts      # compile manifest hash + codegen metadata
```

Generated ref shape (POC-validated; extended):

```typescript
export interface WorkflowAgentRef {
  readonly kind: "agent-ref";
  readonly plugin: string;
  readonly name: string;
  readonly description: string;       // surfaces in tsc errors — fleet docs via compiler
  readonly sourceHash: string;        // sha256 of agent source at codegen
  readonly manifestHash: string;      // hash of this agent's composed entry in the compile manifest
  readonly model?: WorkflowModelRef;  // resolved modelspace binding
  readonly installs: ReadonlyArray<HarnessId>;  // harnesses this agent was compiled for
}
```

Design rules:

- `as const satisfies Record<string, WorkflowAgentRef>` — literal types
  everywhere; `agents.explorer.name` is the literal `"explorer"`.
- Key casing: camelCase of the agent name (`codebase-archeologist` →
  `codebaseArcheologist`).
- One module per plugin namespace under `agents.<plugin>.<name>` when multiple
  plugins are in scope; flat `agents.<name>` for single-plugin projects.
  (Open question 1 from the signal — resolved: nest by plugin, with a flat
  re-export when unambiguous.)
- Generated files carry the standard prism managed-file header and are
  snapshot-tracked: editing them by hand shows as drift and gets repaired.

## The compile manifest (new durable artifact)

Today nothing durable records "what was compiled" — only what was installed
(disposable snapshot). The gate needs a stable record of **composed** agent
state, because policy subsumption operates on composed grants (traits expanded,
toolspace access resolved, per-harness allowlists computed), which exist only
inside the compile pipeline's compose phase today.

This is intentionally **derived state**, not a second writer. The source of
truth remains plugin source + prism compile. If the manifest is absent or too
old, Prism can regenerate it; if a workflow run cannot prove the manifest hash it
was authored against, class-A live dispatch refuses with a typed remediation.
Historical AgentRuns may still be inspected as past labor, but new provider work
requires manifest-backed policy subsumption. The manifest is durable because AgentRun
resources need to record exactly which composed policy surface authorized them;
it is not hand-edited project state.

`prism` writes, on every compile:

```
.prism/state/compile-manifest.json
{
  "version": 1,
  "plugins": { "<name>": { "version": "...", "sourceHash": "..." } },
  "agents": {
    "demo:builder": {
      "sourceHash": "...",
      "composed": {
        "model": { "modelspace": "...", "profile": "...", "perHarness": { ... } },
        "grants": {
          "tools": ["demo:workspace-tools/run_shell", ...],
          "skills": [...]
        },
        "harnesses": ["claude-code", "grok", "codex-cli", "antigravity-cli"]
      },
      "manifestHash": "sha256 of the composed entry above"
    }
  }
}
```

Implementation note: the compose phase (`src/compile/pipeline.ts`,
`composeAgent`) already computes all of this; the manifest is a serialization of
results that are currently thrown away after lowering. Estimated as an additive
change, not a refactor.

## Agent I/O contracts (the deeper move — phased)

Phase 1 (WS2): output schemas are declared at the workflow call site
(`output: Exploration`), as in the POC.

Optional Phase 1.5 (cheap insurance): `AgentSource.contracts.output` may be
introduced as a hashed declaration before inference is wired. The runtime can
record "call-site schema matched/mismatched the agent-declared contract" without
making it a hard dependency. This avoids a migration cliff if early workflows
start depending on conventional output shapes.

Phase 2 (WS5): `AgentSource` gains optional declared output contracts:

```typescript
export default defineAgent({
  name: "explorer",
  ...
  contracts: {
    output: schemaRef("forge", "exploration"),   // Effect Schema, compiled + hashed
  },
});
```

Then `wf.agentRun("explore", agents.explorer, ...)` **infers** its result type from the
agent definition; mispairing agent and schema becomes impossible; the schema
ships with the installed artifact so the harness-side agent knows its own
contract. This is a prism-core source-contract change and is deliberately
sequenced after the workflow package proves the call-site model.

## Orbit-compiled workflow skeletons (WS5)

`OrbitSource` already declares phases, per-phase agents, and handoff intent. A
second project-level emitter compiles each orbit to a typed skeleton:

```typescript
import { orbits } from "../.prism/generated/workflows/orbits.js";

const mission = orbits.forge.mission({
  goal: "...",
  schemas: { explore: Exploration, build: PatchReport, review: ReviewVerdict },
});
```

The skeleton pre-binds phase order and agent slots from the orbit definition;
the author supplies goal and phase schemas (until agent I/O contracts make even
those inferable). The orbit stops being documentation-shaped and becomes
executable.

## prism-core extraction (precondition, WS1)

The workflow package must not import `prism/src` internals. Extract
`@skastr0/prism-core` (workspace package first, npm boundary later):

- source contracts + ref types + helper constructors (`src/index.ts`)
- Effect Schema source validators (`src/compile/sources.ts`)
- `loadPlugin` + `PluginRegistry` (`src/compile/load.ts`, `registry.ts`)
- snapshot manifest codecs (`src/state/snapshot.ts`)
- harness/scope/artifact type vocabulary (`src/types.ts`, `source-selection.ts`)
- NEW: compile manifest schema + reader

Audit (2026-06-11) found these have no CLI entanglement. The CLI consumes the
extracted package — single source of truth, no duplication.

## Acceptance criteria (this layer)

- [ ] Refs regenerate through the sync engine and appear as snapshot entries;
      hand-edits show as drift and repair.
- [ ] `bunx tsc --noEmit` on a workflow importing generated refs: unknown agent
      and mistyped handoff each produce a compile error naming the real fields.
- [ ] Compile manifest written on every compile; contains composed grants for a
      real plugin or fixture, verified against what the lowerers actually installed.
- [ ] An external bun script consumes `@skastr0/prism-core` (load registry,
      read manifest, verify a hash) without importing `prism/src/*`.
- [ ] No Tower/board identifiers anywhere in generated output.
