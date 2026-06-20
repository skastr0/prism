import { describe, expect, test } from "bun:test";
import { buildAmpArgs, assertAmpWorkflowMode } from "./workflow-amp-worker.js";
import { buildClaudeArgs } from "./workflow-claude-worker.js";
import { buildGrokArgs, isGrokAuthOutput } from "./workflow-grok-worker.js";
import { buildOpenCodeArgs } from "./workflow-opencode-worker.js";
import { supportedWorkflowWorkers, UnsupportedWorkflowWorkerError, getWorkflowWorkerAdapter } from "./workflow-workers.js";

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
    expect(args).not.toContain("--prompt-file");
    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual(["--agent", "qa-tester"]);
  });

  test("grok auth output detection is line-based", () => {
    expect(isGrokAuthOutput("You are not authenticated.")).toBe(true);
    expect(isGrokAuthOutput("error: provider requires login before use")).toBe(true);
    expect(isGrokAuthOutput(JSON.stringify({ summary: "You are not authenticated." }))).toBe(false);
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
      },
    });

    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual(["--agent", "qa-tester"]);
    expect(args.slice(args.indexOf("--plugin-dir"), args.indexOf("--plugin-dir") + 2)).toEqual([
      "--plugin-dir",
      "/home/test/.claude/skills/prism-generated-prism-harness-qa",
    ]);
    expect(args).toContain("--mcp-config=/home/test/.claude/skills/prism-generated-prism-harness-qa/.mcp.json");
    expect(args).toContain("--strict-mcp-config");
  });

  test("amp accepts only deep and rush workflow modes", () => {
    expect(assertAmpWorkflowMode("deep")).toBe("deep");
    expect(assertAmpWorkflowMode("rush")).toBe("rush");
    expect(() => assertAmpWorkflowMode("smart")).toThrow("unsupported Amp workflow mode");
    expect(buildAmpArgs({ mode: "deep", prompt: "return json" })).toContain("deep");
  });

  test("antigravity-cli is not a supported workflow worker", () => {
    expect(supportedWorkflowWorkers()).not.toContain("antigravity-cli");
    expect(() => getWorkflowWorkerAdapter("antigravity-cli")).toThrow(UnsupportedWorkflowWorkerError);
  });
});
