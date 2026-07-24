<p align="center">
  <img src="assets/brand/prism-icon.png" alt="Prism" width="160" height="160" />
</p>

<h1 align="center">Prism</h1>

<p align="center"><strong>Author your agent stack once. Refract it into every harness.</strong></p>

<p align="center">
  Agents, skills, tools, hooks, and typed multi-model workflows — written once in TypeScript,<br />
  compiled native for <strong>Claude Code, Codex, OpenCode, Grok, Kimi, Amp, Cursor</strong> and seven more.
</p>

<p align="center">
  <code>npm install -g @skastr0/prism</code>
  ·
  <a href="https://www.npmjs.com/package/@skastr0/prism">npm</a>
</p>

---

## Table of contents

- [The pain](#the-pain)
- [What Prism does](#what-prism-does)
- [Install & quick start](#install--quick-start)
- [One source, fourteen harnesses](#one-source-fourteen-harnesses)
- [The authoring surface](#the-authoring-surface)
- [Workflows: typed task graphs over real harnesses](#workflows-typed-task-graphs-over-real-harnesses)
- [Stateless tools — no daemon, no MCP](#stateless-tools--no-daemon-no-mcp)
- [Convergence: refresh, plan, doctor](#convergence-refresh-plan-doctor)
- [Packages](#packages)
- [Development](#development)
- [Status](#status)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## The pain

You don't run one AI coding harness anymore.

- **Every harness speaks its own dialect** — the agent you wrote for Claude Code is a rewrite away from Codex, again for OpenCode, again for whatever ships next month
- **Your best prompts rot in dotfiles** — agents, skills, and hooks scattered across `~/.claude`, `~/.codex`, `~/.config/opencode`, unversioned, drifting, unreviewable
- **Multi-model work is ad hoc** — fanning one task across Claude, GPT, Grok, and Kimi means shell scripts, copy-paste, and no typed contract on what comes back

## What Prism does

<p align="center">
  <img src="assets/brand/prism-hero.png" alt="One beam in, a spectrum of parallel rays out" width="720" />
</p>

**Prism is a compiler.** One typed plugin source goes in; native agents, skills, tools, and hooks come out for fourteen harnesses — each artifact written in that harness's own format, converged idempotently, with drift detection and managed backups. White light in, spectrum out.

And because Prism knows every harness on your machine, it can also **conduct them**: Prism workflows are typed, Effect-powered task graphs that dispatch real harness workers, force schema-typed outputs, verify them with finish criteria, and persist every run in a durable SQLite ledger.

### Why builders choose it

- **One source of truth** — your whole agent stack is a TypeScript package: versioned, reviewed, tested, distributed
- **Native output, not lowest-common-denominator** — each harness gets artifacts in its own idiom: plugin bundles for Claude Code, TS plugin APIs for OpenCode and Amp, config patches and markdown where that's the native shape
- **Typed multi-model workflows** — `defineWorkflow` + Effect: fan a council across four model vendors, force every seat to return the same `Schema.Struct`, synthesize with a fifth
- **Outputs you can trust** — deterministic and judge finish criteria with bounded repair loops; schema decode failures get repaired, not shipped
- **A durable ledger** — every run in SQLite: replayable task cache, resume after a crash, span traces with OTLP export, evidence bundles
- **Convergent by construction** — drift fails closed, stale artifacts get pruned, and backups live outside your config dirs
- **Stateless tool runtime** — compiled tools load in-process from one CLI; no daemon, no socket, no MCP server to babysit

### Is / is not

| Prism **is** | Prism **is not** |
|---|---|
| A compiler from one typed source to fourteen native harness configs | A lowest-common-denominator wrapper API |
| A typed workflow engine dispatching real harness CLIs | Another SDK calling raw model APIs |
| Stateless CLI tools loaded in-process | A daemon, an MCP server, or a protocol sidecar |
| Convergent and idempotent — refresh twice, change nothing | A dotfile templater that clobbers your config |

## Install & quick start

```bash
npm install -g @skastr0/prism
```

```bash
# 1. Scaffold a harness-aware plugin (agents, skills, tools, hooks)
prism init my-standards --with-agent --with-skill --typescript

# 2. Preview exactly what would be written, per harness
prism plan my-standards --all

# 3. Converge — compile + write native artifacts for the harnesses you target
prism refresh my-standards --harness claude-code,codex-cli,opencode

# 4. Verify state and harness config health any time
prism doctor
```

Explore interactively with `prism plugins <dir>` (plugin manager TUI) and validate structure with `prism validate <plugin-path>`.

## One source, fourteen harnesses

`prism harnesses` — the compile targets, with where each harness lives on disk:

| Harness | ID | Global | Project |
|---|---|---|---|
| Claude Code | `claude-code` | `~/.claude/` | `.claude/` |
| Codex CLI | `codex-cli` | `~/.codex/` | `.codex/` |
| OpenCode | `opencode` | `~/.config/opencode/` | `.opencode/` |
| Grok Build | `grok` | `~/.grok/` | `.grok/` |
| Kimi Code | `kimi-code` | `~/.kimi-code/` | — |
| Amp Code | `amp-code` | `~/.config/amp/` | `.agents/` |
| Antigravity CLI | `antigravity-cli` | `~/.gemini/antigravity-cli/` | `.agents/` |
| Cursor | `cursor` | `~/.cursor/` | `.cursor/` |
| Factory Droid | `factory-droid` | `~/.factory/` | `.factory/` |
| Pi | `pi` | `~/.pi/agent/` | `.pi/` |
| Oh My Pi | `omp` | `~/.omp/agent/` | `.omp/` |
| Hermes | `hermes` | `~/.hermes/` | — |
| OpenClaw | `openclaw` | `~/.openclaw/` | — |
| Devin CLI | `devin` | `~/.config/devin/` | `.devin/` |

Each harness has a dedicated lowerer that knows its native surface — plugin bundle, TS plugin API, markdown file, or config patch — and golden-fixture tests pin the generated output. The full support matrix, including which targets are proven live versus compile-verified, lives in [`docs/lowerer-capability-matrix.md`](docs/lowerer-capability-matrix.md).

## The authoring surface

Eight typed source contracts. Everything you author is one of these:

| Contract | What it declares |
|---|---|
| `AgentSource` | An agent: identity, personality, model, traits, skills, harness targets |
| `TraitSource` | A reusable capability grant: instructions + tool permissions agents inherit |
| `ToolSource` | A canonical tool: Effect Schema input/output + one `handle` implementation |
| `OrbitSource` | A phased multi-agent process: phases, orchestrator, checkpoints, evolution |
| `HookSource` | A harness lifecycle hook: event, matcher, Effect-returning handler |
| `ToolspaceSource` | Logical tool names mapped to harness-final names per target |
| `ModelspaceSource` | Named model profiles resolved per harness/provider |
| `SkillspaceSource` | Skill sets mapped per target |

A tool is defined once, with real schemas and one implementation:

```ts
import { Schema } from "effect";
import type { ToolSource } from "prism";
import { challengeProof } from "./proof";

export default {
  name: "challenge_echo",
  description: "Returns a keyed proof that this generated Prism tool executed.",
  input: Schema.Struct({ challenge: Schema.String }),
  output: Schema.Struct({
    challenge: Schema.String,
    proof: Schema.String,
    source: Schema.Literal("prism-generated-tool"),
  }),
  handle(input) {
    return {
      challenge: input.challenge,
      proof: challengeProof(input.challenge),
      source: "prism-generated-tool" as const,
    };
  },
} satisfies ToolSource;
```

Traits grant it, agents bind it — and agents can fill **tool-owned slots** with their own schema fragments, which the compiler validates as part of the agent-facing contract:

```ts
// trait: permission to the canonical tool
export default {
  name: "submittable",
  tools: { submit_work: { ref: "orbit-core:submit_work" } },
} satisfies TraitSource;

// agent: binds the trait, fills a tool-owned slot with a typed report schema
export default {
  name: "builder",
  description: "Builds scoped changes",
  identity: "builder",
  traits: [{
    trait: "submittable",
    tools: { submit_work: { slots: { builder_report: BuilderSubmitWorkReport } } },
  }],
} satisfies AgentSource;
```

The law behind it: **permissions expose tools, only filled slots synthesize new tool shapes, and the compiler never re-renders your Effect schemas** — your runtime artifacts pass through byte-stable. Full design: [`docs/tools-architecture.md`](docs/tools-architecture.md).

The canonical public names are the `*Source` contracts above; the older `define*` helpers remain as transitional identity wrappers for authoring ergonomics.

## Workflows: typed task graphs over real harnesses

A Prism workflow doesn't call a model API — it **dispatches a real harness CLI** (Claude Code, Codex, Grok, Kimi, OpenCode, Amp, …) as a worker, with a pinned model, a permission sandbox, and a schema the worker's final answer must decode into.

### A task is a typed contract

```ts
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs"; // typed refs generated by `prism refresh`

const Review = Schema.Struct({
  verdict: Schema.Literal("ship", "revise", "block"),
  findings: Schema.Array(Schema.String),
  riskiestAssumption: Schema.String,
});

const review = defineTask({
  id: "adversarial-review",
  agent: agents.forge.securityReviewer,
  worker: { worker: "codex-cli", model: "gpt-5.6-terra", permission: "sandbox-read-only" },
  output: Review,                     // the worker's answer MUST decode into this
  cacheKey: "release-review-v1",      // durable ledger: reruns replay from cache
  prompt: "Attack the diff on this branch. Default to refuted.",
  finish: {
    maxRepairs: 1,
    criteria: [{
      kind: "deterministic",
      name: "non-ship verdicts need findings",
      check: ({ output }) =>
        output.verdict !== "ship" && output.findings.length === 0
          ? Effect.fail(new Error("A non-ship verdict needs findings"))
          : Effect.void,
      repairPrompt: () => "Name the findings that justify your verdict.",
    }],
  },
});
```

Malformed JSON doesn't crash the run and doesn't get shipped: decode failures trigger bounded repair prompts (default 2), separately budgeted from your finish-criteria repairs.

### A workflow is an Effect

Dynamic workflows get the full Effect toolkit — `Effect.gen`, structured concurrency, `Effect.either` per arm, spans on every step. This is a condensed version of a real council workflow that fans one brief across **four model vendors**, then synthesizes with a fifth:

```ts
export const workflow = defineWorkflow({
  name: "voice-council",
  run: (wf) =>
    Effect.gen(function* () {
      const seats = [
        { id: "grok-positioning", worker: { worker: "grok",            model: "grok-4.5" } },
        { id: "agy-strategy",     worker: { worker: "antigravity-cli", model: "Gemini 3.5 Flash (Low)" } },
        { id: "kimi-voice",       worker: { worker: "kimi-code",       model: "kimi-code/kimi-for-coding" } },
        { id: "opencode-proof",   worker: { worker: "opencode",        model: "ollama-cloud/glm-5.2" } },
      ];

      // Independent seats, one typed contract, failures isolated per arm
      const settled = yield* Effect.all(
        seats.map((seat) => Effect.either(wf.runTask(councilTask(seat)))),
        { concurrency: "unbounded" },
      ).pipe(Effect.withSpan("council.fanout"));

      const reports = settled.flatMap((r) => (r._tag === "Right" ? [r.right] : []));

      // A fifth vendor synthesizes — reports are evidence, not authority
      return yield* wf.runTask(synthesisTask({
        worker: { worker: "codex-cli", model: "gpt-5.6-terra", permission: "sandbox-read-only" },
        reports,
      })).pipe(Effect.withSpan("council.synthesis"));
    }),
});
```

Every seat returns the same `Schema.Struct`. No JSON scraping, no prompt-and-pray: a council whose members are Grok, Gemini, Kimi, GLM, and GPT — each behind its own harness, each type-checked on the way out.

### Judges, not just checks

Finish criteria come in two kinds. Deterministic checks are code. **Judge criteria** are structured verdicts — `pass`, `continue`, `fail`, `escalate` — with evidence selection, so acceptance can be a judgment call without becoming an untyped one:

```ts
{
  kind: "judge",
  name: "claims are grounded",
  goal: "Every public claim traces to a receipt in the claim ledger.",
  selectEvidence: ({ output }) => ({ claims: output.claimLedger }),
  evaluate: ({ evidence }) => /* verdict: pass | continue | fail | escalate */,
}
```

### Phases: orbit contracts for multi-agent processes

`wf.phase(contract, fn)` scopes tasks under a named phase of an orbit — with shared agents, a default output schema, inherited finish criteria, and framing (telos, coordination, escalation) composed into every prompt. Each phase runs inside its own span: `workflow.phase.<orbit>:<name>`.

### The ledger

Every run persists to a SQLite store. That buys you operations, not just logs:

```bash
prism workflow run council.workflow.ts          # foreground run
prism workflow run council.workflow.ts --detach # background; returns a run id

prism workflow runs list                        # newest first
prism workflow runs summary --all               # machine-wide rollup across every store
prism workflow runs events <runId>              # append-only event stream
prism workflow runs trace <runId> --otlp <url>  # span tree; export to a collector
prism workflow runs export <runId>              # redacted JSON evidence bundle
prism workflow resume <runId> council.workflow.ts  # completed tasks replay from cache
prism workflow monitor                          # live run monitor TUI
```

Task results are content-addressed in a durable cache: resume a crashed run and finished tasks replay instantly; change a task's semantics and only that task re-executes. Inspect with `prism workflow cache list|show`.

### Budgets and guardrails

Runs are governed, not hopeful:

| Guard | Flag |
|---|---|
| Provider spend ceiling | `--max-cost-usd` |
| Wall-clock ceiling | `--max-wall-ms` |
| Live dispatch ceiling | `--max-tasks` |
| Per-task inactivity cutoff | `--task-no-progress-ms` |
| Prompt size ceiling | `--max-prompt-bytes` |
| Concurrency cap | `--max-concurrent-tasks` |

Transient worker failures retry with bounded attempts and backoff; config errors and cancellations never do. Each task pins one of seven permission modes, from `sandbox-read-only` to `full-access` — enforced per worker.

### Ten workers

`amp-code` · `antigravity-cli` · `claude-code` · `codex-cli` · `devin` · `grok` · `hermes` · `kimi-code` · `opencode` · `omp`

### Start in three moves

```bash
prism workflow scaffold my-first     # validating starter in ~/.prism/workflows
prism workflow catalog               # discover typed agent/orbit/model refs
prism workflow run ~/.prism/workflows/my-first.workflow.ts
```

`prism workflow typecheck` and `prism workflow validate` gate the file before anything dispatches; `--mock-output` lets you test a graph without spending a token.

## Stateless tools — no daemon, no MCP

Compiled tools are **stateless CLI only**. Agents use:

```bash
prism tools list
prism tools show <plugin>
prism tools invoke <plugin> <tool> --input '<json-object>'
```

Compile writes under `PRISM_HOME/runtime/tools/<plugin>/`:

- `catalog.json` — tool inventory
- `SKILL.md` — agent discovery (or always-on rules via `PRISM_TOOLS_CLI_INJECT=rules`)
- `runtime.mjs` — bundled handles loaded **in-process** by invoke (no daemon, no MCP)

Some harnesses (OpenCode, Amp, Pi, OMP) also register the same handles natively in their plugin APIs. Hooks customize harness behavior via native plugins or one-shot command wrappers — never a long-lived protocol server.

## Convergence: refresh, plan, doctor

Prism uses `~/.prism` for durable install and compile state (`PRISM_HOME` to override).

`prism refresh` is the unified convergence path: it compiles first when a plugin has compile targets for the selected harnesses, then reconciles file-router artifacts through the same sync engine. `prism plan` previews the same work without writing; `prism doctor` reports config and refresh-plan problems.

- `state/roots/*.json` tracks Prism-owned outputs per harness root — repeated refreshes skip unchanged files, **fail closed on drift**, and prune stale managed files
- `config.json` controls managed backups (`backup.mode`: `always`/`never`, `backup.retentionPerTarget`); backups live under `backups/`, never as sibling `.bak` files in your config dirs
- Idempotency is a tested invariant, not a hope: `bun run check:refresh-idempotency` runs refresh twice in isolated `HOME`/`PRISM_HOME` and fails on warm-run stale prunes, config churn, orphan hook blocks, snapshot churn, or backup churn

## Packages

| Package | What it is |
|---|---|
| [`@skastr0/prism`](https://www.npmjs.com/package/@skastr0/prism) | The CLI — public npm runner with per-platform binaries (`darwin-arm64/x64`, `linux-arm64/x64`) |
| [`@skastr0/prism-sdk`](https://www.npmjs.com/package/@skastr0/prism-sdk) | Core contracts and codecs: `compile-manifest`, `refs`, `snapshot`, `stable-json` subpaths |
| `@skastr0/prism-packager` | Embeddable packager: compile a plugin into harness-native `DesiredFile[]` payloads without shipping the CLI — release wiring landed, first registry publish pending |

## Development

```bash
bun install
bun run verify
bun run typecheck
bun run build
bun run check:refresh-idempotency
```

Release readiness for the npm CLI distribution:

```bash
bun run build:npm-cli
bun run pack:npm-cli:dry-run
bun scripts/smoke-npm-cli.ts --skip-build
```

The smoke script installs packed tarballs into a clean temporary project, compiles a canonical-tool fixture, and checks generated runtime output for build-machine paths. Public release actions still require maintainer approval for repository visibility, tag pushes, npm trusted publishing, protected environment approval, and the real registry publish.

## Status

Experimental, and honest about it: the package format, generated outputs, and harness adapters may change.

- Ten harness targets are **live-proven** (real workers dispatched end-to-end); Cursor, Factory Droid, and Pi are **compile-verified** — generated output is pinned by golden tests, live dispatch intentionally deferred. See [`docs/lowerer-capability-matrix.md`](docs/lowerer-capability-matrix.md)
- The workflow engine runs an Effect-based DAG with a durable SQLite ledger; it does not claim `@effect/workflow`-style durable execution
- Workflow production hardening is tracked in the open: [`docs/workflow-production-readiness-audit-2026-07-21.md`](docs/workflow-production-readiness-audit-2026-07-21.md)

## Security

Please report suspected vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## Contributing

Focused issues and small pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
