# Pinned third-party skills

A plugin can point to a skill in another Git repo without copying its source.

Add `skill-refs/<name>.skill-ref.json`:

```json
{"name":"demo","source":"owner/repo","commit":"0123456789abcdef0123456789abcdef01234567","skillPath":"skills/demo/SKILL.md"}
```

| field | value |
|---|---|
| `name` | the skill name |
| `source` | GitHub shorthand (`owner/repo`) or a Git URL |
| `commit` | a 40-character commit SHA |
| `skillPath` | the path to `SKILL.md` inside that repo |

The plugin's `targets.skills` decides which harnesses get it. `prism.lock` records the commit and a SHA-256 hash of every file in the skill directory.

## Commands

| command | what it does |
|---|---|
| `prism skills import-npx --into <plugin> --dry-run` | preview pointers from `~/.agents/.skill-lock.json`; drop `--dry-run` to write them and their lock hashes |
| `prism skills update [name] --plugin <plugin>` | review upstream commits and pin the new content |
| `prism refresh <plugin>` | fetch a missing pinned commit into `PRISM_HOME/cache/third-party-skills`, check its hash, and install it; works offline once cached |
| `prism doctor --prune-untracked` | list skill directories Prism doesn't track; add `--fix` to remove them |

A plugin can't have the same skill in both `skills/<name>/` and `skill-refs/<name>.skill-ref.json`; refresh fails and names both.
