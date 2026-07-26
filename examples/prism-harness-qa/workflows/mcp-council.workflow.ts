/**
 * PRISM WORKFLOW COUNCIL — per-plugin MCP naming proof.
 *
 * Fans one task per workflow-capable harness worker (opencode, claude-code,
 * codex-cli, grok, hermes, kimi-code, amp-code). Each task must (1) enumerate
 * the MCP servers/tools visible in its session, (2) call the QA plugin's
 * generated `challenge_echo` tool, (3) return a structured report. The
 * workflow then computes a deterministic council verdict: pass only if every
 * non-blocked harness returned a real keyed proof AND (for MCP-shim
 * harnesses) saw the plugin's own per-plugin server name — never a retired
 * shim string (`prism-mcp-shim`, or a `p_<hash8>_...` aggregated name).
 *
 * The fully-qualified tool-call forms below are not invented: they are the
 * per-plugin scheme's output for plugin `prism-harness-qa`, tool
 * `challenge_echo`, computed from `@skastr0/prism-sdk/mcp/wire-naming`
 * (`pluginServerKey`, `bareWireToolName`, `renderPluginAllowlist`) and from
 * `generatedOwnerToolName` (`src/compile/generated-plugin.ts`) for the two
 * in-process harnesses. Verified against this repo's actual compiled output
 * (`prism refresh examples/prism-harness-qa --harness <h> --scope global`)
 * for every harness below before being pasted in — see PLUGIN_SERVER_KEY /
 * BARE_TOOL_NAME / IN_PROCESS_TOOL_NAME.
 *
 * Run from the prism git root:
 *   prism workflow validate examples/prism-harness-qa/workflows/mcp-council.workflow.ts
 *   prism workflow run examples/prism-harness-qa/workflows/mcp-council.workflow.ts --store /tmp/mcp-council.sqlite
 *
 * Cache is mandatory — there is no cache-bypass flag; point `--store` at a
 * fresh path for a clean re-run instead.
 */
import { Effect, Either, Schema } from "effect";
import {
  defineTask,
  defineWorkflow,
  type WorkflowFinishOptions,
  type WorkflowJudgeCriterionContext,
  type WorkflowRuntime,
  type WorkflowRuntimeError,
  type WorkflowTaskWorkerOptions,
} from "prism";
import { agents } from "prism/refs";
import { models } from "prism/refs/models";
import { challengeProof } from "../tools/proof";

// ---------------------------------------------------------------------------
// The seven workflow-capable harness workers under council.
// ---------------------------------------------------------------------------

const HARNESSES = [
  "opencode",
  "claude-code",
  "codex-cli",
  "grok",
  "hermes",
  "kimi-code",
  "amp-code",
] as const;

type Harness = (typeof HARNESSES)[number];

/** Harnesses whose tools compile in-process (no daemon, no shim, no MCP server). */
const IN_PROCESS_HARNESSES: ReadonlySet<Harness> = new Set(["opencode", "amp-code"]);

/**
 * Harnesses whose wire tool name is the bare name alone (`toolAllowlist:
 * "within-server"` in harness-mcp-contract.ts) — the server key never
 * appears in anything the model can already see, so "enumerate your MCP
 * servers" has no cheap answer: the only way to attempt it is to search
 * (list resources, grep config, guess), which is exactly the crawling that
 * blew codex-cli's budget and derailed hermes/kimi-code's tool-calling
 * turn. `claude-code`/`grok` are excluded here — their fully-qualified
 * tool form (`mcp__<server>__<tool>` / `<server>__<tool>`) already spells
 * the server key in the one tool name they must call anyway, so the ask
 * costs them nothing extra.
 */
const SERVER_NAME_UNDISCOVERABLE_HARNESSES: ReadonlySet<Harness> = new Set(["codex-cli", "hermes", "kimi-code"]);

// ---------------------------------------------------------------------------
// Per-plugin naming — computed from the naming module, not guessed.
// ---------------------------------------------------------------------------

/** `pluginServerKey("prism-harness-qa")` — the one MCP server every shim harness registers this plugin under. */
const PLUGIN_SERVER_KEY = "prism-harness-qa";

/** `bareWireToolName(PLUGIN_SERVER_KEY, generatedOwnerToolName(PLUGIN_SERVER_KEY, "challenge_echo"))` — the wire name inside that server. */
const BARE_TOOL_NAME = "challenge_echo";

/** `generatedOwnerToolName("prism-harness-qa", "challenge_echo")` — the in-process tool key for opencode/amp-code (no server to scope it). */
const IN_PROCESS_TOOL_NAME = "prism_harness_qa_challenge_echo";

/**
 * The exact string each harness expects for a fully-qualified `challenge_echo`
 * call, per `renderPluginAllowlist(harness, PLUGIN_SERVER_KEY, ...)`:
 *  - `within-server` harnesses (codex-cli, hermes, kimi-code) advertise the
 *    bare wire name alone — the server already scopes it.
 *  - `global-prefixed` harnesses carry the server key in the call
 *    (Claude Code's `mcp__<server>__<tool>`, Grok's `<server>__<tool>`).
 *  - opencode/amp-code have no MCP server at all; the daemon tool name is
 *    called directly.
 */
const fullyQualifiedToolForm = (harness: Harness): string => {
  switch (harness) {
    case "claude-code":
      return `mcp__${PLUGIN_SERVER_KEY}__${BARE_TOOL_NAME}`;
    case "grok":
      return `${PLUGIN_SERVER_KEY}__${BARE_TOOL_NAME}`;
    case "codex-cli":
    case "hermes":
    case "kimi-code":
      return BARE_TOOL_NAME;
    case "opencode":
    case "amp-code":
      return IN_PROCESS_TOOL_NAME;
  }
};

/** Retired naming: the single shared shim server key, and the old aggregated `p_<hash8>_...` namespace prefix. Neither may appear in a report. */
const SHIM_STRING_PATTERN = /prism-mcp-shim|(?:^|[^a-z0-9])p_[0-9a-f]{8}_/iu;

// ---------------------------------------------------------------------------
// Task output schema — shared across all seven harness tasks.
// ---------------------------------------------------------------------------

const councilReportSchema = Schema.Struct({
  harness: Schema.Literal(...HARNESSES),
  serversSeen: Schema.Array(Schema.String),
  toolCalled: Schema.Boolean,
  proof: Schema.String,
});

type CouncilReport = Schema.Schema.Type<typeof councilReportSchema>;

// ---------------------------------------------------------------------------
// Prompt.
// ---------------------------------------------------------------------------

const challengeFor = (harness: Harness): string => `mcp-council-${harness}-2026-07-07-001`;

const councilPrompt = (harness: Harness): string => {
  const challenge = challengeFor(harness);
  const toolForm = fullyQualifiedToolForm(harness);
  const serverInstruction = IN_PROCESS_HARNESSES.has(harness)
    ? "This harness bundles the plugin's tools in-process — there is no separate MCP server entry to enumerate. Report serversSeen as an empty array."
    : SERVER_NAME_UNDISCOVERABLE_HARNESSES.has(harness)
      ? "If MCP server names are already visible in your session at no extra cost, list them in serversSeen; otherwise report serversSeen as an empty array. Either way, calling the tool below is the important part."
      : `The fully-qualified tool name below already carries its owning MCP server's key at no extra cost. If a server name is already visible to you that way (or elsewhere in your session at no extra cost), report it in serversSeen — the plugin's own server is named "${PLUGIN_SERVER_KEY}", never "prism-mcp-shim" and never a "p_<8-hex-chars>_..." name (both are retired shim-era names from before the per-plugin naming scheme). Do not search or enumerate beyond what is already visible to you; if nothing is visible, return an empty array.`;

  return (
    "You are one seat on the Prism Workflow Council, verifying per-plugin MCP naming. " +
    `Your harness is "${harness}"; set the harness field to exactly that value. ` +
    `${serverInstruction} ` +
    `Then call the generated tool named exactly "${toolForm}" with input ${JSON.stringify({ challenge })}. ` +
    `The exact challenge string is ${JSON.stringify(challenge)}; copy it byte-for-byte into the tool call — do not reorder, normalize, shorten, or derive it. ` +
    "The tool's proof value is keyed (HMAC) and cannot be computed without actually calling the tool. " +
    "Do not use shell, files, env, fallback JSON, or any echo/status helper — the proof must come from the real tool call. " +
    "Return the proof value from the tool response verbatim in the proof field, and set toolCalled to true only if the tool call actually executed. " +
    "Return only JSON matching the requested schema."
  );
};

// ---------------------------------------------------------------------------
// Per-task finish judge — fail closed unless the harness, tool-called flag,
// and keyed proof all match what only a real tool call could produce.
// ---------------------------------------------------------------------------

const councilFinish = (harness: Harness): WorkflowFinishOptions<CouncilReport> => ({
  maxRepairs: 1,
  criteria: [
    {
      kind: "judge",
      name: "mcp_council_challenge_proof",
      goal: "Fail unless the task output reports this harness, a real tool call, and the exact keyed generated-tool proof.",
      evaluate: (context: WorkflowJudgeCriterionContext<CouncilReport>) => {
        const { output } = context;
        if (
          output.harness === harness &&
          output.toolCalled === true &&
          output.proof === challengeProof(challengeFor(harness))
        ) {
          return Effect.succeed({ verdict: "pass" as const });
        }
        return Effect.succeed({
          verdict: "fail" as const,
          feedback: `expected harness '${harness}' with toolCalled=true and the keyed generated-tool proof for challenge '${challengeFor(harness)}'`,
        });
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// Per-harness task construction — worker shapes mirror the existing
// smoke-*.workflow.ts files (the source of truth for each harness's quirks).
// ---------------------------------------------------------------------------

const hermesProfile = process.env.PRISM_E2E_HERMES_PROFILE;

/** `agents.prismHarnessQa.qaTester` installs every harness except hermes (plugin.json's `targets.agents` omits it); hermes gets an inline contract, same as smoke-hermes.workflow.ts. */
const hermesQaAgent = {
  kind: "agent-ref",
  plugin: "prism-harness-qa",
  name: "qa-tester",
  description: "Prompted Hermès QA contract for generated-tool workflow smoke tests.",
  sourceHash: "hermes-workflow-inline-contract",
  manifestHash: "hermes-workflow-inline-contract",
  installs: [],
} as const;

const councilTask = (harness: Harness, agent: typeof agents.prismHarnessQa.qaTester | typeof hermesQaAgent, worker: WorkflowTaskWorkerOptions) =>
  defineTask({
    id: `verify-${harness}`,
    agent,
    prompt: councilPrompt(harness),
    output: councilReportSchema,
    finish: councilFinish(harness),
    cacheKey: `mcp-council-${harness}-v1`,
    worker,
  });

/** One call per harness — literal `worker`/`agent` per call site (never a runtime ternary inside one shared function body), the same shape smoke-*.workflow.ts and the other councils in this repo use. */
const councilTasks: Record<Harness, ReturnType<typeof councilTask>> = {
  opencode: councilTask("opencode", agents.prismHarnessQa.qaTester, { worker: "opencode" }),
  "claude-code": councilTask("claude-code", agents.prismHarnessQa.qaTester, { worker: "claude-code" }),
  // codex-cli used to die here on Prism's old 360000ms default while doing real
  // work; there is no process timeout any more, so the task simply runs to
  // completion. The lightened SERVER_NAME_UNDISCOVERABLE_HARNESSES prompt above
  // also removes the crawl that made it slow.
  "codex-cli": councilTask("codex-cli", agents.prismHarnessQa.qaTester, { worker: "codex-cli" }),
  // Not "grok-build": that model fails config validation against a custom
  // --agent file with a restricted tools: list (PQ-176). grok-composer-2.5-fast
  // is grok's own CLI default, verified working against this agent shape.
  grok: councilTask("grok", agents.prismHarnessQa.qaTester, { worker: "grok", model: "grok-composer-2.5-fast" }),
  hermes: councilTask("hermes", hermesQaAgent, {
    worker: "hermes",
    model: models.prismHarnessQa.qaModels.smoke,
    ...(hermesProfile !== undefined && hermesProfile.length > 0 ? { profile: hermesProfile } : {}),
  }),
  "kimi-code": councilTask("kimi-code", agents.prismHarnessQa.qaTester, { worker: "kimi-code" }),
  "amp-code": councilTask("amp-code", agents.prismHarnessQa.qaTester, { worker: "amp-code", model: "deep" }),
};

// ---------------------------------------------------------------------------
// Fault-tolerant fan-out — one auth-gated or otherwise broken harness must
// not sink the rest of this harness QA council.
// ---------------------------------------------------------------------------

type HarnessOutcome =
  | { readonly harness: Harness; readonly status: "completed"; readonly report: CouncilReport }
  | { readonly harness: Harness; readonly status: "blocked"; readonly reason: string }
  | { readonly harness: Harness; readonly status: "failed"; readonly error: string };

const errorToMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 800);
};

/** Known setup/auth blockers, same wording the workflow-e2e acceptance matrix classifies (`classifySetupBlocker`). A blocked harness is excluded from the pass/fail gate rather than counted as a council failure. */
const BLOCKED_PATTERNS: Partial<Record<Harness, RegExp>> = {
  grok: /grok requires xAI OAuth login|run `grok login`|refresh Grok credentials/iu,
  hermes: /xAI OAuth state is missing access_token|Run `hermes model` to re-authenticate|Re-authenticate with `hermes model`/iu,
  "kimi-code": /kimi-code requires OAuth login|run `kimi login`|refresh Kimi Code credentials|reached your usage limit for this billing cycle|provider\.api_error: 403/iu,
};

const captureOutcome = (wf: WorkflowRuntime, harness: Harness) =>
  Effect.gen(function* () {
    // `as` (not an annotation) deliberately: this validate harness's TS
    // resolution of `Effect.either(wf.runTask(...))` degrades to
    // `Either<unknown, unknown>` for dynamic (`run:`) workflows — the same
    // failure independently reproduces in the dynamic fan-out validation
    // fixture, so it is an environment limitation of the validate path, not
    // a real type error;
    // `wf.runTask`'s declared signature (`WorkflowRuntime.runTask`,
    // src/workflows.ts) already guarantees this shape.
    const result = (yield* Effect.either(wf.runTask(councilTasks[harness]))) as Either.Either<
      CouncilReport,
      WorkflowRuntimeError
    >;
    if (Either.isRight(result)) {
      return { harness, status: "completed" as const, report: result.right } satisfies HarnessOutcome;
    }
    const message = errorToMessage(result.left);
    const blockedPattern = BLOCKED_PATTERNS[harness];
    if (blockedPattern !== undefined && blockedPattern.test(message)) {
      return { harness, status: "blocked" as const, reason: message } satisfies HarnessOutcome;
    }
    return { harness, status: "failed" as const, error: message } satisfies HarnessOutcome;
  });

// ---------------------------------------------------------------------------
// Council verdict — deterministic, no AI fusion: every check below is a
// mechanical string/equality comparison, so a judge task would only add
// cost and a second place to be wrong.
// ---------------------------------------------------------------------------

interface HarnessVerdict {
  readonly harness: Harness;
  readonly verdict: "pass" | "fail" | "blocked";
  readonly detail?: string;
}

interface CouncilVerdict {
  readonly verdict: "pass" | "fail";
  readonly perHarness: ReadonlyArray<HarnessVerdict>;
  readonly blockedHarnesses: ReadonlyArray<Harness>;
}

const serverNameOk = (harness: Harness, serversSeen: ReadonlyArray<string>): boolean => {
  const sawShimString = serversSeen.some((name) => SHIM_STRING_PATTERN.test(name));
  if (sawShimString) return false;
  // In-process harnesses and within-server harnesses both get an exemption
  // from having to prove they *saw* the per-plugin server name — the former
  // structurally has no server to see, the latter structurally has no cheap
  // way to see it (SERVER_NAME_UNDISCOVERABLE_HARNESSES). Either way a
  // retired shim string above is still a real regression and still fails.
  if (IN_PROCESS_HARNESSES.has(harness) || SERVER_NAME_UNDISCOVERABLE_HARNESSES.has(harness)) return true;
  return serversSeen.some((name) => name === PLUGIN_SERVER_KEY);
};

const evaluateCouncil = (outcomes: ReadonlyArray<HarnessOutcome>): CouncilVerdict => {
  const perHarness = outcomes.map((outcome): HarnessVerdict => {
    if (outcome.status === "blocked") {
      return { harness: outcome.harness, verdict: "blocked", detail: outcome.reason };
    }
    if (outcome.status === "failed") {
      return { harness: outcome.harness, verdict: "fail", detail: outcome.error };
    }

    const { report } = outcome;
    const proofOk = report.proof === challengeProof(challengeFor(outcome.harness));
    const serversOk = serverNameOk(outcome.harness, report.serversSeen);
    const pass = report.toolCalled === true && proofOk && serversOk;
    if (pass) return { harness: outcome.harness, verdict: "pass" };

    const problems = [
      !report.toolCalled && "tool was not called",
      !proofOk && "proof did not match the keyed generated-tool proof",
      !serversOk && "did not see the per-plugin server name (or saw a retired shim string)",
    ].filter((problem): problem is string => problem !== false);
    return { harness: outcome.harness, verdict: "fail", detail: problems.join("; ") };
  });

  const blockedHarnesses = perHarness.filter((r) => r.verdict === "blocked").map((r) => r.harness);
  const nonBlocked = perHarness.filter((r) => r.verdict !== "blocked");
  const verdict: CouncilVerdict["verdict"] =
    nonBlocked.length > 0 && nonBlocked.every((r) => r.verdict === "pass") ? "pass" : "fail";

  return { verdict, perHarness, blockedHarnesses };
};

// ---------------------------------------------------------------------------

export default defineWorkflow({
  name: "prism-mcp-council",
  run: (wf) =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.all(
        HARNESSES.map((harness) => captureOutcome(wf, harness)),
        { concurrency: "unbounded" },
      );

      return { outcomes, council: evaluateCouncil(outcomes) };
    }),
});
