# Skillspaces

Skillspaces are compile-time disambiguation tables for skills the plugin does not necessarily own. Use them when an agent or trait needs to refer to a harness-native or globally installed skill by a logical name.

Use `skillRef(...)` for managed plugin skills in `skills/<name>/SKILL.md`. Use `skillspaceRef(...)` for unmanaged or harness-native skills that must resolve through `skillspaces/*.skillspace.ts`. Plain skill strings are intentionally rejected by the compile language.

## Global Inventory Snapshot

Snapshot date: 2026-04-28.

Local global skill roots inspected:

- OpenCode: `/Users/guilhermecastro/.config/opencode/skills` — 79 skills
- Claude Code: `/Users/guilhermecastro/.claude/skills` — 131 skills
- Codex: `/Users/guilhermecastro/.codex/skills` — 77 skills
- Grok Build: not included in this snapshot

The shared example skillspace lives at `examples/trait-orbit-contracts/deps/agent-core/skillspaces/global-skills.skillspace.ts`.

Most skill names are identical across the inspected harnesses. The first skillspace records those common names with identical `opencode`, `claude-code`, and `codex-cli` target names, plus a small number of harness-specific entries:

- OpenCode-only: `example-skill`, `policy-toml-guardrails`, `tiktok-creative-intelligence`
- Claude-only examples: `agent-browser` and several specialized design/domain-analysis skills not present in the current OpenCode and Codex roots
- Codex-only examples: `prism-usage`, `codex-primary-runtime`

The compiler currently lowers agents for OpenCode, Claude Code, Codex CLI, Gemini CLI, Amp Code, and Grok Build, with target-specific capability gates. Grok skillspace bindings are allowed when the skill names are known for the Grok environment; do not infer them from the older OpenCode/Claude/Codex snapshot without checking the Grok skill root.

## Authoring Pattern

```ts
import { defineTrait, skillspaceRef } from "prism";

export default defineTrait({
  name: "core-engineering",
  description: "Can use core engineering method skills",
  access: {
    skills: [
      skillspaceRef("agent-core", "global-skills", "build"),
      skillspaceRef("agent-core", "global-skills", "testing"),
    ],
  },
});
```

The target lowerer decides what this means. OpenCode emits `permission.skill` with `*` denied and the resolved skill names allowed. Claude Code and Grok emit resolved skill names into generated agent frontmatter; runtime enforcement semantics remain target-specific.
