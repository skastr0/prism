/**
 * Schema round-trip tests for CanonicalTool's side-effect authority field
 * (PQ-075). Authority classifies a tool's side-effect surface — readOnly,
 * mutatesExternalState, mutatesHarnessConfig, startsDaemon, or
 * requiresHumanApproval — and is optional today (default-then-require
 * migration: see ToolAuthoritySchema in @skastr0/prism-sdk/compile-manifest).
 */

import { Result, Schema } from "effect";
import { describe, expect, test } from "bun:test";
import { CanonicalTool, CanonicalToolSchema, HookToolContextSchema } from "./sources.js";

const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

const baseRawTool = {
  name: "run_shell",
  description: "Run a shell command.",
  input: Schema.Struct({ command: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  handle: async () => ({ ok: true }),
};

const decode = (raw: unknown) =>
  Schema.decodeUnknownResult(CanonicalToolSchema, STRICT_PARSE_OPTIONS)(raw);

describe("CanonicalToolSchema authority (PQ-075)", () => {
  test("accepts every declared authority class and preserves it", () => {
    const classes = [
      "readOnly",
      "mutatesExternalState",
      "mutatesHarnessConfig",
      "startsDaemon",
      "requiresHumanApproval",
    ] as const;

    for (const authority of classes) {
      const result = decode({ ...baseRawTool, authority });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success.authority).toBe(authority);
      }
    }
  });

  test("rejects a literal outside the declared authority classes", () => {
    const result = decode({ ...baseRawTool, authority: "mutatesEverything" });
    expect(Result.isFailure(result)).toBe(true);
  });

  test("omits authority cleanly when a tool source declares none (migration default)", () => {
    const result = decode({ ...baseRawTool });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.authority).toBeUndefined();
    }
  });
});

describe("CanonicalTool normalized class authority (PQ-075)", () => {
  const build = (authority?: CanonicalTool["authority"]) =>
    new CanonicalTool({
      name: "run_shell",
      sourcePath: "/test/plugin/tools/run_shell.tool.ts",
      description: "Run a shell command.",
      input: Schema.Struct({ command: Schema.String }),
      output: Schema.Struct({ ok: Schema.Boolean }),
      slots: {},
      handle: async () => ({ ok: true }),
      authority,
    });

  test("carries a declared authority class through construction", () => {
    const tool = build("mutatesExternalState");
    expect(tool.authority).toBe("mutatesExternalState");
  });

  test("leaves authority undefined when the source never declared one", () => {
    const tool = build(undefined);
    expect(tool.authority).toBeUndefined();
  });
});

describe("hook tool context presence (v4)", () => {
  const decodeToolContext = (raw: unknown) => Schema.decodeUnknownResult(HookToolContextSchema)(raw);

  // v4 requires a non-optional Schema.Unknown field to be present, where v3
  // treated absence as undefined. Harness payloads legitimately omit these, so
  // they are optionalKey: absent, explicit undefined, and a value all decode.
  test("accepts an absent value, an explicit undefined, and a value", () => {
    expect(Result.isSuccess(decodeToolContext({ nativeName: "Read" }))).toBe(true);
    expect(Result.isSuccess(decodeToolContext({ nativeName: "Read", input: undefined }))).toBe(true);
    expect(Result.isSuccess(decodeToolContext({ nativeName: "Read", input: { a: 1 } }))).toBe(true);
  });

  test("still requires the fields that carry real meaning", () => {
    expect(Result.isFailure(decodeToolContext({}))).toBe(true);
  });
});

describe("required canonical tool fields name their remediation", () => {
  test("an omitted handle reports the authored missing-key message", () => {
    const { handle: _omitted, ...withoutHandle } = baseRawTool;
    const result = decode(withoutHandle);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain(
        "Declare a callable `handle` implementation for this tool.",
      );
    }
  });

  test("an omitted input reports the authored missing-key message", () => {
    const { input: _omitted, ...withoutInput } = baseRawTool;
    const result = decode(withoutInput);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("Declare `input` with an Effect Schema");
    }
  });
});
