import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAntigravityPtyProcess, antigravityPtyWrapperScript } from "./workflow-antigravity-pty.js";
import {
  DEFAULT_ANTIGRAVITY_MODEL,
  assertAntigravityWorkflowCapabilities,
  buildAgyArgs,
  detectAgyPrintTimeout,
  extractAgyConversationId,
  parseAgyConversationId,
  resolveAntigravityPermission,
  runAntigravityWorkflowTask,
} from "./workflow-antigravity-worker.js";
import { WorkflowOutputParseError } from "./workflow-worker-contract.js";
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

  test("matches the sentinel independently on either stream", () => {
    expect(detectAgyPrintTimeout("Error: timed out waiting for response", "stderr warning after stdout")).toBe(true);
    expect(detectAgyPrintTimeout("stdout warning before stderr", "Error: timed out waiting for response")).toBe(true);
  });

  // Live-observed wording (WFE-005): agy in the wild emits "timeout" (no "-ed",
  // no space), not the "timed out" wording above. Both must match so the retry
  // path fires — this exact string was the dominant Jul-9 failure class.
  test("matches the live-observed 'timeout waiting for response' wording", () => {
    expect(detectAgyPrintTimeout("notice\nError: timeout waiting for response\n", "")).toBe(true);
    expect(detectAgyPrintTimeout("", "Error: timeout waiting for response")).toBe(true);
    expect(detectAgyPrintTimeout("ERROR: Timeout Waiting For Response", "")).toBe(true);
  });

  test("does not match the live wording when it is not at the end", () => {
    expect(detectAgyPrintTimeout("Error: timeout waiting for response\nmore text", "")).toBe(false);
  });
});

describe("buildAgyArgs", () => {
  test("includes the expected flags and positional prompt", () => {
    const args: readonly string[] = buildAgyArgs({ cwd: "/tmp", model: "Gemini 3.5 Flash (Low)", printTimeout: "20s", prompt: "hello" });
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--sandbox",
      "--print-timeout",
      "20s",
      "--add-dir",
      "/tmp",
      "--model",
      "Gemini 3.5 Flash (Low)",
      "--print",
      "hello",
    ]);
  });

  test("keeps --print as the final flag before the prompt", () => {
    const args: readonly string[] = buildAgyArgs({ cwd: "/tmp", model: DEFAULT_ANTIGRAVITY_MODEL, printTimeout: "5m", prompt: "hello" });
    expect(args.at(-2)).toBe("--print");
    expect(args.at(-1)).toBe("hello");
  });

  test("puts log and explicit conversation before --print", () => {
    const conversationId = parseAgyConversationId("103febcc-41a4-435b-a6ed-f6992fb1c3ff");
    expect(conversationId).toBeDefined();
    const args: readonly string[] = buildAgyArgs({
      cwd: "/tmp",
      conversationId,
      logFile: "/tmp/agy.log",
      model: DEFAULT_ANTIGRAVITY_MODEL,
      printTimeout: "5m",
      prompt: "hello",
    });
    expect(args.slice(0, 4)).toEqual([
      "--log-file",
      "/tmp/agy.log",
      "--conversation",
      "103febcc-41a4-435b-a6ed-f6992fb1c3ff",
    ]);
    expect(args.indexOf("--conversation")).toBeLessThan(args.indexOf("--print"));
  });
});

describe("resolveAntigravityPermission", () => {
  test("accepts only modes that Antigravity can honestly map", () => {
    expect(resolveAntigravityPermission("legacy")).toBe("legacy");
    expect(resolveAntigravityPermission("permissive")).toBe("permissive");
    expect(resolveAntigravityPermission("full-access")).toBe("full-access");
    expect(() => resolveAntigravityPermission("restricted")).toThrow("Antigravity CLI has no per-invocation allow/deny");
    expect(() => resolveAntigravityPermission("interactive")).toThrow("interactive prompt mode is incompatible");
    expect(() => resolveAntigravityPermission("sandbox-read-only")).toThrow("not a read-only sandbox mode");
    expect(() => resolveAntigravityPermission("sandbox-workspace-write")).toThrow("not a workspace-write sandbox mode");
  });
});

describe("assertAntigravityWorkflowCapabilities", () => {
  test("accepts the complete workflow flag surface", () => {
    expect(() => assertAntigravityWorkflowCapabilities([
      "--add-dir",
      "--conversation",
      "--dangerously-skip-permissions",
      "--log-file",
      "--model",
      "--print",
      "--print-timeout",
      "--sandbox",
    ].join("\n"))).not.toThrow();
  });

  test("fails with exact remediation when the executable lacks required flags", () => {
    expect(() => assertAntigravityWorkflowCapabilities("--print\n--model"))
      .toThrow("Upgrade agy, or set PRISM_WORKFLOW_ANTIGRAVITY_BIN to a compatible executable.");
  });
});

describe("extractAgyConversationId", () => {
  test("extracts the id from print-mode streaming logs", () => {
    const expected = parseAgyConversationId("103febcc-41a4-435b-a6ed-f6992fb1c3ff");
    expect(extractAgyConversationId(
      "I0622 printmode.go:156] Print mode: conversation=103febcc-41a4-435b-a6ed-f6992fb1c3ff, sending message",
    )).toBe(expected);
  });

  test("falls back to created-conversation logs", () => {
    const expected = parseAgyConversationId("103febcc-41a4-435b-a6ed-f6992fb1c3ff");
    expect(extractAgyConversationId(
      "I0622 server.go:789] Created conversation 103febcc-41a4-435b-a6ed-f6992fb1c3ff",
    )).toBe(expected);
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
          "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
          "const stateFile = './state.txt';",
          "const count = Number(readFileSync(stateFile, 'utf8'));",
          "writeFileSync(stateFile, String(count + 1));",
          "const args = process.argv.slice(2);",
          "const logIndex = args.indexOf('--log-file');",
          "const conversationIndex = args.indexOf('--conversation');",
          "const conversation = conversationIndex >= 0 ? args[conversationIndex + 1] : null;",
          "const conversationId = conversation ?? '103febcc-41a4-435b-a6ed-f6992fb1c3ff';",
          "appendFileSync(args[logIndex + 1], `I printmode.go:156] Print mode: conversation=${conversationId}, sending message\\n`);",
          "appendFileSync('./attempts.ndjson', `${JSON.stringify({ logFile: args[logIndex + 1], conversation })}\\n`);",
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
        preflight: false,
        resolvedPermission: "permissive",
        processTimeoutMs: 5_000,
        printTimeout: "5s",
        maxAttempts: 2,
        backoffMs: 100,
      });

      expect(result.output).toEqual({ ok: true, attempt: 1 });
      expect(result.metadata?.adapter).toBe("antigravity-cli");
      expect(result.metadata?.model).toBe(DEFAULT_ANTIGRAVITY_MODEL);
      const attempts = (await readFile(path.join(root, "attempts.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { logFile: string; conversation: string | null });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.logFile).not.toBe(attempts[1]?.logFile);
      expect(attempts[0]?.conversation).toBeNull();
      expect(attempts[1]?.conversation).toBe("103febcc-41a4-435b-a6ed-f6992fb1c3ff");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records the agy conversation id from the log file", async () => {
    const root = await createTempRoot();
    try {
      const fakeAgy = path.join(root, "fake-agy.mjs");
      await writeFile(
        fakeAgy,
        [
          "#!/usr/bin/env node",
          "import { appendFileSync } from 'node:fs';",
          "const args = process.argv.slice(2);",
          "const logIndex = args.indexOf('--log-file');",
          "if (logIndex >= 0) appendFileSync(args[logIndex + 1], 'I printmode.go:156] Print mode: conversation=103febcc-41a4-435b-a6ed-f6992fb1c3ff, sending message\\n');",
          "console.log(JSON.stringify({ ok: true }));",
          "",
        ].join("\n"),
      );
      await chmod(fakeAgy, 0o755);

      const task = {
        kind: "workflow-task" as const,
        id: "conversation-id",
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

      const result = await runAntigravityWorkflowTask(task, {
        cwd: root,
        bin: fakeAgy,
        preflight: false,
        resolvedPermission: "permissive",
        processTimeoutMs: 5_000,
        printTimeout: "5s",
        maxAttempts: 1,
        backoffMs: 100,
      });

      expect(result.metadata?.sessionId).toBe("103febcc-41a4-435b-a6ed-f6992fb1c3ff");
      expect(result.metadata?.conversationId).toBe("103febcc-41a4-435b-a6ed-f6992fb1c3ff");
      expect(result.metadata?.continuationStrategy).toBe("explicit-conversation-id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries empty stdout with stderr warnings in the same conversation", async () => {
    const root = await createTempRoot();
    try {
      const fakeAgy = path.join(root, "fake-agy.mjs");
      const stateFile = path.join(root, "state.txt");
      await writeFile(stateFile, "0");
      await writeFile(
        fakeAgy,
        [
          "#!/usr/bin/env node",
          "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
          "const count = Number(readFileSync('./state.txt', 'utf8'));",
          "writeFileSync('./state.txt', String(count + 1));",
          "const args = process.argv.slice(2);",
          "const logIndex = args.indexOf('--log-file');",
          "const conversationIndex = args.indexOf('--conversation');",
          "const conversationId = conversationIndex >= 0 ? args[conversationIndex + 1] : '203febcc-41a4-435b-a6ed-f6992fb1c3ff';",
          "appendFileSync(args[logIndex + 1], `I printmode.go:156] Print mode: conversation=${conversationId}, sending message\\n`);",
          "if (count === 0) {",
          "  console.error('warning: transport produced no stdout');",
          "  process.exit(0);",
          "}",
          "console.log(JSON.stringify({ ok: true, attempt: count }));",
          "",
        ].join("\n"),
      );
      await chmod(fakeAgy, 0o755);

      const task = {
        kind: "workflow-task" as const,
        id: "empty-stdout-warning",
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
        preflight: false,
        resolvedPermission: "permissive",
        processTimeoutMs: 5_000,
        printTimeout: "5s",
        maxAttempts: 2,
        backoffMs: 10,
      });

      expect(result.output).toEqual({ ok: true, attempt: 1 });
      expect(result.metadata?.sessionId).toBe("203febcc-41a4-435b-a6ed-f6992fb1c3ff");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a retryable attempt has no conversation id", async () => {
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
          "const count = Number(readFileSync('./state.txt', 'utf8'));",
          "writeFileSync('./state.txt', String(count + 1));",
          "console.error('warning: transport produced no stdout');",
          "",
        ].join("\n"),
      );
      await chmod(fakeAgy, 0o755);

      const task = {
        kind: "workflow-task" as const,
        id: "missing-conversation",
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
          preflight: false,
          resolvedPermission: "permissive",
          processTimeoutMs: 5_000,
          printTimeout: "5s",
          maxAttempts: 2,
          backoffMs: 10,
        }),
      ).rejects.toThrow("no conversation UUID was captured; refusing to start a fresh conversation");
      expect(await readFile(stateFile, "utf8")).toBe("1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attaches bounded Antigravity metadata and session to malformed output", async () => {
    const root = await createTempRoot();
    try {
      const fakeAgy = path.join(root, "fake-agy.mjs");
      await writeFile(
        fakeAgy,
        [
          "#!/usr/bin/env node",
          "import { appendFileSync } from 'node:fs';",
          "const args = process.argv.slice(2);",
          "const logIndex = args.indexOf('--log-file');",
          "appendFileSync(args[logIndex + 1], 'I printmode.go:156] Print mode: conversation=303febcc-41a4-435b-a6ed-f6992fb1c3ff, sending message\\n');",
          "console.error('w'.repeat(6_000));",
          "console.log('definitely not JSON');",
          "",
        ].join("\n"),
      );
      await chmod(fakeAgy, 0o755);

      const task = {
        kind: "workflow-task" as const,
        id: "malformed-output-metadata",
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

      let caught: unknown;
      try {
        await runAntigravityWorkflowTask(task, {
          cwd: root,
          bin: fakeAgy,
          preflight: false,
          resolvedPermission: "permissive",
          processTimeoutMs: 5_000,
          printTimeout: "5s",
          maxAttempts: 1,
          backoffMs: 10,
        });
      } catch (error) {
        caught = error;
      }

      if (!(caught instanceof WorkflowOutputParseError)) {
        throw new Error(`expected malformed worker output to preserve WorkflowOutputParseError; caught: ${String(caught)}`);
      }
      const parseError = caught;
      expect(parseError.rawText).toBe("definitely not JSON");
      expect(parseError.metadata?.adapter).toBe("antigravity-cli");
      expect(parseError.metadata?.sessionId).toBe("303febcc-41a4-435b-a6ed-f6992fb1c3ff");
      expect(parseError.metadata?.conversationId).toBe("303febcc-41a4-435b-a6ed-f6992fb1c3ff");
      expect(parseError.metadata?.stderrTruncated).toBe(true);
      expect(Buffer.byteLength(String(parseError.metadata?.stderrExcerpt), "utf8")).toBeLessThanOrEqual(4_096);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("aborts retry backoff without replaying the conversation", async () => {
    const root = await createTempRoot();
    try {
      const fakeAgy = path.join(root, "fake-agy.mjs");
      const stateFile = path.join(root, "state.txt");
      await writeFile(stateFile, "0");
      await writeFile(
        fakeAgy,
        [
          "#!/usr/bin/env node",
          "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
          "const count = Number(readFileSync('./state.txt', 'utf8'));",
          "writeFileSync('./state.txt', String(count + 1));",
          "const args = process.argv.slice(2);",
          "const logIndex = args.indexOf('--log-file');",
          "appendFileSync(args[logIndex + 1], 'I printmode.go:156] Print mode: conversation=603febcc-41a4-435b-a6ed-f6992fb1c3ff, sending message\\n');",
          "console.log('Error: timed out waiting for response');",
          "",
        ].join("\n"),
      );
      await chmod(fakeAgy, 0o755);

      const task = {
        kind: "workflow-task" as const,
        id: "abort-backoff",
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
      let abortListenerRegistrations = 0;
      const abortSignal = {
        aborted: false,
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject): void => {
          abortListenerRegistrations += 1;
          if (abortListenerRegistrations !== 2) return;
          const event = new Event("abort");
          if (typeof listener === "function") {
            listener(event);
          } else {
            listener.handleEvent(event);
          }
        },
        removeEventListener: (): void => {},
      } as unknown as AbortSignal;

      await expect(
        runAntigravityWorkflowTask(task, {
          cwd: root,
          bin: fakeAgy,
          preflight: false,
          resolvedPermission: "permissive",
          processTimeoutMs: 5_000,
          printTimeout: "5s",
          abortSignal,
          maxAttempts: 3,
          backoffMs: 1_000,
        }),
      ).rejects.toThrow("agy was aborted by Prism workflow stop");
      expect(abortListenerRegistrations).toBe(2);
      expect(await readFile(stateFile, "utf8")).toBe("1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses one total deadline across retry backoff", async () => {
    const root = await createTempRoot();
    try {
      const fakeAgy = path.join(root, "fake-agy.sh");
      const stateFile = path.join(root, "state.txt");
      await writeFile(stateFile, "");
      await writeFile(
        fakeAgy,
        [
          "#!/bin/sh",
          "printf '1' >> ./state.txt",
          "printf 'I printmode.go:156] Print mode: conversation=403febcc-41a4-435b-a6ed-f6992fb1c3ff, sending message\\n' >> \"$2\"",
          "printf 'Error: timed out waiting for response\\n'",
          "",
        ].join("\n"),
      );
      await chmod(fakeAgy, 0o755);

      const task = {
        kind: "workflow-task" as const,
        id: "total-deadline",
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
          preflight: false,
          resolvedPermission: "permissive",
          processTimeoutMs: 3_000,
          printTimeout: "5s",
          maxAttempts: 3,
          backoffMs: 5_000,
        }),
      ).rejects.toThrow("agy exceeded Prism process timeout after 3000ms");
      expect(await readFile(stateFile, "utf8")).toBe("1");
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
          "import { appendFileSync } from 'node:fs';",
          "const args = process.argv.slice(2);",
          "const logIndex = args.indexOf('--log-file');",
          "appendFileSync(args[logIndex + 1], 'I printmode.go:156] Print mode: conversation=503febcc-41a4-435b-a6ed-f6992fb1c3ff, sending message\\n');",
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
          preflight: false,
          resolvedPermission: "permissive",
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
          preflight: false,
          resolvedPermission: "permissive",
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
  test("attributes incompatible executable preflight failures", async () => {
    const root = await createTempRoot();
    try {
      const fakeAgy = path.join(root, "fake-agy.mjs");
      await writeFile(fakeAgy, [
        "#!/usr/bin/env node",
        "console.log('--print\\n--model');",
      ].join("\n"));
      await chmod(fakeAgy, 0o755);
      const task = {
        kind: "workflow-task" as const,
        id: "capability-preflight",
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

      await expect(runAntigravityWorkflowTask(task, {
        cwd: root,
        bin: fakeAgy,
        resolvedPermission: "permissive",
        processTimeoutMs: 5_000,
        printTimeout: "5s",
      })).rejects.toMatchObject({
        metadata: {
          adapter: "antigravity-cli",
          stage: "capability-preflight",
          missingFlags: expect.arrayContaining(["--conversation", "--sandbox"]),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
