# Epistemology Framework Readiness Checklist

## 1. Root And Taxonomy

- One stable workspace root is chosen.
- The workspace is classified as `code`, `docs`, `mixed`, or `framework source repo`.
- The top-level folders reflect real boundaries, not accidents.

## 2. Worldview Layer

- Root `AGENTS.md` exists.
- Nested `AGENTS.md` or `CLAUDE.md` files exist only where subtree rules differ.
- Nested worldview files are non-empty and non-duplicative.
- The resulting inheritance path makes sense for normal edit/read targets.

## 3. Policy Layer

- `.opencode/policy.toml` exists when the workspace has risky paths or guarded workflows.
- The initial rule set covers real risks, not speculative ones.
- If policy uses includes, the include graph is intentional and small enough to understand.
- If rules can require work items, `.agents/sdlc/` exists.
- If rules can emit artifacts, `.agents/messages/` exists.

## 4. Provenance Layer

- `opencode.json` permissions allow the normal read/search/edit path.
- `prov_*` tools are available where provenance matters.
- The workspace structure is legible enough that provenance output will be meaningful.
- Compaction is enabled if compaction context matters.

## 5. Mutation-Risk Layer

- Destructive-command guard mode is intentionally chosen.
- Any deviation from default blocking behavior is documented.
- Bash permissions do not silently undercut the guardrail story.

## 6. Shared Workspace Substrate

- `.agents/messages/` exists when durable messages or policy artifacts matter.
- `.agents/sdlc/{backlog,exploring,committed,building,reviewing,done,abandoned}` exists when work tracking matters.
- `plugin/<name>.ts` barrels exist for local plugins.
- `skills/<skill-name>/` holds local skills.

## 7. Docs / Knowledge Extras

- `.cmap/` exists only if the workspace benefits from long-lived retrieval.
- Docs, notes, research, assets, and archive folders are distinguishable.
- Policies protect source material and generated outputs where needed.

## 8. Framework Source Repo Extras

- `plugin/epistemology-framework.ts` exists.
- `plugin/epistemology-framework/` is the single home for framework runtime code.
- Framework tests remain under `plugin/epistemology-framework/tests/`.
- `bun run validate` is the obvious validation gate.

## 9. Verification

For code repos:

- run `bun run validate`
- run one targeted test when the change is framework-specific
- confirm the plugin barrel and directory structure still line up

For docs-heavy workspaces:

- confirm `.cmap` builds cleanly if present
- confirm worldview and policy files reflect reality
- confirm protected paths are the ones that actually matter

## 10. Done Criteria

The workspace is ready when:

- worldview, policy, provenance, and mutation-risk each have a clear place to operate
- risky paths or actions are guarded
- the root and subtree rules are easy to discover
- validation commands are obvious
- optional machinery is enabled only where it pays for itself
