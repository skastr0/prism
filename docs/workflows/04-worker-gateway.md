# 04 — Worker Gateway and Harness Adapters

The gateway is the only component that touches provider processes. Everything
above it sees one contract; everything below it is per-harness mechanics,
**live-verified before being trusted** (every claim in this doc marked
`verified` was executed on 2026-06-11).

## Worker classes

| Class | Identity source | Gate level | Examples |
|---|---|---|---|
| **A — attested** | prism-compiled agent installed in the harness root | provenance + attestation + policy subsumption | Claude Code, Grok CLI, Codex, Antigravity |
| **B — declared** | runtime-registered endpoint descriptor | typed I/O + budget + ledger/event rows; provenance recorded as `declared` | Hermes profiles, future raw-API/SDK workers |

The ledger records the attestation level on every `gate_passed` event. A
workflow mixing classes is normal and visible — never silently equivalent.

## Adapter contract

```typescript
interface WorkerAdapter {
  readonly harness: WorkerTarget;            // "claude-code" | "grok" | "codex-cli" | "antigravity-cli" | "hermes" | ...
  readonly capabilities: WorkerCapabilities; // fail-closed matrix, see below
  dispatch(req: TaskRequest): Effect<TaskResult, DispatchError, Scope>;
}

interface WorkerCapabilities {
  agentSelection: "installed-artifact" | "named" | "projection" | "profile";
  structuredOutput: "native-schema" | "prompted";   // runtime ALWAYS re-validates regardless
  fork: "seed" | "provider-copy" | "continue" | "none";
  sandbox: "native" | "flag-gated" | "none";        // "none" requires explicit danger opt-in per task
  effort: boolean;                                   // supports effort/reasoning level
  costReporting: "full" | "tokens" | "none";
  concurrencySafe: boolean;                          // false ⇒ adapter-level mutex (e.g. local-db lock races)
}
```

Fail-closed rule (from omegacode, kept): a task requesting something the
adapter cannot honestly provide is **rejected at the gate with the remedy named**
— never silently degraded. Example: parallel forks of one source on a
`fork: "continue"` harness; or `sandbox: none` without
`dangerouslyAllowFullAccess: true` on the task.

`fork: "seed"` is the portable baseline: the runtime starts a fresh provider
session and supplies source AgentRun outputs/transcript excerpts as ordinary
context. It preserves source immutability and works even when the harness has no
native session fork. `provider-copy` means the harness can create a copy of the
source session without mutating it. `continue` means mutating resume and is only
allowed under an exclusive lock.

## Per-harness adapters

### Claude Code — class A `native-agent surface verified`

- Dispatch: `claude -p <prompt> --agent prism-generated-<plugin>:<name>
  --output-format json` (or `stream-json` for live transcripts).
- Agent selection: installed plugin agent by namespaced name.
- Structured output: `--json-schema` flag exists; treat as `native-schema` once
  live-verified (WS3 task), `prompted` until then. Re-validate regardless.
- Telemetry: best in class — result envelope carries cost USD, token usage,
  session id, permission denials, num_turns. Map straight into `task_output`.
- Fork: `--resume <sessionId> --fork-session` ⇒ `provider-copy`. Session id captured
  from the result envelope.
- Sandbox: permission system native; agent's compiled permissions already
  installed.

### Grok CLI — class A `native-agent verified`

- Current dispatch: `grok --model <model> --agent <agent-name> --cwd <cwd>
  --no-alt-screen --output-format plain --prompt-file <prompt-file>`. This
  intentionally does **not** set `--max-turns`; the CLI owns task completion.
- Agent selection: native `--agent` binding is live for generated Prism agent
  refs. A real Survey `source-scout` workflow smoke proved `adapter: grok-cli`,
  `nativeAgent: source-scout`, and `model: grok-build` in the task metadata.
- Structured output: `prompted` (extract + decode + retry). Investigate
  `-p` JSON content blocks for a native lane (WS3).
- Fork: `--resume <sessionId>` exists; copy-vs-continue semantics unverified —
  matrix says `none` until verified.
- `grok agent stdio` exists for a future persistent-session adapter.

### Codex — class A via projection `verified`

- No `exec --agent`; `[agents.*]` config is collab-mode. Adapter reads the
  prism-compiled `~/.codex/agents/<name>.toml` (developer_instructions, model,
  scoped MCP grants) and projects: `codex exec --skip-git-repo-check
  --sandbox <mode> -c model=<m> --output-last-message <f> [--output-schema <schema.json>]
  "<agent-identity>...</agent-identity>\n\n<prompt>"`.
- Structured output: `native-schema` — `--output-schema` takes a JSON Schema
  file; generate it from the task's Effect Schema (see below).
- Fork: `codex exec resume <threadId>` ⇒ `continue` (mutating) — parallel forks
  of one source rejected.
- Sandbox: native modes (`read-only`, `workspace-write`, ...).
- This adapter doubles as the template for any **API-projection worker**
  (raw Anthropic/OpenAI/xAI SDK calls) — same projection, no CLI.

### OpenCode — class A `native-agent verified`

- Dispatch: `opencode run --agent <agent-name> <prompt>` through the shared
  workflow worker process helper.
- Agent selection: native `--agent` binding is live for generated Prism agent
  refs. Task metadata records `nativeAgent` only when this native selector is
  actually used.
- Structured output: `prompted` for the current wedge; runtime extraction and
  Effect Schema decode remain mandatory before completion/cache-write.
- Fork/session semantics: not claimed yet. Treat as `fork: "none"` until an
  immutable provider-copy or safe continue mode is live-verified.

### Antigravity CLI — class B `live dispatch verified, generated-agent binding pending`

- Prism has an antigravity lowerer (agents land in the generated plugin).
- Headless surface confirmed: `agy --log-file <file>
  [--conversation <id>] --dangerously-skip-permissions --sandbox
  --print-timeout <d> --add-dir <dir> --model <m> --print <prompt>`.
  `--print` is prompt-valued, so all options must appear before it.
- Local `agy 1.0.10` currently exposes models including `Gemini 3.5 Flash (Medium)`
  and completed a bounded one-task Prism workflow JSON smoke through the live
  adapter using prompted-contract identity. The workflow adapter defaults to
  `Gemini 3.5 Flash (Medium)` when the task/CLI does not provide a model.
- Native repair continuation is live-verified: the first `agy --print` run logs
  `Created conversation <uuid>` / `Print mode: conversation=<uuid>`, Prism
  records that UUID as `sessionId`, and repair runs resume with
  `--conversation <uuid>`. `--continue` / `-c` resumes mutable global "most
  recent conversation" state, so Prism bans those flags from workflow argv:
  `AgyPrintArgs` cannot represent them, and the spawn path rejects them if a
  cast bypasses the type. Workflow repair must use the captured UUID or fall
  back before spawn.
- Open: how a lowered agent is addressed headlessly —
  plugin agent naming vs projection fallback (read the generated agent
  markdown, inject as system context the way codex does). Capability matrix
  filled only from live runs, per the rule above.

### Hermes — class B `live dispatch verified, profile binding pending`

- Hermes is a claw-style assistant, not a coding harness; profiles are not
  prism-compiled. **No Hermes→Prism type-generation bridge** (decided —
  overkill).
- Dispatch shape: `hermes chat --oneshot --json --source prism-workflow` with a
  bounded process timeout. Live dogfood succeeded and a rerun hit cache. Profile
  selection per invocation remains pending because the CLI surface does not yet
  expose a Prism-agent selector equivalent to Grok/OpenCode/Claude `--agent`.
- Worker descriptor (typed, runtime-registered, ledgered):

```typescript
const ops = wf.worker.hermes({ profile: "ops", toolsets: ["browser", "files"] });
const digest = yield* wf.agentRun("daily-digest", ops, { prompt: ..., output: Digest });
```

- What this unlocks: a workflow orchestrating **multiple Hermes profiles**
  concurrently with typed handoffs between them — not possible today by any
  means — and, combined with the meta-plugin (06), a Hermes agent driving that
  workflow itself: Hermes orchestrating Hermes, with prism-attested coding
  agents (codex/claude/grok) doing the heavy phases in the same program.
- Honesty boundary: Hermes AgentRuns store `attestation: "declared"`; their
  grants are whatever the profile holds — the gate checks only what it can see
  (budget, schema, concurrency).

## Structured output — the answer

Three lanes, one source of truth:

1. **The task's Effect Schema is canonical.** From it the gateway derives a
   JSON Schema (`JSONSchema.make` / standard-schema) for native lanes and a
   compact prompt clause for prompted lanes.
2. **Native lane** (codex today; claude pending verification): schema handed to
   the provider's constrained-output mechanism (`--output-schema`,
   `--json-schema`). Provider-side enforcement is treated as an optimization,
   **never as validation** — the runtime re-decodes with the original Effect
   Schema regardless (client-revalidation; both reference projects converged on
   this after being burned).
3. **Prompted lane** (grok, hermes, agy until verified): schema clause appended
   to the prompt; response goes through extract (fence-strip, brace-match) →
   `JSON.parse` → `Schema.decodeUnknown`. Decode failure feeds the formatted
   parse error back to the same session for a bounded number of
   **decode retries that do not consume task retries** (smithers' rule, kept).
   The current native-continuation implementation covers Claude sessions and
   Antigravity conversations; other prompted workers still fall back to fresh
   invocations until their explicit session-resume handles are verified.

So: it is *both* prompt and SDK injection, per capability — but the type the
workflow sees comes from exactly one place, and nothing the provider says is
trusted until the runtime's own decode passes.

V1 deliberately stops at basic extraction and decode: native schema where the
adapter proves it, otherwise a compact prompt clause plus JSON extraction and
`Schema.decodeUnknown`. Smithers-style balanced extraction heuristics beyond
obvious fences/braces are deferred until real Prism Workflow runs prove the
need. Invalid output fails the AgentRun attempt; completed resources are never
stored unless they decode.

## Error taxonomy (typed, retry-classified)

```
DispatchError      — spawn/exit/stream failures; classify: provider_busy (retryable,
                     e.g. local-db lock races observed in the wild), auth (terminal,
                     short-circuits retries), timeout (retryable w/ backoff), unknown
OutputDecodeError  — decode-lane failures (own retry budget)
CapabilityError    — task asked for what the adapter can't do (terminal, names remedy)
```

Subprocess hygiene (from omegacode's hard-won list): stall watchdog on stdout
inactivity, stderr ring buffer attached to errors, SIGTERM→SIGKILL teardown
tied to the task's Scope, version preflight per adapter (`doctor`).

## `prism-workflow doctor`

One command, one table: per adapter — binary found, version ≥ minimum, auth
state, capability matrix as it will actually be enforced, and for class A: a
sample agent's attestation check against the local harness root.
