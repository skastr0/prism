# Starter Snippets

## Minimal Root `AGENTS.md`

```md
# Workspace Rules

- Package manager: bun
- Validation: `bun run validate`
- Tests: `bun run test -- <target>`
- Keep work items in `.agents/sdlc/`
- Keep durable messages in `.agents/messages/`
- Keep local plugins discoverable through `plugin/<name>.ts` barrels
- Use nested `AGENTS.md` or `CLAUDE.md` only for real subtree rule changes
```

Replace the commands and boundaries with the real workspace rules.

## Minimal `opencode.json` Shape

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "maestro",
  "permission": {
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "edit": "allow",
    "bash": "ask",
    "skill": "allow",
    "task": "allow"
  }
}
```

Add providers, models, MCP servers, and any framework-specific permission detail the workspace actually needs.

## Minimal `.opencode/policy.toml`

```toml
version = 1

[[rules]]
id = "protect-secrets"
match = ["**/.env", "**/secrets/**"]
tools_include = ["read", "edit", "write", "apply_patch", "morph-mcp_edit_file"]

actions = [
  { type = "block_tool", message = "Do not read or edit secret material without an explicit user request." }
]
```

Start with the smallest real risk in the workspace.

## Example Skill-Gated Policy Action

```toml
version = 1

[[rules]]
id = "guard-policy-edits"
match = [".opencode/policy.toml"]
actions = [
  { type = "ensure_skill_loaded", skills = ["epistemology-framework-readiness"], mode = "block" },
  { type = "require_human_override", message = "Policy edits need explicit human review." }
]
```

Confirm the required skill with `/policy skill-loaded epistemology-framework-readiness` only after loading it.

## Minimal SDLC Folders

```sh
mkdir -p .agents/messages
mkdir -p .agents/sdlc/{backlog,exploring,committed,building,reviewing,done,abandoned}
```

## Mutation-Risk Environment Knobs

```sh
export OPENCODE_DESTRUCTIVE_GUARD_MODE=block
export OPENCODE_DESTRUCTIVE_GUARD_EXTENDED=true
export OPENCODE_DESTRUCTIVE_GUARD_ALLOW_TMP_RM_RF=true
```

Leave these close to defaults unless the workspace has a deliberate operational reason.

## Minimal Knowledge Map Bootstrapping

```text
1. initialize `.cmap`
2. build the atlas
3. keep docs and notes in stable top-level folders
```

Use this only when the workspace benefits from long-lived retrieval and navigation.
