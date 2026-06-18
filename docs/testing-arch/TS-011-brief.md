# Architecture Brief: TS-011 Native plugin registration and load tests

## Goal
Prove that generated native plugins for OpenCode, Amp Code, and Pi are registered correctly and can be loaded by their harnesses.

## Key seams
- OpenCode :: `src/compile/lowerers/opencode.ts` patches `opencode.json` `plugin` array with file URL to `plugins/prism-generated-<plugin>/dist/server.mjs`
- Amp Code :: `src/compile/lowerers/amp-code.ts` emits `<amp-root>/plugins/prism-generated-<plugin>.ts`; Amp auto-discovers `.ts` files
- Pi :: `src/compile/lowerers/pi.ts` emits package dir and patches `settings.json` `packages` array
- Shared IDs :: `src/compile/generated-plugin.ts`

## Recommended approach
1. Create `src/compile/native-plugin-load.test.ts`.
2. OpenCode:
   - Compile fixture, apply sync plan to temp opencode root.
   - Read `opencode.json`; assert plugin array contains the file URL and no duplicates.
   - Import the generated `server.mjs` and assert it exports a valid plugin module shape.
3. Amp Code:
   - Compile fixture to temp amp root.
   - Assert `plugins/prism-generated-<plugin>.ts` exists and TypeScript-checks syntactically.
   - Import it with a mock `amp` object and assert `registerCommand`/`registerTool`/`amp.on` are called.
4. Pi:
   - Compile fixture, apply sync plan to temp pi root.
   - Read `settings.json`; assert `packages` array contains `./packages/prism-generated-<plugin>`.
   - Import generated `extensions/prism-extension.js` with mock `pi` and assert registrations.
5. Test re-run idempotency and removal (plugin ID disappears after plugin removed).

## Risks
- Amp/Pi plugin APIs may not be fully documented; mock objects may drift.
- Pi extension is CommonJS-ish; import may need `createRequire`.

## Verdict
Proceed. Essential for native-plugin stability.
