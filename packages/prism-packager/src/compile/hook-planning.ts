import { Effect } from "effect";
import type { HarnessId } from "../types.js";
import { SourceParseError, type CompileError } from "./errors.js";
import type { Hook, HookEvent } from "./sources.js";
import { HOOK_CAPABILITIES, type HookControl } from "./hook-capabilities.js";

export interface HookFidelityEntry {
  readonly hook: string;
  readonly event: HookEvent;
  readonly target: HarnessId;
  readonly outcome: "native" | "degraded" | "skipped" | "failed";
  readonly nativeEvent?: string;
  readonly droppedControls?: ReadonlyArray<HookControl>;
  readonly notes: ReadonlyArray<string>;
}

const PORTABLE_CONTROLS: Record<HookEvent, ReadonlyArray<HookControl>> = {
  "tool.before": ["block", "updatedInput", "systemMessage", "additionalContext"],
  "tool.after": ["updatedOutput", "systemMessage", "additionalContext"],
  "prompt.submit": ["block", "systemMessage", "additionalContext"],
  "permission.request": ["block", "ask", "updatedInput", "systemMessage", "additionalContext"],
  "session.start": [],
  "session.end": [],
  "tool.failure": ["systemMessage", "additionalContext"],
  "stop": ["block", "systemMessage"],
  "subagent.start": ["systemMessage", "additionalContext"],
  "subagent.stop": ["block", "systemMessage", "additionalContext"],
  "compact.before": ["block", "systemMessage", "additionalContext"],
  "compact.after": ["systemMessage", "additionalContext"],
  "notification": ["systemMessage"],
};

const getDroppedControls = (
  event: HookEvent,
  supportedControls: ReadonlyArray<HookControl> | undefined,
): ReadonlyArray<HookControl> => {
  const portable = PORTABLE_CONTROLS[event] ?? [];
  if (!supportedControls) {
    return portable;
  }
  return portable.filter((c) => !supportedControls.includes(c));
};

export const planHooksForTarget = (
  hooks: ReadonlyArray<Hook>,
  target: HarnessId,
): Effect.Effect<
  {
    readonly accepted: ReadonlyArray<Hook>;
    readonly fidelity: ReadonlyArray<HookFidelityEntry>;
  },
  CompileError
> => {
  const accepted: Hook[] = [];
  const fidelity: HookFidelityEntry[] = [];

  for (const hook of hooks) {
    const support = HOOK_CAPABILITIES[target]?.[hook.event] ?? { kind: "unsupported" };
    const policy = hook.onDegraded ?? "degrade";

    if (support.kind === "unsupported") {
      if (policy === "fail") {
        return Effect.fail(
          new SourceParseError({
            sourcePath: hook.sourcePath,
            kind: "hook",
            message: `Hook '${hook.name}' (event '${hook.event}') is unsupported on target '${target}'`,
          }),
        );
      }
      fidelity.push({
        hook: hook.name,
        event: hook.event,
        target,
        outcome: "skipped",
        notes: support.note ? [support.note] : [],
      });
      continue;
    }

    const dropped = getDroppedControls(hook.event, support.controls);
    const isDegraded = support.kind === "degraded" || dropped.length > 0;

    if (!isDegraded) {
      fidelity.push({
        hook: hook.name,
        event: hook.event,
        target,
        outcome: "native",
        nativeEvent: support.nativeEvent,
        notes: support.note ? [support.note] : [],
      });
      accepted.push(hook);
    } else {
      if (policy === "fail") {
        return Effect.fail(
          new SourceParseError({
            sourcePath: hook.sourcePath,
            kind: "hook",
            message: `Hook '${hook.name}' (event '${hook.event}') on target '${target}' dropped controls [${dropped.join(", ")}] but policy is fail`,
          }),
        );
      } else if (policy === "degrade") {
        fidelity.push({
          hook: hook.name,
          event: hook.event,
          target,
          outcome: "degraded",
          nativeEvent: support.nativeEvent,
          droppedControls: dropped,
          notes: support.note ? [support.note] : [],
        });
        accepted.push(hook);
      } else {
        fidelity.push({
          hook: hook.name,
          event: hook.event,
          target,
          outcome: "skipped",
          nativeEvent: support.nativeEvent,
          notes: support.note ? [support.note] : [],
        });
      }
    }
  }

  return Effect.succeed({ accepted, fidelity });
};
