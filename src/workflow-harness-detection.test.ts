import { describe, expect, test } from "bun:test";
import {
  detectWorkflowHarness,
  detectWorkflowHarnesses,
  WORKFLOW_HARNESS_IDS,
  workflowHarnessIdsForHarnesses,
} from "./workflow-harness-detection.js";
import { supportedWorkflowWorkers } from "./workflow-workers.js";

describe("workflow harness detection", () => {
  test("detection ids stay aligned with the workflow worker dispatch table", () => {
    const detectionIds: string[] = [...WORKFLOW_HARNESS_IDS].sort();
    const workerIds: string[] = [...supportedWorkflowWorkers()].sort();
    expect(detectionIds).toEqual(workerIds);
  });

  test("reports missing executables without running a probe", async () => {
    let probes = 0;
    const result = await detectWorkflowHarness("opencode", {
      resolveExecutable: () => undefined,
      verify: true,
      runProbe: async () => {
        probes += 1;
        return { exitCode: 0 };
      },
    });

    expect(probes).toBe(0);
    expect(result.available).toBe(false);
    expect(result.status).toBe("missing");
    expect(result.reason.code).toBe("executable-missing");
    expect(result.reason.command).toBe("opencode");
  });

  test("reports installed executables from PATH in startup-safe mode", async () => {
    const result = await detectWorkflowHarness("codex-cli", {
      resolveExecutable: (command) => `/usr/local/bin/${command}`,
      verify: false,
    });

    expect(result.available).toBe(true);
    expect(result.status).toBe("available");
    expect(result.reason.code).toBe("executable-found");
    expect(result.reason.executablePath).toBe("/usr/local/bin/codex");
  });

  test("honors workflow binary override environment variables", async () => {
    const result = await detectWorkflowHarness("claude-code", {
      env: { PRISM_WORKFLOW_CLAUDE_BIN: "/opt/harnesses/claude" },
      resolveExecutable: (command) => command,
    });

    expect(result.available).toBe(true);
    expect(result.reason.command).toBe("/opt/harnesses/claude");
    expect(result.reason.executablePath).toBe("/opt/harnesses/claude");
  });

  test("reports verified executables as available when the probe succeeds", async () => {
    const result = await detectWorkflowHarness("kimi-code", {
      resolveExecutable: (command) => `/bin/${command}`,
      verify: true,
      runProbe: async (command, args, options) => {
        expect(command).toBe("/bin/kimi");
        expect(args).toEqual(["--version"]);
        expect(options.timeoutMs).toBe(25);
        return { exitCode: 0 };
      },
      probeTimeoutMs: 25,
    });

    expect(result.available).toBe(true);
    expect(result.status).toBe("available");
    expect(result.reason.code).toBe("probe-succeeded");
  });

  test("reports broken executables when the probe exits nonzero", async () => {
    const result = await detectWorkflowHarness("amp-code", {
      resolveExecutable: (command) => `/bin/${command}`,
      verify: true,
      runProbe: async () => ({ exitCode: 2, stderr: "bad install" }),
    });

    expect(result.available).toBe(false);
    expect(result.status).toBe("broken");
    expect(result.reason.code).toBe("probe-exited-nonzero");
    expect(result.reason.exitCode).toBe(2);
    expect(result.reason.stderr).toBe("bad install");
  });

  test("reports broken executables when the probe fails or times out", async () => {
    const [failed, timedOut] = await detectWorkflowHarnesses({
      harnesses: ["grok", "hermes"],
      resolveExecutable: (command) => `/bin/${command}`,
      verify: true,
      runProbe: async (command) => {
        if (command.endsWith("/grok")) throw new Error("spawn EACCES");
        return { exitCode: null, timedOut: true };
      },
    });

    expect(failed?.status).toBe("broken");
    expect(failed?.reason.code).toBe("probe-failed");
    expect(timedOut?.status).toBe("broken");
    expect(timedOut?.reason.code).toBe("probe-timed-out");
  });

  test("filters general harness ids down to workflow harness ids", () => {
    expect(workflowHarnessIdsForHarnesses(["cursor", "opencode", "pi", "codex-cli"])).toEqual([
      "opencode",
      "codex-cli",
    ]);
  });
});
