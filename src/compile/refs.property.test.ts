/**
 * Property tests for reference resolution (src/compile/refs.ts).
 *
 * Covered properties:
 *  - Bare refs (no prefix) resolve to the current registry.
 *  - Prefixed refs route through registry.deps to the correct dependency.
 *  - Unknown prefixes fail closed with UnknownDependencyError.
 */

import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import fc from "fast-check";
import { resolveRefToRegistry } from "./refs.js";
import { UnknownDependencyError } from "./errors.js";
import { arbitraryIdentifier, arbitraryRegistry, propertyTestConfig } from "./testing/registry-fixtures.js";
import type { PluginRegistry } from "./registry.js";

const runResolvedRegistry = (ref: string, registry: PluginRegistry, sourcePath = "/tmp/src.ts") => {
  const effect = resolveRefToRegistry(ref, registry, sourcePath);
  const exit = Effect.runSyncExit(effect);
  if (exit._tag === "Failure") {
    throw Cause.squash(exit.cause);
  }
  return exit.value;
};

const expectUnknownDependencyError = (ref: string, registry: PluginRegistry) => {
  const effect = resolveRefToRegistry(ref, registry, "/tmp/src.ts");
  const exit = Effect.runSyncExit(effect);
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;
  const error = Cause.squash(exit.cause);
  expect(error).toBeInstanceOf(UnknownDependencyError);
};

describe("resolveRefToRegistry properties", () => {
  const config = propertyTestConfig();

  test("bare refs always resolve to the current registry", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbitraryIdentifier(), arbitraryRegistry({ maxDepth: 2 })),
        ([ref, registry]) => {
          const resolved = runResolvedRegistry(ref, registry);
          expect(resolved.pluginName).toBe(registry.pluginName);
          expect(resolved.pluginPath).toBe(registry.pluginPath);
        },
      ),
      config,
    );
  });

  test("prefixed refs route through registry.deps", () => {
    fc.assert(
      fc.property(
        arbitraryRegistry({ maxDepth: 2, maxDeps: 3 }).chain((registry) => {
          const aliases = [...registry.deps.keys()];
          if (aliases.length === 0) return fc.constant({ registry, alias: "" });
          return fc.record({
            registry: fc.constant(registry),
            alias: fc.constantFrom(...aliases),
          });
        }),
        ({ registry, alias }) => {
          fc.pre(alias.length > 0);
          const dep = registry.deps.get(alias)!;
          const resolved = runResolvedRegistry(`${alias}:some-name`, registry);
          expect(resolved.pluginName).toBe(dep.pluginName);
          expect(resolved.pluginPath).toBe(dep.pluginPath);
        },
      ),
      config,
    );
  });

  test("unknown prefixes fail closed with UnknownDependencyError", () => {
    fc.assert(
      fc.property(
        arbitraryRegistry({ maxDepth: 2, maxDeps: 3 }).chain((registry) => {
          const declared = new Set(registry.deps.keys());
          return arbitraryIdentifier({ minLength: 1 }).filter((p) => !declared.has(p) && !p.includes(":")).map((prefix) => ({
            registry,
            prefix,
          }));
        }),
        ({ registry, prefix }) => {
          expectUnknownDependencyError(`${prefix}:some-name`, registry);
        },
      ),
      config,
    );
  });
});
