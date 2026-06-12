# 06 — Packages and the Workflows Meta-Plugin

## Package boundaries

```
@skastr0/prism-core        contracts, refs, loadPlugin/registry, snapshot codecs,
                           compile-manifest schema. No CLI deps. (WS1, extraction)
@skastr0/prism-workflow    wf.* facade, defineWorkflow, gate, budget,
                           approvals, worktrees, AgentRun ledger, worker gateway
                           + adapters, workflow CLI. Depends on core only. (WS2-4)
@skastr0/prism             existing CLI distribution — unchanged role; gains the
                           refs emitter + compile manifest writer (WS1) because
                           those run at compile time.
```

Workspace packages in the prism monorepo during extraction; separate npm
boundaries from day one so imports stay honest. Adapters live inside
prism-workflow until a third-party adapter exists; no premature
`prism-workers` split.

## The meta-plugin: workflows as a prism plugin

The strongest dogfooding move available: the workflow system distributes
*itself* through prism. The reference projects integrate with harnesses via a
copied skill markdown and nothing else; prism gets typed tools, scoped
permissions, hooks, and the skill — all generated, per harness, by machinery
that already exists.

`prism-plugins/workflows/`:

```
plugin.json
toolspaces/workflow-control.toolspace.ts
    workflow_validate        {file}                         → gate dry-run report
    workflow_run             {file|name, input, detach}     → workflowRunId + result
    workflow_status          {workflowRunId}                → typed status
    workflow_wait            {workflowRunId, timeoutMs}     → terminal envelope
    workflow_approve         {workflowRunId, approvalId, decision} → ApprovalDecision
    workflow_runs_list       {filter}                       → workflow run summaries
    workflow_events          {workflowRunId, afterSeq}      → event page
    workflow_agent_runs_list {key?, status?}                → durable AgentRun resources
    workflow_agent_run_get   {key|agentRunId, revision?}    → output/provenance refs
    workflow_agent_run_fork  {key|agentRunId, prompt, as}   → session-fork request
skills/
    workflow-authoring/SKILL.md     # teaches an agent to author workflows:
                                    # the facade primitives, generated-refs import,
                                    # explicit-id rule, validate-before-run loop
hooks/
    approval-notify.hook.ts         # surface approval_requested to the session
agents/ (optional, later)
    mission-conductor.agent.ts      # orchestrator agent pre-granted workflow tools
```

Tool implementations shell to `prism workflow ...` in v1. Importing the runtime
library directly from the MCP server is deferred until the CLI envelopes and
runtime API are stable; one client path prevents the wrapper from becoming a
second runtime. Existing mcp-bundle machinery compiles this wrapper to MCP
servers installed in **every supported harness** — Claude Code, Grok, Codex,
Antigravity, and notably **Hermes** (prism already lowers MCP servers into hermes
config).

This is a client, not the core. The durable architecture is the TypeScript
library plus CLI. Any agent can use the CLI directly through shell access. MCP is
added so tool-native harnesses, especially Hermes profiles, can operate the same
runtime without shell ceremony.

## What the meta-plugin closes

The loop, end to end:

1. An agent in any harness calls the CLI directly, or a Hermes/tool-native agent
   calls `workflow_validate` / `workflow_run` through typed MCP tools whose
   permissions prism compiled.
2. The workflow it wrote materializes or reuses durable AgentRun resources across
   claude / grok / codex / agy, and declared Hermes profile workers, with typed
   handoffs.
3. Results come back as schema-decoded AgentRun resources; the ledger is
   queryable through the same CLI/MCP client surface.

Hermes-orchestrating-Hermes concretely: a Hermes profile with the workflows MCP
server calls `workflow_run` on a mission that fans out to three other Hermes
profiles (class B) plus a codex builder (class A) — typed handoffs between all
of them, ledgered, budget-bounded, replayable by stable AgentRun key. None of
this exists today by any mechanism.

## Authoring loop for agents (the skill's contract)

```
1. read .prism/generated/workflows/agents.ts   (the fleet, as types)
2. write missions/<name>.workflow.ts           (facade primitives + plain TS)
3. bunx tsc --noEmit <file>                    (layer-0 validation, free)
4. prism workflow validate                     (gate dry-run, zero tokens)
5. prism workflow run --detach → wait          (execute, observe)
6. prism workflow agent-runs show <key>        (inspect durable resources)
```

Each step's failure mode is typed and names its remedy — the skill teaches the
loop, the tools enforce it.

When this loop is run via MCP rather than direct CLI, it still executes trusted
local workflow code. The wrapper must not claim stronger protection than the CLI
provides; it should surface the same validate report and then call the same CLI.

## Versioning and compatibility

- Generated refs carry the emitter version; prism-workflow refuses refs from a
  newer emitter (forward-incompatible) with "re-run prism refresh".
- Ledger/event rows carry `v`; the runner refuses newer versions.
- The compile manifest is versioned independently; gate refuses unknown major.
- Single-user phase: no compatibility layers, breaking changes regenerate
  (consolidation stance) — but version stamps exist from day one so refusals
  are typed rather than mysterious.
