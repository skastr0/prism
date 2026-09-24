# Prism

Prism runs your coding agents from typed, checked Effect workflows.

A task is a harness CLI (Claude Code, Codex, Grok, Kimi, Amp, OpenCode, and more), a prompt, and an Effect `Schema` its answer must decode into, plus checks the answer must pass. A workflow is an Effect program over tasks. Every run is recorded in a local ledger, and a rerun replays finished tasks instead of paying for them again.

```bash
npm install -g @skastr0/prism
```

macOS and Linux, arm64 and x64.

```text
$ prism workflow typecheck review.workflow.ts
Workflow typecheck passed: review.workflow.ts

$ prism workflow run review.workflow.ts --mock-output mock.json      # rehearse, no tokens spent
$ prism workflow run review.workflow.ts                              # live, from a Git repo

$ prism workflow runs trace ee259bf3-204f-4b02-8614-9fa56868bc5b
✓ workflow.run · review-commit · 32.9s
└─ ✓ workflow.program · 32.9s
   ├─ ✓ workflow.task · codex · 32.9s
   │  └─ ✓ task.executor · attempt 0 · codex-cli · 32.8s
   └─ ✓ workflow.task · claude · 24.3s
      └─ ✓ task.executor · attempt 0 · claude-code sonnet · 24.3s
```

The full `review.workflow.ts`, the quick start, and the harness list: <https://github.com/skastr0/prism#quick-start>. The same CLI also installs one set of agents, skills, tools, and hooks into every harness (`prism refresh`).

This package is the `prism` command: a small Node launcher that runs the matching prebuilt binary for your platform.
