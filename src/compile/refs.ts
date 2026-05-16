import { Effect } from "effect";
import { UnknownDependencyError, type CompileError } from "./errors.js";
import type { PluginRegistry } from "./registry.js";

export interface ParsedNamedRef {
  readonly pluginPrefix: string | undefined;
  readonly name: string;
}

export interface ParsedSpaceItemRef {
  readonly pluginPrefix: string | undefined;
  readonly space: string;
  readonly name: string;
}

export const parseNamedRef = (ref: string): ParsedNamedRef => {
  const colon = ref.indexOf(":");
  if (colon === -1) return { pluginPrefix: undefined, name: ref };
  return {
    pluginPrefix: ref.slice(0, colon),
    name: ref.slice(colon + 1),
  };
};

export const parseSpaceItemRef = (
  ref: string,
  separator: "/" | "#",
): ParsedSpaceItemRef | undefined => {
  const parsed = parseNamedRef(ref);
  const split = parsed.name.indexOf(separator);
  if (split === -1) return undefined;
  const space = parsed.name.slice(0, split);
  const name = parsed.name.slice(split + 1);
  if (space.length === 0 || name.length === 0) return undefined;
  return { pluginPrefix: parsed.pluginPrefix, space, name };
};

export const registryForRef = (
  ref: string,
  registry: PluginRegistry,
): PluginRegistry | undefined => {
  const parsed = parseNamedRef(ref);
  if (!parsed.pluginPrefix) return registry;
  return registry.deps.get(parsed.pluginPrefix);
};

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
