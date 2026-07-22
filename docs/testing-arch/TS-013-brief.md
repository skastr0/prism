# Architecture Brief: TS-013 MCP HTTP connection resilience tests

## Goal
Harden HTTP transport between harness clients and generated MCP servers against transient failures, timeouts, and reconnects.

## Key seams
- `src/compile/tool-runtime-bundle.ts` :: generated server uses `@modelcontextprotocol/sdk/server/streamable-http`
- `src/mcp/lifecycle.ts` :: `fetchHealth`, HTTP client calls
- The generated bundle's SSE/HTTP request handling

## Recommended approach
1. Create `src/compile/mcp-resilience.test.ts`.
2. Start a generated MCP server using the bundle and helpers from `mcp-http-roundtrip.ts`.
3. Test:
   - Client retries on transient 5xx via an injected fault proxy or by restarting server.
   - Configurable timeout surfaces typed error, not hang.
   - Pipelined initialize/tools/list/call does not corrupt SSE stream state.
   - Reconnect after server restart reuses port and resumes session.
4. If the current client does not implement retries/timeouts, add minimal retry wrapper in `src/mcp/http-client.ts` (new file) and test that.

## Risks
- SDK may handle retries internally; tests must observe actual behavior, not assume.
- Fault injection may require a proxy; keep it simple.

## Verdict
Proceed after TS-009/TS-010; lower priority than lifecycle and execution.
