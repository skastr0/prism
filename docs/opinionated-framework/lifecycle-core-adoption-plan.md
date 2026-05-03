# Lifecycle Core Adoption Plan

Status: Accepted
Date: 2026-04-23

## Purpose

This plan records how the shared execution lifecycle plugins converge on `lifecycle-core` without recreating the old OpenCode-local braid.

`lifecycle-core` is the canonical substrate for lifecycle-domain filesystem protocols:

- contract-heavy lifecycle/IAP messages in `.agents/messages/`
- lifecycle work items in `.agents/{sdlc,rlc,mlc,wlc}/`

It is not the owner of broad domain knowledge, session transport, or harness-native UX.

## Current Assessment

| Surface | Current State | Adoption Direction |
|---------|---------------|--------------------|
| `sdlc` | Already depends on `lifecycle-core` for message packet tools and generated OpenCode synthetic submission tools. Work-item helpers now exist in `lifecycle-core`, but are not yet exposed as generated agent tools. | Keep as first consumer. Add lifecycle-owned work-item tool exposure before proof/cleanup. |
| `rlc` / RLC | Depends on `lifecycle-core`, owns `rlc.lifecycle.ts`, and assigns lifecycle work-item tool permissions through the RLC orchestrator. | Keep `.agents/rlc/` as the lifecycle work-item root. Keep `research` as the broad domain skill/surface. |
| `mlc` / MLC | Depends on `lifecycle-core`, owns `mlc.lifecycle.ts`, and assigns lifecycle work-item tool permissions through the MLC orchestrator. | Keep `.agents/mlc/` as the lifecycle work-item root. Keep `marketing` as the broad domain skill/surface. |
| `wlc` / Writing | Depends on `lifecycle-core`, owns `wlc.lifecycle.ts`, and assigns lifecycle work-item tool permissions through the WLC orchestrator. | Keep `.agents/wlc/` as the lifecycle work-item root. Keep `writing`, voice, and platform skills as broad domain capabilities. |
| `iap-protocol` and `work-tracking` docs | Still describe plugin-owned work items with broad folders such as `.agents/research`, `.agents/marketing`, and `.agents/writing`. | Update after lifecycle-root migration so global guidance distinguishes lifecycle roots from broad domain state. |

## Ownership Rules

Lifecycle method roots are:

- `.agents/sdlc/`
- `.agents/rlc/`
- `.agents/mlc/`
- `.agents/wlc/`

Broad domain folders and skills are separate concepts. `research`, `marketing`, and `writing` can remain domain skills or project knowledge areas, but they are not the lifecycle work-item roots.

Lifecycle work-item ids use:

```text
<CODE>-<NNN>[subtask]
```

Creation generates filenames as:

```text
<CODE>-<NNN>[subtask]-<title-slug>.md
```

Agents should mutate lifecycle work items by id through tools, not by constructing filenames.

## Tool Exposure Direction

The canonical work-item tool implementations now exist:

- `create_item`
- `list_items`
- `read_item`
- `update_item`
- `transition_item`
- `promote_item`
- `get_board`

Generated OpenCode plugins expose these through lifecycle-level `tool_permissions` on concrete lifecycle source files.

Do not solve this by making traits lifecycle-owned. Traits remain agent capability declarations; lifecycle files relate agents to each other. A lifecycle-level tool permission says:

- this lifecycle root is `sdlc`, `rlc`, `mlc`, or `wlc`
- these assigned agents may call the lifecycle work-item tools for that root
- generated tool names remain agent-owned and visible only to the assigned agent
- the canonical handler remains shared in `lifecycle-core`

This preserves the non-circular model:

```text
canonical lifecycle-core tool
+ lifecycle `tool_permissions` root binding
+ agent assignment
+ lowerer
= agent-visible synthetic lifecycle work-item tool
```

## Migration Sequence

1. Bind SDLC agents to work-item tools through `tool_permissions` and prove generated OpenCode tools can create/read/transition an item under `.agents/sdlc/`.
3. Keep `rlc`, `mlc`, and `wlc` as the canonical domain lifecycle plugin identities, with broad domain skills remaining under their owning lifecycle plugins where useful.
4. Refresh generated OpenCode outputs after lifecycle tool-architecture changes so stale generated plugin roots do not coexist with canonical ones.
5. Audit global guidance for any remaining broad-domain folder references and distinguish them from lifecycle state roots.
6. Update global `iap-protocol` and `work-tracking` guidance after the lifecycle roots are migrated, preserving any broad-domain state guidance only where it is intentionally not lifecycle state.
7. Run the generated lifecycle proof item. Only after generated message tools and generated work-item tools are live should old OpenCode-local `iap-sdlc*` residue be deleted.

## Non-Goals

- Do not move OpenCode session transport into `lifecycle-core`; `session-inbox` owns that harness-native shape.
- Do not make `research`, `marketing`, or `writing` synonymous with lifecycle roots.
- Do not attach lifecycle instance semantics directly to reusable traits.
- Do not delete old OpenCode-local lifecycle plugin residue until the generated replacement tools are proven live.
