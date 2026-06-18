/**
 * PrismHome — the Effect service carrying the resolved Prism home directory
 * (docs/overhaul-one-writer-plan.md, WS2).
 *
 * The env read (`PRISM_HOME`, falling back to ~/.prism) happens exactly once,
 * at the CLI edge, when `PrismHomeLive` is built into the runtime. Library
 * code never falls back to the environment: new code (WS3+ snapshot store,
 * sync engine, MCP supervisor) consumes the `PrismHome` tag, so tests are
 * structurally unable to touch real state — they provide `PrismHomeTest`.
 *
 * Do not add `resolvePrismHome()` default-argument fallbacks to new modules;
 * thread this service instead.
 */

import { Context, Effect, Layer } from "effect";
import { resolvePrismHome } from "../prism-home.js";
import type { HarnessId } from "../types.js";

export interface PrismEnv {
  /** Absolute path of the Prism home directory. */
  readonly home: string;
}

export class PrismHome extends Context.Tag("prism/PrismHome")<PrismHome, PrismEnv>() {}

/**
 * Live layer for the CLI edge. Reads the environment once when the layer is
 * built; everything downstream sees one immutable value.
 */
export const PrismHomeLive: Layer.Layer<PrismHome> = Layer.effect(
  PrismHome,
  Effect.sync(() => ({ home: resolvePrismHome() })),
);

/** In-memory layer for tests — no env read, no disk. */
export const PrismHomeTest = (home: string): Layer.Layer<PrismHome> =>
  Layer.succeed(PrismHome, { home });

/**
 * HarnessRoots — the Effect service carrying the resolved base directory for
 * each harness global root. Production resolves via the harness registry's
 * globalConfigPath; tests provide a map of harness IDs to temp directories so
 * refresh/compile/doctor never touch real harness configs.
 */
export interface HarnessRootsEnv {
  /** Resolve the global root directory for a harness. */
  readonly resolve: (harnessId: HarnessId) => string;
}

export class HarnessRoots extends Context.Tag("prism/HarnessRoots")<
  HarnessRoots,
  HarnessRootsEnv
>() {}

/** In-memory layer for tests — maps harnesses to caller-supplied roots. */
export const HarnessRootsTest = (
  roots: Partial<Record<HarnessId, string>>,
): Layer.Layer<HarnessRoots> =>
  Layer.succeed(HarnessRoots, {
    resolve: (harnessId) => {
      const root = roots[harnessId];
      if (root === undefined) {
        throw new Error(`HarnessRootsTest: no root configured for ${harnessId}`);
      }
      return root;
    },
  });
