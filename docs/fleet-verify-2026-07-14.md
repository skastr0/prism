# Fleet Verify — 2026-07-14 (PRD-002 read-only verification pass)

Machine-readable receipts for a **read-only** live-fleet check against the real
`~` on this machine. No config was written, refreshed, or fixed by this pass —
every claim below is either an executed command's output or a file this
process opened and read. `prism refresh --all` (the migration itself) is
explicitly out of scope for this lane; it is glyphed separately.

```json
{
  "schema": "prism.fleet-verify.v1",
  "date": "2026-07-14",
  "glyph": "PRD-002",
  "repo_head": "f2f487093414e0526faa221ffb963dfa4139315f",
  "production_binary": {
    "path": "/Users/guilhermecastro/.local/share/mise/shims/prism -> npm-skastr0-prism/0.3.5",
    "version": "0.3.5"
  },
  "dev_build_binary": {
    "path": "dist/prism-darwin-arm64 (built from repo_head, not installed globally)",
    "version": "0.3.5 (version string unchanged since last bump; binary content is repo_head)"
  }
}
```

## 1. `prism doctor --all` — production vs. dev build

Both runs against the *same real home* (`~`), read-only (`--json`, no `--fix`).

| run | binary | exit code | total findings | error | warning | info |
|---|---|---|---|---|---|---|
| production | 0.3.5 (`which prism`) | 1 | 19 | 14 | 5 | 0 |
| dev build (repo HEAD) | `dist/prism-darwin-arm64` | 1 | 40 | 14 | 12 | 14 |

**Every finding in both runs carries `fix: "refresh"` or `fix: "gc"` — zero
findings are severity-only-manual.** `prism doctor --all --fix` (not run here,
out of scope) is expected to self-heal all of them.

### Production (0.3.5) — 19 findings, all self-healing

| code | severity | fix | count | harness |
|---|---|---|---|---|
| `config.mcp-shim-args-invalid` | error | refresh | 9 | hermes |
| `region.marker-count` | error | refresh | 5 | hermes |
| `snapshot.owned-drift` | warning | refresh | 5 | hermes(1) / opencode(3) / grok(1) |

The hermes errors are a **genuine drift, not a doctor false-positive** — I
diff'd the live `~/.hermes/config.yaml` against what
`src/compile/lowerers/hermes.ts::renderHermesOwnerMcpServerYaml` currently
emits: the live file's `args:` list items sit at the *same* column as the
`args:` key (`    - mcp` / `    - shim`, 4-space indent), while the current
lowerer indents list items two spaces deeper under the key (6-space indent)
and wraps the block in a marker fence the live file lacks entirely
(`region.marker-count` reports `begin=0, end=0` for all 5 hermes MCP regions).
Doctor's `hasStdioShimArgs`/fence reader is byte-literal (`src/doctor.ts:930`,
`src/doctor/mcp-topology-checks.ts:441`) and correctly flags this as
unrefreshed legacy content — the exact "real configs still on the retired
transport, never migrated" state the glyph's Context describes. Functionally,
a real YAML parser (i.e. hermes itself) would still resolve `command: prism`,
`args: [mcp, shim]` correctly since same-indent list items are valid YAML —
but the missing fence means Prism cannot currently *prove* it owns this
region, which is exactly what `prism refresh` (out of scope here) exists to
re-establish.

### Dev build (repo HEAD f2f4870) — 40 findings, all self-healing

Same 19 as production, **plus** two detector families that shipped this arc
and were invisible in 0.3.5:

| code | severity | fix | count | detector | landed |
|---|---|---|---|---|---|
| `namespace.unowned-mcp-entry` | warning | gc | 7 | `src/doctor/orphaned-mcp-entries.ts` | `f5b548a` (PQ-172) |
| `workflow.store-registry.stale-entry` | info | gc | 14 | workflow store registry GC | `241b27f` (WFE-008) |

`namespace.unowned-mcp-entry` fires on `~/.cursor/mcp.json` — 7
Prism-fingerprinted server keys (`booth`, `grok-agent`, `hotmart-cli`,
`meta-ads-cli`, `quasar`, `typefully-cli`, `video-vision`) sitting outside
every owned patch region in that file — a real orphan the glyph's "launchd
residue + orphan detectors landed this arc" note anticipated.
`workflow.store-registry.stale-entry` fires on 14 dead
`/var/folders/.../prism-workflow-loader-*/workflows.sqlite` registry rows
(ephemeral per-run stores from prior workflow executions whose temp dirs are
long gone) — routine GC debt, not a defect.

**launchd-residue detector (`src/doctor/launchd-residue.ts`, `3afc11a`
OBS-002) fired zero findings** — confirmed present (grepped into the dev
binary's source) and confirmed *clean*: no launchd-era residue exists on this
machine right now. The glyph's fear ("doctor can't see this") is resolved:
doctor now has the detector, and what it sees is a clean surface.

`workflowHarnesses` detection also picked up one more entry on the dev build
(10 vs. production's 9) — `omp` (Oh My Pi), found at
`/Users/guilhermecastro/.bun/bin/omp`, not yet enumerated by the shipped
0.3.5 detector.

## 2. Per-harness live stdio-shim MCP proof

Checked against `packages/prism-sdk/src/mcp/wire-naming.ts::ShimHarnessId` /
`SHIM_HARNESS_IDS` (ground truth for which harnesses the stdio-shim path even
applies to) and the real on-disk config each harness reads from
(`src/doctor/mcp-topology-checks.ts::HARNESS_MCP_LOCATION`). One live
`initialize` → `tools/list` → `tools/call` round-trip was driven directly
against `prism mcp shim` (production 0.3.5 binary) with the harness's own
`PRISM_SHIM_*` env, for every harness that has a real prism-owned entry
configured.

| harness | binary present | shim-eligible | prism entries configured | live proof | result |
|---|---|---|---|---|---|
| claude-code | yes | yes | **no** — `~/.claude.json` project entry and every `.mcp.json` under `~/.claude/plugins`/`~/.claude/skills` have empty `mcpServers: {}` (tools ship via generated `tools:` CLI-passthrough frontmatter, per this session's own system-prompt-declared surface) | not run | **untestable-with-reason**: no configured entries |
| codex-cli | yes | yes | **no** — `~/.codex/config.toml` has no `[mcp_servers.*]` table for any prism plugin (only an unrelated `node_repl`) | not run | **untestable-with-reason**: no configured entries |
| grok | yes | yes | **no** — `~/.grok/config.toml` (442 bytes) carries no `mcp_servers` table at all; a `config.toml.bak-dup-sweep-20260709` backup exists, implying prior entries were swept and never re-added | not run | **untestable-with-reason**: no configured entries |
| hermes | yes | yes | **yes**, 9 servers (legacy-indent/unfenced, see §1) | `initialize` → `tools/list` (9 tools) → `tools/call projects_list` | **pass** — shim mechanism itself is healthy for hermes+quasar even though the on-disk config needs `refresh` |
| opencode | yes | **no** | n/a — native in-process plugin (`~/.config/opencode/plugins/prism-generated-*/dist/server.mjs`, a bundled JS module loaded in-process, not a spawned stdio server) | not run | **untestable-with-reason**: no stdio-shim path exists for this harness (`ShimHarnessId` excludes `opencode`) |
| antigravity-cli (agy) | yes | yes | **yes** — `~/.gemini/config/plugins/prism-generated-quasar/mcp_config.json` etc., already correctly shaped (`command: prism`, `args: [mcp, shim]`, matching env) | `initialize` → `tools/list` (9 tools) → `tools/call projects_list` | **pass** |
| kimi-code | yes | yes | **yes** — `~/.kimi-code/plugins/managed/prism-generated-quasar/kimi.plugin.json`, already correctly shaped | `initialize` → `tools/list` (9 tools) → `tools/call projects_list` | **pass** |
| amp-code (amp) | yes | **no** | n/a — native provider | not run | **untestable-with-reason**: no stdio-shim path (`ShimHarnessId` excludes `amp-code`) |
| devin | yes | **no** | n/a — per `wire-naming.ts` comment: "a compile harness with PR1 MCP unsupported (no shim front yet)" | not run | **untestable-with-reason**: shim path not yet built for this harness |
| omp | yes | **no** | n/a — native provider/extension loading | not run | **untestable-with-reason**: no stdio-shim path (`ShimHarnessId` excludes `omp`) |

Plugin used for every live call: `quasar`, tool: `projects_list` (read-only,
zero side effects). Full stdout/stderr JSON-RPC transcripts captured by
`shim_probe.py` during this run; representative result:

```json
{"label": "antigravity-cli+quasar", "ok": true, "tools_count": 9, "tool_call_ok": true, "error": null, "tool_names": ["doctor", "ingest_inspect", "ingest_run", "projects_list", "search", "sessions_list", "sessions_read", "tool_calls_list", "tool_calls_read"], "tool_called": "projects_list"}
```

Score: **3 pass** (hermes, antigravity-cli, kimi-code) / **0 fail** / **7
untestable-with-reason** (claude-code, codex-cli, grok — no configured
entries; opencode, amp-code, devin, omp — no shim path applies). No harness
was recorded as passing without a driven tool call, and none was marked pass
on an assumption.

## 3. 10-concurrent shim soak

10 parallel `prism mcp shim` client sessions (production 0.3.5 binary,
`PRISM_SHIM_PLUGINS=quasar PRISM_SHIM_HARNESS=antigravity-cli`), each its own
process/thread, each doing its own `initialize` → `tools/list`, each checked
that its response `id` matches what *it* sent (cross-talk detector).

```json
{
  "n": 10,
  "ok_count": 10,
  "fail_count": 0,
  "crosstalk_count": 0,
  "total_elapsed_s": 3.95
}
```

All 10 sessions returned the correct 9-tool list for their own request id; no
process crashed; every session terminated cleanly (`SIGTERM`, expected —
client-initiated close). Cross-checked against live process state: exactly
**one** `quasar` daemon process was running throughout
(`bun /Users/guilhermecastro/.prism/runtime/mcp/quasar/server.mjs`) while all
10 shim clients (plus ~289 other real, pre-existing shim-client connections
from concurrent fleet activity — several `omp` sessions active against this
project at the time) were live — confirming the fan-in daemon-sharing
architecture the glyph's acceptance criterion asks for: **10 concurrent
harness sessions shared one daemon with zero conflict.**

## Summary

| glyph acceptance criterion | verdict |
|---|---|
| `prism refresh --all` leaves zero http:// entries | **not attempted** — out of scope for this read-only lane (config-mutation lane is separate) |
| live tool-call proof per stdio-shim harness | **done for every eligible+configured harness** (hermes, antigravity-cli, kimi-code — 3/3 pass); 3 shim-eligible harnesses have zero configured entries (claude-code, codex-cli, grok) and 4 harnesses have no shim path at all (opencode, amp-code, devin, omp) — both classes correctly recorded `untestable-with-reason`, never `pass` |
| `prism doctor --all` exits 0, no ERROR, no drift | **fails today** — exit 1, 14 errors (all hermes, all `fix: refresh`) + 5-12 warnings + 0-14 info depending on binary; every finding is self-healing, none requires manual intervention |
| 10 concurrent sessions share daemons without conflict | **confirmed** — 10/10 pass, 0 crosstalk, 1 shared daemon process observed live |
