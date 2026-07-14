import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { AmpWorkflowWorkerError, runAmpWorkflowTask } from "./workflow-amp-worker.js";
import type { WorkflowAgentRef } from "./workflows.js";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["amp-code"],
} as const satisfies WorkflowAgentRef;

const task = {
  kind: "workflow-task" as const,
  id: "build",
  agent,
  prompt: "Do the thing.",
  output: Schema.Struct({ summary: Schema.String }),
};

describe("runAmpWorkflowTask failure metadata (OBS-006)", () => {
  test("non-zero exit attaches adapter + stderr excerpt to the thrown error", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-amp-fail-"));
    try {
      const fakeAmp = join(root, "fake-amp-fail.mjs");
      await writeFile(fakeAmp, [
        "#!/usr/bin/env node",
        "console.error('amp: provider rejected the request');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeAmp, 0o755);

      const failure = await runAmpWorkflowTask(task, {
        cwd: root,
        bin: fakeAmp,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AmpWorkflowWorkerError);
      const metadata = (failure as AmpWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("amp-code");
      expect(metadata?.stderrExcerpt).toContain("amp: provider rejected the request");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures the session id from a partial stream before a non-zero exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-amp-fail-"));
    try {
      const fakeAmp = join(root, "fake-amp-partial-fail.mjs");
      await writeFile(fakeAmp, [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'system', session_id: 'amp-partial-session' }) + '\\n');",
        "console.error('amp: crashed mid-turn');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeAmp, 0o755);

      const failure = await runAmpWorkflowTask(task, {
        cwd: root,
        bin: fakeAmp,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AmpWorkflowWorkerError);
      const metadata = (failure as AmpWorkflowWorkerError).metadata;
      expect(metadata?.sessionId).toBe("amp-partial-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
