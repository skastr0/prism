import { expect, test } from "bun:test";
import {
  decodeHookResultForEvent,
  decodeNativeHookPayloadForEvent,
} from "./sources.js";

test("decodeHookResultForEvent round-trips valid and rejects invalid results for all 13 events", () => {
  const events = [
    "tool.before",
    "tool.after",
    "tool.failure",
    "prompt.submit",
    "permission.request",
    "session.start",
    "session.end",
    "stop",
    "subagent.start",
    "subagent.stop",
    "compact.before",
    "compact.after",
    "notification",
  ] as const;

  for (const event of events) {
    // Test rejection of invalid result
    const invalidResult = { decision: "bogus" };
    const decodedInvalid = decodeHookResultForEvent(event, invalidResult);
    expect(decodedInvalid._tag).toBe("Left");

    // Test acceptance of valid result
    let validResult: any;
    switch (event) {
      case "tool.before":
        validResult = {
          decision: "continue",
          updatedInput: { foo: "bar" },
          systemMessage: "sys",
          additionalContext: "ctx",
        };
        break;
      case "tool.after":
        validResult = {
          decision: "continue",
          updatedOutput: "out",
          systemMessage: "sys",
          additionalContext: "ctx",
        };
        break;
      case "tool.failure":
        validResult = {
          decision: "continue",
          systemMessage: "sys",
          additionalContext: "ctx",
        };
        break;
      case "prompt.submit":
        validResult = {
          decision: "block",
          message: "blocked prompt",
        };
        break;
      case "permission.request":
        validResult = {
          decision: "allow",
          updatedInput: { args: [] },
          systemMessage: "sys",
        };
        break;
      case "session.start":
        validResult = {
          decision: "continue",
          systemMessage: "sys",
          additionalContext: "ctx",
        };
        break;
      case "session.end":
        validResult = {
          decision: "continue",
          systemMessage: "sys",
          additionalContext: "ctx",
        };
        break;
      case "stop":
        validResult = {
          decision: "block",
          message: "do not stop",
        };
        break;
      case "subagent.start":
        validResult = {
          decision: "continue",
          systemMessage: "sys",
          additionalContext: "ctx",
        };
        break;
      case "subagent.stop":
        validResult = {
          decision: "block",
          message: "subagent block",
        };
        break;
      case "compact.before":
        validResult = {
          decision: "block",
          message: "no compaction",
        };
        break;
      case "compact.after":
        validResult = {
          decision: "continue",
          systemMessage: "sys",
          additionalContext: "ctx",
        };
        break;
      case "notification":
        validResult = {
          decision: "continue",
          systemMessage: "sys",
        };
        break;
    }

    const decodedValid = decodeHookResultForEvent(event, validResult);
    expect(decodedValid._tag).toBe("Right");
  }
});

test("decodeNativeHookPayloadForEvent decodes valid and rejects invalid payloads for 7 new events", () => {
  const newEvents = [
    "tool.failure",
    "stop",
    "subagent.start",
    "subagent.stop",
    "compact.before",
    "compact.after",
    "notification",
  ] as const;

  for (const event of newEvents) {
    // Test rejection of invalid payload (e.g. missing target context)
    const invalidPayload = {
      cwd: "/workspace",
    };
    const decodedInvalid = decodeNativeHookPayloadForEvent(event, invalidPayload);
    expect(decodedInvalid._tag).toBe("Left");

    // Test acceptance of valid payload
    let validPayload: any;
    const target = { harness: "test-harness", nativeEvent: "native-event" };
    switch (event) {
      case "tool.failure":
        validPayload = {
          target,
          tool: { name: "my_tool", input: { arg: 1 }, error: "failed to run" },
        };
        break;
      case "stop":
        validPayload = {
          target,
          stopHookActive: true,
        };
        break;
      case "subagent.start":
        validPayload = {
          target,
          subagent: { id: "sub-1", type: "helper" },
        };
        break;
      case "subagent.stop":
        validPayload = {
          target,
          subagent: { id: "sub-1", type: "helper" },
        };
        break;
      case "compact.before":
        validPayload = {
          target,
          trigger: "compaction-trigger",
        };
        break;
      case "compact.after":
        validPayload = {
          target,
          trigger: "compaction-trigger",
        };
        break;
      case "notification":
        validPayload = {
          target,
          message: "notified",
          kind: "info",
        };
        break;
    }

    const decodedValid = decodeNativeHookPayloadForEvent(event, validPayload);
    expect(decodedValid._tag).toBe("Right");
  }
});
