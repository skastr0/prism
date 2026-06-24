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
  plugin: "native-output-fixture",
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

const UnsupportedReport = Schema.Struct({
  value: Schema.Union(Schema.String, Schema.Number),
});

const task = {
  kind: "workflow-task" as const,
  id: "build",
  agent: builder,
  prompt: "Return a native report.",
  output: NativeReport,
};

const unsupportedTask = {
  ...task,
  output: UnsupportedReport,
};

describe("workflow native structured output", () => {
  test("claude-code passes a JSON schema and consumes native structured output", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-native-"));
    try {
      const fakeClaude = join(root, "fake-claude.mjs");
      const callsFile = join(root, "claude-calls.jsonl");
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
      await rm(root, { recursive: true, force: true });
    }
  });

  test("claude-code falls back to result JSON when native structured output is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-native-"));
    try {
      const fakeClaude = join(root, "fake-claude-fallback.mjs");
      const callsFile = join(root, "claude-fallback-calls.jsonl");
      await writeFile(fakeClaude, [
        "#!/usr/bin/env node",
        "import { appendFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const schemaIndex = args.indexOf('--json-schema');",
        `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, schema: schemaIndex >= 0 ? JSON.parse(args[schemaIndex + 1]) : undefined }) + '\\n');`,
        "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ summary: 'prompted', status: 'pass' }), is_error: false, session_id: 'claude-fallback-session' }));",
        "",
      ].join("\n"));
      await chmod(fakeClaude, 0o755);

      const result = await runClaudeWorkflowTask(task, {
        cwd: root,
        bin: fakeClaude,
        resolvedPermission: "legacy",
      });

      const call = JSON.parse((await Bun.file(callsFile).text()).trim()) as {
        readonly args: readonly string[];
        readonly schema?: unknown;
      };
      expect(call.args).toContain("--json-schema");
      expect(call.schema).toBeDefined();
      expect(result.output).toEqual({ summary: "prompted", status: "pass" });
      expect(result.metadata).toMatchObject({
        adapter: "claude-code",
        sessionId: "claude-fallback-session",
        claudeNativeOutputSchema: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("claude-code omits native schema flags when schema conversion is unsupported", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-native-"));
    try {
      const fakeClaude = join(root, "fake-claude-unsupported.mjs");
      const callsFile = join(root, "claude-unsupported-calls.jsonl");
      await writeFile(fakeClaude, [
        "#!/usr/bin/env node",
        "import { appendFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const schemaIndex = args.indexOf('--json-schema');",
        `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, schemaIndex }) + '\\n');`,
        "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ value: 'fallback' }), is_error: false, session_id: 'claude-unsupported-session' }));",
        "",
      ].join("\n"));
      await chmod(fakeClaude, 0o755);

      const result = await runClaudeWorkflowTask(unsupportedTask, {
        cwd: root,
        bin: fakeClaude,
        resolvedPermission: "legacy",
      });

      const call = JSON.parse((await Bun.file(callsFile).text()).trim()) as {
        readonly args: readonly string[];
        readonly schemaIndex: number;
      };
      expect(call.args).not.toContain("--json-schema");
      expect(call.schemaIndex).toBe(-1);
      expect(result.output).toEqual({ value: "fallback" });
      expect(result.metadata).toMatchObject({
        adapter: "claude-code",
        claudeNativeOutputSchema: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("codex-cli writes a JSON schema file and consumes the final native message", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-native-"));
    try {
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

  test("codex-cli omits native schema flags when schema conversion is unsupported", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-workflow-native-"));
    try {
      const fakeCodex = join(root, "fake-codex-unsupported.mjs");
      const callsFile = join(root, "codex-unsupported-calls.jsonl");
      await writeFile(fakeCodex, [
        "#!/usr/bin/env node",
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const schemaIndex = args.indexOf('--output-schema');",
        `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, schemaIndex }) + '\\n');`,
        "writeFileSync(args[outputIndex + 1], JSON.stringify({ value: 'fallback' }));",
        "console.log(JSON.stringify({ type: 'session_meta', id: 'codex-unsupported-session' }));",
        "",
      ].join("\n"));
      await chmod(fakeCodex, 0o755);

      const result = await runCodexWorkflowTask(unsupportedTask, {
        cwd: root,
        bin: fakeCodex,
        resolvedPermission: "legacy",
      });

      const call = JSON.parse((await Bun.file(callsFile).text()).trim()) as {
        readonly args: readonly string[];
        readonly schemaIndex: number;
      };
      expect(call.args).not.toContain("--output-schema");
      expect(call.schemaIndex).toBe(-1);
      expect(result.output).toEqual({ value: "fallback" });
      expect(result.metadata).toMatchObject({
        adapter: "codex-cli",
        sessionId: "codex-unsupported-session",
        codexNativeOutputSchema: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
