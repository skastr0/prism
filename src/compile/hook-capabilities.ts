import type { HarnessId } from "../types.js";
import type { HookEvent } from "./sources.js";

export type HookControl =
  | "block"
  | "updatedInput"
  | "updatedOutput"
  | "ask"
  | "systemMessage"
  | "additionalContext";

export type HookEventSupport =
  | {
      readonly kind: "native";
      readonly nativeEvent: string;
      readonly controls: ReadonlyArray<HookControl>;
      readonly note?: string;
    }
  | {
      readonly kind: "degraded";
      readonly nativeEvent: string;
      readonly controls: ReadonlyArray<HookControl>;
      readonly note: string;
    }
  | {
      readonly kind: "unsupported";
      readonly note?: string;
    };

export const HOOK_CAPABILITIES: Record<HarnessId, Record<HookEvent, HookEventSupport>> = {
  "claude-code": {
    "tool.before": {
      kind: "native",
      nativeEvent: "PreToolUse",
      controls: ["block", "updatedInput", "systemMessage", "additionalContext"],
    },
    "tool.after": {
      kind: "native",
      nativeEvent: "PostToolUse",
      controls: ["updatedOutput", "systemMessage", "additionalContext"],
    },
    "prompt.submit": {
      kind: "native",
      nativeEvent: "UserPromptSubmit",
      controls: ["block", "systemMessage", "additionalContext"],
    },
    "permission.request": {
      kind: "native",
      nativeEvent: "PermissionRequest",
      controls: ["block", "ask", "updatedInput", "systemMessage"],
    },
    "session.start": {
      kind: "native",
      nativeEvent: "SessionStart",
      controls: ["systemMessage", "additionalContext"],
    },
    "session.end": {
      kind: "native",
      nativeEvent: "SessionEnd",
      controls: ["systemMessage"],
    },
    "tool.failure": {
      kind: "native",
      nativeEvent: "PostToolUseFailure",
      controls: ["systemMessage"],
    },
    stop: {
      kind: "native",
      nativeEvent: "Stop",
      controls: ["block", "systemMessage"],
    },
    "subagent.start": {
      kind: "native",
      nativeEvent: "SubagentStart",
      controls: ["systemMessage", "additionalContext"],
    },
    "subagent.stop": {
      kind: "native",
      nativeEvent: "SubagentStop",
      controls: ["block", "systemMessage"],
    },
    "compact.before": {
      kind: "native",
      nativeEvent: "PreCompact",
      controls: ["block", "systemMessage"],
    },
    "compact.after": {
      kind: "native",
      nativeEvent: "PostCompact",
      controls: ["systemMessage"],
    },
    notification: {
      kind: "native",
      nativeEvent: "Notification",
      controls: ["systemMessage"],
    },
  },
  "codex-cli": {
    "tool.before": {
      kind: "native",
      nativeEvent: "PreToolUse",
      controls: ["block"],
      note: "fires for shell tools only (upstream #20204)",
    },
    "tool.after": {
      kind: "native",
      nativeEvent: "PostToolUse",
      controls: ["systemMessage", "additionalContext"],
    },
    "prompt.submit": {
      kind: "native",
      nativeEvent: "UserPromptSubmit",
      controls: ["systemMessage", "additionalContext"],
    },
    "permission.request": {
      kind: "native",
      nativeEvent: "PermissionRequest",
      controls: ["block", "systemMessage"],
    },
    "session.start": {
      kind: "native",
      nativeEvent: "SessionStart",
      controls: ["systemMessage", "additionalContext"],
    },
    "session.end": {
      kind: "degraded",
      nativeEvent: "Stop",
      controls: ["systemMessage"],
      note: "no native SessionEnd; rides Stop",
    },
    "tool.failure": { kind: "unsupported", note: "no native codex event" },
    stop: {
      kind: "native",
      nativeEvent: "Stop",
      controls: ["block", "systemMessage"],
    },
    "subagent.start": {
      kind: "native",
      nativeEvent: "SubagentStart",
      controls: ["systemMessage", "additionalContext"],
    },
    "subagent.stop": {
      kind: "native",
      nativeEvent: "SubagentStop",
      controls: ["block", "systemMessage"],
    },
    "compact.before": {
      kind: "native",
      nativeEvent: "PreCompact",
      controls: ["block", "systemMessage"],
    },
    "compact.after": {
      kind: "native",
      nativeEvent: "PostCompact",
      controls: ["systemMessage"],
    },
    notification: { kind: "unsupported", note: "no native codex event" },
  },
  opencode: {
    "tool.before": { kind: "native", nativeEvent: "tool.execute.before", controls: ["block"] },
    "tool.after": {
      kind: "native",
      nativeEvent: "tool.execute.after",
      controls: ["systemMessage", "additionalContext"],
    },
    "prompt.submit": {
      kind: "native",
      nativeEvent: "chat.message",
      controls: ["systemMessage", "additionalContext"],
    },
    "permission.request": {
      kind: "native",
      nativeEvent: "permission.ask",
      controls: ["block", "systemMessage"],
    },
    "session.start": {
      kind: "degraded",
      nativeEvent: "session.status",
      controls: ["systemMessage", "additionalContext"],
      note: "busy transition proxy",
    },
    "session.end": {
      kind: "degraded",
      nativeEvent: "session.status/session.idle",
      controls: ["systemMessage", "additionalContext"],
      note: "idle transition proxy",
    },
    // OpenCode's plugin API is tool/permission/chat-centric — it has no clean
    // lifecycle hook for these events, and the lowerer wires none. Honest
    // unsupported rather than a forced mapping onto an unverified bus event.
    "tool.failure": {
      kind: "unsupported",
      note: "no distinct opencode failure event (tool.execute.after carries only a success flag)",
    },
    stop: { kind: "unsupported", note: "opencode has no turn-stop plugin hook" },
    "subagent.start": {
      kind: "unsupported",
      note: "opencode has no subagent lifecycle event (tool.execute.* does not fire for subagents)",
    },
    "subagent.stop": {
      kind: "unsupported",
      note: "opencode has no subagent lifecycle event",
    },
    "compact.before": {
      kind: "unsupported",
      note: "opencode compaction is not exposed as a blocking/injecting plugin hook",
    },
    "compact.after": {
      kind: "unsupported",
      note: "opencode compaction is not exposed as a plugin hook",
    },
    notification: {
      kind: "unsupported",
      note: "opencode has no notification plugin hook (tui.toast is output, not a lifecycle hook)",
    },
  },
  "antigravity-cli": {
    "tool.before": { kind: "native", nativeEvent: "PreToolUse", controls: ["block"] },
    "tool.after": { kind: "native", nativeEvent: "PostToolUse", controls: [] },
    "prompt.submit": { kind: "unsupported" },
    "permission.request": { kind: "unsupported" },
    "session.start": {
      kind: "degraded",
      nativeEvent: "PreInvocation",
      controls: [],
      note: "invocation, not session, granularity",
    },
    "session.end": {
      kind: "degraded",
      nativeEvent: "Stop",
      controls: [],
      note: "turn stop, not session end",
    },
    // Antigravity has only 4 native hook events: PreToolUse, PostToolUse,
    // PreInvocation, Stop. `stop` maps to Stop (turn-stop); the rest have no
    // equivalent. Antigravity's result ceiling is allow/deny/continue — no
    // systemMessage/additionalContext — so no event carries context controls.
    "tool.failure": {
      kind: "unsupported",
      note: "antigravity has no post-tool-failure event",
    },
    stop: {
      kind: "degraded",
      nativeEvent: "Stop",
      controls: [],
      note: "turn-stop; antigravity result ceiling has no context controls",
    },
    "subagent.start": {
      kind: "unsupported",
      note: "antigravity has no subagent lifecycle event",
    },
    "subagent.stop": {
      kind: "unsupported",
      note: "antigravity has no subagent lifecycle event",
    },
    "compact.before": {
      kind: "unsupported",
      note: "antigravity has no compaction event",
    },
    "compact.after": {
      kind: "unsupported",
      note: "antigravity has no compaction event",
    },
    notification: {
      kind: "unsupported",
      note: "antigravity has no notification event",
    },
  },
  "kimi-code": {
    "tool.before": { kind: "native", nativeEvent: "PreToolUse", controls: ["block"] },
    "tool.after": { kind: "native", nativeEvent: "PostToolUse", controls: [] },
    // Verified from a live kimi config.toml [[hooks]] UserPromptSubmit entry.
    "prompt.submit": { kind: "native", nativeEvent: "UserPromptSubmit", controls: ["block"] },
    "permission.request": { kind: "unsupported" },
    "session.start": { kind: "native", nativeEvent: "SessionStart", controls: [] },
    "session.end": { kind: "native", nativeEvent: "SessionEnd", controls: [] },
    // kimi-code mirrors Claude Code's [[hooks]] format, but these T2 events
    // could not be confirmed to fire from the local install (binary opaque,
    // install docs are bundled-skill content). Honest unsupported over an
    // unverified native that would silently no-op.
    "tool.failure": { kind: "unsupported", note: "unverified against kimi's event surface" },
    stop: { kind: "unsupported", note: "unverified against kimi's event surface" },
    "subagent.start": { kind: "unsupported", note: "unverified against kimi's event surface" },
    "subagent.stop": { kind: "unsupported", note: "unverified against kimi's event surface" },
    "compact.before": { kind: "unsupported", note: "unverified against kimi's event surface" },
    "compact.after": { kind: "unsupported", note: "unverified against kimi's event surface" },
    notification: { kind: "unsupported", note: "unverified against kimi's event surface" },
  },
  "amp-code": {
    "tool.before": { kind: "native", nativeEvent: "tool.call", controls: ["block"] },
    "tool.after": { kind: "native", nativeEvent: "tool.result", controls: [] },
    "prompt.submit": {
      kind: "unsupported",
      note: "amp agent.start is experimental (inject-only, no block); not lowered",
    },
    "permission.request": { kind: "unsupported", note: "amp has no permission-decision plugin API" },
    "session.start": { kind: "native", nativeEvent: "session.start", controls: [] },
    "session.end": { kind: "unsupported", note: "amp has no session-end plugin event" },
    // Amp's plugin API (experimental, WIP) exposes only tool.call, tool.result,
    // session.start, agent.start, agent.end. None of these T2 events has a
    // stable amp equivalent; honest unsupported over an unverified mapping onto
    // the experimental agent.* events.
    "tool.failure": { kind: "unsupported", note: "no distinct amp failure event (result comes via tool.result)" },
    stop: { kind: "unsupported", note: "amp has no stable turn-stop event (agent.end is experimental)" },
    "subagent.start": { kind: "unsupported", note: "amp has no subagent lifecycle event" },
    "subagent.stop": { kind: "unsupported", note: "amp has no subagent lifecycle event" },
    "compact.before": { kind: "unsupported", note: "amp has no compaction event" },
    "compact.after": { kind: "unsupported", note: "amp has no compaction event" },
    notification: { kind: "unsupported", note: "amp has no notification event" },
  },
  grok: {
    "tool.before": { kind: "native", nativeEvent: "PreToolUse", controls: ["block"] },
    "tool.after": { kind: "native", nativeEvent: "PostToolUse", controls: [] },
    "prompt.submit": {
      kind: "degraded",
      nativeEvent: "UserPromptSubmit",
      controls: [],
      note: "observe-only, fail-open",
    },
    "permission.request": {
      kind: "unsupported",
      note: "grok PermissionDenied is post-hoc observe-only",
    },
    "session.start": { kind: "native", nativeEvent: "SessionStart", controls: [] },
    "session.end": { kind: "native", nativeEvent: "SessionEnd", controls: [] },
    "tool.failure": {
      kind: "native",
      nativeEvent: "PostToolUseFailure",
      controls: [],
      note: "fail-open",
    },
    stop: {
      kind: "degraded",
      nativeEvent: "Stop",
      controls: [],
      note: "observe-only, cannot block",
    },
    "subagent.start": {
      kind: "native",
      nativeEvent: "SubagentStart",
      controls: [],
      note: "fail-open",
    },
    "subagent.stop": {
      kind: "native",
      nativeEvent: "SubagentStop",
      controls: [],
      note: "fail-open",
    },
    "compact.before": {
      kind: "native",
      nativeEvent: "PreCompact",
      controls: [],
      note: "fail-open",
    },
    "compact.after": {
      kind: "native",
      nativeEvent: "PostCompact",
      controls: [],
      note: "fail-open",
    },
    notification: {
      kind: "native",
      nativeEvent: "Notification",
      controls: [],
      note: "fail-open",
    },
  },
  "factory-droid": {
    "tool.before": { kind: "native", nativeEvent: "PreToolUse", controls: ["block"] },
    "tool.after": { kind: "native", nativeEvent: "PostToolUse", controls: [] },
    "prompt.submit": { kind: "unsupported" },
    "permission.request": { kind: "unsupported" },
    "session.start": { kind: "native", nativeEvent: "SessionStart", controls: [] },
    "session.end": { kind: "native", nativeEvent: "SessionEnd", controls: [] },
    "tool.failure": { kind: "unsupported" },
    stop: { kind: "unsupported" },
    "subagent.start": { kind: "unsupported" },
    "subagent.stop": { kind: "unsupported" },
    "compact.before": { kind: "unsupported" },
    "compact.after": { kind: "unsupported" },
    notification: { kind: "unsupported" },
  },
  pi: {
    "tool.before": { kind: "native", nativeEvent: "tool_call", controls: ["block"] },
    "tool.after": { kind: "native", nativeEvent: "tool_result", controls: [] },
    "prompt.submit": { kind: "unsupported" },
    "permission.request": { kind: "unsupported" },
    "session.start": { kind: "native", nativeEvent: "session_start", controls: [] },
    "session.end": {
      kind: "degraded",
      nativeEvent: "session_shutdown",
      controls: [],
      note: "shutdown conflates quit and session switch",
    },
    "tool.failure": { kind: "unsupported" },
    stop: { kind: "unsupported" },
    "subagent.start": { kind: "unsupported" },
    "subagent.stop": { kind: "unsupported" },
    "compact.before": { kind: "unsupported" },
    "compact.after": { kind: "unsupported" },
    notification: { kind: "unsupported" },
  },
  cursor: {
    "tool.before": { kind: "unsupported", note: "no hook lowerer yet" },
    "tool.after": { kind: "unsupported", note: "no hook lowerer yet" },
    "prompt.submit": { kind: "unsupported", note: "no hook lowerer yet" },
    "permission.request": { kind: "unsupported", note: "no hook lowerer yet" },
    "session.start": { kind: "unsupported", note: "no hook lowerer yet" },
    "session.end": { kind: "unsupported", note: "no hook lowerer yet" },
    "tool.failure": { kind: "unsupported" },
    stop: { kind: "unsupported" },
    "subagent.start": { kind: "unsupported" },
    "subagent.stop": { kind: "unsupported" },
    "compact.before": { kind: "unsupported" },
    "compact.after": { kind: "unsupported" },
    notification: { kind: "unsupported" },
  },
  openclaw: {
    "tool.before": { kind: "unsupported", note: "no hook lowerer yet" },
    "tool.after": { kind: "unsupported", note: "no hook lowerer yet" },
    "prompt.submit": { kind: "unsupported", note: "no hook lowerer yet" },
    "permission.request": { kind: "unsupported", note: "no hook lowerer yet" },
    "session.start": { kind: "unsupported", note: "no hook lowerer yet" },
    "session.end": { kind: "unsupported", note: "no hook lowerer yet" },
    "tool.failure": { kind: "unsupported" },
    stop: { kind: "unsupported" },
    "subagent.start": { kind: "unsupported" },
    "subagent.stop": { kind: "unsupported" },
    "compact.before": { kind: "unsupported" },
    "compact.after": { kind: "unsupported" },
    notification: { kind: "unsupported" },
  },
  hermes: {
    "tool.before": {
      kind: "native",
      nativeEvent: "pre_tool_call",
      controls: ["block"],
    },
    "tool.after": {
      kind: "native",
      nativeEvent: "post_tool_call",
      controls: [],
    },
    "prompt.submit": {
      kind: "degraded",
      nativeEvent: "pre_llm_call",
      controls: ["additionalContext"],
      note: "inject-only, no block",
    },
    "permission.request": {
      kind: "unsupported",
      note: "observer-only, cannot decide",
    },
    "session.start": {
      kind: "native",
      nativeEvent: "on_session_start",
      controls: [],
    },
    "session.end": {
      kind: "native",
      nativeEvent: "on_session_end",
      controls: [],
    },
    "tool.failure": { kind: "unsupported", note: "no clean hermes shell mapping" },
    stop: { kind: "unsupported", note: "no clean hermes shell mapping" },
    "subagent.start": { kind: "unsupported", note: "no clean hermes shell mapping" },
    "subagent.stop": {
      kind: "native",
      nativeEvent: "subagent_stop",
      controls: [],
    },
    "compact.before": { kind: "unsupported", note: "no clean hermes shell mapping" },
    "compact.after": { kind: "unsupported", note: "no clean hermes shell mapping" },
    notification: { kind: "unsupported", note: "no clean hermes shell mapping" },
  },
};
