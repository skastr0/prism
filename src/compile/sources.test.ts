/**
 * Schema round-trip tests for CanonicalTool's side-effect authority field
 * (PQ-075). Authority classifies a tool's side-effect surface — readOnly,
 * mutatesExternalState, mutatesHarnessConfig, startsDaemon, or
 * requiresHumanApproval — and is optional today (default-then-require
 * migration: see ToolAuthoritySchema in @skastr0/prism-sdk/compile-manifest).
 */

import { Either, Schema } from "effect";
import { describe, expect, test } from "bun:test";
import { CanonicalTool, CanonicalToolSchema } from "./sources.js";

const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

const baseRawTool = {
  name: "run_shell",
  description: "Run a shell command.",
  input: Schema.Struct({ command: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  handle: async () => ({ ok: true }),
};

const decode = (raw: unknown) =>
  Schema.decodeUnknownEither(CanonicalToolSchema, STRICT_PARSE_OPTIONS)(raw);

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
      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right.authority).toBe(authority);
      }
    }
  });

  test("rejects a literal outside the declared authority classes", () => {
    const result = decode({ ...baseRawTool, authority: "mutatesEverything" });
    expect(Either.isLeft(result)).toBe(true);
  });

  test("omits authority cleanly when a tool source declares none (migration default)", () => {
    const result = decode({ ...baseRawTool });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.authority).toBeUndefined();
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
