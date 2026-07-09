import { expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GENERATED_HOOK_RUNTIME } from "./hook-runtime-bundle.js";
import * as sources from "./sources.js";

const tempFilePath = path.join(import.meta.dir, "temp-hook-runtime.mjs");

interface GeneratedRuntime {
  decodeNativeHookPayloadForEvent: (event: string, payload: any) => any;
  decodeHookResultForEvent: (event: string, result: any) => any;
}

let generated: GeneratedRuntime;

beforeAll(async () => {
  await fs.writeFile(tempFilePath, GENERATED_HOOK_RUNTIME, "utf8");
  generated = (await import("file://" + tempFilePath)) as GeneratedRuntime;
});

afterAll(async () => {
  try {
    await fs.unlink(tempFilePath);
  } catch (e) {
    // ignore
  }
});

const target = { harness: "test-harness", nativeEvent: "native-event" };

const payloadFixtures: Record<
  sources.HookEvent,
  { valid: any[]; invalid: any[] }
> = {
  "tool.before": {
    valid: [
      {
        target,
        tool: { name: "my_tool", logical: "logical-name", input: { foo: "bar" } },
        cwd: "/workspace",
      },
      {
        target,
        tool: { name: "my_tool", input: { foo: "bar" } },
      },
    ],
    invalid: [
      {
        target: { harness: "test-harness" },
        tool: { name: "my_tool", logical: "logical-name", input: { foo: "bar" } },
      },
      {
        target,
        tool: { logical: "logical-name" },
      },
      {
        target,
        tool: { name: 123 },
      },
      {
        target,
        tool: { name: "my_tool" },
        cwd: 123,
      },
    ],
  },
  "tool.after": {
    valid: [
      {
        target,
        tool: { name: "my_tool", logical: "logical-name", input: { foo: "bar" }, output: "out", success: true },
        cwd: "/workspace",
      },
      {
        target,
        tool: { name: "my_tool", input: { foo: "bar" }, output: "out" },
      },
    ],
    invalid: [
      {
        target,
        tool: { name: "my_tool", input: { foo: "bar" }, output: "out", success: "yes" },
      },
      {
        target,
        tool: { logical: "logical-name" },
      },
    ],
  },
  "tool.failure": {
    valid: [
      {
        target,
        tool: { name: "my_tool", logical: "logical-name", input: { foo: "bar" }, error: "err" },
        cwd: "/workspace",
      },
      {
        target,
        tool: { name: "my_tool", input: { foo: "bar" }, error: null },
      },
    ],
    invalid: [
      {
        target,
        tool: { name: 123, error: "err" },
      },
      {
        target,
        tool: { logical: "logical-name", error: "err" },
      },
    ],
  },
  "prompt.submit": {
    valid: [
      {
        target,
        prompt: "hello",
        cwd: "/workspace",
      },
    ],
    invalid: [
      {
        target,
        prompt: 123,
      },
      {
        target,
      },
    ],
  },
  "permission.request": {
    valid: [
      {
        target,
      },
      {
        target,
        tool: { name: "my_tool" },
      },
    ],
    invalid: [
      {
        target,
        tool: { logical: "logical-name" },
      },
    ],
  },
  "session.start": {
    valid: [
      {
        target,
        session: { id: "s1" },
      },
    ],
    invalid: [
      {
        target,
      },
      {
        target,
        session: 123,
      },
      {
        target,
        session: { id: 123 },
      },
    ],
  },
  "session.end": {
    valid: [
      {
        target,
        session: { id: "s1" },
        reason: "done",
      },
    ],
    invalid: [
      {
        target,
        session: { id: "s1" },
        reason: 123,
      },
    ],
  },
  stop: {
    valid: [
      {
        target,
        stopHookActive: true,
      },
      {
        target,
      },
    ],
    invalid: [
      {
        target,
        stopHookActive: 123,
      },
    ],
  },
  "subagent.start": {
    valid: [
      {
        target,
        subagent: { id: "sub1", type: "t1" },
      },
      {
        target,
      },
    ],
    invalid: [
      {
        target,
        subagent: { id: 123 },
      },
    ],
  },
  "subagent.stop": {
    valid: [
      {
        target,
        subagent: { id: "sub1", type: "t1" },
      },
      {
        target,
      },
    ],
    invalid: [
      {
        target,
        subagent: { id: 123 },
      },
    ],
  },
  "compact.before": {
    valid: [
      {
        target,
        trigger: "t",
      },
      {
        target,
      },
    ],
    invalid: [
      {
        target,
        trigger: 123,
      },
    ],
  },
  "compact.after": {
    valid: [
      {
        target,
        trigger: "t",
      },
      {
        target,
      },
    ],
    invalid: [
      {
        target,
        trigger: 123,
      },
    ],
  },
  notification: {
    valid: [
      {
        target,
        message: "m",
        kind: "k",
      },
      {
        target,
      },
    ],
    invalid: [
      {
        target,
        message: 123,
      },
      {
        target,
        kind: 123,
      },
    ],
  },
};

const resultFixtures: Record<
  sources.HookEvent,
  { valid: any[]; invalid: any[] }
> = {
  "tool.before": {
    valid: [
      { decision: "continue", updatedInput: { a: 1 }, systemMessage: "sys", additionalContext: "ctx" },
      { decision: "block", message: "blocked", systemMessage: "sys" },
    ],
    invalid: [
      { decision: "bogus" },
      { decision: "continue", systemMessage: 123 },
      { decision: "block", message: 123 },
    ],
  },
  "tool.after": {
    valid: [
      { decision: "continue", updatedOutput: { b: 2 }, systemMessage: "sys", additionalContext: "ctx" },
    ],
    invalid: [
      { decision: "block", message: "blocked" },
      { decision: "continue", updatedOutput: { b: 2 }, additionalContext: 123 },
    ],
  },
  "tool.failure": {
    valid: [
      { decision: "continue", systemMessage: "sys", additionalContext: "ctx" },
    ],
    invalid: [
      { decision: "block", message: "blocked" },
    ],
  },
  "prompt.submit": {
    valid: [
      { decision: "continue", systemMessage: "sys", additionalContext: "ctx" },
      { decision: "block", message: "blocked" },
    ],
    invalid: [
      { decision: "allow" },
    ],
  },
  "permission.request": {
    valid: [
      { decision: "continue", systemMessage: "sys", additionalContext: "ctx" },
      { decision: "allow", updatedInput: { a: 1 }, systemMessage: "sys" },
      { decision: "ask", systemMessage: "sys" },
      { decision: "block", message: "blocked" },
    ],
    invalid: [
      { decision: "allow", systemMessage: 123 },
      { decision: "ask", systemMessage: 123 },
    ],
  },
  "session.start": {
    valid: [
      { decision: "continue", systemMessage: "sys", additionalContext: "ctx" },
    ],
    invalid: [
      { decision: "block", message: "blocked" },
    ],
  },
  "session.end": {
    valid: [
      { decision: "continue", systemMessage: "sys", additionalContext: "ctx" },
    ],
    invalid: [
      { decision: "block", message: "blocked" },
    ],
  },
  stop: {
    valid: [
      { decision: "continue", systemMessage: "sys" },
      { decision: "block", message: "blocked" },
    ],
    invalid: [
      { decision: "continue", systemMessage: 123 },
    ],
  },
  "subagent.start": {
    valid: [
      { decision: "continue", systemMessage: "sys", additionalContext: "ctx" },
    ],
    invalid: [
      { decision: "block", message: "blocked" },
    ],
  },
  "subagent.stop": {
    valid: [
      { decision: "continue", systemMessage: "sys", additionalContext: "ctx" },
      { decision: "block", message: "blocked" },
    ],
    invalid: [
      { decision: "allow" },
    ],
  },
  "compact.before": {
    valid: [
      { decision: "continue", systemMessage: "sys", additionalContext: "ctx" },
      { decision: "block", message: "blocked" },
    ],
    invalid: [
      { decision: "allow" },
    ],
  },
  "compact.after": {
    valid: [
      { decision: "continue", systemMessage: "sys", additionalContext: "ctx" },
    ],
    invalid: [
      { decision: "block", message: "blocked" },
    ],
  },
  notification: {
    valid: [
      { decision: "continue", systemMessage: "sys" },
    ],
    invalid: [
      { decision: "continue", systemMessage: 123 },
    ],
  },
};

test("parity check: decodeNativeHookPayloadForEvent for all 13 events", () => {
  const events = Object.keys(payloadFixtures) as sources.HookEvent[];
  for (const event of events) {
    const fixture = payloadFixtures[event];
    for (const validPayload of fixture.valid) {
      const ourResult = generated.decodeNativeHookPayloadForEvent(event, validPayload);
      const tsResult = sources.decodeNativeHookPayloadForEvent(event, validPayload);

      if (ourResult._tag !== tsResult._tag) {
        console.log("FAIL VALID PAYLOAD tag mismatch:", event, JSON.stringify(validPayload), "our:", ourResult, "ts:", tsResult);
      }
      expect(ourResult._tag).toBe(tsResult._tag);
      if (ourResult._tag === "Right" && tsResult._tag === "Right") {
        expect(ourResult.right).toEqual(tsResult.right);
      }
    }
    for (const invalidPayload of fixture.invalid) {
      const ourResult = generated.decodeNativeHookPayloadForEvent(event, invalidPayload);
      const tsResult = sources.decodeNativeHookPayloadForEvent(event, invalidPayload);

      if (ourResult._tag !== "Left" || tsResult._tag !== "Left") {
        console.log("FAIL INVALID PAYLOAD not Left:", event, JSON.stringify(invalidPayload), "our:", ourResult, "ts:", tsResult);
      }
      expect(ourResult._tag).toBe("Left");
      expect(tsResult._tag).toBe("Left");
    }
  }
});

test("parity check: decodeHookResultForEvent for all 13 events", () => {
  const events = Object.keys(resultFixtures) as sources.HookEvent[];
  for (const event of events) {
    const fixture = resultFixtures[event];
    for (const validResult of fixture.valid) {
      const ourResult = generated.decodeHookResultForEvent(event, validResult);
      const tsResult = sources.decodeHookResultForEvent(event, validResult);

      if (ourResult._tag !== tsResult._tag) {
        console.log("FAIL VALID RESULT tag mismatch:", event, JSON.stringify(validResult), "our:", ourResult, "ts:", tsResult);
      }
      expect(ourResult._tag).toBe(tsResult._tag);
      if (ourResult._tag === "Right" && tsResult._tag === "Right") {
        expect(ourResult.right).toEqual(tsResult.right);
      }
    }
    for (const invalidResult of fixture.invalid) {
      const ourResult = generated.decodeHookResultForEvent(event, invalidResult);
      const tsResult = sources.decodeHookResultForEvent(event, invalidResult);

      if (ourResult._tag !== "Left" || tsResult._tag !== "Left") {
        console.log("FAIL INVALID RESULT not Left:", event, JSON.stringify(invalidResult), "our:", ourResult, "ts:", tsResult);
      }
      expect(ourResult._tag).toBe("Left");
      expect(tsResult._tag).toBe("Left");
    }
  }
});
