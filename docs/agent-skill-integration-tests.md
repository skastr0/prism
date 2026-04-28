# Agent Skill Integration Tests

Agent skill visibility has a fast local audit lane in `src/compile/pipeline.test.ts`.

The harness compiles OpenCode agents through `compilePluginForTarget`, reads the generated agent markdown from dry-run operations, parses frontmatter with `gray-matter`, and evaluates the generated `permission.skill` map. This matches the OpenCode rule that skill availability is denied only when permission evaluation returns `deny`; with a generated `* = deny` default, only explicit skill allows remain visible.

The current fast lane covers:

- star-deny skill defaults
- direct skill dependencies becoming both prompt-visible recommended skills and explicit skill allows
- trait-granted skill permissions becoming explicit allows without appearing in `## Recommended Skills`
- missing skill refs failing closed during compile
- assigned example agents avoiding unrelated broad skill visibility

Run it locally with:

```bash
bun test src/compile/pipeline.test.ts
```

This is intentionally a compile-level integration test, not a live OpenCode debug-agent test. It is deterministic and suitable for CI because it does not need a running harness session.

A future live-debug lane can reuse the same assertions after launching an OpenCode debug agent:

- compile the plugin into a temporary project
- start the harness debug session for one generated agent
- ask the harness for available skill names or attempt skill lookup
- compare the runtime result to the parsed `permission.skill` audit

Claude Code and Codex can attach to the same pattern once they expose equivalent debug surfaces. Until then, Claude/Codex coverage stays at compile behavior: direct skill dependencies lower into prompt-visible recommended skills, while permission-only skill access fails closed on targets that cannot enforce skill permissions.
