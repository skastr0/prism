import { Effect } from "effect";
import type { Hook, NormalizedHookToolMatcher } from "./sources.js";
import type { CompileError } from "./errors.js";
import type { PluginRegistry } from "./registry.js";

export type ResolvedHookToolMatcher =
  | { readonly kind: "any" }
  | { readonly kind: "native-tools"; readonly names: ReadonlyArray<string> }
  | { readonly kind: "canonical-tool"; readonly ref: string };

export interface ResolvedHookMatch {
  readonly tool?: ResolvedHookToolMatcher;
}

export const resolveHookToolMatcher = (
  matcher: NormalizedHookToolMatcher,
): ResolvedHookToolMatcher => {
  switch (matcher.kind) {
    case "any":
      return { kind: "any" };
    case "native-tool":
      return { kind: "native-tools", names: [matcher.name] };
    case "canonical-tool":
      return { kind: "canonical-tool", ref: matcher.ref };
  }
};

export const resolveHookMatchForTarget = (
  hook: Hook,
  _registry: PluginRegistry,
  _target: string,
): Effect.Effect<ResolvedHookMatch, CompileError> =>
  Effect.succeed(hook.match.tool ? { tool: resolveHookToolMatcher(hook.match.tool) } : {});
