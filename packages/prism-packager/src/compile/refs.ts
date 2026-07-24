import { Effect } from "effect";
import {
  parseNamedRef,
  parseSpaceItemRef,
  registryForRef,
} from "@skastr0/prism-sdk/refs";
import { UnknownDependencyError, type CompileError } from "./errors.js";
import type { PluginRegistry } from "./registry.js";

export { parseNamedRef, parseSpaceItemRef, registryForRef };
export type { ParsedNamedRef, ParsedSpaceItemRef } from "@skastr0/prism-sdk/refs";

export const resolveRefToRegistry = (
  ref: string,
  currentRegistry: PluginRegistry,
  sourcePath: string,
): Effect.Effect<PluginRegistry, CompileError> =>
  Effect.gen(function* () {
    const parsed = parseNamedRef(ref);
    if (!parsed.pluginPrefix) return currentRegistry;
    const dep = currentRegistry.deps.get(parsed.pluginPrefix);
    if (!dep) {
      return yield* Effect.fail(
        new UnknownDependencyError({
          sourcePath,
          referenceName: ref,
          depPrefix: parsed.pluginPrefix,
          declaredDeps: [...currentRegistry.deps.keys()],
        }),
      );
    }
    return dep;
  });
