# MCP Runtime Stability

This note records the Prism MCP runtime failure mode observed with Hermes and
the intended direction for making generated TypeScript tools safe under agent
fan-out.

## Problem

Prism currently emits canonical `tools/*.tool.ts` as a generated Bun MCP stdio
server for Hermes. Hermes then registers that server from
`~/.hermes/config.yaml -> mcp_servers` with `command` and `args`.

That shape is correct for basic MCP compatibility, but it has a bad operational
property: stdio MCP is subprocess oriented. Every MCP client that connects by
stdio launches a server process. With multiple Hermes agents, multiple Prism
generated MCP servers, or a reconnect/crash-loop, process count scales as:

```text
agents * configured stdio MCP servers * retry/reconnect attempts
```

When the configured command is a bare `bun`, local version managers such as
`mise` may sit in the launch path. The visible symptom is then a `mise`/`bun`
storm even though the Prism tool implementation itself is not spawning
processes.

## Evidence

Local Hermes code supports two relevant MCP shapes:

- `command`/`args` for stdio subprocesses.
- `url`/`headers` for HTTP/Streamable HTTP, with `transport: sse` only for the
  legacy SSE path.

Hermes keeps each MCP server task alive on a background event loop, performs
initial connection retries, and reconnects after connection loss. That is
reasonable client behavior, but it amplifies subprocess launch churn when the
server side is stdio.

The MCP specification is explicit about the operational distinction:

- stdio: the client launches the MCP server as a subprocess.
- Streamable HTTP: the server is an independent process that can handle
  multiple client connections.

The TypeScript SDK documentation points the same way: stdio is for local
child-process integrations; Streamable HTTP is the transport with session
management and resumability. Recent SDK/security material also matters for
local HTTP: localhost MCP servers need host/origin validation and should not be
run unauthenticated.

## Immediate Hardening

The current local patches keep the stdio shape but reduce obvious blast radius:

- Hermes config generation now prefers the absolute Bun executable when Prism
  is running under Bun, avoiding a bare `bun` lookup through `PATH` and `mise`
  where possible.
- Generated Hermes MCP entries include `connect_timeout`, `timeout`, and
  `sampling.enabled: false`, rendered from the central Prism MCP timeout
  policy unless the plugin overrides `runtime.mcp.<harness>`.
- Generated MCP server bundles honor `PRISM_MCP_WORKING_DIRECTORY` and
  `PRISM_MCP_REPO_ROOT`, so Hermes' lack of a stdio `cwd` option does not leave
  tool runtime context dependent on the gateway process cwd.
- The Tower client in `../prism-plugins` now bounds Tower Control HTTP calls
  with `AbortController`, so a Tower request cannot hang until an outer Hermes
  reconnect path starts compounding the failure.

The current local implementation also adds an opt-in Streamable HTTP bundle
path through `plugin.json -> runtime.mcp.<harness>` for Hermes, Codex CLI,
Claude Code, and Antigravity CLI. Prism owns the local bearer token, starts the
generated server during non-dry-run compile/install by default, and writes
client config with static authorization headers for the trusted local machine.

## Target Architecture

Prism should support a shared Streamable HTTP runtime for generated tools.

The supported opt-in shape is:

```json
{
  "runtime": {
    "mcp": {
      "hermes": {
        "transport": "streamable-http",
        "host": "127.0.0.1",
        "port": 38463,
        "tokenEnv": "PRISM_MCP_TOKEN",
        "connectTimeoutMs": 10000,
        "toolTimeoutMs": 120000
      }
    }
  }
}
```

For Hermes this lowers config to:

```yaml
mcp_servers:
  prism-generated-tower:
    url: "http://127.0.0.1:<managed-port>/mcp"
    timeout: 120
    connect_timeout: 10
    sampling:
      enabled: false
    headers:
      Authorization: "Bearer <prism-owned-local-token>"
    tools:
      include:
        - tower_...
```

The generated server is a daemon-like Bun process started once per configured
plugin/scope, not once per Hermes client/session. It serves multiple MCP
sessions over the single `/mcp` endpoint. Session state is keyed by
`MCP-Session-Id`.

For the current implementation, one daemon per compiled source plugin is the
smallest compatible step. The daemon is shared by every harness config that
points at the same plugin/runtime port:

```text
~/.config/prism/mcp/prism_generated_<plugin>/
  server.mjs
  runtime.json     # port, pid, token metadata, build hash
~/.config/prism/tokens.json
```

The later consolidation step is one aggregate Prism daemon per scope that
serves tools from multiple source plugins. That is the better end state for
large agent fleets, but it is a larger ownership change because tool-name
collision handling, config patching, and bundle invalidation become global to
the scope instead of local to one plugin.

## Runtime Rules

A shared HTTP MCP runtime must hold these invariants:

1. Bind only to `127.0.0.1` by default.
2. Validate `Origin`/`Host` according to MCP HTTP security guidance.
3. Require a generated bearer token or an equivalent local authentication
   mechanism, even on localhost.
4. Disable server-initiated sampling unless a plugin explicitly opts in.
5. Bound request duration and outbound fetch duration.
6. Bound concurrent tool calls per server and, eventually, per tool.
7. Return structured tool errors instead of crashing the process.
8. Expose a local health endpoint or status probe for Prism lifecycle commands.
9. Store pid/port/token hash/build metadata in a Prism-owned runtime file and
   the bearer token in `tokens.json` under the Prism runtime root.
10. Never rewrite live harness config during `--dry-run`.

## Compiler Plan

1. Done: keep hardened stdio as the compatibility fallback.
2. Done: add an explicit MCP transport option:

   ```json
   {
     "targets": {
       "tools": ["hermes", "codex-cli", "claude-code", "antigravity-cli"]
     },
     "runtime": {
       "mcp": {
         "hermes": {
           "transport": "streamable-http"
         }
       }
     }
   }
   ```

3. Done: teach `generateMcpServerBundle` to emit either:
   - SDK-backed stdio server, or
   - SDK-backed Streamable HTTP server.
4. Done: add Prism-owned lifecycle commands:

   ```bash
   prism mcp serve <plugin> --harness hermes --host 127.0.0.1 --port auto
   prism mcp status --harness hermes
   prism mcp stop <plugin> --harness hermes
   ```

5. Done: add a runtime-file/lifecycle gate so install/compile starts the daemon
   by default, or verifies it when `--mcp-lifecycle verify` is requested.
6. Next: add process-count regression tests: ten concurrent MCP clients calling the
   same generated tool must not create ten generated server processes in HTTP
   mode.

## Test Strategy

Local tests should cover both transports:

- stdio still accepts content-length and newline JSON-RPC.
- Hermes stdio config emits absolute Bun when available, timeouts, disabled
  sampling, and explicit Prism runtime env.
- HTTP config emits the target-native HTTP URL key plus a static Prism-owned bearer header and
  does not emit `command`.
- One HTTP server handles multiple initialize requests and routes follow-up
  calls by `MCP-Session-Id`.
- Missing/invalid auth or invalid `Origin` fails before tool execution.
- Concurrent calls across sessions run through the same generated server
  process.
- Concurrent tool calls are bounded and fail predictably when over limit.
- Tower HTTP calls respect `TOWER_CONTROL_TIMEOUT_MS`.

## Open Questions

- Add systemd support for Linux; macOS uses a user LaunchAgent for live default
  lifecycle.
- Should the first HTTP runtime be stateless, or stateful with per-session
  transports? Stateless is simpler; stateful preserves resumability and
  notifications if Prism needs them later.
- Should plugin-level HTTP daemons be allowed indefinitely, or should Prism move
  quickly to a single aggregate daemon per harness scope?
- Grok Build plugin-local HTTP MCP config remains unverified and stays on stdio.
- Factory Droid supports both plugin-local stdio MCP through generated `mcp.json` and Prism-managed loopback Streamable HTTP MCP when explicitly configured.

## Sources

- MCP specification, 2025-11-25 latest, transport rules:
  https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP TypeScript SDK server guide:
  https://ts.sdk.modelcontextprotocol.io/documents/server.html
- MCP TypeScript SDK repository, package/runtime status:
  https://github.com/modelcontextprotocol/typescript-sdk
- Hermes MCP user guide, config shape and subprocess-vs-HTTP behavior:
  https://hermes-agent.lzw.me/docs/en/user-guide/features/mcp
- GitHub Advisory GHSA-w48q-cv73-mx4w / CVE-2025-66414, local HTTP DNS
  rebinding risk in older MCP TypeScript SDK defaults:
  https://github.com/advisories/GHSA-w48q-cv73-mx4w
- Local Hermes MCP client implementation:
  `/Users/guilhermecastro/.hermes/hermes-agent/tools/mcp_tool.py`
