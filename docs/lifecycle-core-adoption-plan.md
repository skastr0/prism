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
| `sdlc-core` | Already depends on `lifecycle-core` for message packet tools and generated OpenCode synthetic submission tools. Work-item helpers now exist in `lifecycle-core`, but are not yet exposed as generated agent tools. | Keep as first consumer. Add lifecycle-owned work-item tool exposure before proof/cleanup. |
| `research-core` / RLC | Has `rlc.lifecycle.ts` and RLC agents, but no `lifecycle-core` dependency. Docs and command text still point work items at `.agents/research/`. | Adopt `.agents/rlc/` for lifecycle work items. Keep `research` as the broad domain skill/surface. |
| `marketing-core` / MLC | Has `mlc.lifecycle.ts` and MLC agents, but no `lifecycle-core` dependency. Docs and command text still point work items at `.agents/marketing/`. | Adopt `.agents/mlc/` for lifecycle work items. Keep `marketing` as the broad domain skill/surface. |
| `publishing-automation` / Writing | Has a `plc.lifecycle.ts` and `plc` skill surface, while the canonical lifecycle primitive names this execution lifecycle `WLC`. Docs and command text point work items at `.agents/writing/`. | Rename/converge the lifecycle method to WLC and adopt `.agents/wlc/`. Keep `writing`, voice, and platform skills as broad domain capabilities. |
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

The remaining gap is exposure. Generated OpenCode plugins currently mirror these canonical sources, but only trait-attached tools become registered synthetic tools in `server.ts`.

Do not solve this by making traits lifecycle-owned. Traits remain agent capability declarations; lifecycle files relate agents to each other. The clean next step is a lifecycle-level tool grant or equivalent compiler surface that says:

- this lifecycle root is `sdlc`, `rlc`, `mlc`, or `wlc`
- these assigned agents may call the lifecycle work-item tools for that root
- generated tool names remain agent-owned and visible only to the assigned agent
- the canonical handler remains shared in `lifecycle-core`

This preserves the non-circular model:

```text
canonical lifecycle-core tool
+ lifecycle assignment/root binding
+ agent assignment
+ lowerer
= agent-visible synthetic lifecycle work-item tool
```

## Migration Sequence

1. Add the compiler/lifecycle authoring surface for lifecycle-owned work-item tool grants, or an equivalent non-trait binding that keeps lifecycle ownership out of traits.
2. Bind SDLC agents to work-item tools through that surface and prove generated OpenCode tools can create/read/transition an item under `.agents/sdlc/`.
3. Migrate `research-core` to depend on `lifecycle-core`, adopt `.agents/rlc/`, and refresh RLC docs/commands/identities that still say `.agents/research/`.
4. Migrate `marketing-core` to depend on `lifecycle-core`, adopt `.agents/mlc/`, and refresh MLC docs/commands/identities that still say `.agents/marketing/`.
5. Rename/converge publishing's lifecycle method from PLC to WLC, adopt `.agents/wlc/`, and refresh writing docs/commands/identities that still say `.agents/writing/` as lifecycle state.
6. Update global `iap-protocol` and `work-tracking` guidance after the lifecycle roots are migrated, preserving any broad-domain state guidance only where it is intentionally not lifecycle state.
7. Run the generated lifecycle proof item. Only after generated message tools and generated work-item tools are live should old OpenCode-local `iap-sdlc*` residue be deleted.

## Non-Goals

- Do not move OpenCode session transport into `lifecycle-core`; `session-inbox` owns that harness-native shape.
- Do not make `research`, `marketing`, or `writing` synonymous with lifecycle roots.
- Do not attach lifecycle instance semantics directly to reusable traits.
- Do not delete old OpenCode-local lifecycle plugin residue until the generated replacement tools are proven live.
