import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { KimiWorkflowWorkerError, runKimiWorkflowTask } from "./workflow-kimi-worker.js";

const task = {
  kind: "workflow-task" as const,
  id: "build",
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

  test("sets effort only in the spawned Kimi process environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-kimi-effort-env-"));
    const receipt = join(root, "child-env.json");
    const previousEffort = process.env.KIMI_MODEL_THINKING_EFFORT;
    const previousReceipt = process.env.PRISM_KIMI_TEST_RECEIPT;
    process.env.KIMI_MODEL_THINKING_EFFORT = "parent-value";
    process.env.PRISM_KIMI_TEST_RECEIPT = receipt;
    try {
      const fakeKimi = join(root, "fake-kimi-env.mjs");
      await writeFile(fakeKimi, [
        "#!/usr/bin/env node",
        "const fs = await import('node:fs/promises');",
        "await fs.writeFile(process.env.PRISM_KIMI_TEST_RECEIPT, JSON.stringify({ effort: process.env.KIMI_MODEL_THINKING_EFFORT, home: process.env.KIMI_CODE_HOME, argv: process.argv.slice(2) }));",
        "console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({ summary: 'ok' }) }));",
        "",
      ].join("\n"));
      await chmod(fakeKimi, 0o755);

      await runKimiWorkflowTask(task, {
        cwd: root,
        bin: fakeKimi,
        model: "kimi-code/test-model",
        effort: "high",
        kimiHome: root,
        resolvedPermission: "legacy",
      });

      const child = JSON.parse(await Bun.file(receipt).text()) as {
        readonly effort: string;
        readonly home: string;
        readonly argv: readonly string[];
      };
      expect(child).toMatchObject({ effort: "high", home: root });
      expect(child.argv).not.toContain("--effort");
      expect(child.argv).not.toContain("--reasoning-effort");
      expect(process.env.KIMI_MODEL_THINKING_EFFORT).toBe("parent-value");
    } finally {
      if (previousEffort === undefined) delete process.env.KIMI_MODEL_THINKING_EFFORT;
      else process.env.KIMI_MODEL_THINKING_EFFORT = previousEffort;
      if (previousReceipt === undefined) delete process.env.PRISM_KIMI_TEST_RECEIPT;
      else process.env.PRISM_KIMI_TEST_RECEIPT = previousReceipt;
      await rm(root, { recursive: true, force: true });
    }
  });
});
