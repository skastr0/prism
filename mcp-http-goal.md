# Goal: Make Prism Generated MCPs Safe Under Hermes Agent Fan-Out

Date: 2026-05-17
Status: in progress
Primary target harness: `hermes`

Phase 1 status: done.
Phase 2 status: in progress.

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

Status: done

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

- `bun test src/mcp/runtime-metadata.test.ts`
- `bun test src/compile/mcp-bundle.test.ts -t MCP`
- `bun test src/compile/pipeline.test.ts -t Hermes`
- `bun run typecheck`
- `bun run build`
- `git diff --check`

Review dispatch:

- `requirements-tracer` returned no findings.
- `verification-reviewer` first requested stronger coverage for health
  `uptimeMs` / `startedAt`, unsupported metadata schemas, and missing token
  hash staleness. Added tests.
- `security-reviewer` flagged token-shaped metadata fields and PID-only
  liveness. Fixed by validating `tokenEnv` as an env var name, rejecting URL
  credentials / query / fragments, adding a typed health parser, and requiring
  matching health data for Streamable HTTP freshness checks.
- Security and verification re-reviews returned no findings.

### GLYPH-MCP-HTTP-04: `prism mcp serve/status/stop/restart`

Status: done

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
- `stop` refuses forged or unproven ownership cases where the recorded pid
  command or listening port does not match the generated server.
- `--foreground` runs without daemonizing and does not write misleading pid
  metadata.
- All commands are local-only and never mutate live Hermes config unless the
  user separately runs compile/install without `--dry-run`.

Validation:

- `bun test src/mcp/lifecycle.test.ts`
- `bun test src/cli.test.ts -t mcp`
- `bun test src/mcp/runtime-metadata.test.ts`
- `bun test src/compile/mcp-bundle.test.ts -t MCP`
- `bun test src/compile/pipeline.test.ts -t Hermes`
- `bun run typecheck`
- `bun run build`
- `git diff --check`

Review dispatch:

- `requirements-tracer` flagged token-gated status/stop and stale daemon
  cleanup. Fixed by checking local pid/build/listener ownership before health
  auth and by allowing safe stop/restart for Prism-owned stale states.
- `security-reviewer` flagged `runtime.json` health/token redirection and
  PID-only stop ownership. Fixed by deriving health URLs, rejecting non-loopback
  endpoints, checking the pid command shape, verifying the recorded pid owns
  the listening port before sending bearer auth, and refusing unproven
  ownership.
- `verification-reviewer` flagged missing stop/restart branch coverage. Added
  coverage for duplicate serve suppression, source drift, missing token stop,
  stale pid recovery, stale build restart, missing server file stop,
  port-conflict refusal/recovery, foreground metadata behavior, config
  non-mutation, and forged metadata with zero attacker health hits.

### GLYPH-MCP-HTTP-05: Install-Time Lifecycle Gate

Status: done

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

- `bun run typecheck`
- `bun test src/compile/pipeline.test.ts -t Hermes`
- `bun test src/cli.test.ts -t "install propagates Hermes HTTP MCP lifecycle gate"`
- `bun test src/cli.test.ts -t mcp`
- `bun test src/mcp/lifecycle.test.ts`
- `bun test src/mcp/runtime-metadata.test.ts`
- `bun test src/compile/mcp-bundle.test.ts -t MCP`
- `bun run build`
- `git diff --check`

Review dispatch:

- `requirements-tracer` flagged that the recovery command omitted the compile
  root override. Fixed by rendering `--root <compile-root>` in the exact
  `prism mcp serve ...` command.
- `security-reviewer` flagged stale daemon bypass and failed startup cleanup.
  Fixed by comparing the running daemon against the newly planned server hash
  before config writes, and by restoring/removing `server.mjs` if lifecycle
  startup fails before metadata is recorded.
- `verification-reviewer` flagged weak proof of the rendered command and
  ordering. Added exact command assertions and a failed `--mcp-lifecycle serve`
  regression proving config is not written before daemon startup succeeds.

### GLYPH-MCP-HTTP-06: Tower Opt-In Migration

Status: done

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

- `../prism-plugins: bun run typecheck`
- `prism: bun run typecheck`
- `prism: bun run dev -- compile ../prism-plugins/tower --harness hermes --dry-run`
- Isolated temp-root lifecycle smoke:
  - `prism mcp serve ../prism-plugins/tower --harness hermes --scope global --root <tmp>`
  - `prism mcp status ../prism-plugins/tower --harness hermes --scope global --root <tmp>`
  - `prism mcp restart ../prism-plugins/tower --harness hermes --scope global --root <tmp>`
  - `prism compile ../prism-plugins/tower --harness hermes --root <tmp> --mcp-lifecycle verify`
  - HTTP MCP `initialize`, `tools/list`, and read-only `tower_list_glyphs`
    call succeeded through the generated server.
  - Ten concurrent Tower HTTP MCP sessions called read-only Tower tools with
    the same daemon pid before and after, and exactly one temp-root
    `server.mjs` process existed.
  - Generated temp Hermes config used `url` plus
    `Authorization: Bearer ${PRISM_MCP_TOWER_TOKEN}` and no `command`.
  - `prism mcp stop ../prism-plugins/tower --harness hermes --scope global --root <tmp>`
    stopped the temp daemon; its recorded pid no longer existed.
- `git diff --check` in both repos.

Review dispatch:

- `requirements-tracer` initially flagged Tower skill instructions that omitted
  `--root`, making the validation snippet too easy to run against live Hermes.
  Fixed by documenting a `TMP_HERMES_ROOT` validation flow and reserving root
  omission for intentional live activation. Re-review returned no findings.
- `security-reviewer` returned no blocking findings after the doc fix, clearing
  process-storm, live-config-mutation, host/port/token, and cleanup risk.
- `verification-reviewer` returned `pass` and independently confirmed temp-root
  serve/status/compile, `tools/list`, a read-only Tower call, `url` config with
  no `command`, and daemon cleanup.

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

## Completion Audit

Objective:

- Make Prism-generated Tower MCP safe under Hermes fan-out.
- Keep stdio compatibility for harnesses that still need it.
- Move Tower's Hermes runtime to Prism-managed Streamable HTTP only after
  daemon lifecycle and install-time safety gates exist.
- Validate and review each implemented glyph, then commit the result.

Prompt-to-artifact checklist:

- `mcp-http-goal.md` exists and is the canonical refactor plan: this file.
- Forge glyph tracking exists: GLYPH-MCP-HTTP-01 through 06 record intent,
  scope, acceptance, validation, and review dispatches.
- Each completed glyph has been committed:
  - `01eae6c feat(mcp): add hermes streamable http runtime`
  - `2417840 fix(tower): bound control request bodies`
  - `40040f3 feat(mcp): record runtime health metadata`
  - `c1b64d2 feat(mcp): add hermes daemon lifecycle`
  - `a881c30 feat(mcp): gate hermes http config writes`
  - `eeefc77 feat(tower): opt hermes into http mcp`
  - `138a834 docs(mcp): record tower http migration`
  - `1bc40b1 docs(tower): document hermes http restart flow`
- Reviewers were dispatched for each implemented glyph. Recorded review notes
  are under each glyph's `Review dispatch` section.
- Tower can be opted into Hermes HTTP MCP without a `bun`/`mise` subprocess
  storm: `../prism-plugins/tower/plugin.json` declares Hermes
  `streamable-http` with loopback host, explicit port, and
  `PRISM_MCP_TOWER_TOKEN`.
- Hermes talks to Tower through `url`, not `command`: temp-root generated
  `config.yaml` contained `url: "http://127.0.0.1:38463/mcp"` and no
  `command`.
- Prism starts exactly one Tower MCP daemon for the chosen scope: temp-root
  `prism mcp serve` / `restart` produced one recorded daemon pid and one
  matching temp-root `server.mjs` process.
- Ten Hermes-like concurrent MCP sessions can call Tower tools without spawning
  more generated servers: ten concurrent sessions called `tower_list_glyphs`,
  health pid stayed `94681`, and process inspection found exactly one matching
  temp-root `server.mjs`.
- `prism mcp status` makes daemon state obvious: temp-root status reported
  `running` with pid/url before stop and `stopped` after stop.
- `prism mcp stop` cleans up safely: temp-root stop removed the recorded pid;
  `ps -p <pid>` no longer found the process.
- Reboot/restart instructions are documented:
  `../prism-plugins/tower/skills/tower/SKILL.md` documents temp-root
  `restart` validation and live post-reboot activation order.
- Stdio remains available and tested for harnesses that need it: default
  transport remains stdio unless plugin runtime opts into HTTP, and GLYPH-01 /
  GLYPH-02 validation covers the stdio fallback and HTTP opt-in split.
- No live user config was changed by research/dry-run commands: all non-dry-run
  lifecycle validation used `--root <tmp>`; live Hermes compile was run only
  with `--dry-run`.

GLYPH-MCP-HTTP-07 and GLYPH-MCP-HTTP-08 remain explicit future extensions.
They reduce process count further and expand HTTP support to additional
harnesses, but they are not required for the current Hermes/Tower storm fix
captured by the final success criteria above.

## Phase 2: Generic HTTP MCP Lowering

Intent:

- Move Streamable HTTP MCP support out of Hermes-only code paths.
- Keep HTTP opt-in per plugin and per harness through
  `plugin.json -> runtime.mcp.<harness>`.
- Support every generated-MCP lowerer whose target harness can safely express a
  URL transport with non-plaintext auth.
- Turn HTTP on for Tower and Grok Agent wherever supported by the target
  harness.
- Keep stdio as the default fallback everywhere.
- Use Pulsar CLI as an added quality/backpressure gate.

Target support matrix:

- Hermes: supports URL MCP config with bearer header; HTTP opt-in should be
  supported.
- Codex CLI: supports Streamable HTTP via `url` and `bearer_token_env_var`;
  HTTP opt-in should be supported.
- Claude Code: supports `type: "http"`, `url`, and env-expanded headers in
  `.mcp.json`; HTTP opt-in should be supported for plugin-bundled MCP configs.
- Gemini CLI: supports Streamable HTTP via `httpUrl` and static `headers`, but
  documented env expansion is limited to the `env` block and the upstream issue
  for header env substitution remains open. Prism must not emit plaintext bearer
  tokens, so Gemini HTTP opt-in must fail closed until a safe token path exists.
- Grok Build: Prism currently emits plugin-local `.mcp.json`. Treat HTTP support
  as target-specific and require explicit evidence or fail closed.

### GLYPH-MCP-HTTP-09: Shared MCP HTTP Runtime Contract

Status: done

Intent:

- Extract a target-agnostic runtime resolver for generated MCP servers.
- Make lowerers ask the same helper whether a plugin/harness uses stdio or
  Streamable HTTP.
- Make lifecycle and install-time gates target-aware instead of Hermes-only.

Scope:

- New shared lowerer/runtime helper under `src/compile/`.
- `src/cli.ts`
- `src/mcp/lifecycle.ts`
- `src/compile/pipeline.ts`
- tests covering target-aware runtime parsing/gating.

Acceptance:

- `runtime.mcp.<harness>.transport = "streamable-http"` is parsed and
  validated generically.
- HTTP transport requires loopback host, explicit or lifecycle-managed port,
  and a valid token env var.
- Unsupported target HTTP opt-ins fail closed with an actionable error.
- `prism mcp serve/status/stop/restart` accepts supported harness IDs instead
  of only Hermes.
- Compile/install lifecycle gate applies to any HTTP target that writes URL
  config.
- Stdio remains the default for all targets.

Validation:

- `bun test src/compile/mcp-runtime.test.ts src/mcp/lifecycle.test.ts src/compile/pipeline.test.ts -t "MCP|Hermes|runtime"`
- `bun test src/cli.test.ts -t mcp`
- `bun run typecheck`
- `git diff --check`
- `pulsar score .`

Notes:

- Added `src/compile/mcp-runtime.ts` as the shared target-aware runtime
  resolver, support matrix, generated server naming/path helper, loopback and
  token-env validation, and tool-target assertion point.
- Generalized `prism mcp serve/status/stop/restart` from Hermes-only to any
  lifecycle-supported MCP target. Unsupported targets still fail closed through
  the shared support matrix.
- Generalized the compile/install lifecycle gate so any target that emits
  Streamable HTTP URL config can require `verify` or `serve` before writing.
- Pulsar hard gate passed. Readiness remains under repo-wide backpressure due
  to pre-existing large-file/churn findings, not a new hard failure from this
  glyph.

### GLYPH-MCP-HTTP-10: HTTP Config Renderers for URL-Capable Lowerers

Status: done

Intent:

- Reuse shared MCP config rendering logic across lowerers.
- Add opt-in HTTP config emission for Codex CLI and Claude Code.
- Keep Hermes on the shared path.
- Fail closed for Gemini/Grok targets if secure token config cannot be proven.

Scope:

- `src/compile/lowerers/hermes.ts`
- `src/compile/lowerers/codex-cli.ts`
- `src/compile/lowerers/claude-code.ts`
- `src/compile/lowerers/gemini-cli.ts`
- `src/compile/lowerers/grok.ts`
- lowerer tests.

Acceptance:

- Hermes HTTP output remains unchanged except for shared implementation.
- Codex HTTP output uses `url` and `bearer_token_env_var`, not `command`.
- Claude HTTP output uses `type: "http"`, `url`, and env-expanded
  `Authorization` header, not `command`.
- Gemini/Grok HTTP opt-in either emits a verified secure URL config or rejects
  the opt-in with a clear reason.
- Stdio output remains unchanged for plugins without HTTP runtime config.

Validation:

- `bun test src/compile/mcp-runtime.test.ts src/compile/codex-cli-lowerer.test.ts src/compile/claude-code-lowerer.test.ts src/compile/gemini-cli-lowerer.test.ts src/compile/grok-lowerer.test.ts`
- `bun test src/compile/pipeline.test.ts -t "canonical tools|Codex|Claude|Gemini|Grok|Hermes"`
- `bun run typecheck`
- `bun run build`
- `git diff --check`
- `pulsar score .`

Notes:

- Hermes now uses the shared runtime resolver, URL renderer, bearer-header
  template, generated server naming/path helper, and bundle transport options.
- Codex CLI HTTP opt-in emits `url` plus `bearer_token_env_var` in both
  agent-local MCP blocks and managed global config blocks. It writes the HTTP
  server bundle to the shared lifecycle path under `<codex-root>/prism/mcp/`.
- Claude Code HTTP opt-in emits plugin `.mcp.json` with `type: "http"`,
  `url`, and env-expanded `Authorization` header. It writes the HTTP server
  bundle to the shared lifecycle path under `<claude-root>/prism/mcp/`.
- Gemini CLI and Grok Build fail closed for `streamable-http` runtime opt-in
  until Prism can prove a safe bearer-token secret source for those targets.
- Stdio remains the default and existing stdio lowerer tests remain passing.
- Pulsar hard gate passed. Readiness remains under repo-wide churn pressure,
  including lowerer churn called out by Pulsar.

### GLYPH-MCP-HTTP-11: Tower and Grok Agent HTTP Opt-In

Status: pending

Intent:

- Turn on HTTP MCP for Tower and Grok Agent where the target lowerer supports
  safe URL MCP config.

Scope:

- `../prism-plugins/tower/plugin.json`
- `../prism-plugins/grok-agent/plugin.json`
- plugin docs/lockfiles as needed.

Acceptance:

- Tower declares HTTP runtime for Hermes, Codex CLI, and Claude Code.
- Grok Agent declares HTTP runtime for Hermes, Codex CLI, and Claude Code.
- Unsupported targets are not silently configured as HTTP.
- Temp-root compile previews for each supported harness emit URL config, not
  stdio `command`.
- Live user configs are not mutated during validation.

Validation:

- Prism focused tests and typecheck.
- Prism-plugins typecheck.
- temp-root `prism mcp serve/status/compile --mcp-lifecycle verify/stop` for
  Tower and Grok Agent on supported targets.
- `pulsar score .`

### GLYPH-MCP-HTTP-12: Live Install Decision and Final Audit

Status: pending

Intent:

- Decide whether to install the new HTTP MCPs into live harness configs.
- If installed, do it with daemon lifecycle safety and verify the resulting
  live config.
- If not installed, record the exact operator commands.

Scope:

- live harness config only if explicitly authorized.
- `mcp-http-goal.md` completion audit.

Acceptance:

- The final answer distinguishes capability from live installation state.
- If live install is authorized, Tower and Grok Agent live configs use URL
  transports for supported harnesses and daemons are running.
- If live install is not authorized, no live config is mutated and exact
  install commands are documented.

Validation:

- live or temp-root `mcp status` evidence.
- config inspection for `url` versus `command`.
- `git status --short` clean in both repos.

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
