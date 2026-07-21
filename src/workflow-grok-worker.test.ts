import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  buildGrokArgs,
  parseGrokJsonRunOutput,
  runGrokWorkflowTask,
  sanitizeGrokWorkflowAgentSource,
  stripAgentSkillsFrontmatter,
} from "./workflow-grok-worker.js";
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

describe("grok agent frontmatter sanitize (skills only)", () => {
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
    '  - "ad-creative"',
    "---",
    "",
    "Body stays.",
    "",
  ].join("\n");

  test("removes skills while preserving the Grok-4 tools allowlist and body", () => {
    const stripped = stripAgentSkillsFrontmatter(generated);
    expect(stripped).not.toContain("skills:");
    expect(stripped).not.toContain("atomic-commits");
    expect(stripped).not.toContain("ad-creative");
    expect(stripped).toContain("tools:");
    expect(stripped).toContain("agent-foundations__git_commit");
    expect(stripped).toContain("tower__get_board");
    expect(stripped).toContain('name: "builder"');
    expect(stripped).toContain("Body stays.");
  });

  test("sanitize leaves an agent without skills byte-identical", () => {
    const noSkills = generated.replace(/^skills:\n(?:^ {2}- .*\n)+/mu, "");
    expect(sanitizeGrokWorkflowAgentSource(noSkills)).toBe(noSkills);
  });

  test("removes inline skills, preserves CRLF, tools, and body text", () => {
    const source = [
      "---",
      "name: builder",
      "skills: [one, two]",
      "tools: []",
      "---",
      "",
      "skills:",
      "  - body-example",
    ].join("\r\n");
    const stripped = sanitizeGrokWorkflowAgentSource(source);
    expect(
      stripped.startsWith("---\r\nname: builder\r\ntools: []\r\n---\r\n"),
    ).toBe(true);
    expect(stripped).toContain("\r\nskills:\r\n  - body-example");
    expect(stripped).not.toContain("skills: [one, two]");
    expect(stripped).toContain("tools: []");
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
        model: "grok-4.5",
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
  test("strips skills, preserves tools, and removes the temporary agent after execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-grok-sanitize-"));
    const oldHome = process.env.HOME;
    try {
      const home = join(root, "home");
      const agentDir = join(home, ".grok", "plugins", "prism-generated-forge", "agents");
      const sourceAgent = join(agentDir, "builder.md");
      const callsFile = join(root, "calls.json");
      const fakeGrok = join(root, "fake-grok.mjs");
      await mkdir(agentDir, { recursive: true });
      await writeFile(sourceAgent, [
        "---",
        "name: builder",
        "model: grok-4.5",
        "tools:",
        "  - read_file",
        "skills:",
        "  - oversized-preloaded-skill",
        "---",
        "",
        "Body stays.",
      ].join("\n"));
      await writeFile(fakeGrok, [
        "#!/usr/bin/env node",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const agentPath = args[args.indexOf('--agent') + 1];",
        `writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ agentPath, source: readFileSync(agentPath, 'utf8') }));`,
        "console.log(JSON.stringify({ text: JSON.stringify({ summary: 'ok' }), sessionId: 'grok-session-sanitize' }));",
      ].join("\n"));
      await chmod(fakeGrok, 0o755);
      process.env.HOME = home;

      const result = await runGrokWorkflowTask(task, {
        cwd: root,
        bin: fakeGrok,
        model: "grok-4.5",
        resolvedPermission: "legacy",
      });
      const call = JSON.parse(await Bun.file(callsFile).text()) as { agentPath: string; source: string };
      expect(result.output).toEqual({ summary: "ok" });
      expect(call.agentPath).not.toBe(sourceAgent);
      expect(call.source).not.toContain("skills:");
      expect(call.source).toContain("tools:\n  - read_file");
      expect(call.source).toContain("model: grok-4.5");
      expect(call.source).toContain("Body stays.");
      expect(await Bun.file(call.agentPath).exists()).toBe(false);
      expect(result.metadata).toMatchObject({
        adapter: "grok-cli",
        agentSourceBytes: expect.any(Number),
        maxAgentBytes: 262_144,
      });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an oversized fixed agent context before spawning Grok", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-grok-agent-budget-"));
    const oldHome = process.env.HOME;
    try {
      const home = join(root, "home");
      const agentDir = join(home, ".grok", "plugins", "prism-generated-forge", "agents");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "builder.md"), `---\nname: builder\n---\n${"x".repeat(100)}`);
      process.env.HOME = home;

      await expect(runGrokWorkflowTask(task, {
        cwd: root,
        bin: "must-not-spawn",
        resolvedPermission: "legacy",
        maxAgentBytes: 32,
      })).rejects.toMatchObject({
        metadata: {
          adapter: "grok-cli",
          stage: "agent-preload",
          maxAgentBytes: 32,
        },
      });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      await rm(root, { recursive: true, force: true });
    }
  });


  test("attributes non-zero harness failures with bounded process evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-grok-failure-"));
    try {
      const fakeGrok = join(root, "fake-grok.mjs");
      await writeFile(fakeGrok, [
        "#!/usr/bin/env node",
        "console.error('provider account mismatch');",
        "process.exit(7);",
      ].join("\n"));
      await chmod(fakeGrok, 0o755);

      await expect(runGrokWorkflowTask(task, {
        cwd: root,
        bin: fakeGrok,
        resolvedPermission: "legacy",
      })).rejects.toMatchObject({
        metadata: {
          adapter: "grok-cli",
          stage: "process",
          exitCode: 7,
          stderrExcerpt: "provider account mismatch",
        },
      });
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
