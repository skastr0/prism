# Skill Creator Plugin

This plugin vendors Anthropic's official `skill-creator` skill and its supporting eval tooling so any installed agent can learn the current skill-authoring workflow.

## What it includes

- `skills/skill-creator/SKILL.md` - the main skill authoring, eval, and iteration workflow
- `skills/skill-creator/scripts/` - benchmark, grading, packaging, and description optimization helpers
- `skills/skill-creator/agents/` - grader, comparator, and analyzer prompts used during eval loops
- `skills/skill-creator/eval-viewer/` - HTML review viewer generation
- `skills/skill-creator/references/` - JSON schemas and related reference material

## Installation

```bash
prism install ./plugins/skill-creator --all
```

## Runtime expectations

The authoring guidance is useful from any agent. The advanced eval workflow follows Anthropic's current setup and uses the local `claude` CLI as the evaluation oracle.

For the full eval, benchmark, and description optimization loop, expect to have:

- authenticated `claude` CLI access
- Python 3 available locally
- browser or static HTML access for review artifacts

## Notes

- `prism init --with-skill` and `prism validate` remain useful for creating and checking plugin structure.
- The bundled `skill-creator` goes further than structure alone: it now includes test prompts, benchmark aggregation, blind comparisons, and description optimization workflows.

## Credits

Based on Anthropic's official skill from `anthropics/skills`.
