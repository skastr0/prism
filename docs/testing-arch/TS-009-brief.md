# Architecture Brief: TS-009 MCP daemon lifecycle stress tests

## Goal
Harden the MCP daemon start/stop/restart path so that spin-up, shutdown, port allocation, and health checking are reliable across repeated cycles.

## Key seams (from codebase exploration)
- `src/mcp/lifecycle.ts` :: `serveMcp`, `stopMcp`, `restartMcp`, `getMcpStatus`
- `src/mcp/ports.ts` :: `getFreePort`, `isPortAvailable`
- `src/mcp/runtime-metadata.ts` :: `read/writeMcpRuntimeMetadata`, lock file staleness
- `src/mcp/launchd.ts` :: macOS service wrapper (skip in unit tests; test portable path)
- Bundle startup :: `spawn(bun, [server.mjs], { detached: true })` in `lifecycle.ts`

## Recommended approach
1. Create `src/mcp/lifecycle-stress.test.ts` using temp `PRISM_HOME`.
2. Use a minimal generated `server.mjs` fixture that exposes `/healthz` and `/mcp`.
3. Test:
   - `serveMcp` starts a daemon, `getMcpStatus` reports `running`, health pid matches.
   - `stopMcp` terminates the daemon, status reports `stopped`, no orphan `bun` process remains.
   - `restartMcp` stops old and starts new with a new server hash.
   - 50 sequential `serve/stop` cycles without port or process leaks.
   - Stale lock file with dead pid is overwritten.
   - Port conflict when explicit port is occupied fails closed with a typed error.
4. Assert process absence by polling `process.kill(pid, 0)`.
5. Keep tests portable; mock launchd path.

## Risks
- `getFreePort` race: port can be taken between allocation and bind. Test must tolerate reallocation.
- No SIGKILL fallback: a SIGTERM-ignoring daemon will leak. Document as known limitation.
- macOS launchd tests require real `~/.prism`; keep unit tests off launchd.

## Verdict
Proceed. This is the highest-leverage test for the brittleness the operator reported.
