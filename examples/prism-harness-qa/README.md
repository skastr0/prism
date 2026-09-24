# prism-harness-qa

The reference plugin Prism's own tests use to check compile output and workflow runs across harnesses. It has one of each artifact kind:

| directory | contents |
|---|---|
| `agents/`, `identities/` | `qa-tester` agent |
| `tools/` | `challenge_echo`, a tool that returns a proof string for its input |
| `hooks/` | a `session.start` hook |
| `sops/` | `qa-sop`, lowered to a skill |
| `skills/`, `commands/`, `rules/global/` | a skill, a command, a rule |
| `modelspaces/` | model profiles per harness |
| `harness/<id>/` | per-harness overrides for `codex-cli`, `cursor`, `hermes`, `opencode` |
| `workflows/` | smoke workflows for several harnesses, plus model-selection and jev examples |

Try it in a scratch home:

```bash
export HOME=$(mktemp -d)
export PRISM_HOME=$HOME/.prism
prism refresh examples/prism-harness-qa --harness claude-code,codex-cli
prism tools invoke prism-harness-qa challenge_echo --input '{"challenge":"hello"}'
```

The smoke workflows dispatch live harness CLIs and spend tokens; run them with `--mock-output` first.
