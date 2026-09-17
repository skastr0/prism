/**
 * JevClient — the Effect service behind first-class Jev (TypeSafe System One)
 * decisions in Prism workflows and Prism tools (GLYPH-JEV-03).
 *
 * One implementation serves both surfaces: the workflow runner's native Jev
 * executor (src/workflow-jev.ts) and the compiled `jev/systemone_ask` tool
 * (~/prism-plugins/jev) call this service; nothing else knows the SDK exists.
 *
 * Design contract:
 * - Credentials and endpoints are captured once, when the layer is built.
 *   `JevClientLive` reads TYPESAFE_API_KEY / TYPESAFE_BASE_URL /
 *   TYPESAFE_DEFAULT_MODEL; `JevClientWith` takes explicit options and never
 *   consults the environment.
 * - The TypeSafeClient is constructed lazily on the first live call, because
 *   its constructor throws when the API key is missing. Importing this module,
 *   compiling plugins, validating workflows, and replaying cached outputs must
 *   never require credentials.
 * - The SDK owns transport retry (408/429/5xx, backoff, Retry-After). Prism
 *   adds no second retry layer; `timeoutMs` is per HTTP attempt, matching the
 *   SDK.
 * - SDK logging is forced off: SDK debug logs can include request/response
 *   bodies, i.e. workflow state. Prism telemetry is the bounded channel.
 * - `APIUserAbortError` maps to Effect interruption (the only abort source is
 *   the Effect-provided signal); every other SDK error maps to a tagged
 *   `JevError.kind`. Raw SDK errors are never rethrown or serialized — they
 *   can carry response bodies.
 * - Pre-flight budget guard: requests estimated above
 *   `JEV_TOKEN_REQUEST_TARGET` fail `kind: "request"` with a chunking hint
 *   instead of a raw API 400 — agent callers can act on that message.
 */

import { Context, Effect, Layer, Result, Schema } from "effect";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  UnprocessableEntityError,
  type Fetch as SdkFetch,
  type RetryPolicy as SdkRetryPolicy,
} from "@typesafe-ai/sdk";
import {
  estimateJevRequestTokens,
  JEV_TOKEN_REQUEST_TARGET,
  jevResultSchema,
  JevRequestValidationError,
  normalizeJevQuestions,
  normalizeJevRequest,
  type JevAnswers,
  type JevQuestions,
  type JevRequest,
  type JevResult,
  type JevUsage,
} from "../jev.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const JEV_ERROR_KINDS = [
  "configuration",
  "request",
  "authentication",
  "permission",
  "rate-limit",
  "timeout",
  "connection",
  "http",
  "protocol",
] as const;

/**
 * - `configuration`: missing/invalid client configuration (missing API key).
 * - `request`: the request itself was rejected — local validation, the
 *   pre-flight token-budget guard, or API 400/422.
 * - `authentication` / `permission`: API 401/403.
 * - `rate-limit`: API 429 (carries `retryAfterMs` when the server sent one).
 * - `timeout` / `connection`: transport failures after SDK retries exhaust.
 * - `http`: any other non-2xx API error, including exhausted 5xx.
 * - `protocol`: a nominally successful response failed the request-correlated
 *   result contract (malformed envelope, answer/key mismatch). Terminal and
 *   never repairable by re-asking the model.
 */
export type JevErrorKind = (typeof JEV_ERROR_KINDS)[number];

export class JevError extends Schema.TaggedError<JevError>()("JevError", {
  kind: Schema.Literals(JEV_ERROR_KINDS),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  retryAfterMs: Schema.optionalKey(Schema.Number),
  sdkErrorName: Schema.optionalKey(Schema.String),
}) {}

/** Internal marker so APIUserAbortError becomes interruption, not failure. */
class JevSdkAbort extends Schema.TaggedError<JevSdkAbort>()("JevSdkAbort", {}) {}

const sdkErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toJevError = (cause: unknown): JevError | JevSdkAbort => {
  // Order matters: APITimeoutError extends APIConnectionError.
  if (cause instanceof APIUserAbortError) return new JevSdkAbort({});
  if (cause instanceof APITimeoutError) {
    return new JevError({
      kind: "timeout",
      message: `jev request timed out after ${cause.timeoutMs}ms (per-attempt)`,
      sdkErrorName: cause.name,
    });
  }
  if (cause instanceof APIConnectionError) {
    return new JevError({
      kind: "connection",
      message: `jev request failed to connect: ${sdkErrorMessage(cause)}`,
      sdkErrorName: cause.name,
    });
  }
  if (cause instanceof BadRequestError || cause instanceof UnprocessableEntityError) {
    return new JevError({
      kind: "request",
      message: `jev request rejected (${cause.status}): ${sdkErrorMessage(cause)}`,
      status: cause.status,
      sdkErrorName: cause.name,
    });
  }
  if (cause instanceof AuthenticationError) {
    return new JevError({
      kind: "authentication",
      message: "jev authentication failed (check TYPESAFE_API_KEY)",
      status: cause.status,
      sdkErrorName: cause.name,
    });
  }
  if (cause instanceof PermissionDeniedError) {
    return new JevError({
      kind: "permission",
      message: "jev permission denied for the configured API key",
      status: cause.status,
      sdkErrorName: cause.name,
    });
  }
  if (cause instanceof RateLimitError) {
    return new JevError({
      kind: "rate-limit",
      message: "jev rate limit exceeded after SDK retries",
      status: cause.status,
      ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
      sdkErrorName: cause.name,
    });
  }
  if (cause instanceof APIError) {
    return new JevError({
      kind: "http",
      message: `jev api error (${cause.status}): ${sdkErrorMessage(cause)}`,
      status: cause.status,
      sdkErrorName: cause.name,
    });
  }
  if (cause instanceof TypeSafeError) {
    return new JevError({
      kind: "request",
      message: `jev sdk error: ${sdkErrorMessage(cause)}`,
      sdkErrorName: cause.name,
    });
  }
  return new JevError({
    kind: "http",
    message: `jev request failed: ${sdkErrorMessage(cause)}`,
  });
};

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_JEV_MODEL = "jev-latest";

/** Non-secret resolved configuration, safe for identity hashing and logs. */
export interface JevPublicConfig {
  readonly baseURL: string;
  readonly defaultModel: string;
}

export interface JevCallOptions {
  /** Per-HTTP-attempt timeout override, passed through to the SDK. */
  readonly timeoutMs?: number;
}

export interface JevClientShape {
  readonly config: JevPublicConfig;
  readonly systemOne: <const Q extends JevQuestions>(
    request: JevRequest<Q>,
    options?: JevCallOptions,
  ) => Effect.Effect<JevResult<Q>, JevError>;
}

export class JevClient extends Context.Service<JevClient, JevClientShape>()(
  "prism/JevClient",
) {}

export type JevClientService = JevClient["Service"];

export interface JevClientOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly defaultModel?: string;
  readonly fetch?: SdkFetch;
  /** SDK retry override (transport-level only). */
  readonly retry?: Partial<SdkRetryPolicy>;
  /** SDK per-attempt timeout override in milliseconds. */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

const normalizeBaseUrl = (value: string | undefined): string => {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return DEFAULT_JEV_BASE_URL;
  return trimmed.replace(/\/+$/, "");
};

const normalizeModel = (value: string | undefined): string => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? DEFAULT_JEV_MODEL : trimmed;
};

const normalizeApiKey = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/**
 * The SDK's wire types use mutable JSON arrays/objects; Prism's authoring
 * types are readonly and frozen. A JSON round-trip produces a fresh, plain,
 * mutable payload and removes the impedance mismatch provably — the request
 * was validated as JSON-safe by `normalizeJevRequest` already.
 */
const toSdkWire = (request: JevRequest<JevQuestions>) =>
  JSON.parse(JSON.stringify(request)) as {
    state: Parameters<TypeSafeClient["systemOne"]>[0]["state"];
    questions: Parameters<TypeSafeClient["systemOne"]>[0]["questions"];
  };

const makeJevClientShape = (options: {
  readonly apiKey?: string;
  readonly config: JevPublicConfig;
  readonly fetch?: SdkFetch;
  readonly retry?: Partial<SdkRetryPolicy>;
  readonly timeoutMs?: number;
}): JevClientShape => {
  const { config } = options;
  // Lazily built: TypeSafeClient's constructor throws without an API key, and
  // service construction must stay credential-free.
  let client: TypeSafeClient | undefined;

  const requireClient = (): Effect.Effect<TypeSafeClient, JevError> =>
    Effect.suspend(() => {
      if (client !== undefined) return Effect.succeed(client);
      if (options.apiKey === undefined) {
        return Effect.fail(
          new JevError({
            kind: "configuration",
            message:
              "TYPESAFE_API_KEY is not set; jev requires it only for a live request " +
              "(import, compile, validation, and cache replay work without it)",
          }),
        );
      }
      return Effect.try({
        try: () => {
          const built = new TypeSafeClient({
            apiKey: options.apiKey,
            baseURL: config.baseURL,
            defaultModel: config.defaultModel,
            // SDK debug logging can include request/response bodies (workflow
            // state). Prism telemetry is the bounded channel.
            logLevel: "off",
            ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
            ...(options.retry !== undefined ? { retry: options.retry } : {}),
            ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
          });
          client = built;
          return built;
        },
        catch: (cause) =>
          new JevError({
            kind: "configuration",
            message: `failed to configure the jev client: ${sdkErrorMessage(cause)}`,
            sdkErrorName: cause instanceof Error ? cause.name : undefined,
          }),
      });
    });

  const systemOne = Effect.fn("JevClient.systemOne")(function* <const Q extends JevQuestions>(
    request: JevRequest<Q>,
    callOptions?: JevCallOptions,
  ): Effect.fn.Return<JevResult<Q>, JevError> {
    const normalized = yield* Effect.try({
      try: () => normalizeJevRequest(request),
      catch: (cause) =>
        new JevError({
          kind: "request",
          message: cause instanceof JevRequestValidationError ? cause.message : String(cause),
        }),
    });

    const estimatedTokens = estimateJevRequestTokens(normalized);
    if (estimatedTokens > JEV_TOKEN_REQUEST_TARGET) {
      return yield* Effect.fail(
        new JevError({
          kind: "request",
          message:
            `jev request is ~${estimatedTokens} tokens, above the ${JEV_TOKEN_REQUEST_TARGET}-token ` +
            "pre-flight target (API budget ~32000 shared by state and questions). " +
            "Split state into chunks and ask the same questions per chunk in parallel calls.",
        }),
      );
    }

    const http = yield* requireClient();
    const wire = toSdkWire(normalized);
    const raw = yield* Effect.tryPromise({
      try: (signal) =>
        http.systemOne(
          {
            state: wire.state,
            questions: wire.questions,
            // Resolved explicitly so the effective model never depends on SDK
            // env fallback at call time; identity hashing uses the same value.
            model: normalized.model ?? config.defaultModel,
          },
          {
            signal,
            ...(callOptions?.timeoutMs !== undefined ? { timeout: callOptions.timeoutMs } : {}),
          },
        ),
      catch: toJevError,
    }).pipe(Effect.catchTag("JevSdkAbort", () => Effect.interrupt));

    // Treat the SDK's cast-typed success as untrusted: validate against the
    // request-correlated contract before any caller sees it.
    return yield* Effect.fromResult(Schema.decodeUnknownResult(jevResultSchema(normalized.questions))(
      raw,
    )).pipe(
      Effect.mapError(
        (failure) =>
          new JevError({
            kind: "protocol",
            message: `jev response failed the result contract for these questions: ${failure.message}`,
          }),
      ),
    );
  });

  return { config, systemOne };
};

/**
 * Live layer: captures the TYPESAFE_* environment once at build; the API key
 * is only required when a live call is made.
 */
export const JevClientLive: Layer.Layer<JevClient> = Layer.sync(JevClient, () =>
  makeJevClientShape({
    apiKey: normalizeApiKey(process.env.TYPESAFE_API_KEY),
    config: {
      baseURL: normalizeBaseUrl(process.env.TYPESAFE_BASE_URL),
      defaultModel: normalizeModel(process.env.TYPESAFE_DEFAULT_MODEL),
    },
  }),
);

/**
 * Explicit-config layer; never reads environment variables. Missing optional
 * settings fall back to documented non-secret defaults.
 */
export const JevClientWith = (options: JevClientOptions): Layer.Layer<JevClient> =>
  Layer.sync(JevClient, () =>
    makeJevClientShape({
      apiKey: normalizeApiKey(options.apiKey),
      config: {
        baseURL: normalizeBaseUrl(options.baseURL),
        defaultModel: normalizeModel(options.defaultModel),
      },
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.retry !== undefined ? { retry: options.retry } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }),
  );

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

export interface JevClientTestOptions {
  readonly model?: string;
  readonly usage?: JevUsage;
  /** Override the public config observed by identity/telemetry code. */
  readonly config?: JevPublicConfig;
}

const TEST_JEV_BASE_URL = "https://jev.test";
const TEST_JEV_MODEL = "jev-test";

/**
 * Stub layer for tests: answers a registered questions contract from memory.
 * The registered answers are validated at construction against the real
 * result codec, so a malformed stub fails the test that wrote it, not the
 * system under test. Calls with a different questions map fail
 * `kind: "request"`. Never touches network or environment.
 */
export const JevClientTest = <const Q extends JevQuestions>(
  questions: Q,
  answers: JevAnswers<Q>,
  options?: JevClientTestOptions,
): Layer.Layer<JevClient> => {
  // Eager validation: a malformed stub must fail the test that wrote it, at
  // construction — not later, decoupled, when some run builds the layer.
  const registeredQuestions = normalizeJevQuestions(questions);
  const validatedAnswers = Schema.decodeUnknownSync(jevResultSchema(registeredQuestions))({
    model: options?.model ?? TEST_JEV_MODEL,
    answers,
    usage: options?.usage ?? { input_tokens: 0, output_tokens: 0 },
  });
  const registeredFingerprint = JSON.stringify(registeredQuestions);
  return Layer.sync(JevClient, () => {

    const systemOne: JevClientShape["systemOne"] = Effect.fnUntraced(function* <const R extends JevQuestions>(
      request: JevRequest<R>,
      _callOptions?: JevCallOptions,
    ): Effect.fn.Return<JevResult<R>, JevError> {
      const normalized = yield* Effect.try({
        try: () => normalizeJevRequest(request),
        catch: (cause) =>
          new JevError({
            kind: "request",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      // Key order is significant: normalize preserves author order, and both
      // sides of this comparison come from the same normalization rules.
      if (JSON.stringify(normalized.questions) !== registeredFingerprint) {
        return yield* Effect.fail(
          new JevError({
            kind: "request",
            message:
              "JevClientTest received questions that do not match its registered contract",
          }),
        );
      }
      return validatedAnswers as unknown as JevResult<R>;
    });

    return {
      config: options?.config ?? { baseURL: TEST_JEV_BASE_URL, defaultModel: TEST_JEV_MODEL },
      systemOne,
    };
  });
};
