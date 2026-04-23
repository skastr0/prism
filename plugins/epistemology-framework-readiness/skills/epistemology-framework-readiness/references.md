# References

Use these as the source of truth when extending or validating this skill.

## Framework Home

- `plugin/epistemology-framework/README.md` — framework home, layer order, policy behavior, provenance ownership, validation anchors
- `plugin/epistemology-framework/index.ts` — composition root and exported public surface
- `plugin/epistemology-framework/layer/index.ts` — layer metadata and dispatcher composition
- `plugin/epistemology-framework/kernel/index.ts` — shared kernel helpers, budgets, dedupe, target extraction, prompt context

## Worldview

- `plugin/epistemology-framework/worldview/discovery.ts` — `AGENTS.md` / `CLAUDE.md` discovery rules and root-bounded traversal
- `plugin/epistemology-framework/worldview/runtime.ts` — worldview trigger tools, reminder injection, budgets

## Policy

- `plugin/epistemology-framework/policy/config.ts` — guardrail schema, includes, content matchers, actions, changed-line scope
- `plugin/epistemology-framework/policy/runtime.ts` — runtime enforcement, human override, required-skill handling

## Provenance

- `plugin/epistemology-framework/provenance/runtime.ts` — system reminders, tool-description augmentation, trace capture, compaction context
- `plugin/epistemology-framework/provenance/registry.ts` — authoritative `prov_*` tool list
- `plugin/epistemology-framework/provenance/local-evidence.ts` — local evidence loading and ranking

## Mutation Risk

- `plugin/epistemology-framework/mutation-risk/rules.ts` — destructive command evaluation rules and env config
- `plugin/epistemology-framework/mutation-risk/runtime.ts` — bash hook integration

## Workspace Conventions In This Repo

- `AGENTS.md` — package manager, plugin discovery, simplicity, work tracking, communication, commit conventions
- `plugin/AGENTS.md` — plugin-specific structure, logging, validation, and barrel guidance

## Companion Skills

- `skills/agents-md-author/SKILL.md`
- `skills/sdlc/SKILL.md`
- `skills/research/SKILL.md`
