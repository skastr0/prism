/**
 * `prism jev ask`: a one-shot System One decision from the command line.
 *
 * Reads a JSON request envelope `{state, questions, model?}`, validates it
 * through the same presentation schema + request normalization the workflow
 * runner uses, executes it with the live `JevClient` (env configuration,
 * lazy API key), and prints the wire result `{model, answers, usage}` as
 * pretty JSON. The compiled jev plugin tool shells this command, so agents
 * and humans share exactly one implementation.
 */

import { Effect, Schema } from "effect";
import { EXIT_CODES, type ExitCode } from "./exit.js";
import { readFile } from "./fs.js";
import { parseJevRequest, JevSystemOneInputSchema, type JevResult, type JevQuestions } from "./jev.js";
import { JevClient, JevClientLive, JevError, type JevClientService } from "./services/jev.js";

/**
 * Exit codes follow the CLI contract (src/exit.ts): a malformed `--input`
 * argument is a usage error (2); envelope validation, semantic request
 * rejection, and Jev API failures are domain failures (1).
 */
export class JevAskError extends Error {
  readonly kind = "jev-ask-error" as const;

  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT_CODES.domainFailure,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JevAskError";
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Read the ask envelope: raw JSON text, or `@path` for a JSON file. */
export const parseJevAskInputText = async (raw: string): Promise<unknown> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new JevAskError(
      "jev ask requires --input with a JSON object (or @path)",
      EXIT_CODES.usage,
    );
  }
  let jsonText = trimmed;
  if (trimmed.startsWith("@")) {
    try {
      jsonText = await readFile(trimmed.slice(1));
    } catch (error) {
      throw new JevAskError(
        `failed to read --input file: ${errorMessage(error)}`,
        EXIT_CODES.usage,
        error,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new JevAskError(
      `--input is not valid JSON: ${errorMessage(error)}`,
      EXIT_CODES.usage,
      error,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JevAskError(
      "jev ask input must be a JSON object shaped {state, questions, model?}",
      EXIT_CODES.usage,
    );
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

  // Envelope decode first; semantic request validation second. parseJevRequest
  // performs entry normalization, question validation, and the pre-flight
  // token-budget guard before any HTTP call.
  let envelope: typeof JevSystemOneInputSchema.Type;
  try {
    envelope = Schema.decodeUnknownSync(JevSystemOneInputSchema)(raw);
  } catch (error) {
    throw new JevAskError(
      `jev ask input failed validation: ${errorMessage(error)}`,
      EXIT_CODES.domainFailure,
      error,
    );
  }

  const request = (() => {
    try {
      return parseJevRequest({
        state: envelope.state,
        questions: envelope.questions,
        ...(envelope.model !== undefined ? { model: envelope.model } : {}),
      });
    } catch (error) {
      throw new JevAskError(
        `jev ask request rejected: ${errorMessage(error)}`,
        EXIT_CODES.domainFailure,
        error,
      );
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
      // Keep the error taxonomy visible on stderr: configuration, request,
      // rate-limit, timeout, protocol.
      throw new JevAskError(
        `[jev:${error.kind}] ${error.message}`,
        EXIT_CODES.domainFailure,
        error,
      );
    }
    throw new JevAskError(
      `jev ask failed: ${errorMessage(error)}`,
      EXIT_CODES.domainFailure,
      error,
    );
  }
};
