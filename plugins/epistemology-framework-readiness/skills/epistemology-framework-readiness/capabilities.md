# Epistemology Framework Capabilities

## Core Runtime Layers

### 1. Policy

What it provides:

- Loads project policy from `.opencode/policy.toml`
- Loads optional global policy from `~/.config/opencode/.opencode/policy.toml`
- Supports env overrides through `OPENCODE_POLICY_GUARDRAIL_CONFIG` and `OPENCODE_POLICY_GUARDRAIL_GLOBAL_CONFIG`
- Merges include graphs via `include` or `includes`
- Filters by tool, path, and content
- Supports content matchers using `ast_grep` and `semgrep`
- Supports actions such as:
  - `inject_prompt`
  - `require_work_item`
  - `block_tool`
  - `require_human_override`
  - `stop_session`
  - `ensure_skill_loaded`
- Supports session commands:
  - `/policy override <reason>`
  - `/policy skill-loaded <skill...>`
- Writes policy artifacts under `.agents/messages/`

Workspace implications:

- Keep `.opencode/policy.toml` close to the workspace root.
- Create `.agents/messages/` if you want policy violations and related artifacts to land cleanly.
- Add SDLC folders if rules can require work items.

### 2. Worldview

What it provides:

- Discovers inherited `AGENTS.md` and `CLAUDE.md` files along the path to touched files
- Stops at the workspace root
- Prefers deeper files over parents by path position
- Injects bounded reminders after target-aware tools like `read`, `edit`, `write`, `patch`, and `apply_patch`
- Applies injection budgets:
  - max items: `4`
  - max bytes: `3072`

Workspace implications:

- Root `AGENTS.md` should contain durable workspace-wide rules.
- Nested `AGENTS.md` or `CLAUDE.md` files should only exist at true subtree boundaries.
- Empty or redundant nested files dilute the worldview layer.

### 3. Provenance

What it provides:

- Injects system reminders about worldview, policy, and provenance-aware reasoning
- Augments tool descriptions so agents know when to prefer provenance tools
- Adds compaction context when compaction is enabled
- Captures local traces and evidence for changed files, messages, and work items
- Registers the `prov_*` tools

`prov_*` tools by group:

- **State**
  - `prov_repo_state`
  - `prov_file_state`
- **Lineage**
  - `prov_span_history`
- **Expand / summarize**
  - `prov_diff_expand`
  - `prov_commit_materialize`
  - `prov_commit_expand`
  - `prov_pr_materialize`
  - `prov_pr_expand`
  - `prov_tree_expand`
  - `prov_worktree_overview`
- **Score / authority**
  - `prov_hotspots`
  - `prov_authority`
  - `prov_stability_report`
- **Read surfaces**
  - `prov_read`
  - `prov_block_read`

Workspace implications:

- Allow the base read/search/edit/bash/task path so provenance hints are actionable.
- Keep `.agents/messages/` and `.agents/sdlc/` if you want richer local evidence.
- If you care about compaction continuity, do not disable compaction casually.

### 4. Mutation Risk

What it provides:

- Evaluates bash commands before execution
- Blocks or warns on destructive commands such as:
  - recursive forced `rm`
  - `git reset --hard`
  - `git push --force`
  - destructive docker, kubectl, and disk-formatting flows
- Supports env configuration:
  - `OPENCODE_DESTRUCTIVE_GUARD_MODE` = `block | warn | off`
  - `OPENCODE_DESTRUCTIVE_GUARD_EXTENDED`
  - `OPENCODE_DESTRUCTIVE_GUARD_ALLOW_TMP_RM_RF`

Workspace implications:

- Default to `block` unless the workspace has a deliberate operational reason not to.
- Document any relaxation in `AGENTS.md` or infra docs.

### 5. Kernel And Layering

What it provides:

- Session kernel store
- Dedupe and cache helpers
- Prompt and evidence budgeting
- Tool target extraction
- Explicit layer order: `policy → worldview → provenance → mutation-risk`

Workspace implications:

- The framework works best when the workspace has one stable root and clear subtree boundaries.
- Shallow, explicit folder taxonomy helps the layers cooperate.

## Workspace Capabilities Outside The Plugin

These are not the framework runtime itself, but they are the substrate it depends on:

- `AGENTS.md` and optional nested `CLAUDE.md` / `AGENTS.md`
- `.agents/messages/` for policy and IAP artifacts
- `.agents/sdlc/` for durable work tracking
- `.opencode/policy.toml` for guardrails
- `opencode.json` for permissions, models, agents, and MCP servers
- `plugin/<name>.ts` barrels plus `plugin/<name>/` implementation folders
- `skills/<skill-name>/` for local skills
- optional `.cmap/` for docs-heavy workspaces

## Companion Skills Worth Referencing

- `agents-md-author` for worldview source files
- `sdlc` for work tracking
- `workspace-readiness` has been superseded by this skill; use this one for full framework coverage
