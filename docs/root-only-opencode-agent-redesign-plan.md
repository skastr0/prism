# Root-Only OpenCode Agent Redesign Plan

This plan covers the legacy root-only agents that still live only in `~/.config/opencode/agents/` and carry assumptions from the old local plugin directory.

Do not migrate these agents by copying their markdown into `ai-plugins`. Redesign each one around the current architecture:

- durable identity and method live in canonical plugin sources or skills
- portable business/domain logic becomes canonical tools only when it can stay harness-free
- provider/auth/session/TUI/runtime integrations become standalone OpenCode plugin projects
- compiled agents bind the resulting tools through traits, lifecycle tool grants, or explicit tool access

## Sequencing

1. Finish plugin destination work first.
   - Use `docs/opencode-local-plugin-evacuation-plan.md` as the dependency map.
   - Do not redesign an agent around a tool family whose destination is still unknown.

2. Move pure worker/personality agents first.
   - `spark-worker` has no specialized local plugin dependency and can move into `sdlc-core` or `agent-foundations` as a canonical compiled leaf agent.

3. Move provider/runtime agents after their standalone plugin projects exist.
   - Gmail, Typefully, Anki, yt-dlp/video, session history, and browser/provider agents should not be canonicalized before their runtime plugins have stable names.

4. Move split-core agents after the core/adapter boundary is real.
   - Type-level research, librarian, review, epistemology, and source capture agents need clean core-plus-adapter shapes before agent migration.

5. Delete root-only markdown after compiled replacement proof.
   - Source plugin exists.
   - Required tools are available from canonical/generated or standalone plugin surfaces.
   - OpenCode compiled agent output matches the intended identity.
   - The root-only file is not referenced by commands, docs, or user workflow.

## Agent Redesign Table

| Root-only agent | Durable identity | Historical baggage | Redesign direction | First build item |
|---|---|---|---|---|
| `anki-assistant` | Spaced-repetition/card-quality steward for Anki workflows. | Direct dependence on local `anki-connect` tools and assumed AnkiConnect transport. | Create standalone `anki-connect` OpenCode plugin project; keep card-quality guidance as an installable skill; compile an Anki agent that binds the standalone tool names. | Evacuate `anki-connect`, then create `anki-assistant` source plugin or learning plugin in `ai-plugins`. |
| `gleaner` | Source capture and provenance-preserving filing agent. | Braids Firecrawl, yt-dlp fallback, filesystem filing policy, and local artifact conventions. | Split capture policy into a skill/canonical method surface; use standalone provider plugins for Firecrawl and yt-dlp; consider an RLC/WLC-adjacent compiled agent once capture tools are stable. | Define `source-capture` policy skill and tool dependencies after Firecrawl/yt-dlp destinations land. |
| `gmail-assistant` | Email triage and Gmail operations assistant. | OAuth/keychain/Gmail API local plugin assumptions. | Standalone `gmail-tools` OpenCode plugin project; optional personal-ops agent plugin that binds Gmail tools. | Evacuate `gmail-tools`, then author compiled Gmail agent with explicit destructive-action policy. |
| `librarian` | Remote repository research specialist. | Assumes local GitHub/librarian tools and mixes repo discovery method with tool transport. | Split reusable repo-research method into RLC or a dedicated research-tools plugin; keep GitHub API transport in standalone adapter or provider plugin. | Classify `librarian-tools` core vs adapter, then add compiled `librarian` agent under research-oriented plugin. |
| `session-historian` | OpenCode session-history investigator. | Direct access to OpenCode session database and session schemas. | Standalone `session-historian` OpenCode plugin project because it depends on harness runtime storage; compiled agent can bind those tools after project registration. | Evacuate `session-historian`; document session DB trust and read-only boundaries. |
| `spark-worker` | Ultra-small execution shard for fan-out and tight loops. | Mostly root-only placement; little tool baggage. | Move into `sdlc-core` or `agent-foundations` as a canonical compiled leaf agent with `leaf-agent-protocol` and no bespoke local plugin dependency. | Add `spark-worker.agent.ts`, compile, and delete root-only markdown after generated output matches. |
| `type-level-researcher` | TypeScript type-system research specialist. | Assumes local `type-level-tools` compiler service tool names. | Split `type-level-tools` into portable type-analysis core plus OpenCode adapter; compile this agent in SDLC or a dedicated type-analysis plugin. | Evacuate `type-level-tools`, then bind compiled agent to the adapter tools. |
| `typefully-assistant` | Typefully draft/media/social scheduling operator. | Auth/keychain/provider tool assumptions and weak content-method connection. | Standalone `typefully-tools` plugin; compile the agent under WLC/MLC once Typefully tools are stable and pair it with platform/content skills. | Evacuate `typefully-tools`, then add WLC/MLC compiled agent with Typefully tool access. |
| `video-researcher` | Video transcript/metadata researcher. | Assumes local `yt-dlp-tools`, transcript file workflow, and provider-specific routing. | Standalone `yt-dlp-tools` runtime plugin; compile a video research agent under RLC or source-capture plugin with transcript handling policy. | Evacuate `yt-dlp-tools`, then add compiled video research agent with bounded transcript-output rules. |

## Bucket C Cleanup Order

1. `spark-worker`
   - Lowest dependency risk; proves the root-only to compile-source migration path.

2. Provider-backed assistants
   - `gmail-assistant`
   - `typefully-assistant`
   - `anki-assistant`
   - `video-researcher`

3. Research/capture agents
   - `gleaner`
   - `librarian`
   - `type-level-researcher`

4. Harness-history agent
   - `session-historian`

This order avoids redesigning agents before their tool homes exist, while still removing the simplest root-only agent early.

## Non-Goals

- Do not migrate unrelated personality-only agents in this batch.
- Do not preserve old root-only markdown as a compatibility layer after compiled replacements are proven.
- Do not expose provider/auth/session behavior through canonical tools just to avoid creating standalone plugin projects.
