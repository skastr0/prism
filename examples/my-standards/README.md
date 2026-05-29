# my-standards

An example plugin that demonstrates shared artifact targeting from `plugin.json` without any harness-specific overlays.

## What this example shows

- `plugin.json` is the only source of install targeting.
- Shared rules use the `coding-harness` preset.
- Shared skills use both `coding-harness` and `claw-harness`, so OpenClaw receives the shared skill tree too.
- Commands and agents use explicit harness lists because not every harness supports those artifact types.
- There is no `harness/` directory here because every targeted harness uses the same shared files.

## plugin.json

```json
{
  "name": "my-standards",
  "version": "0.1.0",
  "description": "Example plugin showing shared harness targets without overlays",
  "targets": {
    "rules": ["coding-harness"],
    "commands": ["claude-code", "opencode", "codex-cli", "cursor", "factory-droid"],
    "agents": ["claude-code", "opencode", "factory-droid"],
    "skills": ["coding-harness", "claw-harness"]
  }
}
```

## Installation

```bash
# Validate the example
prism validate ./examples/my-standards

# Preview the shared install plan
prism install ./examples/my-standards --all --dry-run
```

## Notes

- Frontmatter in the markdown artifacts only carries descriptions and harness-specific settings.
- There are no file-level `targets:` blocks in this example.
- OpenClaw v1 receives the shared skill files only in this example because there is no matching `harness/openclaw/skills/...` overlay.
- See `examples/harness-overlays-valid` for the matching harness-overlay example.
