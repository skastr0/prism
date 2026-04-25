# Appendix: The Intelligence Lifecycle (ILC)

Companion to the Lifecycle Primitive. A specification for a class of lifecycle whose job is not to execute world-facing artifacts, but to maintain a living model of a domain's semantic state as ongoing infrastructure for downstream lifecycles.

---

## 0. Purpose

The main spec recognizes four execution lifecycles focused on direct work: SDLC, RLC, WLC, MLC. Of these, RLC — the Research Lifecycle — absorbs all "turn signal into insight" work under one name.

This appendix extracts a distinct primitive from that bucket: the **Intelligence Lifecycle (ILC)**. Mechanically similar to RLC, materially different in runtime shape, artifact lifespan, and failure modes. Separating it makes the architecture's design choices visible; collapsing it into RLC hides a real distinction under a shared label.

Positioning: ILC is peer to SDLC/RLC/WLC/MLC at the execution layer. "Execution" here refers to the architectural level at which the AI instance does the work directly — where the agent harness implements the phases — not to whether outputs are world-facing. ILC artifacts feed the taste artifact layer rather than the world; that is a property of its outputs, not a reason to exclude it from the execution layer.

---

## 1. Distinction from RLC

RLC is **episodic, convergent, terminal.** A question is asked; the lifecycle runs until the question is answered; the artifact is produced once, consumed by a decision, and mostly retires.

ILC is **standing, divergent, maintenance-mode.** There is no single question. The job is to keep a current model of a domain's semantic state available for consultation. The artifact is a living document, continuously updated, versioned, diffable. Consumption is many-to-many: many downstream lifecycles pull from it, many times, across long time horizons.

| Property          | RLC                       | ILC                                  |
|-------------------|---------------------------|--------------------------------------|
| Trigger           | Human question            | Standing heartbeat + on-demand query |
| Signal pool       | Gathered for the question | Continuously ingested, standing      |
| Termination       | Question answered         | Per-turn signal exhaustion (see §3)  |
| Artifact lifespan | Until decision made       | Living, versioned, perpetual         |
| Consumption       | Usually one decision      | Many lifecycles, many times          |
| Drift concern     | Low (short-lived)         | High (ontology shift over time)      |
| Failure mode      | Wrong answer              | Confident stale model of reality     |

The failure modes justify the split more than anything. RLC's failure is a wrong answer acting on a bounded decision. ILC's failure is a degraded sensory organ silently corrupting many downstream decisions over weeks. These demand different safeguards, different review cadences, different architectural roles.

---

## 2. The primitive

```
ILC<Domain>:
  Inputs:
    StandingSignalPool : continuously ingested signal stream for the domain
    Ontology           : taste artifact defining what matters in this domain
    EncodedTaste       : source credibility rules, exclusion criteria,
                           freshness thresholds

  Structure:
    LivingArtifact     : versioned, diffable state document for the domain
    Phases             : [Ingest, Classify, Extract, Synthesize, Diff, Propose]

  Runtime:
    Heartbeat          : standing (e.g. weekly) + on-demand query
    Turn               : drain signal deltas since last turn; update LivingArtifact
    Evolution          : emit (a) diffs for human approval,
                          (b) meta-signals about source health and ontology fit

  Termination (per turn):
    Signal delta drained AND Diff phase has proposed updates or confirmed
    no change
```

### Laws

**Per-turn termination preserves §2 of the main spec.** Each ILC turn drains whatever arrived since the last turn and halts. The *instance* terminates cleanly on signal exhaustion. The standing-ness is a property of the scheduler, not the lifecycle. The termination law in the main spec is unchanged; only the scheduling pattern is new.

**Ontology is authored, not derived.** Same discipline as lane premises in the main spec. "What counts as signal in this domain" is a taste act and must be declared. An ILC whose ontology is inferred from the data it ingests will drift toward whatever the loudest sources amplify. Domain ontology is the most load-bearing human input in this primitive.

**Diffs require human approval before propagation.** The LivingArtifact is writeable only by the human, via batch review of proposed diffs. The system produces candidates; the human lands them. This preserves the taste-batching principle: the ILC makes taste cheaper to apply to ongoing domain awareness, it does not replace it.

---

## 3. Standing signal pools

Reconciliation with the main spec's signal laws:

- **Individual signals remain linear.** A specific post, article, or transcript enters the pool, gets consumed by a turn, and is gone.
- **The pool is persistent** in the sense that new arrivals accumulate; this is not a violation of linearity, it is a scheduling property.
- **Derivation still holds.** Phase outputs within a turn are derived signals in the original sense.

The ILC does not introduce a new signal kind. It introduces a new consumption pattern for existing signal kinds, plus a new artifact class (the LivingArtifact) that sits alongside the existing taste artifact category.

---

## 4. Semi-derived taste artifacts

The main spec defines taste artifacts as persistent, referenced, long half-life, produced in one of two modes. ILC introduces and populates the second mode:

- **Human-authored taste artifacts:** produced in batch sessions by the human.
- **Semi-derived taste artifacts:** produced as candidate updates by the ILC, approved in batch by the human, then function identically to human-authored artifacts downstream.
- **Encoded taste** (separate category): deterministic rules, once written, run autonomously.

The distinction matters because the production path is automated but the *authoring authority* remains human. Without the approval gate, these become hallucinated taste — the system generating its own sense of what the domain means and propagating that through the rest of the architecture. With the gate, they are taste artifacts whose first draft is mechanical, which is exactly the leverage the architecture is built for.

The semi-derived category is the most significant extension this appendix makes to the main spec.

---

## 5. Phases

**Ingest.** Pull from declared sources since last turn. Deduplicate. Normalize to a common representation (transcripts from audio/video, text from pages, structured data where available).

**Classify.** Tag each ingested item against the domain ontology. Drop items outside scope. Flag items that don't fit existing categories — these become meta-signals to the human about ontology gaps, not silent discards.

**Extract.** Pull structured observations from classified items: frames in play, language in use, objections raised, metaphors invoked, voices gaining or losing credibility, emerging clusters.

**Synthesize.** Collapse extracted observations across items into a coherent update to the LivingArtifact. This is the phase where assembly quality matters most — the difference between a sharp synthesis and a plausible-sounding one is decided here.

**Diff.** Produce a structured delta against the prior version of the LivingArtifact: what changed, what's new, what fell out, what's contested, what's the confidence. The diff is the human review surface.

**Propose.** Emit the diff as a semi-derived taste artifact candidate for batch approval. If no meaningful change occurred, emit "no change" explicitly — silence is ambiguous.

---

## 6. Domain selection

Domains are declared, not inferred. Same rule as lane premises in the main spec. "Wellness discourse," "solopreneur audience culture," "AI tooling sentiment" are chosen scopes. Attempting to make a single ILC cover "everything culturally relevant" is the boil-the-ocean failure — same disease as not cutting lane premises.

The set of active ILC domains is itself a taste act, revisited in batch. Domains can be added (new business surface), retired (no longer strategically relevant), or split (a domain has grown too broad for ontology coherence). Domain changes are infrequent; ontology refinements within a domain are more common.

---

## 7. Maintenance layer vs query layer

ILC maintenance (the slow lifecycle) and ILC query (the fast lookup) are distinct and must both exist:

- **Maintenance** runs on the standing heartbeat, updates the LivingArtifact, produces diffs. Expensive per turn, cheap amortized. This is where the quality lives.
- **Query** runs on-demand when a downstream lifecycle or the human needs guidance. Reads the current LivingArtifact, assembles a focused brief for the specific question. Cheap per invocation. This is where the usability lives.

A well-maintained artifact with no query layer is a static dashboard no one checks. A query layer without a well-maintained artifact is confident fabrication.

Investment split is roughly 80/20 maintenance/query in engineering effort, but the user experience is 20/80 — the query layer is what you *feel*. Both bars must be cleared or the whole thing sits unused.

---

## 8. Failure modes

**Stale sensory organ.** The LivingArtifact has not been updated meaningfully in weeks but is still being consulted. The system confidently returns obsolete frames. Mitigation: freshness timestamps on every consulted field; automatic staleness warnings surfaced during query.

**Source rot.** A source that was high-signal at onboarding has degraded (community shifted, author pivoted, SEO captured it). The ILC keeps ingesting and classifying its output as in-scope. Mitigation: source-level signal-to-noise tracked over time; meta-signal emitted when a source's contribution rate to accepted diffs falls below threshold.

**Ontology drift.** The domain has shifted meaningfully but the ontology has not, so new phenomena are being forced into stale categories or silently dropped. Mitigation: "doesn't fit" items are a meta-signal, not a discard; their rate is tracked; spikes trigger batch ontology review.

**Confident fabrication.** The Synthesize phase produces sharp-sounding claims with no grounding in the ingested material. Mitigation: every claim in the LivingArtifact traces to the source items that support it; claims without sufficient grounding are marked low-confidence; the query layer surfaces confidence alongside claim.

**Sophisticated-feeling uselessness.** The system exists, produces polished output, is consulted regularly, and has no measurable effect on decision quality. Mitigation: periodic A/B between decisions made with and without ILC consultation, evaluated against downstream outcome where possible. If the ILC's output does not outperform unaided instinct on decisions you can evaluate after the fact, either the sources, the ontology, or the synthesis is broken. Do not let polish substitute for effect.

---

## 9. Integration with the specification layer

LivingArtifacts are markdown files living in the per-project specification tree, alongside human-authored taste artifacts and encoded rules. Downstream lifecycles reference them like any other specification file.

At the start of any lifecycle invocation, the agent reads the relevant specification files — including whichever LivingArtifacts are in scope for the phase it's executing. The semi-derived status is invisible at this layer: an approved LivingArtifact is just a markdown file in the tree. No compiler routing, no approval-state tracking in the execution path.

Semi-derived status is only visible in the batch review cycle: proposed diffs sit in a pending-diffs folder until the human approves them. Unapproved diffs are not written to the LivingArtifact, so downstream invocations never see them. The gate is a gate on the file, not on the runtime.

Typical layout inside a project:

```
/project
  /intelligence
    /domain-a
      living-artifact.md        ← the current state document (semi-derived taste artifact)
      ontology.md               ← what matters in this domain (human-authored taste artifact)
      sources.md                ← declared source list (encoded taste)
      /pending-diffs            ← proposed updates awaiting batch approval
      /archive                  ← prior versions of the living artifact
    /domain-b
      ...
```

For queries, a downstream lifecycle (or a direct human query) invokes a query-layer agent that reads the relevant living-artifact.md and assembles a focused brief for the specific question. The query agent does not modify anything; it reads, focuses, and returns.

---

## 10. Division of labor (addition to §11 of main spec)

| Layer          | ILC-specific responsibility                                                 |
|----------------|------------------------------------------------------------------------------|
| Human          | Domain selection, ontology authoring, diff approval                         |
| Specification  | Living artifacts, ontologies, source lists, pending-diff queues             |
| Skills / agents| ILC phase implementations (ingest, classify, extract, synthesize, diff), query agents |
| Agent runtime  | Standing maintenance invocations, on-demand query invocations               |
| Signal layer   | Standing pool ingestion, per-item linearity against the pool                |

---

## 11. Relation to the broader architecture

ILC sits at the execution layer alongside the other four execution lifecycles, but its artifacts terminate in the taste artifact layer rather than the world. In the layered view of the main spec:

```
Signal layer             → live signals, linear, consumed
Taste artifacts          → persistent, referenced
  ├── Human-authored     (batch sessions)
  └── Semi-derived       (ILC output, batch-approved)    ← new
Encoded taste            → deterministic rules
Execution lifecycles     → SDLC, RLC, WLC, MLC, ILC
Higher-order lifecycles  → ProductIdeation, Business, ...
Human                    → taste horizon
```

ILC is an execution lifecycle — it is implemented in agent harnesses directly, same as SDLC or MLC. What distinguishes it is the destination of its work: the semi-derived taste artifact layer, feeding the persistent context other lifecycles run against. The cleanest way to understand it is: *an execution lifecycle that manufactures the persistent context other lifecycles consume.*

---

## 12. Open questions

- **Heartbeat cadence per domain.** Fast-moving domains (AI tooling) may want daily or sub-daily; slow-moving domains (underlying cultural shifts) want weekly or slower. Should cadence be per-domain configuration, or dynamically adjusted based on incoming signal volatility?
- **Cross-domain synthesis.** Some decisions sit across multiple ILC domains. Is cross-domain synthesis a query-time concern (the query layer pulls from multiple LivingArtifacts), or does it warrant its own meta-ILC that synthesizes across domains? The former is simpler; the latter may capture emergent patterns the former misses.
- **Retirement of LivingArtifacts.** When a domain is retired, does its LivingArtifact become a referenceable archive (historical snapshot) or get discarded? Archival is probably right, but retrieval semantics are unclear — archived artifacts should not appear in current-state queries but should appear in historical ones.
- **Validation loop.** How do you systematically close the loop between ILC guidance and decision outcomes, given that many outcomes are themselves noisy signals months later? This is the hardest open question and probably requires per-domain answers.
- **Encoding frontier within ILC.** The main spec describes taste being encoded over time as patterns crystallize. Within ILC, what parts of ontology maintenance can eventually be encoded (source pruning rules, category-gap detection, staleness thresholds) versus what remains permanent human work (ontology authorship itself)?
- **RLC-to-ILC promotion.** When a question keeps recurring as RLCs, it may indicate a standing domain that should graduate to its own ILC. Is there an explicit mechanism for noticing and promoting, or is it a taste-batch observation like any other?

---

## Appendix A — Quick reference

- ILC = standing, maintenance-mode lifecycle producing living domain state.
- Peer to SDLC/RLC/WLC/MLC at the execution layer; distinguished by the destination of its output (taste artifact layer, not world).
- Artifacts are semi-derived taste artifacts: machine-produced, human-approved.
- Per-turn signal-exhaustion termination preserves the main spec's laws.
- Ontology is authored, not derived. Same discipline as lane premises.
- Maintenance layer is slow and expensive; query layer is fast and cheap. Both required.
- Failure modes are different in kind from RLC; warrant distinct safeguards.
- Integrates with the specification layer as additional markdown files; semi-derived status is gated at file-write time via pending-diffs approval.
