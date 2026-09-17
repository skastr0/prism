/**
 * Jev (TypeSafe System One) vocabulary for Prism: question constructors,
 * request validation/normalization, and request-correlated result codecs.
 *
 * This module is pure: no services, no environment access, no network. The
 * wire contract is verified against `@typesafe-ai/sdk` v0.6.0 (`src/types.ts`)
 * — these types are readonly mirrors of that contract, not a second
 * interpretation of System One.
 *
 * Terminology follows the SDK and docs.typesafe.ai verbatim:
 * - A *state* is the content evaluated (`EntryType`): string, JSON object,
 *   JSON array, or null — never a bare boolean/number at the top level.
 * - *Questions* are named, independent judgments over one shared state:
 *   `choice` (which option), `score` (which rubric level), `noul`
 *   (probability of yes). All questions in one request see the same state and
 *   are evaluated independently — batching many questions per request is the
 *   platform idiom (docs: 13 questions in one call = 12.2x cheaper, 10x
 *   faster, byte-identical answers).
 * - Answers are typed per question and constrained to the supplied criteria:
 *   choice `{choice, confidence, probabilities}`, score `{score, confidence,
 *   legend, probabilities}`, noul `{noul}`. Noul has no separate confidence.
 *
 * The request's token budget (~32k tokens, state and questions share it) is
 * enforced pre-flight by the service layer in `src/services/jev.ts`; this
 * module owns the estimator so tool handlers and workflows share one oracle.
 */

import { Schema } from "effect";

// ---------------------------------------------------------------------------
// JSON entry types (readonly mirrors of the SDK's JsonValue/EntryType)
// ---------------------------------------------------------------------------

/** Any JSON value. Readonly because decoded workflow data is readonly. */
export type JevJson =
  | null
  | boolean
  | number
  | string
  | readonly JevJson[]
  | { readonly [key: string]: JevJson };

/**
 * A System One entry: text, a JSON object or array, or null. Bare booleans
 * and numbers are excluded at the top level, matching the SDK's `EntryType`.
 */
export type JevEntry =
  | null
  | string
  | readonly JevJson[]
  | { readonly [key: string]: JevJson };

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** Choice labels mapped to descriptions (`null` leaves a label undescribed). */
export type JevChoiceCriteria = Readonly<Record<string, JevEntry>>;

/** An ordered rubric with at least two levels. */
export type JevScoreCriteria = readonly [JevEntry, JevEntry, ...JevEntry[]];

/** A question that selects between named alternatives. */
export interface JevChoiceQuestion<
  Criteria extends JevChoiceCriteria = JevChoiceCriteria,
> {
  readonly type: "choice";
  readonly instructions?: JevEntry;
  readonly criteria: Criteria;
}

/** A question that assigns an ordered-rubric score. */
export interface JevScoreQuestion<
  Criteria extends JevScoreCriteria = JevScoreCriteria,
> {
  readonly type: "score";
  readonly instructions?: JevEntry;
  readonly criteria: Criteria;
}

/** A yes/no question answered as a probability of yes. */
export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions?: JevEntry;
  readonly criteria?: {
    readonly true?: JevEntry;
    readonly false?: JevEntry;
  } | null;
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

/** Questions keyed by the author-chosen IDs identifying their answers. */
export type JevQuestions = Readonly<Record<string, JevQuestion>>;

// ---------------------------------------------------------------------------
// Results (typed per question; inference mirrors the SDK's ResultFor)
// ---------------------------------------------------------------------------

/** Rubric index keys for a concrete score criteria tuple. */
export type JevScoreKey<C extends JevScoreCriteria> = number extends C["length"]
  ? number
  : Extract<keyof C, `${number}`>;

/** The answer type for a question, preserving its criteria keys. */
export type JevResultFor<Q extends JevQuestion> = Q extends JevChoiceQuestion<infer C>
  ? {
      readonly type: "choice";
      // Wire labels are always strings: numeric criteria keys (JS object keys)
      // arrive stringified, so the answer's choice union stringifies them too.
      readonly choice: `${keyof C & (string | number)}`;
      readonly confidence: number;
      readonly probabilities: { readonly [K in keyof C]: number };
    }
  : Q extends JevScoreQuestion<infer C>
    ? {
        readonly type: "score";
        readonly score: number;
        readonly confidence: number;
        readonly legend: { readonly [K in JevScoreKey<C>]: C[K] };
        readonly probabilities: { readonly [K in JevScoreKey<C>]: number };
      }
    : Q extends JevNoulQuestion
      ? { readonly type: "noul"; readonly noul: number }
      : never;

/** Answers keyed by question ID, typed per question. */
export type JevAnswers<Q extends JevQuestions> = {
  readonly [K in keyof Q]: JevResultFor<Q[K]>;
};

/** Token usage for a request. */
export interface JevUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** The full System One result: answers with model and usage metadata. */
export interface JevResult<Q extends JevQuestions> {
  readonly model: string;
  readonly answers: JevAnswers<Q>;
  readonly usage: JevUsage;
}

/** State and named questions for one System One call. */
export interface JevRequest<Q extends JevQuestions = JevQuestions> {
  readonly state: JevEntry;
  readonly questions: Q;
  readonly model?: string;
}

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

export class JevRequestValidationError extends Error {
  override readonly name = "JevRequestValidationError";
  constructor(
    readonly reason: string,
    readonly path?: string,
  ) {
    super(`invalid jev request${path !== undefined ? ` at ${path}` : ""}: ${reason}`);
  }
}

// The variable-level annotation (not just a return annotation on the arrow)
// is what lets TypeScript's control-flow analysis treat `fail(...)` calls as
// never-returning in statement position.
const fail: (reason: string, path?: string) => never = (reason, path) => {
  throw new JevRequestValidationError(reason, path);
};

// ---------------------------------------------------------------------------
// Structural normalization: validate + deep-copy + deep-freeze
//
// This is normalization of already-typed authoring data, not boundary parsing:
// it guarantees the request used for identity hashing and the request sent to
// the API are the same immutable value. Schema codecs cannot deep-freeze, and
// a frozen copy is the point — an author mutating a questions object while
// its task is queued must never create a cache/identity split.
// ---------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

const isEntryValue = (value: unknown): boolean =>
  typeof value === "string" || isPlainObject(value) || Array.isArray(value);

const normalizeJson = (value: unknown, path: string, seen: ReadonlySet<object>): JevJson => {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`non-finite number ${String(value)}`, path);
    return value;
  }
  if (typeof value === "undefined") fail("`undefined` is not JSON; use `null`", path);
  if (typeof value === "function") fail("functions are not valid state/questions content", path);
  if (typeof value === "bigint") fail("bigint values are not valid JSON", path);
  if (typeof value === "symbol") fail("symbols are not valid JSON", path);
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("cyclic structures cannot be serialized or hashed", path);
    const nextSeen = new Set(seen).add(value);
    const items = value.map((item, index) => normalizeJson(item, `${path}[${index}]`, nextSeen));
    return Object.freeze(items);
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) fail("cyclic structures cannot be serialized or hashed", path);
    const nextSeen = new Set(seen).add(value);
    const entries = Object.entries(value).map(([key, item]) => [
      key,
      Object.prototype.hasOwnProperty.call(value, key) && item === undefined
        ? fail("`undefined` is not JSON; use `null`", `${path}.${key}`)
        : normalizeJson(item, `${path}.${key}`, nextSeen),
    ]);
    return Object.freeze(Object.fromEntries(entries));
  }
  fail("only plain JSON values are allowed (no class instances, Dates, Maps, …)", path);
};

/**
 * Validate a System One entry (state, instructions, criterion description),
 * returning a deep-frozen deep copy. Mirrors the SDK's `EntryType`: string,
 * plain JSON object/array, or null.
 */
export const normalizeJevEntry = (value: unknown, path = "state"): JevEntry => {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") {
    fail(`entry must be a string, JSON object/array, or null (got ${typeof value})`, path);
  }
  if (!isEntryValue(value)) {
    fail("entry must be a string, JSON object/array, or null", path);
  }
  return normalizeJson(value, path, new Set()) as JevEntry;
};

const normalizeQuestion = (question: unknown, path: string): JevQuestion => {
  if (!isPlainObject(question)) fail("question must be a plain object", path);
  const type = question.type;
  const allowedKeys = new Set(["type", "instructions", "criteria"]);
  for (const key of Object.keys(question)) {
    if (!allowedKeys.has(key)) fail(`unsupported question field '${key}'`, path);
  }
  const instructions =
    question.instructions === undefined
      ? undefined
      : normalizeJevEntry(question.instructions, `${path}.instructions`);

  if (type === "choice") {
    const criteria = question.criteria;
    if (!isPlainObject(criteria)) {
      fail("choice criteria must be an object mapping labels to descriptions", `${path}.criteria`);
    }
    const labels = Object.keys(criteria);
    if (labels.length === 0) fail("choice criteria must define at least one label", `${path}.criteria`);
    // No precheck: normalizeJevEntry is the sole entry validator, and an own
    // "__proto__" label must land as data, not as a [[Prototype]] write.
    const normalizedCriteria: Record<string, JevEntry> = Object.fromEntries(
      labels.map((label) => [
        label,
        normalizeJevEntry(criteria[label], `${path}.criteria.${label}`),
      ]),
    );
    return Object.freeze({
      type: "choice",
      ...(instructions !== undefined ? { instructions } : {}),
      criteria: Object.freeze(normalizedCriteria),
    });
  }

  if (type === "score") {
    const criteria = question.criteria;
    if (!Array.isArray(criteria)) {
      fail("score criteria must be an ordered rubric array", `${path}.criteria`);
    }
    if (criteria.length < 2) {
      fail("score criteria must describe at least two levels", `${path}.criteria`);
    }
    // No precheck: normalizeJevEntry is the sole entry validator (it accepts
    // null, so undescribed rubric levels are valid).
    const rubric = criteria.map((entry: unknown, index: number) =>
      normalizeJevEntry(entry, `${path}.criteria[${index}]`),
    );
    return Object.freeze({
      type: "score",
      ...(instructions !== undefined ? { instructions } : {}),
      criteria: Object.freeze(rubric) as unknown as JevScoreCriteria,
    });
  }

  if (type === "noul") {
    const criteria = question.criteria;
    if (criteria === undefined || criteria === null) {
      return Object.freeze({
        type: "noul",
        ...(instructions !== undefined ? { instructions } : {}),
        ...(criteria === null ? { criteria: null } : {}),
      });
    }
    if (!isPlainObject(criteria)) {
      fail("noul criteria must be `{ true?: …, false?: … }` or null", `${path}.criteria`);
    }
    for (const key of Object.keys(criteria)) {
      if (key !== "true" && key !== "false") {
        fail(`unsupported noul criteria key '${key}'`, `${path}.criteria`);
      }
    }
    const normalized: { true?: JevEntry; false?: JevEntry } = {};
    if (criteria.true !== undefined) {
      normalized.true = normalizeJevEntry(criteria.true, `${path}.criteria.true`);
    }
    if (criteria.false !== undefined) {
      normalized.false = normalizeJevEntry(criteria.false, `${path}.criteria.false`);
    }
    return Object.freeze({
      type: "noul",
      ...(instructions !== undefined ? { instructions } : {}),
      criteria: Object.freeze(normalized),
    });
  }

  fail(`unsupported question type ${JSON.stringify(type)} (expected choice, score, or noul)`, path);
};

/**
 * Validate a questions map and return a deep-frozen deep copy with the same
 * static type. At least one question is required.
 */
export const normalizeJevQuestions = <const Q extends JevQuestions>(questions: Q): Q => {
  if (!isPlainObject(questions)) fail("questions must be an object keyed by question id", "questions");
  const ids = Object.keys(questions);
  if (ids.length === 0) fail("at least one question is required", "questions");
  const normalized: Record<string, JevQuestion> = Object.fromEntries(
    ids.map((id) => [id, normalizeQuestion(questions[id], `questions.${id}`)]),
  );
  // Localized assertion: `normalized` preserves every id and per-id question
  // shape of Q by construction; only the runtime values changed (frozen copies).
  return Object.freeze(normalized) as Q;
};

/**
 * Validate and freeze a full request (state + questions + optional model).
 * Unexpected top-level fields are rejected rather than silently dropped so
 * worker-task fields (prompt/worker/finish) can never leak into a Jev call.
 */
export const normalizeJevRequest = <const Q extends JevQuestions>(request: JevRequest<Q>): JevRequest<Q> => {
  if (!isPlainObject(request)) fail("request must be a plain object", "request");
  for (const key of Object.keys(request)) {
    if (key !== "state" && key !== "questions" && key !== "model") {
      fail(`unsupported request field '${key}'`, "request");
    }
  }
  if (!("state" in request)) fail("request.state is required", "request");
  const model = request.model;
  if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
    fail("model must be a non-empty string when provided", "request.model");
  }
  return Object.freeze({
    state: normalizeJevEntry(request.state, "state"),
    questions: normalizeJevQuestions(request.questions),
    ...(model !== undefined ? { model } : {}),
  }) as JevRequest<Q>;
};

/** Decode an unknown value (e.g. tool CLI input) into a normalized request. */
export const parseJevRequest = (input: unknown): JevRequest<JevQuestions> =>
  normalizeJevRequest(input as JevRequest<JevQuestions>);

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

/**
 * Documented per-request token budget shared by state and questions
 * (docs.typesafe.ai: "around 32,000 tokens").
 */
export const JEV_TOKEN_BUDGET = 32_000;

/**
 * Soft target Prism enforces pre-flight. Below the hard budget so a request
 * that passes locally still fits after SDK serialization differences.
 */
export const JEV_TOKEN_REQUEST_TARGET = 28_000;

/**
 * Rough request token estimate: JSON payload characters / 4, the standard
 * heuristic. Used only for pre-flight guidance, never as billing data.
 */
export const estimateJevRequestTokens = (request: JevRequest<JevQuestions>): number =>
  Math.ceil(JSON.stringify(request).length / 4);

// ---------------------------------------------------------------------------
// Question constructors (thin tags; normalizeJevRequest is the validator)
// ---------------------------------------------------------------------------

export function choice<const C extends JevChoiceCriteria>(
  definition: Omit<JevChoiceQuestion<C>, "type">,
): JevChoiceQuestion<C> {
  return { type: "choice", ...definition };
}

export function score<const C extends JevScoreCriteria>(
  definition: Omit<JevScoreQuestion<C>, "type">,
): JevScoreQuestion<C> {
  return { type: "score", ...definition };
}

export function noul(
  definition: Omit<JevNoulQuestion, "type"> = {},
): JevNoulQuestion {
  return { type: "noul", ...definition };
}

// ---------------------------------------------------------------------------
// Result codec derivation
// ---------------------------------------------------------------------------

/**
 * Result contract version, folded into workflow identity hashing so a change
 * in these codecs invalidates cached outputs deliberately rather than
 * silently.
 */
export const JEV_RESULT_CONTRACT_VERSION = 1 as const;

const Probability = Schema.Number.pipe(
  Schema.check(Schema.isFinite()),
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
);

/** Confidence summarizes how peaked the distribution is, on a 0–1 scale. */
const Confidence = Probability;

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

const TokenCount = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
);

/**
 * Build a schema that accepts exactly one JSON literal value. Rubric entries
 * are echoed in score legends; validating them against the author's literal
 * value keeps `legend` honestly typed instead of `unknown`-with-a-cast.
 */
const jevLiteralSchema = (value: JevJson): Schema.Schema<unknown> => {
  if (value === null) return Schema.Null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Schema.Literal(value);
  }
  if (Array.isArray(value)) {
    return Schema.Tuple(value.map((entry) => jevLiteralSchema(entry)));
  }
  return Schema.Struct(
    Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jevLiteralSchema(entry)])),
  );
};

const choiceAnswerSchema = (criteria: JevChoiceCriteria): Schema.Schema<unknown> => {
  const labels = Object.keys(criteria);
  return Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.Literals(labels as [string, ...Array<string>]),
    confidence: Confidence,
    probabilities: Schema.Struct(
      Object.fromEntries(labels.map((label) => [label, Probability])),
    ),
  });
};

const scoreAnswerSchema = (criteria: JevScoreCriteria): Schema.Schema<unknown> => {
  const lastIndex = criteria.length - 1;
  return Schema.Struct({
    type: Schema.Literal("score"),
    // The expected score may fall between integer rubric levels.
    score: Schema.Number.pipe(
      Schema.check(Schema.isFinite()),
      Schema.check(Schema.isBetween({ minimum: 0, maximum: lastIndex })),
    ),
    confidence: Confidence,
    legend: Schema.Struct(
      Object.fromEntries(criteria.map((entry, index) => [String(index), jevLiteralSchema(entry)])),
    ),
    probabilities: Schema.Struct(
      Object.fromEntries(criteria.map((_entry, index) => [String(index), Probability])),
    ),
  });
};

const noulAnswerSchema = (): Schema.Schema<unknown> =>
  Schema.Struct({
    type: Schema.Literal("noul"),
    noul: Probability,
  });

const answerSchemaFor = (question: JevQuestion): Schema.Schema<unknown> => {
  switch (question.type) {
    case "choice":
      return choiceAnswerSchema(question.criteria);
    case "score":
      return scoreAnswerSchema(question.criteria);
    case "noul":
      return noulAnswerSchema();
  }
};

/** A service-free codec for the full request-correlated System One result. */
export type JevResultCodec<Q extends JevQuestions> = Schema.Codec<
  JevResult<Q>,
  JevResult<Q>,
  never,
  never
>;

/**
 * Derive the result codec for a questions map. Answer keys, choice labels,
 * probability keys, and score legends all come from the request, so a
 * response disagreeing with its own questions fails decode.
 *
 * Localized assertion: the struct is built from runtime key maps whose key
 * sets provably equal `keyof Q` / the criteria keys (same construction loop
 * as `normalizeJevQuestions`), but TypeScript cannot see through
 * `Object.fromEntries`; the cast maps the runtime struct onto
 * `JevResultCodec<Q>`. Covered by runtime decode tests and dsl-type tests.
 */
export const jevResultSchema = <const Q extends JevQuestions>(questions: Q): JevResultCodec<Q> => {
  const normalized = normalizeJevQuestions(questions);
  const answersFields = Object.fromEntries(
    Object.entries(normalized).map(([id, question]) => [id, answerSchemaFor(question)]),
  );
  const schema = Schema.Struct({
    model: NonEmptyString,
    answers: Schema.Struct(answersFields),
    usage: Schema.Struct({
      input_tokens: TokenCount,
      output_tokens: TokenCount,
    }),
  });
  return schema as unknown as JevResultCodec<Q>;
};

// ---------------------------------------------------------------------------
// Probe results (workflow validation, never a live call)
// ---------------------------------------------------------------------------

export const JEV_PROBE_MODEL = "jev-probe";

const probeAnswerFor = (question: JevQuestion): unknown => {
  switch (question.type) {
    case "choice": {
      // `Object.keys` enumeration order is the stable "first": integer-like
      // labels enumerate numerically, the rest in insertion order.
      const labels = Object.keys(question.criteria);
      const selected = labels[0]!;
      return {
        type: "choice",
        choice: selected,
        confidence: 1,
        probabilities: Object.fromEntries(
          labels.map((label) => [label, label === selected ? 1 : 0]),
        ),
      };
    }
    case "score":
      return {
        type: "score",
        score: 0,
        confidence: 1,
        legend: Object.fromEntries(
          question.criteria.map((entry, index) => [String(index), entry]),
        ),
        probabilities: Object.fromEntries(
          question.criteria.map((_entry, index) => [String(index), index === 0 ? 1 : 0]),
        ),
      };
    case "noul":
      return { type: "noul", noul: 0 };
  }
};

/**
 * A deterministic, schema-valid System One result used by workflow validation
 * probes, where no live API call is made: every answer selects the first
 * declared criterion (score index 0, noul 0) with a concentrated probability
 * distribution, so branch-sensitive `run:` graphs walk the same stable path on
 * every probe. Always decodes against `jevResultSchema(questions)`. This is a
 * witness, not a simulation of what System One would answer.
 */
export const jevProbeResult = <const Q extends JevQuestions>(questions: Q): JevResult<Q> => {
  const normalized = normalizeJevQuestions(questions);
  const answers = Object.fromEntries(
    Object.entries(normalized).map(([id, question]) => [id, probeAnswerFor(question)]),
  );
  return {
    model: JEV_PROBE_MODEL,
    answers: answers as JevResult<Q>["answers"],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
};

// ---------------------------------------------------------------------------
// Tool presentation schemas (nonrecursive; the decoder above stays authority)
//
// These exist for the compiled tool surface (JSON-schema bridges cannot render
// recursive entry types). They describe the envelope honestly — entry slots
// are `Unknown` — and `parseJevRequest` / the JevClient service perform the
// real semantic validation before any HTTP call.
// ---------------------------------------------------------------------------

const ChoiceQuestionPresentation = Schema.Struct({
  type: Schema.Literal("choice"),
  instructions: Schema.optionalKey(Schema.Unknown),
  criteria: Schema.Record(Schema.String, Schema.Unknown),
});

const ScoreQuestionPresentation = Schema.Struct({
  type: Schema.Literal("score"),
  instructions: Schema.optionalKey(Schema.Unknown),
  criteria: Schema.Array(Schema.Unknown).pipe(Schema.check(Schema.isMinLength(2))),
});

const NoulCriteriaPresentation = Schema.Struct({
  true: Schema.optionalKey(Schema.Unknown),
  false: Schema.optionalKey(Schema.Unknown),
});

const NoulQuestionPresentation = Schema.Struct({
  type: Schema.Literal("noul"),
  instructions: Schema.optionalKey(Schema.Unknown),
  criteria: Schema.optionalKey(Schema.NullOr(NoulCriteriaPresentation)),
});

export const JevQuestionPresentation = Schema.Union([
  ChoiceQuestionPresentation,
  ScoreQuestionPresentation,
  NoulQuestionPresentation,
]);

export const JevSystemOneInputSchema = Schema.Struct({
  state: Schema.Unknown,
  questions: Schema.Record(Schema.String, JevQuestionPresentation),
  model: Schema.optionalKey(Schema.String),
});

/**
 * Jev decode boundaries fail on excess properties rather than stripping
 * them: a misspelled question field (`instruction` vs `instructions`) must
 * not silently vanish from the request, and an answer with extra IDs or
 * probability labels is not a response to the request that was sent. The
 * presentation/result schemas below describe Records partly (probability
 * maps are `Record(String, Number)`), so only struct-level strictness takes
 * effect — the request-correlated literal keys do the rest.
 */
export const JEV_STRICT_PARSE_OPTIONS = {
  onExcessProperty: "error" as const,
};

const ChoiceAnswerPresentation = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  confidence: Schema.Number,
  probabilities: Schema.Record(Schema.String, Schema.Number),
});

const ScoreAnswerPresentation = Schema.Struct({
  type: Schema.Literal("score"),
  score: Schema.Number,
  confidence: Schema.Number,
  legend: Schema.Record(Schema.String, Schema.Unknown),
  probabilities: Schema.Record(Schema.String, Schema.Number),
});

const NoulAnswerPresentation = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Number,
});

export const JevSystemOneResultSchema = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(
    Schema.String,
    Schema.Union([ChoiceAnswerPresentation, ScoreAnswerPresentation, NoulAnswerPresentation]),
  ),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
  }),
});
