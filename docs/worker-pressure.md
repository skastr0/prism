# Worker pressure — design spec

**Objective (one sentence):** detect that a harness worker has stopped making
progress *while it is still running*, from signals the worker itself emits — and
never from a clock, a byte count, or a number an author has to guess.

**What this is not:** a replacement for the limits deleted in `b8a8635`. Nothing
here becomes a CLI flag, a task field, or an environment variable. Pressure is a
property Prism *observes*; thresholds are internal constants derived from
observed data, not knobs an agent can see or raise.

---

## 1. Why this exists

A real incident: an agent entered a permanent compaction loop and ran ~300
compactions over ~3 hours, consuming a monthly usage allowance. Nothing in Prism
noticed.

No limit of the kind Prism used to have would have caught it:

- a **timeout** long enough to permit legitimate 3-hour work fires after the
  damage; one short enough to fire early kills real runs. There is no setting
  that separates the two, because *duration is not the pathology*.
- an **output-size cap** fires on verbosity, which healthy long runs also have.
- a **cost ceiling** requires cost reporting the harness may not provide, and is
  a per-run number the author must guess before knowing what the run costs.

The failure was never "too long" or "too big". It was **300 compactions**, which
is not slow work — it is provably *not work*. That distinction is the whole
design:

> A **clock or size** measures ambition and punishes real work.
> A **pathology** measures behaviour and only fires when behaviour is broken.

A healthy task compacts zero to two times. It does not repeat the same tool call
with the same arguments five times. It does not emit four consecutive
near-identical assistant messages. When those happen, no threshold tuning is
required to know something is wrong — and the signal costs nothing when the
worker is healthy.

## 2. Feasibility — what already exists

Every claim below is a file:line in this repository, not an assumption.

**One chokepoint sees every harness.** All ten worker adapters spawn through
`runWorkflowWorkerProcess`, whose `readStream` loop already receives every
stdout/stderr chunk and already fires a per-chunk callback
(`src/workflow-worker-process.ts:115-132`). Today that callback carries only the
stream name (`"stdout" | "stderr"`) and the text is dropped. Passing the chunk
text through is a one-line signature change that yields a **live** event feed for
all ten harnesses at once — no per-adapter work to get the tap.

**Per-harness event parsing already exists.** This is not greenfield; each
adapter already walks its own stream:

| worker | stream format | existing parser |
|---|---|---|
| `claude-code` | `--output-format stream-json --verbose`, JSONL | `parseClaudeStream` — already collects every `tool_use` name and the `result` envelope (`workflow-claude-worker.ts:93`) |
| `codex-cli` | JSONL, typed events (`session_meta`, …) | `codexSessionId` line walk (`workflow-codex-worker.ts:127`) |
| `opencode` | JSONL, `{type, sessionID, part}` | `parseOpenCodeJsonStream` (`workflow-opencode-worker.ts:107`) |
| `omp` | JSONL, `{type: "session" \| "message_end", …}` | `parseOmpJsonStream` (`workflow-omp-worker.ts:157`) |
| `kimi-code` | `--output-format stream-json` | `parseKimiStreamJsonOutput` (`workflow-kimi-worker.ts:56`) |
| `amp-code` | `--stream-json` | `parseAmpStreamJsonResult` (`workflow-amp-worker.ts:139`) |
| `grok` | `--output-format json` (single envelope, not a stream) | inline |
| `antigravity-cli` | text + `--log-file`; conversation id extracted from the log | `extractAgyConversationId` |
| `hermes` | **unconfirmed** — no structured-output flag in the adapter | session id via stderr regex |
| `devin` | **unconfirmed** — ATIF export file, not a live stream | `sessionIdFromAtif` (`workflow-devin-worker.ts:142`) |

Seven harnesses emit machine-readable events today. Three (`agy`, `hermes`,
`devin`) need a live capture before their taxonomy can be written honestly —
see §11.

**Compaction is observable.** Claude Code emits a `compact_boundary` system
event — confirmed by `strings` on the installed binary (`2.1.220`), not inferred
from documentation.

**Recording surfaces exist.** `recordEvent(store, runId, taskId, type, payload)`
writes durable ledger events, and per-attempt metadata persists alongside each
attempt row. Notably this only became viable in `b8a8635`: the 64 KiB
attempt-metadata cap removed in that commit is precisely what would have
rejected pressure telemetry.

**Conclusion:** the tap is one line, the parsers exist in seven of ten adapters,
and the storage is already there. The genuinely new work is the normalizer, the
analyzer, and the surfacing.

## 3. Architecture

Three layers, each independently testable. The analyzer is deliberately pure so
it can be lifted out whole (§10).

```
harness stdout/stderr chunks
  |> L1  tap          (workflow-worker-process.ts — carries chunk text)
  |> L2  normalizer   (per harness: raw lines -> WorkerEvent)
  |> L3  analyzer     (pure: WorkerEvent[] -> PressureSignal[])
  |> emission         (ledger events + attempt metadata + surfacing)
  |> aggregation      (ledger -> worker health per (worker, model))
```

- **L1 tap** — extend `onOutputActivity(stream)` to `onOutput(stream, text)`.
  Line-buffers across chunk boundaries (a JSON event can split mid-line) and
  hands complete lines downstream. Must never throw into the worker path: a
  normalizer or analyzer fault degrades to "no signals", never to a failed task.
- **L2 normalizer** — one small function per harness mapping its native line
  shape onto the canonical event union. Unknown lines normalize to
  `{kind: "unparsed"}` rather than being dropped, so coverage is measurable.
- **L3 analyzer** — pure, synchronous, O(1) per event, bounded state. No I/O, no
  Prism types, no clock reads except a monotonic tick passed in.

## 4. Canonical event taxonomy

The union every harness normalizes into. Deliberately minimal — only what a
pressure signal consumes.

```ts
type WorkerEvent =
  | { kind: "assistant-message"; textHash: string; length: number }
  | { kind: "tool-call"; name: string; argsHash: string }
  | { kind: "tool-result"; name: string; ok: boolean; errorKind?: string }
  | { kind: "compaction" }
  | { kind: "inference-error"; status?: number; errorKind: string }
  | { kind: "turn-boundary" }
  | { kind: "session-meta"; sessionId?: string }
  | { kind: "result-envelope"; ok: boolean }
  | { kind: "unparsed" };
```

Hashes, not payloads: the analyzer compares identity, never content, so nothing
sensitive enters the pressure record and window state stays constant-size.

## 5. Signals

Each signal is a named pathology with a window, an evidence payload, and a
severity. Thresholds below are **initial proposals to be tuned against observed
data in phase P0** — they are not the spec's commitments.

| signal | fires on (initial) | severity | act candidate |
|---|---|---|---|
| `compaction-thrash` | ≥3 compactions with <2 turn boundaries between consecutive pairs, or ≥6 compactions in one attempt | critical | yes |
| `tool-thrash` | same `(name, argsHash)` ≥5× consecutively, or ≥8× in a 20-call window | critical | yes |
| `tool-failure-storm` | ≥5 consecutive `tool-result{ok:false}`, or ≥10 of the last 20 | warn | later |
| `inference-error-storm` | ≥3 consecutive `inference-error` | warn | later |
| `assistant-repetition` | ≥4 consecutive `assistant-message` with identical `textHash` | critical | yes |
| `no-forward-progress` | 15 consecutive events with no new tool signature and no successful tool result | info | no |

`assistant-repetition` is the `antigravity-cli` / Gemini failure mode; exact-hash
identity is the cheap v1, with normalized near-duplicate matching as a follow-up
only if exact matching proves too narrow against real captures.

Every signal carries: attempt id, worker, model, the window that triggered it,
the counts, and up to N evidence identifiers (tool names, hashes) — never raw
message text.

## 6. Emission

- **Ledger event** `task.pressure` per signal transition (fired once when a
  signal opens, once when it clears — not per event), payload as §5.
- **Attempt metadata** rollup at attempt close: per-signal peak counts plus
  totals (compactions, tool calls, failures, inference errors). This is the
  substrate §9 aggregates over.
- **Surfacing**: `prism workflow runs show` gains a pressure line per attempt;
  `runs trace` annotates the executor span; `workflow monitor` shows live signal
  state per running task. A run that ends healthy shows nothing — silence is the
  healthy state.

## 7. Action policy (phase P2, after thresholds are tuned)

- Only `severity: critical` signals act. Warn/info are observability forever.
- Acting means: abort the current *attempt* (not the run), fail the task with a
  named terminal cause `worker-pressure:<signal>`, and let the existing
  transient-retry path decide whether to re-attempt. A pressure abort is a
  first-class named failure, never a silent kill.
- **No escape hatch, by construction.** There is no flag to raise a threshold and
  no task field to opt out. If a threshold proves wrong, the fix is to change the
  constant with the data that proves it, in a commit — not to hand agents a knob
  they will set to infinity.
- Cardinal rule inherited from `b8a8635`: if a proposed guard can fire on a
  healthy long-running task, it does not ship.

## 8. Machine-level spend circuit breaker (separate, related)

Distinct from pressure and worth stating so the two are not conflated: pressure
catches a *broken* worker; a spend breaker catches a *legitimate but expensive*
fleet. It reads cumulative reported cost/tokens across **all** runs in a rolling
window from the ledger, is configured once in `~/.prism`, and is invisible to
workflows — no agent can see, set, or raise it. Scoped here as a sibling, not
part of the pressure build.

## 9. Worker health

Pressure is per-attempt and live. Health is the aggregate: roll the §6 metadata
across the ledger per `(worker, model)` over a rolling window to answer
questions dispatch actually cares about:

- which harness/model is currently degrading (rising `inference-error-storm`)?
- which one thrashes tools on this class of task?
- did a harness upgrade change its failure profile?

Surfaced through `prism workflow runs summary --health` and, later, consumable
before dispatch. Read-only in the first pass: health *informs*, it does not
auto-route.

## 10. Module boundary (vellum reuse)

L2 + L3 must be liftable into `../vellum` with zero edits:

- pure functions only; no Effect, no Prism types, no store, no filesystem, no
  `Date.now()` (a monotonic tick is passed in)
- input: `WorkerEvent[]` or a fed stream of them; output: `PressureSignal[]`
- harness normalizers live behind a registry so a consumer can add its own
- the Prism-specific parts (tap wiring, ledger emission, CLI surfacing) stay in
  Prism and depend on the module, never the reverse

Concretely: `src/worker-pressure/{events,normalizers,analyzer}.ts` with no
imports from `workflow-*`, and everything Prism-flavoured in
`src/workflow-pressure.ts`.

## 11. Risks and open questions

1. **Legitimate repetition.** A task may genuinely call one tool repeatedly with
   identical arguments (polling, batch retries). Mitigation: `tool-thrash`
   requires *consecutive* identity with no intervening successful result; P0
   observation must confirm this does not fire on healthy runs before P2 acts.
2. **Format drift.** Harness stream shapes change between releases. Mitigation:
   `unparsed` is counted, so normalizer coverage per worker is measurable and a
   drop is visible rather than silent. A harness whose coverage collapses simply
   produces no signals — it never produces *wrong* ones.
3. **Three unconfirmed harnesses.** `hermes`, `devin`, and `agy` have no
   confirmed structured event stream in the adapter. P0 must capture a real run
   from each before their normalizers are written; until then they emit only
   `unparsed` and are honestly reported as uncovered. **No taxonomy for these
   three will be written from assumption.**
4. **Per-line parse cost.** Every line of every worker's stream gets JSON-parsed.
   Mitigation: cheap prefix test before `JSON.parse`, O(1) analyzer state, and a
   measurement on a real large-stream run before P2. If it costs more than a low
   single-digit percentage of run wall time, sampling is the fallback.
5. **Compaction detectability outside Claude.** Confirmed for `claude-code`.
   Unknown for the rest; P0 capture decides. A harness with no compaction event
   simply does not get that signal.

## 12. Test plan

- **Fixtures from real captures**, not synthesized streams: one healthy and one
  pathological capture per covered harness, stored as test fixtures.
- **Invariant: healthy stream ⇒ zero signals.** This is the primary gate. Every
  healthy fixture must produce an empty signal set; a regression here is what
  "punishing real work" looks like in test form.
- **Replay of the real incident**: a synthetic compaction-loop stream shaped like
  the observed 300-compaction failure must trigger `compaction-thrash` within the
  first minute of stream time.
- Analyzer property tests: bounded state regardless of stream length; signal
  transitions idempotent.

## 13. Phasing

| phase | scope | exit criterion |
|---|---|---|
| **P0 observe** | L1 tap, L2 for the seven confirmed harnesses, L3 analyzer, ledger emission. Nothing acts. Live captures for the three unconfirmed harnesses. | real runs produce signals; healthy runs produce none |
| **P1 surface** | `runs show` / `trace` / `monitor` display | pressure visible without reading the ledger by hand |
| **P2 act** | abort path for critical signals, thresholds tuned from P0 data | the incident class is caught; no healthy run is killed |
| **P3 health** | per-(worker, model) aggregation and `runs summary --health` | degradation is visible before dispatch |

P2 does not begin until P0 has produced enough real-run data to justify each
threshold. Shipping an acting guard on guessed numbers is the exact mistake
`b8a8635` removed.
