/**
 * `prism jev ask`: a one-shot System One decision from the command line.
 *
 * Reads a JSON request envelope `{state, questions, model?}`, validates it
 * through the same presentation schema + request normalization the workflow
 * runner uses, executes it with the live `JevClient` (env configuration,
 * lazy API key), and prints the wire result `{model, answers, usage}` as
 * pretty JSON. The compiled jev plugin tool shells this command, so agents
 * and humans share exactly one implementation.
 *
 * Machine contract (what the tool depends on):
 * - Success: exit 0, exactly one JSON document on stdout.
 * - Handled failure: empty stdout, exit 1 (domain) or 2 (usage), and with
 *   `--json-errors` exactly one {@link JevAskErrorRecord} JSON document on
 *   stderr. Messages are diagnostic text, not parsing inputs; the `kind`
 *   field is the only classification a machine should read.
 */

import { Effect, Schema } from "effect";
import { EXIT_CODES, type ExitCode } from "./exit.js";
import { readFile } from "./fs.js";
import {
  JEV_STRICT_PARSE_OPTIONS,
  JevSystemOneInputSchema,
  parseJevRequest,
  type JevQuestions,
  type JevResult,
} from "./jev.js";
import {
  JEV_ERROR_KINDS,
  JevClient,
  JevClientLive,
  JevError,
  type JevClientService,
} from "./services/jev.js";

/**
 * Failure classification for `prism jev ask`, structured so the message text
 * never has to be parsed (question IDs and other user-controlled strings can
 * themselves contain "[jev:…]"):
 * - "usage": the --input argument itself is malformed (bad JSON, unreadable
 *   file, non-object payload). Caller-side fix.
 * - "request": the envelope failed presentation validation or semantic
 *   request validation — the same class the API reports as HTTP 400.
 * - every JevErrorKind: surfaced verbatim from the JevClient taxonomy.
 * - "internal": an unexpected failure inside this CLI.
 */
export const JEV_ASK_ERROR_KINDS = [
  "usage",
  "request",
  ...JEV_ERROR_KINDS,
  "internal",
] as const;
export type JevAskErrorKind = (typeof JEV_ASK_ERROR_KINDS)[number];

export interface JevAskFailure {
  readonly kind: JevAskErrorKind;
  readonly message: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class JevAskError extends Error {
  readonly kind = "jev-ask-error" as const;

  constructor(readonly failure: JevAskFailure) {
    super(`[jev:${failure.kind}] ${failure.message}`);
    this.name = "JevAskError";
  }

  /** CLI exit-code contract (src/exit.ts): malformed --input is usage (2); everything else is a domain failure (1). */
  get exitCode(): ExitCode {
    return this.failure.kind === "usage" ? EXIT_CODES.usage : EXIT_CODES.domainFailure;
  }
}

/** The `--json-errors` stderr record: a single versioned JSON document. */
export interface JevAskErrorRecord {
  readonly version: 1;
  readonly error: {
    readonly kind: JevAskErrorKind;
    readonly message: string;
    readonly httpStatus?: number;
    readonly retryAfterMs?: number;
  };
}

/**
 * Project any failure into the machine record. Only JevAskError carries a
 * classified kind; anything unexpected becomes "internal" — never a
 * fabricated API classification.
 */
export const jevAskErrorRecord = (error: unknown): JevAskErrorRecord => {
  const failure: JevAskFailure =
    error instanceof JevAskError
      ? error.failure
      : {
          kind: "internal",
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        };
  return {
    version: 1,
    error: {
      kind: failure.kind,
      message: failure.message,
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
    },
  };
};

/** Machine record for Commander parse failures (missing --input, invalid --timeout-ms). */
export const jevAskUsageRecord = (error: unknown): JevAskErrorRecord => ({
  version: 1,
  error: {
    kind: "usage",
    message: error instanceof Error ? error.message : String(error),
  },
});

/**
 * True when argv is a `jev ask` invocation carrying `--json-errors`. The
 * CLI's top-level Commander catch uses this to emit a usage record for parse
 * failures, which happen before the command action runs.
 */
export const isJevAskJsonErrorsArgv = (argv: readonly string[]): boolean =>
  argv[2] === "jev" && argv[3] === "ask" && argv.includes("--json-errors");

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Read the ask envelope: raw JSON text, or `@path` for a JSON file. */
export const parseJevAskInputText = async (raw: string): Promise<unknown> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new JevAskError({
      kind: "usage",
      message: "jev ask requires --input with a JSON object (or @path)",
    });
  }
  let jsonText = trimmed;
  if (trimmed.startsWith("@")) {
    try {
      jsonText = await readFile(trimmed.slice(1));
    } catch (error) {
      throw new JevAskError({
        kind: "usage",
        message: `failed to read --input file: ${errorMessage(error)}`,
        cause: error,
      });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new JevAskError({
      kind: "usage",
      message: `--input is not valid JSON: ${errorMessage(error)}`,
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JevAskError({
      kind: "usage",
      message: "jev ask input must be a JSON object shaped {state, questions, model?}",
    });
  }
  return parsed;
};

export interface JevAskOptions {
  /** Raw JSON text or `@path` to a JSON file describing {state, questions, model?}. */
  readonly input: string;
  /** Per-HTTP-attempt timeout override passed through to the SDK. */
  readonly timeoutMs?: number;
  /** Injection seam for tests; the CLI always leaves this unset (live env client). */
  readonly client?: JevClientService;
}

export const runJevAsk = async (options: JevAskOptions): Promise<JevResult<JevQuestions>> => {
  const raw = await parseJevAskInputText(options.input);

  // Envelope decode first (strict: excess fields are typos, not noise);
  // semantic request validation second. parseJevRequest performs entry
  // normalization and question validation before any HTTP call.
  let envelope: typeof JevSystemOneInputSchema.Type;
  try {
    envelope = Schema.decodeUnknownSync(JevSystemOneInputSchema)(
      raw,
      JEV_STRICT_PARSE_OPTIONS,
    );
  } catch (error) {
    throw new JevAskError({
      kind: "request",
      message: `jev ask input failed validation: ${errorMessage(error)}`,
      cause: error,
    });
  }

  const request = (() => {
    try {
      return parseJevRequest({
        state: envelope.state,
        questions: envelope.questions,
        ...(envelope.model !== undefined ? { model: envelope.model } : {}),
      });
    } catch (error) {
      throw new JevAskError({
        kind: "request",
        message: `jev ask request rejected: ${errorMessage(error)}`,
        cause: error,
      });
    }
  })();

  const program = Effect.flatMap(JevClient, (client) =>
    client.systemOne(request, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }));
  const runnable =
    options.client !== undefined
      ? Effect.provideService(program, JevClient, options.client)
      : Effect.provide(program, JevClientLive);

  try {
    return await Effect.runPromise(runnable);
  } catch (error) {
    if (error instanceof JevError) {
      throw new JevAskError({
        kind: error.kind,
        message: error.message,
        ...(error.status !== undefined ? { httpStatus: error.status } : {}),
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        cause: error,
      });
    }
    throw new JevAskError({
      kind: "internal",
      message: `jev ask failed: ${errorMessage(error)}`,
      cause: error,
    });
  }
};
