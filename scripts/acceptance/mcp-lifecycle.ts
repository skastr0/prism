/**
 * Acceptance gate: mcp-lifecycle (overhaul WS6 regression net) — BLOCKED STUB.
 *
 * Intended gate (runs once WS6 makes the lifecycle sandboxable):
 *   1. serve an http-transport plugin into a sandbox harness root,
 *   2. restart 5x and assert the lowered harness config bytes are identical
 *      across restarts (EXPECTED FAIL on the pre-WS6 lifecycle: every boot
 *      rotates token + port via getFreePort/ensureMcpToken),
 *   3. stop, then assert no orphan daemon processes (pgrep on the sandbox
 *      server path).
 *
 * Why it is a stub today — sandboxability audit of src/mcp/lifecycle.ts +
 * src/mcp/launchd.ts (2026-06-10):
 *
 *   - serve IS sandboxable: with a sandboxed PRISM_HOME (any path other than
 *     ~/.prism), launchAgentEligible() returns false, so serveMcpResolved
 *     spawns a detached `bun server.mjs` child (spawnDaemon) instead of
 *     installing a LaunchAgent; bundle, token store, runtime.json and logs
 *     all stay under PRISM_HOME/runtime. Belt-and-braces
 *     PRISM_MCP_DISABLE_LAUNCHD=1 also forces the spawn path.
 *
 *   - WS3 update: stop/restart now share the launchAgentEligible(prismHome)
 *     predicate with serve — a sandboxed PRISM_HOME never touches launchctl,
 *     and serve consumes the compiled canonical bundle (it never rewrites
 *     bundles). The remaining blocker is WS6 scope: stable port + token
 *     identity across restarts (the byte-identical-configs assertion) and the
 *     supervisor-owned runtime.json writes.
 *
 * What WS6 must change to make this gate executable (tracked requirements,
 * mirrored in the JSON below):
 *
 *   1. Every launchctl invocation goes through an injectable launchd service
 *      (Effect Context.Tag with a Live darwin layer and a no-op sandbox/test
 *      layer) — or minimally, stop/restart honor the same sandbox predicate
 *      as serve (sandbox root => never touch launchctl).
 *   2. All runtime state (plists, tokens, runtime.json, logs, bundles) lives
 *      under PRISM_HOME/runtime/mcp/<plugin>/ — never ~/Library/LaunchAgents
 *      or harness roots — so a sandboxed PRISM_HOME fully contains the gate.
 *   3. Port allocated once and persisted; token rotated only via explicit
 *      `prism mcp rotate-token`: 5 restarts must produce byte-identical
 *      lowered harness configs (this is the EXPECTED-FAIL assertion the gate
 *      will flip to PASS).
 *   4. Server identity (host/port/token) read from env + endpoint.json at
 *      startup instead of compile-time defines, so restarts never rewrite
 *      the bundle.
 *
 * Usage: bun scripts/acceptance/mcp-lifecycle.ts
 */

const summary = {
  gate: "mcp-lifecycle",
  pass: null,
  expected: null,
  blocked:
    "WS3 removed the launchctl hazard (serve/stop/restart all gate launchctl behind " +
    "launchAgentEligible(prismHome), and serve consumes the compiled canonical bundle instead of " +
    "rewriting it). The gate stays a stub until WS6 lands its assertions' subject: stable " +
    "port + token identity across restarts and the supervisor as sole runtime.json writer.",
  details: {
    sandboxable: {
      serve:
        "yes — sandboxed PRISM_HOME makes launchAgentEligible() false; " +
        "spawnDaemon runs a detached bun child with state under PRISM_HOME/runtime",
      stop: "yes — stop shares the launchAgentEligible(prismHome) predicate since WS3",
      restart: "yes — restart = stop + serve under the same predicate",
    },
    ws6Requirements: [
      "gate every launchctl call behind an injectable launchd service (Live darwin layer + no-op sandbox layer), or apply the serve-side sandbox predicate to stop/restart",
      "scope plists/tokens/runtime.json/logs/bundles under PRISM_HOME/runtime/mcp/<plugin>/ so a sandboxed PRISM_HOME fully contains the gate",
      "stable identity: port allocated once and persisted, token rotated only via `prism mcp rotate-token` — 5 restarts must yield byte-identical lowered harness configs",
      "server reads host/port/token from env + endpoint.json at startup; no compile-time defines, so restarts never rewrite the bundle",
    ],
    plannedAssertions: [
      "serve http-transport plugin into sandbox root succeeds",
      "restart 5x -> lowered harness config bytes identical across restarts (EXPECTED FAIL pre-WS6: per-boot token+port rotation)",
      "stop -> pgrep on the sandbox server path finds no orphan daemons",
    ],
  },
};

console.log(JSON.stringify(summary, null, 2));
process.exitCode = 0;
