/**
 * Reference body: Jev (TypeSafe System One) decision tasks (0.7.0).
 * Product documentation, not plugin data. No frontmatter — the loader owns the
 * skill file; this module contributes one chapter of its body.
 */

export const JEV_REFERENCE_MARKDOWN = `# Jev decisions

A \`jev()\` task is a decision, not a worker dispatch: no prompt, no worker, no repair loop. It issues **one** TypeSafe System One request — a shared \`state\` plus many \`questions\` — and returns one typed answer per question id, with confidence and full probability distributions.

\`\`\`ts
import { jev } from "prism";

const triage = jev({
  id: "triage-tabs",
  cacheKey: "tab-triage-v1",
  state: {
    tabs: [
      { id: "t1", title: "Effect Schema v4 — README", note: "docs tab, referenced twice today" },
      { id: "t2", title: "github.com/skastr0/prism/pull/41", note: "open PR awaiting my review" },
    ],
  },
  questions: {
    t1_route: {
      type: "choice",
      instructions: "About state item t1 ('Effect Schema v4 — README')",
      criteria: { keep: "actively needed this week", park: "reference for later", close: null },
    },
    t2_route: {
      type: "choice",
      instructions: "About state item t2 ('…prism/pull/41')",
      criteria: { keep: "actively needed this week", park: "reference for later", close: null },
    },
    actionable_count: {
      type: "score",
      instructions: "Across ALL tabs in state, how many need concrete action this week?",
      criteria: ["none", "one or two", "three or more"],
    },
    any_credential_risk: {
      type: "noul",
      instructions: "Is any tab an authenticated console that should not linger open?",
      criteria: { true: "at least one authenticated console", false: "none" },
    },
  },
});
\`\`\`

| Field | Type | Semantics |
|---|---|---|
| \`id\` | \`string\` | Task identity inside the workflow. |
| \`state\` | one entry | The content every question is evaluated against. |
| \`questions\` | \`Record<string, JevQuestion>\` | At least one question; answers come back keyed by these ids. |
| \`model\` | \`string?\` | Per-task model override. |
| \`timeoutMs\` | \`number?\` | Per-HTTP-attempt timeout override. Not part of the cache address. |
| \`cacheKey\` | \`string?\` | Stable key for the durable cache; defaults to the task id. |

A jev task has no prompt, worker options, or finish criteria. An unsupported field is rejected when the task is built.

## The batching doctrine

Bundle every item into \`state\` and every question into the same request. Never fan out one call per item or per question. Batching is the platform idiom and the reason this task kind exists: one jev task replaces a fan-out of per-item worker calls.

## State

\`state\` is a single *entry*: a string, a JSON object/array, or \`null\`. A bare number or boolean at the top level is rejected at validation — serialize it (\`"3"\`). Numbers and booleans nested inside an object/array entry are fine. The same entry rule applies to a question's \`instructions\` and to \`criteria\` descriptions.

## Questions

| Type | Shape | Answer |
|---|---|---|
| \`choice\` | \`criteria\`: label → description; \`null\` leaves a label undescribed. At least one label. | \`{ choice, confidence, probabilities }\` — probabilities cover exactly your labels. |
| \`score\` | \`criteria\`: an ordered rubric array with at least two levels. | \`{ score, confidence, legend, probabilities }\` — \`score\` is an EXPECTED score between 0 and (levels − 1) that may fall between integer levels; \`legend\` echoes your criteria verbatim; use the threshold \`probabilities\` for a discrete verdict. |
| \`noul\` | yes/no presence; needs \`criteria\` \`{ true?, false? }\` or \`instructions\`. | \`{ noul }\` — 0–1, read as P(true). Noul has no separate confidence. |

Every question may carry \`instructions\`. **The question id does NOT bind the question to a state item** — pin the subject in \`instructions\`. Observed: unbound questions return flat guesses; bound questions answer at confidence 1.0.

## Decode is strict

Answers are keyed by your question ids and typed per question. Answer keys, choice labels, probability keys, and score legends all come from the request, so a response that adds or omits an answer key or label fails closed. Nothing is silently stripped.

Jev tasks have no judge criteria and no decode-repair loop: a contract mismatch is terminal for that task.

## Budget

A request targets **~28,000 estimated tokens** (state + questions, ~4 chars/token; the platform's documented ceiling is ~32,000). Over-budget requests fail pre-flight with a "split into chunks" hint. The remedy is to shard the **state** into sequential jev tasks with the same questions and merge answers — never split one logical question across requests.

\`WORKFLOW_JEV_CONCURRENCY\` (default 32) caps concurrent Jev calls per run. Excess calls queue and run as slots free; the limiter never fails work.

## Caching

A jev task's identity hash covers the resolved endpoint, the model, \`state\`, \`questions\`, and the result-contract version. Change anything and only that task re-executes. \`timeoutMs\` is deliberately not part of the address. Cache hits and resume replay are exact.

## Phases

Inside \`wf.phase\`, use \`ctx.jev({ id, questions, state, ... })\`. When the phase binds an input contract, the phase's typed \`input\` decodes the state once before the task is built, and the state is that decoded value — still subject to the entry rule above.

## Configuration

| Env | Effect |
|---|---|
| \`TYPESAFE_API_KEY\` | Required for a live request. |
| \`TYPESAFE_BASE_URL\` | Overrides the endpoint. |
| \`TYPESAFE_DEFAULT_MODEL\` | Overrides the default model. |

A workflow without jev tasks never touches credentials. Error messages are scrubbed of the configured API key even when an upstream diagnostic echoes it back.

## Failures

Failures surface as typed \`JevError\` kinds:

| Kind | Means |
|---|---|
| \`configuration\` | Missing or invalid \`TYPESAFE_API_KEY\`. |
| \`request\` | Local validation, the pre-flight token-budget guard, or API 400/422. |
| \`authentication\` | API 401 — check or rotate the key. |
| \`permission\` | API 403. |
| \`rate-limit\` | API 429; carries \`retryAfterMs\` when sent. |
| \`timeout\` | Transport timeout after SDK retries. |
| \`connection\` | Transport failure after SDK retries. |
| \`http\` | Any other non-2xx, including exhausted 5xx. |
| \`protocol\` | The response violated the result contract. |

## Ad hoc

\`\`\`bash
prism jev ask --input '{"state": …, "questions": …}' [--timeout-ms n] [--json-errors]
prism jev ask --input @request.json
\`\`\`

Success prints the wire result \`{ model, answers, usage }\` as JSON on stdout and exits 0. \`--input\` takes a JSON object or \`@path\` to a JSON file. On failure stdout is empty and the exit is 1 (domain) or 2 (usage); with \`--json-errors\` exactly one record goes to stderr:

\`\`\`json
{ "version": 1, "error": { "kind": "rate-limit", "message": "…", "httpStatus": 429, "retryAfterMs": 250 } }
\`\`\`

\`kind\` is the only field a machine should read — message text is diagnostic and may quote your own payload. In addition to the \`JevError\` kinds above, the CLI adds \`usage\` (the \`--input\` argument itself is malformed) and \`internal\` (an unexpected failure inside the CLI).

The \`jev/systemone_ask\` tool in the \`jev\` plugin and the workflow runner share this one implementation.
`;
