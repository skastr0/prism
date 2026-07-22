import { describe, expect, test } from "bun:test";

// --- stubs after MCP tree deletion (tests may still reference old names) ---
const __mcpDeleted = (name: string): any => {
  throw new Error(`MCP surface deleted: ${name}`);
};
const pluginServerKey = (pluginName: string): string =>
  pluginName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
const shimServerKey = (_harness: string): string => "prism";
const bareWireToolName = (_plugin: string, tool: string): string => tool;
const renderAllowlist = (...args: unknown[]): string => String(args[args.length - 1] ?? "");
const renderPluginAllowlist = (...args: unknown[]): string => {
  const tool = String(args[args.length - 1] ?? "");
  const plugin = String(args[args.length - 2] ?? "");
  return `${pluginServerKey(plugin)}__${tool}`;
};
const renderPluginWire = (plugin: string, tool: string, ..._rest: unknown[]): string =>
  `${pluginServerKey(plugin)}_${tool}`;
const generatedMcpWireServerName = (pluginName: string): string => `prism-generated-${pluginName}`;
const generatedMcpServerName = generatedMcpWireServerName;
const prismMcpServerPath = (prismHome: string, pluginName: string): string =>
  `${prismHome}/runtime/mcp/${pluginName}/server.mjs`;
const prismMcpServerStdioPath = (prismHome: string, pluginName: string): string =>
  `${prismHome}/runtime/mcp/${pluginName}/entry-stdio.mjs`;
const writePrismMcpServerBundle = async (..._args: unknown[]): Promise<{ path: string }> =>
  __mcpDeleted("writePrismMcpServerBundle");
const resolveOwnerMcpRuntime = (..._args: unknown[]): any => __mcpDeleted("resolveOwnerMcpRuntime");
const generateMcpServerBundle = async (..._args: unknown[]): Promise<any> =>
  __mcpDeleted("generateMcpServerBundle");
const mcpServerRuntimeSourceSha256 = (): string => "deleted";
const readMcpServerSourceSha256FromBundle = (_c: string): string | undefined => undefined;
const cleanupPrismMcpProcessesUnder = async (_root: string): Promise<void> => {};
const pluginDaemonLogPath = (..._args: unknown[]): string => "/tmp/prism-mcp-deleted.log";
const registerDaemon = async (..._args: unknown[]): Promise<any> => __mcpDeleted("registerDaemon");
type RegistryEntry = { pluginName: string; pid?: number };
type RegistryResult = { ok: boolean };
// --- end stubs ---
import { buildAmpArgs, assertAmpWorkflowMode } from "./workflow-amp-worker.js";
import {
  DEFAULT_ANTIGRAVITY_MODEL,
  assertAgyPrintArgsWorkflowSafe,
  buildAgyArgs,
  parseAgyConversationId,
  resolveAntigravityPermission,
  type AgyPrintArgs,
} from "./workflow-antigravity-worker.js";
import { buildClaudeArgs } from "./workflow-claude-worker.js";
import { buildGrokArgs, isGrokAuthOutput } from "./workflow-grok-worker.js";
import { isKimiAuthOutput, buildKimiArgs } from "./workflow-kimi-worker.js";
import { buildOpenCodeArgs } from "./workflow-opencode-worker.js";
import { buildHermesArgs } from "./workflow-hermes-worker.js";
import { buildCodexArgs } from "./workflow-codex-worker.js";
import { supportedWorkflowWorkers, getWorkflowWorkerAdapter, WorkflowPermissionError, type WorkflowWorkerAdapterOptionsForCapability } from "./workflow-workers.js";
import type { WorkflowTaskRepairContext } from "./workflow-runner.js";

type UnsupportedRepairOptions = WorkflowWorkerAdapterOptionsForCapability<"no-repair-loop-continuation">;

const assertUnsupportedRepairContextIsUnrepresentable = (options: UnsupportedRepairOptions): void => {
  // @ts-expect-error unsupported harness contexts cannot read repair-loop state
  void options.context?.repair;
};

void assertUnsupportedRepairContextIsUnrepresentable;
const invalidUnsupportedRepairOptions: UnsupportedRepairOptions = {
  cwd: "/repo",
  resolvedPermission: "legacy",
  context: {
    // @ts-expect-error unsupported harness contexts cannot receive repair-loop state
    repair: {} as WorkflowTaskRepairContext,
  },
};
void invalidUnsupportedRepairOptions;

describe("workflow worker argument builders", () => {
  test("grok uses explicit single-turn mode", () => {
    const args = buildGrokArgs({
      cwd: "/repo",
      agent: "qa-tester",
      model: "grok-build",
      prompt: "return json",
    });

    expect(args).toContain("--single");
    expect(args.slice(args.indexOf("--allow"), args.indexOf("--allow") + 2)).toEqual(["--allow", "MCPTool"]);
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual(["--output-format", "json"]);
    expect(args).toContain("--no-wait-for-background");
    expect(args).not.toContain("--prompt-file");
    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual(["--agent", "qa-tester"]);
  });

  test("grok auth output detection is line-based", () => {
    expect(isGrokAuthOutput("You are not authenticated.")).toBe(true);
    expect(isGrokAuthOutput("error: provider requires login before use")).toBe(true);
    expect(isGrokAuthOutput(JSON.stringify({ summary: "You are not authenticated." }))).toBe(false);
  });

  test("kimi auth output detection is line-based", () => {
    expect(isKimiAuthOutput(
      'error: failed to run prompt: auth.login_required: OAuth provider "managed:kimi-code" requires login before it can be used.',
    )).toBe(true);
    expect(isKimiAuthOutput(JSON.stringify({ summary: "auth.login_required: requires login" }))).toBe(false);
  });

  test("opencode invokes the generated agent directly", () => {
    const args = buildOpenCodeArgs({
      cwd: "/repo",
      agent: "qa-tester",
      model: "provider/model",
      prompt: "return json",
    });

    expect(args).toContain("--agent");
    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual(["--agent", "qa-tester"]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "provider/model"]);
    expect(args).not.toContain("subagent");
  });

  test("claude loads generated plugin MCP config explicitly", () => {
    const allowedToolName = `mcp__${generatedMcpWireServerName("prism-harness-qa")}__prism_harness_qa_challenge_echo`;
    const args = buildClaudeArgs({
      agent: "qa-tester",
      model: "sonnet",
      prompt: "return json",
      generatedPlugin: {
        pluginDir: "/home/test/.claude/skills/prism-generated-prism-harness-qa",
        mcpConfig: "/home/test/.claude/skills/prism-generated-prism-harness-qa/.mcp.json",
        allowedTools: [allowedToolName],
      },
    });

    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual(["--agent", "qa-tester"]);
    expect(args.slice(args.indexOf("--plugin-dir"), args.indexOf("--plugin-dir") + 2)).toEqual([
      "--plugin-dir",
      "/home/test/.claude/skills/prism-generated-prism-harness-qa",
    ]);
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(args).toContain("--verbose");
    expect(args).toContain("--mcp-config=/home/test/.claude/skills/prism-generated-prism-harness-qa/.mcp.json");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain(`--allowedTools=${allowedToolName}`);
  });

  test("amp accepts only deep and rush workflow modes", () => {
    expect(assertAmpWorkflowMode("deep")).toBe("deep");
    expect(assertAmpWorkflowMode("rush")).toBe("rush");
    expect(() => assertAmpWorkflowMode("smart")).toThrow("unsupported Amp workflow mode");
    expect(buildAmpArgs({ mode: "deep", prompt: "return json", permission: "legacy" })).toContain("deep");
  });

  test("antigravity-cli is a supported workflow worker", () => {
    expect(supportedWorkflowWorkers()).toContain("antigravity-cli");
    expect(getWorkflowWorkerAdapter("antigravity-cli").id).toBe("antigravity-cli");
  });

  test("workflow workers expose one task execution entrypoint", () => {
    for (const worker of ["amp-code", "antigravity-cli", "claude-code", "codex-cli", "grok", "hermes", "kimi-code", "opencode"]) {
      const adapter = getWorkflowWorkerAdapter(worker);
      expect(typeof adapter.runTask).toBe("function");
      expect("continueTask" in adapter).toBe(false);
    }
  });
});

describe("workflow worker continuation arg mapping", () => {
  test("claude uses exact session resume only", () => {
    const args = buildClaudeArgs({ agent: "a", prompt: "p", resumeSessionId: "s1" });
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "s1"]);
    expect(args).not.toContain("--continue");
  });

  test("opencode uses exact session id", () => {
    const args = buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p", sessionId: "s1" });
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "s1"]);
    expect(args).not.toContain("--continue");
  });

  test("grok uses exact session id", () => {
    const args = buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p", sessionId: "s1" });
    expect(args.slice(args.indexOf("-r"), args.indexOf("-r") + 2)).toEqual(["-r", "s1"]);
    expect(args).not.toContain("--continue");
  });

  test("hermes uses exact session resume", () => {
    const args = buildHermesArgs({ prompt: "p", resumeSessionId: "s1", permission: "legacy" });
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "s1"]);
    expect(args).toContain("chat");
    expect(args).not.toContain("--continue");
  });

  test("kimi uses exact session id", () => {
    const args = buildKimiArgs({ prompt: "p", skillsDir: "/s", sessionId: "s1" });
    expect(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2)).toEqual(["--session", "s1"]);
    expect(args).not.toContain("--continue");
  });

  test("codex maps continuation to exec resume", () => {
    const args = buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p", resumeSessionId: "s1" });
    expect(args.slice(args.indexOf("resume"), args.indexOf("resume") + 2)).toEqual(["resume", "s1"]);
    expect(args).not.toContain("--ephemeral");
    expect(args).not.toContain("--last");
  });

  test("amp maps continuation to exact thread id", () => {
    const args = buildAmpArgs({ prompt: "p", permission: "legacy", sessionId: "s1" });
    expect(args.slice(args.indexOf("threads"), args.indexOf("threads") + 3)).toEqual(["threads", "continue", "s1"]);
    expect(args).toContain("--stream-json");
    expect(args).not.toContain("last");
  });
});

describe("antigravity-cli permission arg mapping", () => {
  test("puts all options before --print so agy receives the prompt value", () => {
    const args: AgyPrintArgs = buildAgyArgs({ cwd: "/r", model: "Gemini", prompt: "p", printTimeout: "5m", permission: "permissive" });
    const rawArgs: readonly string[] = args;
    expect(rawArgs).toEqual([
      "--dangerously-skip-permissions",
      "--sandbox",
      "--print-timeout",
      "5m",
      "--add-dir",
      "/r",
      "--model",
      "Gemini",
      "--print",
      "p",
    ]);
    // @ts-expect-error AgyPrintArgs permits no flags after the prompt-valued --print pair.
    const bad: AgyPrintArgs = ["--print", "p", "--model", "Gemini"] as const;
    void bad;
    // @ts-expect-error AgyPrintArgs forbids global latest-conversation continuation.
    const continueBad: AgyPrintArgs = ["--continue", "--print", "p"] as const;
    void continueBad;
    // @ts-expect-error AgyPrintArgs forbids the short alias for global latest-conversation continuation.
    const shortContinueBad: AgyPrintArgs = ["-c", "--print", "p"] as const;
    void shortContinueBad;
  });

  test("rejects forbidden global continuation flags before spawn", () => {
    expect(() => assertAgyPrintArgsWorkflowSafe(["--continue", "--print", "p"]))
      .toThrow("explicit --conversation id");
    expect(() => assertAgyPrintArgsWorkflowSafe(["-c", "--print", "p"]))
      .toThrow("explicit --conversation id");
  });

  test("allows prompt text that happens to name a forbidden flag", () => {
    const args = buildAgyArgs({
      cwd: "/r",
      model: DEFAULT_ANTIGRAVITY_MODEL,
      prompt: "--continue",
      printTimeout: "5m",
      permission: "permissive",
    });
    expect(() => assertAgyPrintArgsWorkflowSafe(args)).not.toThrow();
  });

  test("puts continuation flags before --print", () => {
    const conversationId = parseAgyConversationId("103febcc-41a4-435b-a6ed-f6992fb1c3ff");
    expect(conversationId).toBeDefined();
    const args: readonly string[] = buildAgyArgs({
      cwd: "/r",
      conversationId,
      logFile: "/tmp/agy.log",
      model: DEFAULT_ANTIGRAVITY_MODEL,
      prompt: "p",
      printTimeout: "5m",
      permission: "permissive",
    });
    expect(args.slice(0, 4)).toEqual([
      "--log-file",
      "/tmp/agy.log",
      "--conversation",
      "103febcc-41a4-435b-a6ed-f6992fb1c3ff",
    ]);
    expect(args.indexOf("--conversation")).toBeLessThan(args.indexOf("--print"));
  });

  test("legacy preserves the previous permissive agy flags", () => {
    const args: readonly string[] = buildAgyArgs({ cwd: "/r", model: DEFAULT_ANTIGRAVITY_MODEL, prompt: "p", printTimeout: "5m", permission: "legacy" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--sandbox");
  });

  test("default emits permissive agy flags", () => {
    const args: readonly string[] = buildAgyArgs({ cwd: "/r", model: DEFAULT_ANTIGRAVITY_MODEL, prompt: "p", printTimeout: "5m" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--sandbox");
  });

  test("restricted throws", () => {
    expect(() => resolveAntigravityPermission("restricted"))
      .toThrow(WorkflowPermissionError);
  });

  test("interactive throws", () => {
    expect(() => resolveAntigravityPermission("interactive"))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-read-only throws", () => {
    expect(() => resolveAntigravityPermission("sandbox-read-only"))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-workspace-write throws", () => {
    expect(() => resolveAntigravityPermission("sandbox-workspace-write"))
      .toThrow(WorkflowPermissionError);
  });

  test("full-access emits previous permissive agy flags", () => {
    const args: readonly string[] = buildAgyArgs({ cwd: "/r", model: DEFAULT_ANTIGRAVITY_MODEL, prompt: "p", printTimeout: "5m", permission: "full-access" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--sandbox");
  });
});

describe("opencode permission arg mapping", () => {
  test("legacy emits no --dangerously-skip-permissions", () => {
    const args = buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "legacy" });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("permissive emits --dangerously-skip-permissions", () => {
    const args = buildOpenCodeArgs({ cwd: "/r", agent: "a", model: "provider/model", prompt: "p", permission: "permissive" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual(["--agent", "a"]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "provider/model"]);
  });

  test("default emits permissive --dangerously-skip-permissions", () => {
    const args = buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p" });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("restricted throws WorkflowPermissionError", () => {
    expect(() => buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "restricted" }))
      .toThrow(WorkflowPermissionError);
  });

  test("interactive throws WorkflowPermissionError", () => {
    expect(() => buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "interactive" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-read-only throws WorkflowPermissionError", () => {
    expect(() => buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "sandbox-read-only" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-workspace-write throws WorkflowPermissionError", () => {
    expect(() => buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "sandbox-workspace-write" }))
      .toThrow(WorkflowPermissionError);
  });

  test("full-access emits --dangerously-skip-permissions", () => {
    const args = buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "full-access" });
    expect(args).toContain("--dangerously-skip-permissions");
  });
});

describe("claude-code permission arg mapping", () => {
  test("legacy emits --print only", () => {
    const args = buildClaudeArgs({ agent: "a", prompt: "p", permission: "legacy" });
    expect(args).toContain("--print");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("permissive emits --dangerously-skip-permissions --print --output-format stream-json", () => {
    const args = buildClaudeArgs({ agent: "a", prompt: "p", permission: "permissive" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--print");
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual(["--agent", "a"]);
  });

  test("default emits permissive --dangerously-skip-permissions", () => {
    const args = buildClaudeArgs({ agent: "a", prompt: "p" });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("restricted with tools list emits --allowedTools", () => {
    const args = buildClaudeArgs({ agent: "a", prompt: "p", permission: "restricted", restrictedTools: ["Read", "Edit"] });
    expect(args).toContain("--allowedTools=Read,Edit");
  });

  test("restricted with no tools list throws", () => {
    expect(() => buildClaudeArgs({ agent: "a", prompt: "p", permission: "restricted" }))
      .toThrow(WorkflowPermissionError);
  });

  test("interactive throws", () => {
    expect(() => buildClaudeArgs({ agent: "a", prompt: "p", permission: "interactive" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-read-only throws", () => {
    expect(() => buildClaudeArgs({ agent: "a", prompt: "p", permission: "sandbox-read-only" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-workspace-write throws", () => {
    expect(() => buildClaudeArgs({ agent: "a", prompt: "p", permission: "sandbox-workspace-write" }))
      .toThrow(WorkflowPermissionError);
  });

  test("full-access emits same as permissive", () => {
    const args = buildClaudeArgs({ agent: "a", prompt: "p", permission: "full-access" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--print");
  });

  test("emits json schema only when a native output schema is supplied", () => {
    const withoutSchema = buildClaudeArgs({ agent: "a", prompt: "p" });
    expect(withoutSchema).not.toContain("--json-schema");

    const outputSchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    const args = buildClaudeArgs({ agent: "a", prompt: "p", outputSchema });
    const idx = args.indexOf("--json-schema");
    expect(idx).not.toBe(-1);
    expect(JSON.parse(args[idx + 1] ?? "")).toEqual(outputSchema);
  });
});

describe("hermes permission arg mapping", () => {
  test("legacy emits no --yolo", () => {
    const args = buildHermesArgs({ prompt: "p", permission: "legacy" });
    expect(args.slice(0, 3)).toEqual(["chat", "--query", "p"]);
    expect(args).not.toContain("--yolo");
  });

  test("permissive emits --yolo", () => {
    const args = buildHermesArgs({ prompt: "p", permission: "permissive" });
    expect(args).toContain("--yolo");
  });

  test("default emits permissive --yolo", () => {
    const args = buildHermesArgs({ prompt: "p" });
    expect(args).toContain("--yolo");
  });

  test("restricted throws", () => {
    expect(() => buildHermesArgs({ prompt: "p", permission: "restricted" }))
      .toThrow(WorkflowPermissionError);
  });

  test("interactive throws", () => {
    expect(() => buildHermesArgs({ prompt: "p", permission: "interactive" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-read-only throws", () => {
    expect(() => buildHermesArgs({ prompt: "p", permission: "sandbox-read-only" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-workspace-write throws", () => {
    expect(() => buildHermesArgs({ prompt: "p", permission: "sandbox-workspace-write" }))
      .toThrow(WorkflowPermissionError);
  });

  test("full-access emits --yolo", () => {
    const args = buildHermesArgs({ prompt: "p", permission: "full-access" });
    expect(args).toContain("--yolo");
  });

  test("profile precedes chat query for Hermes profile selection", () => {
    const args = buildHermesArgs({ prompt: "p", profile: "lyra03", permission: "legacy" });
    expect(args.slice(0, 5)).toEqual(["--profile", "lyra03", "chat", "--query", "p"]);
  });
});

describe("codex-cli permission arg mapping", () => {
  test("legacy preserves the previous workspace-write sandbox", () => {
    const args = buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p", permission: "legacy" });
    const idx = args.indexOf("--sandbox");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("workspace-write");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("permissive bypasses approvals and sandbox", () => {
    const args = buildCodexArgs({ cwd: "/r", model: "gpt-5.1-codex", outputPath: "/tmp/o", prompt: "p", permission: "permissive" });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "gpt-5.1-codex"]);
    expect(args.slice(args.indexOf("--cd"), args.indexOf("--cd") + 2)).toEqual(["--cd", "/r"]);
    expect(args).not.toContain("--sandbox");
  });

  test("passes the resolved Codex model reasoning variant explicitly", () => {
    const args = buildCodexArgs({
      cwd: "/r",
      model: "gpt-5.6-luna",
      variant: "high",
      outputPath: "/tmp/o",
      prompt: "p",
      permission: "permissive",
    });
    expect(args.slice(args.indexOf("--config"), args.indexOf("--config") + 2))
      .toEqual(["--config", 'model_reasoning_effort="high"']);
  });

  test("default bypasses approvals and sandbox", () => {
    const args = buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p" });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--sandbox");
  });

  test("sandbox-read-only emits --sandbox read-only", () => {
    const args = buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p", permission: "sandbox-read-only" });
    const idx = args.indexOf("--sandbox");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("read-only");
    expect(args).not.toContain("--ask-for-approval");
  });

  test("sandbox-workspace-write emits --sandbox workspace-write", () => {
    const args = buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p", permission: "sandbox-workspace-write" });
    const idx = args.indexOf("--sandbox");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("workspace-write");
    expect(args).not.toContain("--ask-for-approval");
  });

  test("full-access bypasses approvals and sandbox", () => {
    const args = buildCodexArgs({ cwd: "/r", model: "gpt-5.1-codex", outputPath: "/tmp/o", prompt: "p", permission: "full-access" });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "gpt-5.1-codex"]);
    expect(args.slice(args.indexOf("--cd"), args.indexOf("--cd") + 2)).toEqual(["--cd", "/r"]);
    expect(args).not.toContain("--sandbox");
  });

  test("interactive throws", () => {
    expect(() => buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p", permission: "interactive" }))
      .toThrow(WorkflowPermissionError);
  });

  test("restricted throws", () => {
    expect(() => buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p", permission: "restricted" }))
      .toThrow(WorkflowPermissionError);
  });

  test("emits output schema only when a native output schema path is supplied", () => {
    const withoutSchema = buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p" });
    expect(withoutSchema).not.toContain("--output-schema");

    const args = buildCodexArgs({
      cwd: "/r",
      outputPath: "/tmp/o",
      outputSchemaPath: "/tmp/schema.json",
      prompt: "p",
    });
    expect(args.slice(args.indexOf("--output-schema"), args.indexOf("--output-schema") + 2)).toEqual([
      "--output-schema",
      "/tmp/schema.json",
    ]);
  });
});

describe("grok permission arg mapping", () => {
  test("legacy emits no --always-approve", () => {
    const args = buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "legacy" });
    expect(args).not.toContain("--always-approve");
  });

  test("permissive emits --always-approve and bypassPermissions", () => {
    const args = buildGrokArgs({ cwd: "/r", agent: "a", model: "grok-model", prompt: "p", permission: "permissive" });
    expect(args).toContain("--always-approve");
    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual(["--agent", "a"]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "grok-model"]);
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  test("model override replaces the grok-build fallback", () => {
    const args = buildGrokArgs({ cwd: "/r", agent: "a", model: "grok-custom", prompt: "p", permission: "legacy" });
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "grok-custom"]);
  });

  test("default emits permissive --always-approve and bypassPermissions", () => {
    const args = buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p" });
    expect(args).toContain("--always-approve");
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  test("restricted throws", () => {
    expect(() => buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "restricted" }))
      .toThrow(WorkflowPermissionError);
  });

  test("interactive throws", () => {
    expect(() => buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "interactive" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-read-only throws", () => {
    expect(() => buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "sandbox-read-only" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-workspace-write throws", () => {
    expect(() => buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "sandbox-workspace-write" }))
      .toThrow(WorkflowPermissionError);
  });

  test("full-access emits --always-approve and bypassPermissions", () => {
    const args = buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "full-access" });
    expect(args).toContain("--always-approve");
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });
});

describe("kimi-code permission arg mapping", () => {
  test("legacy emits no --yolo", () => {
    const args = buildKimiArgs({ prompt: "p", skillsDir: "/s", permission: "legacy" });
    expect(args).not.toContain("--yolo");
  });

  test("permissive omits --yolo because Kimi prompt mode rejects it", () => {
    const args = buildKimiArgs({ model: "moonshot/kimi-k2", prompt: "p", skillsDir: "/s", permission: "permissive" });
    expect(args).not.toContain("--yolo");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "moonshot/kimi-k2"]);
    expect(args.slice(args.indexOf("--skills-dir"), args.indexOf("--skills-dir") + 2)).toEqual(["--skills-dir", "/s"]);
  });

  test("default omits --yolo", () => {
    const args = buildKimiArgs({ prompt: "p", skillsDir: "/s" });
    expect(args).not.toContain("--yolo");
  });

  test("restricted throws", () => {
    expect(() => buildKimiArgs({ prompt: "p", skillsDir: "/s", permission: "restricted" }))
      .toThrow(WorkflowPermissionError);
  });

  test("interactive throws", () => {
    expect(() => buildKimiArgs({ prompt: "p", skillsDir: "/s", permission: "interactive" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-read-only throws", () => {
    expect(() => buildKimiArgs({ prompt: "p", skillsDir: "/s", permission: "sandbox-read-only" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-workspace-write throws", () => {
    expect(() => buildKimiArgs({ prompt: "p", skillsDir: "/s", permission: "sandbox-workspace-write" }))
      .toThrow(WorkflowPermissionError);
  });

  test("full-access omits --yolo because Kimi prompt mode rejects it", () => {
    const args = buildKimiArgs({ prompt: "p", skillsDir: "/s", permission: "full-access" });
    expect(args).not.toContain("--yolo");
  });
});

describe("amp-code permission arg mapping", () => {
  test("legacy emits no settings override", () => {
    const args = buildAmpArgs({ prompt: "p", permission: "legacy" });
    expect(args).not.toContain("--settings-file");
  });

  test("permissive uses a settings file override when provided", () => {
    const args = buildAmpArgs({ prompt: "p", permission: "permissive", settingsFile: "/tmp/amp-settings.json" });
    expect(args.slice(args.indexOf("--settings-file"), args.indexOf("--settings-file") + 2)).toEqual(["--settings-file", "/tmp/amp-settings.json"]);
  });

  test("permissive without settings file throws", () => {
    expect(() => buildAmpArgs({ prompt: "p", permission: "permissive" }))
      .toThrow("requires a generated settings file");
  });

  test("restricted throws", () => {
    expect(() => buildAmpArgs({ prompt: "p", permission: "restricted" }))
      .toThrow(WorkflowPermissionError);
  });

  test("interactive throws", () => {
    expect(() => buildAmpArgs({ prompt: "p", permission: "interactive" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-read-only throws", () => {
    expect(() => buildAmpArgs({ prompt: "p", permission: "sandbox-read-only" }))
      .toThrow(WorkflowPermissionError);
  });

  test("sandbox-workspace-write throws", () => {
    expect(() => buildAmpArgs({ prompt: "p", permission: "sandbox-workspace-write" }))
      .toThrow(WorkflowPermissionError);
  });

  test("full-access uses a settings file override when provided", () => {
    const args = buildAmpArgs({ prompt: "p", permission: "full-access", settingsFile: "/tmp/amp-settings.json" });
    expect(args.slice(args.indexOf("--settings-file"), args.indexOf("--settings-file") + 2)).toEqual(["--settings-file", "/tmp/amp-settings.json"]);
  });
});
