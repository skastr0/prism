# Prism — brief

updated: 2026-09-24 · version: 0.8.1 · maturity: usable-with-gaps

Maturity: 23 npm releases, green CI, and I run my own multi-agent work through it; but I'm the only user I can show, the run ledger is local SQLite, and live runs have no cost cap.

## One line

Prism runs your coding agents from typed, checked Effect workflows.

## The pain

- **No types.** You ask two agents to review a commit, from a script or a chat. Each answers in its own prose, and you read it or scrape it.
- **No checks, no retries.** A "revise" with no findings flows straight into your next step. A malformed reply or a flaky exit, and you start over by hand.
- **No resume, no record.** The script dies halfway and every finished task runs again at full token cost. Afterwards nothing says which agent answered what, on which model, in how long.

## What changes

A task is a harness CLI, a prompt, an Effect `Schema` the answer must decode into, and checks the decoded answer must pass. A workflow is an Effect program over tasks, so fan-out is `Effect.all`. A reply that fails the schema or a check gets a repair prompt; one that still fails ends the task with a typed error, never bad data downstream. Every run lands in a SQLite ledger: rerun it and finished tasks replay from the cache, and `prism workflow runs trace` shows who did what.

(Receipts: See it run 1–4. Repair budgets: `docs/workflows.md`, "Output schemas and decode repairs" and "Finish criteria".)

## Where it fits

Several agents on one piece of work, each in its own harness, answering the same typed contract: Codex and Claude reviewing one commit in parallel is one `Effect.all`. The same tool also installs one set of skills, rules, and tools into every harness, so those agents share a toolbox; Quasar's 17 tools reach them this way (`prism tools invoke quasar <tool>`).

## See it run

All runs: published `prism` 0.8.1, 2026-09-24, from the Prism repo (a Git repo; Codex needs one), with my own Codex and Claude Code logins. The workflow is `review.workflow.ts`, shown in the README.

**1. Mistakes fail before any tokens are spent.** Claude Code can't enforce a Codex sandbox mode, and the types know it:

```text
$ prism workflow typecheck bad-perm.workflow.ts
❌ Workflow typecheck failed: workflow type error in bad-perm.workflow.ts:
bad-perm.workflow.ts:35:37: Argument of type '{ worker: "claude-code"; model: "sonnet"; permission: "sandbox-read-only"; }' is not assignable to parameter of type 'WorkflowTaskWorkerOptions'.
  Types of property 'permission' are incompatible.
    Type '"sandbox-read-only"' is not assignable to type 'ClaudeWorkflowPermissionMode | undefined'.
```

**2. Answers are checked.** A mocked "revise" with no findings fails the finish check (no tokens spent):

```text
$ prism workflow run review.workflow.ts --mock-output mock.json
❌ Workflow run failed: workflow task codex failed finish criterion 'a non-ship verdict names its findings': verdict without findings
```

**3. Two agents, one contract, live.** Codex and Claude review HEAD (`327d206`) in parallel; 34.5 s wall clock:

```text
$ prism workflow run review.workflow.ts
{
  "runId": "ee259bf3-204f-4b02-8614-9fa56868bc5b",
  "tasks": [
    { "id": "codex", "status": "completed", "cached": false,
      "output": { "verdict": "revise", "findings": [
        "README.md:117 [MEDIUM] The new prose promises a backup whenever a file is repaired. Source changes also produce a `repair`, but `src/sync/plan.ts:279-280` sets `backup: false` for them; ...",
        "README.md:117 [LOW] The TypeScript source list drops `*.sop.ts`, ..." ] } },
    { "id": "claude", "status": "completed", "cached": false,
      "output": { "verdict": "ship", "findings": [ "327d206 is docs-only: ...", ... ] } }
  ]
}
```

Codex's finding was correct; the README was fixed from it.

**4. The ledger.** A rerun replays both tasks from the cache (1.8 s), and the trace shows the parallel run:

```text
$ prism workflow run review.workflow.ts          # again
    { "id": "codex", "status": "completed", "cached": true, ... }
    { "id": "claude", "status": "completed", "cached": true, ... }

$ prism workflow runs trace ee259bf3-204f-4b02-8614-9fa56868bc5b
✓ workflow.run · review-commit · 32.9s
└─ ✓ workflow.program · 32.9s
   ├─ ✓ workflow.task · codex · 32.9s
   │  └─ ✓ task.executor · attempt 0 · codex-cli · 32.8s
   └─ ✓ workflow.task · claude · 24.3s
      └─ ✓ task.executor · attempt 0 · claude-code sonnet · 24.3s

$ prism workflow runs summary d1ab489c-c6ae-4d40-964b-f13e5a6e257e
Tasks: total 2, fresh executions 0, cache hits 2, repairs 0
```

## How it works

`defineTask` binds a harness (`worker`), prompt, output `Schema`, optional `cacheKey`, and `finish` criteria; `defineWorkflow` takes a task list or an Effect `run(wf)` program that calls `wf.runTask` (`docs/workflows.md`). `src/workflow-runtime.ts` spawns the harness CLI through that harness's adapter, with its own login, model, and permission mode. The final message must decode into the schema (`src/workflow-errors.ts:8` on failure; 2 decode repairs by default), then pass the finish criteria (deterministic code, or a judge verdict of pass / continue / fail / escalate). Runs, tasks, events, and spans go to a per-project SQLite store under `PRISM_HOME`; completed results are cached by task id, `cacheKey`, and a hash of what ran, so a rerun replays them. 13 harnesses can run tasks (every `HarnessId` except `pi`, `src/lowerer-capabilities.ts`).

The second half, the compiler: `prism refresh` turns one plugin (`plugin.json` plus `agents/`, `skills/`, `tools/`, `hooks/`, `rules/`) into each harness's own files, records what it wrote in `~/.prism/state/roots/`, backs up a hand-edited file before repairing it, and refuses files it never wrote.

Diagram spec (text only; no visual approved):

- nodes: `review.workflow.ts` · `prism workflow typecheck` · `wf.runTask` × N · harness adapter · harness CLI (codex, claude, …) · `Schema` decode · finish criteria · repair prompt · SQLite ledger · task cache · `runs trace` / `runs summary`
- edges: workflow file → typecheck → `wf.runTask` (parallel) → adapter → harness CLI → decode → finish criteria → ledger; decode or criteria failure → repair prompt → harness CLI; ledger → cache → `wf.runTask` (replay); ledger → trace / summary

## Who it is for / not for

For:
- someone who already runs Claude Code, Codex, or another agent CLI and wants several of them on one task with typed answers
- someone who writes TypeScript and is happy to write Effect
- someone who wants a record of every agent run they can read back and replay

Not for:
- anyone who wants a hosted service or a model API SDK: Prism drives CLIs you have installed and logged into
- anyone who needs a hard cost cap per run (there is none)
- Windows users (no Windows build)

## Install

```bash
npm install -g @skastr0/prism
```

Binaries for darwin-arm64, darwin-x64, linux-arm64, linux-x64 (`packages/npm/prism-*/package.json`). Workflows need the harness CLIs you name installed and logged in; live runs spend their tokens.

## Proof

- Released: `0.8.1` on 2026-09-24; 23 versions on npm (`npm view @skastr0/prism versions`). Publish run: https://github.com/skastr0/prism/actions/runs/35974633094.
- Tests: `bun run test:ci` in the 0.8.1 release gate: 1,623 pass, 0 fail across 157 files.
- Today's runs: `ee259bf3…` (live, 2 fresh tasks), `d1ab489c…` (2 cache hits, 1.8 s).
- Harness reach: 13 workflow harnesses (`src/lowerer-capabilities.ts`, `workflowWorker: true`); the capability matrix marks 10 targets live-proven (`docs/lowerer-capability-matrix.md`).
- Daily use: my own multi-agent work runs through Prism workflows and plugins (85 plugin sources in `~/Projects/prism-plugins`; 21 generated Claude Code plugins).
- GitHub: `skastr0/prism`, public, 2 stars.

## Gaps

- **Codex tasks fail outside a Git repo:** `codex exited with 1: ... Not inside a trusted directory and --skip-git-repo-check was not specified.`
- **No cost cap.** No timeout, token, or cost ceiling by design (`docs/workflows.md`, "Running and operating"); scope is set by the prompt, model, and graph.
- **The ledger is local.** A per-project SQLite store, not distributed durable execution. `docs/workflow-production-readiness-audit-2026-07-21.md` still lists open rows.
- **`runs resume` output unclear.** Resuming a completed run today printed a new run id with an empty task list (unverified whether that is the intended no-op).
- **No Pi workflow adapter**; Cursor and Pi compile output is checked against saved expected output, not loaded live.
- **One user.** No evidence of anyone else running it.

## Demo moments

1. **Typed before it runs** (terminal, ~10 s): `typecheck` rejects a Codex sandbox mode on a Claude task. Proves mistakes fail before tokens are spent.
2. **Two agents, one contract** (terminal, ~40 s, sped up): the live review run, then the `runs trace` tree. Proves parallel harnesses returning the same typed shape.
3. **Rerun is free** (terminal, ~5 s): the same command again, both tasks `"cached": true` in 1.8 s. Proves the ledger.

## Copy bank

- tagline: Typed workflows for your coding agents.
- short description: Prism runs Claude Code, Codex, and other agent CLIs from typed Effect workflows: schema-checked answers, repair loops, and a ledger you can replay.
- page lede: Prism runs the coding agents you already use, Claude Code, Codex, and eleven more, from workflows you write in TypeScript with Effect. Every answer is checked against a schema before your code sees it, and every run is recorded, so a rerun replays finished work instead of paying for it again.
- X post: I stopped running agents from scripts. In Prism a task is a harness, a prompt, and a schema its answer must decode into. Codex and Claude review a commit in parallel, a bad answer gets a repair prompt, and a rerun replays both from the ledger in 2 seconds.
- limits a user needs (page, stated once where they hit them; no maturity labels in public copy, SPINE §3b):
  - macOS and Linux only (no Windows build).
  - Run Codex tasks from inside a Git repository.
  - A live run spends the harness's tokens and has no built-in cost cap.
