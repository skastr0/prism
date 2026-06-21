import { describe, expect, test } from "bun:test";
import { buildAmpArgs, assertAmpWorkflowMode } from "./workflow-amp-worker.js";
import { buildClaudeArgs } from "./workflow-claude-worker.js";
import { buildGrokArgs, isGrokAuthOutput } from "./workflow-grok-worker.js";
import { isKimiAuthOutput, buildKimiArgs } from "./workflow-kimi-worker.js";
import { buildOpenCodeArgs } from "./workflow-opencode-worker.js";
import { buildHermesArgs } from "./workflow-hermes-worker.js";
import { buildCodexArgs } from "./workflow-codex-worker.js";
import { supportedWorkflowWorkers, UnsupportedWorkflowWorkerError, getWorkflowWorkerAdapter, WorkflowPermissionError } from "./workflow-workers.js";

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
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual(["--output-format", "plain"]);
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
    const args = buildClaudeArgs({
      agent: "qa-tester",
      model: "sonnet",
      prompt: "return json",
      generatedPlugin: {
        pluginDir: "/home/test/.claude/skills/prism-generated-prism-harness-qa",
        mcpConfig: "/home/test/.claude/skills/prism-generated-prism-harness-qa/.mcp.json",
        allowedTools: ["mcp__prism-generated-prism-harness-qa__prism_harness_qa_challenge_echo"],
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
    expect(args).toContain("--allowedTools=mcp__prism-generated-prism-harness-qa__prism_harness_qa_challenge_echo");
  });

  test("amp accepts only deep and rush workflow modes", () => {
    expect(assertAmpWorkflowMode("deep")).toBe("deep");
    expect(assertAmpWorkflowMode("rush")).toBe("rush");
    expect(() => assertAmpWorkflowMode("smart")).toThrow("unsupported Amp workflow mode");
    expect(buildAmpArgs({ mode: "deep", prompt: "return json", permission: "legacy" })).toContain("deep");
  });

  test("antigravity-cli is not a supported workflow worker", () => {
    expect(supportedWorkflowWorkers()).not.toContain("antigravity-cli");
    expect(() => getWorkflowWorkerAdapter("antigravity-cli")).toThrow(UnsupportedWorkflowWorkerError);
  });
});

describe("opencode permission arg mapping", () => {
  test("legacy emits no --dangerously-skip-permissions", () => {
    const args = buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "legacy" });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("permissive emits --dangerously-skip-permissions", () => {
    const args = buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "permissive" });
    expect(args).toContain("--dangerously-skip-permissions");
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
  });

  test("default emits permissive --dangerously-skip-permissions", () => {
    const args = buildClaudeArgs({ agent: "a", prompt: "p" });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("restricted with tools list emits --allowedTools", () => {
    const args = buildClaudeArgs({ agent: "a", prompt: "p", permission: "restricted", restrictedTools: ["Read", "Edit"] });
    expect(args).toContain("--allowedTools");
    const idx = args.indexOf("--allowedTools");
    expect(args[idx + 1]).toBe("Read,Edit");
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
});

describe("hermes permission arg mapping", () => {
  test("legacy emits no --yolo", () => {
    const args = buildHermesArgs({ prompt: "p", permission: "legacy" });
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
    const args = buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p", permission: "permissive" });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--sandbox");
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

  test("interactive throws", () => {
    expect(() => buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p", permission: "interactive" }))
      .toThrow(WorkflowPermissionError);
  });

  test("restricted throws", () => {
    expect(() => buildCodexArgs({ cwd: "/r", outputPath: "/tmp/o", prompt: "p", permission: "restricted" }))
      .toThrow(WorkflowPermissionError);
  });
});

describe("grok permission arg mapping", () => {
  test("legacy emits no --always-approve", () => {
    const args = buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "legacy" });
    expect(args).not.toContain("--always-approve");
  });

  test("permissive emits --always-approve and bypassPermissions", () => {
    const args = buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p", permission: "permissive" });
    expect(args).toContain("--always-approve");
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

  test("permissive emits --yolo", () => {
    const args = buildKimiArgs({ prompt: "p", skillsDir: "/s", permission: "permissive" });
    expect(args).toContain("--yolo");
  });

  test("default emits permissive --yolo", () => {
    const args = buildKimiArgs({ prompt: "p", skillsDir: "/s" });
    expect(args).toContain("--yolo");
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

  test("full-access emits --yolo", () => {
    const args = buildKimiArgs({ prompt: "p", skillsDir: "/s", permission: "full-access" });
    expect(args).toContain("--yolo");
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
