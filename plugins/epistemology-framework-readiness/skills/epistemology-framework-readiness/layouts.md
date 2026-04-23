# Example Layouts

## Consumer Code Repository

```text
repo/
├── AGENTS.md
├── opencode.json
├── .opencode/
│   └── policy.toml
├── .agents/
│   ├── messages/
│   └── sdlc/
│       ├── backlog/
│       ├── exploring/
│       ├── committed/
│       ├── building/
│       ├── reviewing/
│       ├── done/
│       └── abandoned/
├── plugin/
│   └── some-local-plugin.ts
├── skills/
├── src/
├── tests/
└── package.json
```

Use this when the workspace mainly ships code but still wants worldview, policy, provenance, and mutation-risk to matter.

## Framework Source Repository

```text
repo/
├── AGENTS.md
├── opencode.json
├── .opencode/
│   └── policy.toml
├── .agents/
│   ├── messages/
│   └── sdlc/
├── plugin/
│   ├── epistemology-framework.ts
│   └── epistemology-framework/
│       ├── index.ts
│       ├── kernel/
│       ├── layer/
│       ├── mutation-risk/
│       ├── policy/
│       ├── provenance/
│       ├── tests/
│       └── worldview/
├── skills/
│   └── epistemology-framework-readiness/
└── package.json
```

Use this when the workspace is itself the home of the framework and must preserve the single-home plugin layout.

## Docs Or Knowledge Workspace

```text
workspace/
├── AGENTS.md
├── opencode.json
├── .opencode/
│   └── policy.toml
├── .agents/
│   ├── messages/
│   └── sdlc/
├── .cmap/
├── docs/
├── notes/
├── research/
├── assets/
└── archive/
```

Use this when worldview, policy, and retrieval matter more than build tooling.

## Mixed Workspace

```text
workspace/
├── AGENTS.md
├── opencode.json
├── .opencode/
│   └── policy.toml
├── .agents/
├── .cmap/
├── apps/
├── packages/
├── plugin/
├── skills/
├── docs/
├── research/
└── notes/
```

Use this when one root contains both executable code and durable non-code material.

## Nested Worldview Rule Of Thumb

Add nested `AGENTS.md` or `CLAUDE.md` only when a subtree needs different rules, such as:

- `plugin/` for plugin SDK and logging rules
- `research/` for citation and source-handling rules
- `contracts/` for compatibility and change-control rules
- `apps/<name>/` for app-specific commands or release rules

Do not create nested worldview files just to restate the root.
