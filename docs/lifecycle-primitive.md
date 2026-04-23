# The Lifecycle Primitive

A specification for taste-amplified business automation.

---

## 0. Purpose

This document captures a primitive and a set of operating principles for building business automation that amplifies rather than replaces individual taste. It is written for its author as a canonical reference. When noise resumes and direction blurs, return here.

The system being built is not an "autonomous business." An autonomous business is an LLM building a business for itself — a different project, possibly valid, not this one. This is a **taste-expressed business**: automation whose explicit purpose is to make taste the only expensive input, then make taste cheap to apply.

---

## 1. Ground truth

All of this — every agent, every framework, every "memory," every "dream cycle" — reduces to one mechanism: **what text is in the context window at the moment the next token is sampled.** The model is fixed. The generation is fixed. The only surface area is assembly.

Four levers:

- **Tagging** — role of text (system / developer / user / tool / tool_result / assistant). Affects how the model weights instruction-following vs. content-processing.
- **Position** — absolute location in the window (top, middle, end). Attention is non-uniform; top-of-prompt and end-of-message get disproportionate weight.
- **Sequencing** — relative order of semantically related chunks. Narrative flow shapes resolution of ambiguity.
- **Boundary** — what is *excluded*. Most context failures are over-inclusion, not under-inclusion.

Generic text produces generic output. Filling the window with slop cannot be rescued by model intelligence. Once text is in the window, the work is done.

---

## 2. The primitive

```
Lifecycle<T>:
  Inputs:
    SignalQueue       : linear, consumable, single-use
    TasteArtifacts    : persistent, referenced-not-consumed
    EncodedTaste      : deterministic rules, infrastructure

  Structure:
    Phases            : [Phase<T>] where Phase = AtomicWork | Lifecycle<T'>

  Runtime:
    Heartbeat         : external trigger; begins a turn
    Turn              : drain signals through phases; produce artifacts + derived signals
    Evolution         : emit signals upward (to parent) or internally (to queue)

  Termination:
    SignalQueue empty AND no phase emits more
```

### Laws

**Linearity.** A signal can be acted on once. Once consumed, its derivatives are new signals, not re-uses of the original. This is the monadic bind: `signal >>= action = newSignal`.

**Origination.** Signals originate from (a) external sources or (b) derivations of already-consumed signals within a phase. The system cannot manufacture signals to extend its own runtime. Manufactured signals are hallucinated scarcity.

**Mechanical termination.** Done is "the signal queue is empty." No planning required. Judgment lives in how well each signal is extracted, not in knowing when to halt.

**Free audit.** Every artifact traces to the signals it consumed. Reproducibility is structural.

---

## 3. Signals

Three kinds of input, distinct in behavior:

**Live signals.** Linear, consumed, short half-life. External (ad performance, App Store reviews, GitHub issues, engagement data) or derived (phase outputs that become input for the next phase in the same turn).

**Taste artifacts.** Persistent, referenced, long half-life. Two authoring modes:

- *Human-authored.* Batch-produced by the human in dedicated taste windows. Examples: a backlog, a content plan with branch strategies, a research-directions document, a brand voice declaration.
- *Semi-derived.* Produced as candidate updates by an ILC (see §4), approved in batch by the human, then function identically to human-authored artifacts downstream. The production path is automated; the authoring authority remains human. Without the approval gate, semi-derived taste becomes hallucinated taste — the system generating its own sense of what matters and propagating that through the rest of the architecture.

Both modes: referenced by many phase executions, replaced in batches, not consumed per use. Effectively configuration, not input.

**Encoded taste.** Deterministic rules. Permanent until edited. Examples: code quality thresholds (complexity, duplication, cohesion, lint), content format rules, architectural preferences, validation criteria. Once encoded, operate autonomously.

A phase execution draws on all three: it pulls relevant taste artifacts (context), obeys encoded taste (constraints), and consumes live signals (input).

---

## 4. Execution lifecycles (the five base cases)

Recursion terminates at five primitives whose work is implemented directly in agent harnesses. These are the lifecycles at which the AI instance does the work itself, rather than composing the work of other lifecycles. The term "execution" refers to where the work grounds out architecturally — at the agent harness level — not to whether the output is world-facing.

- **SDLC** — Software Development Lifecycle. Produces code.
- **RLC** — Research Lifecycle. Produces distilled findings, prompts, direction documents for bounded questions.
- **WLC** — Writing Lifecycle. Produces prose (posts, essays, scripts, YouTube scripts).
- **MLC** — Marketing Lifecycle. Produces creatives, hooks, campaigns, experiments.
- **ILC** — Intelligence Lifecycle. Produces living domain models maintained over time; artifacts are semi-derived taste artifacts feeding downstream lifecycles. See the ILC appendix for the full specification.

Some outputs are world-facing (code shipped, posts published, creatives placed). Others stay internal (research findings consulted by the human, living domain models feeding other lifecycles). Both are legitimate execution-lifecycle outputs.

**At the execution level, specification is already compiled.** The skills and agent definitions accumulated over months of prompt engineering — builder agents, orchestrator-engineers, build/review/evolve skills, domain maintenance harnesses — are the execution-level specification in its compiled form. A new specification layer at this level would be redundant. The work at this level is maintenance and refinement of existing prompts, not new structure.

**RLC and ILC are distinct even though both turn signal into insight.** RLC is episodic, convergent, terminal: a question is asked, the lifecycle runs until answered, the artifact informs a bounded decision and mostly retires. ILC is standing, divergent, maintenance-mode: it keeps a current model of a domain's semantic state available for consultation by many downstream lifecycles across long time horizons. The failure modes differ fundamentally — RLC fails at a wrong answer on a bounded decision; ILC fails as a degraded sensory organ silently corrupting many downstream decisions over weeks. Different safeguards, different review cadences. See the ILC appendix §1 for the full distinction.

---

## 5. Higher-order lifecycles

A higher-order lifecycle has phases that are themselves lifecycles. Composition up the stack:

```
Business<Apps>
  ↓ phases
  [ ProductIdeation, Launch, Growth, ... ]
  ↓
ProductIdeation
  ↓ phases (each is itself a Lifecycle)
  [ MLC<DistributionCheck>,
    RLC<MarketResearch>,
    SDLC<FeasibilitySpike>,
    WLC<StoryDraft> ]
```

**Higher-order evolution is a fold over child outputs.** The evolution phase consumes the transcripts and artifacts of child lifecycles and emits new signals for the parent's next turn.

**Higher-order signal sourcing is a mix.** Synthesized signals bubbling up from children + fresh external signals + semi-derived taste from ILCs + human taste signals at the top. Higher the order, higher the proportion of human taste.

**This is where the specification layer earns its keep.** Unlike execution phases, higher-order lifecycles are project-specific in structure (not just content), ad hoc in sequencing (each run is a real composition decision), and taste-heavy (which child to invoke when, whether to skip, whether to escalate). The variability and taste density make them poor candidates for baking into shared agent prompts. They want per-project, evolvable specification files.

---

## 6. Agents

An agent is a packaged context-window assembly strategy, anthropomorphized for design convenience. Mechanically, an agent is the runtime instantiation of a phase.

### Components

- **Identity** (top-positioned, system or developer tag): role, personality parameters, goals, constraints, anti-patterns, communication protocol, telos, loop-closure criteria.
- **Task**: the specific signal being consumed this turn.
- **Tools**: tool definitions bounding the action surface. Defines the ontology the agent operates within.
- **Loop state**: evolving tail of turns, tool calls, tool results.
- **Termination rule**: property of the agent, not external.

### Loop

```
assemble context → generate →
  if tool_call: execute, append result, repeat
  if final text: emit and close
```

### Personality as policy

Personality instructions at the top of context are not flavor. They pre-commit the model's weights toward particular response trajectories given downstream events. "Cautious" escalates on the first warning. "Impulsive" persists through five. Personality is a configurable parameter of a phase, set based on required behavior. Exploration phases want impulsive agents; Validation phases want cautious ones.

### Tool surface is part of character

Giving an agent `bash` versus a narrow typed tool set is not just a capability choice. It shapes how the agent reasons. A MarketingExperiment phase wants `draft_hook`, `schedule_post`, `pull_metrics` — not `bash`. Narrow tools encode the domain ontology.

---

## 7. The specification layer

The original shape here assumed specification would stay purely markdown and be interpreted dynamically at runtime. The harness-programming realization has now split that into two layers:

- **durable source specification** — markdown plus TypeScript-authored compile primitives (`identity`, `personality`, `tool`, `trait`, `agent`, `lifecycle`, etc.)
- **compiled harness artifacts** — target-native agents, skills, config patches, and synthetic-tool/plugin outputs emitted by `agentpkg`

So the live architectural truth is no longer “there is no compiler process.” There is a compiler process, but the philosophy still holds at a deeper level: the product is the durable specification, not the emitted harness residue.

Four reasons this shape still fits:

- The source substrate still matches the materials the human and agents can read and edit directly.
- Specification remains diffable and reviewable as first-class source.
- The compiler lowers structure into the real harnesses instead of pretending runtime assembly is magic.
- Version control still provides the main audit trail; generated artifacts remain disposable.

### Where specification lives

Layered by lifecycle order:

**Execution lifecycles (SDLC, RLC, WLC, MLC, ILC).** Now live as reusable compile-time source plugins and harness surfaces rather than only as informal prompt residue. The important distinction remains: these are shared execution grammars, not per-project ad hoc compositions.

**Higher-order lifecycles.** Per-project source files that compose execution lifecycles into larger patterns. Product ideation, launch, growth. These may still be markdown-heavy in spirit, but in harness-programming they can now be authored as durable compile-time lifecycle source and lowered into target-native artifacts.

**Taste artifacts.** Per-project files defining what the business is and isn't, including the living domain artifacts maintained by ILCs. Brief, architectural decisions, brand voice, story positioning, domain state. Referenced by both higher-order lifecycles and execution phases.

**Encoded taste.** Per-project rule files. Code quality thresholds, content format constraints, validation criteria, ILC source lists and exclusion rules. Consumed by execution phases as constraints.

Typical per-project layout:

```
/project
  brief.md                           ← taste artifact
  architectural-decisions.md           ← taste artifact
  brand-voice.md                       ← taste artifact
  code-quality.md                      ← encoded taste
  /lifecycles
    product-ideation.md              ← higher-order recipe
    launch.md                        ← higher-order recipe
    growth.md                        ← higher-order recipe
  /intelligence
    /domain-a
      living-artifact.md             ← semi-derived taste artifact
      ontology.md                    ← taste artifact (what matters here)
      sources.md                     ← encoded taste (source list)
      /pending-diffs                 ← proposals awaiting approval
  /compositions
    ideation-log.md                  ← run history
    evolution-notes.md               ← structural learnings
  /signal-queue
    /inbound                         ← fresh live signals
    /derived                         ← intra-turn derivations
```

### Shape of a higher-order lifecycle file

A higher-order lifecycle file is a composition recipe. It names the child lifecycles to invoke, the signal routing between them, the termination rule, the taste checkpoints, and the evolution instruction.

```
# [Lifecycle name] for [Project]

## Produces
[what this lifecycle commits when complete]

## Phases
### 1. [Phase name] ([child lifecycle type])
- Invoke: [child orchestrator reference]
- Signal in: [what flows from prior phase or external source]
- Termination: [what must exist to move on]
- Skip if: [conditions that bypass this phase]

### 2. [Phase name] ...

## Taste checkpoints
[points where human sign-off is required before proceeding]

## Evolution
At the end of each run: read transcripts of all phases, update
the compositions log with what worked. Update this file directly
if something structural should change.
```

### The specification is the product

The set of per-project markdown files — taste artifacts, higher-order lifecycle recipes, living domain artifacts, compositions logs — is the business operating system. Agents interpret these files. Skills are the interpretive vocabulary. But the specification is what differentiates one project from another and what accumulates value over time.

If the specification is sharp, the agents are commodity. If the specification is vague, no agent saves the system.

### Specification evolves through explicit edits

The evolve phase writes to specification files directly. Not through opaque compaction. Through edits reviewable as diffs.

This provides stable-identity-like accumulation without stable-identity risks:

- No opaque drift — every change is a commit.
- No compaction loss — whatever stays in the file stays exactly as written.
- Human-in-the-loop is natural — taste batches become diff reviews.
- Forking is cheap — copy the file, specialize, evolve independently.

---

## 8. Architecture: ephemeral invocation, persistent specification

The stable-vs-ephemeral question mostly resolves by separating two things that usually get conflated.

**Specification persists.** Higher-order lifecycle files, taste artifacts (human-authored and semi-derived), encoded rules — these live in version control and accumulate improvements over time.

**Invocation is ephemeral.** Every time a lifecycle runs, a fresh agent reads the specification, assembles its context, executes, and is discarded. No compaction tricks, no long-lived identity to contaminate.

**Evolution is mechanical.** The evolve phase writes to specification files directly. What "the lifecycle has learned" is literally the contents of the file and its commit history.

This pattern:

- Avoids compaction bias (no opaque lossy memory).
- Avoids identity contamination (every run starts fresh).
- Preserves accumulated learning (in the files).
- Makes audit trivial (read the file, read the diffs).
- Keeps the human naturally in the loop (diffs are reviewable during taste batches).

### Where actually-persistent agents still make sense

A few niches where long-lived agent identity may still be right:

- **Interactive assistants tied to the human.** A project manager that holds session context across conversations. Its "identity" is mostly memory of what was said recently; its context is mostly taste artifacts plus recent live signals.
- **Real-time response scenarios.** If a signal requires sub-second response, spinning up a fresh agent per event may be too slow. Rare in business automation.

Both are edge cases. The default is ephemeral invocation against persistent specification.

### Decision rule

| Level | Pattern |
|---|---|
| Leaves (execution phases) | Ephemeral invocation. Existing agent and skill definitions are the specification. |
| Mid-level (execution lifecycle orchestrators) | Ephemeral invocation. Existing orchestrator agents are the specification. |
| Higher-order lifecycles | Ephemeral invocation. Per-project markdown files are the specification. |
| Interactive assistants | Persistent, selectively, where session continuity is load-bearing. |
| Top (the human) | Persistent, outside the system. The source of specification and taste signals. |

---

## 9. The taste horizon

**Taste cannot be automated.** Taste is the irreducible human judgment about what matters, what is good, what the business is actually trying to be. Delegating taste means the system optimizes toward something that is not what you want.

**But taste is not a continuous requirement. It is a batch input.**

Three operations replace "automate it" as the mental model:

### Batching

Sit down for a dedicated taste window (Saturday, Monday morning, end-of-month). Approve, reject, assign strategies. One session → weeks of downstream execution. The automation *around* the session prepares material so the taste window is a taste window, not a work session. ILC diff review fits naturally into these windows.

### Encoding

Some slices of taste are deterministic and can be lifted into rules: code quality thresholds, architectural preferences, brand voice constraints, content format rules, ILC source-credibility rules. Once encoded, they run inside the execution loop without the human. Deciding what is encodable is a taste act; the encoded rule then operates autonomously.

### Signaling

Pre-declared strategies bind batched taste to live-world execution. *"If A performs, weight it up. If B flatlines, rotate. If C surges beyond threshold, escalate."* The strategy is taste; the execution of the strategy is mechanical.

### The leverage ratio

**Optimize for taste-hour-to-execution-hour ratio.**

- Saturday session approving 50 content items → ~30 days of MLC execution. 1 day : 30 days.
- Sprint planning approving a 4-week backlog → 2 hours : 4 weeks.
- Encoding a code quality rule → one afternoon : indefinite execution.
- Approving an ILC diff batch → minutes : weeks of informed downstream decisions.

The whole system is designed to maximize this ratio without sacrificing fit to taste.

### The encoding frontier

The boundary of encodable taste expands over time, and only through working. During batch sessions, notice repeated judgments. Each repeated judgment is a candidate for a rule. If encoding reproduces what you would have done, the rule is valid; the batch shrinks. If not, back off; that slice stays human.

Batch sessions should shrink as encoded taste accumulates into infrastructure. Growing batch sessions mean either (a) expanding business surface faster than encoding (healthy) or (b) discovering taste has more irreducible complexity than assumed (information about the business's nature). Both are useful.

### Back-pressure

Taste throughput per unit time is finite. Execution strategies must respect this as a rate limit. A thousand backlog items generated Saturday is useless if they all want validation Tuesday. Strategies gate execution not only for market responsiveness but for pacing validation load. This applies to ILC diff queues too — ILC cadence must be tuned so diff volume stays within batch throughput, or the queue overflows and approvals degrade into rubber-stamping.

---

## 10. Known constraints

**Specification hygiene matters.** Because agents read and interpret markdown, the clarity of the specification directly shapes output quality. Vague or contradictory files produce vague or contradictory behavior. Specification files need the same care as agent prompts: no slop, clear boundaries, explicit references.

**Cross-reference discipline.** Specification files reference other files — lifecycles reference taste artifacts, compositions reference lifecycles, higher-order phases may reference ILC living artifacts. Broken references produce silent degradation. Occasional audits — or a lightweight linter, when one becomes worth building — keep the graph healthy.

**Context windows are finite but getting cheaper per token.** Even with dynamic specification-reading, the total context an agent assembles must fit. File organization should support pulling only what's needed for a given invocation, not loading every taste artifact on every run. Especially relevant for ILCs, whose living artifacts can grow large — query-layer slicing matters.

**Cache economics shape viable patterns.** Append-only agent loops are cheap because every turn reuses the prefix. Mutating context mid-run pays full recompute. Design for the append-only loop. The primitive is abstract enough that if cache patterns improve, new implementations slot in without changing the type.

**Memory, agents, learning, dreams — all reduce to assembly strategies.** There is nothing extra. Claims otherwise are marketing.

---

## 11. Division of labor

| Layer | Responsibility |
|---|---|
| Human | Premises, taste artifacts (batched), escalation calls, strategic pivots, specification edits during review. For ILCs: domain selection, ontology authoring, diff approval. |
| Specification (per project) | Higher-order lifecycle recipes, taste artifacts (human-authored + semi-derived), encoded rules, composition logs. For ILCs: living domain artifacts, ontologies, source lists, pending-diff queues. |
| Skills and agent definitions (shared) | Interpretive vocabulary; execution-phase compiled form for all five execution lifecycles. |
| Agent runtime | Reads specification at loop start, assembles own context, executes, evolves specification at end. |
| Signal layer | Capture, storage, linearity enforcement, retrieval. For ILCs: standing pool ingestion, per-item linearity against the pool. |

---

## 12. What this is not

- **Not an autonomous business.** That is a different project.
- **Not a general productivity system.** This is a business operating system shaped by one person's taste.
- **Not a framework to share.** Internal primitive. Sharing is a future question.
- **Not a cap on ambition.** The taste horizon rises as encoding expands. The ceiling moves.

---

## Appendix A — Quick reference

- Context window is the whole game. Everything else is assembly strategy.
- Signals are linear. Used once, then derived.
- Done = signal queue empty. Mechanical, not judged.
- Specification is the product. Agents are commodity.
- Five execution lifecycles: SDLC, RLC, WLC, MLC, ILC. Execution refers to agent-harness implementation level, not output audience.
- Higher-order lifecycles are per-project markdown. Execution lifecycles are already compiled into agents and skills.
- Ephemeral invocation, persistent specification, human at the horizon.
- Evolution is editing markdown, not opaque compaction.
- Taste is batched, encoded, or signaled — never continuous.
- Semi-derived taste artifacts (ILC output) bridge automation and taste authority, through the approval gate.
- Optimize taste-hour-to-execution-hour ratio.

## Appendix B — Open questions to revisit

- Termination rule per lifecycle kind: is signal-exhaustion always right, or do some lifecycles want time-boxed or budget-gated termination?
- What conventions for specification file structure reduce agent confusion? (Flat vs nested layout, naming conventions, cross-reference idioms.)
- When does specification-file linting become worth building? (Broken references, outdated inputs, structural inconsistencies.)
- When is a piece of composition worth extracting from one project's files into a shared template? (Premature extraction vs. helpful reuse.)
- Do sibling projects ever cross-pollinate through shared specification, or are they strictly siloed?
- At what point does the human-interactive assistant pattern earn its stable-identity exception, and what are the guardrails?
- See the ILC appendix §12 for ILC-specific open questions.
