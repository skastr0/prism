# OpenCode Local Plugin Evacuation Plan

This plan treats `~/.config/opencode/plugin/` as transition residue, not a permanent source root.

Preferred homes:

- canonical reusable business/domain logic: `/Users/guilhermecastro/Projects/ai-plugins`
- substantial OpenCode-native runtime plugins: standalone projects under `/Users/guilhermecastro/Projects`
- generated compile outputs: `~/.config/opencode/plugins/agentpkg-generated-*`

## Current Load State

`~/.config/opencode/opencode.json` no longer loads broad local plugin sources. It loads:

- `agentpkg-generated-sdlc-core`
- `agentpkg-generated-rlc`
- `agentpkg-generated-mlc`
- `agentpkg-generated-wlc`
- `file:///Users/guilhermecastro/Projects/session-inbox`

`~/.config/opencode/tui.json` still references local TUI plugin files. Treat those as the remaining runtime-local cleanup lane.

## Cutover Sequence

1. Finish the lifecycle split before deleting any remaining `iap-sdlc*` residue.
   - `session-inbox` owns session transport and `/sendoff`.
   - `lifecycle-core` owns lifecycle/IAP packet tools.
   - `lifecycle-core` owns lifecycle work-item tools for `.agents/{sdlc,rlc,mlc,wlc}`.
   - Generated OpenCode plugin roots expose those canonical tools.

2. Evacuate active OpenCode-native runtime plugins into standalone projects.
   - Start with plugins that need hooks, TUI, sessions, subprocess supervision, browser control, DAP, auth, or provider integration.
   - Register standalone projects with `file:///Users/guilhermecastro/Projects/<project>`.

3. Extract portable cores only where there is real reuse pressure.
   - Pure domain algorithms, schemas, and durable protocol behavior belong in `ai-plugins`.
   - Harness adapters stay in standalone OpenCode projects.

4. Redesign root-only agents after plugin destinations are explicit.
   - Agents should bind canonical tools or standalone plugin tools instead of preserving old local-plugin assumptions.

5. Delete old local sources after replacement proof.
   - Replacement project exists.
   - OpenCode config points at the replacement.
   - Generated/canonical tools cover the expected behavior.
   - Tests or smoke checks have been run.
   - No TUI or OpenCode config still references the old local file.

## Plugin Classification

| Local plugin | Destination | Rationale | Retirement trigger |
|---|---|---|---|
| `anki-connect` | standalone project `/Users/guilhermecastro/Projects/anki-connect-plugin` | External local service integration and runtime transport are OpenCode-native tool concerns. | Standalone project registered, Anki smoke check passes, local barrel removed. |
| `background-tasks` | standalone project `/Users/guilhermecastro/Projects/background-tasks` | Subprocess supervision, log buffers, health checks, and session notifications are runtime plugin behavior. | Project registered, CLI/tool tests pass, no local config reference remains. |
| `background-tasks-tui` | standalone project paired with `background-tasks` | TUI runtime belongs with the background task runtime project, not root config. | TUI config references standalone project or the TUI feature is retired. |
| `cmap-tools` | split core plus adapter | Concept-map transforms can become portable canonical logic; OpenCode exposure is adapter/runtime. | Core exists in `ai-plugins`, adapter project registered, tests cover import/export behavior. |
| `dev-browser` | standalone project `/Users/guilhermecastro/Projects/dev-browser-plugin` | Browser relay/server lifecycle and injected scripts are harness/runtime integration. | Standalone relay works from OpenCode, smoke test passes, local source removed. |
| `epistemology-framework` | canonical core in `ai-plugins` plus optional adapter | Kernel, policy, provenance, and worldview logic are reusable domain semantics; OpenCode tools are just one surface. | Core plugin published in `ai-plugins`, adapter points to it, old local source deleted. |
| `exa-tools` | standalone provider plugin | Provider API/auth integration is operational runtime tooling. | Standalone project registered and API smoke tests pass. |
| `firecrawl-tools` | standalone provider plugin | Provider API/auth integration and batch job polling are runtime plugin concerns. | Standalone project registered and scrape/batch tests pass. |
| `gmail-tools` | standalone provider plugin | OAuth/keychain/provider integration should not live in canonical compile tools. | Standalone project registered, auth docs moved with it, local source removed. |
| `librarian-tools` | split core plus adapter | Durable library/knowledge semantics can be shared; OpenCode tool exposure is adapter-specific. | Core destination chosen, adapter registered, index/query tests pass. |
| `parallel-tools` | standalone provider/runtime plugin | Remote task orchestration, monitoring, and provider calls are runtime integration. | Standalone project registered and task lifecycle tests pass. |
| `review` | split core plus adapter | Review story extraction and work-item conversion are portable; PR comments and git/GitHub runtime are adapter concerns. | Core review package or plugin exists, adapter registered, branch/PR tests pass. |
| `rust-debugger` | standalone project `/Users/guilhermecastro/Projects/rust-debugger-plugin` | DAP sessions and debugger process state are runtime plugin behavior. | Standalone project registered and DAP smoke test passes. |
| `session-historian` | split core plus adapter | History/query semantics may be reusable; OpenCode session access is harness-native. | Core schema/storage owner chosen, adapter registered, history smoke test passes. |
| `tiktok-creative-intelligence` | standalone provider plugin with optional canonical skill/docs | Network/provider policy and media intelligence tooling need runtime auth/fetch behavior. | Standalone project registered, policy/normalization tests pass, skill docs copied if useful. |
| `type-level-tools` | split core plus adapter | TypeScript compiler/index/search logic is portable; OpenCode tool registration is adapter-specific. | Core package or `ai-plugins` canonical core exists, adapter registered, type-query tests pass. |
| `typefully-tools` | standalone provider plugin | Auth/keychain/provider integration belongs in a standalone runtime project. | Standalone project registered and draft/query smoke checks pass. |
| `yt-dlp-tools` | standalone runtime plugin | CLI/process integration and media extraction are runtime tooling. | Standalone project registered and `yt-dlp` smoke check passes. |
| `shared` | dissolve into destination projects | Shared helpers should move with their consumers or become a real package only if multiple standalone projects need them. | No local plugin imports `shared/*`; copied or packaged helpers are owned elsewhere. |

## `iap-sdlc*` Rule

Do not reintroduce or preserve `iap-sdlc` as a single plugin. The correct end state is the three-way split:

- `session-inbox` for OpenCode session transport and `/sendoff`
- `lifecycle-core` message packet tools for `.agents/messages/`
- `lifecycle-core` work-item tools for `.agents/{sdlc,rlc,mlc,wlc}/`

Deletion of old `iap-sdlc*` residue is allowed only after all three replacements are live and config references are removed.
