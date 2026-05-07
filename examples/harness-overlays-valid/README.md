# harness-overlays-valid

An example plugin that demonstrates shared artifact targets plus harness-specific overlays.

## What this example shows

- `plugin.json` still owns all install targeting.
- Shared artifacts live at the top level (`commands/`, `skills/`).
- Harness-specific replacements live under `harness/<id>/...`.
- When a shared file and a harness overlay share the same relative path, the harness overlay wins for that harness.
- Non-overridden files still come from the shared directories.

## Structure

```text
harness-overlays-valid/
├── plugin.json
├── commands/
│   └── test.md
├── skills/
│   └── example-skill/
│       ├── SKILL.md
│       └── checklist.md
└── harness/
    ├── opencode/
    │   └── commands/
    │       └── test.md
    └── openclaw/
        └── skills/
            └── example-skill/
                └── SKILL.md
```

## Overlay behavior

- `commands/test.md` is the shared default command for targeted command-capable harnesses.
- `harness/opencode/commands/test.md` replaces that command only for OpenCode.
- `skills/example-skill/SKILL.md` is the shared default skill entry point.
- `harness/openclaw/skills/example-skill/SKILL.md` replaces only the `SKILL.md` file for OpenClaw.
- `skills/example-skill/checklist.md` stays shared, including for OpenClaw, because there is no matching overlay file.

## Validation

```bash
prism validate ./examples/harness-overlays-valid
prism install ./examples/harness-overlays-valid --harness opencode --dry-run
prism install ./examples/harness-overlays-valid --harness openclaw --dry-run
```

There are no file-level `targets:` blocks in this fixture. The shared/overlay layout plus `plugin.json` targets define the plan.
