# Goal: Make Prism Generated MCPs Safe Under Hermes Agent Fan-Out

Date: 2026-05-17
Status: in progress
Primary target harness: `hermes`

## Receipt

Prism generated MCP tools were observed creating a `mise` / `bun` process storm
when triggered through Hermes, especially from Tower tools. The Tower tool code
does not spawn processes directly. The operational failure is the current
generated MCP shape:

```yaml
mcp_servers:
  prism-generated-tower:
    command: "bun"
    args: [".../server.mjs"]
```

That is stdio MCP. The MCP client owns the subprocess. Under Hermes fan-out,
reconnects, or crash loops, process count scales with clients and configured
stdio servers. If `bun` is resolved through `mise`, the visible failure is a
`mise` storm.

The durable end state is not "make stdio slightly better." The durable end
state is:

- keep stdio as a compatibility fallback;
- compile Prism TypeScript tools into Streamable HTTP MCP servers when the
  harness can consume `url` MCP config;
- run one generated server process per configured scope/plugin at first;
- eventually consolidate to one aggregate Prism MCP server per harness scope;
- make Prism own daemon lifecycle so Hermes does not have to spawn Bun for
  every MCP client/session.

## Non-Negotiables

- Do not mutate live `~/.hermes/config.yaml` during research or dry-run tests.
- Do not restart Hermes as part of this refactor.
- Do not flip Tower to HTTP by default until daemon lifecycle exists or the
  operator explicitly opts in.
- Preserve current stdio behavior for harnesses that do not support HTTP MCP.
- Generated HTTP servers must bind to loopback by default.
- Generated HTTP servers must require auth even on localhost.
- Generated HTTP servers must validate Host and Origin.
- Generated tool calls must be bounded by timeout and concurrency limits.
- Server-initiated sampling must stay disabled unless explicitly enabled later.

## Current Local State

Already implemented in the current worktree:

- Hardened Hermes stdio config generation:
  - absolute Bun command when Prism itself is running under Bun;
  - `connect_timeout: 10`;
  - `timeout: 120`;
  - `sampling.enabled: false`;
  - explicit Prism runtime env for cwd/repo root.
- Generated MCP bundles stabilize runtime context with
  `PRISM_MCP_WORKING_DIRECTORY` and `PRISM_MCP_REPO_ROOT`.
- Generated MCP tool calls have `PRISM_MCP_TOOL_TIMEOUT_MS`.
- Generated Streamable HTTP MCP bundles exist behind an opt-in transport:

  ```json
  {
    "runtime": {
      "mcp": {
        "hermes": {
          "transport": "streamable-http",
          "host": "127.0.0.1",
          "port": 38463,
          "tokenEnv": "PRISM_MCP_TOKEN"
        }
      }
    }
  }
  ```

- Hermes HTTP lowering emits `url`, auth header, timeouts, disabled sampling,
  and tool include list.
- Generated HTTP server supports multiple MCP sessions through one Bun process.
- HTTP server requires bearer token, validates Host/Origin, enforces
  `MCP-Session-Id`, and has `PRISM_MCP_MAX_CONCURRENT_CALLS`.
- Tower Control requests in `../prism-plugins` have a bounded fetch timeout via
  `TOWER_CONTROL_TIMEOUT_MS`.

Verified locally:

- `bun test src/compile/mcp-bundle.test.ts -t MCP`
- `bun test src/compile/pipeline.test.ts -t Hermes`
- `bun run typecheck`
- `bun run build`
- `../prism-plugins: bun run typecheck`
- `git diff --check` in both repos
- `bun run dev -- compile ../prism-plugins/tower --harness hermes --dry-run`

## Desired Runtime Shape

Hermes config in HTTP mode:

```yaml
mcp_servers:
  prism-generated-tower:
    url: "http://127.0.0.1:38463/mcp"
    connect_timeout: 10
    timeout: 120
    enabled: true
    sampling:
      enabled: false
    headers:
      Authorization: "Bearer ${PRISM_MCP_TOKEN}"
    tools:
      include:
        - tower_...
```

Prism-owned runtime files:

```text
~/.hermes/prism/mcp/prism_generated_tower/
  server.mjs
  runtime.json
```

`runtime.json` should contain only Prism-owned lifecycle metadata:

```json
{
  "schema": "prism.mcp-runtime.v1",
  "serverName": "prism-generated-tower",
  "transport": "streamable-http",
  "host": "127.0.0.1",
  "port": 38463,
  "pid": 12345,
  "tokenEnv": "PRISM_MCP_TOKEN",
  "tokenSha256": "...",
  "serverSha256": "...",
  "startedAt": "2026-05-17T00:00:00.000Z",
  "healthUrl": "http://127.0.0.1:38463/healthz",
  "mcpUrl": "http://127.0.0.1:38463/mcp"
}
```

The token itself should not be written to `runtime.json`. If Prism generates a
token, it should write it only to the appropriate env file or print explicit
operator instructions.

## CLI Shape

Add a first-class `mcp` command group:

```bash
prism mcp serve <plugin-path> --harness hermes --scope global --port auto
prism mcp serve <plugin-path> --harness hermes --scope global --foreground
prism mcp status --harness hermes
prism mcp status <plugin-path> --harness hermes
prism mcp stop <plugin-path> --harness hermes
prism mcp restart <plugin-path> --harness hermes
```

Behavior:

- `serve` compiles or locates the generated HTTP MCP bundle, selects or verifies
  a port, verifies token availability, starts exactly one server process, waits
  for health, writes `runtime.json`, and exits only after startup is proven.
- `serve --foreground` runs the generated server in the current process group
  for debugging and logs the URL.
- `status` reads runtime files, checks pid liveness, checks `/healthz`, checks
  server hash drift, and reports stale runtime files clearly.
- `stop` terminates the recorded pid only if the process still matches the
  recorded server identity/hash.
- `restart` performs stop then serve.

## Forge Glyphs

Glyph IDs are planning labels only. They must not appear in generated MCP
protocol names, plugin manifests, public runtime output, or user-facing config.

### GLYPH-MCP-HTTP-01: Failure Analysis and Stdio Hardening

Status: done

Intent:

- Prove the storm is caused by stdio subprocess launch/reconnect behavior, not
  Tower directly spawning processes.
- Reduce immediate stdio blast radius while preserving compatibility.

Scope:

- `src/compile/lowerers/hermes.ts`
- `src/compile/mcp-bundle.ts`
- `src/compile/pipeline.test.ts`
- `src/compile/mcp-bundle.test.ts`
- `../prism-plugins/tower/tools/shared/orbit-server-client.ts`
- `docs/mcp-runtime-stability.md`

Acceptance:

- Hermes stdio config uses absolute Bun when available.
- Hermes stdio config includes connect/tool timeouts.
- Hermes stdio config disables sampling.
- Generated MCP runtime has stable cwd/repoRoot context.
- Tower Control HTTP calls have a bounded timeout.
- No live config is written.

Validation:

- Focused Hermes pipeline tests pass.
- Focused MCP bundle tests pass.
- Prism typecheck/build pass.
- Prism-plugins typecheck passes.
- Tower compile dry-run performs no writes.

Review dispatch:

- `requirements-tracer` returned `needs-work` because Tower timeout originally
  covered only response headers, not body consumption. Fixed by keeping the
  timeout signal alive through `responseMessage()` / `response.json()`.
- `security-reviewer` and `contract-reviewer` confirmed the same Tower timeout
  gap. Fixed before commit.

### GLYPH-MCP-HTTP-02: Opt-In Streamable HTTP Bundle

Status: done

Intent:

- Compile Prism TypeScript tools into a generated HTTP MCP server.
- Allow Hermes to target the generated server by `url` instead of `command`.
- Prove multiple MCP sessions use one generated Bun process.

Scope:

- `src/types.ts`
- `src/compile/load.ts`
- `src/compile/registry.ts`
- `src/compile/mcp-bundle.ts`
- `src/compile/lowerers/hermes.ts`
- `src/compile/mcp-bundle.test.ts`
- `src/compile/pipeline.test.ts`

Acceptance:

- `plugin.json -> runtime.mcp.hermes.transport` accepts
  `"streamable-http"`.
- Hermes HTTP runtime requires an explicit port for now.
- Hermes HTTP config emits `url` and does not emit `command`.
- Generated HTTP server handles `initialize`, `tools/list`, `tools/call`,
  `shutdown`, and `notifications/exit`.
- Generated HTTP server issues and checks `MCP-Session-Id`.
- Generated HTTP server requires bearer auth.
- Generated HTTP server rejects invalid Origin.
- Ten concurrent tool calls across two sessions use the same server process.
- Default transport remains stdio.

Validation:

- `bun test src/compile/mcp-bundle.test.ts -t MCP`
- `bun test src/compile/pipeline.test.ts -t Hermes`
- `bun run typecheck`
- `bun run build`

Review dispatch:

- `requirements-tracer` requested coverage for HTTP concurrency rejection and
  HTTP shutdown / `notifications/exit`. Added tests.
- `security-reviewer` flagged timeout/concurrency leakage where timed-out tool
  work could keep running while the concurrency slot was released. Fixed by
  keeping the HTTP concurrency slot occupied until underlying work settles.
- `security-reviewer` flagged non-loopback host acceptance, unbounded sessions,
  and unbounded request bodies. Fixed with loopback host validation,
  `PRISM_MCP_MAX_SESSIONS`, session TTL, and `PRISM_MCP_MAX_REQUEST_BYTES`.
- `contract-reviewer` flagged missing `MCP-Protocol-Version` validation. Fixed
  by requiring a supported protocol-version header for HTTP POST/DELETE.
- `verification-reviewer` flagged post-buffer request-size enforcement and
  missing negative tests for session/request/host rejection. Fixed with bounded
  stream reading plus direct regression tests.

### GLYPH-MCP-HTTP-03: Runtime Metadata and Health Endpoint

Status: pending

Intent:

- Give Prism a durable local record of generated MCP daemon state.
- Give operators and tests a cheap way to verify the daemon is alive and
  matches the compiled artifact.

Scope:

- `src/compile/mcp-bundle.ts`
- new runtime helper module under `src/compile/` or `src/mcp/`
- tests for runtime file read/write and health response

Acceptance:

- Generated HTTP server exposes `GET /healthz`.
- Health response includes server name, transport, uptime, pid, tool count,
  and server hash if provided by env.
- Prism can compute a stable sha256 for the generated `server.mjs`.
- Runtime metadata schema is typed and versioned.
- Runtime metadata never stores secret token values.
- Stale runtime files are detectable.

Validation:

- Unit tests for runtime metadata parser.
- HTTP server test checks `/healthz`.
- `git diff --check`.
- Typecheck.

### GLYPH-MCP-HTTP-04: `prism mcp serve/status/stop/restart`

Status: pending

Intent:

- Make Prism own the daemon lifecycle so Hermes can safely point at `url`
  MCP servers without needing to spawn Bun itself.

Scope:

- `src/cli.ts`
- new `src/mcp/lifecycle.ts`
- generated bundle path resolution
- runtime metadata read/write
- process liveness checks
- tests for serve/status/stop behavior

Acceptance:

- `prism mcp serve <plugin> --harness hermes --scope global --port auto`
  starts exactly one generated HTTP MCP daemon.
- Re-running `serve` is idempotent when the live daemon matches the current
  server hash.
- Re-running `serve` restarts or errors clearly when the recorded daemon is
  stale.
- `status` reports running, stopped, stale pid, stale build, missing token, and
  port conflict states.
- `stop` only stops the recorded Prism-owned daemon.
- `restart` is equivalent to safe stop plus serve.
- `--foreground` runs without daemonizing and does not write misleading pid
  metadata.
- All commands are local-only and never mutate live Hermes config unless the
  user separately runs compile/install without `--dry-run`.

Validation:

- CLI tests with temp plugin and temp runtime root.
- Process-count test proves repeated `serve` does not create duplicate daemons.
- Typecheck/build.

### GLYPH-MCP-HTTP-05: Install-Time Lifecycle Gate

Status: pending

Intent:

- Prevent Prism from writing Hermes `url` config that points to nothing, unless
  the operation explicitly starts or verifies the daemon.

Scope:

- `src/installer.ts`
- `src/compile/pipeline.ts`
- Hermes lowerer integration points
- CLI option design

Acceptance:

- `compile --dry-run` may preview HTTP config.
- Non-dry-run install/compile refuses to write Hermes HTTP `url` config if the
  daemon is not running and no lifecycle option was provided.
- An explicit option can start/verify the daemon before config write.
- Error message tells the operator the exact `prism mcp serve ...` command.
- Stdio fallback remains available.

Validation:

- Tests cover dry-run preview, missing daemon refusal, running daemon success,
  and stdio fallback.

### GLYPH-MCP-HTTP-06: Tower Opt-In Migration

Status: pending

Intent:

- Move Tower to HTTP MCP only after lifecycle is reliable.
- Avoid reintroducing the Hermes/mise process storm.

Scope:

- `../prism-plugins/tower/plugin.json`
- Tower docs if present
- Prism dry-run and lifecycle smoke

Acceptance:

- Tower declares `runtime.mcp.hermes.transport = "streamable-http"` with an
  explicit port or a lifecycle-managed port.
- Tower MCP daemon starts with `prism mcp serve`.
- Hermes config preview uses `url`, not `command`.
- Tower tools function through the HTTP MCP server.
- No live config is changed during validation unless explicitly authorized.

Validation:

- `prism mcp serve ../prism-plugins/tower --harness hermes --scope global`
  in a controlled local test mode.
- `prism mcp status ../prism-plugins/tower --harness hermes`.
- `prism compile ../prism-plugins/tower --harness hermes --dry-run`.
- Tower plugin typecheck.

### GLYPH-MCP-HTTP-07: Aggregate Server Per Scope

Status: future

Intent:

- Reduce process count further by serving multiple Prism-generated source
  plugins from one aggregate MCP server per harness scope.

Scope:

- Bundle composition model
- Tool-name collision policy
- Aggregate runtime metadata
- Config patch strategy for multiple `mcp_servers` entries or one shared entry

Acceptance:

- One aggregate server can host tools from multiple source plugins.
- Tool names remain deterministic and collision-safe.
- Per-plugin enable/disable remains possible.
- Runtime restart is atomic enough that Hermes does not see partial tool
  inventory.
- Existing one-server-per-plugin mode remains available as a fallback.

Validation:

- Multi-plugin fixture with two plugins and shared dependency.
- Concurrent calls across both plugin toolsets use one process.
- Config diff remains deterministic.

### GLYPH-MCP-HTTP-08: Cross-Harness HTTP MCP Support

Status: future

Intent:

- Reuse the HTTP MCP runtime for other harnesses that support `url` MCP config.

Scope:

- Harness capability discovery
- Target-specific config lowerers
- Compatibility docs

Acceptance:

- Each harness explicitly declares supported MCP transports.
- HTTP config is emitted only where the harness supports it.
- Stdio remains the default fallback elsewhere.

Validation:

- Per-harness lowerer tests.
- Dry-run fixtures.

## Open Design Decisions

1. Port allocation:
   - Current implementation requires explicit port in plugin runtime config.
   - Lifecycle should support `--port auto` and persist the chosen port in
     `runtime.json`.

2. Token storage:
   - Preferred: operator-managed env var.
   - Possible: Prism-managed env file with strict permissions.
   - Never store raw token in `runtime.json`.

3. SDK usage:
   - Current implementation is dependency-light and implements the subset Prism
     needs for generated tools.
   - Re-evaluate the official MCP TypeScript SDK for full Streamable HTTP
     compliance, resumability, and future notifications.

4. Daemonization:
   - Simplest: spawn detached Bun child and record pid.
   - More robust on macOS: generate launchd plist.
   - Cross-platform future: systemd/user service equivalents.

5. Config write gate:
   - Strict mode should refuse HTTP config if daemon is missing.
   - Dry-run should always be allowed.
   - Explicit operator override may be useful for externally supervised daemons.

## Final Success Criteria

The refactor is complete when:

- Tower can be opted into Hermes HTTP MCP without a `bun`/`mise` subprocess
  storm.
- Hermes talks to Tower through `url`, not `command`.
- Prism starts exactly one Tower MCP daemon for the chosen scope.
- Ten Hermes-like concurrent MCP sessions can call Tower tools without spawning
  additional generated server processes.
- `prism mcp status` makes daemon state obvious.
- `prism mcp stop` cleans up the daemon safely.
- Reboot/restart instructions are documented.
- Stdio remains available and tested for harnesses that need it.
- No live user config is changed by dry-run or research commands.

## Sources

- MCP transports specification:
  https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP TypeScript SDK server guide:
  https://ts.sdk.modelcontextprotocol.io/documents/server.html
- Hermes MCP user guide:
  https://hermes-agent.lzw.me/docs/en/user-guide/features/mcp
- MCP TypeScript SDK HTTP security advisory:
  https://github.com/advisories/GHSA-w48q-cv73-mx4w
- Local design note:
  `docs/mcp-runtime-stability.md`
