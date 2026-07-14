import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { KimiWorkflowWorkerError, runKimiWorkflowTask } from "./workflow-kimi-worker.js";
import type { WorkflowAgentRef } from "./workflows.js";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["kimi-code"],
} as const satisfies WorkflowAgentRef;

const task = {
  kind: "workflow-task" as const,
  id: "build",
  agent,
  prompt: "Do the thing.",
  output: Schema.Struct({ summary: Schema.String }),
};

describe("runKimiWorkflowTask failure metadata (OBS-006)", () => {
  test("non-zero exit attaches adapter + stderr excerpt to the thrown error", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-kimi-fail-"));
    try {
      const fakeKimi = join(root, "fake-kimi-fail.mjs");
      await writeFile(fakeKimi, [
        "#!/usr/bin/env node",
        "console.error('kimi: provider rejected the request');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeKimi, 0o755);

      const failure = await runKimiWorkflowTask(task, {
        cwd: root,
        bin: fakeKimi,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(KimiWorkflowWorkerError);
      const metadata = (failure as KimiWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("kimi-code");
      expect(metadata?.stderrExcerpt).toContain("kimi: provider rejected the request");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures the session id from a partial stream-json before a non-zero exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-kimi-fail-"));
    try {
      const fakeKimi = join(root, "fake-kimi-partial-fail.mjs");
      await writeFile(fakeKimi, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ session_id: 'kimi-partial-session' }));",
        "console.error('kimi: crashed mid-turn');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeKimi, 0o755);

      const failure = await runKimiWorkflowTask(task, {
        cwd: root,
        bin: fakeKimi,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(KimiWorkflowWorkerError);
      const metadata = (failure as KimiWorkflowWorkerError).metadata;
      expect(metadata?.sessionId).toBe("kimi-partial-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attaches metadata when stream-json contains no assistant message", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-kimi-fail-"));
    try {
      const fakeKimi = join(root, "fake-kimi-no-assistant.mjs");
      await writeFile(fakeKimi, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ session_id: 'kimi-no-assistant-session', role: 'system' }));",
        "process.exit(0);",
        "",
      ].join("\n"));
      await chmod(fakeKimi, 0o755);

      const failure = await runKimiWorkflowTask(task, {
        cwd: root,
        bin: fakeKimi,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(KimiWorkflowWorkerError);
      expect((failure as KimiWorkflowWorkerError).message).toBe("kimi-code stream-json output did not contain an assistant message");
      const metadata = (failure as KimiWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("kimi-code");
      expect(metadata?.sessionId).toBe("kimi-no-assistant-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
