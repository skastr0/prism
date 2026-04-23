# Configuration Guidance

## 1. Establish The Root First

Pick one durable workspace root.

Do not configure a transient subdirectory if the real workspace is higher up, because worldview inheritance, policy discovery, provenance root-relative paths, and SDLC folders all depend on a stable root.

## 2. Write A Useful Root `AGENTS.md`

Capture what the framework cannot infer reliably:

- package manager
- validation commands
- folder boundaries
- naming conventions
- domain vocabulary
- sensitive paths
- whether `.cmap` is used
- whether local plugins are exposed via `plugin/*.ts`

For this repo, local plugin discovery happens through `plugin/<name>.ts` barrels. Do not add local plugins to the `opencode.json` plugin array.

## 3. Configure `opencode.json`

At minimum, decide:

- default agent
- providers and models
- permission defaults
- whether compaction is enabled
- optional MCP servers that materially help the workspace

Keep the ordinary path usable:

- `read`, `glob`, `grep`
- `edit` / `write` / patching tools
- `skill`
- `task` when delegation is part of the workspace
- `bash` with deliberate guardrails

If permissions are fine-grained, make sure the framework-specific tools are allowed where needed:

- `prov_*`
- `cmap_*` for docs-heavy workspaces
- `iap_*` and `sdlc_*` when using messages and work items

If compaction is disabled, provenance cannot add its compaction context.

## 4. Add `.opencode/policy.toml`

Start with the smallest real set of guardrails:

- secret paths
- generated outputs
- source-of-truth documents
- risky mutation surfaces
- required review or work-item steps
- required skills for special tasks

Use includes when the policy deserves modular files.

Use `/policy override <reason>` only as an explicit human unlock, not as a convenience escape hatch.

Use `/policy skill-loaded <skill...>` only after the required skills are actually loaded.

For deep policy authoring guidance, see [policy-authoring.md](policy-authoring.md).

## 5. Create `.agents/`

Recommended baseline:

- `.agents/messages/`
- `.agents/sdlc/backlog/`
- `.agents/sdlc/exploring/`
- `.agents/sdlc/committed/`
- `.agents/sdlc/building/`
- `.agents/sdlc/reviewing/`
- `.agents/sdlc/done/`
- `.agents/sdlc/abandoned/`

This is especially important if policy rules can require work items or if the workspace benefits from durable IAP traffic.

## 6. Shape Worldview Intentionally

Use:

- one root `AGENTS.md`
- nested `AGENTS.md` or `CLAUDE.md` only where subtree rules genuinely differ

Good nested boundaries:

- `plugin/`
- `research/`
- `contracts/`
- `apps/<name>/`

Bad nested boundaries:

- every folder "just in case"
- empty files
- copies of the root file with no real local differences

## 7. Preserve Provenance Value

Provenance pays off when the workspace is legible:

- clear folder structure
- clear validation commands
- meaningful commit history
- `.agents/messages/` and `.agents/sdlc/` present when relevant
- compaction not disabled without reason

If you want full trust and history support, do not strip the workspace down so far that `prov_*` tools have nothing to work with.

## 8. Decide Mutation-Risk Strictness

Default stance:

- keep `OPENCODE_DESTRUCTIVE_GUARD_MODE=block`

Relax only intentionally:

- `warn` for transitional environments
- `off` only for tightly controlled environments where other controls replace it

Document the choice if it differs from default expectations.

## 9. Add `.cmap` Only When It Pays Off

Use `.cmap` for:

- research vaults
- notes libraries
- architecture docs that need long-lived retrieval
- mixed workspaces with durable non-code material

Skip it for small, purely code-centric repos where atlas-style retrieval will not be maintained.

## 10. Framework Source Repo Extras

If the workspace contains the framework itself:

- keep `plugin/epistemology-framework.ts` as the discovery barrel
- keep implementation in `plugin/epistemology-framework/`
- keep tests under `plugin/epistemology-framework/tests/`
- use `bun run validate` as the code-quality gate

Do not fracture the framework across multiple homes.
