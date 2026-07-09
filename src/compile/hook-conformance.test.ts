import { expect, test, describe } from "bun:test";
import { Effect } from "effect";
import { getAllHarnessIds } from "../harnesses.js";
import { HOOK_CAPABILITIES, type HookControl } from "./hook-capabilities.js";
import { planHooksForTarget } from "./hook-planning.js";
import { HookEventSchema, type HookEvent, Hook } from "./sources.js";
import { hookEvent as publicHookEvent, type HookDefinition } from "../index.js";
import type { HarnessId } from "../types.js";

// The portable control set each event's result grammar offers — mirrors
// PORTABLE_CONTROLS in hook-planning.ts. Kept here independently so this test
// fails if the two drift (a control added to the grammar but not the planner,
// or vice versa, would surface as a conformance mismatch).
const PORTABLE_CONTROLS: Record<HookEvent, ReadonlyArray<HookControl>> = {
  "tool.before": ["block", "updatedInput", "systemMessage", "additionalContext"],
  "tool.after": ["updatedOutput", "systemMessage", "additionalContext"],
  "prompt.submit": ["block", "systemMessage", "additionalContext"],
  "permission.request": ["block", "ask", "updatedInput", "systemMessage", "additionalContext"],
  "session.start": [],
  "session.end": [],
  "tool.failure": ["systemMessage", "additionalContext"],
  stop: ["block", "systemMessage"],
  "subagent.start": ["systemMessage", "additionalContext"],
  "subagent.stop": ["block", "systemMessage", "additionalContext"],
  "compact.before": ["block", "systemMessage", "additionalContext"],
  "compact.after": ["systemMessage", "additionalContext"],
  notification: ["systemMessage"],
};

const ALL_EVENTS: HookEvent[] = (() => {
  const ast = HookEventSchema.ast;
  if (ast._tag !== "Union") throw new Error("expected a union of literals");
  return ast.types.map((t) => {
    if (t._tag !== "Literal") throw new Error("expected literal");
    return t.literal as HookEvent;
  });
})();

const makeHook = (event: HookEvent, onDegraded?: "fail" | "degrade" | "skip"): Hook =>
  new Hook({
    name: `hook-${event.replace(/\./g, "-")}`,
    sourcePath: `<conformance>/${event}.hook.ts`,
    event,
    targets: [],
    match: {},
    handle: () => Effect.succeed({ decision: "continue" as const }),
    ...(onDegraded ? { onDegraded } : {}),
  });

const droppedControls = (event: HookEvent, supported: ReadonlyArray<HookControl>): HookControl[] =>
  PORTABLE_CONTROLS[event].filter((c) => !supported.includes(c));

// Type-level guard: the public authoring surface must accept every event,
// including T2. If a T2 event were missing from index.ts's hookEvent/types,
// this would fail to compile (bun runs it; tsc gates it in CI).
const _t2AuthoringCompiles: HookDefinition = {
  name: "guard-stop",
  event: publicHookEvent.stop,
  handle: () => Effect.succeed({ decision: "block" as const, message: "keep going" }),
};
void _t2AuthoringCompiles;

describe("public hook authoring surface (src/index.ts) matches the schema", () => {
  test("hookEvent exposes every portable event, T2 included", () => {
    const schemaEvents = new Set<string>(
      (HookEventSchema.ast._tag === "Union" ? HookEventSchema.ast.types : []).map((t) =>
        t._tag === "Literal" ? String(t.literal) : "",
      ),
    );
    const publicValues = new Set<string>(Object.values(publicHookEvent));
    for (const e of schemaEvents) {
      expect(publicValues.has(e), `public hookEvent is missing '${e}'`).toBe(true);
    }
    expect(publicValues).toEqual(schemaEvents);
  });
});

describe("hook conformance — capability table is complete and consistent with the planner", () => {
  test("every harness × event resolves to a plan outcome that matches its capability kind", () => {
    const failures: string[] = [];
    const hooks = ALL_EVENTS.map((e) => makeHook(e));

    for (const harness of getAllHarnessIds()) {
      const caps = HOOK_CAPABILITIES[harness];
      const plan = Effect.runSync(planHooksForTarget(hooks, harness));
      const outcomeByEvent = new Map(
        plan.fidelity.map((f) => [f.event, f]),
      );
      const acceptedEvents = new Set(plan.accepted.map((h) => h.event));

      for (const event of ALL_EVENTS) {
        const support = caps[event];
        if (support === undefined) {
          failures.push(`${harness} ${event}: MISSING capability-table entry`);
          continue;
        }
        const fidelity = outcomeByEvent.get(event);
        if (!fidelity) {
          failures.push(`${harness} ${event}: planner produced no fidelity entry`);
          continue;
        }

        if (support.kind === "unsupported") {
          if (fidelity.outcome !== "skipped") {
            failures.push(`${harness} ${event}: table=unsupported but plan=${fidelity.outcome}`);
          }
          if (acceptedEvents.has(event)) {
            failures.push(`${harness} ${event}: unsupported event was accepted by the planner`);
          }
          continue;
        }

        // native / degraded -> accepted, and the plan's degraded-ness must match
        // whether the lowerer actually drops any portable control.
        if (!acceptedEvents.has(event)) {
          failures.push(`${harness} ${event}: table=${support.kind} but planner did not accept it`);
        }
        const dropped = droppedControls(event, support.controls);
        const expectedOutcome = support.kind === "degraded" || dropped.length > 0 ? "degraded" : "native";
        if (fidelity.outcome !== expectedOutcome) {
          failures.push(
            `${harness} ${event}: expected plan outcome ${expectedOutcome} (kind=${support.kind}, dropped=[${dropped.join(",")}]) but got ${fidelity.outcome}`,
          );
        }
        if (fidelity.outcome === "degraded" && dropped.length > 0) {
          const reported = new Set(fidelity.droppedControls ?? []);
          for (const c of dropped) {
            if (!reported.has(c)) {
              failures.push(`${harness} ${event}: dropped control ${c} not reported in fidelity`);
            }
          }
        }
      }
    }

    expect(failures, `\n${failures.join("\n")}`).toEqual([]);
  });

  test("onDegraded: fail turns any degraded/unsupported event into a compile error", () => {
    // Pick, per harness, an event the table marks unsupported or degraded, and
    // assert onDegraded:"fail" makes planning fail closed.
    const failures: string[] = [];
    for (const harness of getAllHarnessIds()) {
      const caps = HOOK_CAPABILITIES[harness];
      const target = ALL_EVENTS.find((e) => {
        const support = caps[e];
        if (support.kind === "unsupported") return true;
        return droppedControls(e, support.controls).length > 0;
      });
      if (!target) continue; // fully-native harness (claude-code) — nothing to fail on
      const exit = Effect.runSyncExit(planHooksForTarget([makeHook(target, "fail")], harness));
      if (exit._tag !== "Failure") {
        failures.push(`${harness} ${target}: onDegraded:"fail" did not fail closed`);
      }
    }
    expect(failures, `\n${failures.join("\n")}`).toEqual([]);
  });
});
