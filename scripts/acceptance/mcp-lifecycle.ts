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
 *   - serve IS sandboxable: with `--root <sandbox>` (any path other than
 *     defaultMcpRuntimeRoot() = ~/.config), shouldUseLaunchAgent() returns
 *     false, so serveMcpResolved spawns a detached `bun server.mjs` child
 *     (spawnDaemon) instead of installing a LaunchAgent; bundle, token store,
 *     runtime.json and logs all stay under the sandbox root. Belt-and-braces
 *     PRISM_MCP_DISABLE_LAUNCHD=1 also forces the spawn path.
 *
 *   - stop/restart are NOT sandboxable: stopMcpResolved unconditionally runs
 *     `launchctl bootout gui/<uid>/com.prism.mcp.<serverName>` on darwin
 *     (lifecycle.ts ~line 1419 -> stopLaunchAgent in launchd.ts). There is no
 *     root guard and no PRISM_MCP_DISABLE_LAUNCHD guard on the stop path —
 *     the env var is only consulted by shouldUseLaunchAgent on the serve
 *     side. The label is derived purely from the plugin name, so serving a
 *     corpus plugin in a sandbox and stopping it would bootout the REAL
 *     registered launch agent of the same plugin on this machine. Even with
 *     a randomized plugin name, every restart still invokes launchctl against
 *     the real user gui domain. serveMcpResolved's stale-build branch calls
 *     the same stop path, so a restart loop multiplies the exposure 5x.
 *
 *   Real-machine launchctl side effects therefore cannot be ruled out for the
 *   restart/stop half of the gate -> per the acceptance-net rules this lands
 *   as a stub that exits 0 and reports blocked.
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
    "stopMcpResolved unconditionally runs `launchctl bootout gui/<uid>/com.prism.mcp.<serverName>` on darwin " +
    "(src/mcp/lifecycle.ts -> stopLaunchAgent in src/mcp/launchd.ts) with no sandbox-root or " +
    "PRISM_MCP_DISABLE_LAUNCHD guard; the label derives from the plugin name alone, so a sandboxed " +
    "restart/stop cycle would bootout real registered launch agents (or at best hammer the real gui " +
    "domain 5x). Real-machine launchctl side effects cannot be ruled out until WS6's supervisor lands.",
  details: {
    sandboxable: {
      serve:
        "yes — --root <sandbox> != defaultMcpRuntimeRoot() makes shouldUseLaunchAgent() false; " +
        "spawnDaemon runs a detached bun child with state under the sandbox root",
      stop: "no — unconditional launchctl bootout on darwin",
      restart: "no — restart = stop + serve; the stale-build serve branch also calls stop",
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
