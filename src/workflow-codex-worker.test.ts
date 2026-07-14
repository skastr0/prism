import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { CodexWorkflowWorkerError, runCodexWorkflowTask } from "./workflow-codex-worker.js";
import type { WorkflowAgentRef } from "./workflows.js";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["codex-cli"],
} as const satisfies WorkflowAgentRef;

const task = {
  kind: "workflow-task" as const,
  id: "build",
  agent,
  prompt: "Do the thing.",
  output: Schema.Struct({ summary: Schema.String }),
};

describe("runCodexWorkflowTask failure metadata (OBS-006)", () => {
  test("non-zero exit attaches adapter + stderr excerpt to the thrown error", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-codex-fail-"));
    try {
      const fakeCodex = join(root, "fake-codex-fail.mjs");
      await writeFile(fakeCodex, [
        "#!/usr/bin/env node",
        "console.error('codex: provider rejected the request');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeCodex, 0o755);

      const failure = await runCodexWorkflowTask(task, {
        cwd: root,
        bin: fakeCodex,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(CodexWorkflowWorkerError);
      const metadata = (failure as CodexWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("codex-cli");
      expect(metadata?.stderrExcerpt).toContain("codex: provider rejected the request");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures the session id from a partial session_meta event before a non-zero exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-codex-fail-"));
    try {
      const fakeCodex = join(root, "fake-codex-partial-fail.mjs");
      await writeFile(fakeCodex, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'session_meta', id: 'codex-partial-session' }));",
        "console.error('codex: crashed mid-turn');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeCodex, 0o755);

      const failure = await runCodexWorkflowTask(task, {
        cwd: root,
        bin: fakeCodex,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(CodexWorkflowWorkerError);
      const metadata = (failure as CodexWorkflowWorkerError).metadata;
      expect(metadata?.sessionId).toBe("codex-partial-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attaches metadata when --output-last-message is not written", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-codex-fail-"));
    try {
      const fakeCodex = join(root, "fake-codex-no-output.mjs");
      await writeFile(fakeCodex, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'session_meta', id: 'codex-no-output-session' }));",
        "process.exit(0);",
        "",
      ].join("\n"));
      await chmod(fakeCodex, 0o755);

      const failure = await runCodexWorkflowTask(task, {
        cwd: root,
        bin: fakeCodex,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(CodexWorkflowWorkerError);
      expect((failure as CodexWorkflowWorkerError).message).toContain("codex did not write --output-last-message");
      const metadata = (failure as CodexWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("codex-cli");
      expect(metadata?.sessionId).toBe("codex-no-output-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
