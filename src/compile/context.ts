/**
 * CompileContext service.
 *
 * Carries per-invocation state threaded through the compile pipeline:
 *   - target          : the harness id being compiled for
 *   - pluginPath      : the plugin directory being compiled
 *   - registry        : the plugin's loaded registry (filled in during Load)
 *
 * Used as an Effect Context so per-target logic can read this without
 * plumbing parameters through every function.
 */

import { Context, Effect, Ref } from "effect";
import { emptyRegistry, type PluginRegistry } from "./registry.js";

export class CompileContext extends Context.Tag("prism/CompileContext")<
  CompileContext,
  {
    readonly target: string;
    readonly pluginPath: string;
    readonly registry: Ref.Ref<PluginRegistry>;
  }
>() {}

export const makeCompileContext = (params: {
  target: string;
  pluginPath: string;
}) =>
  Effect.gen(function* () {
    const registry = yield* Ref.make(emptyRegistry(params.pluginPath, "", ""));
    return CompileContext.of({
      target: params.target,
      pluginPath: params.pluginPath,
      registry,
    });
  });
