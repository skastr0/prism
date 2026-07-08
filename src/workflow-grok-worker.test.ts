import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { buildGrokArgs, parseGrokJsonRunOutput, runGrokWorkflowTask, stripAgentToolsFrontmatter } from "./workflow-grok-worker.js";
import { runWorkflow } from "./workflow-runner.js";
import { createWorkflowWorkerExecutor } from "./workflow-workers.js";
import { defineTask, defineWorkflow, type WorkflowAgentRef } from "./workflows.js";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["grok"],
} as const satisfies WorkflowAgentRef;

const task = {
  kind: "workflow-task" as const,
  id: "build",
  agent,
  prompt: "Do the thing.",
  output: Schema.Struct({ summary: Schema.String }),
};

const fakeGrokJsonRun = (callsFile: string, sessionId: string): string => [
  "#!/usr/bin/env node",
  "import { appendFileSync } from 'node:fs';",
  "const args = process.argv.slice(2);",
  `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');`,
  `console.log(JSON.stringify({ text: JSON.stringify({ summary: 'ok' }), sessionId: ${JSON.stringify(sessionId)}, stopReason: 'complete' }));`,
  "",
].join("\n");

describe("grok agent tools frontmatter strip (grok-4.x session validation)", () => {
  const generated = [
    "---",
    'name: "builder"',
    'description: "Build specialist"',
    'model: "grok-composer-2.5-fast"',
    "tools:",
    '  - "agent-foundations__git_commit"',
    '  - "tower__get_board"',
    "skills:",
    '  - "atomic-commits"',
    "---",
    "",
    "Body stays.",
    "",
  ].join("\n");

  test("removes the tools block and preserves every other frontmatter key and the body", () => {
    const stripped = stripAgentToolsFrontmatter(generated);
    expect(stripped).not.toContain("tools:");
    expect(stripped).not.toContain("agent-foundations__git_commit");
    expect(stripped).toContain('name: "builder"');
    expect(stripped).toContain('model: "grok-composer-2.5-fast"');
    expect(stripped).toContain("skills:");
    expect(stripped).toContain('  - "atomic-commits"');
    expect(stripped).toContain("Body stays.");
  });

  test("leaves agents without a tools block byte-identical", () => {
    const noTools = generated.replace(/^tools:\n(?:^ {2}- .*\n)+/mu, "");
    expect(stripAgentToolsFrontmatter(noTools)).toBe(noTools);
  });
});

describe("grok worker structured session id", () => {
  test("buildGrokArgs requests the json envelope and uses exact session resume", () => {
    const fresh = buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p" });
    expect(fresh.slice(fresh.indexOf("--output-format"), fresh.indexOf("--output-format") + 2)).toEqual(["--output-format", "json"]);
    expect(fresh).not.toContain("-r");
    expect(fresh).not.toContain("--continue");

    const resume = buildGrokArgs({ cwd: "/r", agent: "a", prompt: "p", sessionId: "grok-session-1" });
    expect(resume.slice(resume.indexOf("-r"), resume.indexOf("-r") + 2)).toEqual(["-r", "grok-session-1"]);
    expect(resume).toContain("--output-format");
  });

  test("extracts assistant text and session id from the Grok JSON envelope", () => {
    expect(parseGrokJsonRunOutput(JSON.stringify({
      text: JSON.stringify({ summary: "ok" }),
      sessionId: "grok-session-1",
      stopReason: "complete",
    }))).toEqual({
      text: JSON.stringify({ summary: "ok" }),
      sessionId: "grok-session-1",
    });
  });

  test("captures the session id from structured output, not log text", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-grok-"));
    try {
      const callsFile = join(root, "calls.jsonl");
      const fakeGrok = join(root, "fake-grok.mjs");
      await writeFile(fakeGrok, fakeGrokJsonRun(callsFile, "grok-session-1099"));
      await chmod(fakeGrok, 0o755);

      const result = await runGrokWorkflowTask(task, {
        cwd: root,
        bin: fakeGrok,
        resolvedPermission: "legacy",
      });

      expect(result.output).toEqual({ summary: "ok" });
      expect(result.metadata?.sessionId).toBe("grok-session-1099");

      const argv = JSON.parse((await Bun.file(callsFile).text()).trim()) as string[];
      expect(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2)).toEqual(["--output-format", "json"]);
      expect(argv).not.toContain("-r");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repairs an attempt-0 decode failure in the same Grok session", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-grok-runner-"));
    const fakeGrok = join(root, "fake-grok.mjs");
    const callsFile = join(root, "grok-calls.jsonl");
    const oldBin = process.env.PRISM_WORKFLOW_GROK_BIN;
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const resumeIndex = args.indexOf('-r');",
      "const outputFormatIndex = args.indexOf('--output-format');",
      "const resume = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;",
      "const prompt = args.at(-1);",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ resume, outputFormat: args[outputFormatIndex + 1], prompt }) + '\\n');`,
      "const repaired = resume !== undefined;",
      "const text = JSON.stringify(repaired ? { summary: 'ok after repair' } : { notSummary: 'bad' });",
      "console.log(JSON.stringify({ text, sessionId: repaired ? 'grok-session-ignored' : 'grok-session-1', stopReason: 'complete' }));",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);
    process.env.PRISM_WORKFLOW_GROK_BIN = fakeGrok;

    try {
      const repairTask = defineTask({
        id: "build",
        agent,
        prompt: "Build the slice.",
        output: Schema.Struct({ summary: Schema.String }),
        worker: { worker: "grok" },
        finish: { maxRepairs: 1 },
      });
      const workflow = defineWorkflow({ name: "runner-grok-native-repair", tasks: [repairTask] as const });
      const result = await runWorkflow(workflow, {
        executeTask: createWorkflowWorkerExecutor({ worker: "grok", cwd: root }),
      });

      const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
        resume?: string;
        outputFormat: string;
        prompt: string;
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ outputFormat: "json" });
      expect(calls[0]?.resume).toBeUndefined();
      expect(calls[0]?.prompt).toContain("Build the slice.");
      expect(calls[1]).toMatchObject({ resume: "grok-session-1", outputFormat: "json" });
      expect(calls[1]?.prompt).not.toContain("Build the slice.");
      expect(calls[1]?.prompt).toContain("[\"summary\"]");
      expect(calls[1]?.prompt).toContain("is missing");
      expect(result.tasks[0]?.output).toEqual({ summary: "ok after repair" });
      expect(result.tasks[0]?.metadata).toMatchObject({
        adapter: "grok-cli",
        sessionId: "grok-session-1",
        repairExecution: {
          mode: "native-continuation",
          continuation: { adapter: "grok-cli", sessionId: "grok-session-1" },
        },
        finish: {
          repairs: 1,
          repairMode: "native-continuation",
        },
      });
    } finally {
      if (oldBin === undefined) delete process.env.PRISM_WORKFLOW_GROK_BIN;
      else process.env.PRISM_WORKFLOW_GROK_BIN = oldBin;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repairs malformed assistant JSON in the same Grok session", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-grok-parse-repair-"));
    const fakeGrok = join(root, "fake-grok.mjs");
    const callsFile = join(root, "grok-calls.jsonl");
    const oldBin = process.env.PRISM_WORKFLOW_GROK_BIN;
    await writeFile(fakeGrok, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const resumeIndex = args.indexOf('-r');",
      "const outputFormatIndex = args.indexOf('--output-format');",
      "const resume = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;",
      "const prompt = args.at(-1);",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ resume, outputFormat: args[outputFormatIndex + 1], prompt }) + '\\n');`,
      "const repaired = resume !== undefined;",
      "const text = repaired ? JSON.stringify({ summary: 'ok after parse repair' }) : 'not json';",
      "console.log(JSON.stringify({ text, sessionId: repaired ? 'grok-session-ignored' : 'grok-session-1', stopReason: 'complete' }));",
      "",
    ].join("\n"));
    await chmod(fakeGrok, 0o755);
    process.env.PRISM_WORKFLOW_GROK_BIN = fakeGrok;

    try {
      const repairTask = defineTask({
        id: "build",
        agent,
        prompt: "Build the slice.",
        output: Schema.Struct({ summary: Schema.String }),
        worker: { worker: "grok" },
        finish: { maxRepairs: 1 },
      });
      const workflow = defineWorkflow({ name: "runner-grok-native-parse-repair", tasks: [repairTask] as const });
      const result = await runWorkflow(workflow, {
        executeTask: createWorkflowWorkerExecutor({ worker: "grok", cwd: root }),
      });

      const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((line) => JSON.parse(line) as {
        resume?: string;
        outputFormat: string;
        prompt: string;
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ outputFormat: "json" });
      expect(calls[0]?.resume).toBeUndefined();
      expect(calls[1]).toMatchObject({ resume: "grok-session-1", outputFormat: "json" });
      expect(calls[1]?.prompt).toContain("workflow worker output did not contain JSON");
      expect(result.tasks[0]?.output).toEqual({ summary: "ok after parse repair" });
      expect(result.tasks[0]?.metadata).toMatchObject({
        adapter: "grok-cli",
        sessionId: "grok-session-1",
        repairExecution: {
          mode: "native-continuation",
          continuation: { adapter: "grok-cli", sessionId: "grok-session-1" },
        },
      });
    } finally {
      if (oldBin === undefined) delete process.env.PRISM_WORKFLOW_GROK_BIN;
      else process.env.PRISM_WORKFLOW_GROK_BIN = oldBin;
      await rm(root, { recursive: true, force: true });
    }
  });
});
