import { Either, Schema } from "effect";

export const WorkflowContinuationAdapterIdSchema = Schema.Literal(
  "amp-code",
  "antigravity-cli",
  "claude-code",
  "codex-cli",
  "devin",
  "grok-cli",
  "hermes",
  "kimi-code",
  "opencode-cli",
  "omp-cli",
);
export type WorkflowContinuationAdapterId = typeof WorkflowContinuationAdapterIdSchema.Type;

export const WorkflowContinuationWorkerIdSchema = Schema.Literal(
  "amp-code",
  "antigravity-cli",
  "claude-code",
  "codex-cli",
  "devin",
  "grok",
  "hermes",
  "kimi-code",
  "opencode",
  "omp",
);
export type WorkflowContinuationWorkerId = typeof WorkflowContinuationWorkerIdSchema.Type;

export const StableSessionIdSchema = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand("StableSessionId"),
);
export type StableSessionId = typeof StableSessionIdSchema.Type;

export const WorkflowStableSessionSchema = Schema.Struct({
  adapter: WorkflowContinuationAdapterIdSchema,
  sessionId: StableSessionIdSchema,
});
export type WorkflowStableSession = typeof WorkflowStableSessionSchema.Type;

export const WorkflowHarnessContinuationSupportSchema = Schema.Union(
  Schema.Struct({
    adapter: WorkflowContinuationAdapterIdSchema,
    workflowWorker: Schema.Boolean,
    stableSessionIds: Schema.Literal(true),
    exactSameSessionContinuation: Schema.Literal(true),
    sessionIdField: Schema.Literal("sessionId"),
    continueCommand: Schema.NonEmptyTrimmedString,
    capture: Schema.NonEmptyTrimmedString,
  }),
  Schema.Struct({
    adapter: WorkflowContinuationAdapterIdSchema,
    workflowWorker: Schema.Boolean,
    stableSessionIds: Schema.Literal(false),
    exactSameSessionContinuation: Schema.Literal(false),
    sessionIdField: Schema.Literal("sessionId"),
    reason: Schema.NonEmptyTrimmedString,
  }),
);
export type WorkflowHarnessContinuationSupport = typeof WorkflowHarnessContinuationSupportSchema.Type;

export const workflowContinuationAdapterByWorker = {
  "amp-code": "amp-code",
  "antigravity-cli": "antigravity-cli",
  "claude-code": "claude-code",
  "codex-cli": "codex-cli",
  devin: "devin",
  grok: "grok-cli",
  hermes: "hermes",
  "kimi-code": "kimi-code",
  opencode: "opencode-cli",
  omp: "omp-cli",
} as const satisfies Record<WorkflowContinuationWorkerId, WorkflowContinuationAdapterId>;
export type WorkflowRepairLoopContinuationWorkerId = keyof typeof workflowContinuationAdapterByWorker;
export type WorkflowRepairLoopContinuationCapability =
  | "stable-session-repair-loop"
  | "no-repair-loop-continuation";
export type WorkflowRepairLoopContinuationCapabilityForWorker<Worker extends string> =
  Worker extends WorkflowRepairLoopContinuationWorkerId
    ? "stable-session-repair-loop"
    : "no-repair-loop-continuation";

export const workflowHarnessContinuationSupport = {
  "amp-code": {
    adapter: "amp-code",
    workflowWorker: true,
    stableSessionIds: true,
    exactSameSessionContinuation: true,
    sessionIdField: "sessionId",
    continueCommand: "amp threads continue <sessionId> --execute <prompt>",
    capture: "stream-json session_id, local thread metadata, or threads list/search recovery",
  },
  "antigravity-cli": {
    adapter: "antigravity-cli",
    workflowWorker: true,
    stableSessionIds: true,
    exactSameSessionContinuation: true,
    sessionIdField: "sessionId",
    continueCommand: "agy --conversation <sessionId> --print <prompt>",
    capture: "conversation id from agy print metadata, cache, database, or log recovery",
  },
  "claude-code": {
    adapter: "claude-code",
    workflowWorker: true,
    stableSessionIds: true,
    exactSameSessionContinuation: true,
    sessionIdField: "sessionId",
    continueCommand: "claude --resume <sessionId> --print <prompt>",
    capture: "stream-json session_id",
  },
  "codex-cli": {
    adapter: "codex-cli",
    workflowWorker: true,
    stableSessionIds: true,
    exactSameSessionContinuation: true,
    sessionIdField: "sessionId",
    continueCommand: "codex exec resume <sessionId> <prompt>",
    capture: "session_meta payload id, rollout JSONL, app-server metadata, or session index recovery",
  },
  "grok-cli": {
    adapter: "grok-cli",
    workflowWorker: true,
    stableSessionIds: true,
    exactSameSessionContinuation: true,
    sessionIdField: "sessionId",
    continueCommand: "grok -r <sessionId> <prompt>",
    capture: "json sessionId, sessions list/search, or session export recovery",
  },
  hermes: {
    adapter: "hermes",
    workflowWorker: true,
    stableSessionIds: true,
    exactSameSessionContinuation: true,
    sessionIdField: "sessionId",
    continueCommand: "hermes chat --resume <sessionId> --query <prompt>",
    capture: "chat stderr session_id",
  },
  "kimi-code": {
    adapter: "kimi-code",
    workflowWorker: true,
    stableSessionIds: true,
    exactSameSessionContinuation: true,
    sessionIdField: "sessionId",
    continueCommand: "kimi --session <sessionId> --prompt <prompt>",
    capture: "stream-json session.resume_hint.session_id or session index recovery",
  },
  devin: {
    adapter: "devin",
    workflowWorker: true,
    stableSessionIds: true,
    exactSameSessionContinuation: true,
    sessionIdField: "sessionId",
    continueCommand: "devin -p -r <sessionId> --prompt-file <prompt>",
    capture: "ATIF export session_id via --export",
  },
  "opencode-cli": {
    adapter: "opencode-cli",
    workflowWorker: true,
    stableSessionIds: true,
    exactSameSessionContinuation: true,
    sessionIdField: "sessionId",
    continueCommand: "opencode run -s <sessionId> <prompt>",
    capture: "json step_start sessionID, session list, export, database, or log recovery",
  },
  "omp-cli": {
    adapter: "omp-cli",
    workflowWorker: true,
    stableSessionIds: true,
    exactSameSessionContinuation: true,
    sessionIdField: "sessionId",
    continueCommand: "omp --mode json --resume <sessionId> -- <prompt>",
    capture: "json session event id",
  },
} as const satisfies Record<WorkflowContinuationAdapterId, WorkflowHarnessContinuationSupport>;

const decodeAdapter = (value: unknown): WorkflowContinuationAdapterId | undefined => {
  const result = Schema.decodeUnknownEither(WorkflowContinuationAdapterIdSchema)(value);
  return Either.isRight(result) ? result.right : undefined;
};

export const stableSessionIdFromUnknown = (value: unknown): StableSessionId | undefined => {
  const result = Schema.decodeUnknownEither(StableSessionIdSchema)(value);
  return Either.isRight(result) ? result.right : undefined;
};

export const workflowContinuationAdapterForWorker = (
  worker: string,
): WorkflowContinuationAdapterId | undefined => {
  const result = Schema.decodeUnknownEither(WorkflowContinuationWorkerIdSchema)(worker);
  return Either.isRight(result) ? workflowContinuationAdapterByWorker[result.right] : undefined;
};

export const workflowContinuationSupportForAdapter = (
  adapter: string | undefined,
): WorkflowHarnessContinuationSupport | undefined => {
  const decoded = decodeAdapter(adapter);
  return decoded === undefined ? undefined : workflowHarnessContinuationSupport[decoded];
};

export const workflowAdapterFromMetadata = (
  metadata: Record<string, unknown> | undefined,
): WorkflowContinuationAdapterId | undefined =>
  decodeAdapter(metadata?.adapter);

export const workflowStableSessionFromMetadata = (
  metadata: Record<string, unknown> | undefined,
): WorkflowStableSession | undefined => {
  const adapter = workflowAdapterFromMetadata(metadata);
  if (adapter === undefined) return undefined;
  const sessionId = stableSessionIdFromUnknown(metadata?.sessionId)
    ?? stableSessionIdFromUnknown(metadata?.sessionID)
    ?? stableSessionIdFromUnknown(metadata?.session_id)
    ?? stableSessionIdFromUnknown(metadata?.externalSessionPointer);
  return sessionId === undefined ? undefined : { adapter, sessionId };
};

export const normalizeWorkflowSessionMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (metadata === undefined) return undefined;
  const session = workflowStableSessionFromMetadata(metadata);
  if (session === undefined) return metadata;
  const { sessionID: _sessionID, session_id: _sessionIdSnake, externalSessionPointer: _externalSessionPointer, ...rest } = metadata;
  return {
    ...rest,
    adapter: session.adapter,
    sessionId: session.sessionId,
  };
};

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const stableSessionIdFromRecordKeys = (
  value: unknown,
  keys: ReadonlyArray<string>,
): StableSessionId | undefined => {
  const object = objectValue(value);
  if (object === undefined) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = stableSessionIdFromRecordKeys(item, keys);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  }
  for (const key of keys) {
    const decoded = stableSessionIdFromUnknown(object[key]);
    if (decoded !== undefined) return decoded;
  }
  for (const nested of Object.values(object)) {
    const decoded = stableSessionIdFromRecordKeys(nested, keys);
    if (decoded !== undefined) return decoded;
  }
  return undefined;
};

export const stableSessionIdFromJsonLines = (
  text: string,
  keys: ReadonlyArray<string> = ["sessionId", "sessionID", "session_id", "conversationId", "conversation_id", "threadId", "thread_id"],
): StableSessionId | undefined => {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const decoded = stableSessionIdFromRecordKeys(parsed, keys);
      if (decoded !== undefined) return decoded;
    } catch {
      // Ignore non-JSON logging lines.
    }
  }
  return undefined;
};

export const stableSessionIdFromRegex = (
  text: string,
  patterns: ReadonlyArray<RegExp>,
): StableSessionId | undefined => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const decoded = stableSessionIdFromUnknown(match?.[1]);
    if (decoded !== undefined) return decoded;
  }
  return undefined;
};
