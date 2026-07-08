# Hooks Harness Audit — 2026-07-08

Full investigation of hooks support across all 12 Prism harnesses: native reality
(web research, receipt-verified), current Prism lowering (repo, source-verified),
gaps, and the expansion plan. Claude Code is the baseline; every other target
degrades gracefully from it.

Method: 12 haiku web-researchers (one per harness, primary-source receipts
required) → 12 independent receipt-checkers attempting refutation → 1 sonnet repo
agent extracting lowerer ground truth → refuted/unverified claims corrected or
flagged below. Claude Code baseline re-verified directly against
https://code.claude.com/docs/en/hooks.

---

## 1. The baseline — Claude Code native hooks surface (verified)

**30 events** (grouped; full list verbatim from the hooks reference):

| group | events |
|---|---|
| session | `SessionStart` `SessionEnd` `Setup` `CwdChanged` `ConfigChange` `InstructionsLoaded` `FileChanged` |
| prompt | `UserPromptSubmit` `UserPromptExpansion` |
| tool | `PreToolUse` `PostToolUse` `PostToolUseFailure` `PostToolBatch` |
| permission | `PermissionRequest` `PermissionDenied` |
| stop | `Stop` `StopFailure` |
| subagent/team | `SubagentStart` `SubagentStop` `TaskCreated` `TaskCompleted` `TeammateIdle` |
| compaction | `PreCompact` `PostCompact` |
| display/ux | `Notification` `MessageDisplay` `Elicitation` `ElicitationResult` |
| worktree | `WorktreeCreate` `WorktreeRemove` |

**Output protocol** (JSON stdout on exit 0; exit 2 = block with stderr feedback):

- universal: `continue` / `stopReason` / `suppressOutput` / `systemMessage` / `terminalSequence`
- top-level `decision: "block"` + `reason` (UserPromptSubmit, PostToolUse, Stop, SubagentStop, ConfigChange, PreCompact, …)
- `hookSpecificOutput`: `permissionDecision: allow|deny|ask|defer` + reason (PreToolUse), `decision.behavior: allow|deny` (PermissionRequest), `updatedInput` (PreToolUse/PermissionRequest), `updatedToolOutput` (PostToolUse), `retry` (PermissionDenied), `additionalContext`, `displayContent` (MessageDisplay), `sessionTitle`/`initialUserMessage`/`watchPaths`/`reloadSkills` (SessionStart)

**Handler types:** `command`, `http`, `mcp_tool`, `prompt` (single LLM turn), `agent` (subagent, experimental).
**Modifiers:** matchers (exact/regex), `if` conditional (permission-rule syntax, tool events), `async`/`asyncRewake`, `once: true` (skill frontmatter only), timeouts per type.
**Definition surfaces:** settings.json ×3 scopes, managed policy, plugin `hooks/hooks.json`, skill/agent frontmatter.

## 2. Prism's portable abstraction today

6 events: `tool.before` `tool.after` `prompt.submit` `permission.request` `session.start` `session.end`
(`src/compile/sources.ts:114-121`)

Results: `continue(systemMessage?, additionalContext?)` | `block(message)` | `allow` (permission.request only)
(`src/compile/sources.ts:508-563`)

Matchers: any / toolspace-tool / toolspace-group / canonical-tool (`src/compile/hooks.ts`).

**Coverage vs baseline: 6 of 30 events; no updatedInput, no updatedToolOutput, no
`ask` decision, no stop-continuation control, no async, no `if`, no `once`.**

## 3. Per-harness matrix — native reality × current lowering

Fidelity legend: what a hook author gets per portable event on that target.
`✔` native full · `◐` degraded (noted) · `✖` fail-closed at compile · `—` harness has no native equivalent.

| harness | native hooks story | t.before | t.after | prompt | perm | s.start | s.end | result fidelity today |
|---|---|---|---|---|---|---|---|---|
| **claude-code** | 30 events, full JSON protocol | ✔ | ✔ | **✖** | **✖** | ✔ | ✔ | **block-only exit-2; systemMessage/additionalContext dropped** |
| **opencode** | plugin API, ~40 hook points | ✔ | ✔ | ✔ | ✔ | ◐ | ◐ | full: throw-block, systemMessage, additionalContext, allow/deny |
| **codex-cli** | native hooks GA, 10 events | ◐ shell-only | ✔ | ✔ | ◐ no ask | ✔ | ◐ →Stop | block + systemMessage + additionalContext(3 events) + allow/deny |
| **antigravity-cli** | hooks.json, 4 events | ✔ | ✔ | ✖ | ✖ | ◐ →PreInvocation | ◐ →Stop | allow/deny/continue only (native ceiling — no context fields) |
| **kimi-code** | config-only `[[hooks]]`, beta, fail-open | ✔ | ✔ | ✖ | ✖ | ✔ | ✔ | block-only exit-2 |
| **amp-code** | plugin API `amp.on`, experimental, 5 events | ✔ | ✔ | ✖ | ✖ | ✔ | **✖** no native event | block-only return-value; context stripped by validation |
| **grok** | hooks.json, 14 events, only PreToolUse blocks, fail-open | ✔ | ✔ | ✖ | ✖ | ✔ | ✔ | block-only (JSON deny) — near native ceiling |
| **factory-droid** | hooks.json plugin, 9 events, JSON stdout protocol | ✔ | ✔ | ✖ | ✖ | ✔ | ✔ | block-only exit-2 |
| **pi** | extension API `pi.on`, 30 events | ✔ | ✔ | ✖ | ✖ | ✔ | ◐ →shutdown | block-only read; full result serialized but **unread** by extension |
| **cursor** | native hooks (IDE ~21 events; CLI subset ~4), perm allow/deny/ask, CC-compat output mode | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | no lowerer (tools-only) |
| **openclaw** | plugin `api.on`, ~32 hook points, Decision{block,params,requireApproval} | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | no lowerer |
| **hermes** | shell hooks in config.yaml: any-language JSON wire, CLI+gateway, CC-style block accepted natively | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | no lowerer (managed config.yaml region already exists) |

Repo receipts: claude-code `src/compile/lowerers/claude-code.ts:220,287-289` +
`shared.ts:163-183`; opencode `opencode.ts:878-886,906-993`; codex
`codex-cli.ts:246-334`; antigravity `antigravity-cli.ts:215-253`; kimi
`kimi-code.ts:475-518`; amp `amp-code.ts:213-288,317-375`; grok
`grok.ts:229,303-318`; factory `factory-droid.ts:221,262-278`; pi
`pi.ts:292-307,424-492`; capability declarations `src/lowerer-capabilities.ts`.

### Headline finding

**Prism's weakest hook target is Claude Code itself.** The lowerer fails closed
on `prompt.submit` and `permission.request` (both natively supported as
`UserPromptSubmit`/`PermissionRequest`) and emits no JSON stdout at all —
`systemMessage`/`additionalContext` are computed by the portable hook and then
silently dropped. OpenCode, ironically, is the only target with the complete
6/6 + full-result surface.

## 4. Per-harness notes and corrections (receipt-checked)

**claude-code** — baseline verified directly against the docs page; 30-event
list and output fields confirmed verbatim. Everything in §1 is available to the
lowerer today.

**opencode** — plugin API confirmed: `tool.execute.before` (throw = block,
`output.args` mutable → modify-input headroom), `tool.execute.after` (output
mutable), `permission.ask` (allow/deny/ask status — the only harness besides
cursor with a real `ask`), `chat.message`/`chat.params`, experimental
system/messages transforms, rich session event bus. Caveat (researcher,
unrefuted): `tool.execute.before` does not fire for subagent tool calls —
document as a degradation note. Refuted detail: "40+ separate Hooks interface
entries" — the count mixes event-bus events with plugin hook methods; treat the
hook-method set as the lowering surface.

**codex-cli** — native hooks are GA and **enabled by default** (researcher
claimed opt-in; refuted by receipt-checker against
developers.openai.com/codex/hooks). 10 events. Two hard caveats, both
confirmed: `PreToolUse` fires **only for shell/Bash tools** (upstream issue
#20204) — Read/Edit/MCP tool calls are invisible to `tool.before` on this
target; `updatedInput` is parsed but rejected (no input mutation). No native
SessionEnd (#20603) — Prism already aliases `session.end`→`Stop`, keep it. No
`ask` in PermissionRequest. Plugin-bundled hooks (v0.128+) unverified — probe
before relying; Prism's config.toml patching stays the safe path.

**antigravity-cli** — 4 events (`PreToolUse` `PostToolUse` `PreInvocation`
`Stop`). Receipt-checker **refuted** `systemMessage`/`additionalContext` in the
native output protocol — decision allow/deny/continue is the ceiling, so the
current lowerer dropping context fields is *correct*, not a bug. Docs URLs
unverified; weakest documentation surface of the natively-hooked targets.
`PostInvocation`/`injectSteps` exists natively but Prism deliberately does not
model it (see lowerer-capability-matrix).

**kimi-code** — hooks are beta (v1.28.0), config-only: plugins **cannot**
bundle hooks; Prism's config.toml `[[hooks]]` patching is the only path
(confirmed). Fail-open on hook failure (unverified). Receipt-checker refuted
the claimed `UserPromptSubmit`/`SubagentStart` control sets — the real
event/control surface beyond the 4 already lowered is **unknown; probe before
any upgrade**.

**amp-code** — experimental plugin API (the magic-comment gate the researcher
cited is stale — refuted). Events: `session.start`, `tool.call` (returns
`allow | reject-and-continue | modify | synthesize | error` — **`modify` gives
modify-input headroom**), `tool.result`, `agent.start` (can inject messages →
session/turn context injection), `agent.end`. Still no session-end, no
permission API. `prompt.submit` could approximate via `agent.start` (inject-only,
no block) — degraded semantics if we want it.

**grok** — 14 events but **only `PreToolUse` can block**; everything else is
observe-only. Fail-open by design (timeouts default 5s, crashes ignored).
Project-level hooks require `/hooks-trust`; plugin hooks dir supported. Has
`UserPromptSubmit` natively (observe-only) → `prompt.submit` can lower as
degraded observe. `PermissionDenied` is post-hoc observe, not a decision point
→ `permission.request` stays fail-closed.

**factory-droid** — 9 events including `UserPromptSubmit`, `Stop`,
`SubagentStop`, `PreCompact`, `Notification`, `SessionStart/End`. JSON stdout
protocol documented natively (`continue`/`stopReason`/`permissionDecision`/
`additionalContext`) — the current exit-2-only lowering under-uses the target.
Receipt-checker refuted PostToolUse modify-output; stop-control unverified.
`${DROID_PLUGIN_ROOT}` expansion, marketplace distribution, `hooksDisabled`
global toggle all confirmed.

**pi** — richest extension surface after Claude Code: 30 events incl.
`tool_call` (block + arg mutation), `tool_result` (output mutation), `input`
(block + transform user input → real `prompt.submit` mapping),
`session_before_compact`, provider request/header hooks. Receipt-checker
corrections applied: `session_before_switch` returns `{cancel?}` not
`{block,reason}`; `input` action value is `'handled'`; `~/.pi/agent/extensions`
is global and trust-free (only project `.pi/extensions` is trust-gated);
`user_bash` is for `!`-commands, cannot block. **Cheap win:** Prism's wrapper
already serializes the full hook result to stdout — the generated extension
just never reads anything but `decision==='block'` on `tool_call`
(`pi.ts:466-474`); `systemMessage`/`additionalContext` are on the wire, unread.

**cursor** — real native hooks (beta since v1.7, production-shipping):
`beforeShellExecution`/`beforeMCPExecution`/`beforeReadFile`/`beforeSubmitPrompt`/
`stop`/`preToolUse`/`postToolUse` etc.; permission `allow|deny|ask`,
`updated_input`, and a **Claude-Code-compat `hookSpecificOutput` mode** that
would make a lowerer cheap. Two caveats: the CLI supports only a ~4-event
subset (IDE has ~21) — the exact CLI set needs a probe; enforcement is partly
prompt-level rather than loop-level (per researcher, unrefuted). Currently
`hooks: unsupported` in Prism (tools-only target).

**openclaw** — no native hooks config, but a confirmed plugin API:
`api.on(hookName, handler)` with Decision object
`{block, blockReason, params (input rewrite), requireApproval, message}`,
~32 hook points incl. `before_tool_call`, `after_tool_call`,
`tool_result_persist`, `message_received`/`message_sending`, session +
gateway lifecycle, compaction. In-process, priority-ordered, per-hook
timeouts. Distribution: `openclaw.plugin.json` + `openclaw plugins install`.
Mapping is natural for 5/6 portable events; `prompt.submit` maps to
message-flow hooks whose semantics differ (messaging assistant, not a
prompt REPL) — probe + degradation note.

**hermes** — *(re-grounded 2026-07-08 against the local install's own docs —
`~/.hermes/hermes-agent/website/docs/user-guide/features/hooks.md` — which
supersede the web research below.)* Three systems: gateway hooks
(HOOK.yaml + handler.py, Python, gateway-only), python plugin
`ctx.register_hook()` (in-process), and **shell hooks** — the Prism target:
declared in a `hooks:` block in `~/.hermes/config.yaml`, any language,
subprocess JSON stdin→stdout, runs in **CLI + gateway**, regex `matcher` on
tool names, 60s timeout capped 300s, failures non-fatal.

Facts that dissolve the earlier blockers:

- **Block protocol accepts Claude-Code style natively** —
  `{"decision":"block","reason"}` is normalized alongside Hermes-canonical
  `{"action":"block","message"}`. Prism's existing wrapper output shape is
  already compatible.
- **`prompt.submit` has a documented home**: the doc states Claude Code's
  `UserPromptSubmit` is *intentionally* not a separate event —
  `pre_llm_call` fires at the same place and takes `{"context": str}`
  (inject-context yes; block no → degraded).
- **Consent is scriptable, first-class**: manual allowlisting via an
  `approvals` array of exact `(event, command)` pairs in
  `~/.hermes/shell-hooks-allowlist.json` is documented for non-TTY /
  service-account deployments; `hooks_auto_accept` / `HERMES_ACCEPT_HOOKS=1`
  / `--accept-hooks` are the other hatches. The "non-TTY reliability bug"
  from web research is just this consent gate: un-consented hooks silently
  stay unregistered in non-TTY runs. Allowlist keys on the exact command
  string (not hash), so Prism regenerating wrappers at stable paths keeps
  consent valid.
- **Backpressure ships with the harness**: `hermes hooks test <event>`
  (synthetic-payload fire) and `hermes hooks doctor` (exec bit, allowlist,
  mtime drift, JSON validity, timing) are the WS6 probe, free.
- The #44582 input-mutation bug is irrelevant: the shell wire protocol has
  no mutation contract, and Prism's T1 surface doesn't need one.

Mapping: `tool.before`→`pre_tool_call` (block ✓ + matcher ✓),
`tool.after`→`post_tool_call`, `prompt.submit`→`pre_llm_call` (◐ inject-only),
`session.start`→`on_session_start`, `session.end`→`on_session_end`
(+`on_session_finalize`); T2 `subagent.stop`→`subagent_stop`;
`permission.request` stays fail-closed (`pre_approval_request` observer-only).
Possible extras to probe: `transform_tool_result`/`transform_llm_output`
(modify-output as `str` replace — shell-hook response shape undocumented),
`pre_verify`.

Two real design notes, not blockers: (1) hooks are machine-global config
(like kimi) **and fire in gateway messaging sessions too** — a Prism coding
hook firing inside the user's WhatsApp/Slack assistant sessions needs an
explicit scope decision (tool-name matchers narrow it); (2) install = patch
the managed `hooks:` region + seed the allowlist — Prism already owns a
fenced managed region in `~/.hermes/config.yaml` for `mcp_servers:`
(`src/compile/lowerers/hermes.ts:193-195`), so the write machinery exists.

## 5. Plan

North star: **author once against a Claude-Code-shaped hook surface; compile
everywhere with a typed, per-target verdict — native where possible, degraded
where declared, fail-closed only where required.**

### WS1 — expand the portable abstraction (the contract)

- **Tier the event model.**
  - **T1 core** (exists): `tool.before` `tool.after` `prompt.submit`
    `permission.request` `session.start` `session.end`.
  - **T2 extended** (add; ≥4 harnesses have native equivalents):
    `tool.failure` (PostToolUseFailure), `stop` (Stop), `subagent.start`,
    `subagent.stop`, `compact.before`, `compact.after`, `notification`.
  - **T3 native passthrough** (add): `event: { native: "TeammateIdle" }` pinned
    to explicit targets, payload passed through untyped at `native`, no
    portability contract. This is how "all of Claude Code's capabilities"
    becomes reachable without forcing Elicitation/WorktreeCreate/MessageDisplay
    through a 12-harness matrix.
- **Expand the result surface** per event: `updatedInput` (tool.before,
  permission.request), `updatedOutput` (tool.after), permission `ask` (+
  `deny` reason), stop-continuation (`continue`/`stopReason`),
  `suppressOutput`. Keep `systemMessage`/`additionalContext` as-is.
- **Capability contract as data:** `harness × event × control →
  native | degraded(note) | unsupported`, one table in
  `lowerer-capabilities.ts`, consumed by compile, doctor, and docs. The matrix
  in §3 becomes generated output, not prose.
- **Degradation policy on `defineHook`:** `onDegraded: 'fail' | 'degrade' |
  'skip'` per hook (optionally per target). Today's behavior is an implicit
  mid-build throw; make it a typed diagnostic. Recommended default:
  `'degrade'` + compile report (fail only when a hook declares a control as
  load-bearing, e.g. a security block).

### WS2 — Claude Code lowerer to full fidelity (fix the baseline first)

- Map `prompt.submit`→`UserPromptSubmit`, `permission.request`→`PermissionRequest`.
- Replace exit-2-only wrappers with the JSON stdout protocol: `systemMessage`,
  `hookSpecificOutput.additionalContext`, `permissionDecision allow|deny|ask`,
  `updatedInput`, `updatedToolOutput`, `continue`/`stopReason`.
- T2 events lower 1:1; T3 passthrough wired.
- Later (not v1): expose `http`/`prompt`/`agent` handler types, `if`, `async`,
  `once` as claude-code-targeted authoring options.

### WS3 — cheap high-yield upgrades (existing lowerers)

| target | change | cost |
|---|---|---|
| pi | read the already-serialized result in the extension (systemMessage/additionalContext); `prompt.submit`→`input` (block+modify); `tool.after` output mutation via `tool_result` | low — the data is already on the wire |
| factory-droid | `prompt.submit`→`UserPromptSubmit`; switch to native JSON stdout protocol (permissionDecision, additionalContext); T2 `stop`/`subagent.stop`/`compact.before`/`notification` | low |
| codex-cli | T2 `subagent.*`/`compact.*`; surface the **shell-only PreToolUse** caveat as a compile-time degradation note | low |
| opencode | modify-input/-output via `tool.execute.*`; T2 via event bus; subagent blind-spot degradation note | low-med |
| grok | `prompt.submit`→`UserPromptSubmit` (degraded observe-only); T2 observe events; document fail-open | low |
| amp-code | modify-input via `tool.call` `modify` action; `session.start` context injection via `agent.start` messages | med (probe the current plugin API first — docs are drifting) |
| kimi-code | **probe before touching** — refuted control claims; possible `prompt.submit` if UserPromptSubmit is real | probe first |
| antigravity-cli | no upgrade possible (native ceiling); encode ceiling in capability table | trivial |

### WS4 — new lowerers

1. **cursor** — highest value of the three (real userbase, permission `ask`,
   `updated_input`, CC-compat output mode). Scope to the CLI event subset;
   probe determines the exact set.
2. **openclaw** — plugin lowerer via `api.on` + Decision object; 5/6 T1 events
   map naturally; `prompt.submit` needs a semantics decision (message hooks).
3. **hermes** — shell-hook lowerer via the existing managed config.yaml
   region + allowlist seeding: 5/6 T1 (permission.request fail-closed,
   prompt.submit inject-only) + subagent.stop. Cheaper than first assessed —
   the consent and non-TTY concerns dissolved on local-primary-source
   reading (§4), and `hermes hooks test`/`doctor` provide the probe.
   Open scope decision: hooks fire in gateway messaging sessions too.

### WS5 — degradation observability

Per plugin × target **hooks fidelity report** at compile: each hook →
native / degraded(how) / skipped(why). Surfaced in compile output, `prism
plugins` TUI, and doctor. Kills the current silent-drop failure mode
(claude-code context fields today) and the mid-build throw.

### WS6 — conformance probes (the backpressure)

A sentinel-hook fixture plugin (one hook per portable event writing a marker
file) + a scripted probe run per harness. Deterministic pass/fail per
event × control; run before each lowerer ships and on harness version bumps.
Also resolves the open unknowns: kimi's real event set, cursor's CLI subset,
amp's current plugin API shape, codex plugin-bundled hooks.

### Order

WS1 → WS2 (baseline principle: fix Claude Code first) → WS3 pi + factory-droid
(cheapest fidelity wins) → WS5 (visibility before breadth) → WS4 cursor →
openclaw → probes-then-upgrades for kimi/amp → hermes. WS6 fixtures land
incrementally with each lowerer they gate.

## 6. Open questions

1. **T3 passthrough vs full portability** — is the tier model acceptable as
   the meaning of "support all of Claude Code's hooks capabilities"?
   (Recommended: yes — 23 of 30 CC events have <4 harness equivalents.)
2. **Default degradation policy** — flip from fail-closed to
   degrade-with-report? (Recommended: degrade, with `'fail'` opt-in per hook.)
3. **Scope of WS4** — cursor/openclaw/hermes lowerers this cycle, or capability
   table entries only?

---

*Workflow run `wf_9ec911fd-a62` (25 agents, 12 researched + 12 verified + 1 repo).
Full structured results:*
`~/.claude/projects/-Users-guilhermecastro-Projects-prism/.../tasks/wjix6fdm3.output`
