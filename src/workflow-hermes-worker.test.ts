import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { HermesWorkflowWorkerError, runHermesWorkflowTask } from "./workflow-hermes-worker.js";
import type { WorkflowAgentRef } from "./workflows.js";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["hermes"],
} as const satisfies WorkflowAgentRef;

const task = {
  kind: "workflow-task" as const,
  id: "build",
  agent,
  prompt: "Do the thing.",
  output: Schema.Struct({ summary: Schema.String }),
};

describe("runHermesWorkflowTask failure metadata (OBS-006)", () => {
  test("non-zero exit attaches adapter + stderr excerpt to the thrown error", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-hermes-fail-"));
    try {
      const fakeHermes = join(root, "fake-hermes-fail.mjs");
      await writeFile(fakeHermes, [
        "#!/usr/bin/env node",
        "console.error('hermes: provider rejected the request');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeHermes, 0o755);

      const failure = await runHermesWorkflowTask(task, {
        cwd: root,
        bin: fakeHermes,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(HermesWorkflowWorkerError);
      const metadata = (failure as HermesWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("hermes");
      expect(metadata?.stderrExcerpt).toContain("hermes: provider rejected the request");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures the session id printed to stderr before a non-zero exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-hermes-fail-"));
    try {
      const fakeHermes = join(root, "fake-hermes-partial-fail.mjs");
      await writeFile(fakeHermes, [
        "#!/usr/bin/env node",
        "console.error('session_id: hermes-partial-session');",
        "console.error('hermes: crashed mid-turn');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeHermes, 0o755);

      const failure = await runHermesWorkflowTask(task, {
        cwd: root,
        bin: fakeHermes,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(HermesWorkflowWorkerError);
      const metadata = (failure as HermesWorkflowWorkerError).metadata;
      expect(metadata?.sessionId).toBe("hermes-partial-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
