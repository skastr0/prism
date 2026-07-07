#!/usr/bin/env bun
/**
 * prism CLI - Unified plugin distribution for AI coding harnesses
 */

import { Command, CommanderError, InvalidArgumentError, Option as CommanderOption } from "commander";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import {
  getAllHarnessIds,
  getHarness,
  isValidHarnessId,
  resolveHarnessRoot,
} from "./harnesses.js";
import {
  formatManifestTargets,
  manifestHasCompileTargets,
  readManifest,
  validatePluginSkills,
  validatePluginAgents,
  manifestTargetsHarness,
  manifestTargetsArtifact,
} from "./manifest.js";
import {
  describePrismCause,
  PluginManifestError,
  renderPrismCause,
  renderPrismError,
} from "./errors.js";
import { EXIT_CODES, exitWith, type ExitCode } from "./exit.js";
import { ensureDir, exists, expandPath } from "./fs.js";
import { HARNESS_SCOPES } from "./types.js";
import type {
  HarnessId,
  HarnessScope,
  PluginManifest,
} from "./types.js";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import {
  compilePluginForTarget,
  formatOperations,
  syncWorkflowRefsForProject,
  type CompileResult,
  type CompileMcpLifecycleMode,
} from "./compile/pipeline.js";
import { cleanCache, getCacheDir } from "./compile/cache.js";
import { topologicallySortedPlugins } from "./plugin-order.js";
import { createPluginScaffold } from "./plugin-scaffold.js";
import {
  formatMcpStatus,
  getMcpStatus,
  listMcpStatuses,
  type McpLifecycleHarness,
} from "./mcp/lifecycle.js";
import { prismWorkflowsSourceDir, resolvePrismHome } from "./prism-home.js";
import { discoverPluginPaths } from "./plugin-inventory.js";
import {
  formatPackageOperations,
  packagePluginForTarget,
} from "./packager.js";
import {
  formatRefreshRootPlan,
  refreshPlanJsonEnvelope,
  refreshPlugin,
  type RefreshResult,
} from "./refresh.js";
import type { SyncReport } from "./sync/apply.js";
import { blockedTargetErrors } from "./sync/run.js";
import { doctorExitCode, formatDoctorReport, runDoctor } from "./doctor.js";
import { loadWorkflowFile, renderWorkflowModelResolutionTable, validateWorkflowFile } from "./workflow-loader.js";
import { runWorkflowTypecheck } from "./workflow-typecheck.js";
import { runWorkflow } from "./workflow-runner.js";
import { defaultWorkflowStorePath, isWorkflowRunOutcomeSuccessful, WorkflowStore, type WorkflowRunCompactSummary } from "./workflow-store.js";
import {
  buildWorkflowCatalog,
  pickDefaultAgent,
  pickDefaultWorkers,
  renderCatalogHuman,
  renderRefsStatus,
  scaffoldWorkflowSource,
  workflowRefsStatus,
} from "./workflow-catalog.js";
import { runWorkflowMonitor } from "./workflow-tui.js";
import { runPluginsTui } from "./plugins-tui/index.js";
import { createWorkflowWorkerExecutor, getWorkflowWorkerAdapter } from "./workflow-workers.js";
import { isWorkflowPermissionMode, WORKFLOW_PERMISSION_MODES } from "./workflow-permissions.js";
import {
  requestWorkflowRunnerTermination,
  startDetachedWorkflowRun,
  updateDetachedWorkflowRun,
  workflowRunOptionsSnapshot,
} from "./workflow-controls.js";
import type { WorkflowPermissionMode } from "./workflows.js";

declare const APP_VERSION: string | undefined;

const program = new Command();
const prismVersion =
  typeof APP_VERSION === "string" && APP_VERSION.length > 0
    ? APP_VERSION
    : "0.0.0-dev";

program
  .name("prism")
  .description("Unified plugin distribution for AI coding harnesses")
  .version(prismVersion);

program
  .command("__mcp-server <bundle-path>", { hidden: true })
  .description("Internal Prism MCP server launcher")
  .action(async (bundlePath: string) => {
    await import(pathToFileURL(resolve(bundlePath)).href);
  });

class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

function withoutOrdinal<T extends { readonly ordinal?: number | undefined }>(record: T): Omit<T, "ordinal"> {
  const { ordinal: _, ...rest } = record;
  return rest;
}

// Refresh command
program
  .command("refresh [plugin-path]")
  .description("Converge a plugin's targeted harness outputs")
  .option("--plugin <path>", "Plugin path to refresh")
  .option("--plugins <directory>", "Directory of child plugins to refresh (shallow scan)")
  .option("--harness <harnesses>", "Comma-separated list of harness IDs")
  .option("--all", "Refresh all supported harnesses")
  .option("-p, --project <path>", "Project path for project-specific rules")
  .option(
    "--scope <scope>",
    `Compile output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global"
  )
  .option("--overwrite", "Overwrite existing files", false)
  .option("--no-validate", "Skip plugin validation before refresh")
  .option("--dry-run", "Preview the refresh plan without writing", false)
  .option("--compile-only", "Only run compile-phase lowering")
  .option("--clean", "Clear compile cache before compiling", false)
  .option("--compile-root <path>", "Override compile output root")
  .option(
    "--mcp-lifecycle <mode>",
    "Generated HTTP MCP lifecycle behavior during compile (none|verify|serve)",
    parseMcpLifecycleMode,
    "serve"
  )
  .action(async (pluginPath: string | undefined, options) => {
    try {
      await runRefreshCommand("refresh", pluginPath, options);
    } catch (error) {
      printCliError(error, "Error");
      exitWith(exitCodeForCliError(error, EXIT_CODES.domainFailure));
    }
  });

// Plan command
program
  .command("plan [plugin-path]")
  .description("Preview Prism refresh changes without writing")
  .option("--plugin <path>", "Plugin path to plan")
  .option("--plugins <directory>", "Directory of child plugins to plan (shallow scan)")
  .option("--harness <harnesses>", "Comma-separated list of harness IDs")
  .option("--all", "Plan all supported harnesses")
  .option("-p, --project <path>", "Project path for project-specific rules")
  .option(
    "--scope <scope>",
    `Compile output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global"
  )
  .option("--overwrite", "Overwrite existing files", false)
  .option("--no-validate", "Skip plugin validation before planning")
  .option("--compile-only", "Only plan compile-phase lowering")
  .option("--clean", "Plan compile cache cleanup")
  .option("--compile-root <path>", "Override compile output root")
  .option("--json", "Print a machine-readable JSON envelope", false)
  .option(
    "--mcp-lifecycle <mode>",
    "Generated HTTP MCP lifecycle behavior during compile (none|verify|serve)",
    parseMcpLifecycleMode,
    "serve"
  )
  .action(async (pluginPath: string | undefined, options) => {
    try {
      await runRefreshCommand("plan", pluginPath, options);
    } catch (error) {
      printCliError(error, "Error");
      exitWith(exitCodeForCliError(error, EXIT_CODES.domainFailure));
    }
  });

const workflow = program
  .command("workflow")
  .description("Validate Prism workflow files");

const parseIntegerAtLeast = (value: string, minimum: number, message: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new InvalidArgumentError(message);
  }
  return parsed;
};

const parsePositiveInteger = (value: string): number =>
  parseIntegerAtLeast(value, 1, "must be a positive integer");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Await full delivery to stdout before the action resolves, so large output
// (e.g. `workflow catalog --json`) is not truncated at the pipe buffer on exit.
const writeStdout = (text: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });

const defaultWorkflowStorePathForCwd = (): string =>
  defaultWorkflowStorePath(resolvePrismHome(), process.cwd());

workflow
  .command("typecheck <file>")
  .description("Typecheck a workflow module with Prism's generated tsconfig and shipped declarations")
  .action(async (file: string) => {
    try {
      const result = await runWorkflowTypecheck(file);
      await writeStdout(`Workflow typecheck passed: ${result.filePath}\nTsconfig: ${result.tsconfigPath}\n`);
    } catch (error) {
      printCliError(error, "Workflow typecheck failed");
      exitWith(EXIT_CODES.domainFailure);
    }
  });

workflow
  .command("validate <file>")
  .description("Load a workflow module, resolve each task's (worker, model), and print its typed task summary")
  .option("--table", "Print a human-readable worker->model resolution table instead of JSON")
  .action(async (file: string, options: { readonly table?: boolean }) => {
    try {
      const summary = await validateWorkflowFile(file);
      if (options.table === true) {
        await writeStdout(`${renderWorkflowModelResolutionTable(summary.modelResolution)}\n`);
      } else {
        console.log(JSON.stringify(summary, null, 2));
      }
    } catch (error) {
      printCliError(error, "Workflow validation failed");
      exitWith(EXIT_CODES.domainFailure);
    }
  });

workflow
  .command("catalog")
  .description("List orbits, agents, and model profiles compiled for this project (workflow authoring discovery)")
  .option("--json", "Emit machine-readable JSON")
  .option("--orbit <name>", "Filter to one orbit/namespace")
  .action(async (options: { readonly json?: boolean; readonly orbit?: string }) => {
    try {
      const result = await buildWorkflowCatalog();
      const output = options.json === true
        ? JSON.stringify({ surfaceDir: result.surfaceDir, present: result.present, ...(result.catalog ?? {}) }, null, 2)
        : renderCatalogHuman(result, options.orbit);
      await writeStdout(`${output}\n`);
    } catch (error) {
      printCliError(error, "Workflow catalog failed");
      exitWith(EXIT_CODES.domainFailure);
    }
  });

workflow
  .command("refs")
  .description("Show the generated workflow refs surface for this project and its freshness")
  .option("--json", "Emit machine-readable JSON")
  .action(async (options: { readonly json?: boolean }) => {
    try {
      const status = workflowRefsStatus();
      await writeStdout(`${options.json === true ? JSON.stringify(status, null, 2) : renderRefsStatus(status)}\n`);
    } catch (error) {
      printCliError(error, "Workflow refs failed");
      exitWith(EXIT_CODES.domainFailure);
    }
  });

workflow
  .command("scaffold <name>")
  .description("Write a validating starter workflow that uses a real discovered agent ref")
  .option("--print", "Print to stdout instead of writing a file")
  .option(
    "--out <path>",
    "Output path (default: ~/.prism/workflows/<name>.workflow.ts — never the project repo; workflows reference their target repo by absolute path and are never git-added)",
  )
  .action(async (name: string, options: { readonly print?: boolean; readonly out?: string }) => {
    try {
      const result = await buildWorkflowCatalog();
      if (result.catalog === null) {
        printCliError(
          new Error(`no compiled surface at ${result.surfaceDir} — run \`prism refresh <plugin-path>\` first`),
          "Workflow scaffold failed",
        );
        exitWith(EXIT_CODES.domainFailure);
        return;
      }
      const agent = pickDefaultAgent(result.catalog);
      const agentRef = agent?.ref ?? "agents.forge.explorer";
      const workers = pickDefaultWorkers(result.catalog, agent);
      const source = scaffoldWorkflowSource(name, agentRef, workers);
      if (options.print === true) {
        await writeStdout(source);
        return;
      }
      const outPath = options.out ?? join(prismWorkflowsSourceDir(resolvePrismHome()), `${name}.workflow.ts`);
      await ensureDir(dirname(outPath));
      await writeFile(outPath, source, "utf8");
      await writeStdout(
        `Wrote ${outPath} (agent: ${agentRef}; workers: ${workers.join(", ")}).\nNext: prism workflow validate ${outPath}\n`,
      );
    } catch (error) {
      printCliError(error, "Workflow scaffold failed");
      exitWith(EXIT_CODES.domainFailure);
    }
  });

workflow
  .command("monitor [workflow-file]")
  .description("Open the workflow run monitor TUI for the current project store")
  .option("--store <path>", "SQLite workflow store path")
  .option("--poll-ms <ms>", "Auto-refresh interval", parsePositiveInteger, 500)
  .option("--fail-stale-after-ms <ms>", "Mark running workflow runs older than this many milliseconds as failed while monitoring", parsePositiveInteger)
  .action(async (_workflowFile: string | undefined, options: {
    readonly store?: string;
    readonly pollMs: number;
    readonly failStaleAfterMs?: number;
  }) => {
    try {
      await runWorkflowMonitor({
        storePath: options.store ?? defaultWorkflowStorePathForCwd(),
        pollMs: options.pollMs,
        ...(options.failStaleAfterMs !== undefined ? { failStaleAfterMs: options.failStaleAfterMs } : {}),
      });
    } catch (error) {
      printCliError(error, "Workflow monitor failed");
      exitWith(EXIT_CODES.domainFailure);
    }
  });

// Plugins TUI — plugin manager + install inspector for a folder of plugins
program
  .command("plugins [dir]")
  .description("Open the plugin manager / install-inspector TUI for a folder of plugins")
  .option("-p, --project <path>", "Project path for project-scoped install state")
  .option("--poll-ms <ms>", "MCP status poll interval", parsePositiveInteger, 2000)
  .action(async (dir: string | undefined, options: { readonly project?: string; readonly pollMs: number }) => {
    try {
      await runPluginsTui({
        dir: dir ?? process.cwd(),
        ...(options.project ? { projectPath: options.project } : {}),
        pollMs: options.pollMs,
      });
    } catch (error) {
      printCliError(error, "Plugins TUI failed");
      exitWith(EXIT_CODES.domainFailure);
    }
  });

workflow
  .command("run <file>")
  .description("Run a workflow through the configured worker, or with mock outputs when provided")
  .option("--mock-output <path>", "JSON object keyed by workflow task id")
  .option("--worker <worker>", "Fallback worker for tasks without task-level worker selection")
  .option("--model <model>", "Fallback model for tasks without task-level model selection")
  .option("--permission <mode>", "Fallback permission mode for tasks without task-level permission (legacy|permissive|restricted|interactive|sandbox-read-only|sandbox-workspace-write|full-access)")
  .option("--max-concurrent-tasks <count>", "Maximum concurrent workflow task executions", parsePositiveInteger)
  .option("--task-timeout-ms <ms>", "Default per-task process timeout in milliseconds", parsePositiveInteger)
  .option("--store <path>", "SQLite workflow store path")
  .option("--detach", "Start the workflow in a detached background process and return its run id")
  .addOption(new CommanderOption("--run-id <id>").hideHelp())
  .addOption(new CommanderOption("--run-token <token>").hideHelp())
  .option("--no-cache", "Disable workflow task cache lookup and writes")
  .action(async (file: string, options: {
    readonly mockOutput?: string;
    readonly worker?: string;
    readonly model?: string;
    readonly permission?: string;
    readonly maxConcurrentTasks?: number;
    readonly taskTimeoutMs?: number;
    readonly store?: string;
    readonly detach?: boolean;
    readonly runId?: string;
    readonly runToken?: string;
    readonly cache?: boolean;
  }) => {
    let store: WorkflowStore | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let executionRunId: string | undefined;
    let terminationController: AbortController | undefined;
    let terminationHandler: (() => void) | undefined;
    try {
      // Typecheck gating for detached runs: the user-facing foreground command
      // is the typecheck moat. The detached background child is spawned by
      // Prism from already-vetted source, so it skips the (non-trivial)
      // in-process typecheck to avoid paying cold-start cost on every restart.
      // The `run --detach` spawning parent also skips it so the detach handoff
      // returns promptly; structural loading still runs either way.
      const isDetachSpawnParent = options.detach === true && options.runId === undefined;
      const isDetachedChild = process.env.PRISM_WORKFLOW_DETACHED_CHILD === "1";
      const workflow = await loadWorkflowFile(file, {
        skipTypecheck: isDetachSpawnParent || isDetachedChild,
      });
      const storePath = expandPath(options.store ?? defaultWorkflowStorePathForCwd());
      if (options.detach === true) {
        if (options.runId !== undefined || options.runToken !== undefined) {
          throw new CliUsageError("--run-id and --run-token are reserved for Prism's internal detached runner");
        }
        if (options.mockOutput === undefined && options.worker !== undefined) {
          getWorkflowWorkerAdapter(options.worker);
        }
        store = await WorkflowStore.open(storePath);
        const runId = store.createRun(workflow.name, randomUUID());
        const token = randomUUID();
        store.recordRunSnapshot({
          runId,
          workflowFile: expandPath(file),
          options: workflowRunOptionsSnapshot(options),
        });
        store.setRunHandoffToken(runId, token);
        store.close();
        store = undefined;
        startDetachedWorkflowRun(file, { ...options, permission: options.permission }, { runId, storePath, token });
        console.log(JSON.stringify({ runId, workflow: workflow.name, status: "running", detached: true }, null, 2));
        return;
      }
      if (
        options.runId !== undefined &&
        (process.env.PRISM_WORKFLOW_DETACHED_CHILD !== "1" || process.env.PRISM_WORKFLOW_DETACHED_RUN_ID !== options.runId)
      ) {
        throw new CliUsageError("--run-id is reserved for Prism's internal detached runner");
      }
      store = await WorkflowStore.open(storePath);
      if (options.runId !== undefined) {
        if (options.runToken === undefined || !store.consumeRunHandoffToken(options.runId, options.runToken)) {
          throw new CliUsageError("invalid detached workflow run handoff");
        }
        executionRunId = options.runId;
      } else {
        executionRunId = store.createRun(workflow.name);
      }
      store.recordRunSnapshot({
        runId: executionRunId,
        workflowFile: expandPath(file),
        options: workflowRunOptionsSnapshot(options),
      });
      terminationController = new AbortController();
      terminationHandler = () => {
        terminationController?.abort();
        if (store !== undefined && executionRunId !== undefined) {
          store.recordEvent({
            runId: executionRunId,
            type: "runner.termination_signal.received",
            payload: { signal: "SIGTERM" },
          });
        }
      };
      process.once("SIGTERM", terminationHandler);
      store.markRunRunnerStarted(executionRunId, process.pid);
      heartbeat = setInterval(() => store?.heartbeatRun(executionRunId!), 2_000);
      const outputs = options.mockOutput
        ? JSON.parse(await readFile(expandPath(options.mockOutput), "utf8")) as Record<string, unknown>
        : null;
      const parsedPermission = options.permission !== undefined
        ? parseWorkflowPermissionMode(options.permission)
        : undefined;
      const workerExecutor = outputs === null
        ? createWorkflowWorkerExecutor({ worker: options.worker, cwd: process.cwd(), model: options.model, fallbackPermission: parsedPermission, taskTimeoutMs: options.taskTimeoutMs })
        : null;
      const result = await runWorkflow(workflow, {
        store,
        cache: options.cache !== false,
        mockOutput: outputs !== null,
        maxConcurrentTasks: options.maxConcurrentTasks,
        runId: executionRunId,
        abortSignal: terminationController.signal,
        runtimeOptions: {
          fallbackWorker: options.worker,
          fallbackModel: options.model,
          fallbackPermission: parsedPermission,
        },
        executeTask: async (task, context) => {
          if (outputs === null) return workerExecutor!(task, context);
          if (!Object.prototype.hasOwnProperty.call(outputs, task.id)) {
            throw new Error(`missing mock output for workflow task ${task.id}`);
          }
          return outputs[task.id];
        },
      });
      console.log(JSON.stringify(result, null, 2));
      // A run can complete (the author program itself succeeded, e.g. by isolating a task
      // failure via Effect.either) while still carrying a failed/escalated task — that is not
      // a caller-visible success. Map the persisted terminal status to the process exit code
      // so a caller's `$?` reflects the real outcome instead of always reading 0.
      const finalRunStatus = store.getRun(executionRunId!)?.status ?? "unknown";
      if (!isWorkflowRunOutcomeSuccessful(finalRunStatus, result.tasks.map((task) => task.status))) {
        exitWith(EXIT_CODES.domainFailure);
      }
    } catch (error) {
      if (store !== undefined && executionRunId !== undefined && store.getRun(executionRunId)?.status === "running") {
        store.finishRun(executionRunId, "failed");
      }
      printCliError(error, "Workflow run failed");
      exitWith(EXIT_CODES.domainFailure);
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (terminationHandler !== undefined) process.off("SIGTERM", terminationHandler);
      store?.close();
    }
  });

const workflowRuns = workflow
  .command("runs")
  .description("Inspect persisted workflow run history");

const workflowCache = workflow
  .command("cache")
  .description("Inspect persisted workflow task cache entries");

const formatWorkflowDuration = (durationMs: number | null): string =>
  durationMs === null ? "n/a" : `${durationMs}ms`;

const formatWorkflowSummaryValue = (value: string | null | undefined): string =>
  value === null || value === undefined || value.length === 0 ? "n/a" : value;

const formatWorkflowEvidenceSource = (source: WorkflowRunCompactSummary["tasks"][number]["evidenceSource"]): string => {
  switch (source) {
    case "this-run":
      return "this run";
    case "prior-cache-record":
      return "prior cache record";
    case "run-events":
      return "run events";
    case "unknown":
      return "unknown";
  }
};

const formatWorkflowRunCompactSummary = (summary: WorkflowRunCompactSummary): string => {
  const lines = [
    `Workflow run ${summary.run.runId} (${summary.run.workflow})`,
    summary.disclaimer,
    `Status: ${summary.totals.status}`,
    `Duration: ${formatWorkflowDuration(summary.totals.durationMs)}`,
    `Tasks: total ${summary.totals.totalTasks}, fresh executions ${summary.totals.freshExecutions}, cache hits ${summary.totals.cacheHits}, repairs ${summary.totals.repairs}`,
  ];
  for (const task of summary.tasks) {
    const details = [
      task.status,
      task.execution,
      `source ${formatWorkflowEvidenceSource(task.evidenceSource)}`,
      `adapter ${formatWorkflowSummaryValue(task.workerAdapter)}`,
      `model ${formatWorkflowSummaryValue(task.model)}`,
      `native agent ${formatWorkflowSummaryValue(task.nativeAgent)}`,
      `repairs ${task.repairCount}`,
      `duration ${formatWorkflowDuration(task.durationMs)}`,
    ];
    if (task.externalSessionPointer !== null) {
      details.push(`external session ${task.externalSessionPointer}`);
    }
    lines.push(`- ${task.taskId}: ${details.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
};

workflowCache
  .command("list")
  .description("List completed workflow task cache entries")
  .option("--store <path>", "SQLite workflow store path")
  .option("--workflow <name>", "Filter cache entries by workflow name")
  .option("--task-id <id>", "Filter cache entries by task id")
  .option("--cache-key <key>", "Filter cache entries by task cache key")
  .option("--prompt-hash <hash>", "Filter cache entries by prompt hash")
  .option("--agent-manifest-hash <hash>", "Filter cache entries by agent manifest hash")
  .option("--limit <n>", "Maximum number of cache entries to return", parsePositiveInteger)
  .action(async (options: {
    readonly store?: string;
    readonly workflow?: string;
    readonly taskId?: string;
    readonly cacheKey?: string;
    readonly promptHash?: string;
    readonly agentManifestHash?: string;
    readonly limit?: number;
  }) => {
    let store: WorkflowStore | undefined;
    try {
      store = await WorkflowStore.open(expandPath(options.store ?? defaultWorkflowStorePathForCwd()));
      const entries = store.listCompletedCache({
        workflow: options.workflow,
        taskId: options.taskId,
        cacheKey: options.cacheKey,
        promptHash: options.promptHash,
        agentManifestHash: options.agentManifestHash,
      })
        .slice(0, options.limit);
      console.log(JSON.stringify({ entries }, null, 2));
    } catch (error) {
      printCliError(error, "Workflow cache list failed");
      exitWith(EXIT_CODES.domainFailure);
    } finally {
      store?.close();
    }
  });

workflowCache
  .command("show")
  .description("Show one completed workflow task cache entry")
  .requiredOption("--workflow <name>", "Workflow name")
  .requiredOption("--cache-key <key>", "Task cache key")
  .option("--store <path>", "SQLite workflow store path")
  .option("--task-id <id>", "Filter cache entries by task id")
  .option("--prompt-hash <hash>", "Filter cache entries by prompt hash")
  .option("--agent-manifest-hash <hash>", "Filter cache entries by agent manifest hash")
  .action(async (options: {
    readonly store?: string;
    readonly workflow: string;
    readonly taskId?: string;
    readonly cacheKey: string;
    readonly promptHash?: string;
    readonly agentManifestHash?: string;
  }) => {
    let store: WorkflowStore | undefined;
    try {
      store = await WorkflowStore.open(expandPath(options.store ?? defaultWorkflowStorePathForCwd()));
      const entries = store.listCompletedCache({
        workflow: options.workflow,
        taskId: options.taskId,
        cacheKey: options.cacheKey,
        promptHash: options.promptHash,
        agentManifestHash: options.agentManifestHash,
      });
      if (entries.length !== 1) {
        throw new Error(`workflow cache show expected exactly one entry, found ${entries.length}`);
      }
      console.log(JSON.stringify({ entry: entries[0] }, null, 2));
    } catch (error) {
      printCliError(error, "Workflow cache show failed");
      exitWith(EXIT_CODES.domainFailure);
    } finally {
      store?.close();
    }
  });

workflowRuns
  .command("list")
  .description("List workflow runs from the SQLite workflow store")
  .option("--store <path>", "SQLite workflow store path")
  .option("--limit <n>", "Maximum number of runs to return", parsePositiveInteger)
  .option("--fail-stale-after-ms <ms>", "Mark running workflow runs older than this many milliseconds as failed before listing")
  .action(async (options: { readonly store?: string; readonly limit?: number; readonly failStaleAfterMs?: string }) => {
    let store: WorkflowStore | undefined;
    try {
      store = await WorkflowStore.open(expandPath(options.store ?? defaultWorkflowStorePathForCwd()));
      if (options.failStaleAfterMs !== undefined) {
        store.failStaleRuns(parsePositiveInteger(options.failStaleAfterMs));
      }
      console.log(JSON.stringify({ runs: store.listRuns().slice(0, options.limit) }, null, 2));
    } catch (error) {
      printCliError(error, "Workflow runs list failed");
      exitWith(EXIT_CODES.domainFailure);
    } finally {
      store?.close();
    }
  });

workflowRuns
  .command("show <runId>")
  .description("Show task history for one workflow run")
  .option("--store <path>", "SQLite workflow store path")
  .option("--fail-stale-after-ms <ms>", "Mark running workflow runs older than this many milliseconds as failed before showing tasks")
  .action(async (runId: string, options: { readonly store?: string; readonly failStaleAfterMs?: string }) => {
    let store: WorkflowStore | undefined;
    try {
      store = await WorkflowStore.open(expandPath(options.store ?? defaultWorkflowStorePathForCwd()));
      if (options.failStaleAfterMs !== undefined) {
        store.failStaleRuns(parsePositiveInteger(options.failStaleAfterMs));
      }
      const run = store.getRun(runId);
      if (run === null) {
        throw new CliUsageError(`workflow run not found: ${runId}`);
      }
      console.log(JSON.stringify({
        run,
        taskSummary: store.summarizeRunTasks(runId).map(withoutOrdinal),
        tasks: store.listRunTasks(runId).map(withoutOrdinal),
      }, null, 2));
    } catch (error) {
      printCliError(error, "Workflow runs show failed");
      exitWith(exitCodeForCliError(error, EXIT_CODES.domainFailure));
    } finally {
      store?.close();
    }
  });

workflowRuns
  .command("summary <runId>")
  .description("Show compact execution evidence for one workflow run")
  .option("--store <path>", "SQLite workflow store path")
  .option("--json", "Print the compact summary as JSON", false)
  .option("--fail-stale-after-ms <ms>", "Mark running workflow runs older than this many milliseconds as failed before showing the summary")
  .action(async (runId: string, options: { readonly store?: string; readonly json?: boolean; readonly failStaleAfterMs?: string }) => {
    let store: WorkflowStore | undefined;
    try {
      store = await WorkflowStore.open(expandPath(options.store ?? defaultWorkflowStorePathForCwd()));
      if (options.failStaleAfterMs !== undefined) {
        store.failStaleRuns(parsePositiveInteger(options.failStaleAfterMs));
      }
      const summary = store.compactRunSummary(runId);
      if (summary === null) {
        throw new CliUsageError(`workflow run not found: ${runId}`);
      }
      if (options.json === true) {
        console.log(JSON.stringify({ summary }, null, 2));
      } else {
        process.stdout.write(formatWorkflowRunCompactSummary(summary));
      }
    } catch (error) {
      printCliError(error, "Workflow runs summary failed");
      exitWith(exitCodeForCliError(error, EXIT_CODES.domainFailure));
    } finally {
      store?.close();
    }
  });

workflowRuns
  .command("events <runId>")
  .description("Show append-only events for one workflow run")
  .option("--store <path>", "SQLite workflow store path")
  .option("--after-sequence <n>", "Return events after this sequence number", (value) =>
    parseIntegerAtLeast(value, 0, "must be a non-negative integer"))
  .option("--limit <n>", "Maximum number of events to return", parsePositiveInteger)
  .option("--follow", "Stream events as NDJSON until the workflow run reaches a terminal status")
  .option("--timeout-ms <ms>", "Maximum time to follow before failing", parsePositiveInteger)
  .option("--interval-ms <ms>", "Polling interval when following", parsePositiveInteger, 250)
  .option("--fail-stale-after-ms <ms>", "Mark running workflow runs older than this many milliseconds as failed before showing events")
  .action(async (
    runId: string,
    options: {
      readonly store?: string;
      readonly afterSequence?: number;
      readonly limit?: number;
      readonly follow?: boolean;
      readonly timeoutMs?: number;
      readonly intervalMs: number;
      readonly failStaleAfterMs?: string;
    },
  ) => {
    let store: WorkflowStore | undefined;
    try {
      store = await WorkflowStore.open(expandPath(options.store ?? defaultWorkflowStorePathForCwd()));
      if (options.follow === true) {
        const started = Date.now();
        let afterSequence = options.afterSequence ?? 0;
        let emitted = 0;
        while (true) {
          if (options.failStaleAfterMs !== undefined) {
            store.failStaleRuns(parsePositiveInteger(options.failStaleAfterMs));
          }
          const run = store.getRun(runId);
          if (run === null) {
            throw new CliUsageError(`workflow run not found: ${runId}`);
          }
          const remaining = options.limit === undefined ? undefined : Math.max(0, options.limit - emitted);
          const events = store.listRunEvents(runId)
            .filter((event) => event.sequence > afterSequence)
            .slice(0, remaining);
          for (const event of events) {
            process.stdout.write(`${JSON.stringify({ runId, event })}\n`);
            afterSequence = event.sequence;
            emitted += 1;
          }
          if (options.limit !== undefined && emitted >= options.limit) return;
          if (store.getRun(runId)?.status !== "running") return;
          if (options.timeoutMs !== undefined && Date.now() - started >= options.timeoutMs) {
            throw new Error(`timed out following workflow run ${runId}`);
          }
          await delay(Math.min(options.intervalMs, Math.max(1, (options.timeoutMs ?? Number.POSITIVE_INFINITY) - (Date.now() - started))));
        }
      }
      if (options.failStaleAfterMs !== undefined) {
        store.failStaleRuns(parsePositiveInteger(options.failStaleAfterMs));
      }
      const events = store.listRunEvents(runId)
        .filter((event) => options.afterSequence === undefined || event.sequence > options.afterSequence)
        .slice(0, options.limit);
      console.log(JSON.stringify({ runId, events }, null, 2));
    } catch (error) {
      printCliError(error, "Workflow runs events failed");
      exitWith(EXIT_CODES.domainFailure);
    } finally {
      store?.close();
    }
  });

workflowRuns
  .command("wait <runId>")
  .description("Wait until a workflow run reaches a terminal status")
  .option("--store <path>", "SQLite workflow store path")
  .option("--timeout-ms <ms>", "Maximum time to wait before failing", parsePositiveInteger, 60_000)
  .option("--interval-ms <ms>", "Polling interval", parsePositiveInteger, 250)
  .option("--fail-stale-after-ms <ms>", "Mark running workflow runs older than this many milliseconds as failed while waiting")
  .action(async (
    runId: string,
    options: {
      readonly store?: string;
      readonly timeoutMs: number;
      readonly intervalMs: number;
      readonly failStaleAfterMs?: string;
    },
  ) => {
    let store: WorkflowStore | undefined;
    try {
      store = await WorkflowStore.open(expandPath(options.store ?? defaultWorkflowStorePathForCwd()));
      const started = Date.now();
      while (true) {
        if (options.failStaleAfterMs !== undefined) {
          store.failStaleRuns(parsePositiveInteger(options.failStaleAfterMs));
        }
        const run = store.listRuns().find((candidate) => candidate.runId === runId);
        if (run === undefined) {
          throw new CliUsageError(`workflow run not found: ${runId}`);
        }
        if (run.status !== "running") {
          const tasks = store.listRunTasks(runId);
          console.log(JSON.stringify({
            run,
            taskSummary: store.summarizeRunTasks(runId).map(withoutOrdinal),
            tasks: tasks.map(withoutOrdinal),
          }, null, 2));
          // Same terminal-status mapping as `workflow run`: a "completed" run can still carry
          // an isolated failed/escalated task, which must read as a non-zero exit for a caller
          // polling via `$?`.
          if (!isWorkflowRunOutcomeSuccessful(run.status, tasks.map((task) => task.status))) {
            exitWith(EXIT_CODES.domainFailure);
          }
          return;
        }
        if (Date.now() - started >= options.timeoutMs) {
          throw new Error(`timed out waiting for workflow run ${runId}`);
        }
        await delay(Math.min(options.intervalMs, Math.max(1, options.timeoutMs - (Date.now() - started))));
      }
    } catch (error) {
      printCliError(error, "Workflow runs wait failed");
      exitWith(exitCodeForCliError(error, EXIT_CODES.domainFailure));
    } finally {
      store?.close();
    }
  });

workflowRuns
  .command("update <runId> <file>")
  .description("Stop a running workflow and start an updated detached run against the same store/cache")
  .option("--store <path>", "SQLite workflow store path")
  .option("--mock-output <path>", "JSON object keyed by workflow task id")
  .option("--worker <worker>", "Fallback worker for tasks without task-level worker selection")
  .option("--model <model>", "Fallback model for tasks without task-level model selection")
  .option("--permission <mode>", "Fallback permission mode for tasks without task-level permission (legacy|permissive|restricted|interactive|sandbox-read-only|sandbox-workspace-write|full-access)")
  .option("--max-concurrent-tasks <count>", "Maximum concurrent workflow task executions", parsePositiveInteger)
  .option("--task-timeout-ms <ms>", "Default per-task process timeout in milliseconds", parsePositiveInteger)
  .option("--no-cache", "Disable workflow task cache lookup and writes")
  .action(async (runId: string, file: string, options: {
    readonly store?: string;
    readonly mockOutput?: string;
    readonly worker?: string;
    readonly model?: string;
    readonly permission?: string;
    readonly maxConcurrentTasks?: number;
    readonly taskTimeoutMs?: number;
    readonly cache?: boolean;
  }) => {
    try {
      const storePath = expandPath(options.store ?? defaultWorkflowStorePathForCwd());
      const result = await updateDetachedWorkflowRun({ runId, file, storePath, options });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      printCliError(error, "Workflow runs update failed");
      exitWith(exitCodeForCliError(error, EXIT_CODES.domainFailure));
    }
  });

workflowRuns
  .command("stop <runId>")
  .description("Request a running workflow run to stop before starting more tasks")
  .option("--store <path>", "SQLite workflow store path")
  .action(async (runId: string, options: { readonly store?: string }) => {
    let store: WorkflowStore | undefined;
    try {
      store = await WorkflowStore.open(expandPath(options.store ?? defaultWorkflowStorePathForCwd()));
      const stoppedRun = store.stopRunningRun(runId);
      if (stoppedRun !== null) {
        requestWorkflowRunnerTermination(store, stoppedRun, "stop-requested");
        console.log(JSON.stringify({ run: stoppedRun }, null, 2));
        return;
      }
      const run = store.getRun(runId);
      if (run === null) {
        throw new CliUsageError(`workflow run not found: ${runId}`);
      }
      console.log(JSON.stringify({ run }, null, 2));
    } catch (error) {
      printCliError(error, "Workflow runs stop failed");
      exitWith(exitCodeForCliError(error, EXIT_CODES.domainFailure));
    } finally {
      store?.close();
    }
  });

// Init command - create a new plugin
program
  .command("init <name>")
  .description("Create a new harness-aware plugin from template")
  .option("-d, --dir <path>", "Directory to create plugin in", ".")
  .option("--with-agent", "Include example agent definition")
  .option("--with-skill", "Include example skill scaffold (preset targets for coding + claw harnesses)")
  .option("--typescript", "Include TypeScript authoring guardrails with Oxlint and Oxfmt")
  .option("--minimal", "Create minimal plugin (manifest only)")
  .action(async (name: string, options) => {
    try {
      const targetDir = join(expandPath(options.dir), name);

      if (await exists(targetDir)) {
        console.error(`Directory already exists: ${targetDir}`);
        exitWith(EXIT_CODES.domainFailure);
      }

      console.log(`\n📦 Creating plugin: ${name}`);
      console.log(`   Directory: ${targetDir}\n`);

      const { created } = await createPluginScaffold({
        name,
        targetDir,
        minimal: options.minimal,
        typescript: options.typescript,
        withAgent: options.withAgent,
        withSkill: options.withSkill,
      });

      console.log("Created:");
      for (const file of created) {
        console.log(`   ${file}`);
      }
      console.log("\n✅ Plugin created successfully!");
      console.log(`\nNext steps:`);
      console.log(`   cd ${name}`);
      console.log(`   prism plan --plugin . --all`);
    } catch (error) {
      printCliError(error, "Error");
      exitWith(EXIT_CODES.domainFailure);
    }
  });

// Package command - emit distributable harness package artifacts without live activation
program
  .command("package <plugin-path>")
  .description("Package Prism source plugins into distributable per-harness artifacts")
  .option("--harness <harnesses>", "Comma-separated list of harness IDs")
  .option("--all", "Package all compile-targeted supported harnesses")
  .option(
    "--scope <scope>",
    `Package output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global",
  )
  .option("-p, --project <path>", "Project root when packaging project-scope artifacts")
  .option("--out <path>", "Override package output directory")
  .option("--dry-run", "Preview package writes without writing", false)
  .option("--force", "Allow writing into an existing unowned package output root", false)
  .action(async (pluginPath: string, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      const expanded = expandPath(pluginPath);
      const manifest = await readManifest(expanded);
      const requested = resolveRequestedHarnesses(options);
      const harnesses = requested.filter((harnessId) =>
        manifestHasCompileTargets(manifest, harnessId)
      );

      if (harnesses.length === 0) {
        console.log("\nNo compile-targeted harnesses matched this plugin.");
        return;
      }

      console.log(`\n📦 Packaging plugin: ${manifest.name}`);
      console.log(`   Harnesses: ${harnesses.join(", ")}`);
      if (options.out) console.log(`   Output: ${expandPath(options.out)}`);

      for (const harnessId of harnesses) {
        const result = await packagePluginForTarget({
          pluginPath: expanded,
          target: harnessId,
          scope: options.scope,
          projectPath: options.project,
          out: options.out,
          dryRun: options.dryRun,
          force: options.force,
          generatorVersion: prismVersion,
        });

        console.log(`\n   ${harnessId}: ${result.packageRoot}`);
        console.log(`   Activation: ${result.activationPath}`);
        const operationText = formatPackageOperations(result.operations);
        if (operationText.trim().length > 0) {
          console.log(indentBlock(operationText, "      "));
        }
      }

      console.log(options.dryRun ? "\n🔍 Dry run — no writes performed." : "\n✅ Done.");
    } catch (error) {
      printCliError(error, "Package error");
      exitWith(exitCodeForCliError(error, EXIT_CODES.domainFailure));
    }
  });

const mcpCommand = program
  .command("mcp")
  .description(
    "Observe Prism-generated MCP daemons (UDS-only; the stdio shim resolves-or-spawns and idle-reaps them)",
  );

mcpCommand
  .command("status [plugin-path]")
  .description("Show Prism-generated MCP daemon status (read from the UDS registry)")
  .option("--harness <id>", "Target MCP harness", parseMcpLifecycleHarness, "hermes")
  .option(
    "--scope <scope>",
    `Output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global"
  )
  .option("-p, --project <path>", "Project root when using --scope project")
  .action(async (pluginPath: string | undefined, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      if (pluginPath) {
        const status = await getMcpStatus({
          pluginPath,
          harness: options.harness,
          scope: options.scope,
          projectPath: options.project,
          prismHome: resolvePrismHome(),
        });
        console.log(formatMcpStatus(status));
        return;
      }

      const statuses = await listMcpStatuses({
        harness: options.harness,
        scope: options.scope,
        projectPath: options.project,
        prismHome: resolvePrismHome(),
      });
      if (statuses.length === 0) {
        console.log("stopped         (no Prism MCP runtime files found)");
        return;
      }
      for (const status of statuses) {
        console.log(formatMcpStatus(status));
      }
    } catch (error) {
      printCliError(error, "MCP status error");
      exitWith(exitCodeForCliError(error, EXIT_CODES.domainFailure));
    }
  });

mcpCommand
  .command("shim")
  .description(
    "Run the aggregating stdio MCP shim (the process a harness lowerer's " +
      "generated stdio-shim config spawns directly; entirely env-driven, no flags)",
  )
  .addHelpText(
    "after",
    `
Env vars read (all optional except PRISM_SHIM_PLUGINS):
  PRISM_SHIM_PLUGINS             comma-separated plugin names to aggregate
  PRISM_SHIM_DAEMON_TIMEOUT_MS   per-request daemon timeout
  PRISM_SHIM_SPAWN_TIMEOUT_MS    resolve-or-spawn timeout for a cold daemon
  PRISM_SHIM_ENABLED_TOOLS       comma-separated allowlist of wire tool names
  PRISM_SHIM_EXPOSURE            explicit X-Prism-Mcp-Exposure value forwarded to
                                 every daemon; when unset the shim derives the
                                 per-owner profile prism-generated-<owner>:<harness>
`,
  )
  .action(async () => {
    await import("./mcp/shim-main.js");
  });

program
  .command("doctor [plugin-path]")
  .description("Diagnose Prism refresh state and harness config health")
  .option("--harness <harnesses>", "Comma-separated list of harness IDs")
  .option("--all", "Check all supported harnesses")
  .option(
    "--scope <scope>",
    `Harness output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global",
  )
  .option("-p, --project <path>", "Project root when checking project scope")
  .option("--fix", "Converge fixable refresh findings", false)
  .option("--json", "Print a machine-readable JSON report", false)
  .action(async (pluginPath: string | undefined, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      const report = await runDoctor({
        ...(pluginPath ? { pluginPath } : {}),
        harnesses: resolveRequestedHarnesses(options),
        scope: options.scope,
        ...(options.project ? { projectPath: options.project } : {}),
        prismHome: resolvePrismHome(),
        fix: options.fix,
      });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatDoctorReport(report));
      }
      const code = doctorExitCode(report);
      if (code !== EXIT_CODES.success) exitWith(code);
    } catch (error) {
      printCliError(error, "Doctor error");
      exitWith(exitCodeForCliError(error, EXIT_CODES.domainFailure));
    }
  });

// List command - show supported harness IDs
program
  .command("harnesses")
  .description("List all supported harness IDs")
  .action(() => {
    console.log("\n📋 Supported harness IDs:\n");
    const harnesses = getAllHarnessIds();
    for (const id of harnesses) {
      const harness = getHarness(id);
      console.log(`   ${id.padEnd(12)} - ${harness.name}`);
      console.log(`                  Global: ${harness.globalConfigPath}`);
      if (harness.projectConfigPath) {
        console.log(`                  Project: ${harness.projectConfigPath}`);
      }
      console.log();
    }
  });

// Validate command - check plugin structure
program
  .command("validate <plugin-path>")
  .description("Validate a plugin structure")
  .option("-v, --verbose", "Show detailed validation output")
  .action(async (pluginPath: string, options: { verbose?: boolean }) => {
    try {
      await runValidateCommand(pluginPath, options);
    } catch (error) {
      printCliError(error, "Invalid plugin");
      exitWith(EXIT_CODES.domainFailure);
    }
  });

type ValidateCommandOptions = {
  verbose?: boolean;
};

type ValidationStatus = {
  hasErrors: boolean;
  hasWarnings: boolean;
};

async function runValidateCommand(
  pluginPath: string,
  options: ValidateCommandOptions
): Promise<void> {
  const manifest = await readManifest(pluginPath);
  printValidateManifestSummary(manifest);

  const skillStatus = printValidateGroup(
    "\n🎯 Skills validation",
    await validatePluginSkills(pluginPath),
    "skillName",
    "(unknown)",
    options
  );
  const agentStatus = printValidateGroup(
    "\n🤖 Agents validation",
    await validatePluginAgents(pluginPath),
    "agentName",
    "(unknown)",
    options
  );

  finishValidateCommand(mergeValidationStatus(skillStatus, agentStatus), options);
}

function printValidateManifestSummary(manifest: PluginManifest): void {
  console.log(`\n📦 Plugin: ${manifest.name} v${manifest.version}`);
  console.log(`   Description: ${manifest.description || "(none)"}`);
  console.log(`   Targets: ${formatManifestTargets(manifest)}`);
}

function emptyValidationStatus(): ValidationStatus {
  return { hasErrors: false, hasWarnings: false };
}

function mergeValidationStatus(
  left: ValidationStatus,
  right: ValidationStatus
): ValidationStatus {
  return {
    hasErrors: left.hasErrors || right.hasErrors,
    hasWarnings: left.hasWarnings || right.hasWarnings,
  };
}

function printValidateGroup<NameKey extends "skillName" | "agentName">(
  label: string,
  results: Array<PluginValidationResult & Partial<Record<NameKey, string>>>,
  nameKey: NameKey,
  fallbackName: string,
  options: ValidateCommandOptions
): ValidationStatus {
  if (results.length === 0) return emptyValidationStatus();

  console.log(`${label}:`);
  return results
    .map((result) => printValidateItem(result, nameKey, fallbackName, options))
    .reduce(mergeValidationStatus, emptyValidationStatus());
}

function printValidateItem<NameKey extends "skillName" | "agentName">(
  result: PluginValidationResult & Partial<Record<NameKey, string>>,
  nameKey: NameKey,
  fallbackName: string,
  options: ValidateCommandOptions
): ValidationStatus {
  const itemName = result[nameKey] || fallbackName;

  if (result.valid) {
    console.log(`   ✅ ${itemName}`);
    return printValidateWarnings(result.warnings, options);
  }

  console.log(`   ❌ ${itemName}`);
  for (const error of result.errors) {
    console.log(`      • ${error}`);
  }
  return {
    hasErrors: true,
    hasWarnings: result.warnings.length > 0 && !options.verbose,
  };
}

function printValidateWarnings(
  warnings: string[],
  options: ValidateCommandOptions
): ValidationStatus {
  if (options.verbose && warnings.length > 0) {
    for (const warning of warnings) {
      console.log(`      ⚠️  ${warning}`);
    }
    return { hasErrors: false, hasWarnings: true };
  }

  return { hasErrors: false, hasWarnings: warnings.length > 0 };
}

function finishValidateCommand(
  status: ValidationStatus,
  options: ValidateCommandOptions
): void {
  console.log();
  if (status.hasErrors) {
    console.log("❌ Validation failed with errors");
    exitWith(EXIT_CODES.domainFailure);
  } else if (status.hasWarnings && !options.verbose) {
    console.log("✅ Plugin is valid (run with --verbose to see warnings)");
  } else {
    console.log("✅ Plugin is valid");
  }
}

type LoadedPlugin = {
  pluginPath: string;
  manifest: PluginManifest;
};

type RefreshCommandOptions = {
  all?: boolean;
  harness?: string;
  plugin?: string;
  plugins?: string;
  project?: string;
  scope?: HarnessScope;
  overwrite?: boolean;
  validate?: boolean;
  dryRun?: boolean;
  json?: boolean;
  compileOnly?: boolean;
  clean?: boolean;
  compileRoot?: string;
  mcpLifecycle?: CompileMcpLifecycleMode;
};

type NormalizedRefreshOptions = {
  all?: boolean;
  harness?: string;
  plugin?: string;
  plugins?: string;
  project?: string;
  scope: HarnessScope;
  overwrite: boolean;
  validate?: boolean;
  dryRun: boolean;
  json: boolean;
  compileOnly: boolean;
  clean: boolean;
  compileRoot?: string;
  mcpLifecycle: CompileMcpLifecycleMode;
};

type RefreshCommandContext = LoadedPlugin & {
  harnesses: HarnessId[];
  options: NormalizedRefreshOptions;
};

type InvalidPluginManifest = {
  pluginPath: string;
  error: unknown;
};

type RefreshFailure = {
  readonly harness?: string;
  readonly path?: string;
  readonly headline: string;
  readonly hint?: string;
};

type PluginRefreshResult = {
  pluginPath: string;
  name: string;
  success: boolean;
  reports: ReadonlyArray<SyncReport>;
  compileResults: ReadonlyArray<CompileResult>;
  errors: RefreshFailure[];
  backups: string[];
};

type PluginValidationResult = {
  valid: boolean;
  warnings: string[];
  skillName?: string;
  agentName?: string;
  errors: string[];
};

type DirectoryRefreshOptions = {
  harnesses: HarnessId[];
  scope: HarnessScope;
  projectPath?: string;
  compileRoot?: string;
  mcpLifecycle: CompileMcpLifecycleMode;
  validate?: boolean;
  dryRun: boolean;
  overwrite: boolean;
  compileOnly: boolean;
  clean: boolean;
  json: boolean;
};

type RefreshMode = "refresh" | "plan";

type RefreshSelection =
  | { readonly kind: "single"; readonly pluginPath: string }
  | { readonly kind: "directory"; readonly directory: string };

async function runRefreshCommand(
  mode: RefreshMode,
  positionalPluginPath: string | undefined,
  rawOptions: RefreshCommandOptions
): Promise<void> {
  const options = normalizeRefreshCommandOptions(rawOptions, mode);
  assertProjectPathForProjectScope(options.scope, options.project);
  const selection = resolveRefreshSelection(positionalPluginPath, options);

  if (selection.kind === "directory") {
    await runRefreshDirectoryCommand(mode, selection.directory, options);
    return;
  }

  await runRefreshSingleCommand(mode, selection.pluginPath, options);
}

async function runRefreshSingleCommand(
  mode: RefreshMode,
  pluginPath: string,
  options: NormalizedRefreshOptions,
): Promise<void> {
  const context = await loadRefreshCommandContext(pluginPath, options, mode);

  if (context.options.validate !== false) {
    const validation = await collectTargetedValidationResults(context);
    const valid = context.options.json
      ? pluginValidationResultIsValid(validation.skillResults, validation.agentResults)
      : printPluginValidationResult(validation.skillResults, validation.agentResults, {
        header: "\n❌ Plugin validation failed:\n",
        labelIndent: "   ",
        itemIndent: "      ",
        errorIndent: "         ",
      });
    if (!valid) {
      if (!context.options.json) console.log("\nUse --no-validate to skip validation.");
      exitWith(EXIT_CODES.domainFailure);
    }
  }

  const compilePhase = await runCompilePhaseForPlugin({
    pluginPath: context.pluginPath,
    manifest: context.manifest,
    harnesses: context.harnesses,
    scope: context.options.scope,
    projectPath: context.options.project,
    compileRoot: context.options.compileRoot,
    mcpLifecycle: context.options.mcpLifecycle,
    clean: context.options.clean,
    dryRun: context.options.dryRun,
    quiet: context.options.json,
  });
  if (!compilePhase.success) {
    exitWith(EXIT_CODES.domainFailure);
  }

  const refreshResult = context.options.compileOnly
    ? undefined
    : await runDirectRefreshForPlugin(context, "   ");

  if (context.options.json) {
    console.log(JSON.stringify(commandJsonEnvelope({
      mode,
      plugin: context.manifest.name,
      compileResults: compilePhase.results,
      ...(refreshResult ? { refreshResult } : {}),
    }), null, 2));
  } else {
    printRefreshCommandResult({
      mode,
      compileResults: compilePhase.results,
      compileBackups: compilePhase.backups,
      ...(refreshResult ? { refreshResult } : {}),
    });
  }

  const failOnUnapplied = !context.options.dryRun;
  if (failOnUnapplied && refreshResult && !refreshResult.success) {
    exitWith(EXIT_CODES.domainFailure);
  }
  if (
    failOnUnapplied &&
    compilePhase.results.some((result) => result.blocked.length > 0 || result.failures.length > 0)
  ) {
    exitWith(EXIT_CODES.domainFailure);
  }
}

async function loadRefreshCommandContext(
  pluginPath: string,
  options: NormalizedRefreshOptions,
  mode: RefreshMode,
): Promise<RefreshCommandContext> {
  const harnesses = resolveRequestedHarnesses(options);
  const manifest = await readManifest(pluginPath);

  if (!options.json) {
    console.log(
      `\n📦 ${mode === "plan" || options.dryRun ? "Planning" : "Refreshing"} plugin: ${manifest.name} v${manifest.version}`,
    );
  }
  if (!options.json) {
    printPluginRefreshContext({
      manifest,
      harnesses,
      scope: options.scope,
      projectPath: options.project,
    });
  }

  return { pluginPath, manifest, harnesses, options };
}

function normalizeRefreshCommandOptions(
  options: RefreshCommandOptions,
  mode: RefreshMode,
): NormalizedRefreshOptions {
  return {
    ...options,
    scope: options.scope ?? "global",
    overwrite: options.overwrite ?? false,
    dryRun: mode === "plan" || options.dryRun === true,
    json: options.json ?? false,
    compileOnly: options.compileOnly ?? false,
    clean: options.clean ?? false,
    mcpLifecycle: options.mcpLifecycle ?? "serve",
  };
}

function resolveRefreshSelection(
  positionalPluginPath: string | undefined,
  options: NormalizedRefreshOptions,
): RefreshSelection {
  const pluginCandidates = [positionalPluginPath, options.plugin]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const directoryCandidates = [options.plugins]
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  if (pluginCandidates.length + directoryCandidates.length !== 1) {
    throw new Error("Specify exactly one plugin path or --plugins <directory>");
  }
  if (directoryCandidates[0]) {
    return { kind: "directory", directory: directoryCandidates[0] };
  }
  return { kind: "single", pluginPath: pluginCandidates[0]! };
}

async function collectTargetedValidationResults(context: RefreshCommandContext): Promise<{
  skillResults: PluginValidationResult[];
  agentResults: PluginValidationResult[];
}> {
  const shouldValidateSkills = context.harnesses.some((harnessId) =>
    manifestTargetsArtifact(context.manifest, "skills", harnessId)
  );
  const shouldValidateAgents = context.harnesses.some((harnessId) =>
    manifestTargetsArtifact(context.manifest, "agents", harnessId)
  );

  return {
    skillResults: shouldValidateSkills
      ? await validatePluginSkills(context.pluginPath)
      : [],
    agentResults: shouldValidateAgents
      ? await validatePluginAgents(context.pluginPath)
      : [],
  };
}

async function runDirectRefreshForPlugin(
  context: RefreshCommandContext,
  indent = "",
): Promise<RefreshResult> {
  const result = await refreshPlugin({
    pluginPath: context.pluginPath,
    harnesses: context.harnesses,
    projectPath: context.options.project,
    prismHome: resolvePrismHome(),
    overwrite: context.options.overwrite,
    dryRun: context.options.dryRun,
  });

  if (!context.options.json) {
    printRefreshReports(result, indent);
  }
  return result;
}

function printRefreshCommandResult(options: {
  readonly mode: RefreshMode;
  readonly compileResults: ReadonlyArray<CompileResult>;
  readonly compileBackups: ReadonlyArray<string>;
  readonly refreshResult?: RefreshResult;
}): void {
  if (options.refreshResult) {
    printRefreshDiagnostics(options.refreshResult);
  }

  const allBackups = [
    ...options.compileBackups,
    ...(options.refreshResult?.backups ?? []),
  ];
  if (allBackups.length > 0) {
    console.log("\n💾 Backups created:");
    for (const backup of allBackups) {
      console.log(`   ${backup}`);
    }
  }

  const compileHasUnapplied = options.compileResults.some(
    (result) => result.blocked.length > 0 || result.failures.length > 0,
  );
  if (compileHasUnapplied || (options.refreshResult && !options.refreshResult.success)) {
    console.log(`\n❌ ${options.mode === "plan" ? "Plan found unapplied targets." : "Refresh finished with unapplied targets."}`);
    return;
  }

  if (options.mode === "plan") {
    console.log("\n✅ Plan completed.");
  } else if (options.refreshResult?.converged && options.compileResults.every((result) => result.converged)) {
    console.log("\n✅ Already converged — nothing written.");
  } else {
    console.log("\n✅ Done.");
  }
}

function printRefreshReports(result: RefreshResult, indent = ""): void {
  if (result.reports.length === 0) return;
  console.log(`\n${indent}📋 Refresh plan:\n`);
  const formatted = formatRefreshRootPlan(result.reports);
  if (formatted.trim().length > 0) {
    console.log(indentBlock(formatted, indent));
  }
}

function printRefreshDiagnostics(result: RefreshResult): void {
  for (const warning of result.warnings) {
    console.log(`\n⚠️  ${warning.harness} ${warning.targetPath}: ${warning.reason}`);
  }
  for (const blocked of result.blocked) {
    console.error(`\n⛔ ${renderPrismError(blocked)}`);
  }
  for (const failure of result.failures) {
    console.error(`\n❌ ${failure.op.kind} ${failure.op.targetPath}: ${failure.message}`);
  }
}

function commandJsonEnvelope(options: {
  readonly mode: RefreshMode;
  readonly plugin: string;
  readonly compileResults: ReadonlyArray<CompileResult>;
  readonly refreshResult?: RefreshResult;
}): unknown {
  return {
    schema: "prism.plan.v1",
    mode: options.mode,
    plugin: options.plugin,
    compile: options.compileResults.map(compileResultJsonEnvelope),
    ...(options.refreshResult ? { refresh: refreshPlanJsonEnvelope(options.refreshResult) } : {}),
    success:
      options.compileResults.every(
        (result) => result.blocked.length === 0 && result.failures.length === 0,
      ) && (options.refreshResult?.success ?? true),
  };
}

function pluginResultJsonEnvelope(
  mode: RefreshMode,
  result: PluginRefreshResult,
): unknown {
  return {
    schema: "prism.plan.plugin.v1",
    mode,
    pluginPath: result.pluginPath,
    plugin: result.name,
    success: result.success,
    compile: result.compileResults.map(compileResultJsonEnvelope),
    refresh: {
      roots: result.reports.map((report) => ({
        harness: report.harness,
        root: report.root,
        converged: report.converged,
        counts: report.ops.reduce<Record<string, number>>((acc, op) => {
          acc[op.kind] = (acc[op.kind] ?? 0) + 1;
          return acc;
        }, {}),
        operations: report.ops.map((op) => ({
          kind: op.kind,
          targetPath: op.targetPath,
          ...("reason" in op ? { reason: op.reason } : {}),
          ...(op.kind === "blocked" ? { hint: op.hint } : {}),
        })),
      })),
    },
    errors: result.errors,
  };
}

function workflowRefsJsonEnvelope(report: SyncReport): unknown {
  return {
    harness: report.harness,
    root: report.root,
    converged: report.converged,
    counts: report.ops.reduce<Record<string, number>>((acc, op) => {
      acc[op.kind] = (acc[op.kind] ?? 0) + 1;
      return acc;
    }, {}),
    operations: report.ops.map((op) => ({
      kind: op.kind,
      targetPath: op.targetPath,
      ...("reason" in op ? { reason: op.reason } : {}),
      ...(op.kind === "blocked" ? { hint: op.hint } : {}),
    })),
    failures: report.failures.map((failure) => ({
      kind: failure.op.kind,
      targetPath: failure.op.targetPath,
      message: failure.message,
    })),
    blocked: blockedTargetErrors(report).map((blocked) => ({
      targetPath: blocked.targetPath,
      message: blocked.message,
      hint: blocked.hint,
    })),
  };
}

function workflowRefsReportHasFailures(report: SyncReport | null): boolean {
  return report !== null && (report.failures.length > 0 || blockedTargetErrors(report).length > 0);
}

function printWorkflowRefsReport(report: SyncReport, indent = ""): void {
  console.log(`\n${indent}🛠  Workflow refs:`);
  console.log(`${indent}   Root: ${report.root}`);
  const operationText = formatOperations(report.ops);
  if (operationText.trim().length > 0) {
    console.log(indentBlock(operationText, indent.length > 0 ? `${indent}   ` : ""));
  }
  for (const blocked of blockedTargetErrors(report)) {
    console.error(`\n${indent}⛔ ${renderPrismError(blocked)}`);
  }
  for (const failure of report.failures) {
    console.error(`\n${indent}❌ ${failure.op.kind} ${failure.op.targetPath}: ${failure.message}`);
  }
}

function compileResultJsonEnvelope(result: CompileResult): unknown {
  return {
    target: result.target,
    scope: result.scope,
    root: result.outputRoot,
    converged: result.converged,
    counts: result.operations.reduce<Record<string, number>>((acc, op) => {
      acc[op.kind] = (acc[op.kind] ?? 0) + 1;
      return acc;
    }, {}),
    operations: result.operations.map((op) => ({
      kind: op.kind,
      targetPath: op.targetPath,
      ...("reason" in op ? { reason: op.reason } : {}),
      ...(op.kind === "blocked" ? { hint: op.hint } : {}),
    })),
    failures: result.failures.map((failure) => ({
      kind: failure.op.kind,
      targetPath: failure.op.targetPath,
      message: failure.message,
    })),
    blocked: result.blocked.map((blocked) => ({
      targetPath: blocked.targetPath,
      message: blocked.message,
      hint: blocked.hint,
    })),
  };
}

async function requireRefreshDirectory(expandedDir: string): Promise<void> {
  if (await exists(expandedDir)) return;

  console.error(`Directory not found: ${expandedDir}`);
  exitWith(EXIT_CODES.usage);
}

async function runRefreshDirectoryCommand(
  mode: RefreshMode,
  directory: string,
  options: NormalizedRefreshOptions,
): Promise<void> {
  const harnesses = resolveRequestedHarnesses(options);
  const expandedDir = expandPath(directory);

  await requireRefreshDirectory(expandedDir);
  const pluginPaths = await discoverPluginPaths(expandedDir);
  if (pluginPaths.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({
        schema: "prism.plan.collection.v1",
        mode,
        plugins: [],
        invalidPlugins: [],
      }, null, 2));
    } else {
      printRefreshDirectoryDiscovery(expandedDir, pluginPaths);
    }
    return;
  }
  if (!options.json) printRefreshDirectoryDiscovery(expandedDir, pluginPaths);

  const { validPlugins, invalidPlugins } = await loadPluginManifests(pluginPaths);
  if (!options.json) printRefreshDirectoryManifestResults(validPlugins, invalidPlugins);

  const { results, workflowRefsReport } = await refreshValidPlugins(validPlugins, {
    harnesses,
    scope: options.scope,
    projectPath: options.project,
    compileRoot: options.compileRoot,
    mcpLifecycle: options.mcpLifecycle,
    validate: options.validate,
    dryRun: options.dryRun,
    overwrite: options.overwrite,
    compileOnly: options.compileOnly,
    clean: options.clean,
    json: options.json,
  });

  if (options.json) {
    console.log(JSON.stringify({
      schema: "prism.plan.collection.v1",
      mode,
      plugins: results.map((result) => pluginResultJsonEnvelope(mode, result)),
      ...(workflowRefsReport ? { workflowRefs: workflowRefsJsonEnvelope(workflowRefsReport) } : {}),
      invalidPlugins: invalidPlugins.map(({ pluginPath, error }) => ({
        pluginPath,
        message: formatManifestLoadError(pluginPath, error),
      })),
    }, null, 2));
    if (
      results.some((result) => !result.success) ||
      invalidPlugins.length > 0 ||
      workflowRefsReportHasFailures(workflowRefsReport)
    ) {
      exitWith(EXIT_CODES.domainFailure);
    }
    return;
  }

  const hasFailures = printRefreshDirectorySummary({
    pluginPaths,
    validPlugins,
    invalidPlugins,
    results,
  });

  if (hasFailures || workflowRefsReportHasFailures(workflowRefsReport)) {
    console.log(`\n⚠️  Some plugins failed validation, compile, or refresh`);
    exitWith(EXIT_CODES.domainFailure);
  }

  console.log(
    mode === "plan"
      ? "\n✅ All plugin plans completed successfully!"
      : "\n✅ All plugin refreshes completed successfully!",
  );
}

function printRefreshDirectoryDiscovery(
  expandedDir: string,
  pluginPaths: string[]
): boolean {
  if (pluginPaths.length === 0) {
    console.log(`\n📂 No plugins found in ${expandedDir}`);
    console.log("   (Looking for directories containing plugin.json)");
    return false;
  }

  console.log(`\n📂 Found ${pluginPaths.length} plugin(s) in ${expandedDir}:`);
  return true;
}

async function loadPluginManifests(pluginPaths: string[]): Promise<{
  validPlugins: LoadedPlugin[];
  invalidPlugins: InvalidPluginManifest[];
}> {
  const validPlugins: LoadedPlugin[] = [];
  const invalidPlugins: InvalidPluginManifest[] = [];

  for (const pluginPath of pluginPaths) {
    try {
      const manifest = await readManifest(pluginPath);
      validPlugins.push({ pluginPath, manifest });
    } catch (error) {
      invalidPlugins.push({ pluginPath, error });
    }
  }

  return { validPlugins, invalidPlugins };
}

function printRefreshDirectoryManifestResults(
  validPlugins: LoadedPlugin[],
  invalidPlugins: InvalidPluginManifest[]
): void {
  if (validPlugins.length > 0) {
    console.log("\n✅ Valid plugin manifests:");
    for (const { manifest } of validPlugins) {
      console.log(`   • ${manifest.name} v${manifest.version}`);
    }
  }

  if (invalidPlugins.length > 0) {
    console.log("\n❌ Invalid plugin manifests:\n");
    for (const { pluginPath, error } of invalidPlugins) {
      console.log(indentBlock(formatManifestLoadError(pluginPath, error, { bullet: true }), "   "));
      console.log();
    }
  }

  console.log();
}

async function refreshValidPlugins(
  validPlugins: LoadedPlugin[],
  options: DirectoryRefreshOptions
): Promise<{
  readonly results: PluginRefreshResult[];
  readonly workflowRefsReport: SyncReport | null;
}> {
  const sortedPlugins = topologicallySortedPlugins(validPlugins);
  const results: PluginRefreshResult[] = [];

  for (const plugin of sortedPlugins) {
    results.push(await refreshDiscoveredPlugin(plugin, options));
  }

  const workflowRefsReport = await syncDirectoryWorkflowRefs(results, options);
  if (!options.json && workflowRefsReport) printWorkflowRefsReport(workflowRefsReport, "   ");

  return { results, workflowRefsReport };
}

async function syncDirectoryWorkflowRefs(
  results: ReadonlyArray<PluginRefreshResult>,
  options: DirectoryRefreshOptions,
): Promise<SyncReport | null> {
  if (options.dryRun) return null;
  if (!results.some((result) => result.compileResults.length > 0)) return null;
  return syncWorkflowRefsForProject({
    prismHome: resolvePrismHome(),
    ...(options.projectPath ? { projectPath: options.projectPath } : {}),
  });
}

async function refreshDiscoveredPlugin(
  plugin: LoadedPlugin,
  options: DirectoryRefreshOptions
): Promise<PluginRefreshResult> {
  if (!options.json) {
    console.log(`\n📦 Refreshing plugin: ${plugin.manifest.name} v${plugin.manifest.version}`);
    printPluginRefreshContext({
      manifest: plugin.manifest,
      harnesses: options.harnesses,
      scope: options.scope,
      projectPath: options.projectPath,
      indent: "   ",
    });
  }

  if (!(await validatePluginBeforeRefresh(plugin, options))) {
    return failedPluginRefresh(plugin, { headline: "Validation failed" }, []);
  }

  const compilePhase = await runCompilePhaseForPlugin({
    pluginPath: plugin.pluginPath,
    manifest: plugin.manifest,
    harnesses: options.harnesses,
    scope: options.scope,
    projectPath: options.projectPath,
    compileRoot: options.compileRoot,
    mcpLifecycle: options.mcpLifecycle,
    clean: options.clean,
    dryRun: options.dryRun,
    quiet: options.json,
    emitWorkflowRefs: false,
  });

  if (!compilePhase.success) {
    return failedPluginRefresh(plugin, compilePhase.failure, compilePhase.backups);
  }

  if (options.compileOnly) {
    return successfulPluginRefresh(plugin, [], compilePhase.results, compilePhase.backups);
  }

  const result = await refreshPlugin({
    pluginPath: plugin.pluginPath,
    harnesses: options.harnesses,
    projectPath: options.projectPath,
    prismHome: resolvePrismHome(),
    overwrite: options.overwrite,
    dryRun: options.dryRun,
  });
  if (!options.json) {
    printRefreshReports(result, "   ");
    printRefreshDiagnostics(result);
  }
  return {
    pluginPath: plugin.pluginPath,
    name: plugin.manifest.name,
    success: result.success,
    reports: result.reports,
    compileResults: compilePhase.results,
    errors: [
      ...result.blocked.map((blocked) => ({
        path: blocked.targetPath,
        headline: blocked.message,
        hint: blocked.hint,
      })),
      ...result.failures.map((failure) => ({
        path: failure.op.targetPath,
        headline: `${failure.op.kind} failed: ${failure.message}`,
      })),
    ],
    backups: [...compilePhase.backups, ...result.backups],
  };
}

async function validatePluginBeforeRefresh(
  plugin: LoadedPlugin,
  options: DirectoryRefreshOptions
): Promise<boolean> {
  if (options.validate === false) return true;

  const shouldValidateSkills = options.harnesses.some((harnessId) =>
    manifestTargetsArtifact(plugin.manifest, "skills", harnessId)
  );
  const shouldValidateAgents = options.harnesses.some((harnessId) =>
    manifestTargetsArtifact(plugin.manifest, "agents", harnessId)
  );
  const skillResults = shouldValidateSkills
    ? await validatePluginSkills(plugin.pluginPath)
    : [];
  const agentResults = shouldValidateAgents
    ? await validatePluginAgents(plugin.pluginPath)
    : [];

  if (options.json) return pluginValidationResultIsValid(skillResults, agentResults);
  return printPluginValidationResult(skillResults, agentResults);
}

function pluginValidationResultIsValid(
  skillResults: PluginValidationResult[],
  agentResults: PluginValidationResult[],
): boolean {
  return skillResults.every((result) => result.valid) &&
    agentResults.every((result) => result.valid);
}

function printPluginValidationResult(
  skillResults: PluginValidationResult[],
  agentResults: PluginValidationResult[],
  style: {
    header: string;
    labelIndent: string;
    itemIndent: string;
    errorIndent: string;
  } = {
    header: "\n   ❌ Validation failed:\n",
    labelIndent: "      ",
    itemIndent: "         ",
    errorIndent: "            ",
  }
): boolean {
  const hasSkillErrors = skillResults.some((result) => !result.valid);
  const hasAgentErrors = agentResults.some((result) => !result.valid);
  if (!hasSkillErrors && !hasAgentErrors) return true;

  console.log(style.header);

  if (hasSkillErrors) {
    printValidationFailures("Skills", skillResults, "skillName", style);
  }
  if (hasAgentErrors) {
    printValidationFailures("Agents", agentResults, "agentName", style);
  }

  return false;
}

function printValidationFailures(
  label: string,
  results: PluginValidationResult[],
  nameKey: "skillName" | "agentName",
  style: {
    labelIndent: string;
    itemIndent: string;
    errorIndent: string;
  }
): void {
  console.log(`${style.labelIndent}${label}:`);
  const fallbackName = `(unknown ${label.slice(0, -1).toLowerCase()})`;
  for (const result of results) {
    if (result.valid) continue;

    console.log(`${style.itemIndent}${result[nameKey] || fallbackName}:`);
    for (const error of result.errors) {
      console.log(`${style.errorIndent}• ${error}`);
    }
  }
}

function failedPluginRefresh(
  plugin: LoadedPlugin,
  failure: RefreshFailure,
  backups: string[]
): PluginRefreshResult {
  return {
    pluginPath: plugin.pluginPath,
    name: plugin.manifest.name,
    success: false,
    reports: [],
    compileResults: [],
    errors: [failure],
    backups,
  };
}

function successfulPluginRefresh(
  plugin: LoadedPlugin,
  reports: SyncReport[],
  compileResults: CompileResult[],
  backups: string[]
): PluginRefreshResult {
  return {
    pluginPath: plugin.pluginPath,
    name: plugin.manifest.name,
    success: true,
    reports,
    compileResults,
    errors: [],
    backups,
  };
}

function printRefreshDirectorySummary(options: {
  pluginPaths: string[];
  validPlugins: LoadedPlugin[];
  invalidPlugins: InvalidPluginManifest[];
  results: PluginRefreshResult[];
}): boolean {
  const successCount = options.results.filter((result) => result.success).length;
  const failedResults = options.results.filter((result) => !result.success);

  console.log("\n" + "─".repeat(60));
  console.log("\n📊 Summary:");
  console.log(`   Total discovered plugins: ${options.pluginPaths.length}`);
  console.log(`   Valid manifests: ${options.validPlugins.length}`);
  if (options.invalidPlugins.length > 0) {
    console.log(`   Invalid manifests: ${options.invalidPlugins.length}`);
  }
  console.log(`   Successful refreshes: ${successCount}`);
  printFailedRefreshSummary(failedResults);
  printInvalidManifestSummary(options.invalidPlugins);

  return failedResults.length > 0 || options.invalidPlugins.length > 0;
}

function printFailedRefreshSummary(results: PluginRefreshResult[]): void {
  if (results.length === 0) return;

  console.log(`   Failed refreshes: ${results.length}`);
  for (const result of results) {
    for (const failure of result.errors) {
      console.log(`      • ${formatRefreshFailureLine(result.name, failure)}`);
    }
  }
}

function formatRefreshFailureLine(plugin: string, failure: RefreshFailure): string {
  const location = [plugin, failure.harness, failure.path]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" › ");
  const line = `${location} — ${failure.headline}`;
  return failure.hint ? `${line} → ${failure.hint}` : line;
}

function printInvalidManifestSummary(
  invalidPlugins: InvalidPluginManifest[]
): void {
  if (invalidPlugins.length === 0) return;

  console.log("   Invalid plugin manifests:");
  for (const { pluginPath, error } of invalidPlugins) {
    console.log(`      • ${getManifestErrorLabel(pluginPath, error)}`);
  }
}

function resolveRequestedHarnesses(options: {
  all?: boolean;
  harness?: string;
}): HarnessId[] {
  if (options.all) {
    return getAllHarnessIds();
  }

  if (options.harness) {
    const harnesses = options.harness
      .split(",")
      .map((value: string) => value.trim())
      .filter((value) => value.length > 0);

    for (const harness of harnesses) {
      if (!isValidHarnessId(harness)) {
        console.error(`Unknown harness ID: ${harness}`);
        console.error(`Valid harness IDs: ${getAllHarnessIds().join(", ")}`);
        exitWith(EXIT_CODES.usage);
      }
    }

    return harnesses as HarnessId[];
  }

  console.error("Please specify --harness <ids> or --all");
  exitWith(EXIT_CODES.usage);
}

function printPluginRefreshContext(options: {
  manifest: PluginManifest;
  harnesses: HarnessId[];
  scope: HarnessScope;
  projectPath?: string;
  indent?: string;
}): void {
  const indent = options.indent ?? "   ";
  const matchingHarnesses = options.harnesses.filter((id) =>
    manifestTargetsHarness(options.manifest, id)
  );

  console.log(`${indent}Manifest targets: ${formatManifestTargets(options.manifest)}`);
  console.log(
    `${indent}Matching requested harnesses: ${
      matchingHarnesses.length > 0 ? matchingHarnesses.join(", ") : "None (check plugin.json)"
    }`
  );
  console.log(`${indent}Compile output scope: ${options.scope}`);

  if (options.projectPath) {
    console.log(`${indent}Project: ${options.projectPath}`);
  }

  const compileHarnesses = options.harnesses.filter((id) =>
    manifestHasCompileTargets(options.manifest, id)
  );
  if (
    options.projectPath &&
    options.scope === "global" &&
    compileHarnesses.length > 0
  ) {
    console.log(
      `${indent}Note: compile outputs stay in the global harness root unless --scope project is requested.`
    );
  }

  console.log();
}

type CompilePhaseOutcome =
  | { success: true; backups: string[]; results: CompileResult[] }
  | { success: false; backups: string[]; results: CompileResult[]; failure: RefreshFailure };

type DescribedPrismCause = ReturnType<typeof describePrismCause>;
type CompileBlocked = CompileResult["blocked"][number];
type CompileApplyFailure = CompileResult["failures"][number];

function refreshFailureFromCause(harness: HarnessId, described: DescribedPrismCause): RefreshFailure {
  return {
    harness,
    ...(described.path ? { path: described.path } : {}),
    headline: described.headline,
    ...(described.hint ? { hint: described.hint } : {}),
  };
}

function refreshFailureFromBlocked(harness: HarnessId, blocked: CompileBlocked): RefreshFailure {
  return {
    harness,
    path: blocked.targetPath,
    headline: blocked.message,
    hint: blocked.hint,
  };
}

function refreshFailureFromApplyFailure(
  harness: HarnessId,
  failure: CompileApplyFailure,
): RefreshFailure {
  return {
    harness,
    path: failure.op.targetPath,
    headline: `${failure.op.kind} failed: ${failure.message}`,
  };
}

function printCompileCause(harness: HarnessId, described: DescribedPrismCause, indent: string): void {
  console.log(`\n${indent}❌ Compile failed for ${harness}: ${described.headline}`);
  for (const detail of described.detail ?? []) {
    console.log(`${indent}   ${detail}`);
  }
  if (described.hint) {
    console.log(`${indent}   hint: ${described.hint}`);
  }
}

function printCompileResult(result: CompileResult, harness: HarnessId, indent: string): void {
  console.log(`\n${indent}🛠  Compile (${harness}, ${result.scope}):`);
  console.log(`${indent}   Root: ${result.outputRoot}`);
  console.log(`${indent}   Built: ${result.built.length > 0 ? result.built.join(", ") : "(none)"}`);
  console.log(
    `${indent}   From cache: ${result.fromCache.length > 0 ? result.fromCache.join(", ") : "(none)"}`
  );
  if (result.lockfilePath) {
    console.log(`${indent}   Lockfile: ${result.lockfilePath}`);
  }
  const operationText = formatOperations(result.operations);
  if (operationText.trim().length > 0) {
    console.log(indentBlock(operationText, indent.length > 0 ? `${indent}   ` : ""));
  }
}

function compilePhaseFailure(
  backups: string[],
  results: CompileResult[],
  failure: RefreshFailure,
): CompilePhaseOutcome {
  return { success: false, backups, results, failure };
}

async function runCompilePhaseForPlugin(options: {
  pluginPath: string;
  manifest: PluginManifest;
  harnesses: HarnessId[];
  scope: HarnessScope;
  projectPath?: string;
  compileRoot?: string;
  mcpLifecycle: CompileMcpLifecycleMode;
  clean?: boolean;
  dryRun: boolean;
  indent?: string;
  quiet?: boolean;
  emitWorkflowRefs?: boolean;
}): Promise<CompilePhaseOutcome> {
  const indent = options.indent ?? "";
  const compileBackups: string[] = [];
  const results: CompileResult[] = [];

  if (options.clean && options.harnesses.some((id) => manifestHasCompileTargets(options.manifest, id))) {
    const cacheDir = getCacheDir(expandPath(options.pluginPath));
    if (options.dryRun) {
      if (!options.quiet) console.log(`\n${indent}🧹 Plan — would clear compile cache: ${cacheDir}`);
    } else {
      await cleanCache(cacheDir);
      if (!options.quiet) console.log(`\n${indent}🧹 Cleared compile cache: ${cacheDir}`);
    }
  }

  for (const harnessId of options.harnesses) {
    if (!manifestHasCompileTargets(options.manifest, harnessId)) continue;

    const compileExit = await Effect.runPromiseExit(
      compilePluginForTarget({
        pluginPath: expandPath(options.pluginPath),
        target: harnessId,
        scope: options.scope,
        projectPath: options.projectPath,
        root: options.compileRoot,
        prismHome: resolvePrismHome(),
        dryRun: options.dryRun,
        mcpLifecycle: options.mcpLifecycle,
        ...(options.emitWorkflowRefs !== undefined
          ? { emitWorkflowRefs: options.emitWorkflowRefs }
          : {}),
      })
    );

    if (compileExit._tag === "Failure") {
      const described = describePrismCause(compileExit.cause);
      if (!options.quiet) printCompileCause(harnessId, described, indent);
      return compilePhaseFailure(
        compileBackups,
        results,
        refreshFailureFromCause(harnessId, described),
      );
    }

    results.push(compileExit.value);
    if (!options.quiet) printCompileResult(compileExit.value, harnessId, indent);
    compileBackups.push(...compileExit.value.backups);

    const firstBlocked = compileExit.value.blocked[0];
    if (firstBlocked) {
      if (!options.quiet) {
        console.log(`\n${indent}⛔ ${indentBlock(renderPrismError(firstBlocked), `${indent}   `).trimStart()}`);
      }
      return compilePhaseFailure(
        compileBackups,
        results,
        refreshFailureFromBlocked(harnessId, firstBlocked),
      );
    }
    const firstFailure = compileExit.value.failures[0];
    if (firstFailure) {
      if (!options.quiet) {
        console.log(
          `\n${indent}❌ ${firstFailure.op.kind} ${firstFailure.op.targetPath}: ${firstFailure.message}`,
        );
      }
      return compilePhaseFailure(
        compileBackups,
        results,
        refreshFailureFromApplyFailure(harnessId, firstFailure),
      );
    }
  }

  return { success: true, backups: compileBackups, results };
}

function parseHarnessScope(value: string): HarnessScope {
  if ((HARNESS_SCOPES as readonly string[]).includes(value)) {
    return value as HarnessScope;
  }

  throw new InvalidArgumentError(
    `Invalid scope '${value}'. Expected one of: ${HARNESS_SCOPES.join(", ")}`
  );
}

function parseMcpLifecycleHarness(value: string): McpLifecycleHarness {
  if (isValidHarnessId(value)) return value;
  throw new InvalidArgumentError(
    `Invalid MCP lifecycle harness '${value}'. Expected one of: ${getAllHarnessIds().join(", ")}.`
  );
}

function parseWorkflowPermissionMode(value: string): WorkflowPermissionMode {
  if (isWorkflowPermissionMode(value)) return value;
  throw new InvalidArgumentError(
    `Invalid permission mode '${value}'. Expected one of: ${WORKFLOW_PERMISSION_MODES.join(", ")}`,
  );
}

function parseMcpLifecycleMode(value: string): CompileMcpLifecycleMode {
  if (value === "none" || value === "verify" || value === "serve") return value;
  throw new InvalidArgumentError("--mcp-lifecycle must be one of: none, verify, serve.");
}

function assertProjectPathForProjectScope(
  scope: HarnessScope,
  projectPath?: string
): void {
  if (scope === "project" && !projectPath) {
    throw new CliUsageError("Project-local scope requires --project <path>");
  }
}

function getManifestErrorLabel(pluginPath: string, error: unknown): string {
  if (error instanceof PluginManifestError) {
    return error.pluginLabel;
  }

  return basename(expandPath(pluginPath));
}

function formatManifestLoadError(
  pluginPath: string,
  error: unknown,
  options: { bullet?: boolean } = {}
): string {
  const label = getManifestErrorLabel(pluginPath, error);
  const manifestPath = error instanceof PluginManifestError
    ? error.manifestPath
    : join(expandPath(pluginPath), "plugin.json");
  const lines = options.bullet ? [`• ${label}`] : [`Plugin: ${label}`];

  lines.push(`${options.bullet ? "  " : ""}Path: ${manifestPath}`);

  if (error instanceof PluginManifestError) {
    lines.push(`${options.bullet ? "  " : ""}${error.summary}`);
    for (const detail of error.details) {
      lines.push(`${options.bullet ? "    " : ""}- ${detail}`);
    }
    return lines.join("\n");
  }

  lines.push(`${options.bullet ? "  " : ""}${error instanceof Error ? error.message : String(error)}`);
  return lines.join("\n");
}

function indentBlock(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function printCliError(error: unknown, fallbackLabel: string): void {
  if (error instanceof PluginManifestError) {
    console.error(`\n❌ ${fallbackLabel}:\n`);
    console.error(indentBlock(formatManifestLoadError(error.pluginPath, error), "   "));
    return;
  }

  console.error(`\n❌ ${fallbackLabel}: ${error instanceof Error ? error.message : error}`);
}

function exitCodeForCliError(error: unknown, fallback: ExitCode): ExitCode {
  if (
    error instanceof CliUsageError ||
    error instanceof InvalidArgumentError ||
    error instanceof CommanderError
  ) {
    return EXIT_CODES.usage;
  }
  return fallback;
}

function installExitOverride(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) installExitOverride(child);
}

installExitOverride(program);
try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    exitWith(error.exitCode === 0 ? EXIT_CODES.success : EXIT_CODES.usage);
  }
  printCliError(error, "Error");
  exitWith(EXIT_CODES.domainFailure);
}
