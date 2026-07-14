import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCanonicalCompileFixture } from "./compile/test-fixtures.js";
import { prismOxlintPluginJs } from "./init-templates.js";
import { generateMcpServerBundle } from "./compile/mcp-bundle.js";
import { writePrismMcpServerBundle } from "./compile/mcp-runtime-path.js";
import { bindingFromToolSource } from "./compile/tool-bindings.js";
import { cleanupPrismMcpProcessesUnder } from "./testing/mcp-process-cleanup.js";
import { deriveProjectKey } from "./project-key.js";
import { WORKFLOW_STORE_SCHEMA_VERSION, WorkflowStore } from "./workflow-store.js";
import { registerWorkflowStore } from "./workflow-store-registry.js";

const tempRoots: string[] = [];
const repoRoot = process.cwd();

const effectImportPath = join(
  repoRoot,
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const prismImportPath = join(repoRoot, "src", "index.ts").replace(/\\/g, "/");

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-cli-"));
  tempRoots.push(root);
  return root;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const mergeEnv = (overrides: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );

const runCli = async (
  args: string[],
  envOverrides: Record<string, string>,
  options: { readonly cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", join(repoRoot, "src", "cli.ts"), ...args],
    cwd: options.cwd ?? repoRoot,
    env: mergeEnv(envOverrides),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const getFreePort = (host: string): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });

test("refresh and plan help use managed backup policy instead of a per-run backup flag", async () => {
  for (const command of ["refresh", "plan"]) {
    const result = await runCli([command, "--help"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(command === "refresh" ? "--dry-run" : "--json");
    expect(result.stdout).not.toContain("--backup");
    expect(result.stdout).not.toContain(".bak");
  }
});

test("workflow run, update, and resume expose budgets but no cache bypass", async () => {
  for (const args of [
    ["workflow", "run", "--help"],
    ["workflow", "runs", "update", "--help"],
    ["workflow", "runs", "resume", "--help"],
  ]) {
    const result = await runCli(args, {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--max-concurrent-tasks");
    expect(result.stdout).toContain("Maximum concurrent workflow task executions");
    expect(result.stdout).toContain("--task-timeout-ms");
    expect(result.stdout).toContain("Default per-task process timeout");
    expect(result.stdout).toContain("--max-wall-ms");
    expect(result.stdout).toContain("--task-no-progress-ms");
    expect(result.stdout).toContain("--max-tasks");
    expect(result.stdout).toContain("--max-cost-usd");
    expect(result.stdout).not.toContain("--cache");
    expect(result.stdout).not.toContain("--no-cache");
  }
});

test("workflow budget flags reject non-positive integer limits and non-finite or negative cost", async () => {
  for (const [flag, value, message] of [
    ["--max-wall-ms", "0", "must be a positive integer"],
    ["--task-no-progress-ms", "1.5", "must be a positive integer"],
    ["--max-tasks", "Infinity", "must be a positive integer"],
    ["--max-cost-usd", "-0.01", "must be a finite non-negative number"],
    ["--max-cost-usd", "Infinity", "must be a finite non-negative number"],
    ["--max-cost-usd", "", "must be a finite non-negative number"],
  ] as const) {
    const result = await runCli(["workflow", "run", "unused.workflow.ts", flag, value], {});

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
  }
});

test("workflow monitor help exposes deterministic timeout controls", async () => {
  const help = await runCli(["workflow", "monitor", "--help"], {});

  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("--store");
  expect(help.stdout).toContain("--poll-ms");
  expect(help.stdout).toContain("--fail-stale-after-ms");
  expect(help.stdout).toContain("--timeout-ms");

  const invalid = await runCli(["workflow", "monitor", "--timeout-ms", "0"], {});
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stderr).toContain("must be a positive integer");
});

test("workflow scaffold writes to ~/.prism/workflows by default and never instructs git add (PQ-176)", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const fakeHome = join(root, "home");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  // Copy the fixture rather than compiling the checked-in example in place —
  // refresh writes a fresh prism.lock next to the plugin source, which would
  // otherwise dirty the repo on every test run.
  const pluginPath = join(root, "prism-harness-qa");
  await cp(join(repoRoot, "examples", "prism-harness-qa"), pluginPath, { recursive: true });
  // HOME redirects the harness roots (~/.claude, ~/.codex) into the sandbox —
  // refresh must never touch the real machine's harness configs.
  const env = { PRISM_HOME: prismHome, HOME: fakeHome };

  const refresh = await runCli(
    ["refresh", pluginPath, "--harness", "claude-code,codex-cli", "--scope", "global"],
    env,
    { cwd: projectRoot },
  );
  expect(refresh.stderr).toBe("");
  expect(refresh.exitCode).toBe(0);

  const scaffold = await runCli(["workflow", "scaffold", "pq176-smoke"], env, { cwd: projectRoot });
  expect(scaffold.exitCode).toBe(0);
  expect(scaffold.stdout).not.toContain("git add");

  const expectedPath = join(prismHome, "workflows", "pq176-smoke.workflow.ts");
  expect(scaffold.stdout).toContain(expectedPath);
  expect(await pathExists(expectedPath)).toBe(true);
  // Never written under the project repo the doc warns against.
  expect(await pathExists(join(projectRoot, "workflows", "pq176-smoke.workflow.ts"))).toBe(false);

  const source = await readFile(expectedPath, "utf8");
  expect(source).not.toContain("git add");
  expect(source).toContain("agents.");

  const validate = await runCli(["workflow", "validate", expectedPath], env, { cwd: projectRoot });
  expect(validate.exitCode).toBe(0);
  const summary = JSON.parse(validate.stdout) as { dynamic: boolean };
  // The scaffold's `run:` fan-out is dynamic (tasks constructed at runtime),
  // so validate's static summary reports no enumerable tasks — expected.
  expect(summary.dynamic).toBe(true);

  // The scaffold template names its tasks "a" and (when two workers are
  // picked) "b" — supply both; an unused mock key is harmless.
  const mockOutputPath = join(root, "mock-output.json");
  await writeFile(
    mockOutputPath,
    JSON.stringify({ a: { worker: "x", summary: "ok" }, b: { worker: "x", summary: "ok" } }),
  );
  const run = await runCli(
    ["workflow", "run", expectedPath, "--mock-output", mockOutputPath],
    env,
    { cwd: projectRoot },
  );
  expect(run.exitCode).toBe(0);
}, 60_000);

test("workflow typecheck accepts a workflow against shipped Prism declarations", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const workflowPath = join(root, "typed.workflow.ts");

  await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow, type WorkflowAgentRef } from "prism";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const satisfies WorkflowAgentRef;

export const workflow = defineWorkflow({
  name: "typed-smoke",
  tasks: [defineTask({
    id: "build",
    phase: "implement",
    agent,
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
  })] as const,
});
`);

  const result = await runCli(["workflow", "typecheck", workflowPath], { PRISM_HOME: prismHome });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Workflow typecheck passed");
  expect(result.stdout).toContain("tsconfig.workflow.json");
  expect(await pathExists(join(prismHome, "state", "tsconfig.workflow.json"))).toBe(true);
}, 30_000);

test("workflow typecheck rejects deliberate phase field type skew", async () => {
  const root = await createTempRoot();
  const workflowPath = join(root, "bad-phase.workflow.ts");

  await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow, type WorkflowAgentRef } from "prism";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const satisfies WorkflowAgentRef;

export const workflow = defineWorkflow({
  name: "bad-phase",
  tasks: [defineTask({
    id: "build",
    phase: 42,
    agent,
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
  })] as const,
});
`);

  const result = await runCli(["workflow", "typecheck", workflowPath], { PRISM_HOME: join(root, "prism-home") });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Workflow typecheck failed");
  expect(result.stderr).toContain("Type 'number' is not assignable to type 'string'");
}, 30_000);

test("workflow typecheck rejects diagnostics from imported workflow helpers", async () => {
  const root = await createTempRoot();
  const workflowPath = join(root, "with-helper.workflow.ts");
  const helperPath = join(root, "helper.ts");

  await writeFile(helperPath, `
export const helperSummary: string = 42;
`);

  await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow, type WorkflowAgentRef } from "prism";
import { helperSummary } from "./helper.ts";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const satisfies WorkflowAgentRef;

export const workflow = defineWorkflow({
  name: "helper-diagnostic",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: helperSummary,
    output: Schema.Struct({ summary: Schema.String }),
  })] as const,
});
`);

  const result = await runCli(["workflow", "typecheck", workflowPath], { PRISM_HOME: join(root, "prism-home") });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Workflow typecheck failed");
  expect(result.stderr).toContain("helper.ts");
  expect(result.stderr).toContain("Type 'number' is not assignable to type 'string'");
}, 30_000);

test("workflow typecheck rejects missing generated refs imports", async () => {
  const root = await createTempRoot();
  const workflowPath = join(root, "missing-refs.workflow.ts");

  await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow, type WorkflowAgentRef } from "prism";
import { agents } from "prism/refs";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const satisfies WorkflowAgentRef;

void agents;

export const workflow = defineWorkflow({
  name: "missing-refs",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
  })] as const,
});
`);

  const result = await runCli(["workflow", "typecheck", workflowPath], { PRISM_HOME: join(root, "prism-home") });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Workflow typecheck failed");
  expect(result.stderr).toContain("Cannot find module 'prism/refs'");
}, 30_000);

test("workflow run, update, and resume reject the removed cache bypass flag", async () => {
  for (const args of [
    ["workflow", "run", "workflow.ts", "--no-cache"],
    ["workflow", "runs", "update", "run-1", "workflow.ts", "--no-cache"],
    ["workflow", "runs", "resume", "run-1", "workflow.ts", "--no-cache"],
  ]) {
    const result = await runCli(args, {});

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown option '--no-cache'");
  }
});

test("checked-in example workflows do not recommend the removed --no-cache flag", async () => {
  for (const relativePath of [
    "examples/prism-harness-qa/workflows/mcp-council.workflow.ts",
    "examples/prism-harness-qa/workflows/smoke-devin.workflow.ts",
  ]) {
    const source = await readFile(join(repoRoot, relativePath), "utf8");
    expect(source).not.toContain("--no-cache");
  }
});

test("workflow runs list applies its limit to newest runs first", async () => {
  const root = await createTempRoot();
  const storePath = join(root, "workflows.sqlite");
  const store = await WorkflowStore.open(storePath);
  store.createRun("older", "a-older-run");
  store.createRun("newer", "z-newer-run");
  store.close();

  const result = await runCli(["workflow", "runs", "list", "--store", storePath, "--limit", "1"], {});

  expect(result.exitCode).toBe(0);
  const listed = JSON.parse(result.stdout) as { runs: Array<{ runId: string }> };
  expect(listed.runs.map((run) => run.runId)).toEqual(["z-newer-run"]);
});

const toSqliteDateTime = (date: Date): string => date.toISOString().slice(0, 19).replace("T", " ");

test("workflow runs list --since filters by cutoff, surfaces a cause column, and rejects --hours+--since (OBS-007)", async () => {
  const root = await createTempRoot();
  const storePath = join(root, "workflows.sqlite");
  const store = await WorkflowStore.open(storePath);
  store.createRun("old-workflow", "old-run");
  const failId = store.createRun("new-workflow", "new-run");
  store.finishRun(failId, "failed", { kind: "workflow-failed", errorName: "Error", message: "boom" });
  store.close();

  const now = new Date();
  const db = new Database(storePath);
  db.query("update workflow_runs set created_at = ? where run_id = ?")
    .run(toSqliteDateTime(new Date(now.getTime() - 10 * 24 * 3_600_000)), "old-run");
  db.query("update workflow_runs set created_at = ? where run_id = ?")
    .run(toSqliteDateTime(new Date(now.getTime() - 60_000)), "new-run");
  db.close();

  const unfiltered = await runCli(["workflow", "runs", "list", "--store", storePath], {});
  expect(unfiltered.exitCode).toBe(0);
  const unfilteredListed = JSON.parse(unfiltered.stdout) as {
    runs: Array<{ runId: string; cause: string | null }>;
  };
  expect(unfilteredListed.runs.map((run) => run.runId)).toEqual(["new-run", "old-run"]);
  expect(unfilteredListed.runs).toEqual([
    expect.objectContaining({ runId: "new-run", cause: "workflow-failed" }),
    expect.objectContaining({ runId: "old-run", cause: null }),
  ]);

  const sinceRelative = await runCli(["workflow", "runs", "list", "--store", storePath, "--since", "24h"], {});
  expect(sinceRelative.exitCode).toBe(0);
  const sinceRelativeListed = JSON.parse(sinceRelative.stdout) as { runs: Array<{ runId: string }> };
  expect(sinceRelativeListed.runs.map((run) => run.runId)).toEqual(["new-run"]);

  const sinceIso = await runCli([
    "workflow", "runs", "list", "--store", storePath,
    "--since", toSqliteDateTime(new Date(now.getTime() - 5 * 24 * 3_600_000)),
  ], {});
  expect(sinceIso.exitCode).toBe(0);
  const sinceIsoListed = JSON.parse(sinceIso.stdout) as { runs: Array<{ runId: string }> };
  expect(sinceIsoListed.runs.map((run) => run.runId)).toEqual(["new-run"]);

  const conflicting = await runCli(
    ["workflow", "runs", "list", "--store", storePath, "--hours", "1", "--since", "24h"],
    {},
  );
  expect(conflicting.exitCode).toBe(2);
  expect(conflicting.stderr).toContain("--hours and --since are mutually exclusive");

  const badSince = await runCli(["workflow", "runs", "list", "--store", storePath, "--since", "not-a-date"], {});
  expect(badSince.exitCode).toBe(2);
  expect(badSince.stderr).toContain("--since must be an ISO date/time");
}, 30_000);

// Builds a store file pinned at schema v1 (matching the migration fixtures in
// workflow-store.test.ts), for exercising the WFE-007 soft-divergence notice from the CLI edge.
const createLegacyV1Store = (storePath: string, runId: string): void => {
  const db = new Database(storePath);
  db.exec(`
    create table workflow_runs (
      run_id text primary key,
      workflow text not null,
      status text not null default 'running',
      finished_at text,
      handoff_token text,
      runner_pid integer,
      heartbeat_at text,
      created_at text not null default (datetime('now'))
    );
    create table workflow_run_tasks (
      run_id text not null,
      ordinal integer not null,
      workflow text not null,
      task_id text not null,
      cache_key text not null,
      prompt_hash text not null,
      agent_manifest_hash text not null,
      agent_plugin text not null,
      agent_name text not null,
      status text not null,
      cached integer not null,
      output_json text not null,
      metadata_json text,
      created_at text not null default (datetime('now')),
      primary key (run_id, ordinal)
    );
    create table workflow_events (
      run_id text not null,
      sequence integer not null,
      task_id text,
      type text not null,
      payload_json text not null,
      created_at text not null default (datetime('now')),
      primary key (run_id, sequence)
    );
    insert into workflow_runs (run_id, workflow, status, finished_at)
    values ('${runId}', 'legacy-workflow', 'completed', '2026-01-01 00:00:00');
    pragma user_version = 1;
  `);
  db.close();
};

test("workflow runs list surfaces a soft-divergence notice when the store schema is older than the binary (WFE-007)", async () => {
  const root = await createTempRoot();
  const storePath = join(root, "workflows.sqlite");
  createLegacyV1Store(storePath, "legacy-run");

  const first = await runCli(["workflow", "runs", "list", "--store", storePath], {});
  expect(first.exitCode).toBe(0);
  const firstListed = JSON.parse(first.stdout) as {
    runs: Array<{ runId: string }>;
    storeSchemaNotice?: { severity: string; openedVersion: number; currentVersion: number; message: string };
  };
  expect(firstListed.runs.map((run) => run.runId)).toEqual(["legacy-run"]);
  expect(firstListed.storeSchemaNotice).toEqual({
    severity: "info",
    openedVersion: 1,
    currentVersion: WORKFLOW_STORE_SCHEMA_VERSION,
    message: expect.stringContaining("schema version 1"),
  });

  // The store is now at the current schema — a later read carries no notice.
  const second = await runCli(["workflow", "runs", "list", "--store", storePath], {});
  expect(second.exitCode).toBe(0);
  const secondListed = JSON.parse(second.stdout) as { storeSchemaNotice?: unknown };
  expect(secondListed.storeSchemaNotice).toBeUndefined();
});

test("workflow runs show surfaces a soft-divergence notice when the store schema is older than the binary (WFE-007)", async () => {
  const root = await createTempRoot();
  const storePath = join(root, "workflows.sqlite");
  createLegacyV1Store(storePath, "legacy-show-run");

  const show = await runCli(["workflow", "runs", "show", "legacy-show-run", "--store", storePath], {});
  expect(show.exitCode).toBe(0);
  const shown = JSON.parse(show.stdout) as {
    run: { runId: string };
    storeSchemaNotice?: { severity: string; openedVersion: number; currentVersion: number; message: string };
  };
  expect(shown.run.runId).toBe("legacy-show-run");
  expect(shown.storeSchemaNotice).toEqual({
    severity: "info",
    openedVersion: 1,
    currentVersion: WORKFLOW_STORE_SCHEMA_VERSION,
    message: expect.stringContaining("schema version 1"),
  });
});

test("workflow runs list --all aggregates per-store soft-divergence notices (WFE-007)", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const legacyStorePath = join(root, "legacy.sqlite");
  const currentStorePath = join(root, "current.sqlite");
  createLegacyV1Store(legacyStorePath, "legacy-all-run");
  const currentStore = await WorkflowStore.open(currentStorePath);
  currentStore.createRun("current-workflow", "current-run");
  currentStore.close();

  // Registers both store paths without opening either — so the first real open of the legacy
  // store happens inside `runs list --all` itself, and the notice it produces is observable.
  registerWorkflowStore(prismHome, legacyStorePath);
  registerWorkflowStore(prismHome, currentStorePath);

  const all = await runCli(["workflow", "runs", "list", "--all"], { PRISM_HOME: prismHome });
  expect(all.exitCode).toBe(0);
  const listed = JSON.parse(all.stdout) as {
    runs: Array<{ runId: string }>;
    storeSchemaNotices?: Array<{ severity: string; openedVersion: number; currentVersion: number; message: string; storePath: string }>;
  };
  expect(listed.runs.map((run) => run.runId).sort()).toEqual(["current-run", "legacy-all-run"]);
  expect(listed.storeSchemaNotices).toEqual([
    {
      severity: "info",
      openedVersion: 1,
      currentVersion: WORKFLOW_STORE_SCHEMA_VERSION,
      message: expect.stringContaining("schema version 1"),
      storePath: legacyStorePath,
    },
  ]);
});

test("workflow runs show resolves a run across the store registry without --store (routing defect, repro run 07cedd42-57d2)", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  const workflowPath = join(root, "cross-store.workflow.ts");
  const mockOutputPath = join(root, "mock-output.json");
  await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

export const workflow = defineWorkflow({
  name: "cross-store-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
    cacheKey: "cross-store-build",
  })] as const,
});
`);
  await writeFile(mockOutputPath, JSON.stringify({ build: { summary: "ok" } }));

  // Registers project A's own default store in the shared registry.
  const runA = await runCli(
    ["workflow", "run", workflowPath, "--mock-output", mockOutputPath],
    { PRISM_HOME: prismHome },
    { cwd: projectA },
  );
  expect(runA.exitCode).toBe(0);

  // The run under test lands in project B's default store — a different store than A's.
  const runB = await runCli(
    ["workflow", "run", workflowPath, "--mock-output", mockOutputPath],
    { PRISM_HOME: prismHome },
    { cwd: projectB },
  );
  expect(runB.exitCode).toBe(0);
  const { runId } = JSON.parse(runB.stdout) as { runId: string };

  // Looked up from project A's cwd, with no --store: before the fix this errored "workflow run
  // not found" because only project A's default store was ever consulted.
  const show = await runCli(
    ["workflow", "runs", "show", runId],
    { PRISM_HOME: prismHome },
    { cwd: projectA },
  );
  expect(show.exitCode).toBe(0);
  const showData = JSON.parse(show.stdout) as { run: { runId: string; workflow: string } };
  expect(showData.run).toMatchObject({ runId, workflow: "cross-store-smoke" });

  // An explicit --store is still honored as given (no scanning) and still 404s cleanly for a
  // run that isn't in that specific store.
  const explicitMiss = await runCli(
    ["workflow", "runs", "show", runId, "--store", join(prismHome, "workflows", deriveProjectKey(projectA).key, "workflows.sqlite")],
    { PRISM_HOME: prismHome },
  );
  expect(explicitMiss.exitCode).toBe(2);
  expect(explicitMiss.stderr).toContain(`workflow run not found: ${runId}`);
}, 30_000);

test("workflow runs summary --all reports a workflow x status x cause rollup across stores (OBS-007)", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const storeAPath = join(root, "store-a.sqlite");
  const storeBPath = join(root, "store-b.sqlite");

  const storeA = await WorkflowStore.open(storeAPath);
  storeA.createRun("wf-one", "ok-run");
  const failRunId = storeA.createRun("wf-one", "fail-run");
  storeA.finishRun(failRunId, "failed", { kind: "workflow-failed", errorName: "Error", message: "boom" });
  storeA.close();

  const storeB = await WorkflowStore.open(storeBPath);
  const failRunId2 = storeB.createRun("wf-two", "fail-run-2");
  storeB.finishRun(failRunId2, "failed", { kind: "workflow-failed", errorName: "Error", message: "boom2" });
  storeB.close();

  // Registers both stores in the (isolated, PRISM_HOME-scoped) registry.
  expect((await runCli(["workflow", "runs", "list", "--store", storeAPath], { PRISM_HOME: prismHome })).exitCode).toBe(0);
  expect((await runCli(["workflow", "runs", "list", "--store", storeBPath], { PRISM_HOME: prismHome })).exitCode).toBe(0);

  const json = await runCli(["workflow", "runs", "summary", "--all", "--json"], { PRISM_HOME: prismHome });
  expect(json.exitCode).toBe(0);
  const data = JSON.parse(json.stdout) as {
    totals: { runs: number; stores: number };
    rollup: Array<{ workflow: string; status: string; cause: string | null; count: number }>;
  };
  expect(data.totals).toEqual({ runs: 3, stores: 2 });
  expect(data.rollup).toEqual(expect.arrayContaining([
    expect.objectContaining({ workflow: "wf-one", status: "running", cause: null, count: 1 }),
    expect.objectContaining({ workflow: "wf-one", status: "failed", cause: "workflow-failed", count: 1 }),
    expect.objectContaining({ workflow: "wf-two", status: "failed", cause: "workflow-failed", count: 1 }),
  ]));

  const text = await runCli(["workflow", "runs", "summary", "--all"], { PRISM_HOME: prismHome });
  expect(text.exitCode).toBe(0);
  expect(text.stdout).toContain("Workflow runs rollup: 3 runs across 2 stores");
  expect(text.stdout).toContain("workflow-failed");

  const usageError = await runCli(["workflow", "runs", "summary", "some-run-id", "--all"], { PRISM_HOME: prismHome });
  expect(usageError.exitCode).toBe(2);
  expect(usageError.stderr).toContain("--all does not take a runId");
}, 30_000);

test("workflow default store lives under PRISM_HOME, not the current project", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const workflowPath = join(root, "default-store.workflow.ts");
  const mockOutputPath = join(root, "mock-output.json");

  await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

export const workflow = defineWorkflow({
  name: "default-store-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
    cacheKey: "default-store-build",
  })] as const,
});
`);
  await writeFile(mockOutputPath, JSON.stringify({ build: { summary: "ok" } }));

  const run = await runCli([
    "workflow", "run", workflowPath,
    "--mock-output", mockOutputPath,
  ], { PRISM_HOME: prismHome }, { cwd: root });

  expect(run.exitCode).toBe(0);
  const runData = JSON.parse(run.stdout) as { runId: string };
  const projectKey = deriveProjectKey(root).key;
  const expectedStore = join(prismHome, "workflows", projectKey, "workflows.sqlite");
  expect(await pathExists(expectedStore)).toBe(true);
  expect(await pathExists(join(root, ".prism", "workflows", "workflows.sqlite"))).toBe(false);

  const list = await runCli(["workflow", "runs", "list"], { PRISM_HOME: prismHome }, { cwd: root });
  expect(list.exitCode).toBe(0);
  const listed = JSON.parse(list.stdout) as { runs: Array<{ runId: string; workflow: string }> };
  expect(listed.runs).toContainEqual(expect.objectContaining({
    runId: runData.runId,
    workflow: "default-store-smoke",
  }));
}, 30_000);

test("workflow runs show returns the run record and rejects missing runs", async () => {
  const root = await createTempRoot();
  const workflowPath = join(root, "inspect.workflow.ts");
  const mockOutputPath = join(root, "mock-output.json");
  const storePath = join(root, "workflows.sqlite");

  await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

export const workflow = defineWorkflow({
  name: "inspect-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
    cacheKey: "inspect-build",
  })] as const,
});
`);
  await writeFile(mockOutputPath, JSON.stringify({ build: { summary: "ok" } }));

  const run = await runCli([
    "workflow", "run", workflowPath,
    "--store", storePath,
    "--mock-output", mockOutputPath,
  ], {});

  expect(run.exitCode).toBe(0);
  const runData = JSON.parse(run.stdout) as { runId: string };

  const show = await runCli(["workflow", "runs", "show", runData.runId, "--store", storePath], {});

  expect(show.exitCode).toBe(0);
  const showData = JSON.parse(show.stdout) as {
    run: { runId: string; workflow: string; status: string };
    taskSummary: Array<{ taskId: string; status: string; cached: boolean; cacheLookup: string }>;
    tasks: Array<{ taskId: string; cached: boolean }>;
  };
  expect(showData.run).toMatchObject({ runId: runData.runId, workflow: "inspect-smoke", status: "completed" });
  expect(showData.taskSummary).toEqual([
    expect.objectContaining({ taskId: "build", status: "completed", cached: false, cacheLookup: "miss" }),
  ]);
  expect(showData.tasks).toEqual([expect.objectContaining({ taskId: "build", cached: false })]);

  const missing = await runCli(["workflow", "runs", "show", "missing-run", "--store", storePath], {});
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr).toContain("workflow run not found: missing-run");
}, 30_000);

test("workflow run exits 0 for a fully successful run (PQ-174)", async () => {
  const root = await createTempRoot();
  const workflowPath = join(root, "success.workflow.ts");
  const mockOutputPath = join(root, "mock-output.json");
  const storePath = join(root, "workflows.sqlite");

  await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

export const workflow = defineWorkflow({
  name: "exit-code-success-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
    cacheKey: "exit-code-success-build",
  })] as const,
});
`);
  await writeFile(mockOutputPath, JSON.stringify({ build: { summary: "ok" } }));

  const run = await runCli([
    "workflow", "run", workflowPath,
    "--store", storePath,
    "--mock-output", mockOutputPath,
  ], {});

  expect(run.exitCode).toBe(0);
  const runData = JSON.parse(run.stdout) as { runId: string; tasks: Array<{ status: string }> };
  expect(runData.tasks.every((task) => task.status === "completed")).toBe(true);

  const show = await runCli(["workflow", "runs", "show", runData.runId, "--store", storePath], {});
  expect(show.exitCode).toBe(0);
  const showData = JSON.parse(show.stdout) as { run: { status: string } };
  expect(showData.run.status).toBe("completed");
}, 30_000);

test("workflow run and runs wait exit non-zero when a run completes with a fault-isolated failed task (PQ-174)", async () => {
  // PQ-166 fault isolation lets an author's `run` program recover from a task failure (e.g.
  // via Effect.either) and finish successfully, so the persisted run status reads
  // "completed" even though a task failed. That must still surface as a process failure to a
  // caller checking $? — this is the exact regression PQ-174 fixes.
  const root = await createTempRoot();
  const workflowPath = join(root, "fault-isolated.workflow.ts");
  const mockOutputPath = join(root, "mock-output.json");
  const storePath = join(root, "workflows.sqlite");

  await writeFile(workflowPath, `
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

const build = defineTask({
  id: "build",
  agent,
  prompt: "Build the slice.",
  output: Schema.Struct({ summary: Schema.String }),
  finish: { maxRepairs: 0 },
});

export const workflow = defineWorkflow({
  name: "fault-isolated-exit-code-smoke",
  run: (wf) => Effect.gen(function* () {
    const outcome = yield* Effect.either(wf.runTask(build));
    return { isolated: outcome._tag === "Left" };
  }),
});
`);
  // Deliberately fails schema decode (missing "summary") to force the task to fail; the
  // workflow's own Effect.either isolates it, so the run itself still completes.
  await writeFile(mockOutputPath, JSON.stringify({ build: { wrong: "shape" } }));

  const run = await runCli([
    "workflow", "run", workflowPath,
    "--store", storePath,
    "--mock-output", mockOutputPath,
  ], {});

  expect(run.exitCode).not.toBe(0);
  const runData = JSON.parse(run.stdout) as { runId: string; tasks: Array<{ status: string }> };
  expect(runData.tasks).toEqual([expect.objectContaining({ id: "build", status: "failed" })]);

  const show = await runCli(["workflow", "runs", "show", runData.runId, "--store", storePath], {});
  expect(show.exitCode).toBe(0);
  const showData = JSON.parse(show.stdout) as { run: { status: string } };
  // The persisted run status is "completed" (the author program recovered) even though the
  // CLI process itself must exit non-zero — the assertion this regression test exists for.
  expect(showData.run.status).toBe("completed");

  const wait = await runCli([
    "workflow", "runs", "wait", runData.runId,
    "--store", storePath,
  ], {});
  expect(wait.exitCode).not.toBe(0);
  const waitData = JSON.parse(wait.stdout) as { run: { status: string } };
  expect(waitData.run.status).toBe("completed");
}, 30_000);

test("workflow runs summary exposes compact execution evidence in text and JSON", async () => {
  const root = await createTempRoot();
  const workflowPath = join(root, "summary.workflow.ts");
  const mockOutputPath = join(root, "mock-output.json");
  const storePath = join(root, "workflows.sqlite");

  await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

export const workflow = defineWorkflow({
  name: "summary-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
    cacheKey: "summary-build",
  })] as const,
});
`);
  await writeFile(mockOutputPath, JSON.stringify({ build: { summary: "ok" } }));

  const run = await runCli([
    "workflow", "run", workflowPath,
    "--store", storePath,
    "--mock-output", mockOutputPath,
  ], {});
  expect(run.exitCode).toBe(0);
  const runData = JSON.parse(run.stdout) as { runId: string };

  const text = await runCli(["workflow", "runs", "summary", runData.runId, "--store", storePath], {});
  expect(text.exitCode).toBe(0);
  expect(text.stdout).toContain("execution evidence only");
  expect(text.stdout).toContain("does not prove workflow side effects were semantically correct");
  expect(text.stdout).toContain("Tasks: total 1, fresh executions 1, cache hits 0, repairs 0");
  expect(text.stdout).toContain("- build: completed, fresh");
  expect(text.stdout).toContain("source this run");

  const json = await runCli(["workflow", "runs", "summary", runData.runId, "--store", storePath, "--json"], {});
  expect(json.exitCode).toBe(0);
  const data = JSON.parse(json.stdout) as {
    summary: {
      kind: string;
      semanticCorrectness: string;
      disclaimer: string;
      totals: { totalTasks: number; freshExecutions: number; cacheHits: number; repairs: number; status: string };
      tasks: Array<{ taskId: string; status: string; execution: string; evidenceSource: string; repairCount: number; workerAdapter: string | null; externalSessionPointer: string | null }>;
    };
  };
  expect(data.summary.kind).toBe("workflow-execution-evidence");
  expect(data.summary.semanticCorrectness).toBe("not-evaluated");
  expect(data.summary.disclaimer).toContain("execution evidence only");
  expect(data.summary.totals).toMatchObject({
    totalTasks: 1,
    freshExecutions: 1,
    cacheHits: 0,
    repairs: 0,
    status: "completed",
  });
  expect(data.summary.tasks).toEqual([
    expect.objectContaining({
      taskId: "build",
      status: "completed",
      execution: "fresh",
      evidenceSource: "this-run",
      repairCount: 0,
      workerAdapter: null,
      externalSessionPointer: null,
    }),
  ]);

  const missing = await runCli(["workflow", "runs", "summary", "missing-run", "--store", storePath], {});
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr).toContain("workflow run not found: missing-run");
}, 30_000);

test("workflow runs show/summary surface the detached runner's captured log path (OBS-003)", async () => {
  const root = await createTempRoot();
  const workflowPath = join(root, "runner-log.workflow.ts");
  const mockOutputPath = join(root, "mock-output.json");
  const storePath = join(root, "workflows.sqlite");

  await writeFile(workflowPath, `
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "${prismImportPath}";

const agent = {
  kind: "agent-ref",
  plugin: "forge",
  name: "builder",
  description: "Build specialist",
  sourceHash: "${"a".repeat(64)}",
  manifestHash: "${"b".repeat(64)}",
  installs: ["grok"],
} as const;

export const workflow = defineWorkflow({
  name: "runner-log-smoke",
  tasks: [defineTask({
    id: "build",
    agent,
    prompt: "Return a summary.",
    output: Schema.Struct({ summary: Schema.String }),
    cacheKey: "runner-log-build",
  })] as const,
});
`);
  await writeFile(mockOutputPath, JSON.stringify({ build: { summary: "ok" } }));

  const detached = await runCli([
    "workflow", "run", workflowPath,
    "--store", storePath,
    "--mock-output", mockOutputPath,
    "--detach",
  ], {});
  expect(detached.exitCode).toBe(0);
  const { runId } = JSON.parse(detached.stdout) as { runId: string };

  const waited = await runCli(["workflow", "runs", "wait", runId, "--store", storePath], {});
  expect(waited.exitCode).toBe(0);

  const show = await runCli(["workflow", "runs", "show", runId, "--store", storePath], {});
  expect(show.exitCode).toBe(0);
  const showData = JSON.parse(show.stdout) as { run: { runnerPid?: number }; runnerLogPath?: string };
  expect(showData.run.runnerPid).toEqual(expect.any(Number));
  expect(typeof showData.runnerLogPath).toBe("string");
  expect(await Bun.file(showData.runnerLogPath as string).exists()).toBe(true);

  const summaryJson = await runCli(["workflow", "runs", "summary", runId, "--store", storePath, "--json"], {});
  expect(summaryJson.exitCode).toBe(0);
  const summaryData = JSON.parse(summaryJson.stdout) as { runnerLogPath?: string };
  expect(summaryData.runnerLogPath).toBe(showData.runnerLogPath);

  const summaryText = await runCli(["workflow", "runs", "summary", runId, "--store", storePath], {});
  expect(summaryText.exitCode).toBe(0);
  expect(summaryText.stdout).toContain(`Runner log: ${showData.runnerLogPath}`);

  // Foreground (non-detached) runs never spawn a runner process, so no path should be surfaced.
  const foreground = await runCli([
    "workflow", "run", workflowPath,
    "--store", storePath,
    "--mock-output", mockOutputPath,
  ], {});
  expect(foreground.exitCode).toBe(0);
  const { runId: foregroundRunId } = JSON.parse(foreground.stdout) as { runId: string };
  const foregroundShow = await runCli(["workflow", "runs", "show", foregroundRunId, "--store", storePath], {});
  expect(foregroundShow.exitCode).toBe(0);
  const foregroundShowData = JSON.parse(foregroundShow.stdout) as { runnerLogPath?: string };
  expect(foregroundShowData.runnerLogPath).toBeUndefined();
}, 30_000);

type JsonObject = Record<string, unknown>;

type LintRule = {
  create: (context: {
    getFilename: () => string;
    report: (diagnostic: JsonObject) => void;
  }) => Record<string, ((node: JsonObject) => void) | undefined>;
};

type LintPlugin = {
  rules: Record<string, LintRule>;
};

const readJson = async (path: string): Promise<JsonObject> =>
  JSON.parse(await readFile(path, "utf8")) as JsonObject;

const loadGeneratedLintPlugin = async (): Promise<LintPlugin> => {
  const root = await createTempRoot();
  const pluginPath = join(root, "prism-oxlint-plugin.mjs");
  await writeFile(pluginPath, prismOxlintPluginJs);
  const module = (await import(pathToFileURL(pluginPath).href)) as { default: LintPlugin };
  return module.default;
};

const identifier = (name: string): JsonObject => ({ type: "Identifier", name });
const literal = (value: string): JsonObject => ({ type: "Literal", value });
const memberExpression = (object: JsonObject, property: JsonObject): JsonObject => ({
  type: "MemberExpression",
  object,
  property,
});
const callExpression = (callee: JsonObject, args: JsonObject[]): JsonObject => ({
  type: "CallExpression",
  callee,
  arguments: args,
});
const property = (name: string, value: JsonObject): JsonObject => ({
  type: "Property",
  key: identifier(name),
  value,
});
const objectExpression = (properties: JsonObject[]): JsonObject => ({
  type: "ObjectExpression",
  properties,
});
const schemaStructCall = (): JsonObject =>
  callExpression(memberExpression(identifier("Schema"), identifier("Struct")), [
    objectExpression([]),
  ]);

const runGeneratedRule = async (
  ruleName: string,
  node: JsonObject,
  filename = "agents/builder.agent.ts"
): Promise<JsonObject[]> => {
  const plugin = await loadGeneratedLintPlugin();
  const reports: JsonObject[] = [];
  const visitors = plugin.rules[ruleName]?.create({
    getFilename: () => filename,
    report: (diagnostic) => reports.push(diagnostic),
  });

  visitors?.CallExpression?.(node);
  return reports;
};

const createInstallAllFixture = async (): Promise<{
  monorepoRoot: string;
  projectRoot: string;
  homeRoot: string;
}> => {
  const root = await createTempRoot();
  const monorepoRoot = join(root, "monorepo");
  const projectRoot = join(root, "project-root");
  const homeRoot = join(root, "home");
  const compilePluginRoot = join(monorepoRoot, "trait-orbit-contracts");

  await mkdir(monorepoRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeRoot, { recursive: true });

  await createCanonicalCompileFixture({
    pluginRoot: compilePluginRoot,
    projectRoot,
    withCanonicalToolBindings: false,
  });

  return { monorepoRoot, projectRoot, homeRoot };
};

const createCliMcpFixture = async (options?: {
  readonly harness?: "hermes" | "codex-cli" | "cursor";
  readonly streamableHttp?: boolean;
  readonly port?: number;
}): Promise<{
  pluginRoot: string;
  hermesRoot: string;
  prismHome: string;
}> => {
  const root = await createTempRoot();
  const harness = options?.harness ?? "hermes";
  const pluginRoot = join(root, "cli-hermes-tools");
  const hermesRoot = join(root, "hermes-root");
  const prismHome = join(root, "prism-home");
  await mkdir(hermesRoot, { recursive: true });
  await mkdir(prismHome, { recursive: true });
  await writeFile(join(hermesRoot, "config.yaml"), "existing: true\n");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "cli-hermes-tools",
        version: "0.1.0",
        targets: { tools: [harness] },
        ...(options?.streamableHttp
          ? {
              runtime: {
                mcp: {
                  [harness]: {
                    transport: "streamable-http",
                    host: "127.0.0.1",
                    port: options.port,
                  },
                },
              },
            }
          : {}),
      },
      null,
      2,
    ),
  );
  await mkdir(join(pluginRoot, "tools"), { recursive: true });
  await writeFile(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo through CLI lifecycle.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );
  return { pluginRoot, hermesRoot, prismHome };
};

/** What `prism refresh` produces: the canonical PRISM_HOME union bundle. */
const prebuildCliCanonicalBundle = async (
  pluginRoot: string,
  prismHome: string,
): Promise<void> => {
  const bundle = await generateMcpServerBundle({
    sourcePluginName: "cli-hermes-tools",
    sourcePluginRoot: pluginRoot,
    serverName: "prism-generated-cli-hermes-tools",
    bundleId: "prism-generated-cli-hermes-tools",
    bindings: [
      bindingFromToolSource("cli-hermes-tools", join(pluginRoot, "tools", "echo.tool.ts")),
    ],
  });
  await writePrismMcpServerBundle(prismHome, "cli-hermes-tools", bundle.content);
};

const createCliPackageFixture = async (): Promise<{
  readonly pluginRoot: string;
  readonly outRoot: string;
  readonly prismHome: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "cli-package-plugin");
  const outRoot = join(root, "packaged");
  const prismHome = join(root, "prism-home");

  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "cli-package-plugin",
        version: "0.1.0",
        targets: { hooks: ["codex-cli"] },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginRoot, "hooks", "prompt-context.hook.ts"),
    `import { defineHook, hookEvent } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "prompt-context",
  event: hookEvent.promptSubmit,
  targets: ["codex-cli"],
  handle: (event) => ({
    decision: "continue",
    additionalContext: "cli:" + event.prompt,
  }),
});
`,
  );

  return { pluginRoot, outRoot, prismHome };
};

afterEach(async () => {
  const roots = tempRoots.splice(0);
  await Promise.all(roots.map((root) => cleanupPrismMcpProcessesUnder(root).catch(() => undefined)));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("init --typescript scaffolds OXC configs, scripts, and local plugin", async () => {
  const root = await createTempRoot();

  const result = await runCli(["init", "typed-plugin", "--dir", root, "--typescript"], {});

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(".oxlintrc.json");
  expect(result.stdout).toContain(".oxfmtrc.json");
  expect(result.stdout).toContain("prism-oxlint-plugin.js");

  const pluginRoot = join(root, "typed-plugin");
  const packageJson = await readJson(join(pluginRoot, "package.json"));
  expect(packageJson.scripts).toMatchObject({
    lint: "oxlint .",
    "lint:fix": "oxlint . --fix",
    format: "oxfmt . --write",
    "format:check": "oxfmt . --check",
    typecheck: "tsc --noEmit",
  });
  expect(packageJson.devDependencies).toMatchObject({
    oxlint: "^1.62.0",
    oxfmt: "^0.47.0",
    typescript: "^5.8.3",
  });

  const oxlintConfig = await readJson(join(pluginRoot, ".oxlintrc.json"));
  expect(oxlintConfig.jsPlugins).toEqual([
    {
      name: "prism",
      specifier: "./prism-oxlint-plugin.js",
    },
  ]);
  expect(oxlintConfig.rules).toMatchObject({
    "prism/no-inline-slot-schemas": "error",
    "prism/no-trait-tool-contract-overrides": "error",
  });

  const oxfmtConfig = await readJson(join(pluginRoot, ".oxfmtrc.json"));
  expect(oxfmtConfig.$schema).toBe("./node_modules/oxfmt/configuration_schema.json");

  expect(await pathExists(join(pluginRoot, "README.md"))).toBe(false);
});

test("mcp serve/status/stop manages a Hermes daemon under a sandboxed PRISM_HOME", async () => {
  const { pluginRoot, hermesRoot, prismHome } = await createCliMcpFixture();
  await prebuildCliCanonicalBundle(pluginRoot, prismHome);
  const env = { PRISM_HOME: prismHome };
  const common = [
    pluginRoot,
    "--harness",
    "hermes",
  ];

  const originalConfig = await readFile(join(hermesRoot, "config.yaml"), "utf8").catch(() => "");
  const serve = await runCli(["mcp", "serve", ...common, "--port", "auto"], env);
  try {
    expect(serve.exitCode).toBe(0);
    expect(serve.stdout).toContain("started prism-generated-cli-hermes-tools");

    const status = await runCli(["mcp", "status", ...common], env);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("running");
    expect(status.stdout).toContain("prism-generated-cli-hermes-tools");

    const listStatus = await runCli([
      "mcp",
      "status",
      "--harness",
      "hermes",
    ], env);
    expect(listStatus.exitCode).toBe(0);
    expect(listStatus.stdout).toContain("running");
    expect(listStatus.stdout).toContain("prism-generated-cli-hermes-tools");

    const secondServe = await runCli(["mcp", "serve", ...common, "--port", "auto"], env);
    expect(secondServe.exitCode).toBe(0);
    expect(secondServe.stdout).toContain("already-running prism-generated-cli-hermes-tools");

    const restart = await runCli(["mcp", "restart", ...common, "--port", "auto"], env);
    expect(restart.exitCode).toBe(0);
    expect(restart.stdout).toContain("started prism-generated-cli-hermes-tools");

    const stop = await runCli(["mcp", "stop", ...common], env);
    if (stop.exitCode !== 0) {
      throw new Error(`mcp stop failed\nstdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`);
    }
    expect(stop.stdout).toContain("stopped prism-generated-cli-hermes-tools");

    const stopped = await runCli(["mcp", "status", ...common], env);
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toContain("stopped");
    expect(await readFile(join(hermesRoot, "config.yaml"), "utf8").catch(() => "")).toBe(originalConfig);
  } finally {
    await runCli(["mcp", "stop", ...common], env).catch(() => undefined);
  }
}, 15_000);

test("mcp status accepts supported non-Hermes lifecycle harnesses", async () => {
  const { pluginRoot, prismHome } = await createCliMcpFixture({ harness: "cursor" });

  const status = await runCli([
    "mcp",
    "status",
    pluginRoot,
    "--harness",
    "cursor",
  ], { PRISM_HOME: prismHome });

  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("stopped");
  expect(status.stdout).toContain("prism-generated-cli-hermes-tools");
});

test("refresh compile-only writes Hermes MCP config to an explicit profile root", async () => {
  const { pluginRoot, hermesRoot, prismHome } = await createCliMcpFixture();

  const result = await runCli([
    "refresh",
    "--plugin",
    pluginRoot,
    "--harness",
    "hermes",
    "--compile-only",
    "--compile-root",
    hermesRoot,
  ], { PRISM_HOME: prismHome });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`Root: ${hermesRoot}`);
  const config = await readFile(join(hermesRoot, "config.yaml"), "utf8");
  expect(config).toContain("mcp_servers:");
  expect(config).toContain("prism-generated-cli-hermes-tools:");
  expect(config).toContain('url: "http://127.0.0.1:');
  expect(config).toContain("X-Prism-Mcp-Exposure:");
  expect(config).not.toContain('command: "bun"');
  expect(
    await pathExists(join(prismHome, "runtime", "mcp", "cli-hermes-tools", "server.mjs")),
  ).toBe(true);
  // The bundle never lands inside the harness root.
  expect(await pathExists(join(hermesRoot, "prism", "mcp"))).toBe(false);
});

test("package CLI writes distributable payload", async () => {
  const { pluginRoot, outRoot, prismHome } = await createCliPackageFixture();

  const result = await runCli([
    "package",
    pluginRoot,
    "--harness",
    "codex-cli",
    "--out",
    outRoot,
  ], { PRISM_HOME: prismHome });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Packaging plugin: cli-package-plugin");
  expect(result.stdout).toContain("codex-cli");
  expect(result.stdout).toContain("prism.activation.json");

  const packageRoot = join(outRoot, "codex-cli", "prism-generated-cli-package-plugin");
  expect(await pathExists(join(packageRoot, ".prism-package.json"))).toBe(true);
  expect(await pathExists(join(packageRoot, "payload", "hooks", "prompt-context.mjs"))).toBe(true);

  const activation = await readFile(join(packageRoot, "prism.activation.json"), "utf8");
  expect(activation).toContain("UserPromptSubmit");
  expect(activation).toContain("config.toml");

});

test("refresh serves Hermes HTTP MCP by default", async () => {
  const port = await getFreePort("127.0.0.1");
  const { pluginRoot, hermesRoot } = await createCliMcpFixture({
    streamableHttp: true,
    port,
  });
  const env = {};
  const common = [
    "refresh",
    "--plugin",
    pluginRoot,
    "--harness",
    "hermes",
    "--compile-root",
    hermesRoot,
    "--no-validate",
  ];

  const served = await runCli(common, env);
  try {
    expect(served.exitCode).toBe(0);
    expect(served.stdout).toContain("Compile (hermes, global)");
    const config = await readFile(join(hermesRoot, "config.yaml"), "utf8");
    expect(config).toContain(`url: "http://127.0.0.1:${port}/mcp"`);
  } finally {
    await runCli([
      "mcp",
      "stop",
      pluginRoot,
      "--harness",
      "hermes",
    ], env).catch(() => undefined);
  }
}, 20_000);

test("refresh --plugins compiles Hermes child plugins into an explicit profile root", async () => {
  const { pluginRoot, hermesRoot, prismHome } = await createCliMcpFixture();

  const result = await runCli([
    "refresh",
    "--plugins",
    dirname(pluginRoot),
    "--harness",
    "hermes",
    "--compile-root",
    hermesRoot,
    "--no-validate",
  ], { PRISM_HOME: prismHome });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Compile (hermes, global)");
  expect(result.stdout).toContain(`Root: ${hermesRoot}`);
  expect(result.stdout).toContain("All plugin refreshes completed successfully");
  const config = await readFile(join(hermesRoot, "config.yaml"), "utf8");
  expect(config).toContain("mcp_servers:");
  // Hermes now registers one server per owner plugin, keyed by the plugin's
  // own server key (never the retired aggregated `prism-mcp-shim` key).
  expect(config).toContain("cli-hermes-tools:");
  expect(config).not.toContain("prism-mcp-shim:");
  expect(config).toContain('PRISM_SHIM_PLUGINS: "cli-hermes-tools"');
  expect(config).toContain('PRISM_SHIM_NAMING: "per-plugin"');
  expect(
    await pathExists(join(prismHome, "runtime", "mcp", "cli-hermes-tools", "server.mjs")),
  ).toBe(true);
  expect(await pathExists(join(hermesRoot, "prism", "mcp"))).toBe(false);
});

test("init --with-agent scaffolds TypeScript agent sources, not source markdown agents", async () => {
  const root = await createTempRoot();

  const result = await runCli(["init", "typed-agent", "--dir", root, "--with-agent"], {});

  expect(result.exitCode).toBe(0);

  const pluginRoot = join(root, "typed-agent");
  const agentPath = join(pluginRoot, "agents", "reviewer.agent.ts");
  expect(await pathExists(agentPath)).toBe(true);
  expect(await pathExists(join(pluginRoot, "identities", "reviewer.identity.md"))).toBe(true);
  expect(await pathExists(join(pluginRoot, "agents", "reviewer.md"))).toBe(false);
  const agentSource = await readFile(agentPath, "utf8");
  expect(agentSource).toContain("satisfies AgentSource");
  expect(agentSource).not.toContain("defineAgent");
});

test("validate rejects source markdown agents", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "source-markdown-agent");
  await mkdir(join(pluginRoot, "agents"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "source-markdown-agent",
        version: "0.1.0",
        targets: { agents: ["opencode"] },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginRoot, "agents", "reviewer.md"),
    `---
description: Source markdown agent
---

You are a reviewer.
`,
  );

  const result = await runCli(["validate", pluginRoot], {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Source markdown agents are not supported");
});

test("validate rejects file-level install targets in shared and overlay artifacts", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "file-level-targets");
  await mkdir(join(pluginRoot, "rules", "global"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "testing"), { recursive: true });
  await mkdir(join(pluginRoot, "harness", "opencode", "commands"), { recursive: true });
  await mkdir(join(pluginRoot, "harness", "opencode", "skills", "debugging"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "file-level-targets",
        version: "0.1.0",
        targets: {
          rules: ["opencode"],
          commands: ["opencode"],
          skills: ["opencode"],
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginRoot, "rules", "global", "standards.md"),
    "---\ntargets: [opencode]\n---\n\n# Standards\n",
  );
  await writeFile(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\ntargets: [opencode]\n---\n\n# Testing\n",
  );
  await writeFile(
    join(pluginRoot, "harness", "opencode", "commands", "review.md"),
    "---\ntargets: [opencode]\n---\n\n# Review\n",
  );
  await writeFile(
    join(pluginRoot, "harness", "opencode", "skills", "debugging", "SKILL.md"),
    "---\nname: debugging\ndescription: Debugging guidance\ntargets: [opencode]\n---\n\n# Debugging\n",
  );
  await writeFile(
    join(pluginRoot, "harness", "opencode", "skills", "debugging", "notes.md"),
    "---\ntargets: [opencode]\n---\n\nIgnored support file.\n",
  );

  const result = await runCli(["validate", pluginRoot], {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "File-level install targets are not supported in rules/global/standards.md. Move install scope to plugin.json targets.rules",
  );
  expect(result.stderr).toContain(
    "File-level install targets are not supported in skills/testing/SKILL.md. Move install scope to plugin.json targets.skills",
  );
  expect(result.stderr).toContain(
    "File-level install targets are not supported in harness/opencode/commands/review.md. Move install scope to plugin.json targets.commands",
  );
  expect(result.stderr).toContain(
    "File-level install targets are not supported in harness/opencode/skills/debugging/SKILL.md. Move install scope to plugin.json targets.skills",
  );
  expect(result.stderr).not.toContain("notes.md. Move install scope");
});

test("validate rejects agent targets for harnesses without compile lowerers", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "unsupported-agent-target");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "unsupported-agent-target",
        version: "0.1.0",
        targets: { agents: ["opencode", "cursor"] },
      },
      null,
      2,
    ),
  );

  const result = await runCli(["validate", pluginRoot], {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("targets.agents resolves to unsupported compile harnesses");
});

test("validate summarizes warnings when not verbose", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "skill-warning-summary");
  await mkdir(join(pluginRoot, "skills", "testing"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "skill-warning-summary",
        version: "0.1.0",
        targets: { skills: ["codex-cli"] },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    `---
name: renamed-testing
description: Testing guidance
---

# Testing
`,
  );

  const result = await runCli(["validate", pluginRoot], {});

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("✅ renamed-testing");
  expect(result.stdout).toContain("Plugin is valid (run with --verbose to see warnings)");
  expect(result.stdout).not.toContain(
    "Skill name 'renamed-testing' does not match directory name 'testing'",
  );
});

test("validate --verbose prints warnings", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "skill-warning-verbose");
  await mkdir(join(pluginRoot, "skills", "testing"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "skill-warning-verbose",
        version: "0.1.0",
        targets: { skills: ["codex-cli"] },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    `---
name: renamed-testing
description: Testing guidance
---

# Testing
`,
  );

  const result = await runCli(["validate", pluginRoot, "--verbose"], {});

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("✅ renamed-testing");
  expect(result.stdout).toContain(
    "Skill name 'renamed-testing' does not match directory name 'testing'",
  );
  expect(result.stdout).toContain("✅ Plugin is valid");
  expect(result.stdout).not.toContain("run with --verbose");
});

test("generated Oxlint rule rejects inline Schema slot fills but allows imported schemas", async () => {
  const invalidBinding = callExpression(identifier("bindTrait"), [
    literal("submittable"),
    objectExpression([
      property(
        "tools",
        objectExpression([
          property(
            "submit_work",
            objectExpression([
              property(
                "slots",
                objectExpression([property("builder_report", schemaStructCall())])
              ),
            ])
          ),
        ])
      ),
    ]),
  ]);
  const validBinding = callExpression(identifier("bindTrait"), [
    literal("submittable"),
    objectExpression([
      property(
        "tools",
        objectExpression([
          property(
            "submit_work",
            objectExpression([
              property(
                "slots",
                objectExpression([property("builder_report", identifier("BuilderReport"))])
              ),
            ])
          ),
        ])
      ),
    ]),
  ]);

  await expect(
    runGeneratedRule("no-inline-slot-schemas", invalidBinding)
  ).resolves.toHaveLength(1);
  await expect(
    runGeneratedRule("no-inline-slot-schemas", validBinding)
  ).resolves.toHaveLength(0);
  await expect(
    runGeneratedRule("no-inline-slot-schemas", invalidBinding, "tools/submit_work.tool.ts")
  ).resolves.toHaveLength(0);
});

test("generated Oxlint rule rejects trait-owned slots and tool input/output replacement", async () => {
  const traitDefinition = callExpression(identifier("defineTrait"), [
    objectExpression([
      property("name", literal("submittable")),
      property("slots", objectExpression([property("builder_report", objectExpression([]))])),
      property(
        "tools",
        objectExpression([
          property(
            "submit_work",
            objectExpression([
              property("ref", literal("orbit-core:submit_work")),
              property("input", identifier("WorkSubmissionBase")),
              property("output", identifier("OrbitDispatchReceipt")),
            ])
          ),
        ])
      ),
    ]),
  ]);

  const reports = await runGeneratedRule("no-trait-tool-contract-overrides", traitDefinition);

  expect(reports).toHaveLength(3);
  expect(reports.map((report) => String(report.message))).toEqual([
    expect.stringContaining("root-level slots"),
    expect.stringContaining("input/output replacement"),
    expect.stringContaining("input/output replacement"),
  ]);
});

test("refresh requires --project when project scope is requested", async () => {
  const result = await runCli(
    ["refresh", "--plugin", ".", "--harness", "opencode", "--scope", "project"],
    {}
  );

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Project-local scope requires --project <path>");
});

test("doctor returns usage exit code for invalid invocation", async () => {
  const result = await runCli(
    ["doctor", "--harness", "opencode", "--scope", "project"],
    {}
  );

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Project-local scope requires --project <path>");
});

test("bare doctor defaults to detected-installed harnesses and prints the detection as the first line", async () => {
  const root = await createTempRoot();
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");

  // Only claude-code and codex-cli have a global config root on this fake
  // HOME; every other supported harness's root is absent.
  await mkdir(join(homeRoot, ".claude"), { recursive: true });
  await mkdir(join(homeRoot, ".codex"), { recursive: true });
  await mkdir(prismHome, { recursive: true });

  const result = await runCli(["doctor"], { HOME: homeRoot, PRISM_HOME: prismHome });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.split("\n")[0]).toBe("Detected installed harnesses: claude-code, codex-cli");
});

test("bare refresh/plan default to detected-installed harnesses (fake HOME, matches --harness <detected>)", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "detected-default-plugin");
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");
  const rulePath = join(pluginRoot, "rules", "global", "standards.md");

  // Only opencode's global config root exists, so detection must resolve to
  // exactly ["opencode"] regardless of the other 13 supported harnesses.
  await mkdir(join(pluginRoot, "rules", "global"), { recursive: true });
  await mkdir(join(homeRoot, ".config", "opencode"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      { name: "detected-default-plugin", version: "0.1.0", targets: { rules: ["opencode"] } },
      null,
      2,
    ),
  );
  await writeFile(rulePath, "Always prefer the detected-installed default.\n");

  const env = { HOME: homeRoot, PRISM_HOME: prismHome };
  for (const command of ["refresh", "plan"]) {
    // `plan` has no --dry-run flag (it is always a dry run); `refresh` needs
    // it explicitly so this test never writes into the fake HOME.
    const modeArgs = command === "refresh" ? ["--dry-run"] : [];
    const bare = await runCli([command, "--plugin", pluginRoot, ...modeArgs], env);
    const explicit = await runCli(
      [command, "--plugin", pluginRoot, "--harness", "opencode", ...modeArgs],
      env,
    );

    expect(bare.exitCode).toBe(0);
    expect(explicit.exitCode).toBe(0);
    // The only difference bare-run introduces is the detected-harnesses
    // header as the first printed line — everything after it is byte-identical
    // to the equivalent explicit `--harness <detected list>` run.
    expect(bare.stdout).toBe(`Detected installed harnesses: opencode\n${explicit.stdout}`);
  }
}, 20_000); // 4 CLI spawns (refresh x2, plan x2); default 5s timeout is tight under load.

test("bare invocation fails with a helpful error when no harness is installed (never silent, never --all)", async () => {
  const root = await createTempRoot();
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");

  // Fresh HOME: no supported harness has a config root on disk.
  await mkdir(homeRoot, { recursive: true });
  await mkdir(prismHome, { recursive: true });

  const env = { HOME: homeRoot, PRISM_HOME: prismHome };
  const doctorResult = await runCli(["doctor"], env);

  expect(doctorResult.exitCode).toBe(2);
  expect(doctorResult.stderr).toContain(
    "No installed harnesses detected (checked the global config root for every supported harness).",
  );
  expect(doctorResult.stderr).toContain("Please specify --harness <ids> or --all.");
  // Never a silent no-op and never a silent fall-through to --all: no
  // harness-scoped output should have been produced.
  expect(doctorResult.stdout).toBe("");
});

test("package keeps requiring explicit --harness or --all even when harnesses are installed", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "package-strict-plugin");
  const homeRoot = join(root, "home");

  // A harness root is present (would resolve as a non-empty detected set for
  // refresh/plan/doctor), proving package's carve-out is verb-gated, not a
  // side effect of an empty machine.
  await mkdir(homeRoot, { recursive: true });
  await mkdir(join(homeRoot, ".claude"), { recursive: true });
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({ name: "package-strict-plugin", version: "0.1.0", targets: {} }, null, 2),
  );

  const result = await runCli(["package", pluginRoot], { HOME: homeRoot });

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Please specify --harness <ids> or --all");
  expect(result.stdout).not.toContain("Detected installed harnesses");
});

test("commands return usage exit code for invalid scope values", async () => {
  const result = await runCli(
    ["plan", "--plugin", ".", "--harness", "opencode", "--scope", "banana"],
    {},
  );

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Invalid scope 'banana'");
});

test("refresh compiles Antigravity rules into a generated plugin bundle", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "antigravity-rules-plugin");
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");
  const rulePath = join(pluginRoot, "rules", "global", "standards.md");

  await mkdir(join(pluginRoot, "rules", "global"), { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "antigravity-rules-plugin",
        version: "0.1.0",
        targets: { rules: ["antigravity-cli"] },
      },
      null,
      2,
    ),
  );
  await writeFile(rulePath, "Always prefer managed Antigravity plugin rules.\n");

  const result = await runCli(
    ["refresh", "--plugin", pluginRoot, "--harness", "antigravity-cli", "--dry-run"],
    { HOME: homeRoot, PRISM_HOME: prismHome },
  );

  const generatedPluginRoot = join(
    homeRoot,
    ".gemini",
    "antigravity-cli",
    "plugins",
    "prism-generated-antigravity-rules-plugin",
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Compile (antigravity-cli, global)");
  expect(result.stdout).toContain(join(generatedPluginRoot, "rules", "context.md"));
  expect(result.stdout).toContain(join(generatedPluginRoot, "plugin.json"));
  expect(result.stdout).not.toContain(
    join(homeRoot, ".gemini", "antigravity-cli", "rules", "standards.md"),
  );
});

test("refresh CLI stores managed backups under Prism home", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "managed-rules-plugin");
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");
  const rulePath = join(pluginRoot, "rules", "global", "standards.md");
  const opencodeRulesPath = join(homeRoot, ".config", "opencode", "AGENTS.md");

  await mkdir(join(pluginRoot, "rules", "global"), { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "managed-rules-plugin",
        version: "0.1.0",
        targets: { rules: ["opencode"] },
      },
      null,
      2,
    ),
  );
  await writeFile(rulePath, "First managed rule.\n");

  const env = { HOME: homeRoot, PRISM_HOME: prismHome };
  const first = await runCli(["refresh", "--plugin", pluginRoot, "--harness", "opencode"], env);
  expect(first.exitCode).toBe(0);

  await writeFile(rulePath, "Second managed rule.\n");
  const second = await runCli(["refresh", "--plugin", pluginRoot, "--harness", "opencode"], env);

  expect(second.exitCode).toBe(0);
  expect(second.stdout).toContain("Backups created");
  expect(second.stdout).toContain(join(prismHome, "backups"));
  expect(second.stdout).not.toContain(".bak");
  expect(await pathExists(`${opencodeRulesPath}.bak`)).toBe(false);
  expect(await readFile(opencodeRulesPath, "utf8")).toContain("Second managed rule.");
});

test("refresh dry-run reports unmanaged target blocked reasons", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "managed-command-plugin");
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");
  const commandTarget = join(homeRoot, ".config", "opencode", "commands", "review.md");

  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await mkdir(join(homeRoot, ".config", "opencode", "commands"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "managed-command-plugin",
        version: "0.1.0",
        targets: { commands: ["opencode"] },
      },
      null,
      2,
    ),
  );
  await writeFile(join(pluginRoot, "commands", "review.md"), "Managed review command.\n");
  await writeFile(commandTarget, "User-owned review command.\n");

  const result = await runCli(
    ["refresh", "--plugin", pluginRoot, "--harness", "opencode", "--dry-run"],
    { HOME: homeRoot, PRISM_HOME: prismHome },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("blocked");
  expect(result.stdout).toContain("a file Prism has never managed already exists");
});

test("refresh dry-run compiles targeted plugin with project scope", async () => {
  const { monorepoRoot, projectRoot, homeRoot } = await createInstallAllFixture();
  const pluginRoot = join(monorepoRoot, "trait-orbit-contracts");

  const result = await runCli(
    [
      "refresh",
      "--plugin",
      pluginRoot,
      "--harness",
      "opencode",
      "--scope",
      "project",
      "--project",
      projectRoot,
      "--dry-run",
    ],
    { HOME: homeRoot }
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Planning plugin: canonical-compile-fixture");
  expect(result.stdout).toContain("Matching requested harnesses: opencode");
  expect(result.stdout).toContain("Compile output scope: project");
  expect(result.stdout).toContain("Compile (opencode, project)");
  expect(result.stdout).toContain("Refresh plan");
  expect(
    await pathExists(join(projectRoot, ".opencode", "agents", "builder.md"))
  ).toBe(false);
});

test("plan --json prints a parseable machine-readable envelope", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "json-plan-plugin");
  const projectRoot = join(root, "project-root");
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");

  await createCanonicalCompileFixture({
    pluginRoot,
    projectRoot,
    withCanonicalToolBindings: false,
  });

  const result = await runCli(
    [
      "plan",
      "--plugin",
      pluginRoot,
      "--harness",
      "opencode",
      "--scope",
      "project",
      "--project",
      projectRoot,
      "--json",
    ],
    { HOME: homeRoot, PRISM_HOME: prismHome },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout) as JsonObject;
  expect(parsed.schema).toBe("prism.plan.v1");
  expect(parsed.mode).toBe("plan");
  expect(result.stdout).not.toContain("Compile (");
  expect(result.stdout).not.toContain("Plan completed");
});

test("refresh dry-run compiles Claude command-only plugins into skills-dir plugin bundles", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "claude-command-plugin");
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");

  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "claude-command-plugin",
        version: "0.1.0",
        targets: { commands: ["claude-code"] },
      },
      null,
      2,
    ),
  );
  await writeFile(join(pluginRoot, "commands", "review.md"), "# Review\n\nReview the change.\n");

  const result = await runCli(
    ["refresh", "--plugin", pluginRoot, "--harness", "claude-code", "--dry-run"],
    { HOME: homeRoot, PRISM_HOME: prismHome },
  );

  const generatedCommandPath = join(
    homeRoot,
    ".claude",
    "skills",
    "prism-generated-claude-command-plugin",
    "commands",
    "review.md",
  );
  const directCommandPath = join(homeRoot, ".claude", "commands", "review.md");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Compile (claude-code, global)");
  expect(result.stdout).toContain(generatedCommandPath);
  expect(result.stdout).not.toContain(directCommandPath);
  expect(await pathExists(generatedCommandPath)).toBe(false);
  expect(await pathExists(directCommandPath)).toBe(false);
});

test("refresh --plugins requires --project when project scope is requested", async () => {
  const { monorepoRoot, homeRoot } = await createInstallAllFixture();

  const result = await runCli(
    ["refresh", "--plugins", monorepoRoot, "--harness", "opencode", "--scope", "project"],
    { HOME: homeRoot }
  );

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Project-local scope requires --project <path>");
});

test("refresh --plugins compiles discovered child plugins with project scope", async () => {
  const { monorepoRoot, projectRoot, homeRoot } = await createInstallAllFixture();

  const result = await runCli(
    [
      "refresh",
      "--plugins",
      monorepoRoot,
      "--harness",
      "opencode,claude-code",
      "--scope",
      "project",
      "--project",
      projectRoot,

    ],
    { HOME: homeRoot }
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    "Manifest targets: agents=[opencode, claude-code]; orbits=[opencode, claude-code]; tools=[opencode, claude-code]; toolspaces=[opencode, claude-code]; modelspaces=[opencode, claude-code]"
  );
  expect(result.stdout).toContain("Matching requested harnesses: opencode, claude-code");
  expect(result.stdout).toContain("Compile output scope: project");
  expect(result.stdout).toContain("Compile (opencode, project)");
  expect(result.stdout).toContain("Compile (claude-code, project)");
  expect(result.stdout).toContain("All plugin refreshes completed successfully");

  expect(
    await pathExists(join(projectRoot, ".opencode", "agents", "builder.md"))
  ).toBe(true);
  expect(
    await pathExists(join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"))
  ).toBe(true);
  expect(
    await pathExists(
      join(
        projectRoot,
        ".claude",
        "skills",
        "prism-generated-canonical-compile-fixture",
        "agents",
        "builder.md",
      ),
    )
  ).toBe(true);
  expect(
    await pathExists(
      join(
        projectRoot,
        ".claude",
        "skills",
        "prism-generated-canonical-compile-fixture",
        "skills",
        "delivery-contract",
        "SKILL.md",
      ),
    )
  ).toBe(true);
  expect(
    await pathExists(join(homeRoot, ".config", "opencode", "agents", "builder.md"))
  ).toBe(false);
  expect(
    await pathExists(
      join(homeRoot, ".claude", "skills", "prism-generated-canonical-compile-fixture", "agents", "builder.md"),
    )
  ).toBe(false);
});

test("refresh --plugins emits workflow refs once after directory compile", async () => {
  const { monorepoRoot, projectRoot, homeRoot } = await createInstallAllFixture();
  const args = [
    "refresh",
    "--plugins",
    monorepoRoot,
    "--harness",
    "opencode,claude-code",
    "--scope",
    "project",
    "--project",
    projectRoot,
  ];

  const first = await runCli(args, { HOME: homeRoot });

  expect(first.exitCode).toBe(0);
  expect(first.stdout.match(/Workflow refs/g)?.length).toBe(1);
  expect(first.stdout.match(/generated\/agents\.ts/g)?.length).toBe(1);

  const second = await runCli(args, { HOME: homeRoot });

  expect(second.exitCode).toBe(0);
  expect(second.stdout.match(/Workflow refs/g)?.length).toBe(1);
  expect(second.stdout.match(/generated\/agents\.ts/g)?.length).toBe(1);
  expect(second.stdout).toContain("skip");
  expect(second.stdout).not.toContain("repair");
}, 30_000);

test("refresh --plugins skips skill validation when skills are not targeted", async () => {
  const { monorepoRoot, projectRoot, homeRoot } = await createInstallAllFixture();

  await mkdir(
    join(monorepoRoot, "trait-orbit-contracts", "skills", "leaf-agent-protocol"),
    { recursive: true }
  );

  const result = await runCli(
    [
      "refresh",
      "--plugins",
      monorepoRoot,
      "--harness",
      "opencode",
      "--scope",
      "project",
      "--project",
      projectRoot,

    ],
    { HOME: homeRoot }
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain("Validation failed");
  expect(result.stdout).toContain("All plugin refreshes completed successfully");
});
