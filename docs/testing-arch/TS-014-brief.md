# Architecture Brief: TS-014 Cross-plugin canonical tool ownership runtime tests

## Goal
Prove the runtime contract between owner and consumer plugins for canonical tools: consumer bindings route to owner runtime, bound fields are injected, and owner removal is detected.

## Key seams
- `src/compile/protocol-tools.ts` :: `permissionBinding` records `toolPluginName`
- `src/compile/tool-bindings.ts` :: `groupBindingsByOwner`, `allReferencedBindingsByOwner`
- `src/compile/mcp-runtime.ts` :: `resolveOwnerMcpRuntime`
- `src/compile/pipeline.ts` :: `assertAgentToolBindingsAreTargeted`
- `src/compile/resolve.ts` :: `resolveOrbitToolPermissions` (note: `bind` field currently unsupported)

## Recommended approach
1. Create `src/compile/cross-plugin-tool-runtime.test.ts`.
2. Test `assertAgentToolBindingsAreTargeted`:
   - Owner targets harness → compile succeeds.
   - Owner does not target harness → compile fails with clear error.
3. Test owner runtime resolution:
   - `resolveOwnerMcpRuntime` returns port/url from `runtime.json` when daemon running.
   - Falls back to static plugin.json runtime config when no runtime.json.
   - Returns error when neither exists.
4. Test cross-plugin call round-trip:
   - Owner plugin tool increments a counter.
   - Consumer agent binds it; compile consumer for opencode.
   - Start owner MCP bundle.
   - Call tool through owner endpoint with consumer's scoped name; assert correct output.
5. Test orbit tool permissions:
   - If `bind` is still unsupported, assert compile rejects `bind` with clear error.
   - Otherwise, assert bound fields are injected and hidden from agent schema.

## Risks
- Orbit `bind` support may require implementation; scope tests to current behavior.
- Cross-plugin compile requires two plugin directories and a registry.

## Verdict
Proceed. This is the core of the generated-tools brittleness.
