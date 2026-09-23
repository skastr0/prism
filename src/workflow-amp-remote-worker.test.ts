import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  buildAmpOrbArgs,
  buildAmpRemoteContinueArgs,
  buildAmpRunnerArgs,
  resolveAmpRemotePinPlan,
  runAmpOrbWorkflowTask,
  runAmpRunnerWorkflowTask,
  assertAmpRemotePermission,
  ampRemoteTargetOf,
} from "./workflow-amp-remote-worker.js";
import { AMP_WORKFLOW_CATALOG_PIN_MODE, AmpWorkflowWorkerError } from "./workflow-amp-worker.js";
import { assertWorkflowWorkerPermission } from "./workflow-workers.js";
import { WorkflowPermissionError } from "./workflow-permissions.js";
import { workflowTaskIdentity } from "./workflow-identity.js";
import { HARNESS_CATALOGS } from "./configure/catalogs/index.js";
import { AMP_ORB_SIZES, AMP_THREAD_VISIBILITIES, type AnyWorkflowWorkerTask } from "./workflows.js";

const orbTask = {
  kind: "workflow-task" as const,
  id: "probe",
  prompt: "Reply with the JSON object.",
  output: Schema.Struct({ summary: Schema.String }),
  worker: {
    worker: "amp-orb" as const,
    project: "skastr052/orb-setup",
    size: "a1.tiny" as const,
  },
} satisfies AnyWorkflowWorkerTask;

const runnerTask = {
  kind: "workflow-task" as const,
  id: "probe",
  prompt: "Reply with the JSON object.",
  output: Schema.Struct({ summary: Schema.String }),
  worker: {
    worker: "amp-runner" as const,
    runnerId: "macbook",
  },
} satisfies AnyWorkflowWorkerTask;

/** Fake amp CLI: records argv, emits a fixed JSONL transcript. */
const fakeAmpScript = (transcript: string): string => [
  "#!/usr/bin/env node",
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));",
  `process.stdout.write(${JSON.stringify(transcript)});`,
  "",
].join("\n");

const ORB_SUCCESS_STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "T-orb-probe-0001" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: '{"summary":"ok"}' }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"summary":"ok"}', session_id: "T-orb-probe-0001" }),
].join("\n") + "\n";

const RUNNER_ERROR_STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "T-runner-probe-0002" }),
  JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "agent turn failed", error: "agent turn failed", session_id: "T-runner-probe-0002" }),
].join("\n") + "\n";

describe("buildAmpOrbArgs", () => {
  test("exact argv: project, size, visibility, title, labels, stream flags", () => {
    expect(buildAmpOrbArgs({
      target: { worker: "amp-orb", project: "skastr052/orb-setup", size: "a1.tiny", visibility: "workspace", labels: ["prism", "l6"] },
      prompt: "PROMPT",
      title: "prism probe",
      mode: "low",
    })).toEqual([
      "--orb-execute",
      "--execute",
      "PROMPT",
      "--stream-json",
      "--no-ide",
      "--no-notifications",
      "--no-color",
      "--no-archive-after-execute",
      "--project",
      "skastr052/orb-setup",
      "--orb-size",
      "a1.tiny",
      "--visibility",
      "workspace",
      "--title",
      "prism probe",
      "--label",
      "prism",
      "--label",
      "l6",
      "--mode",
      "low",
    ]);
  });

  test("omits optional flags when unset", () => {
    const args = buildAmpOrbArgs({ target: { worker: "amp-orb", project: "o/r" }, prompt: "P" });
    expect(args).not.toContain("--orb-size");
    expect(args).not.toContain("--visibility");
    expect(args).not.toContain("--title");
    expect(args).not.toContain("--label");
    expect(args).not.toContain("--mode");
    expect(args).not.toContain("--settings-file");
  });
});

describe("buildAmpRunnerArgs", () => {
  test("exact argv: executor runner:<id>, optional runner-dir", () => {
    expect(buildAmpRunnerArgs({
      target: { worker: "amp-runner", runnerId: "macbook", runnerDir: "/tmp/repo" },
      prompt: "PROMPT",
      title: "prism probe",
      pluginReadyTimeout: true,
    })).toEqual([
      "--execute",
      "PROMPT",
      "--stream-json",
      "--no-ide",
      "--no-notifications",
      "--no-color",
      "--no-archive-after-execute",
      "--executor",
      "runner:macbook",
      "--runner-dir",
      "/tmp/repo",
      "--title",
      "prism probe",
      "--plugin-ready-timeout",
    ]);
  });

  test("no --orb-execute and no --executor on continuation argv", () => {
    expect(buildAmpRemoteContinueArgs({ sessionId: "T-abc", prompt: "fix it" })).toEqual([
      "threads",
      "continue",
      "T-abc",
      "--orb-execute",
      "--execute",
      "fix it",
      "--stream-json",
      "--no-color",
    ]);
  });
});

describe("remote permission fail-closed", () => {
  test("legacy passes; every dial/permission mode throws with remediation", () => {
    expect(() => assertAmpRemotePermission("amp-orb", "legacy")).not.toThrow();
    for (const mode of ["permissive", "full-access", "restricted", "interactive", "sandbox-read-only", "sandbox-workspace-write"] as const) {
      expect(() => assertAmpRemotePermission("amp-orb", mode)).toThrow(WorkflowPermissionError);
      expect(() => assertAmpRemotePermission("amp-runner", mode)).toThrow(/Prism cannot override them per invocation/);
    }
  });

  test("validate-time assert rejects non-legacy before dispatch", () => {
    expect(() => assertWorkflowWorkerPermission("amp-orb", "permissive")).toThrow(WorkflowPermissionError);
    expect(() => assertWorkflowWorkerPermission("amp-runner", "full-access")).toThrow(WorkflowPermissionError);
    expect(() => assertWorkflowWorkerPermission("amp-orb", "legacy")).not.toThrow();
    expect(() => assertWorkflowWorkerPermission("amp-runner", "legacy")).not.toThrow();
  });
});

describe("remote target validation", () => {
  test("missing project / runnerId fails with remediation naming the field", () => {
    // Untyped workflow files and a CLI-only --worker fallback can carry no
    // target; the validator must catch them (the DSL makes these required).
    const bareOrb = { ...orbTask, worker: { worker: "amp-orb" as const } } as unknown as AnyWorkflowWorkerTask;
    expect(() => ampRemoteTargetOf("amp-orb", bareOrb)).toThrow(/worker\.project is required/);
    const bareRunner = { ...runnerTask, worker: { worker: "amp-runner" as const } } as unknown as AnyWorkflowWorkerTask;
    expect(() => ampRemoteTargetOf("amp-runner", bareRunner)).toThrow(/worker\.runnerId is required/);
  });

  test("non-absolute runnerDir fails closed", () => {
    const relative = { ...runnerTask, worker: { worker: "amp-runner" as const, runnerId: "macbook", runnerDir: "relative/dir" } };
    expect(() => ampRemoteTargetOf("amp-runner", relative)).toThrow(/must be an absolute directory/);
  });

  test("blank labels and unknown size/visibility fail closed", () => {
    expect(() => ampRemoteTargetOf("amp-orb", {
      ...orbTask,
      worker: { worker: "amp-orb", project: "o/r", labels: [" "] },
    })).toThrow(/labels/);
    expect(() => ampRemoteTargetOf("amp-orb", {
      ...orbTask,
      worker: { worker: "amp-orb", project: "o/r", size: "a2.huge" as never },
    })).toThrow(/worker\.size/);
    expect(() => ampRemoteTargetOf("amp-orb", {
      ...orbTask,
      worker: { worker: "amp-orb", project: "o/r", visibility: "public" as never },
    })).toThrow(/worker\.visibility/);
  });

  test("size and visibility enums match the Amp docs", () => {
    expect([...AMP_ORB_SIZES]).toEqual(["a1.tiny", "a1.small", "a1.medium", "a1.large", "a1.xxlarge", "a1.3xlarge"]);
    expect([...AMP_THREAD_VISIBILITIES]).toEqual(["private", "unlisted", "workspace", "group"]);
  });
});

describe("runner pin rule (design §6.2, fail closed)", () => {
  test("runnerDir unset fails closed even for a dial-free pin", () => {
    const target = { worker: "amp-runner" as const, runnerId: "macbook" };
    expect(() => resolveAmpRemotePinPlan({ target, cwd: "/repo", catalogModel: "zai-org/glm-5" }))
      .toThrow(/runnerDir is unset/);
  });

  test("runnerDir equal to cwd allows the pin; a different dir fails closed", () => {
    const target = { worker: "amp-runner" as const, runnerId: "macbook", runnerDir: "/repo" };
    expect(resolveAmpRemotePinPlan({ target, cwd: "/repo", catalogModel: "zai-org/glm-5" }).kind).toBe("pin");
    expect(() => resolveAmpRemotePinPlan({ target: { ...target, runnerDir: "/elsewhere" }, cwd: "/repo", catalogModel: "zai-org/glm-5" }))
      .toThrow(/runnerDir/);
  });

  test("orb pins always fail closed; plugin modes are fine everywhere", () => {
    expect(() => resolveAmpRemotePinPlan({ target: { worker: "amp-orb", project: "o/r" }, cwd: "/repo", catalogModel: "zai-org/glm-5" }))
      .toThrow(/amp-orb cannot use worker\.catalogModel\/effort/);
    expect(resolveAmpRemotePinPlan({ target: { worker: "amp-orb", project: "o/r" }, cwd: "/repo", mode: "low" }).kind).toBe("mode");
    expect(resolveAmpRemotePinPlan({ target: { worker: "amp-runner", runnerId: "m" }, cwd: "/anywhere", mode: "ultra" }).kind).toBe("mode");
  });
});

describe("runAmpOrbWorkflowTask / runAmpRunnerWorkflowTask (fake amp CLI)", () => {
  test("orb: exact argv, result extraction, session id metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-amp-orb-"));
    try {
      const fakeAmp = join(root, "fake-amp-orb.mjs");
      await writeFile(fakeAmp, fakeAmpScript(ORB_SUCCESS_STREAM));
      await chmod(fakeAmp, 0o755);

      const execution = await runAmpOrbWorkflowTask(orbTask, {
        cwd: root,
        bin: fakeAmp,
        model: "high",
        resolvedPermission: "legacy",
      });

      const args = JSON.parse(await readFile(join(root, "argv.json"), "utf8")) as string[];
      expect(args).toContain("--orb-execute");
      expect(args.slice(args.indexOf("--project"), args.indexOf("--project") + 2)).toEqual(["--project", "skastr052/orb-setup"]);
      expect(args.slice(args.indexOf("--orb-size"), args.indexOf("--orb-size") + 2)).toEqual(["--orb-size", "a1.tiny"]);
      expect(args).toContain("--title");
      expect(args).not.toContain("--executor");
      expect(execution.output).toEqual({ summary: "ok" });
      expect(execution.metadata?.sessionId).toBe("T-orb-probe-0001");
      expect(execution.metadata?.ampThread).toBe("T-orb-probe-0001");
      expect(execution.metadata?.ampProject).toBe("skastr052/orb-setup");
      expect(execution.metadata?.orbSize).toBe("a1.tiny");
      expect(execution.metadata?.model).toBe("high");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runner: --executor runner:<id> argv and honest metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-amp-runner-"));
    try {
      const fakeAmp = join(root, "fake-amp-runner.mjs");
      await writeFile(fakeAmp, fakeAmpScript(ORB_SUCCESS_STREAM.replace("T-orb-probe-0001", "T-runner-probe-0003")));
      await chmod(fakeAmp, 0o755);

      const execution = await runAmpRunnerWorkflowTask(runnerTask, {
        cwd: root,
        bin: fakeAmp,
        resolvedPermission: "legacy",
      });

      const args = JSON.parse(await readFile(join(root, "argv.json"), "utf8")) as string[];
      expect(args).not.toContain("--orb-execute");
      expect(args.slice(args.indexOf("--executor"), args.indexOf("--executor") + 2)).toEqual(["--executor", "runner:macbook"]);
      expect(args).not.toContain("--runner-dir");
      expect(execution.metadata?.ampRunner).toBe("macbook");
      expect(execution.metadata?.sessionId).toBe("T-runner-probe-0003");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is_error result throws with the stream error text and thread metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-amp-remote-err-"));
    try {
      const fakeAmp = join(root, "fake-amp-err.mjs");
      await writeFile(fakeAmp, fakeAmpScript(RUNNER_ERROR_STREAM));
      await chmod(fakeAmp, 0o755);

      const failure = await runAmpRunnerWorkflowTask(runnerTask, {
        cwd: root,
        bin: fakeAmp,
        resolvedPermission: "legacy",
      }).then(() => undefined, (error: unknown) => error);

      expect(failure).toBeInstanceOf(AmpWorkflowWorkerError);
      const metadata = (failure as AmpWorkflowWorkerError).metadata;
      expect(metadata?.adapter).toBe("amp-runner");
      expect(metadata?.sessionId).toBe("T-runner-probe-0002");
      expect(metadata?.ampRunner).toBe("macbook");
      expect((failure as AmpWorkflowWorkerError).message).toContain("agent turn failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("permissive permission throws before any process runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-amp-remote-perm-"));
    try {
      const fakeAmp = join(root, "fake-amp-never.mjs");
      await writeFile(fakeAmp, fakeAmpScript(ORB_SUCCESS_STREAM));
      await chmod(fakeAmp, 0o755);
      await expect(runAmpOrbWorkflowTask(orbTask, {
        cwd: root,
        bin: fakeAmp,
        resolvedPermission: "permissive",
      })).rejects.toThrow(WorkflowPermissionError);
      expect(await readFile(join(root, "argv.json")).then(() => true, () => false)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("remote worker identity (design §4 cache fold)", () => {
  test("project, size, runnerId, runnerDir change the address; labels, visibility, permission legacy do not", () => {
    const base = workflowTaskIdentity("wf", orbTask, { fallbackPermission: "legacy" }).promptHash;
    expect(workflowTaskIdentity("wf", { ...orbTask, worker: { ...orbTask.worker, project: "other/repo" } }, { fallbackPermission: "legacy" }).promptHash)
      .not.toBe(base);
    expect(workflowTaskIdentity("wf", { ...orbTask, worker: { ...orbTask.worker, size: "a1.small" } }, { fallbackPermission: "legacy" }).promptHash)
      .not.toBe(base);
    expect(workflowTaskIdentity("wf", { ...orbTask, worker: { ...orbTask.worker, visibility: "workspace" } }, { fallbackPermission: "legacy" }).promptHash)
      .toBe(base);
    expect(workflowTaskIdentity("wf", { ...orbTask, worker: { ...orbTask.worker, labels: ["x"] } }, { fallbackPermission: "legacy" }).promptHash)
      .toBe(base);

    const runnerBase = workflowTaskIdentity("wf", runnerTask, { fallbackPermission: "legacy" }).promptHash;
    expect(workflowTaskIdentity("wf", { ...runnerTask, worker: { ...runnerTask.worker, runnerId: "mini" } }, { fallbackPermission: "legacy" }).promptHash)
      .not.toBe(runnerBase);
    expect(workflowTaskIdentity("wf", { ...runnerTask, worker: { ...runnerTask.worker, runnerDir: "/tmp/other" } }, { fallbackPermission: "legacy" }).promptHash)
      .not.toBe(runnerBase);
  });
});

describe("harness catalogs", () => {
  test("amp-orb and amp-runner have catalog rows with refresh procedures", () => {
    for (const harness of ["amp-orb", "amp-runner"] as const) {
      const catalog = HARNESS_CATALOGS[harness];
      expect(catalog.harness).toBe(harness);
      expect(catalog.refresh.procedure.length).toBeGreaterThan(0);
      expect(catalog.refresh.sources.length).toBeGreaterThan(0);
    }
    expect(HARNESS_CATALOGS["amp-runner"].binaryNames).toEqual(["amp"]);
  });
});
