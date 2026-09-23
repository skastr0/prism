/**
 * Amp runners, discovered on demand by
 * `prism workflow refresh-harness-types --discover-amp-runners` and used to
 * type and validate `worker.runnerId` / `worker.runnerDir` on `amp-runner`
 * tasks and named workers.
 *
 * Amp exposes no account-wide runner CLI command or REST route; the surface is
 * the `list_runners` platform tool inside an Amp thread (the same data the
 * ampcode.com thread composer's location picker shows). Discovery therefore
 * spends one small `amp -x --stream-json` turn and parses the list_runners
 * TOOL RESULT from the transcript — never the assistant's echoed text, which
 * can reformat or truncate the JSON.
 *
 * An old entry is valid: there are no staleness warnings, and Amp re-validates
 * `--executor runner:<id>` against live runners at spawn time.
 */

import { Schema } from "effect";

export const AMP_RUNNERS_REFRESH_COMMAND =
  "prism workflow refresh-harness-types --discover-amp-runners";

export interface AmpRunnerDirectory {
  readonly path: string;
  readonly repositoryURL?: string;
  readonly canCreateWorktree?: boolean;
}

export interface AmpRunner {
  readonly runnerId: string;
  readonly name: string;
  readonly hostname?: string;
  readonly workingDirectory?: string;
  readonly repositoryURL?: string;
  /** The runner's own last-seen timestamp from Amp, as reported. */
  readonly lastSeenAt: string;
  readonly capabilities: readonly string[];
  readonly directories: readonly AmpRunnerDirectory[];
}

export interface DiscoveredAmpRunners {
  readonly runners: readonly AmpRunner[];
  readonly source: "command" | "empty";
  /** When the one-shot capture ran (distinct from each runner's lastSeenAt). */
  readonly capturedAt?: string;
  readonly error?: string;
}

const ampRunnerDirectorySchema = Schema.Struct({
  path: Schema.String,
  repositoryURL: Schema.optional(Schema.NullOr(Schema.String)),
  canCreateWorktree: Schema.optional(Schema.Boolean),
});

/** Required: runnerId, lastSeenAt, directories. Upstream extras are ignored. */
const ampRunnerSchema = Schema.Struct({
  runnerId: Schema.String,
  lastSeenAt: Schema.String,
  directories: Schema.Array(ampRunnerDirectorySchema),
  name: Schema.optional(Schema.String),
  hostname: Schema.optional(Schema.String),
  workingDirectory: Schema.optional(Schema.String),
  repositoryURL: Schema.optional(Schema.NullOr(Schema.String)),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
});

const ampRunnersPayloadSchema = Schema.Struct({
  runners: Schema.Array(ampRunnerSchema),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** `list_runners` prompt: call the tool, then print its raw JSON and nothing else. */
export const AMP_RUNNERS_PROMPT =
  "Call the list_runners tool with no arguments. Then output exactly the JSON object it returned, with text(JSON.stringify(result)), and nothing else. Do not summarize, reformat, or omit any fields.";

/**
 * Sentinel the discovery runner emits when the amp turn itself failed, so the
 * reason survives the fail-soft string-only command contract.
 */
export const AMP_TURN_ERROR_PREFIX = "AMP_TURN_ERROR:";

/** JSON candidates hidden inside a tool_result's content (string, block array, or block). */
const candidateTexts = (content: unknown): readonly string[] => {
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    return content.flatMap((block) => {
      if (typeof block === "string") return [block];
      if (!isRecord(block)) return [];
      if (typeof block.text === "string") return [block.text];
      if (block.type === "tool_result") return candidateTexts(block.content);
      return [];
    });
  }
  return [];
};

/** The `{ runners: [...] }` payload inside one candidate text, if any. */
const extractRunnersPayload = (text: string): Record<string, unknown> | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(value)) {
    // A bare runner array (the agent printed the list without the wrapper).
    if (value.some((row) => isRecord(row) && typeof row.runnerId === "string")) return { runners: value };
    for (const block of value) {
      if (isRecord(block) && typeof block.text === "string") {
        const inner = extractRunnersPayload(block.text);
        if (inner !== undefined) return inner;
      }
    }
    return undefined;
  }
  return isRecord(value) && Array.isArray(value.runners) ? value : undefined;
};

type DecodedRunner = Schema.Schema.Type<typeof ampRunnerSchema>;

const normalizeDirectory = (row: DecodedRunner["directories"][number]): AmpRunnerDirectory | undefined => {
  const path = nonBlank(row.path);
  if (path === undefined) return undefined;
  const repositoryURL = nonBlank(row.repositoryURL);
  return {
    path,
    ...(repositoryURL !== undefined ? { repositoryURL } : {}),
    ...(typeof row.canCreateWorktree === "boolean" ? { canCreateWorktree: row.canCreateWorktree } : {}),
  };
};

const normalizeRunner = (row: DecodedRunner): AmpRunner | undefined => {
  const runnerId = nonBlank(row.runnerId);
  if (runnerId === undefined) return undefined;
  const directories = row.directories
    .map(normalizeDirectory)
    .filter((directory): directory is AmpRunnerDirectory => directory !== undefined);
  const unique = [...new Map(directories.map((directory) => [directory.path, directory])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  const name = nonBlank(row.name) ?? runnerId;
  const hostname = nonBlank(row.hostname);
  const workingDirectory = nonBlank(row.workingDirectory);
  const repositoryURL = nonBlank(row.repositoryURL);
  return {
    runnerId,
    name,
    ...(hostname !== undefined ? { hostname } : {}),
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    ...(repositoryURL !== undefined ? { repositoryURL } : {}),
    lastSeenAt: row.lastSeenAt,
    capabilities: row.capabilities ?? [],
    directories: unique,
  };
};

const decodeRunnersPayload = (payload: unknown): { readonly runners: AmpRunner[]; readonly dropped: number } => {
  const decoded = Schema.decodeUnknownSync(ampRunnersPayloadSchema)(payload) as { runners: readonly DecodedRunner[] };
  const runners: AmpRunner[] = [];
  let dropped = 0;
  for (const row of decoded.runners) {
    const runner = normalizeRunner(row);
    if (runner === undefined) dropped += 1;
    else runners.push(runner);
  }
  const unique = [...new Map(runners.map((runner) => [runner.runnerId, runner])).values()]
    .sort((left, right) => left.runnerId.localeCompare(right.runnerId));
  return { runners: unique, dropped };
};

/**
 * Parse the `amp -x <prompt> --stream-json` transcript: the list_runners tool
 * result only. Required fields fail closed through the Effect Schema decode;
 * upstream extras are ignored. Returns the discovery thread id so the caller
 * can delete it.
 */
export const parseAmpRunnersStreamJson = (
  stdout: string,
): { readonly runners: AmpRunner[]; readonly sessionId?: string; readonly error?: string } => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { runners: [], error: "amp -x --stream-json produced no output" };
  if (trimmed.startsWith(AMP_TURN_ERROR_PREFIX)) {
    return { runners: [], error: trimmed.slice(AMP_TURN_ERROR_PREFIX.length).trim() };
  }

  let sessionId: string | undefined;
  let decodeError: string | undefined;
  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (row.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(row);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    sessionId ??= nonBlank(event.session_id);
    // Only tool results carry trustworthy data; the assistant's echo can
    // reformat or truncate the JSON, so it is never a candidate.
    if (event.type !== "user") continue;
    const message = isRecord(event.message) ? event.message : event;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      for (const text of candidateTexts(block.content)) {
      const payload = extractRunnersPayload(text);
      if (payload === undefined) continue;
      try {
        const { runners, dropped } = decodeRunnersPayload(payload);
        if (runners.length === 0 && decodeError === undefined) {
          decodeError = dropped > 0
            ? `list_runners returned ${dropped} runner row(s) without a usable runnerId`
            : "list_runners returned no runners";
          continue;
        }
        return { runners, sessionId, ...(dropped > 0 ? { error: `skipped ${dropped} runner row(s) with a blank runnerId` } : {}) };
      } catch (cause) {
        decodeError = `list_runners result failed decode: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      }
    }
  }
  return {
    runners: [],
    sessionId,
    error: decodeError ?? "no list_runners tool result found in the amp -x --stream-json transcript",
  };
};

/** Sorted runner ids in the snapshot. Empty when discovery found none. */
export const ampRunnerIds = (discovered: DiscoveredAmpRunners | undefined): readonly string[] =>
  [...new Set((discovered?.runners ?? []).map((runner) => runner.runnerId))]
    .sort((left, right) => left.localeCompare(right));

const normalizeDir = (path: string): string => {
  const trimmed = path.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/u, "") : trimmed;
};

/** Sorted unique directories one runner serves. */
export const ampRunnerServedDirs = (runner: AmpRunner): readonly string[] =>
  [...new Set(runner.directories.map((directory) => normalizeDir(directory.path)))]
    .filter((path) => path.length > 0)
    .sort((left, right) => left.localeCompare(right));

const runnerLabel = (runner: AmpRunner): string =>
  runner.hostname !== undefined ? `${runner.runnerId} (${runner.hostname})` : runner.runnerId;

/**
 * Fail closed on an `amp-runner` target the snapshot does not know: an unknown
 * runnerId, or a runnerDir that runner does not serve. No snapshot, or one
 * without runners, leaves both a free string (the same fallback as every other
 * discovered union). `runnerDir` is optional: the runner's start directory.
 */
export const validateAmpRunnerTarget = (
  runnerId: string,
  runnerDir: string | undefined,
  discovered: DiscoveredAmpRunners | undefined,
): string | undefined => {
  const runners = discovered?.runners ?? [];
  if (runners.length === 0) return undefined;
  const runner = runners.find((candidate) => candidate.runnerId === runnerId)
    ?? (runners.filter((candidate) => candidate.runnerId.toLowerCase() === runnerId.toLowerCase()).length === 1
      ? runners.find((candidate) => candidate.runnerId.toLowerCase() === runnerId.toLowerCase())
      : undefined);
  if (runner === undefined) {
    const wanted = runnerId.toLowerCase();
    const nearby = runners.filter((candidate) => candidate.runnerId.toLowerCase() === wanted || candidate.name.toLowerCase() === wanted);
    const known = runners.map(runnerLabel).sort((left, right) => left.localeCompare(right));
    return [
      `Unknown Amp runner ${JSON.stringify(runnerId)} for worker 'amp-runner'.`,
      nearby.length > 0 ? `Did you mean ${nearby.map((candidate) => JSON.stringify(candidate.runnerId)).join(" or ")}?` : undefined,
      `Known runners: ${known.join(", ")}.`,
      `Fix: set worker.runnerId to one of them, start the runner with \`amp --no-tui --runner-id <id>\`, or run \`${AMP_RUNNERS_REFRESH_COMMAND}\` to snapshot the account-wide runners (costs one small Amp turn).`,
    ].filter((line): line is string => line !== undefined).join(" ");
  }
  if (runnerDir === undefined) return undefined;
  const served = ampRunnerServedDirs(runner);
  if (served.includes(normalizeDir(runnerDir))) return undefined;
  return [
    `Amp runner ${JSON.stringify(runner.runnerId)} does not serve ${JSON.stringify(runnerDir)}.`,
    `Served directories: ${served.length > 0 ? served.join(", ") : "(none)"}.`,
    runner.workingDirectory !== undefined
      ? `Its start directory is ${JSON.stringify(runner.workingDirectory)}; omit runnerDir to use it.`
      : undefined,
    `Fix: set worker.runnerDir to a directory this runner serves, or run \`${AMP_RUNNERS_REFRESH_COMMAND}\` to refresh the snapshot.`,
  ].filter((line): line is string => line !== undefined).join(" ");
};
