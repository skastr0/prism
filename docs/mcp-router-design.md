# Prism MCP Front-Door Router — Design

Status: design approved in principle; first increment pending. Author: diagnosis + 3-architect design panel (June 2026).

## Problem

Today Prism runs one `Bun.serve` daemon **per generated plugin**, each on an auto-allocated
loopback port (`getFreePort`) pinned into its own launchd job. Harness configs
(`~/.grok`, `~/.claude`, `~/.codex`, `~/.kimi-code`, `~/.cursor`, and per-project mirrors)
**bake** `http://127.0.0.1:<port>/mcp` at `prism refresh`/compile time and are never
re-synced when the port later moves (rebuild/refresh/realloc). Result: chronic config
desync and constant config churn. For a system whose telos is "scale to many MCPs"
(harness programming), per-plugin port management is O(N) and brittle.

## Decision

**Front-door reverse proxy on one fixed port → existing N backends, discovered via
`runtime.json`.** Grafts: (a) path↔header cross-check, (b) single source-of-truth port
file `~/.prism/router.json`. The fuller "1 process / 1 supervisor" UDS variant is the
**v2 destination**, reached without changing any harness config because the URL contract
is identical.

Rationale: config stability is a property of the URL shape, not the topology — so it is
equal across all candidates and does not discriminate. The discriminator is build risk ×
blast radius. The proxy touches the proven session/exposure/transport code **zero**
(backends run byte-identical), keeps N fault domains isolated, and lands on the shared
end-state URL contract.

## Client contract (stable forever)

```
http://127.0.0.1:7337/mcp/<plugin>        # POST initialize | POST w/ session | GET SSE | DELETE
http://127.0.0.1:7337/mcp/<plugin>/healthz
http://127.0.0.1:7337/healthz             # router self-health
```

`<plugin>` = `normalizeBundleSegment(name)` (already the `runtime.json` dir key). Content-stable:
moves only on rename, never on rebuild/restart/realloc. Only the `url` literal changes;
`X-Prism-Mcp-Exposure` header and codex/kimi/hermes native tool-filters stay byte-identical.
Adding the Nth+1 MCP = one path entry, no new port, no new job → O(1) in N.

## Port

Default `7337`, sticky in `~/.prism/router.json` (one value, read by both the config-baker
and the router). On boot: if our own healthy router holds it → idempotent no-op; if a
**foreign** process holds it → **fail loud, stay down**, surface via `prism doctor`. Never
silently reallocate (silent realloc is the disease being cured). Strictly better than N
pinned ports: 1 loud one-time conflict vs N silent continuous desyncs.

## Protocol correctness

Router is a transparent byte-proxy; backends own all MCP semantics unchanged.
- Per-plugin `Mcp-Session-Id` scoping is free: each backend is a distinct process with its
  own `sessions` map behind its own path.
- **SSE GET must stream `Response(upstream.body)` unbuffered — never `await .text()`.** This
  is the single load-bearing detail and the make-or-break test.
- Host rewrite to `127.0.0.1:<backend-port>` so the backend's `isAllowedHostHeader` passes.
- Named risks: double-hop idle (Bun `idleTimeout` 255s cap at two hops → match + client
  reconnect); discovery race (backend realloc mid-flight → 502 → mtime-cache + retry-once).

## Migration (additive, no flag day)

Backends never move, so old per-plugin URLs and the front door coexist during cutover.
- Phase 0: add `src/mcp/router.ts` + `src/compile/mcp-router-bundle.ts`; ensure-router step
  beside `serveMcp` in `pipeline.ts`; one router launch-agent in `launchd.ts`. Both
  topologies serve simultaneously.
- Phase 1: flip `renderMcpHttpUrl` (mcp-runtime.ts:191) to the front-door URL; `prism refresh`
  rewrites each harness config to the stable URL (idempotent; lowerers unchanged).
- Phase 2: delete the compile-time→backend-port coupling. Rollback = revert the one branch + refresh.

## First increment (de-risks everything; touches zero existing code)

Build only the bare router; point ONE plugin (quasar) at `…/mcp/quasar` by hand; validate
the full round-trip: initialize → tool call (exposure honored end-to-end) → **SSE under
load** → DELETE → backend-realloc rediscovery. Decision gate: proceed only if SSE-through-proxy
holds in Bun; if fragile, jump to the UDS variant.
