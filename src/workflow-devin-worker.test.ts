import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  buildDevinArgs,
  DevinWorkflowWorkerError,
  isDevinAuthOutput,
  mapDevinPermissionMode,
  runDevinWorkflowTask,
} from "./workflow-devin-worker.js";
import { DEFAULT_WORKFLOW_WORKER_STDERR_EXCERPT_BYTES } from "./workflow-worker-metadata.js";
import { WorkflowPermissionError } from "./workflow-permissions.js";
import type { StableSessionId } from "./workflow-session.js";

const failureTask = {
  kind: "workflow-task" as const,
  id: "devin-nonzero-exit",
  agent: {
    kind: "agent-ref" as const,
    plugin: "test",
    name: "agent",
    description: "test agent",
    sourceHash: "a".repeat(64),
    manifestHash: "a".repeat(64),
    installs: ["devin"],
  },
  prompt: "Return JSON",
  output: Schema.Struct({ ok: Schema.Boolean }),
};

const captureDevinFailure = async (
  bin: string,
  cwd: string,
): Promise<DevinWorkflowWorkerError> => {
  try {
    await runDevinWorkflowTask(failureTask, {
      cwd,
      bin,
      resolvedPermission: "permissive",
      processTimeoutMs: 5_000,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(DevinWorkflowWorkerError);
    return error as DevinWorkflowWorkerError;
  }
  throw new Error("expected Devin worker failure");
};

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

  test("renders a bounded stderr excerpt for nonzero exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-devin-worker-test-"));
    try {
      const fakeDevin = join(root, "fake-devin.mjs");
      await writeFile(
        fakeDevin,
        [
          "#!/usr/bin/env node",
          "import { writeSync } from 'node:fs';",
          "writeSync(1, 'stdout-fallback-should-not-win\\n');",
          "writeSync(2, `unbounded-stderr-prefix:${'x'.repeat(5_000)}:actual-stderr-tail\\n`);",
          "process.exitCode = 7;",
          "",
        ].join("\n"),
      );
      await chmod(fakeDevin, 0o755);

      const error = await captureDevinFailure(fakeDevin, root);
      const message = error.message;
      expect(message).toContain("actual-stderr-tail");
      expect(message).not.toContain("[object Object]");
      expect(message).not.toContain("unbounded-stderr-prefix");
      expect(message).not.toContain("stdout-fallback-should-not-win");
      expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(
        Buffer.byteLength("devin exited with 7: ", "utf8") +
          DEFAULT_WORKFLOW_WORKER_STDERR_EXCERPT_BYTES,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses a bounded stdout excerpt when stderr is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-devin-worker-test-"));
    try {
      const fakeDevin = join(root, "fake-devin.mjs");
      await writeFile(
        fakeDevin,
        [
          "#!/usr/bin/env node",
          "import { writeSync } from 'node:fs';",
          "writeSync(1, `unbounded-stdout-prefix:${'y'.repeat(5_000)}:actual-stdout-tail\\n`);",
          "process.exitCode = 9;",
          "",
        ].join("\n"),
      );
      await chmod(fakeDevin, 0o755);

      const error = await captureDevinFailure(fakeDevin, root);
      const message = error.message;
      expect(message).toContain("actual-stdout-tail");
      expect(message).not.toContain("unbounded-stdout-prefix");
      expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(
        Buffer.byteLength("devin exited with 9: ", "utf8") +
          DEFAULT_WORKFLOW_WORKER_STDERR_EXCERPT_BYTES,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("non-zero exit attaches adapter + stderr excerpt to the thrown error (OBS-006)", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-devin-worker-test-"));
    try {
      const fakeDevin = join(root, "fake-devin.mjs");
      await writeFile(
        fakeDevin,
        [
          "#!/usr/bin/env node",
          "console.error('devin: session quota exceeded');",
          "process.exit(1);",
          "",
        ].join("\n"),
      );
      await chmod(fakeDevin, 0o755);

      const error = await captureDevinFailure(fakeDevin, root);
      expect(error.metadata?.adapter).toBe("devin");
      expect(error.metadata?.stderrExcerpt).toContain("devin: session quota exceeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures the session id from a partial ATIF export before a non-zero exit (OBS-006)", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-devin-worker-test-"));
    try {
      const fakeDevin = join(root, "fake-devin.mjs");
      await writeFile(
        fakeDevin,
        [
          "#!/usr/bin/env node",
          "import { writeFileSync } from 'node:fs';",
          "const args = process.argv.slice(2);",
          "const exportIndex = args.indexOf('--export');",
          "writeFileSync(args[exportIndex + 1], JSON.stringify({ session_id: 'devin-partial-session', steps: [] }));",
          "console.error('devin: crashed mid-turn');",
          "process.exit(1);",
          "",
        ].join("\n"),
      );
      await chmod(fakeDevin, 0o755);

      const error = await captureDevinFailure(fakeDevin, root);
      expect(error.metadata?.adapter).toBe("devin");
      expect(error.metadata?.sessionId).toBe("devin-partial-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to the known continuation session id when no ATIF export was written (OBS-006)", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-devin-worker-test-"));
    try {
      const fakeDevin = join(root, "fake-devin.mjs");
      await writeFile(
        fakeDevin,
        [
          "#!/usr/bin/env node",
          "console.error('devin: internal error');",
          "process.exit(1);",
          "",
        ].join("\n"),
      );
      await chmod(fakeDevin, 0o755);

      const failure = await runDevinWorkflowTask(failureTask, {
        cwd: root,
        bin: fakeDevin,
        resolvedPermission: "permissive",
        processTimeoutMs: 5_000,
        repair: {
          mode: "native-continuation",
          continuation: { adapter: "devin", sessionId: "prior-session-id" as StableSessionId },
          attempt: 1,
          criterion: "output-json-parse",
          repairPrompt: "Return valid JSON.",
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(DevinWorkflowWorkerError);
      const metadata = (failure as DevinWorkflowWorkerError).metadata;
      expect(metadata?.sessionId).toBe("prior-session-id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
