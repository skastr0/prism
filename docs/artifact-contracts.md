# Per-artifact-kind contract laws (PQ-162)

Prism core owns the **shape** (contract/type) of every artifact kind a
plugin can carry. The **data** is user-aligned and lives in 0..n userland
plugins in the dependency graph; core ships no default data (AGENTS.md
invariant 1). Multiple plugins may carry the same artifact kind only where
that kind's contract declares a dedupe-and-merge law. Where no merge law is
sensible, the law is **crash**: a plan/validate-time hard error naming both
plugins — never silent last-writer-wins (AGENTS.md invariant 2).

This table is the single place that law is enumerated per kind. It is a
description of enforcement that already exists in code (grep the file:line
refs to verify), not a design proposal — see PQ-162's own acceptance
criteria: "no merge implementations ahead of a second producer."

## Law table

| Kind | Identity key | Law | Enforcement | Status |
|---|---|---|---|---|
| **rules** | `(targetPath, regionKey)` inside a shared file (`AGENTS.md`, `config.toml`, …) | **merge** — fenced region per plugin, keyed by marker | `src/sync/plan.ts` `planSharedFileRegions` (region read-modify-write) + `src/sync/regions.ts` (`applyRegion`/marker grammar) | shipped, tested (`src/sync/sync.test.ts` "shared-file regions") |
| **commands** | `targetPath` (bare filename for direct-install harnesses; namespaced path inside a generated bundle otherwise) | **namespace-by-construction** where bundled (Claude/Antigravity/Grok/Factory/Kimi/Amp/Pi generated plugin dirs); **crash** on the bare direct-install path (OpenCode, Codex prompts, Factory `.factory/commands/`, Cursor generated-command-plugin) | `src/refresh.ts` `addCommandsForHarness` → owned `DesiredFile` → `src/sync/plan.ts` `assertNoPathConflicts` (same-call) + `assertNoForeignOwnerConflicts` (cross-call, PQ-162) | shipped; cross-call guard closed by PQ-162 (same mechanism as skills below) |
| **agents** | `targetPath` (bare `agents/<name>.md` for Pi/OMP direct-file surfaces; namespaced path inside a generated bundle for every other compile target) | **namespace-by-construction** where bundled (Claude/Antigravity/Grok/Factory/Kimi/OpenCode/Cursor-tools-only/Devin generated plugin dirs); **crash** on the bare direct-file surfaces (Pi `agents/<name>.md`, OMP `agents/<name>.md`) | `src/compile/lowerers/pi.ts` `planAgentWrites` / `src/compile/lowerers/omp.ts` emit an owned `DesiredFile` per agent → same `plan.ts` guard pair as commands/skills | shipped; cross-plugin bare-name crash proven at `src/compile/pi-ownership.test.ts` ("two plugins compiling a same-named agent to Pi's direct agent surface fail closed, naming both plugins") |
| **tools** (canonical `tools/*.tool.ts`) | wire tool name on the rendered MCP/native-registerTool surface | **namespace-by-construction** — every lowerer bundles canonical tools per source plugin (`<PRISM_HOME>/runtime/mcp/<source-plugin>/server.mjs`, or a per-plugin generated extension/package); **crash** as backstop if two tools still render the same bare wire name | `packages/prism-sdk/src/mcp/wire-naming.ts` `assertUniqueBareTools` (throws) + `src/compile/mcp-bundle.ts` generated-contract-name-collision throw | shipped, tested (`packages/prism-sdk/src/mcp/wire-naming.test.ts` `assertUniqueBareTools` describe block) |
| **skills** | `targetPath` (bare `skills/<name>/…` for direct-install harnesses; namespaced path inside a generated bundle otherwise) | **namespace-by-construction** where bundled; **crash** on the bare direct/shared install path (Claude Code `~/.claude/skills/`, OpenCode, Codex, OpenClaw, Hermes, Cursor `.cursor/skills/`, Factory `.factory/skills/`, Grok `~/.grok/skills/`, OMP) | `src/refresh.ts` `addSkillsForHarness` → owned `DesiredFile` → `src/sync/plan.ts` `assertNoPathConflicts` (same-call, PQ-156) + `assertNoForeignOwnerConflicts` (cross-call, PQ-162 — closes the gap this glyph's Notes named as the known suspect) | shipped; cross-plugin bare-name crash proven at `src/sync/sync.test.ts` "cross-plugin ownership guard (PQ-162)" |
| **MCP servers** | wire server key (`pluginServerKey(plugin)`) and per-tool wire name on a shared Streamable HTTP bundle or config entry | **namespace-by-construction** — per-plugin bundle directory + prefixed wire names; bare-name-collision **crash** as backstop | `packages/prism-sdk/src/mcp/wire-naming.ts` (`pluginServerKey`, `bareWireToolName`, `assertUniqueBareTools`) | shipped, tested |
| **hooks** | one fenced region per (native event, plugin) inside a shared native hook config (Codex/Kimi `config.toml`), or a namespaced path inside a generated bundle otherwise | **merge** — one region per plugin per concern; native array-of-tables/array syntax lets multiple plugins' fenced blocks accumulate under the same logical event key without a shared-value merge step | `src/compile/lowerers/codex-cli.ts` `planConfigRegions` (`codex.hooks.<plugin>` marker region) / `src/compile/lowerers/kimi-code.ts` `hooksConfigRegion` | shipped (the "claude/codex pattern" the ratifying comment names); region collision itself still goes through the same `assertNoPathConflicts`/`assertNoForeignOwnerConflicts` pair when two regions ever target the same fence key |
| **modelspaces** | `(modelspace, profile, harness)` cell | **merge** by cell — declared law, no second producer yet | none built yet — correct per PQ-162 non-goals ("do NOT build merge machinery for kinds with no second producer yet"); revisit when a second plugin actually contributes bindings to the same modelspace | declared, not yet exercised |
| **workflows** | the compiled artifact ref (`agents.*`, `tools.*`, `traits.*`, …) generated into `.prism/generated` | **single representation** — harness lowering and workflow-ref generation must read the *same* compiled registry surface, never diverge (AGENTS.md invariant 3) | `src/compile/workflow-refs-emitter.ts` reads the same `registry.ts` / `workflow-catalog.ts` surface compile lowering reads, rather than re-deriving a second view | shipped (closed by PQ-154's amp-mode/modelspace unification) |

## Reading the "crash" rows

Two structurally different collision classes both resolve to the ratified
"agents and tools = crash" / "skills = crash on the bare-name install path"
law, and both are enforced by the **same** pair of guards in
`src/sync/plan.ts`:

- `assertNoPathConflicts` (PQ-156) — same-call guard. Fires when two
  different plugins' files (or a file and a region) appear together in one
  `planSync` call's `desired.files`/`desired.regions`. This is the shape
  every existing PQ-156 test exercises.
- `assertNoForeignOwnerConflicts` (PQ-162) — cross-call guard. Every real
  caller (`refresh.ts`, `compile/pipeline.ts`) scopes one `planSync` call to
  exactly one plugin (`scopePlugins` is always a singleton), so a genuine
  two-plugin bare-name collision — the actual shape of "two plugins ship
  `skills/debugging/SKILL.md`" or "two plugins each compile an agent named
  `builder` to Pi" — never appears within one call. It only appears across
  two sequential, differently-scoped calls, once plugin A has already
  written the path. Before this guard, that second call fell through
  `planOwnedFile`'s generic foreign-file classification (`blocked`,
  "a file Prism has never managed already exists here") — both factually
  wrong (the path IS Prism-managed, by plugin A) and silent about which two
  plugins collided. It also fixes a strictly worse pre-existing hole: under
  `--overwrite`, that same fall-through previously **silently repaired**
  (with backup) rather than blocking at all — an actual silent-last-writer.
  `assertNoForeignOwnerConflicts` reads the snapshot's recorded owner
  directly (independent of this call's scope) and throws the same
  `PathConflictError`, naming both plugins, before either guard's callers
  reach `degradedOwnership` — so `--overwrite` cannot be used to adopt a
  path another Prism-managed plugin already owns (AGENTS.md invariant 7:
  "no adopt, ever"). Unlike the same-call guard, it is **content-gated**: a
  plugin-attribution mismatch alone does not throw when the desired bytes
  already match what is on record (see the doc comment on the function
  itself for why — it covers a real legitimate multi-producer-convergence
  shape and makes rollout safe over a snapshot carrying a stale attribution
  from before a producer-side fix). A genuine two-author collision never
  coincides on content by accident, so real skill/agent/command collisions
  still fail closed exactly as before.

Both guards reuse the same `PathConflictError` type (`src/errors.ts`) so
callers and the CLI's top-level error renderer treat every occurrence of
this law identically regardless of which artifact kind triggered it.

## Known gap surfaced by corpus validation (not fixed here — filed as a follow-up)

Running `prism plan --plugins ~/Projects/prism-plugins --all` against this
glyph's real corpus (per PQ-162's own backpressure: "any firing = real
latent collision, review before shipping the guard") surfaces 18
`PathConflictError`s, all on OpenCode's per-owner tool-binding mirror bundle
(`src/compile/lowerers/opencode.ts` `planOwnerGeneratedRuntimePlugins`):
when plugin B binds a canonical tool owned by plugin A, OpenCode's lowerer
regenerates plugin A's own generated-plugin bundle as part of plugin B's
compile output so the binding resolves at runtime. Multiple consumers of the
same owner (and the owner's own compile, if it has one) each independently
regenerate that same bundle path. This surfaced two real, narrow issues,
both addressed here:

- The regenerated bundle was attributed to the triggering consumer
  (`plugin: input.target.sourcePluginName`) instead of the true owner
  (`pluginName`) — fixed: `planOwnerGeneratedRuntimePlugins` now attributes
  it to `pluginName`, matching invariant 3 ("one representation per
  artifact, across all consumers").
- Multiple independent regenerations of that bundle do not reliably
  converge on identical bytes in this corpus (content differs across
  producers even after the attribution fix) — **not fixed here**. This repo
  is mid-session across several concurrent glyph lanes sharing the same
  real `~/.prism` state, so some of the observed divergence is plausibly
  version-skew noise (the snapshot was written by a different code
  revision than this lane's build) rather than proof that
  `Bun.build`'s output is inherently non-deterministic for this bundle —
  but that is not established either way here. Resolving it needs a
  controlled, sandboxed-harness-root determinism test (compile the same
  owner's mirror twice in one process, diff bytes) that this session did
  not have safe means to run without either writing to the real machine's
  harness roots or building new sandboxing plumbing — out of scope for this
  glyph (PQ-162's own non-goals rule out new merge machinery ahead of a
  decided law for this artifact class, and this is a newly-discovered class
  the ratified law table does not name).

Until that lands as its own follow-up glyph, the content-gate above means
this shows up as a per-plugin, per-harness compile failure (batch-isolated
from sibling plugins, consistent with how every other hard compile error in
this codebase already behaves) rather than a silent clobber — which is a
strict improvement over the pre-existing behavior (this same pattern was
*already* degrading to a silent-ish `blocked` classification before this
glyph, just with a misleading "never managed" hint attributing nothing).
It is not, however, a clean pass of the corpus-check backpressure clause;
recorded here rather than glossed over.

## Non-goals (carried from the glyph)

- No merge machinery for kinds with no second producer yet (modelspaces).
- No new registry/service infrastructure — namespaced refs plus the two
  plan-time guards above are the whole mechanism.
- No renaming of existing artifacts.
- No merge law invented for OpenCode's owner-mirror bundle class (the known
  gap above) — its law is undecided; file a follow-up glyph rather than
  deciding it here under time pressure.
