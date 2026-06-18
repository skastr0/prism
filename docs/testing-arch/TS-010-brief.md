# Architecture Brief: TS-010 Generated canonical tool execution matrix

## Goal
Prove that generated canonical tools actually execute across harness targets and that cross-plugin owner/consumer bindings route correctly.

## Key seams
- `src/compile/mcp-runtime-path.ts` :: `prismMcpServerPath`, `writePrismMcpServerBundle`
- `src/compile/pipeline.ts` :: emits bundle and calls `serveMcp` when `--mcp-lifecycle serve`
- `src/compile/mcp-runtime.ts` :: `resolveOwnerMcpRuntime`
- `src/compile/lowerers/opencode.ts`, `cursor.ts`, `hermes.ts` :: consumer config emission

## Recommended approach
1. Create `src/compile/generated-tool-execution.test.ts`.
2. For each target in [opencode, cursor, hermes, antigravity-cli]:
   - Compile a tools-only fixture (or use `createGoldenCompileFixture`) targeting the harness.
   - Start the emitted MCP bundle (use helpers from `src/compile/test-helpers/mcp-http-roundtrip.ts`).
   - Send `initialize` → `tools/list` → `tools/call`.
   - Assert tool names are correctly scoped and the call returns expected output.
3. Add a cross-plugin case:
   - Owner plugin defines a canonical tool.
   - Consumer plugin agent binds it.
   - Compile consumer for opencode; verify consumer config references owner runtime.
   - Start owner bundle and call the tool via owner endpoint with consumer-bound slot values.
4. Assert typed JSON-RPC errors for invalid input.

## Risks
- Hermes/Cursor require config patches; use `prism-sandbox.ts` to isolate.
- Cross-plugin runtime resolution depends on owner compile happening first; test must compile both.

## Verdict
Proceed. Second-highest leverage after lifecycle tests.
