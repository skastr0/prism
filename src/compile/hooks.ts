import { Effect } from "effect";
import type { Hook, NormalizedHookToolMatcher } from "./sources.js";
import { SourceParseError, UnknownDependencyError, type CompileError } from "./errors.js";
import type { PluginRegistry } from "./registry.js";

interface ParsedNamedRef {
  readonly pluginPrefix: string | undefined;
  readonly name: string;
}

interface ParsedSpaceItemRef {
  readonly pluginPrefix: string | undefined;
  readonly space: string;
  readonly name: string;
}

export type ResolvedHookToolMatcher =
  | { readonly kind: "any" }
  | { readonly kind: "native-tools"; readonly names: ReadonlyArray<string> }
  | { readonly kind: "canonical-tool"; readonly ref: string };

export interface ResolvedHookMatch {
  readonly tool?: ResolvedHookToolMatcher;
}

const parseNamedRef = (ref: string): ParsedNamedRef => {
  const colon = ref.indexOf(":");
  if (colon === -1) return { pluginPrefix: undefined, name: ref };
  return {
    pluginPrefix: ref.slice(0, colon),
    name: ref.slice(colon + 1),
  };
};

const parseSpaceItemRef = (
  ref: string,
  separator: "/" | "#",
): ParsedSpaceItemRef | undefined => {
  const parsed = parseNamedRef(ref);
  const split = parsed.name.indexOf(separator);
  if (split === -1) return undefined;
  const space = parsed.name.slice(0, split);
  const name = parsed.name.slice(split + 1);
  if (!space || !name) return undefined;
  return { pluginPrefix: parsed.pluginPrefix, space, name };
};

const resolveRefToRegistry = (
  ref: string,
  registry: PluginRegistry,
  sourcePath: string,
): Effect.Effect<PluginRegistry, CompileError> =>
  Effect.gen(function* () {
    const parsed = parseNamedRef(ref);
    if (!parsed.pluginPrefix) return registry;
    const dep = registry.deps.get(parsed.pluginPrefix);
    if (!dep) {
      return yield* Effect.fail(
        new UnknownDependencyError({
          sourcePath,
          referenceName: ref,
          depPrefix: parsed.pluginPrefix,
          declaredDeps: [...registry.deps.keys()],
        }),
      );
    }
    return dep;
  });

const hookParseError = (
  hook: Hook,
  field: string,
  message: string,
): SourceParseError =>
  new SourceParseError({
    sourcePath: hook.sourcePath,
    kind: "hook",
    message: `${field}: ${message}`,
  });

const resolveToolRefForTarget = (
  hook: Hook,
  field: string,
  toolRef: string,
  registry: PluginRegistry,
  target: string,
  currentRegistry: PluginRegistry = registry,
): Effect.Effect<string, CompileError> =>
  Effect.gen(function* () {
    const parsed = parseSpaceItemRef(toolRef, "/");
    if (!parsed) {
      return yield* Effect.fail(hookParseError(hook, field, `invalid tool ref '${toolRef}'`));
    }

    const reg = yield* resolveRefToRegistry(toolRef, currentRegistry, hook.sourcePath);
    const toolspace = reg.toolspaces.get(parsed.space);
    const tool = toolspace?.tools[parsed.name];
    if (!tool) {
      return yield* Effect.fail(hookParseError(hook, field, `references unknown tool '${toolRef}'`));
    }

    const nativeName = tool.targets[target];
    if (!nativeName) {
      return yield* Effect.fail(
        hookParseError(
          hook,
          field,
          `tool '${toolRef}' has no '${target}' target binding`,
        ),
      );
    }

    return nativeName;
  });

const resolveToolGroupRefForTarget = (
  hook: Hook,
  field: string,
  groupRef: string,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ReadonlyArray<string>, CompileError> =>
  Effect.gen(function* () {
    const parsed = parseSpaceItemRef(groupRef, "#");
    if (!parsed) {
      return yield* Effect.fail(hookParseError(hook, field, `invalid tool group ref '${groupRef}'`));
    }

    const reg = yield* resolveRefToRegistry(groupRef, registry, hook.sourcePath);
    const toolspace = reg.toolspaces.get(parsed.space);
    const group = toolspace?.groups[parsed.name];
    if (!group) {
      return yield* Effect.fail(
        hookParseError(hook, field, `references unknown tool group '${groupRef}'`),
      );
    }

    const nativeNames = new Set<string>();
    for (const nestedToolRef of group.tools) {
      nativeNames.add(
        yield* resolveToolRefForTarget(
          hook,
          `${field}.tools`,
          nestedToolRef,
          registry,
          target,
          reg,
        ),
      );
    }

    return [...nativeNames].sort((left, right) => left.localeCompare(right));
  });

export const resolveHookToolMatcherForTarget = (
  hook: Hook,
  matcher: NormalizedHookToolMatcher,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ResolvedHookToolMatcher, CompileError> =>
  Effect.gen(function* () {
    switch (matcher.kind) {
      case "any":
        return { kind: "any" };
      case "toolspace-tool":
        return {
          kind: "native-tools",
          names: [yield* resolveToolRefForTarget(hook, "match.tool", matcher.ref, registry, target)],
        };
      case "toolspace-group":
        return {
          kind: "native-tools",
          names: yield* resolveToolGroupRefForTarget(
            hook,
            "match.tool",
            matcher.ref,
            registry,
            target,
          ),
        };
      case "canonical-tool":
        return { kind: "canonical-tool", ref: matcher.ref };
    }
  });

export const resolveHookMatchForTarget = (
  hook: Hook,
  registry: PluginRegistry,
  target: string,
): Effect.Effect<ResolvedHookMatch, CompileError> =>
  Effect.gen(function* () {
    if (!hook.match.tool) return {};
    return {
      tool: yield* resolveHookToolMatcherForTarget(hook, hook.match.tool, registry, target),
    };
  });
