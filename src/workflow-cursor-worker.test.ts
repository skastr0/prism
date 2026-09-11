import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { CursorWorkflowWorkerError, runCursorWorkflowTask } from "./workflow-cursor-worker.js";
import type { StableSessionId } from "./workflow-session.js";

const task = {
  kind: "workflow-task" as const,
  id: "build",
  prompt: "Do the thing.",
  output: Schema.Struct({ summary: Schema.String }),
};

describe("runCursorWorkflowTask success", () => {
  test("parses the stream-json result and captures session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-cursor-ok-"));
    try {
      const fakeAgent = join(root, "fake-agent-ok.mjs");
      const callsFile = join(root, "calls.jsonl");
      await writeFile(fakeAgent, [
        "#!/usr/bin/env node",
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-session-1' }));",
        "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ summary: 'ok' }), session_id: 'cursor-session-1', duration_ms: 12 }));",
        "",
      ].join("\n"));
      await chmod(fakeAgent, 0o755);

      const result = await runCursorWorkflowTask(task, {
        cwd: root,
        bin: fakeAgent,
        model: "composer-2.5-fast",
        resolvedPermission: "permissive",
      });

      const args = JSON.parse((await Bun.file(callsFile).text()).trim()) as string[];
      expect(args).toContain("--print");
      expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual([
        "--output-format",
        "stream-json",
      ]);
      expect(args).toContain("--trust");
      expect(args).toContain("--force");
      expect(args.slice(args.indexOf("--workspace"), args.indexOf("--workspace") + 2)).toEqual(["--workspace", root]);
      expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "composer-2.5-fast"]);
      expect(args).not.toContain("--continue");
      expect(args).not.toContain("--agent");
      expect(args).not.toContain("--auto-review");
      expect(result.output).toEqual({ summary: "ok" });
      expect(result.metadata).toMatchObject({
        adapter: "cursor",
        sessionId: "cursor-session-1",
        model: "composer-2.5-fast",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resumes the exact captured session on native continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-cursor-resume-"));
    try {
      const fakeAgent = join(root, "fake-agent-resume.mjs");
      const callsFile = join(root, "calls.jsonl");
      await writeFile(fakeAgent, [
        "#!/usr/bin/env node",
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ summary: 'fixed' }), session_id: 'cursor-resume-1' }));",
        "",
      ].join("\n"));
      await chmod(fakeAgent, 0o755);

      const result = await runCursorWorkflowTask(task, {
        cwd: root,
        bin: fakeAgent,
        resolvedPermission: "legacy",
        repair: {
          attempt: 2,
          criterion: "decode",
          mode: "native-continuation",
          repairPrompt: "The previous output was invalid JSON.",
          continuation: { adapter: "cursor", sessionId: "cursor-resume-1" as StableSessionId },
        },
      });

      const args = JSON.parse((await Bun.file(callsFile).text()).trim()) as string[];
      expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "cursor-resume-1"]);
      expect(args).not.toContain("--force");
      expect(result.output).toEqual({ summary: "fixed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runCursorWorkflowTask failure metadata (OBS-006)", () => {
  test("non-zero exit attaches adapter + stderr excerpt to the thrown error", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-cursor-fail-"));
    try {
      const fakeAgent = join(root, "fake-agent-fail.mjs");
      await writeFile(fakeAgent, [
        "#!/usr/bin/env node",
        "console.error('agent: provider rejected the request');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeAgent, 0o755);

      const failure = await runCursorWorkflowTask(task, {
        cwd: root,
        bin: fakeAgent,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(CursorWorkflowWorkerError);
      const metadata = (failure as CursorWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("cursor");
      expect(metadata?.stderrExcerpt).toContain("agent: provider rejected the request");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures the session id from a partial stream-json before a non-zero exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-cursor-fail-"));
    try {
      const fakeAgent = join(root, "fake-agent-partial-fail.mjs");
      await writeFile(fakeAgent, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-partial-session' }));",
        "console.error('agent: crashed mid-turn');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeAgent, 0o755);

      const failure = await runCursorWorkflowTask(task, {
        cwd: root,
        bin: fakeAgent,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(CursorWorkflowWorkerError);
      const metadata = (failure as CursorWorkflowWorkerError).metadata;
      expect(metadata?.sessionId).toBe("cursor-partial-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attaches metadata when the JSON stream contains no result event", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-cursor-fail-"));
    try {
      const fakeAgent = join(root, "fake-agent-no-result.mjs");
      await writeFile(fakeAgent, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-no-result-session' }));",
        "process.exit(0);",
        "",
      ].join("\n"));
      await chmod(fakeAgent, 0o755);

      const failure = await runCursorWorkflowTask(task, {
        cwd: root,
        bin: fakeAgent,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(CursorWorkflowWorkerError);
      expect((failure as CursorWorkflowWorkerError).message).toBe(
        "cursor agent JSON stream did not contain a result event",
      );
      const metadata = (failure as CursorWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("cursor");
      expect(metadata?.sessionId).toBe("cursor-no-result-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
