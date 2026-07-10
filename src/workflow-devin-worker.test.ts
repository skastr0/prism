import { describe, expect, test } from "bun:test";
import {
  buildDevinArgs,
  isDevinAuthOutput,
  mapDevinPermissionMode,
} from "./workflow-devin-worker.js";
import { WorkflowPermissionError } from "./workflow-permissions.js";

describe("workflow-devin-worker", () => {
  test("maps permission modes to Devin CLI flags", () => {
    expect(mapDevinPermissionMode("legacy")).toBeUndefined();
    expect(mapDevinPermissionMode("permissive")).toBe("accept-edits");
    expect(mapDevinPermissionMode("full-access")).toBe("dangerous");
    expect(mapDevinPermissionMode("restricted")).toBe("auto");
  });

  test("rejects interactive and unproven sandbox modes", () => {
    expect(() => mapDevinPermissionMode("interactive")).toThrow(WorkflowPermissionError);
    expect(() => mapDevinPermissionMode("sandbox-read-only")).toThrow(WorkflowPermissionError);
    expect(() => mapDevinPermissionMode("sandbox-workspace-write")).toThrow(WorkflowPermissionError);
  });

  test("buildDevinArgs includes print, model, export, and optional resume", () => {
    const args = buildDevinArgs({
      model: "swe-1-7",
      permission: "permissive",
      sessionId: "magenta-answer",
      agentConfigPath: "/tmp/agent.yaml",
      promptFilePath: "/tmp/prompt.md",
      exportPath: "/tmp/out.json",
    });
    expect(args).toEqual([
      "-p",
      "--model",
      "swe-1-7",
      "--permission-mode",
      "accept-edits",
      "-r",
      "magenta-answer",
      "--agent-config",
      "/tmp/agent.yaml",
      "--prompt-file",
      "/tmp/prompt.md",
      "--export",
      "/tmp/out.json",
    ]);
  });

  test("detects auth-required output", () => {
    expect(isDevinAuthOutput("error: not authenticated — run `devin auth login`")).toBe(true);
    expect(isDevinAuthOutput("pong")).toBe(false);
  });
});
