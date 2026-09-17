import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { choice, noul, score, type JevQuestions } from "../jev.js";
import {
  JevClient,
  JevClientTest,
  JevClientWith,
  JevError,
} from "./jev.js";

const questions = {
  route: choice({
    instructions: "Choose the next action.",
    criteria: { act: "Clear request.", clarify: "Needs info." },
  }),
  readiness: score({ criteria: ["Not ready", "Ready"] as const }),
  destructive: noul({ instructions: "Destructive?" }),
} satisfies JevQuestions;

const okBody = {
  model: "jev-2026-08",
  answers: {
    route: {
      type: "choice",
      choice: "act",
      confidence: 0.9,
      probabilities: { act: 0.9, clarify: 0.1 },
    },
    readiness: {
      type: "score",
      score: 1,
      confidence: 0.95,
      legend: { "0": "Not ready", "1": "Ready" },
      probabilities: { "0": 0.05, "1": 0.95 },
    },
    destructive: { type: "noul", noul: 0.01 },
  },
  usage: { input_tokens: 210, output_tokens: 44 },
};

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

interface CapturedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: any;
}

const capturingFetch = (
  handler: (call: CapturedCall, index: number) => Promise<Response> | Response,
) => {
  const calls: Array<CapturedCall> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    const call: CapturedCall = {
      url,
      method,
      headers: new Headers(init?.headers),
      body,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};

const run = <A>(
  effect: Effect.Effect<A, JevError, JevClient>,
  layer: ReturnType<typeof JevClientWith> | ReturnType<typeof JevClientTest>,
  options?: { signal?: AbortSignal },
) => Effect.runPromise(effect.pipe(Effect.provide(layer)), options);

const askOnce = Effect.gen(function* () {
  const jev = yield* JevClient;
  return yield* jev.systemOne({ state: "double charged", questions });
});

describe("JevClientWith", () => {
  test("sends state and all questions in one POST with model resolution and bearer auth", async () => {
    const { calls, fetch } = capturingFetch(() => jsonResponse(200, okBody));
    const result = await run(
      askOnce,
      JevClientWith({ apiKey: "ts-test-key", baseURL: "https://api.example.test/", fetch }),
    );
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.example.test/v1/systemone");
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe("Bearer ts-test-key");
    expect(call.body.model).toBe("jev-latest");
    expect(Object.keys(call.body.questions)).toEqual(["route", "readiness", "destructive"]);
    expect(call.body.state).toBe("double charged");
    expect(result.answers.route.choice).toBe("act");
    expect(result.usage).toEqual({ input_tokens: 210, output_tokens: 44 });
  });

  test("task-level model override wins over the layer default", async () => {
    const { calls, fetch } = capturingFetch(() => jsonResponse(200, okBody));
    const layer = JevClientWith({ apiKey: "k", defaultModel: "jev-stable", fetch });
    await run(
      Effect.gen(function* () {
        const jev = yield* JevClient;
        return yield* jev.systemOne({ state: null, questions, model: "jev-turbo" });
      }),
      layer,
    );
    expect(calls[0]!.body.model).toBe("jev-turbo");
  });

  test("missing API key only fails at the first live call", async () => {
    const layer = JevClientWith({});
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        const jev = yield* JevClient;
        return jev.config;
      }).pipe(Effect.provide(layer)),
    );
    expect(config.defaultModel).toBe("jev-latest");
    const exit = await Effect.runPromiseExit(askOnce.pipe(Effect.provide(layer)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as JevError;
      expect(error).toBeInstanceOf(JevError);
      expect(error.kind).toBe("configuration");
    }
  });

  test("SDK retries 429s and succeeds without Prism adding a second layer", async () => {
    const { calls, fetch } = capturingFetch((_call, index) =>
      index < 2
        ? jsonResponse(429, { error: { message: "slow down" } }, { "retry-after-ms": "1" })
        : jsonResponse(200, okBody),
    );
    const result = await run(
      askOnce,
      JevClientWith({
        apiKey: "k",
        fetch,
        retry: { backoffInitialMs: 1, backoffMaxMs: 2, backoffJitter: 0 },
      }),
    );
    expect(calls).toHaveLength(3);
    expect(result.answers.destructive.noul).toBe(0.01);
  });

  test("401 is terminal: authentication kind, no retry, and key never in the error", async () => {
    const { calls, fetch } = capturingFetch(() =>
      jsonResponse(401, { error: { message: "bad key" } }),
    );
    const exit = await Effect.runPromiseExit(
      askOnce.pipe(Effect.provide(JevClientWith({ apiKey: "ts-secret-key-value", fetch }))),
    );
    expect(calls).toHaveLength(1);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as JevError;
      expect(error.kind).toBe("authentication");
      expect(error.status).toBe(401);
      expect(JSON.stringify(error)).not.toContain("ts-secret-key-value");
    }
  });

  test("exhausted rate limit maps to rate-limit with retryAfterMs", async () => {
    const { fetch } = capturingFetch(() =>
      jsonResponse(429, { error: { message: "slow down" } }, { "retry-after-ms": "1500" }),
    );
    const exit = await Effect.runPromiseExit(
      askOnce.pipe(
        Effect.provide(JevClientWith({ apiKey: "k", fetch, retry: { maxRetries: 1, backoffInitialMs: 1, backoffMaxMs: 2 } })),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as JevError;
      expect(error.kind).toBe("rate-limit");
      expect(error.retryAfterMs).toBe(1500);
    }
  });

  test("per-attempt timeout maps to timeout kind", async () => {
    // Hangs until the caller aborts, like a real socket that never answers;
    // real fetch rejects on abort — the mock must honor that contract too.
    const hang: typeof globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as typeof globalThis.fetch;
    const exit = await Effect.runPromiseExit(
      askOnce.pipe(
        Effect.provide(JevClientWith({ apiKey: "k", fetch: hang, timeoutMs: 25, retry: { maxRetries: 0 } })),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as JevError;
      expect(error.kind).toBe("timeout");
    }
  });

  test("aborting the run interrupts the fiber instead of failing with a JevError", async () => {
    const controller = new AbortController();
    const hanging: typeof globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as typeof globalThis.fetch;
    const exitPromise = Effect.runPromiseExit(
      askOnce.pipe(Effect.provide(JevClientWith({ apiKey: "k", fetch: hanging }))),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    const exit = await exitPromise;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
    }
  });

  test("malformed success envelope is protocol-kind and never retried", async () => {
    const { calls, fetch } = capturingFetch(() =>
      jsonResponse(200, { model: "jev-2026-08", answers: { route: { type: "choice", choice: "explode" } } }),
    );
    const exit = await Effect.runPromiseExit(
      askOnce.pipe(
        Effect.provide(JevClientWith({ apiKey: "k", fetch, retry: { backoffInitialMs: 1 } })),
      ),
    );
    expect(calls).toHaveLength(1);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as JevError;
      expect(error.kind).toBe("protocol");
    }
  });

  test("server error text echoing the API key is scrubbed (http kind)", async () => {
    const sentinel = "ts-live-secret-9f8e7d6c5b";
    const { calls, fetch } = capturingFetch(() =>
      jsonResponse(500, { detail: `upstream rejected bearer ${sentinel} twice: ${sentinel}` }),
    );
    const exit = await Effect.runPromiseExit(
      askOnce.pipe(
        Effect.provide(JevClientWith({ apiKey: sentinel, fetch, retry: { maxRetries: 0 } })),
      ),
    );
    expect(calls).toHaveLength(1);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as JevError;
      expect(error.kind).toBe("http");
      expect(error.status).toBe(500);
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect(error.message).toContain("[redacted]");
    }
  });

  test("connection error text echoing the API key is scrubbed (connection kind)", async () => {
    const sentinel = "ts-live-secret-1a2b3c4d5e";
    const failing: typeof globalThis.fetch = (() =>
      Promise.reject(
        new Error(`dial failed for Bearer ${sentinel}`),
      )) as unknown as typeof globalThis.fetch;
    const exit = await Effect.runPromiseExit(
      askOnce.pipe(
        Effect.provide(JevClientWith({ apiKey: sentinel, fetch: failing, retry: { maxRetries: 0 } })),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as JevError;
      expect(error.kind).toBe("connection");
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect(error.message).toContain("[redacted]");
    }
  });

  test("protocol failures scrub a key embedded in the malformed response", async () => {
    const sentinel = "ts-live-secret-6f7g8h9i0j";
    const { fetch } = capturingFetch(() =>
      jsonResponse(200, {
        model: "jev-2026-08",
        answers: { route: { type: "choice", choice: sentinel } },
      }),
    );
    const exit = await Effect.runPromiseExit(
      askOnce.pipe(Effect.provide(JevClientWith({ apiKey: sentinel, fetch }))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as JevError;
      expect(error.kind).toBe("protocol");
      expect(JSON.stringify(error)).not.toContain(sentinel);
    }
  });

  test("oversized requests fail pre-flight with a chunking hint and zero HTTP calls", async () => {
    const { calls, fetch } = capturingFetch(() => jsonResponse(200, okBody));
    const bigState = "x".repeat(200_000);
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const jev = yield* JevClient;
        return yield* jev.systemOne({ state: bigState, questions });
      }).pipe(Effect.provide(JevClientWith({ apiKey: "k", fetch }))),
    );
    expect(calls).toHaveLength(0);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as JevError;
      expect(error.kind).toBe("request");
      expect(error.message).toMatch(/split state into chunks/i);
    }
  });
});

describe("JevClientTest", () => {
  test("returns the registered answers without network", async () => {
    const result = await run(
      askOnce,
      JevClientTest(questions, okBody.answers as any, {
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    );
    expect(result.answers.route.choice).toBe("act");
    expect(result.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  test("fails calls whose questions differ from the registered contract", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const jev = yield* JevClient;
        return yield* jev.systemOne({
          state: "x",
          questions: { other: noul({ instructions: "different" }) },
        });
      }).pipe(Effect.provide(JevClientTest(questions, okBody.answers as any))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as JevError;
      expect(error.kind).toBe("request");
      expect(error.message).toMatch(/registered contract/);
    }
  });

  test("validates registered answers against the real result codec at construction", () => {
    expect(() =>
      JevClientTest(questions, {
        route: { type: "choice", choice: "not-a-label", confidence: 0.5, probabilities: { act: 1 } },
        readiness: okBody.answers.readiness,
        destructive: okBody.answers.destructive,
      } as any),
    ).toThrow();
  });

  test("rejects answers with excess properties (extra ids, extra probability labels)", () => {
    // Strict decode: a response carrying fields the request never asked for
    // is not an answer to that request — it must fail, not strip.
    expect(() =>
      JevClientTest(questions, {
        ...okBody.answers,
        unasked: { type: "noul" },
      } as any),
    ).toThrow();
    expect(() =>
      JevClientTest(questions, {
        ...okBody.answers,
        route: {
          ...okBody.answers.route,
          probabilities: { act: 0.5, wait: 0.4, invented: 0.1 },
        },
      } as any),
    ).toThrow();
  });
});
