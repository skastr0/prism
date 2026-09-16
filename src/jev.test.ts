import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  choice,
  estimateJevRequestTokens,
  JEV_TOKEN_BUDGET,
  JEV_TOKEN_REQUEST_TARGET,
  jevResultSchema,
  JevRequestValidationError,
  normalizeJevEntry,
  normalizeJevQuestions,
  normalizeJevRequest,
  noul,
  parseJevRequest,
  score,
  type JevResult,
} from "./jev.js";

const questions = {
  route: choice({
    instructions: "Choose the next action.",
    criteria: {
      act: "The request is clear and safe to execute.",
      clarify: "Important information is missing.",
    },
  }),
  readiness: score({
    criteria: ["Not ready", "Partially ready", "Ready to execute"] as const,
  }),
  destructive: noul({
    instructions: "Would the proposed action destroy user data?",
  }),
} as const;

const validResponse = {
  model: "jev-2026-08",
  answers: {
    route: {
      type: "choice",
      choice: "act",
      confidence: 0.92,
      probabilities: { act: 0.92, clarify: 0.08 },
    },
    readiness: {
      type: "score",
      score: 2,
      confidence: 0.8,
      legend: { "0": "Not ready", "1": "Partially ready", "2": "Ready to execute" },
      probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 },
    },
    destructive: { type: "noul", noul: 0.02 },
  },
  usage: { input_tokens: 412, output_tokens: 96 },
};

describe("question constructors", () => {
  test("tag definitions without validating (normalization validates)", () => {
    expect(questions.route.type).toBe("choice");
    expect(questions.readiness.type).toBe("score");
    expect(questions.destructive.type).toBe("noul");
    expect(noul()).toEqual({ type: "noul" });
  });
});

describe("normalizeJevEntry", () => {
  test("accepts strings, plain objects, arrays, and null", () => {
    expect(normalizeJevEntry("hello")).toBe("hello");
    expect(normalizeJevEntry(null)).toBe(null);
    const array = normalizeJevEntry(["a", { b: [1, true, null] }], "state");
    expect(array).toEqual(["a", { b: [1, true, null] }]);
  });

  test("rejects bare booleans and numbers at the entry top level", () => {
    expect(() => normalizeJevEntry(true)).toThrow(JevRequestValidationError);
    expect(() => normalizeJevEntry(42)).toThrow(JevRequestValidationError);
  });

  test("rejects undefined, functions, symbols, bigints, and non-finite numbers", () => {
    expect(() => normalizeJevEntry(undefined)).toThrow(JevRequestValidationError);
    expect(() => normalizeJevEntry(() => 1)).toThrow(JevRequestValidationError);
    expect(() => normalizeJevEntry(Symbol("s"))).toThrow(JevRequestValidationError);
    expect(() => normalizeJevEntry(10n as unknown)).toThrow(JevRequestValidationError);
    expect(() => normalizeJevEntry({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => normalizeJevEntry({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  test("rejects class instances anywhere in the structure", () => {
    expect(() => normalizeJevEntry({ at: new Date(0) as unknown as string })).toThrow(
      JevRequestValidationError,
    );
    expect(() => normalizeJevEntry({ m: new Map() as unknown as string })).toThrow(/plain JSON/);
  });

  test("rejects cyclic structures", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => normalizeJevEntry(cyclic)).toThrow(/cyclic/);
  });

  test("returns deep-frozen deep copies, so later mutation cannot change them", () => {
    const source = { tab: { title: "Original" } };
    const normalized = normalizeJevEntry(source) as { tab: { title: string } };
    source.tab.title = "Mutated";
    expect(normalized.tab.title).toBe("Original");
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.tab)).toBe(true);
    expect(() => {
      normalized.tab.title = "Nope";
    }).toThrow();
  });
});

describe("normalizeJevQuestions", () => {
  test("rejects an empty questions map", () => {
    expect(() => normalizeJevQuestions({})).toThrow(/at least one question/);
  });

  test("rejects empty choice criteria and one-level score rubrics", () => {
    expect(() => normalizeJevQuestions({ q: { type: "choice", criteria: {} } })).toThrow(
      /at least one label/,
    );
    expect(() =>
      normalizeJevQuestions({ q: { type: "score", criteria: ["only"] as unknown as never } }),
    ).toThrow(/at least two levels/);
    expect(() => normalizeJevQuestions({ q: { type: "score", criteria: null as never } })).toThrow(
      /rubric array/,
    );
  });

  test("accepts noul criteria as omitted, null, one-sided, or two-sided", () => {
    expect(normalizeJevQuestions({ q: { type: "noul" } }).q).toEqual({ type: "noul" });
    expect(normalizeJevQuestions({ q: { type: "noul", criteria: null } }).q).toMatchObject({
      criteria: null,
    });
    expect(
      normalizeJevQuestions({ q: { type: "noul", criteria: { true: "yes" } } }).q,
    ).toMatchObject({ criteria: { true: "yes" } });
  });

  test("rejects unknown question types and typo fields", () => {
    expect(() => normalizeJevQuestions({ q: { type: "pick" as never } })).toThrow(
      /unsupported question type/,
    );
    expect(() =>
      normalizeJevQuestions({ q: { type: "noul", criterai: null } as never }),
    ).toThrow(/unsupported question field 'criterai'/);
  });

  test("catalog errors name the question id path", () => {
    try {
      normalizeJevQuestions({ tab_017_category: { type: "choice", criteria: {} } });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(JevRequestValidationError);
      expect((error as Error).message).toContain("questions.tab_017_category.criteria");
    }
  });
});

describe("normalizeJevRequest / parseJevRequest", () => {
  test("validates and freezes the whole request", () => {
    const request = normalizeJevRequest({
      state: { ticket: "double charged" },
      questions,
      model: "jev-2026-08",
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.questions)).toBe(true);
    expect(request.model).toBe("jev-2026-08");
  });

  test("rejects unknown top-level fields so worker options cannot leak in", () => {
    expect(() =>
      normalizeJevRequest({ state: null, questions, prompt: "hack" } as never),
    ).toThrow(/unsupported request field 'prompt'/);
  });

  test("parseJevRequest handles unknown input", () => {
    const parsed = parseJevRequest({ state: "doc", questions: { q: { type: "noul" } } });
    expect(parsed.questions["q"]?.type).toBe("noul");
    expect(() => parseJevRequest({ questions: {} })).toThrow(/state/);
  });
});

describe("token budget", () => {
  test("documents the API budget and the enforced target below it", () => {
    expect(JEV_TOKEN_BUDGET).toBe(32_000);
    expect(JEV_TOKEN_REQUEST_TARGET).toBeLessThan(JEV_TOKEN_BUDGET);
  });

  test("estimates tokens from serialized payload size", () => {
    const small = estimateJevRequestTokens({ state: "hi", questions: { q: { type: "noul" } } });
    const big = estimateJevRequestTokens({
      state: "x".repeat(40_000),
      questions: { q: { type: "noul" } },
    });
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeGreaterThan(9_000);
  });
});

describe("jevResultSchema", () => {
  const codec = jevResultSchema(questions);
  const decode = Schema.decodeUnknownSync(codec);

  test("decodes a valid mixed response with per-question typing", () => {
    const result: JevResult<typeof questions> = decode(validResponse);
    expect(result.answers.route.type).toBe("choice");
    expect(result.answers.route.choice).toBe("act");
    expect(result.answers.readiness.score).toBe(2);
    expect(result.answers.destructive.noul).toBe(0.02);
    expect(result.model).toBe("jev-2026-08");
    expect(result.usage.input_tokens).toBe(412);
  });

  test("encodes and decodes losslessly with no services", () => {
    const decoded = decode(validResponse);
    const encoded = Schema.encodeSync(codec)(decoded);
    expect(encoded).toEqual(decoded);
  });

  test("rejects a choice outside the criteria labels", () => {
    const bad = structuredClone(validResponse);
    bad.answers.route.choice = "explode";
    expect(() => decode(bad)).toThrow();
  });

  test("rejects probabilities missing a criteria label", () => {
    const bad = structuredClone(validResponse) as any;
    delete bad.answers.route.probabilities.clarify;
    expect(() => decode(bad)).toThrow();
  });

  test("rejects a score outside the rubric range and non-integer fractional rubric positions only outside range", () => {
    const bad = structuredClone(validResponse);
    bad.answers.readiness.score = 3; // rubric has levels 0..2
    expect(() => decode(bad)).toThrow();

    const fractional = structuredClone(validResponse);
    fractional.answers.readiness.score = 1.4; // expected scores may fall between levels
    expect(() => decode(fractional)).not.toThrow();
  });

  test("rejects probabilities outside [0, 1]", () => {
    const bad = structuredClone(validResponse);
    bad.answers.destructive.noul = 1.2;
    expect(() => decode(bad)).toThrow();
  });

  test("rejects a score legend that disagrees with the request rubric", () => {
    const bad = structuredClone(validResponse) as any;
    bad.answers.readiness.legend["2"] = "Totally ready";
    expect(() => decode(bad)).toThrow();
  });

  test("rejects malformed usage and empty model", () => {
    const bad = structuredClone(validResponse) as any;
    bad.usage.input_tokens = -1;
    expect(() => decode(bad)).toThrow();
    const emptyModel = structuredClone(validResponse);
    emptyModel.model = "";
    expect(() => decode(emptyModel)).toThrow();
  });

  test("noul answers carry no confidence field in their type", () => {
    const result = decode(validResponse);
    expect("confidence" in result.answers.destructive).toBe(false);
  });
});
