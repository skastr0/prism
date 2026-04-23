---
name: epistemology-framework-readiness
description: Configure or audit a code repo, docs vault, or mixed workspace so the epistemology-framework plugin can deliver worldview inheritance, policy guardrails, provenance tools, destructive-command protection, SDLC/IAP work tracking, and optional knowledge mapping. Use when replacing basic workspace-readiness, bootstrapping a new OpenCode workspace, or diagnosing why framework capabilities are not taking effect.
---

# Epistemology Framework Readiness

Use this skill when a user wants a workspace to be fully ready for the epistemology-framework plugin, not merely generally tidy.

## What "framework-ready" Means

A ready workspace gives each framework layer somewhere clear to operate:

- **worldview** can discover meaningful `AGENTS.md` and `CLAUDE.md` files.
- **policy** can load `.opencode/policy.toml` and enforce real guardrails.
- **provenance** can expose `prov_*` tools and capture trustworthy local evidence.
- **mutation-risk** can remain the final stop for destructive bash commands.
- **SDLC/IAP** folders exist when the workspace needs durable work tracking or policy artifacts.
- **knowledge mapping** exists only when long-lived docs and navigation justify `.cmap`.

## Capability Map

- **Core framework capabilities**: see [capabilities.md](capabilities.md)
- **Configuration and rollout guidance**: see [configuration.md](configuration.md)
- **Policy authoring guidance**: see [policy-authoring.md](policy-authoring.md)
- **Readiness checklist**: see [checklist.md](checklist.md)
- **Example layouts**: see [layouts.md](layouts.md)
- **Starter snippets**: see [snippets.md](snippets.md)
- **Source-of-truth references**: see [references.md](references.md)

## First Classify The Workspace

- **Code repo**: prioritize validation commands, plugin discovery, policy, provenance, and mutation-risk.
- **Docs or knowledge folder**: prioritize worldview, policy, `.agents/`, and optional `.cmap`.
- **Mixed workspace**: establish one root, then separate code and durable docs into explicit subtrees.
- **Framework source repo**: treat it as a code repo, plus preserve `plugin/epistemology-framework/`, its barrel file, and its tests.

## Minimum Complete Setup

Always establish these first:

1. Confirm one stable workspace root.
2. Add a root `AGENTS.md` with package manager, validation commands, folder boundaries, and local conventions.
3. Create `.agents/messages/` and `.agents/sdlc/{backlog,exploring,committed,building,reviewing,done,abandoned}` when policy artifacts or durable work tracking matter.
4. Configure `opencode.json` so the normal read/search/edit/skill/task/bash path is usable.
5. Add `.opencode/policy.toml` when the workspace contains risky material, sensitive paths, or required review steps.
6. Expose local plugins with `plugin/<name>.ts` barrels and keep implementation in `plugin/<name>/`.
7. Add nested `AGENTS.md` files only at real boundary changes.
8. Initialize `.cmap` only when the workspace benefits from long-lived retrieval and atlas-style navigation.

## Layer Priorities

The framework composes in this order: **policy → worldview → provenance → mutation-risk**.

Configure in that same order:

1. **Policy**: decide what must be blocked, reviewed, or skill-gated.
2. **Worldview**: write the instructions that should be inherited by path.
3. **Provenance**: keep permissions and workflow structure rich enough that `prov_*` tools pay off.
4. **Mutation-risk**: keep destructive-command protection on unless there is a deliberate reason to soften it.

## Companion Skills

Use these alongside this skill when depth is needed:

- `agents-md-author` for strong root and nested `AGENTS.md` files
- `sdlc` for work-item and message discipline
- `research` when the workspace is a research vault, not just a code repo

## Output Pattern

When using this skill, produce:

1. Workspace classification and current framework coverage.
2. A short file plan.
3. Setup or repair changes in dependency order.
4. Verification commands or checks, grouped by layer.
5. Optional next upgrades.

When auditing an existing workspace, report each layer as **present**, **partial**, or **missing**.
