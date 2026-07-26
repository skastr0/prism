import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ClaudeWorkflowWorkerError, runClaudeWorkflowTask } from "./workflow-claude-worker.js";
import type { WorkflowAgentRef } from "./workflows.js";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["claude-code"],
} as const satisfies WorkflowAgentRef;

const task = {
  kind: "workflow-task" as const,
  id: "build",
  agent,
  prompt: "Do the thing.",
  output: Schema.Struct({ summary: Schema.String }),
};

describe("runClaudeWorkflowTask session persistence", () => {
  test("passes --no-session-persistence and never exposes the transient Claude session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-claude-ephemeral-"));
    try {
      const fakeClaude = join(root, "fake-claude-ephemeral.mjs");
      const callsFile = join(root, "calls.jsonl");
      await writeFile(fakeClaude, [
        "#!/usr/bin/env node",
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'transient-claude-session' }));",
        "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ summary: 'ok' }), session_id: 'transient-claude-session' }));",
        "console.error('session id: transient-claude-session');",
        "",
      ].join("\n"));
      await chmod(fakeClaude, 0o755);

      const result = await runClaudeWorkflowTask(task, {
        cwd: root,
        bin: fakeClaude,
        resolvedPermission: "legacy",
        sessionPersistence: "ephemeral",
      });

      const args = JSON.parse((await Bun.file(callsFile).text()).trim()) as string[];
      expect(args).toContain("--no-session-persistence");
      expect(args).not.toContain("--resume");
      expect(result.output).toEqual({ summary: "ok" });
      expect(result.metadata).toMatchObject({
        adapter: "claude-code",
        sessionPersistence: "ephemeral",
      });
      expect(result.metadata).not.toHaveProperty("sessionId");
      expect(result.metadata).not.toHaveProperty("stderrExcerpt");
      expect(JSON.stringify(result.metadata)).not.toContain("transient-claude-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runClaudeWorkflowTask failure metadata (OBS-006)", () => {
  test("non-zero exit attaches adapter + stderr excerpt to the thrown error", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-claude-fail-"));
    try {
      const fakeClaude = join(root, "fake-claude-fail.mjs");
      await writeFile(fakeClaude, [
        "#!/usr/bin/env node",
        "console.error('claude: provider rejected the request');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeClaude, 0o755);

      const failure = await runClaudeWorkflowTask(task, {
        cwd: root,
        bin: fakeClaude,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ClaudeWorkflowWorkerError);
      const metadata = (failure as ClaudeWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("claude-code");
      expect(metadata?.stderrExcerpt).toContain("claude: provider rejected the request");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures the session id from a partial stream-json before a non-zero exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-claude-fail-"));
    try {
      const fakeClaude = join(root, "fake-claude-partial-fail.mjs");
      await writeFile(fakeClaude, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-partial-session' }));",
        "console.error('claude: crashed mid-turn');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeClaude, 0o755);

      const failure = await runClaudeWorkflowTask(task, {
        cwd: root,
        bin: fakeClaude,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ClaudeWorkflowWorkerError);
      const metadata = (failure as ClaudeWorkflowWorkerError).metadata;
      expect(metadata?.sessionId).toBe("claude-partial-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attaches metadata when the JSON stream parses but contains no result event", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-claude-fail-"));
    try {
      const fakeClaude = join(root, "fake-claude-no-result.mjs");
      await writeFile(fakeClaude, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-no-result-session' }));",
        "process.exit(0);",
        "",
      ].join("\n"));
      await chmod(fakeClaude, 0o755);

      const failure = await runClaudeWorkflowTask(task, {
        cwd: root,
        bin: fakeClaude,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ClaudeWorkflowWorkerError);
      expect((failure as ClaudeWorkflowWorkerError).message).toBe("claude JSON stream did not contain a result event");
      const metadata = (failure as ClaudeWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("claude-code");
      expect(metadata?.sessionId).toBe("claude-no-result-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
