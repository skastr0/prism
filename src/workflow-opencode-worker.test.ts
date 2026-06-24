import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { buildOpenCodeArgs, runOpenCodeWorkflowTask } from "./workflow-opencode-worker.js";
import type { WorkflowTaskRepairContext } from "./workflow-runner.js";
import type { StableSessionId } from "./workflow-session.js";
import type { WorkflowAgentRef } from "./workflows.js";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["opencode"],
} as const satisfies WorkflowAgentRef;

const task = {
  kind: "workflow-task" as const,
  id: "build",
  agent,
  prompt: "Do the thing.",
  output: Schema.Struct({ summary: Schema.String }),
};

// A fake `opencode` that emits the real `--format json` event stream: every event carries a
// top-level sessionID and the assistant output arrives as a {type:"text"} event.
const fakeOpenCodeEventStream = (callsFile: string, sessionId: string): string => [
  "#!/usr/bin/env node",
  "import { appendFileSync } from 'node:fs';",
  `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
  `const sid = ${JSON.stringify(sessionId)};`,
  "process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: sid, part: {} }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'text', sessionID: sid, part: { type: 'text', text: JSON.stringify({ summary: 'ok' }) } }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'step_finish', sessionID: sid, part: {} }) + '\\n');",
  "",
].join("\n");

describe("opencode worker session id", () => {
  test("buildOpenCodeArgs requests the json event stream and uses exact session resume", () => {
    const fresh = buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p" });
    expect(fresh.slice(fresh.indexOf("--format"), fresh.indexOf("--format") + 2)).toEqual(["--format", "json"]);
    expect(fresh).not.toContain("-s");
    expect(fresh).not.toContain("--continue");
    expect(fresh).not.toContain("--fork");

    const resume = buildOpenCodeArgs({ cwd: "/r", agent: "a", prompt: "p", sessionId: "ses_1" });
    expect(resume.slice(resume.indexOf("-s"), resume.indexOf("-s") + 2)).toEqual(["-s", "ses_1"]);
    expect(resume).toContain("--format");
  });

  test("captures the session id from the run's own --format json events", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-opencode-"));
    try {
      const callsFile = join(root, "calls.jsonl");
      const fakeOpenCode = join(root, "fake-opencode.mjs");
      await writeFile(fakeOpenCode, fakeOpenCodeEventStream(callsFile, "ses_109952961ffeaJCDLyv5j46jjS"));
      await chmod(fakeOpenCode, 0o755);

      const result = await runOpenCodeWorkflowTask(task, {
        cwd: root,
        bin: fakeOpenCode,
        resolvedPermission: "legacy",
      });

      expect(result.output).toEqual({ summary: "ok" });
      expect(result.metadata?.sessionId).toBe("ses_109952961ffeaJCDLyv5j46jjS");

      const argv = JSON.parse((await Bun.file(callsFile).text()).trim()) as string[];
      expect(argv.slice(argv.indexOf("--format"), argv.indexOf("--format") + 2)).toEqual(["--format", "json"]);
      expect(argv).not.toContain("-s"); // first attempt creates a new session
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resumes the prior session in place on repair (-s, never --fork)", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-opencode-"));
    try {
      const callsFile = join(root, "calls.jsonl");
      const fakeOpenCode = join(root, "fake-opencode.mjs");
      // The run reports a (new) session id, but a repair must keep the resumed one.
      await writeFile(fakeOpenCode, fakeOpenCodeEventStream(callsFile, "ses_IGNORED_ON_RESUME"));
      await chmod(fakeOpenCode, 0o755);

      const repair: WorkflowTaskRepairContext = {
        attempt: 1,
        criterion: "output-schema",
        repairPrompt: "fix it",
        mode: "native-continuation",
        continuation: { adapter: "opencode-cli", sessionId: "ses_RESUME_ME" as StableSessionId },
      };
      const result = await runOpenCodeWorkflowTask(task, {
        cwd: root,
        bin: fakeOpenCode,
        resolvedPermission: "legacy",
        repair,
      });

      expect(result.metadata?.sessionId).toBe("ses_RESUME_ME");
      const argv = JSON.parse((await Bun.file(callsFile).text()).trim()) as string[];
      expect(argv.slice(argv.indexOf("-s"), argv.indexOf("-s") + 2)).toEqual(["-s", "ses_RESUME_ME"]);
      expect(argv).not.toContain("--fork");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to raw stdout when the run emits no events (no session id)", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-opencode-"));
    try {
      const fakeOpenCode = join(root, "fake-opencode-plain.mjs");
      await writeFile(fakeOpenCode, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ summary: 'plain' }));",
        "",
      ].join("\n"));
      await chmod(fakeOpenCode, 0o755);

      const result = await runOpenCodeWorkflowTask(task, {
        cwd: root,
        bin: fakeOpenCode,
        resolvedPermission: "legacy",
      });

      expect(result.output).toEqual({ summary: "plain" });
      expect(result.metadata?.sessionId).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
