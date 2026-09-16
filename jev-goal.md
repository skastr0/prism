# Goal: First-Class Jev (TypeSafe System One) Integration for Prism

Date: 2026-09-16
Status: in implementation
Temporary working document — DELETE before feature completion (owner instruction).

## What this builds

Jev decisions as first-class citizens in Prism, one implementation behind two surfaces:

1. **Workflow DSL** — a native `jev(...)` task kind (`kind: "jev"`) executed in-process by
   the runner via an Effect v4 `JevClient` service. Typed answers (choice/score/noul with
   confidence + probabilities + usage), recorded through the same snapshot/cache/attempt/
   ledger machinery as worker tasks. No worker spawn, no prompt repair, no WFE-009 retry.
2. **Prism tool** — `~/prism-plugins/jev` with one canonical tool `jev/systemone_ask`
   (`prism tools invoke jev systemone_ask --input ...`), delegating to the same core
   service, auto-surfaced to agents via the generated `prism-tools-jev` skill.

## Settled decisions (owner)

- Public namespace is `jev` (module, service, plugin, tool names, task constructor).
- New native task kind, not a worker backend and not a `defineTask` overload.
- `@typesafe-ai/sdk@0.6.0` pinned as a prism core dependency.
- Batching doctrine: ONE request, many questions (cookbook: 12.2x cheaper, 10x faster,
  same answers); chunk at ~28k estimated tokens; never one-question-per-call.

## Design decisions (Oracle, reviewed)

- `jev({ id, state, questions, model?, timeoutMs?, phase?, cacheKey? })`; result is the
  full `{ model, answers, usage }`; output schema derived from questions, author cannot
  override.
- State is a concrete JSON entry evaluated before task construction; cross-task
  dependencies use dynamic `run:` workflows, not lazy state callbacks.
- `ctx.jev(...)` added to phase ctx; `ctx.task` stays worker-only; no finish/repair
  semantics on Jev tasks.
- `JevClient` Context.Service: `JevClientLive` (env, lazy credential check at first live
  call), `JevClientWith(options)` (explicit, never env), `JevClientTest` (stubbed). SDK
  `logLevel` forced off; interruption via Effect-provided AbortSignal; SDK error
  taxonomy mapped to tagged `JevError` kinds. SDK transport retry only.
- Runner: kind-dispatch in a composed executor (`workflow-executors.ts`); Jev adapter in
  `workflow-jev.ts`; separate run-scoped limiter `WORKFLOW_JEV_CONCURRENCY = 32`; identity
  hash from `{kind, api, baseURL, model, state, questions, resultContractVersion}`; store
  migration v6→v7 adds `task_kind` + `request_json`.
- Tool presentation schemas are nonrecursive (union/record bridges extended); the shared
  decoder is the authority. Pre-flight token-budget guard (`JEV_TOKEN_BUDGET`) fails
  `request`-kind with a "split into chunks" message.
- Docs prune at the end per owner: this file is deleted; durable docs go into docs/.

## Slices

- [ ] GLYPH-JEV-02: `src/jev.ts` pure vocabulary + schemas + tests
- [ ] GLYPH-JEV-03: `@typesafe-ai/sdk` dep + `src/services/jev.ts` + tests
- [ ] GLYPH-JEV-04: task union, phase `ctx.jev`, identity, store v7
- [ ] GLYPH-JEV-05: runner execution (`workflow-jev.ts`, dispatch, limiters, mocks)
- [ ] GLYPH-JEV-06: authoring/bundle runtime (load bridge, facade, embedded sources)
- [ ] GLYPH-JEV-07: loader/validate/catalog/TUI consumers, schema bridges, CLI timeout
- [ ] GLYPH-JEV-08: `~/prism-plugins/jev` tool plugin + skill + tests
- [ ] GLYPH-JEV-09: examples, docs, changelog, full gates, delete this file
