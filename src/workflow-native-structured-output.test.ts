import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { runClaudeWorkflowTask } from "./workflow-claude-worker.js";
import { runCodexWorkflowTask } from "./workflow-codex-worker.js";
import type { WorkflowAgentRef } from "./workflows.js";

const builder = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["claude-code", "codex-cli"],
} as const satisfies WorkflowAgentRef;

const NativeReport = Schema.Struct({
  summary: Schema.String,
  status: Schema.Literal("pass", "needs-work"),
});

const task = {
  kind: "workflow-task" as const,
  id: "build",
  agent: builder,
  prompt: "Return a native report.",
  output: NativeReport,
};

describe("workflow native structured output", () => {
  test("claude-code passes a JSON schema and consumes native structured output", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-native-"));
    const fakeClaude = join(root, "fake-claude.mjs");
    const callsFile = join(root, "claude-calls.jsonl");
    const oldRoot = process.env.PRISM_WORKFLOW_CLAUDE_ROOT;
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const schemaIndex = args.indexOf('--json-schema');",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, schema: schemaIndex >= 0 ? JSON.parse(args[schemaIndex + 1]) : undefined }) + '\\n');`,
      "console.log(JSON.stringify({ type: 'result', structured_output: { summary: 'typed', status: 'pass' }, is_error: false, session_id: 'claude-native-session', duration_ms: 12, num_turns: 1 }));",
      "",
    ].join("\n"));
    await chmod(fakeClaude, 0o755);
    process.env.PRISM_WORKFLOW_CLAUDE_ROOT = root;

    try {
      const result = await runClaudeWorkflowTask(task, {
        cwd: root,
        bin: fakeClaude,
        resolvedPermission: "legacy",
      });

      const call = JSON.parse((await Bun.file(callsFile).text()).trim()) as {
        readonly args: readonly string[];
        readonly schema: { readonly properties?: Record<string, unknown> };
      };
      expect(call.args).toContain("--json-schema");
      expect(call.schema.properties).toMatchObject({
        summary: { type: "string" },
        status: { enum: ["pass", "needs-work"] },
      });
      expect(result.output).toEqual({ summary: "typed", status: "pass" });
      expect(result.metadata).toMatchObject({
        adapter: "claude-code",
        sessionId: "claude-native-session",
        claudeNativeOutputSchema: true,
      });
    } finally {
      if (oldRoot === undefined) delete process.env.PRISM_WORKFLOW_CLAUDE_ROOT;
      else process.env.PRISM_WORKFLOW_CLAUDE_ROOT = oldRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("codex-cli writes a JSON schema file and consumes the final native message", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-native-"));
    const fakeCodex = join(root, "fake-codex.mjs");
    const callsFile = join(root, "codex-calls.jsonl");
    await writeFile(fakeCodex, [
      "#!/usr/bin/env node",
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const schemaIndex = args.indexOf('--output-schema');",
      "const outputIndex = args.indexOf('--output-last-message');",
      "const schema = schemaIndex >= 0 ? JSON.parse(readFileSync(args[schemaIndex + 1], 'utf8')) : undefined;",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, schema }) + '\\n');`,
      "writeFileSync(args[outputIndex + 1], JSON.stringify({ summary: 'typed', status: 'pass' }));",
      "console.log(JSON.stringify({ type: 'session_meta', id: 'codex-native-session' }));",
      "",
    ].join("\n"));
    await chmod(fakeCodex, 0o755);

    try {
      const result = await runCodexWorkflowTask(task, {
        cwd: root,
        bin: fakeCodex,
        resolvedPermission: "legacy",
      });

      const call = JSON.parse((await Bun.file(callsFile).text()).trim()) as {
        readonly args: readonly string[];
        readonly schema: { readonly properties?: Record<string, unknown> };
      };
      expect(call.args).toContain("--output-schema");
      expect(call.args).toContain("--output-last-message");
      expect(call.schema.properties).toMatchObject({
        summary: { type: "string" },
        status: { enum: ["pass", "needs-work"] },
      });
      expect(result.output).toEqual({ summary: "typed", status: "pass" });
      expect(result.metadata).toMatchObject({
        adapter: "codex-cli",
        sessionId: "codex-native-session",
        codexNativeOutputSchema: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
