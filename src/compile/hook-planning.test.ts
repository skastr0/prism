import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { planHooksForTarget, type HookFidelityEntry } from "./hook-planning.js";
import { Hook, type HookEvent } from "./sources.js";

const makeHook = (options: {
  name: string;
  event: HookEvent;
  onDegraded?: "fail" | "degrade" | "skip";
}): Hook =>
  new Hook({
    name: options.name,
    sourcePath: `/dummy/${options.name}.hook.ts`,
    event: options.event,
    targets: [],
    match: {},
    handle: () => {},
    onDegraded: options.onDegraded,
  });

describe("hook-planning 9-cell policy matrix", () => {
  // Cell 1, 2, 3: Native-Full (claude-code + session.start)
  describe("native-full", () => {
    test("onDegraded: fail", () => {
      const hook = makeHook({ name: "native-fail", event: "session.start", onDegraded: "fail" });
      const result = Effect.runSync(planHooksForTarget([hook], "claude-code"));
      expect(result.accepted).toEqual([hook]);
      expect(result.fidelity).toHaveLength(1);
      expect(result.fidelity[0]).toEqual({
        hook: "native-fail",
        event: "session.start",
        target: "claude-code",
        outcome: "native",
        nativeEvent: "SessionStart",
        notes: [],
      });
    });

    test("onDegraded: degrade", () => {
      const hook = makeHook({ name: "native-degrade", event: "session.start", onDegraded: "degrade" });
      const result = Effect.runSync(planHooksForTarget([hook], "claude-code"));
      expect(result.accepted).toEqual([hook]);
      expect(result.fidelity[0]?.outcome).toBe("native");
    });

    test("onDegraded: skip", () => {
      const hook = makeHook({ name: "native-skip", event: "session.start", onDegraded: "skip" });
      const result = Effect.runSync(planHooksForTarget([hook], "claude-code"));
      expect(result.accepted).toEqual([hook]);
      expect(result.fidelity[0]?.outcome).toBe("native");
    });
  });

  // Cell 4, 5, 6: Degraded/dropped-controls (claude-code + tool.before)
  // Anchored on pi + tool.before — pi is not in the program sequence and its
  // tool_call hook stays block-only (drops updatedInput/systemMessage/
  // additionalContext), so it remains a stable "degraded" fixture. claude-code
  // tool.before became native-with-full-controls in S1 and no longer degrades.
  describe("degraded / dropped controls", () => {
    test("onDegraded: fail", () => {
      const hook = makeHook({ name: "degraded-fail", event: "tool.before", onDegraded: "fail" });
      const exit = Effect.runSyncExit(planHooksForTarget([hook], "pi"));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = exit.cause;
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("SourceParseError");
          if (error.error._tag === "SourceParseError") {
            expect(error.error.message).toContain("dropped controls");
          }
        }
      }
    });

    test("onDegraded: degrade", () => {
      const hook = makeHook({ name: "degraded-degrade", event: "tool.before", onDegraded: "degrade" });
      const result = Effect.runSync(planHooksForTarget([hook], "pi"));
      expect(result.accepted).toEqual([hook]);
      expect(result.fidelity).toHaveLength(1);
      expect(result.fidelity[0]).toEqual({
        hook: "degraded-degrade",
        event: "tool.before",
        target: "pi",
        outcome: "degraded",
        nativeEvent: "tool_call",
        droppedControls: ["updatedInput", "systemMessage", "additionalContext"],
        notes: [],
      });
    });

    test("onDegraded: skip", () => {
      const hook = makeHook({ name: "degraded-skip", event: "tool.before", onDegraded: "skip" });
      const result = Effect.runSync(planHooksForTarget([hook], "pi"));
      expect(result.accepted).toEqual([]);
      expect(result.fidelity).toHaveLength(1);
      expect(result.fidelity[0]).toEqual({
        hook: "degraded-skip",
        event: "tool.before",
        target: "pi",
        outcome: "skipped",
        nativeEvent: "tool_call",
        notes: [],
      });
    });
  });

  // Cell 7, 8, 9: Unsupported. Anchored on openclaw + prompt.submit — openclaw
  // has no hook lowerer and is not in the program sequence, so it stays
  // unsupported across every stage (claude-code has no unsupported events
  // after S1, so it can no longer serve as the unsupported fixture).
  describe("unsupported", () => {
    test("onDegraded: fail", () => {
      const hook = makeHook({ name: "unsupported-fail", event: "prompt.submit", onDegraded: "fail" });
      const exit = Effect.runSyncExit(planHooksForTarget([hook], "openclaw"));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = exit.cause;
        expect(error._tag).toBe("Fail");
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("SourceParseError");
          if (error.error._tag === "SourceParseError") {
            expect(error.error.message).toContain("is unsupported");
          }
        }
      }
    });

    test("onDegraded: degrade", () => {
      const hook = makeHook({ name: "unsupported-degrade", event: "prompt.submit", onDegraded: "degrade" });
      const result = Effect.runSync(planHooksForTarget([hook], "openclaw"));
      expect(result.accepted).toEqual([]);
      expect(result.fidelity).toHaveLength(1);
      expect(result.fidelity[0]).toEqual({
        hook: "unsupported-degrade",
        event: "prompt.submit",
        target: "openclaw",
        outcome: "skipped",
        notes: ["no hook lowerer yet"],
      });
    });

    test("onDegraded: skip", () => {
      const hook = makeHook({ name: "unsupported-skip", event: "prompt.submit", onDegraded: "skip" });
      const result = Effect.runSync(planHooksForTarget([hook], "openclaw"));
      expect(result.accepted).toEqual([]);
      expect(result.fidelity).toHaveLength(1);
      expect(result.fidelity[0]).toEqual({
        hook: "unsupported-skip",
        event: "prompt.submit",
        target: "openclaw",
        outcome: "skipped",
        notes: ["no hook lowerer yet"],
      });
    });
  });
});
