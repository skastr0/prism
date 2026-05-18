#!/usr/bin/env bun
/**
 * prism CLI - Unified plugin distribution for AI coding harnesses
 */

import { Command, InvalidArgumentError } from "commander";
import { Effect } from "effect";
import { getAllHarnessIds, getHarness, isValidHarnessId } from "./harnesses.js";
import { install, planInstallation } from "./installer.js";
import {
  formatManifestTargets,
  manifestHasCompileTargets,
  PluginManifestError,
  readManifest,
  validatePluginSkills,
  validatePluginAgents,
  manifestTargetsHarness,
  manifestTargetsArtifact,
} from "./manifest.js";
import { exists, expandPath } from "./fs.js";
import { HARNESS_SCOPES } from "./types.js";
import type {
  FileOperation,
  HarnessId,
  HarnessScope,
  PluginManifest,
} from "./types.js";
import { basename, join } from "node:path";
import {
  compilePluginForTarget,
  formatOperations,
  type CompileMcpLifecycleMode,
} from "./compile/pipeline.js";
import { formatCompileError, type CompileError } from "./compile/errors.js";
import { cleanCache, getCacheDir } from "./compile/cache.js";
import { createPluginScaffold } from "./plugin-scaffold.js";
import {
  formatMcpServeResult,
  formatMcpStatus,
  formatMcpStopResult,
  getMcpStatus,
  listMcpStatuses,
  restartMcp,
  serveMcp,
  stopMcp,
  type McpLifecycleHarness,
  type McpPortSelection,
} from "./mcp/lifecycle.js";

const program = new Command();

program
  .name("prism")
  .description("Unified plugin distribution for AI coding harnesses")
  .version("0.1.0");

// Install command
program
  .command("install <plugin-path>")
  .description("Install a plugin to one or more harnesses")
  .option("--harness <harnesses>", "Comma-separated list of harness IDs")
  .option("--all", "Install to all supported harnesses")
  .option("-p, --project <path>", "Project path for project-specific rules")
  .option(
    "--scope <scope>",
    `Compile output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global"
  )
  .option("--overwrite", "Overwrite existing files", false)
  .option("--backup", "Create .bak backups before overwriting files")
  .option("--no-validate", "Skip plugin validation before install")
  .option("--dry-run", "Preview operations without executing", false)
  .option("--compile-root <path>", "Override compile output root")
  .option(
    "--mcp-lifecycle <mode>",
    "Generated HTTP MCP lifecycle behavior during compile (none|verify|serve)",
    parseMcpLifecycleMode,
    "none"
  )
  .action(async (pluginPath: string, options) => {
    try {
      await runInstallCommand(pluginPath, options);
    } catch (error) {
      printCliError(error, "Error");
      process.exit(1);
    }
  });

// Install-all command - discover and install all plugins in a directory
program
  .command("install-all <directory>")
  .description("Discover and refresh all plugins found in a directory (shallow scan)")
  .option("--harness <harnesses>", "Comma-separated list of harness IDs")
  .option("--all", "Install to all supported harnesses")
  .option("-p, --project <path>", "Project path for project-specific rules")
  .option(
    "--scope <scope>",
    `Compile output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global"
  )
  .option("--overwrite", "Overwrite existing files", false)
  .option("--backup", "Create .bak backups before overwriting files")
  .option("--no-validate", "Skip plugin validation before install")
  .option("--dry-run", "Preview operations without executing", false)
  .option("--compile-root <path>", "Override compile output root")
  .option(
    "--mcp-lifecycle <mode>",
    "Generated HTTP MCP lifecycle behavior during compile (none|verify|serve)",
    parseMcpLifecycleMode,
    "none"
  )
  .action(async (directory: string, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      const harnesses = resolveRequestedHarnesses(options);
      const expandedDir = expandPath(directory);

      await requireInstallAllDirectory(expandedDir);
      const pluginPaths = await discoverPluginPaths(expandedDir);
      if (!printInstallAllDiscovery(expandedDir, pluginPaths)) return;

      const { validPlugins, invalidPlugins } = await loadPluginManifests(pluginPaths);
      printInstallAllManifestResults(validPlugins, invalidPlugins);

      const results = await refreshValidPlugins(validPlugins, {
        harnesses,
        scope: options.scope,
        projectPath: options.project,
        compileRoot: options.compileRoot,
        mcpLifecycle: options.mcpLifecycle,
        validate: options.validate,
        dryRun: options.dryRun,
        backup: options.backup,
        overwrite: options.overwrite,
      });

      const hasFailures = printInstallAllSummary({
        pluginPaths,
        validPlugins,
        invalidPlugins,
        results,
      });

      if (hasFailures) {
        console.log("\n⚠️  Some plugins failed validation, compile, or install");
        process.exit(1);
      }

      console.log("\n✅ All plugin refreshes completed successfully!");
    } catch (error) {
      printCliError(error, "Error");
      process.exit(1);
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
        process.exit(1);
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
      console.log(`   prism install . --all --dry-run`);
    } catch (error) {
      printCliError(error, "Error");
      process.exit(1);
    }
  });

// Compile command - run the agent language compiler for a plugin
program
  .command("compile <plugin-path>")
  .description("Compile agent language sources into per-harness artifacts")
  .option(
    "--harness <id>",
    "Target harness ID ('opencode', 'claude-code', 'gemini-cli', 'codex-cli', 'amp-code', 'hermes', or 'grok')",
    "opencode"
  )
  .option(
    "--scope <scope>",
    `Output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global"
  )
  .option("-p, --project <path>", "Project root when compiling with --scope project")
  .option("--dry-run", "Preview operations without writing", false)
  .option("--clean", "Clear compile cache before compiling", false)
  .option("--backup", "Create .bak backups before overwriting files")
  .option("--root <path>", "Override harness output root")
  .option(
    "--mcp-lifecycle <mode>",
    "Generated HTTP MCP lifecycle behavior (none|verify|serve)",
    parseMcpLifecycleMode,
    "none"
  )
  .action(async (pluginPath: string, options) => {
    try {
      const expanded = expandPath(pluginPath);
      assertProjectPathForProjectScope(options.scope, options.project);

      if (options.clean) {
        const cacheDir = getCacheDir(expanded);
        if (options.dryRun) {
          console.log(`\n🧹 Dry run — would clear compile cache: ${cacheDir}`);
        } else {
          await cleanCache(cacheDir);
          console.log(`\n🧹 Cleared compile cache: ${cacheDir}`);
        }
      }

      const program = compilePluginForTarget({
        pluginPath: expanded,
        target: options.harness,
        scope: options.scope,
        projectPath: options.project,
        root: options.root,
        dryRun: options.dryRun,
        backup: options.backup,
        mcpLifecycle: options.mcpLifecycle,
      });

      const exit = await Effect.runPromiseExit(program);

      if (exit._tag === "Failure") {
        console.error(`\n❌ Compile failed:`);
        console.error(`   ${renderCompileError(exit.cause)}`);
        process.exit(1);
      }

      const result = exit.value;
      console.log(`\n🛠  Compiled ${result.composed.length} agent(s) for '${result.target}' (${result.scope}):`);
      console.log(`   Output root: ${result.outputRoot}`);
      console.log(`   Cache dir: ${result.cacheDir}`);
      console.log(`   Built: ${result.built.length > 0 ? result.built.join(", ") : "(none)"}`);
      console.log(
        `   From cache: ${result.fromCache.length > 0 ? result.fromCache.join(", ") : "(none)"}`
      );
      if (result.lockfilePath) {
        console.log(`   Lockfile: ${result.lockfilePath}`);
      }
      for (const agent of result.composed) {
        console.log(`   - ${agent.name}`);
      }
      console.log(`\n📋 Operations:\n`);
      console.log(formatOperations(result.operations));
      if (result.backups.length > 0) {
        console.log(`\n💾 Backups:`);
        for (const b of result.backups) {
          console.log(`   ${b}`);
        }
      }
      if (options.dryRun) {
        console.log(`\n🔍 Dry run — no writes performed.`);
      } else {
        console.log(`\n✅ Done.`);
      }
    } catch (error) {
      printCliError(error, "Compile error");
      process.exit(1);
    }
  });

const mcpCommand = program
  .command("mcp")
  .description("Manage Prism-generated MCP HTTP daemon lifecycle");

mcpCommand
  .command("serve <plugin-path>")
  .description("Start a Prism-generated HTTP MCP daemon")
  .option("--harness <id>", "Target MCP harness", parseMcpLifecycleHarness, "hermes")
  .option(
    "--scope <scope>",
    `Output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global"
  )
  .option("-p, --project <path>", "Project root when using --scope project")
  .option("--root <path>", "Override harness root")
  .option("--host <host>", "HTTP bind host")
  .option("--port <port>", "HTTP port or 'auto'")
  .option("--token-env <name>", "Environment variable containing the bearer token")
  .option("--foreground", "Run the generated server in the current process group", false)
  .action(async (pluginPath: string, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      const result = await serveMcp({
        pluginPath,
        harness: options.harness,
        scope: options.scope,
        projectPath: options.project,
        root: options.root,
        host: options.host,
        port: parseMcpPortSelection(options.port),
        tokenEnv: options.tokenEnv,
        foreground: options.foreground,
      });
      console.log(formatMcpServeResult(result));
    } catch (error) {
      printCliError(error, "MCP serve error");
      process.exit(1);
    }
  });

mcpCommand
  .command("status [plugin-path]")
  .description("Show Prism-generated MCP daemon status")
  .option("--harness <id>", "Target MCP harness", parseMcpLifecycleHarness, "hermes")
  .option(
    "--scope <scope>",
    `Output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global"
  )
  .option("-p, --project <path>", "Project root when using --scope project")
  .option("--root <path>", "Override harness root")
  .option("--token-env <name>", "Environment variable containing the bearer token")
  .action(async (pluginPath: string | undefined, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      if (pluginPath) {
        const status = await getMcpStatus({
          pluginPath,
          harness: options.harness,
          scope: options.scope,
          projectPath: options.project,
          root: options.root,
          tokenEnv: options.tokenEnv,
        });
        console.log(formatMcpStatus(status));
        return;
      }

      const statuses = await listMcpStatuses({
        harness: options.harness,
        scope: options.scope,
        projectPath: options.project,
        root: options.root,
        tokenEnv: options.tokenEnv,
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
      process.exit(1);
    }
  });

mcpCommand
  .command("stop <plugin-path>")
  .description("Stop a Prism-owned MCP HTTP daemon")
  .option("--harness <id>", "Target MCP harness", parseMcpLifecycleHarness, "hermes")
  .option(
    "--scope <scope>",
    `Output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global"
  )
  .option("-p, --project <path>", "Project root when using --scope project")
  .option("--root <path>", "Override harness root")
  .option("--token-env <name>", "Environment variable containing the bearer token")
  .action(async (pluginPath: string, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      const result = await stopMcp({
        pluginPath,
        harness: options.harness,
        scope: options.scope,
        projectPath: options.project,
        root: options.root,
        tokenEnv: options.tokenEnv,
      });
      console.log(formatMcpStopResult(result));
    } catch (error) {
      printCliError(error, "MCP stop error");
      process.exit(1);
    }
  });

mcpCommand
  .command("restart <plugin-path>")
  .description("Restart a Prism-owned MCP HTTP daemon")
  .option("--harness <id>", "Target MCP harness", parseMcpLifecycleHarness, "hermes")
  .option(
    "--scope <scope>",
    `Output scope (${HARNESS_SCOPES.join("|")})`,
    parseHarnessScope,
    "global"
  )
  .option("-p, --project <path>", "Project root when using --scope project")
  .option("--root <path>", "Override harness root")
  .option("--host <host>", "HTTP bind host")
  .option("--port <port>", "HTTP port or 'auto'")
  .option("--token-env <name>", "Environment variable containing the bearer token")
  .action(async (pluginPath: string, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      const result = await restartMcp({
        pluginPath,
        harness: options.harness,
        scope: options.scope,
        projectPath: options.project,
        root: options.root,
        host: options.host,
        port: parseMcpPortSelection(options.port),
        tokenEnv: options.tokenEnv,
      });
      console.log(formatMcpServeResult(result));
    } catch (error) {
      printCliError(error, "MCP restart error");
      process.exit(1);
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
      process.exit(1);
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
    process.exit(1);
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

type InstallCommandOptions = {
  all?: boolean;
  harness?: string;
  project?: string;
  scope: HarnessScope;
  overwrite?: boolean;
  backup?: boolean;
  validate?: boolean;
  dryRun?: boolean;
  compileRoot?: string;
  mcpLifecycle: CompileMcpLifecycleMode;
};

type NormalizedInstallOptions = InstallCommandOptions & {
  overwrite: boolean;
  backup: boolean;
  dryRun: boolean;
};

type InstallCommandContext = LoadedPlugin & {
  harnesses: HarnessId[];
  options: NormalizedInstallOptions;
};

type InvalidPluginManifest = {
  pluginPath: string;
  error: unknown;
};

type PluginRefreshResult = {
  pluginPath: string;
  name: string;
  success: boolean;
  operations: FileOperation[];
  errors: string[];
  backups: string[];
};

type PluginValidationResult = {
  valid: boolean;
  warnings: string[];
  skillName?: string;
  agentName?: string;
  errors: string[];
};

type InstallAllRefreshOptions = {
  harnesses: HarnessId[];
  scope: HarnessScope;
  projectPath?: string;
  compileRoot?: string;
  mcpLifecycle: CompileMcpLifecycleMode;
  validate?: boolean;
  dryRun: boolean;
  backup: boolean;
  overwrite: boolean;
};

async function runInstallCommand(
  pluginPath: string,
  rawOptions: InstallCommandOptions
): Promise<void> {
  const context = await loadInstallCommandContext(pluginPath, rawOptions);

  if (context.options.validate !== false) {
    const validation = await collectTargetedValidationResults(context);
    if (
      !printPluginValidationResult(validation.skillResults, validation.agentResults, {
        header: "\n❌ Plugin validation failed:\n",
        labelIndent: "   ",
        itemIndent: "      ",
        errorIndent: "         ",
      })
    ) {
      console.log("\nUse --no-validate to skip validation.");
      process.exit(1);
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
    dryRun: context.options.dryRun,
    backup: context.options.backup,
  });
  if (!compilePhase.success) {
    process.exit(1);
  }

  await planOrRunInstallCommand(context, compilePhase.backups);
}

async function loadInstallCommandContext(
  pluginPath: string,
  rawOptions: InstallCommandOptions
): Promise<InstallCommandContext> {
  const options = normalizeInstallCommandOptions(rawOptions);
  assertProjectPathForProjectScope(options.scope, options.project);
  const harnesses = resolveRequestedHarnesses(options);
  const manifest = await readManifest(pluginPath);

  console.log(`\n📦 Installing plugin: ${manifest.name} v${manifest.version}`);
  printPluginRefreshContext({
    manifest,
    harnesses,
    scope: options.scope,
    projectPath: options.project,
  });

  return { pluginPath, manifest, harnesses, options };
}

function normalizeInstallCommandOptions(
  options: InstallCommandOptions
): NormalizedInstallOptions {
  return {
    ...options,
    overwrite: options.overwrite ?? false,
    backup: options.backup ?? false,
    dryRun: options.dryRun ?? false,
    mcpLifecycle: options.mcpLifecycle ?? "none",
  };
}

async function collectTargetedValidationResults(context: InstallCommandContext): Promise<{
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

async function planOrRunInstallCommand(
  context: InstallCommandContext,
  compileBackups: string[]
): Promise<void> {
  const operations = await planInstallation({
    pluginPath: context.pluginPath,
    harnesses: context.harnesses,
    projectPath: context.options.project,
    overwrite: context.options.overwrite,
    backup: context.options.backup,
    dryRun: context.options.dryRun,
  });

  if (context.options.dryRun) {
    console.log("\n🔍 Dry run - operations that would be performed:\n");
    printOperations(operations);
    return;
  }

  const result = await install({
    pluginPath: context.pluginPath,
    harnesses: context.harnesses,
    projectPath: context.options.project,
    overwrite: context.options.overwrite,
    backup: context.options.backup,
    dryRun: false,
  });

  printInstallCommandResult(result.operations, result.backups, result.errors, compileBackups);
  if (result.errors.length > 0) {
    process.exit(1);
  }

  console.log("\n✅ Done!");
}

function printInstallCommandResult(
  operations: FileOperation[],
  backups: string[],
  errors: Array<{ operation: FileOperation; message: string }>,
  compileBackups: string[]
): void {
  if (operations.length > 0) {
    console.log("\n📋 Install:\n");
    printOperations(operations);
  }

  const allBackups = [...compileBackups, ...backups];
  if (allBackups.length > 0) {
    console.log("\n💾 Backups created:");
    for (const backup of allBackups) {
      console.log(`   ${backup}`);
    }
  }

  if (errors.length > 0) {
    console.log("\n❌ Errors:");
    for (const error of errors) {
      console.log(`   ${error.operation.target}: ${error.message}`);
    }
  }
}

async function requireInstallAllDirectory(expandedDir: string): Promise<void> {
  if (await exists(expandedDir)) return;

  console.error(`Directory not found: ${expandedDir}`);
  process.exit(1);
}

async function discoverPluginPaths(expandedDir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(expandedDir, { withFileTypes: true });
  const pluginPaths: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const potentialPluginPath = join(expandedDir, entry.name);
    const manifestPath = join(potentialPluginPath, "plugin.json");
    if (await exists(manifestPath)) {
      pluginPaths.push(potentialPluginPath);
    }
  }

  return pluginPaths;
}

function printInstallAllDiscovery(
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

function printInstallAllManifestResults(
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
  options: InstallAllRefreshOptions
): Promise<PluginRefreshResult[]> {
  const results: PluginRefreshResult[] = [];

  for (const plugin of validPlugins) {
    results.push(await refreshDiscoveredPlugin(plugin, options));
  }

  return results;
}

async function refreshDiscoveredPlugin(
  plugin: LoadedPlugin,
  options: InstallAllRefreshOptions
): Promise<PluginRefreshResult> {
  console.log(`\n📦 Installing plugin: ${plugin.manifest.name} v${plugin.manifest.version}`);
  printPluginRefreshContext({
    manifest: plugin.manifest,
    harnesses: options.harnesses,
    scope: options.scope,
    projectPath: options.projectPath,
    indent: "   ",
  });

  if (!(await validatePluginBeforeRefresh(plugin, options))) {
    return failedPluginRefresh(plugin, "Validation failed", []);
  }

  const compilePhase = await runCompilePhaseForPlugin({
    pluginPath: plugin.pluginPath,
    manifest: plugin.manifest,
    harnesses: options.harnesses,
    scope: options.scope,
    projectPath: options.projectPath,
    compileRoot: options.compileRoot,
    mcpLifecycle: options.mcpLifecycle,
    dryRun: options.dryRun,
    backup: options.backup,
  });

  if (!compilePhase.success) {
    return failedPluginRefresh(plugin, compilePhase.error, compilePhase.backups);
  }

  return planOrRunPluginInstall(plugin, options, compilePhase.backups);
}

async function validatePluginBeforeRefresh(
  plugin: LoadedPlugin,
  options: InstallAllRefreshOptions
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

  return printPluginValidationResult(skillResults, agentResults);
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

async function planOrRunPluginInstall(
  plugin: LoadedPlugin,
  options: InstallAllRefreshOptions,
  compileBackups: string[]
): Promise<PluginRefreshResult> {
  const operations = await planInstallation({
    pluginPath: plugin.pluginPath,
    harnesses: options.harnesses,
    projectPath: options.projectPath,
    overwrite: options.overwrite,
    backup: options.backup,
    dryRun: options.dryRun,
  });

  if (options.dryRun) {
    console.log("\n   🔍 Operations that would be performed:\n");
    printOperations(operations, "      ");
    return successfulPluginRefresh(plugin, operations, compileBackups);
  }

  const result = await install({
    pluginPath: plugin.pluginPath,
    harnesses: options.harnesses,
    projectPath: options.projectPath,
    overwrite: options.overwrite,
    backup: options.backup,
    dryRun: false,
  });

  printPluginInstallResult(result.operations, result.backups, result.errors, compileBackups);
  return {
    pluginPath: plugin.pluginPath,
    name: plugin.manifest.name,
    success: result.success,
    operations: result.operations,
    errors: result.errors.map((error) => `${error.operation.target}: ${error.message}`),
    backups: [...compileBackups, ...result.backups],
  };
}

function printPluginInstallResult(
  operations: FileOperation[],
  backups: string[],
  errors: Array<{ operation: FileOperation; message: string }>,
  compileBackups: string[]
): void {
  if (operations.length > 0) {
    console.log("\n   📋 Installation results:\n");
    printOperations(operations, "      ");
  }

  if (compileBackups.length + backups.length > 0) {
    console.log("\n   💾 Backups created:");
    for (const backup of [...compileBackups, ...backups]) {
      console.log(`      ${backup}`);
    }
  }

  if (errors.length > 0) {
    console.log("\n   ❌ Errors:");
    for (const error of errors) {
      console.log(`      ${error.operation.target}: ${error.message}`);
    }
  }
}

function failedPluginRefresh(
  plugin: LoadedPlugin,
  error: string,
  backups: string[]
): PluginRefreshResult {
  return {
    pluginPath: plugin.pluginPath,
    name: plugin.manifest.name,
    success: false,
    operations: [],
    errors: [error],
    backups,
  };
}

function successfulPluginRefresh(
  plugin: LoadedPlugin,
  operations: FileOperation[],
  backups: string[]
): PluginRefreshResult {
  return {
    pluginPath: plugin.pluginPath,
    name: plugin.manifest.name,
    success: true,
    operations,
    errors: [],
    backups,
  };
}

function printInstallAllSummary(options: {
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
    console.log(`      • ${result.name}: ${result.errors.join(", ")}`);
  }
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

/**
 * Print operations in a readable format
 */
function printOperations(operations: FileOperation[], indent = ""): void {
  const byHarness = new Map<HarnessId, FileOperation[]>();

  for (const op of operations) {
    const list = byHarness.get(op.harness) || [];
    list.push(op);
    byHarness.set(op.harness, list);
  }

  for (const [harness, ops] of byHarness) {
    console.log(`${indent}   ${harness}:`);
    for (const op of ops) {
      // Determine if this is an "update" (append with "Updating existing section" reason)
      const isUpdate = op.type === "append" && op.reason === "Updating existing section";
      const icon =
        op.type === "copy"
          ? "📄"
          : op.type === "append"
            ? isUpdate ? "🔄" : "📝"
            : op.type === "skip"
              ? "⏭️"
              : "🔀";
      const displayType = isUpdate ? "update" : op.type;
      const status = op.type === "skip" || isUpdate ? ` (${op.reason})` : "";
      console.log(`${indent}      ${icon} ${displayType.padEnd(6)} ${op.artifact}: ${op.target}${status}`);
    }
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
        process.exit(1);
      }
    }

    return harnesses as HarnessId[];
  }

  console.error("Please specify --harness <ids> or --all");
  process.exit(1);
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

async function runCompilePhaseForPlugin(options: {
  pluginPath: string;
  manifest: PluginManifest;
  harnesses: HarnessId[];
  scope: HarnessScope;
  projectPath?: string;
  compileRoot?: string;
  mcpLifecycle: CompileMcpLifecycleMode;
  dryRun: boolean;
  backup: boolean;
  indent?: string;
}): Promise<
  | { success: true; backups: string[] }
  | { success: false; backups: string[]; error: string }
> {
  const indent = options.indent ?? "";
  const compileBackups: string[] = [];

  for (const harnessId of options.harnesses) {
    if (!manifestHasCompileTargets(options.manifest, harnessId)) continue;

    const compileExit = await Effect.runPromiseExit(
      compilePluginForTarget({
        pluginPath: expandPath(options.pluginPath),
        target: harnessId,
        scope: options.scope,
        projectPath: options.projectPath,
        root: options.compileRoot,
        dryRun: options.dryRun,
        backup: options.backup,
        mcpLifecycle: options.mcpLifecycle,
      })
    );

    if (compileExit._tag === "Failure") {
      const error = `Compile failed for ${harnessId}: ${renderCompileError(compileExit.cause)}`;
      console.log(`\n${indent}❌ ${error}`);
      return {
        success: false,
        backups: compileBackups,
        error,
      };
    }

    console.log(`\n${indent}🛠  Compile (${harnessId}, ${compileExit.value.scope}):`);
    console.log(`${indent}   Root: ${compileExit.value.outputRoot}`);
    console.log(
      `${indent}   Built: ${
        compileExit.value.built.length > 0 ? compileExit.value.built.join(", ") : "(none)"
      }`
    );
    console.log(
      `${indent}   From cache: ${
        compileExit.value.fromCache.length > 0
          ? compileExit.value.fromCache.join(", ")
          : "(none)"
      }`
    );
    if (compileExit.value.lockfilePath) {
      console.log(`${indent}   Lockfile: ${compileExit.value.lockfilePath}`);
    }
    const operationText = formatOperations(compileExit.value.operations);
    if (operationText.trim().length > 0) {
      console.log(indentBlock(operationText, indent.length > 0 ? `${indent}   ` : ""));
    }
    compileBackups.push(...compileExit.value.backups);
  }

  return { success: true, backups: compileBackups };
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

function parseMcpPortSelection(value: string | undefined): McpPortSelection | undefined {
  if (value === undefined) return undefined;
  if (value === "auto") return "auto";

  const port = Number(value);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;

  throw new InvalidArgumentError("--port must be 'auto' or an integer from 1 to 65535.");
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
    throw new Error("Project-local scope requires --project <path>");
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

const COMPILE_ERROR_TAGS = new Set([
  "SourceParseError",
  "UnknownReferenceError",
  "UnknownTargetError",
  "InvalidTargetScopeError",
  "DuplicateNameError",
  "BundleNameMismatchError",
  "MissingTargetResolutionError",
  "UnknownDependencyError",
  "DependencyCycleError",
  "PluginManifestError",
]);

function renderCompileError(cause: unknown): string {
  let rendered: string | undefined;
  const walk = (node: unknown): void => {
    if (rendered) return;
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n._tag === "Die" && n.defect instanceof Error) {
      rendered = n.defect.stack ?? n.defect.message;
      return;
    }
    if (n._tag === "Die" && n.defect !== undefined) {
      rendered =
        typeof n.defect === "string"
          ? n.defect
          : JSON.stringify(n.defect, Object.getOwnPropertyNames(n.defect), 2);
      return;
    }
    if (typeof n._tag === "string" && COMPILE_ERROR_TAGS.has(n._tag)) {
      rendered = formatCompileError(n as unknown as CompileError);
      return;
    }
    for (const value of Object.values(n)) {
      walk(value);
    }
  };
  walk(cause);
  return rendered ?? (cause instanceof Error ? cause.message : JSON.stringify(cause, null, 2));
}

function printCliError(error: unknown, fallbackLabel: string): void {
  if (error instanceof PluginManifestError) {
    console.error(`\n❌ ${fallbackLabel}:\n`);
    console.error(indentBlock(formatManifestLoadError(error.pluginPath, error), "   "));
    return;
  }

  console.error(`\n❌ ${fallbackLabel}: ${error instanceof Error ? error.message : error}`);
}

program.parse();
