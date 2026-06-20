import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAntigravityPtyProcess, antigravityPtyWrapperScript } from "./workflow-antigravity-pty.js";
import { detectAgyPrintTimeout, buildAgyArgs, runAntigravityWorkflowTask } from "./workflow-antigravity-worker.js";
import { Schema } from "effect";

const createTempRoot = async (): Promise<string> =>
  mkdtemp(path.join(tmpdir(), "prism-antigravity-worker-test-"));

describe("detectAgyPrintTimeout", () => {
  test("matches the trailing sentinel line", () => {
    expect(detectAgyPrintTimeout("notice\nError: timed out waiting for response\n", "")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(detectAgyPrintTimeout("ERROR: Timed Out Waiting For Response", "")).toBe(true);
  });

  test("does not match when the sentinel is not at the end", () => {
    expect(detectAgyPrintTimeout("Error: timed out waiting for response\nmore text", "")).toBe(false);
  });

  test("does not match prose containing the phrase", () => {
    expect(detectAgyPrintTimeout("This is not an Error: timed out waiting for response message.", "")).toBe(false);
  });

  test("matches sentinel on stderr", () => {
    expect(detectAgyPrintTimeout("", "Error: timed out waiting for response")).toBe(true);
  });
});

describe("buildAgyArgs", () => {
  test("includes the expected flags and positional prompt", () => {
    const args = buildAgyArgs({ cwd: "/tmp", model: "Gemini 3.5 Flash (Low)", printTimeout: "20s", prompt: "hello" });
    expect(args).toEqual([
      "--print",
      "--dangerously-skip-permissions",
      "--sandbox",
      "--print-timeout",
      "20s",
      "--add-dir",
      "/tmp",
      "--model",
      "Gemini 3.5 Flash (Low)",
      "hello",
    ]);
  });

  test("omits --model when not provided", () => {
    const args = buildAgyArgs({ cwd: "/tmp", printTimeout: "5m", prompt: "hello" });
    expect(args).not.toContain("--model");
  });
});

describe("antigravityPtyWrapperScript", () => {
  test("returns a non-empty Python script", () => {
    const script = antigravityPtyWrapperScript();
    expect(script.length).toBeGreaterThan(0);
    expect(script).toContain("#!/usr/bin/env python3");
    expect(script).toContain("pty.fork()");
  });
});

describe("runAntigravityPtyProcess", () => {
  test("runs a simple command through the PTY wrapper and captures stdout", async () => {
    const root = await createTempRoot();
    try {
      const result = await runAntigravityPtyProcess({
        command: "echo",
        args: ["hello from pty"],
        cwd: root,
        processTimeoutMs: 5_000,
        printTimeout: "5s",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello from pty");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("kills the process group when the outer timeout fires", async () => {
    const root = await createTempRoot();
    try {
      const result = await runAntigravityPtyProcess({
        command: "sh",
        args: ["-c", "sleep 100 & sleep 100 & wait"],
        cwd: root,
        processTimeoutMs: 500,
        printTimeout: "5s",
      });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runAntigravityWorkflowTask retries", () => {
  test("retries on the agy timeout sentinel and succeeds when the next attempt returns JSON", async () => {
    const root = await createTempRoot();
    try {
      const fakeAgy = path.join(root, "fake-agy.mjs");
      const stateFile = path.join(root, "state.txt");
      await writeFile(stateFile, "0");
      await writeFile(
        fakeAgy,
        [
          "#!/usr/bin/env node",
          "import { readFileSync, writeFileSync } from 'node:fs';",
          "const stateFile = './state.txt';",
          "const count = Number(readFileSync(stateFile, 'utf8'));",
          "writeFileSync(stateFile, String(count + 1));",
          "if (count === 0) {",
          "  console.log('Error: timed out waiting for response');",
          "  process.exit(0);",
          "}",
          "console.log(JSON.stringify({ ok: true, attempt: count }));",
          "",
        ].join("\n"),
      );
      await chmod(fakeAgy, 0o755);

      const task = {
        kind: "workflow-task" as const,
        id: "retry-test",
        agent: {
          kind: "agent-ref" as const,
          plugin: "test",
          name: "agent",
          description: "test agent",
          sourceHash: "a".repeat(64),
          manifestHash: "a".repeat(64),
          installs: ["antigravity-cli"],
        },
        prompt: "Return JSON {\"ok\": true}",
        output: Schema.Struct({ ok: Schema.Boolean, attempt: Schema.Number }),
      };

      const result = await runAntigravityWorkflowTask(task, {
        cwd: root,
        bin: fakeAgy,
        processTimeoutMs: 5_000,
        printTimeout: "5s",
        maxAttempts: 2,
        backoffMs: 100,
      });

      expect(result.output).toEqual({ ok: true, attempt: 1 });
      expect(result.metadata?.adapter).toBe("antigravity-cli");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails after exhausting retries on repeated sentinel", async () => {
    const root = await createTempRoot();
    try {
      const fakeAgy = path.join(root, "fake-agy.mjs");
      await writeFile(
        fakeAgy,
        [
          "#!/usr/bin/env node",
          "console.log('Error: timed out waiting for response');",
          "process.exit(0);",
          "",
        ].join("\n"),
      );
      await chmod(fakeAgy, 0o755);

      const task = {
        kind: "workflow-task" as const,
        id: "retry-exhausted",
        agent: {
          kind: "agent-ref" as const,
          plugin: "test",
          name: "agent",
          description: "test agent",
          sourceHash: "a".repeat(64),
          manifestHash: "a".repeat(64),
          installs: ["antigravity-cli"],
        },
        prompt: "Return JSON {\"ok\": true}",
        output: Schema.Struct({ ok: Schema.Boolean }),
      };

      await expect(
        runAntigravityWorkflowTask(task, {
          cwd: root,
          bin: fakeAgy,
          processTimeoutMs: 5_000,
          printTimeout: "5s",
          maxAttempts: 2,
          backoffMs: 100,
        }),
      ).rejects.toThrow("agy print mode failed before Prism worker JSON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails terminally when PTY setup cannot start", async () => {
    const root = await createTempRoot();
    const oldPty = process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY;
    const oldPython = process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY_PYTHON;
    try {
      process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY = "1";
      process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY_PYTHON = path.join(root, "missing-python");
      const task = {
        kind: "workflow-task" as const,
        id: "pty-setup-failure",
        agent: {
          kind: "agent-ref" as const,
          plugin: "test",
          name: "agent",
          description: "test agent",
          sourceHash: "a".repeat(64),
          manifestHash: "a".repeat(64),
          installs: ["antigravity-cli"],
        },
        prompt: "Return JSON {\"ok\": true}",
        output: Schema.Struct({ ok: Schema.Boolean }),
      };

      await expect(
        runAntigravityWorkflowTask(task, {
          cwd: root,
          bin: "echo",
          processTimeoutMs: 5_000,
          printTimeout: "5s",
          maxAttempts: 2,
          backoffMs: 100,
        }),
      ).rejects.toThrow("agy process setup failed before Prism worker JSON");
    } finally {
      if (oldPty === undefined) {
        delete process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY;
      } else {
        process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY = oldPty;
      }
      if (oldPython === undefined) {
        delete process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY_PYTHON;
      } else {
        process.env.PRISM_WORKFLOW_ANTIGRAVITY_PTY_PYTHON = oldPython;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
