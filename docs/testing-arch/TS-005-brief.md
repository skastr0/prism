# Architecture Second-Opinion Brief: TS-005

## Core design questions

TS-005 asks for MCP bundle round-trip tests, but the existing test landscape already covers most of the checklist in `src/compile/mcp-bundle.test.ts`: bundle generation, spawning a Streamable HTTP server, `tools/list`, `tools/call`, SDK client round-trip, enum-vs-const schema compatibility, concurrency limits, timeouts, and session/request caps. Acceptance gates `scripts/acceptance/mcp-lifecycle.ts` and `scripts/acceptance/mcp-determinism.ts` add daemon lifecycle and cross-compile determinism. The real architectural question, therefore, is not whether to write more end-to-end tests, but where the remaining seam is mis-layered:

1. Does a round-trip that starts at `generateMcpServerBundle` (direct function call) actually exercise the pipeline path that lowerers and harnesses depend on?
2. Is the const→enum bug truly prevented by current tests, or only by tests that bypass the canonical `PRISM_HOME/runtime/mcp/<plugin>/server.mjs` write path?
3. Should additional coverage live in unit tests, acceptance scripts, or a shared helper layer?

## Recommended approach

The gap is a **pipeline seam**: `mcp-bundle.test.ts` calls `generateMcpServerBundle` directly and writes the bundle to ad-hoc temp paths, while `pipeline.test.ts` verifies only static contents of the union bundle after `compilePluginForTarget`. Neither file proves that the bundle emitted by the pipeline into `prismMcpServerPath(prismHome, pluginName)` can be spawned and spoken to over MCP.

Recommended steps:

1. **Extract shared round-trip helpers** from `mcp-bundle.test.ts` into a new `src/compile/test-helpers/mcp-http-roundtrip.ts` containing:
   - `waitForHttpServer(port)`
   - `httpRpc({ port, sessionId, method, params })`
   - `roundTripCompiledBundle({ serverPath, port })` → initialize → tools/list → tools/call → assert structured content
   - `assertSchemaNoConst(schemas)` to enforce enum-only literals

2. **Add one integration test in `src/compile/pipeline.test.ts`** that:
   - Runs `compilePluginForTarget` for a tools-only fixture targeting a harness that uses MCP (e.g., `hermes` or `codex-cli`)
   - Reads the bundle from `prismMcpServerPath(prismHome, pluginName)`
   - Spawns it and calls `tools/list` and `tools/call`
   - Asserts response shape and schema compatibility (no `"const":`, literals as `"enum"`)

3. **Keep acceptance gates focused**: `mcp-lifecycle.ts` should remain a daemon-lifecycle gate; add at most a single post-healthz `tools/list` smoke if desired, but do not duplicate the full matrix.

## Risks and failure modes

- **const→enum regression** is caught today only by direct `generateMcpServerBundle` tests, not after the pipeline write. A pipeline-level round-trip closes this.
- **Schema-bridge drift from MCP emitter**: `schema-bridge.test.ts` validates Zod arg shapes at compile time, but no test compares those shapes against the JSON Schema served over MCP wire.
- **Pipeline writes stale/wrong bundle path**: `pipeline.test.ts` and `mcp-determinism.ts` check placement and byte identity, but not runtime behavior.
- **Exposure-profile filtering** (Grok/Cursor `X-Prism-Mcp-Exposure`) is patched in `pipeline.test.ts` but never validated at the protocol layer.
- **Lowerer tool names diverge from bundle `tools/list` names**: Kimi naming is asserted statically in lowerer tests, not against a live server.
- **Fixture sprawl**: four different inline minimal plugins exist for the same MCP story across `mcp-bundle.test.ts`, `mcp/lifecycle.test.ts`, `pipeline.test.ts`, and `test-fixtures.ts`.

## Dependencies on other TS glyphs

- **Daemon lifecycle glyphs** (`mcp/lifecycle.test.ts`, acceptance): round-trip tests should not re-test restart semantics.
- **Harness HTTP lowering glyphs** (Hermes/Codex/Kimi config rendering): round-trip should validate only the canonical union bundle, not per-harness config text.
- **Exposure-header glyphs** (Grok deny-by-default): need a protocol-level test once exposure logic is stable.
- **Kimi plugin MCP glyphs**: lowerer tests own Kimi naming; round-trip proves server schemas, not Kimi CLI behavior.

## Concrete first file or function to create/modify

**Create `src/compile/test-helpers/mcp-http-roundtrip.ts`** by extracting reusable helpers from `mcp-bundle.test.ts`. Then **add one test in `src/compile/pipeline.test.ts`** that reads the emitted bundle from `prismMcpServerPath` and runs the round-trip.

**Boundaries not to cross:**
- No `prism refresh` CLI subprocess in unit tests (leave to acceptance).
- No daemon restart or `prism mcp serve` lifecycle tests (leave to `mcp/lifecycle.test.ts`).
- No harness root config assertions beyond what `pipeline.test.ts` already does.
- No `~/Projects/prism-plugins` corpus or Kimi/OpenCode runtime imports in unit tests.
