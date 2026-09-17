import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { EXIT_CODES } from "./exit.js";
import {
  isJevAskJsonErrorsArgv,
  JevAskError,
  jevAskErrorRecord,
  jevAskUsageRecord,
  parseJevAskInputText,
  runJevAsk,
} from "./jev-ask.js";
import {
  JevClient,
  JevClientTest,
  JevError,
  type JevCallOptions,
  type JevClientService,
  resolveJevPublicConfig,
} from "./services/jev.js";
import type { JevQuestions, JevRequest, JevUsage } from "./jev.js";

const questions = {
  route: {
    type: "choice",
    criteria: { act: "act now", wait: "leave it" },
  },
  confidence: { type: "score", criteria: ["low", "high"] },
} as const;

const stubAnswers = {
  route: { type: "choice", choice: "act", confidence: 0.9, probabilities: { act: 0.9, wait: 0.1 } },
  confidence: {
    type: "score",
    score: 1,
    confidence: 0.8,
    legend: { "0": "low", "1": "high" },
    probabilities: { "0": 0.2, "1": 0.8 },
  },
} as const;

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "prism-jev-ask-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const serviceFromLayer = (layer: ReturnType<typeof JevClientTest>): Promise<JevClientService> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* JevClient;
    }).pipe(Effect.provide(layer)),
  );

describe("parseJevAskInputText", () => {
  test("parses inline JSON and @-prefixed files", async () => {
    expect(await parseJevAskInputText(`{"state": {}}`)).toEqual({ state: {} });
    await withTempDir(async (dir) => {
      const path = join(dir, "request.json");
      await writeFile(path, JSON.stringify({ state: { tabs: 2 } }));
      expect(await parseJevAskInputText(`@${path}`)).toEqual({ state: { tabs: 2 } });
    });
  });

  test("rejects empty input, invalid JSON, non-object payloads, and missing files", async () => {
    await expect(parseJevAskInputText("  ")).rejects.toThrow("requires --input");
    await expect(parseJevAskInputText("{nope")).rejects.toThrow("not valid JSON");
    await expect(parseJevAskInputText("[1]")).rejects.toThrow("must be a JSON object");
    await expect(parseJevAskInputText("@/definitely/missing.json")).rejects.toThrow(
      "failed to read --input file",
    );
    // Malformed --input is a CLI-contract usage error.
    const error = await parseJevAskInputText("{nope").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(JevAskError);
    expect((error as JevAskError).exitCode).toBe(EXIT_CODES.usage);
  });
});

describe("runJevAsk", () => {
  const envelope = JSON.stringify({
    state: { tabs: ["https://a.dev"] },
    questions,
  });

  test("executes a validated request against the injected client and returns the wire result", async () => {
    const client = await serviceFromLayer(
      JevClientTest(questions, stubAnswers, {
        usage: { input_tokens: 55, output_tokens: 12 },
      }),
    );
    const result = await runJevAsk({ input: envelope, client });
    expect(result.model).toBe("jev-test");
    expect(result.usage).toEqual({ input_tokens: 55, output_tokens: 12 });
    expect(result.answers.route).toEqual(stubAnswers.route);
    expect(result.answers.confidence).toEqual(stubAnswers.confidence);
  });

  test("forwards timeoutMs to the client call options", async () => {
    const calls: Array<JevCallOptions | undefined> = [];
    const fake: JevClientService = {
      config: resolveJevPublicConfig({}),
      systemOne: <const Q extends JevQuestions>(
        request: JevRequest<Q>,
        callOptions?: JevCallOptions,
      ) => {
        calls.push(callOptions);
        void request;
        return Effect.succeed({
          model: "jev-test",
          answers: {},
          usage: { input_tokens: 0, output_tokens: 0 } satisfies JevUsage,
        }) as never;
      },
    };
    await runJevAsk({
      input: JSON.stringify({ state: {}, questions }),
      timeoutMs: 4000,
      client: fake,
    });
    expect(calls).toEqual([{ timeoutMs: 4000 }]);
  });

  test("rejects envelopes that fail presentation decode", async () => {
    const input = `{"state": {}, "questions": "nope"}`;
    const error = await runJevAsk({ input }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(JevAskError);
    expect((error as JevAskError).message).toContain("failed validation");
    expect((error as JevAskError).failure.kind).toBe("request");
  });

  test("error output never contains the TYPESAFE_API_KEY value", async () => {
    // The decode failure message quotes the offending payload value; when
    // that value IS the configured credential (operator pasted it into the
    // payload), stderr must carry [redacted], not the key.
    const sentinel = "ts-ask-secret-3c4d5e6f7a";
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = sentinel;
    try {
      const input = JSON.stringify({ state: {}, questions: sentinel });
      const error = await runJevAsk({ input }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(JevAskError);
      const asError = error as JevAskError;
      expect(JSON.stringify(asError)).not.toContain(sentinel);
      expect(JSON.stringify(asError.failure)).not.toContain(sentinel);
      expect(JSON.stringify(jevAskErrorRecord(asError))).not.toContain(sentinel);
      expect(JSON.stringify(jevAskErrorRecord(new Error(`boom: ${sentinel}`)))).not.toContain(
        sentinel,
      );
      expect(JSON.stringify(jevAskUsageRecord(new Error(`argv had ${sentinel}`)))).not.toContain(
        sentinel,
      );
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });

  test("rejects misspelled question fields instead of silently stripping them", () => {
    // `instruction` (singular) is not a schema field: strict decode must fail
    // rather than drop the author's instructions from the request.
    const input = JSON.stringify({
      state: {},
      questions: {
        watch: { type: "noul", criteria: { true: "watched" }, instruction: "typo" },
      },
    });
    return runJevAsk({ input }).then(
      () => {
        throw new Error("expected rejection");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(JevAskError);
        expect((error as JevAskError).failure.kind).toBe("request");
        expect((error as JevAskError).message).toContain("failed validation");
      },
    );
  });

  test("rejects requests failing semantic validation before any client call", async () => {
    // Empty choice criteria fails normalizeJevRequest.
    const bad = JSON.stringify({
      state: {},
      questions: { pick: { type: "choice", criteria: {} } },
    });
    const error = await runJevAsk({ input: bad }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(JevAskError);
    expect((error as JevAskError).message).toContain("request rejected");
  });

  test("maps JevError failures to JevAskError with the taxonomy kind in the message", async () => {
    const failing: JevClientService = {
      config: resolveJevPublicConfig({}),
      systemOne: () =>
        Effect.fail(
          new JevError({
            kind: "configuration",
            message: "TYPESAFE_API_KEY is required for live Jev calls",
          }),
        ) as never,
    };
    const error = await runJevAsk({
      input: JSON.stringify({ state: {}, questions }),
      client: failing,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(JevAskError);
    expect((error as JevAskError).message).toContain("[jev:configuration]");
    expect((error as JevAskError).exitCode).toBe(EXIT_CODES.domainFailure);
  });
});

describe("machine error records", () => {
  test("jevAskErrorRecord projects the structured failure, keeping httpStatus/retryAfterMs", () => {
    const error = new JevAskError({
      kind: "rate-limit",
      message: "jev rate limit exceeded after SDK retries",
      httpStatus: 429,
      retryAfterMs: 1500,
    });
    expect(jevAskErrorRecord(error)).toEqual({
      version: 1,
      error: {
        kind: "rate-limit",
        message: "jev rate limit exceeded after SDK retries",
        httpStatus: 429,
        retryAfterMs: 1500,
      },
    });
  });

  test("jevAskErrorRecord never fabricates an API classification for unexpected errors", () => {
    expect(jevAskErrorRecord(new Error("boom")).error.kind).toBe("internal");
    expect(jevAskErrorRecord("boom").error.kind).toBe("internal");
  });

  test("jevAskUsageRecord classifies pre-action commander failures as usage", () => {
    const record = jevAskUsageRecord(new Error("option '--input <json>' argument missing"));
    expect(record).toEqual({
      version: 1,
      error: { kind: "usage", message: "option '--input <json>' argument missing" },
    });
  });

  test("isJevAskJsonErrorsArgv only matches a jev ask invocation carrying the flag", () => {
    expect(isJevAskJsonErrorsArgv(["bun", "cli.ts", "jev", "ask", "--json-errors"])).toBe(true);
    expect(
      isJevAskJsonErrorsArgv(["bun", "cli.ts", "jev", "ask", "--input", "{}", "--json-errors"]),
    ).toBe(true);
    expect(isJevAskJsonErrorsArgv(["bun", "cli.ts", "jev", "ask"])).toBe(false);
    expect(isJevAskJsonErrorsArgv(["bun", "cli.ts", "doctor", "--json-errors"])).toBe(false);
    expect(isJevAskJsonErrorsArgv(["bun", "cli.ts"])).toBe(false);
  });
});
