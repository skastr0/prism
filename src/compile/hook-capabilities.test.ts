import { describe, expect, test } from "bun:test";
import { SchemaAST } from "effect";
import { getAllHarnessIds } from "../harnesses.js";
import { HOOK_CAPABILITIES } from "./hook-capabilities.js";
import { HookEventSchema, type HookEvent } from "./sources.js";

const getHookEventsFromSchema = (): HookEvent[] => {
  const ast = HookEventSchema.ast;
  if (ast._tag === "Union") {
    return ast.types.map((t) => {
      if (t._tag === "Literal") {
        return t.literal as HookEvent;
      }
      throw new Error(`Expected Literal AST, got ${t._tag}`);
    });
  } else if (ast._tag === "Literal") {
    return [ast.literal as HookEvent];
  }
  throw new Error(`Expected Union or Literal AST, got ${ast._tag}`);
};

describe("hook-capabilities", () => {
  test("runtime completeness", () => {
    const harnessIds = getAllHarnessIds();
    const hookEvents = getHookEventsFromSchema();

    for (const harnessId of harnessIds) {
      const capabilities = HOOK_CAPABILITIES[harnessId];
      expect(capabilities).toBeDefined();

      for (const event of hookEvents) {
        const support = capabilities[event];
        expect(support).toBeDefined();
        expect(["native", "degraded", "unsupported"]).toContain(support.kind);
      }
    }
  });

  test("no 'pending' placeholder survives — every stage resolved its events", () => {
    const harnessIds = getAllHarnessIds();
    const hookEvents = getHookEventsFromSchema();
    for (const harnessId of harnessIds) {
      for (const event of hookEvents) {
        const note = HOOK_CAPABILITIES[harnessId][event].note;
        if (note) {
          expect(note.toLowerCase()).not.toContain("pending");
        }
      }
    }
  });

  test("spot-asserts", () => {
    // claude-code prompt.submit is native UserPromptSubmit (landed in S1)
    const claudePromptSubmit = HOOK_CAPABILITIES["claude-code"]["prompt.submit"];
    expect(claudePromptSubmit.kind).toBe("native");
    if (claudePromptSubmit.kind === "native") {
      expect(claudePromptSubmit.nativeEvent).toBe("UserPromptSubmit");
    }

    // opencode permission.request is native "permission.ask"
    const opencodePermRequest = HOOK_CAPABILITIES["opencode"]["permission.request"];
    expect(opencodePermRequest.kind).toBe("native");
    if (opencodePermRequest.kind === "native") {
      expect(opencodePermRequest.nativeEvent).toBe("permission.ask");
    }

    // codex-cli session.end is degraded "Stop"
    const codexSessionEnd = HOOK_CAPABILITIES["codex-cli"]["session.end"];
    expect(codexSessionEnd.kind).toBe("degraded");
    if (codexSessionEnd.kind === "degraded") {
      expect(codexSessionEnd.nativeEvent).toBe("Stop");
    }

    // openclaw has no hook lowerer and is not in the program sequence: a
    // permanently-unsupported anchor for the unsupported-with-note pattern.
    const openclawToolBefore = HOOK_CAPABILITIES["openclaw"]["tool.before"];
    expect(openclawToolBefore.kind).toBe("unsupported");
    expect(openclawToolBefore.note).toContain("no hook lowerer");
  });
});
