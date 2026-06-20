import { describe, expect, test } from "bun:test";
import { buildAmpArgs, assertAmpWorkflowMode } from "./workflow-amp-worker.js";
import { buildGrokArgs } from "./workflow-grok-worker.js";
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
    expect(args).not.toContain("--prompt-file");
    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual(["--agent", "qa-tester"]);
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
