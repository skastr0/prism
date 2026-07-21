import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolve the Prism home directory every durable runtime-root path in
 * `prism-sdk` (registry files, compiled bundles, daemon logs) is derived
 * from. UDS socket identity includes this value, but an overlong literal
 * path falls back to a fixed-width per-user temporary namespace.
 *
 * Mirrors `resolvePrismHome()` in the root package's `src/prism-home.ts`
 * (this package cannot import that module -- `packages/prism-sdk` has no
 * dependency on the root `src/` tree, see `udsPathFor`'s doc comment) so a
 * caller relying on either resolver observes the same path for the same
 * inputs:
 *
 *   1. an explicit `override` (threaded by the caller), else
 *   2. `PRISM_HOME` from the environment, else
 *   3. `~/.prism` (the default when neither is set).
 *
 * This is a *safety net*, not the primary threading mechanism -- production
 * call sites should still thread an explicit `prismHome` end to end (see
 * `ShimAggregatorOptions.prismHome`, `ResolveOrSpawnOptions.prismHome`,
 * `McpLifecycleCommonOptions.prismHome`). Reading `PRISM_HOME` here as a
 * fallback means a call site that forgets to thread it through still lands
 * in whatever sandbox a test's `PRISM_HOME` override intends, instead of
 * silently falling through to the real invoking machine's home directory --
 * which is exactly the gap that let `uds-registry.test.ts`'s unsandboxed
 * `beforeEach`/`afterEach` delete the real `~/.prism/runtime/mcp`.
 */
export function resolvePrismHomeForSdk(override?: string): string {
  const configured = override ?? process.env.PRISM_HOME;
  if (configured && configured.trim().length > 0) {
    if (configured === "~") return homedir();
    if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
    return resolve(configured);
  }
  return join(homedir(), ".prism");
}
