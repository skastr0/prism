import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import {
  buildOmpArgs,
  OmpWorkflowWorkerError,
  parseOmpJsonStream,
  runOmpWorkflowTask,
} from "./workflow-omp-worker.js";
import { WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskRepairContext } from "./workflow-runner.js";
import type { StableSessionId } from "./workflow-session.js";
import { defineTask, type WorkflowAgentRef } from "./workflows.js";
import { createWorkflowWorkerExecutor } from "./workflow-workers.js";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  installs: ["omp"],
} as const satisfies WorkflowAgentRef;

const task = {
  kind: "workflow-task" as const,
  id: "build",
  agent,
  prompt: "Do the thing.",
  output: Schema.Struct({ summary: Schema.String }),
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const fakeOmpEventStream = (callsFile: string, sessionId: string): string => [
  "#!/usr/bin/env node",
  "import { appendFileSync } from 'node:fs';",
  `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
  `const sid = ${JSON.stringify(sessionId)};`,
  "process.stdout.write(JSON.stringify({ type: 'session', version: 3, id: sid }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ summary: 'ok' }) }] } }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [] }) + '\\n');",
  "",
].join("\n");

describe("OMP workflow argv", () => {
  test("uses scripting, model, profile, permission, tool, and exact-resume flags", () => {
    const args = buildOmpArgs({
      cwd: "/repo",
      systemPromptPath: "/repo/.omp/agents/builder.md",
      model: "gpt-5.6-luna",
      provider: "openai",
      profile: "isolated",
      thinking: "high",
      prompt: "return json",
      sessionId: "019f-session",
      permission: "restricted",
      restrictedTools: ["read", "grep"],
    });

    expect(args).toEqual([
      "--mode", "json",
      "--cwd", "/repo",
      "--append-system-prompt", "/repo/.omp/agents/builder.md",
      "--no-title",
      "--profile", "isolated",
      "--provider", "openai",
      "--model", "gpt-5.6-luna",
      "--thinking", "high",
      "--resume", "019f-session",
      "--approval-mode", "yolo",
      "--tools", "read,grep",
      "--",
      "return json",
    ]);
  });

  test("restricted mode with no allowlist disables every tool", () => {
    expect(buildOmpArgs({
      cwd: "/repo",
      systemPromptPath: "/agent.md",
      prompt: "p",
      permission: "restricted",
    })).toContain("--no-tools");
  });

  test("rejects interactive and host-sandbox permission modes", () => {
    for (const permission of [
      "interactive",
      "sandbox-read-only",
      "sandbox-workspace-write",
    ] as const) {
      expect(() => buildOmpArgs({
        cwd: "/repo",
        systemPromptPath: "/agent.md",
        prompt: "p",
        permission,
      })).toThrow(WorkflowPermissionError);
    }
  });
});

describe("OMP JSON event stream", () => {
  test("captures the session header and final assistant message", () => {
    const parsed = parseOmpJsonStream([
      JSON.stringify({ type: "session", id: "019f-own-session" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify({ summary: "final" }) }],
        },
      }),
    ].join("\n"));

    expect(parsed).toEqual({
      sessionId: "019f-own-session",
      text: JSON.stringify({ summary: "final" }),
    });
  });

  test("uses the last assistant message from agent_end as a bounded fallback", () => {
    const parsed = parseOmpJsonStream(JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "old" }] },
        { role: "user", content: [{ type: "text", text: "ignored" }] },
        { role: "assistant", content: [{ type: "text", text: "final" }] },
      ],
    }));
    expect(parsed.text).toBe("final");
  });
});

describe("OMP workflow execution", () => {
  test("loads the project compiled agent before global and captures its own session", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-omp-worker-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = join(root, "home");
      const projectAgent = join(root, ".omp", "agents", "builder.md");
      const globalAgent = join(process.env.HOME, ".omp", "agent", "agents", "builder.md");
      await writeText(projectAgent, "project compiled agent\n");
      await writeText(globalAgent, "global compiled agent\n");
      const callsFile = join(root, "calls.jsonl");
      const fakeOmp = join(root, "fake-omp.mjs");
      await writeFile(fakeOmp, fakeOmpEventStream(callsFile, "019f-project-session"));
      await chmod(fakeOmp, 0o755);

      const result = await runOmpWorkflowTask(task, {
        cwd: root,
        bin: fakeOmp,
        model: "gpt-5.6-luna",
        resolvedPermission: "legacy",
      });

      expect(result.output).toEqual({ summary: "ok" });
      expect(result.metadata?.sessionId).toBe("019f-project-session");
      const argv = JSON.parse((await Bun.file(callsFile).text()).trim()) as string[];
      expect(argv.slice(
        argv.indexOf("--append-system-prompt"),
        argv.indexOf("--append-system-prompt") + 2,
      )).toEqual(["--append-system-prompt", projectAgent]);
      expect(argv).not.toContain(globalAgent);
    } finally {
      process.env.HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repairs by resuming the exact OMP session with the same compiled agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-omp-worker-"));
    try {
      const projectAgent = join(root, ".omp", "agents", "builder.md");
      await writeText(projectAgent, "project compiled agent\n");
      const callsFile = join(root, "calls.jsonl");
      const fakeOmp = join(root, "fake-omp.mjs");
      await writeFile(fakeOmp, fakeOmpEventStream(callsFile, "019f-ignored"));
      await chmod(fakeOmp, 0o755);
      const repair: WorkflowTaskRepairContext = {
        attempt: 1,
        criterion: "output-schema",
        repairPrompt: "fix it",
        mode: "native-continuation",
        continuation: {
          adapter: "omp-cli",
          sessionId: "019f-resume-me" as StableSessionId,
        },
      };

      const result = await runOmpWorkflowTask(task, {
        cwd: root,
        bin: fakeOmp,
        resolvedPermission: "legacy",
        repair,
      });

      expect(result.metadata?.sessionId).toBe("019f-resume-me");
      const argv = JSON.parse((await Bun.file(callsFile).text()).trim()) as string[];
      expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual([
        "--resume",
        "019f-resume-me",
      ]);
      expect(argv).toContain(projectAgent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes task profile, model provider, variant, and restricted tools into OMP scripting", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-omp-worker-"));
    const previousBin = process.env.PRISM_WORKFLOW_OMP_BIN;
    try {
      const projectAgent = join(root, ".omp", "agents", "builder.md");
      await writeText(projectAgent, "project compiled agent\n");
      const callsFile = join(root, "calls.jsonl");
      const fakeOmp = join(root, "fake-omp.mjs");
      await writeFile(fakeOmp, fakeOmpEventStream(callsFile, "019f-profiled-session"));
      await chmod(fakeOmp, 0o755);
      process.env.PRISM_WORKFLOW_OMP_BIN = fakeOmp;

      const profiledTask = defineTask({
        ...task,
        id: "profiled",
        worker: {
          worker: "omp",
          profile: "isolated",
          permission: "restricted",
          restrictedTools: ["read", "grep"],
          model: {
            kind: "model-profile-ref",
            plugin: "agent-core",
            modelspace: "default-models",
            profile: "builder",
            targets: {
              omp: {
                provider: "openai",
                model: "gpt-5.6-luna",
                variant: "minimal",
              },
            },
          },
        },
      });
      const execute = createWorkflowWorkerExecutor({ cwd: root });
      const result = await execute(profiledTask);

      expect(result).toEqual(expect.objectContaining({ output: { summary: "ok" } }));
      const argv = JSON.parse((await Bun.file(callsFile).text()).trim()) as string[];
      expect(argv.slice(argv.indexOf("--profile"), argv.indexOf("--profile") + 2)).toEqual([
        "--profile",
        "isolated",
      ]);
      expect(argv.slice(argv.indexOf("--provider"), argv.indexOf("--provider") + 2)).toEqual([
        "--provider",
        "openai",
      ]);
      expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual([
        "--model",
        "gpt-5.6-luna",
      ]);
      expect(argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 2)).toEqual([
        "--thinking",
        "minimal",
      ]);
      expect(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2)).toEqual([
        "--tools",
        "read,grep",
      ]);
      expect(argv).toContain("--approval-mode");
    } finally {
      if (previousBin === undefined) delete process.env.PRISM_WORKFLOW_OMP_BIN;
      else process.env.PRISM_WORKFLOW_OMP_BIN = previousBin;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed before spawn when the compiled OMP agent is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-omp-worker-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = join(root, "empty-home");
      await expect(runOmpWorkflowTask(task, {
        cwd: root,
        bin: join(root, "must-not-spawn"),
        resolvedPermission: "legacy",
      })).rejects.toThrow(OmpWorkflowWorkerError);
      await expect(runOmpWorkflowTask(task, {
        cwd: root,
        bin: join(root, "must-not-spawn"),
        resolvedPermission: "legacy",
      })).rejects.toThrow("Run prism refresh <plugin> --harness omp");
    } finally {
      process.env.HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runOmpWorkflowTask failure metadata (OBS-006)", () => {
  test("non-zero exit attaches adapter + stderr excerpt to the thrown error", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-omp-fail-"));
    try {
      const projectAgent = join(root, ".omp", "agents", "builder.md");
      await writeText(projectAgent, "project compiled agent\n");
      const fakeOmp = join(root, "fake-omp-fail.mjs");
      await writeFile(fakeOmp, [
        "#!/usr/bin/env node",
        "console.error('omp: provider rejected the request');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeOmp, 0o755);

      const failure = await runOmpWorkflowTask(task, {
        cwd: root,
        bin: fakeOmp,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(OmpWorkflowWorkerError);
      const metadata = (failure as OmpWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("omp-cli");
      expect(metadata?.stderrExcerpt).toContain("omp: provider rejected the request");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures the session id from a partial event stream before a non-zero exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-omp-fail-"));
    try {
      const projectAgent = join(root, ".omp", "agents", "builder.md");
      await writeText(projectAgent, "project compiled agent\n");
      const fakeOmp = join(root, "fake-omp-partial-fail.mjs");
      await writeFile(fakeOmp, [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'session', id: 'omp-partial-session' }) + '\\n');",
        "console.error('omp: crashed mid-turn');",
        "process.exit(1);",
        "",
      ].join("\n"));
      await chmod(fakeOmp, 0o755);

      const failure = await runOmpWorkflowTask(task, {
        cwd: root,
        bin: fakeOmp,
        resolvedPermission: "legacy",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(OmpWorkflowWorkerError);
      const metadata = (failure as OmpWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("omp-cli");
      expect(metadata?.sessionId).toBe("omp-partial-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
