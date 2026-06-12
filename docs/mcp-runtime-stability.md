# MCP Runtime Stability

This note records the current Prism generated-MCP runtime contract.

## Decision

Prism generated MCP uses Streamable HTTP only.

The stdio transport was removed because every MCP client connection can launch a
new subprocess. Under Hermes or other agent fan-out, that scales process count
with clients, configured generated servers, and reconnect attempts. That shape
is not reliable enough for Prism-managed generated tools.

Prism now rejects `plugin.json -> runtime.mcp.<harness>.transport` values other
than `streamable-http`.

## Current Architecture

Each source plugin gets one canonical generated MCP bundle:

```text
<PRISM_HOME>/runtime/mcp/<source-plugin>/server.mjs
```

Harness roots never receive generated MCP server bundles. They only receive
config entries that point at a Prism-managed loopback daemon:

```text
http://127.0.0.1:<managed-port>/mcp
```

The daemon serves multiple Streamable HTTP sessions from one Bun process. Prism
records runtime metadata beside the bundle and stores bearer tokens in:

```text
<PRISM_HOME>/runtime/mcp/tokens.json
```

## Config Contract

Generated configs use HTTP-native fields:

- Codex CLI: `url`, `bearer_token_env_var`, `enabled_tools`
- Claude Code: `.mcp.json` with `type: "http"`, `url`, and `headers`
- Hermes: `config.yaml -> mcp_servers.<name>.url`, `headers`, and `tools.include`
- Antigravity CLI: `mcp_config.json -> serverUrl` and `headers`
- Factory Droid: `mcp.json -> type: "http"`, `url`, and `headers`
- Kimi Code: plugin `mcpServers` with `url`, `headers` or `bearerTokenEnvVar`, and `enabledTools`
- Cursor: `mcp.json -> url` and `headers`
- Grok Build: plugin-local `.mcp.json` with `type: "http"`, `url`, and `headers`

Codex and Claude render environment-token config entries so tracked configs do
not serialize live bearer tokens. Other harnesses keep using their current
verified HTTP config shape until they have a safe env-token surface.

Grok generated MCP config uses the same shared Streamable HTTP daemon as the
other generated-MCP plugin-bundle targets. Prism does not emit Grok stdio MCP
config.

## Exposure Contract

The generated bundle is a union of the tools needed by generated-MCP-config
harness targets. Per-harness exposure must remain deny-by-default.

Native client filters are still used where available:

- Codex `enabled_tools`
- Hermes `tools.include`
- Kimi `enabledTools`

For shared HTTP daemons, configs that support headers also send:

```text
X-Prism-Mcp-Exposure: prism-generated-<plugin>:<harness>
```

The generated HTTP server validates that profile and registers only the tool
names assigned to that harness for the MCP session. This replaces the removed
stdio-era `PRISM_MCP_ENABLED_TOOLS` per-process config hack.

## Runtime Rules

A Prism generated HTTP MCP runtime must:

1. Bind to loopback by default.
2. Validate `Host` and `Origin`.
3. Require bearer authentication.
4. Keep bearer token values out of runtime metadata.
5. Bound sessions, request bytes, concurrent tool calls, and tool duration.
6. Expose authenticated health data for lifecycle checks.
7. Fail closed on missing bundles, stale bundle hashes, stale health, invalid
   tokens, non-loopback hosts, or unsupported targets.
8. Keep dry-runs side-effect free.

## Verification

The regression suite covers:

- Streamable HTTP multi-session serving from one process.
- Official SDK Streamable HTTP client compatibility.
- Host/origin/auth failures before tool execution.
- Session and request-size caps.
- Tool concurrency and timeout release.
- Output validation at runtime.
- Cross-harness union bundle exposure profiles.
- Codex/Claude env-token config rendering.
- Stale daemon and stale bundle lifecycle gates.
