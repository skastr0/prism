# Prism Portable Hook Contract (v2)

The portable hook surface Prism plugins author against, and the per-harness
capability contract that lowers it. Claude Code is the semantic baseline;
every other target lowers the maximal native subset and **degrades loudly,
never silently**. Companion audit: `docs/hooks-harness-audit.md`.

Program sequence (one stage at a time, contract re-evaluated between stages):
S0 contract (this doc's Appendix A) → S1 claude-code → S2 codex-cli →
S3 hermes → S4 grok → S5 opencode → S6 antigravity-cli → S7 kimi-code →
S8 amp-code.

---

## 1. Event tiers

- **T1 core** — the 6 existing events. Portable; most targets lower them.
- **T2 extended** — 7 new events with native equivalents on ≥4 harnesses.
  Portable; capability-gated per target.
- **T3 native passthrough** — *deferred to S1; not in S0.* A separate
  authoring construct (`defineNativeHook`) pinning one harness's native event
  verbatim, no portability contract. It must NOT touch the portable schemas
  in this document.

## 2. Events

| event | tier | fires | payload extras (beyond `{event, target, cwd?, session?, native?}`) |
|---|---|---|---|
| `tool.before` | T1 | before a tool call executes | `tool: {logical?, nativeName, input}` |
| `tool.after` | T1 | after a tool call succeeds | `tool: {…, output, success?}` |
| `tool.failure` | T2 | after a tool call fails | `tool: {logical?, nativeName, input, error: unknown}` |
| `prompt.submit` | T1 | user prompt submitted, before the model sees it | `prompt: string` |
| `permission.request` | T1 | a permission decision is pending | `tool?: {logical?, nativeName, input}` |
| `stop` | T2 | the agent is about to finish its turn | `stopHookActive?: boolean` |
| `subagent.start` | T2 | a subagent is spawned | `subagent?: {id?, type?}` |
| `subagent.stop` | T2 | a subagent finished | `subagent?: {id?, type?}` |
| `compact.before` | T2 | before context compaction | `trigger?: string` |
| `compact.after` | T2 | after context compaction | `trigger?: string` |
| `notification` | T2 | harness emits a user-facing notification | `message?: string, kind?: string` |
| `session.start` | T1 | session begins/resumes | `session` required |
| `session.end` | T1 | session terminates | `session` required, `reason?` |

## 3. Results per event

Design rules: every union keeps `{decision: "continue"}` as the zero case;
new capabilities are optional fields or new alternatives, so **existing hook
results keep decoding unchanged**. Wrappers that don't understand a field
ignore it (degradation is compile-time visible via the fidelity report, §5 —
never a runtime error).

```
tool.before        :: {decision:"continue", updatedInput?, systemMessage?, additionalContext?}
                    | {decision:"block", message, systemMessage?}
tool.after         :: {decision:"continue", updatedOutput?, systemMessage?, additionalContext?}
tool.failure       :: {decision:"continue", systemMessage?, additionalContext?}
prompt.submit      :: {decision:"continue", systemMessage?, additionalContext?}
                    | {decision:"block", message}
permission.request :: {decision:"continue", systemMessage?, additionalContext?}
                    | {decision:"allow", updatedInput?, systemMessage?}
                    | {decision:"ask", systemMessage?}
                    | {decision:"block", message}
stop               :: {decision:"continue", systemMessage?}
                    | {decision:"block", message}        // block = do NOT stop; message = what to do next
subagent.start     :: {decision:"continue", systemMessage?, additionalContext?}
subagent.stop      :: {decision:"continue", systemMessage?, additionalContext?}
                    | {decision:"block", message}        // block = subagent's work not accepted
compact.before     :: {decision:"continue", systemMessage?, additionalContext?}
                    | {decision:"block", message}
compact.after      :: {decision:"continue", systemMessage?, additionalContext?}
notification       :: {decision:"continue", systemMessage?}
```

Semantics notes:

- `updatedInput` (tool.before, permission.request allow) replaces the tool
  arguments before execution. `updatedOutput` (tool.after) replaces the tool
  result before the model sees it.
- `ask` = "don't decide; hand to the user." Its universal degradation is
  `continue` (let the harness's normal permission flow run) — safe everywhere.
- `stop`/`subagent.stop`/`compact.before` `block` follows Claude Code
  semantics (Stop `decision:block` + reason keeps the agent working).

## 4. Capability contract — `HOOK_CAPABILITIES` (data, not prose)

New module `src/compile/hook-capabilities.ts`:

```ts
export type HookControl =
  | "block" | "updatedInput" | "updatedOutput" | "ask"
  | "systemMessage" | "additionalContext";

export type HookEventSupport =
  | { readonly kind: "native";   readonly nativeEvent: string; readonly controls: ReadonlyArray<HookControl>; readonly note?: string }
  | { readonly kind: "degraded"; readonly nativeEvent: string; readonly controls: ReadonlyArray<HookControl>; readonly note: string }
  | { readonly kind: "unsupported"; readonly note?: string };

export const HOOK_CAPABILITIES: Record<HarnessId, Record<HookEvent, HookEventSupport>>;
```

- `Record<HarnessId, Record<HookEvent, …>>` makes completeness a
  **type-level** invariant: adding an event or harness without a row fails tsc.
- `kind: "degraded"` = lowers to a native event whose semantics or controls
  fall short (e.g. session.end riding Stop); the `note` states exactly how.
- `controls` lists what the target's **current lowering actually delivers** —
  not what the harness could theoretically do. Stages flip entries as they
  land; the table diff *is* the visible contract evolution per stage.

### S0 seed content (current reality — transcribe exactly)

T1 rows (every T2 row in S0 is `unsupported`, with `note: "pending S<n>"` for
harnesses in the program sequence — claude S1, codex S2, hermes S3, grok S4,
opencode S5, antigravity S6, kimi S7, amp S8; plain `unsupported` for
factory-droid, pi, cursor, openclaw):

| harness | tool.before | tool.after | prompt.submit | permission.request | session.start | session.end |
|---|---|---|---|---|---|---|
| claude-code | native PreToolUse [block] | native PostToolUse [] | unsupported "pending S1" | unsupported "pending S1" | native SessionStart [] | native SessionEnd [] |
| codex-cli | native PreToolUse [block] note:"fires for shell tools only (upstream #20204)" | native PostToolUse [systemMessage, additionalContext] | native UserPromptSubmit [systemMessage, additionalContext] | native PermissionRequest [block, systemMessage] | native SessionStart [systemMessage, additionalContext] | degraded Stop [systemMessage] note:"no native SessionEnd; rides Stop" |
| opencode | native tool.execute.before [block] | native tool.execute.after [systemMessage, additionalContext] | native chat.message [systemMessage, additionalContext] | native permission.ask [block, systemMessage] | degraded session.status [systemMessage, additionalContext] note:"busy transition proxy" | degraded session.status/session.idle [systemMessage, additionalContext] note:"idle transition proxy" |
| antigravity-cli | native PreToolUse [block] | native PostToolUse [] | unsupported | unsupported | degraded PreInvocation [] note:"invocation, not session, granularity" | degraded Stop [] note:"turn stop, not session end" |
| kimi-code | native PreToolUse [block] | native PostToolUse [] | unsupported "pending S7 probe" | unsupported | native SessionStart [] | native SessionEnd [] |
| amp-code | native tool.call [block] | native tool.result [] | unsupported | unsupported | native session.start [] | unsupported "Amp has no session-end plugin event" |
| grok | native PreToolUse [block] | native PostToolUse [] | unsupported "pending S4" | unsupported "grok PermissionDenied is post-hoc observe-only" | native SessionStart [] | native SessionEnd [] |
| factory-droid | native PreToolUse [block] | native PostToolUse [] | unsupported | unsupported | native SessionStart [] | native SessionEnd [] |
| pi | native tool_call [block] | native tool_result [] | unsupported | unsupported | native session_start [] | degraded session_shutdown [] note:"shutdown conflates quit and session switch" |
| cursor | unsupported (×6) — no hook lowerer yet | | | | | |
| openclaw | unsupported (×6) — no hook lowerer yet | | | | | |
| hermes | unsupported "pending S3" (×6) | | | | | |

## 5. Degradation policy + fidelity report

`HookSource` gains `onDegraded?: "fail" | "degrade" | "skip"` (default
`"degrade"`).

Planning semantics per hook × target (new module
`src/compile/hook-planning.ts`, consulted at the pipeline gate that today
does coarse target-level validation — `assertTargetSupportsHooks`,
`src/compile/pipeline.ts:466,1080`):

| capability kind | onDegraded: fail | degrade (default) | skip |
|---|---|---|---|
| native, all controls | lower | lower | lower |
| native/degraded, some controls missing | **compile error** | lower + fidelity note listing dropped controls | omit + note |
| unsupported | **compile error** | omit + fidelity note | omit + note |

- "Controls missing" is decidable statically only at event level (we don't
  know which fields a handler returns); S0 evaluates at **event + declared
  capability** level: a hook is `degraded` on a target when the event lowers
  with fewer controls than the portable result union defines.
- Output: `HookFidelityEntry { hook, event, target, outcome: "native" |
  "degraded" | "skipped" | "failed", nativeEvent?, droppedControls?, notes }`.
  Collected per plugin × target, returned through the compile pipeline, and
  printed in the compile summary. (Deeper surfacing — doctor, plugins TUI —
  is a later stage; S0 just makes it exist and print.)
- After the planning gate, a lowerer receiving an event it cannot lower is a
  **compiler planning bug** (invariant throw — the pattern already used in
  `src/compile/lowerers/hermes.ts:155-157`).

## 6. Runtime mirror invariant

`GENERATED_HOOK_RUNTIME` (`src/compile/hook-runtime-bundle.ts`) hand-mirrors
the decode logic of `sources.ts` in generated JS. S0 must:

1. Extend it for the new events + result alternatives.
2. Add a **parity test** that evaluates the generated JS and asserts, over a
   fixture set of payloads/results (valid + invalid per event), that its
   accept/reject behavior matches `decodeNativeHookPayloadForEvent` /
   `decodeHookResultForEvent` from `sources.ts`. If such a mirror test
   already exists, extend it; if not, create it. This is the deterministic
   gate that keeps the mirror honest.

## 7. Authoring surface

A plain object satisfying `HookSource` — `{ name, description?, event,
targets?, match?, onDegraded?, handle }` — `event` accepts the 13 portable
literals. `match.tool`
(any/toolspace-tool/toolspace-group/canonical-tool) is unchanged and applies
to `tool.before`/`tool.after`/`tool.failure`/`permission.request`.

## 8. Invariants

- Existing plugins and hooks keep compiling with identical STRUCTURE for
  currently-supported hook/target pairs. Wrapper BUNDLE_HASH values change
  whenever `GENERATED_HOOK_RUNTIME` changes (the runtime is bundled into every
  wrapper), so hash-only golden re-records are expected then — any NON-hash
  golden diff is a violation. (S0 note: the s0d re-record was verified
  hash-only; it also absorbed the pre-existing pi golden drift.)
- Widening only: no removed fields, no renamed events.
- `sources.ts` schemas are the single source of truth; the runtime bundle
  mirrors them under the parity test.
- The capability table is the only place harness hook support is declared;
  lowerers must not carry their own private support decisions after their
  stage lands.
- Board/tower identifiers never appear in schemas, fixtures, or generated
  artifacts.

---

## Appendix A — S0 implementation work order

Scope: contract only. **No changes under `src/compile/lowerers/` in S0.**
The only integration point outside new files is the pipeline planning gate.

1. `src/compile/sources.ts`
   - `HookEventSchema`: add the 7 T2 literals (§2).
   - Payload schemas for the 7 new events (§2), added to
     `HookEventPayloadSchema`, `nativeHookPayloadSchemaForEvent`, and native
     payload transforms following the existing per-event pattern.
   - Result schemas per §3: extend `ToolBeforeHookResultSchema` (optional
     `updatedInput`, `systemMessage`, `additionalContext`; block gains
     optional `systemMessage`), new `ToolAfterHookResultSchema` (with
     `updatedOutput`), `PromptSubmitHookResultSchema` (blockable),
     `PermissionRequestHookResultSchema` (+`ask` alternative, allow gains
     optional `updatedInput`), `StopHookResultSchema`,
     blockable results for `subagent.stop`/`compact.before`, observational
     for the rest. Update `HookEventResultSchema`,
     `hookResultSchemaForEvent`.
   - `HookDefinitionSchema` + `Hook` class: add `onDegraded` (optional in
     source, normalized to `"degrade"` on the `Hook` class).
2. `src/compile/hook-runtime-bundle.ts` — mirror all of the above (§6.1).
3. `src/compile/hook-capabilities.ts` (new) — types + `HOOK_CAPABILITIES`
   seed exactly per §4.
4. `src/compile/hook-planning.ts` (new) — `planHooksForTarget(hooks, target)
   → { accepted, fidelity }` per §5; integrate at the pipeline hook gate
   (`pipeline.ts` — replace/extend `assertTargetSupportsHooks` so event-level
   planning runs for every target and fidelity entries flow into the compile
   result + printed summary).
5. Tests (all `bun test`):
   - schema round-trips for every new event payload + result alternative
     (valid and invalid cases);
   - capability table runtime completeness (every harness × event) — the
     type system enforces it too;
   - planning policy matrix: {native, degraded, unsupported} ×
     {fail, degrade, skip} — 9 outcomes per §5 table;
   - runtime mirror parity (§6.2);
   - existing suite stays green; golden outputs unchanged.

Acceptance: `bun test` green (modulo the pre-existing failures enumerated in
the stage brief, which must not grow), `bunx tsc --noEmit` clean, one atomic
commit containing only S0 files.
