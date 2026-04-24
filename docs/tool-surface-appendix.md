# Appendix: The Tool Surface

Companion to the Lifecycle Primitive. A specification for how agent outputs are constrained by tool signatures rather than described by prose schemas, and how this reshapes phase composition, encoded taste, and the agent layer itself.

---

## 0. Purpose

The main spec treats tools as part of an agent's character ("narrow tools encode the domain ontology") but does not formalize how tools are produced, specialized per project, or related to encoded taste. This appendix extracts that formalization.

The core move: agent outputs are constrained by tool signatures rather than described by prose schemas. A tool's type is the contract. The agent cannot emit an output that violates it. Business logic lives in the tool body, not in prose the agent is hoped to follow. This collapses a class of drift failures that prose-level schema descriptions cannot mechanically prevent.

Positioning: lateral to all execution lifecycles. Every phase compiles against a tool surface; the surface is as much a parameter of the phase as prose identity and signal state are.

---

## 1. The problem this solves

Prose-level schemas describe shapes the agent is hoped to produce. Enforcement is interpretation — the agent reads the schema carefully enough to match it. Failure is silent: the agent emits something *almost* right, downstream consumers accept it, the schema and output drift, invariants erode, nothing flags the violation.

Tools collapse this. When the only way for an agent to produce a `ReviewDeliverable` is to call `submit_review(...)`, the schema is the function signature. The inference layer rejects malformed arguments before they become outputs. Business logic — validation, provenance tagging, downstream signal emission, audit logging — runs in normal code on normal infrastructure with normal testing. There is no second copy of the schema to disagree with.

The distinction is not cosmetic. Prose schemas fight drift with reading comprehension; tool schemas fight drift with type systems. The architecture uses the stronger mechanism wherever it applies.

---

## 2. The primitive

```
ToolSurface<Phase, Project>:
  Inputs:
    CanonicalTools      : one logical tool = one strict contract + one implementation
    TraitAttachments    : semantic attachments/refinements over canonical tools
    SlotBindings        : agent/project-specific schema specializations
    Lowerer             : target-native wrapper generation strategy

  Structure:
    ToolDefinitions     : canonical authored tools in `tools/`
    SyntheticWrappers   : per-agent/per-target generated wrappers where needed
    Descriptions        : natural-language explanations injected alongside

  Runtime:
    BuildTime           : compiler resolves canonical tools + refinements and emits artifacts
    LoadTime            : harness loads the concrete surface for this target
    ExecutionTime       : surface is fixed; wrappers delegate to canonical implementations

  Termination:
    Not applicable — a surface is a static artifact, not a process
```

### Laws

**Immutability during phase execution.** A phase's tool surface is fixed at instantiation. Tools do not appear, disappear, or change shape mid-run. This preserves the ephemeral-agent property that a phase's capabilities are a function of its instantiation, not its trajectory.

**Mutation through evolution only.** Tool surface changes occur in the evolve phase of the lifecycle above, where a new build is produced for the next turn. Mid-run tool mutation re-introduces the instability ephemeral fanout was designed to eliminate.

**Build-time synthesis, dynamic load.** The compiler emits each phase's tool definitions as real artifacts on disk at build time. The runtime loads them dynamically at phase instantiation. This closes the free-audit loop: every phase's exact tool surface is a diffable artifact alongside its prose and transcripts.

**Project-first specialization.** Tools are specialized through canonical implementations plus safe refinements. A review tool for Ripple, an OSS project, and an info product may share a canonical implementation and differ through bound schemas, descriptions, or domain-local downstream behavior. The specialization axis is still the project/domain; the implementation is no longer duplicated when the behavior is actually the same.

---

## 3. Canonical tools and protocol families

The current architecture no longer centers on factories. It centers on **canonical tools**.

Most tools across the system share semantics, but the canonical answer is now:

- one logical tool
- one authored implementation in `tools/`
- traits attach/refine it
- lowerers generate the target-native wrapper surface

This lets the system share real business logic without duplicating per-agent contracts.

Some tool families are domain protocol families rather than ad hoc helpers. For example, lifecycle-domain packet tools now belong in a reusable canonical plugin (`lifecycle-core`) that owns:

- packet/work-item schemas
- filename policy
- persistence rules
- canonical handles

By contrast, harness-session transport and sendoff behavior belong in harness-native plugin projects (for example `session-inbox` for OpenCode) because they require harness SDK hooks, session APIs, or TUI runtime directly.

That split is more important than any generic factory abstraction. It keeps portable domain protocols separate from harness-native transport.

The authored model for filesystem-backed protocol families is documented in `docs/protocol-family-authoring.md`. The current decision is conservative: protocol families do **not** need a new first-class compiler primitive yet. They are authored as schemas, shared TypeScript persistence modules, canonical tools, trait attachments or lifecycle tool grants, and tests.

The immediate lifecycle families are intentionally different:

- lifecycle message packets are contract-heavy JSON audit artifacts under `.agents/messages/`
- lifecycle work items are markdown state artifacts under `.agents/{sdlc,rlc,mlc,wlc}/`

Both families require tool-owned filename policy. Neither should let agents supply final filenames or raw mutation paths.

---

## 4. Project-specific specialization

A project's tool surface encodes that project's definition of its key operations. "Reviewed," "shipped," "publishable," "escalation-worthy" — these are taste acts. Project specialization means each project supplies its own implementations of tool semantics that are shared in name but distinct in invariant.

```
  submit_review (Ripple)         submit_review (OSS)            submit_review (InfoProduct)
  ───────────────────────        ─────────────────────          ────────────────────────────
  enforces UX taste              enforces contributor-          enforces voice and pricing
  references design system       friendly review heuristics     taste, funnel position
  emits ripple.qa signal         emits oss.maintainer signal    emits info.editorial signal
```

All three satisfy the phase's contract that the agent produces a review. None are interchangeable unless they truly share one canonical implementation. The project's taste is encoded directly in the canonical tool body and/or in the safe refinements applied above it.

This reframes what a "project" is in the architecture. A project is not just premises plus taste artifacts parameterizing generic lifecycles. A project is premises, taste artifacts, *and* a tool surface whose implementations enforce the project's specific invariants. The tool surface is load-bearing taste.

---

## 5. Encoded taste has two surfaces

The main spec defines encoded taste as "deterministic rules, infrastructure." This appendix refines that into two distinct surfaces:

**Declarative rules.** Configuration and thresholds that run passively inside execution loops — code quality thresholds, lint rules, content format constraints. Ambient; referenced by many phases; edited as data.

**Tool implementations.** Active gates on what an agent can emit. Authored as canonical tools, then specialized safely through trait attachments and slot bindings. Invoked by the agent through generated or native tool surfaces.

The two surfaces differ in runtime behavior, authoring surface, and evolution cadence:

| Property            | Declarative rules         | Tool implementations   |
|---------------------|---------------------------|------------------------|
| Runtime behavior    | Passive reference         | Active gate            |
| Authoring surface   | Configuration, rule files | TypeScript code        |
| Invocation          | Read during execution     | Called by the agent    |
| Evolution cadence   | Ambient edits             | Evolve-phase rebuilds  |
| Scope               | Often cross-project       | Usually per-project    |

Both are encoded taste. Both operate autonomously once defined. They are complementary, not alternatives. A review phase might rely on declarative rules (content format) *and* a tool implementation (project-specific approval logic).

The structural consequence worth keeping in view: per-project tool implementations become the primary vehicle by which encoded taste differs across projects. The lifecycles barely change across projects; the tool bodies change.

---

## 6. Agent collapse

When identity, prose, tools, signals, and taste artifacts are independent axes that the compiler composes, the named-agent count falls.

Sprawling agent lists are usually the symptom of missing decomposition. Each "agent" ends up encoding some combination of prose identity, tool assumptions, project context, and phase-specific logic, and because the combination is not separable, every new combination demands a new named agent. The combinatorial explosion is `|phases| × |projects| × |tool configurations|`.

Once the axes decouple:

- **Phases** are a small closed set across the four execution lifecycles plus higher-order lifecycles.
- **Projects** supply tool-surface specializations.
- **Tool surfaces** are composed at compile time from manifests and factories.
- **Prose identity** is parameterized by phase and project but is mostly stable.

A handful of strong phase definitions, per-project tool surfaces, and project-parameterized prose covers most of what previously looked like distinct agents.

### Test for named-agent status

If the difference between two agents collapses into a different manifest entry or a different project specialization, they are the same agent with different configuration. If the difference requires structurally different loop logic, different termination criteria, or genuinely distinct prose identity, they are distinct.

Most of what currently looks like a separate agent probably fails the first test. The agents that remain named tend to be the higher-order stable-identity ones from §8 of the main spec, plus specialists whose behavior is structurally different rather than merely configured differently.

---

## 7. Integration with the compiler

The main spec's compiler resolves `(interface + lane_impl + runtime_state) → concrete brief`. With the tool surface formalized, compilation expands:

```
(phase_type + project + signal_state + tool_manifest)
  → context_window + tool_surface
```

Both outputs are real artifacts:

- **Context window**: assembled from prose identity, task framing, taste artifacts, and live signals, as before.
- **Tool surface**: synthesized from the manifest, factories, and project specializations, emitted as concrete tool definitions on disk.

The agent runtime receives both as inputs to phase instantiation. Neither mutates during execution. Both are diffable and archivable. The compiler's job is assembly of both; the division between prose-side assembly and tool-side synthesis is internal to the compiler and invisible to everything below it.

### Runtime coupling

Per-session dynamic tool registration is not universal across agent harnesses. Accepting that the current implementation is shaped by the harness it targets is the healthy call, consistent with the main spec's treatment of cache economics: design for the runtime that exists, keep the primitive abstract enough that alternative implementations slot in if the landscape changes.

The primitive is portable in principle. The current implementation is coupled to harnesses that support dynamic tool surfaces at phase start. This is a deliberate scope choice, not a limitation to work around.

---

## 8. Division of labor (addition to §11 of main spec)

| Layer          | Tool-surface responsibility                                                     |
|----------------|---------------------------------------------------------------------------------|
| Human          | Canonical tool design, trait attachments, project/domain specializations |
| Interface      | Tool contracts, slot schemas, wrapper generation rules |
| Implementation | Canonical tool code plus any shared TypeScript modules it uses |
| Compiler       | Canonical tools + refinements → concrete build-time surfaces |
| Agent runtime  | Loads or registers the pre-built tool surface at phase instantiation |
| Signal layer   | Receives structured tool-call outputs and any downstream protocol artifacts |

---

## 9. Failure modes

**Canonical-tool drift.** Two tools that are semantically one tool evolve into duplicated implementations because the system fails to centralize them in one canonical source file. Mitigation: enforce one logical tool = one canonical implementation.

**Harness leakage.** A canonical tool quietly starts depending on harness SDK APIs, session transport, or TUI runtime. Mitigation: move those concerns into a standalone harness-native plugin project and keep the canonical tool pure TypeScript.

**Tool surface drift from prose.** Prose identity refers to tools by name or assumes capabilities the current surface does not have. This is the drift class the appendix exists to eliminate, but it can re-enter through prose assumptions about tools. Mitigation: prose identity never hard-codes tool field names; references are to tool *names*, and the tool's own description carries shape information into the assembled context.

**Mid-run mutation creeping in.** A well-intentioned pattern that lets an agent "install" a new tool during execution based on observed need. This is the instability case laws 1 and 2 exist to prevent. Mitigation: hard refusal at the runtime layer; tool-need observations are emitted as signals for the parent's next compilation, not satisfied inline.

**Project specialization as dumping ground.** Every project-specific quirk becomes a tool override, even where a shared tool with configuration would be cleaner. Mitigation: prefer manifest-level configuration over implementation-level override; reach for an override only when the invariant is genuinely project-local.

---

## 10. Relation to the broader architecture

```
Signal layer          → live signals, linear, consumed
Taste artifact layer  → persistent, referenced
  ├── Human-authored  (batch sessions)
  ├── Semi-derived    (ILC output, batch-approved)
  └── Encoded taste
        ├── Declarative rules        (ambient, data-like)
        └── Tool implementations     (active, code-like)    ← formalized here
Tool surface layer    → compiled from canonical tools + trait refinements + lowerers
Execution lifecycles  → SDLC, RLC, WLC, MLC
Higher-order          → ProductIdeation, Business, ...
Human                 → taste horizon
```

The tool surface sits between the taste artifact layer and the execution lifecycles. It is composed from canonical tool definitions, project/domain refinements, and lowering strategy, then feeds directly into the phase's concrete capabilities. It is not itself a lifecycle, does not produce world-facing artifacts directly, and does not terminate.

The cleanest framing: *a tool surface is the compiled expression of a project's encoded taste in the form of an agent-callable interface.*

---

## 11. Open questions

- **Tool description generation.** The natural-language description of a tool that the agent sees can itself be generated from the shape plus a short prose template. How much of the description should be generated vs. hand-written? Generated descriptions stay in sync with the shape but can read mechanically; hand-written ones are richer but drift-prone. Likely answer: shape-derived skeleton with hand-written prose layered on top, both versioned alongside the tool.
- **First-class protocol-family primitive.** Filesystem-backed protocol families now have an authored model using schemas, shared writers, canonical tools, and tests. A future compiler primitive may be warranted if multiple families need common discovery, migration, or generated documentation beyond what ordinary modules provide.
- **Cross-project tool promotion.** When two projects converge on a genuinely identical tool implementation, should it be promoted to a cross-project shared tool? The encoding-frontier principle from the main spec suggests: yes, once the pattern is observed repeatedly, but not before. Premature sharing is premature abstraction.
- **Versioning and tool-surface migration.** When a factory's underlying template changes, every tool synthesized from it changes. How is this propagated safely across projects mid-work? Probably: rebuilds are per-project and scheduled at evolve-phase boundaries, but the mechanics of coordinating a breaking factory change across projects remains unresolved.
- **Bespoke-tool audit cadence.** Bespoke tools accumulate. At what interval is the bespoke set reviewed for extractable shared shape? Probably per-project evolve phase at minimum, with a cross-project review at a longer cadence.

---

## Appendix A — Quick reference

- Tools are the schema boundary for agent outputs. Prose describes; tools enforce.
- Tool surface is fixed at phase instantiation; mutation happens only in evolve phases.
- Build-time synthesis, dynamic load. Every surface is a diffable artifact on disk.
- Factory for the 80% that is semantically shared; bespoke for the 20% that is not.
- Project specialization is load-bearing. Same tool name across projects, different invariants.
- Encoded taste has two surfaces: declarative rules and tool implementations. Both autonomous.
- Agent count collapses once identity, prose, tools, signals, and taste artifacts decouple.
- Compiler output expands to `(context_window, tool_surface)`. Both are real artifacts.
