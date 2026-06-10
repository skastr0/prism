#!/usr/bin/env bun
/**
 * prism CLI - Unified plugin distribution for AI coding harnesses
 */

import { Command, InvalidArgumentError } from "commander";
import { Effect } from "effect";
import {
  getAllHarnessIds,
  getHarness,
  isValidHarnessId,
  resolveHarnessRoot,
} from "./harnesses.js";
import { install, planInstallation } from "./installer.js";
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
} from "./errors.js";
import { EXIT_CODES, exitWith } from "./exit.js";
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
import { readHarnessLedger } from "./managed-ledger.js";
import { resolvePrismHome } from "./prism-home.js";
import {
  formatPackageOperations,
  packagePluginForTarget,
} from "./packager.js";

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
  .option("--no-validate", "Skip plugin validation before install")
  .option("--dry-run", "Preview operations without executing", false)
  .option("--compile-root <path>", "Override compile output root")
  .option(
    "--mcp-lifecycle <mode>",
    "Generated HTTP MCP lifecycle behavior during compile (none|verify|serve)",
    parseMcpLifecycleMode,
    "serve"
  )
  .action(async (pluginPath: string, options) => {
    try {
      await runInstallCommand(pluginPath, options);
    } catch (error) {
      printCliError(error, "Error");
      exitWith(EXIT_CODES.domainFailure);
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
  .option("--no-validate", "Skip plugin validation before install")
  .option("--dry-run", "Preview operations without executing", false)
  .option("--compile-root <path>", "Override compile output root")
  .option(
    "--mcp-lifecycle <mode>",
    "Generated HTTP MCP lifecycle behavior during compile (none|verify|serve)",
    parseMcpLifecycleMode,
    "serve"
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
        exitWith(EXIT_CODES.domainFailure);
      }

      console.log("\n✅ All plugin refreshes completed successfully!");
    } catch (error) {
      printCliError(error, "Error");
      exitWith(EXIT_CODES.domainFailure);
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
    "Target harness ID ('opencode', 'claude-code', 'antigravity-cli', 'codex-cli', 'amp-code', 'hermes', 'grok', 'factory-droid', 'pi', or 'kimi-code')",
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
  .option("--root <path>", "Override harness output root")
  .option(
    "--mcp-lifecycle <mode>",
    "Generated HTTP MCP lifecycle behavior (none|verify|serve)",
    parseMcpLifecycleMode,
    "serve"
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
        prismHome: resolvePrismHome(),
        dryRun: options.dryRun,
        mcpLifecycle: options.mcpLifecycle,
      });

      const exit = await Effect.runPromiseExit(program);

      if (exit._tag === "Failure") {
        console.error(`\n❌ Compile failed:`);
        console.error(indentBlock(renderPrismCause(exit.cause), "   "));
        exitWith(EXIT_CODES.domainFailure);
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
  .option("--host <host>", "HTTP bind host")
  .option("--port <port>", "HTTP port or 'auto'")
  .option("--token-env <name>", "Environment variable name used by the generated MCP server")
  .option("--foreground", "Run the generated server in the current process group", false)
  .action(async (pluginPath: string, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      const result = await serveMcp({
        pluginPath,
        harness: options.harness,
        scope: options.scope,
        projectPath: options.project,
        prismHome: resolvePrismHome(),
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
  .option("--token-env <name>", "Environment variable name used by the generated MCP server")
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
          tokenEnv: options.tokenEnv,
        });
        console.log(formatMcpStatus(status));
        return;
      }

      const statuses = await listMcpStatuses({
        harness: options.harness,
        scope: options.scope,
        projectPath: options.project,
        prismHome: resolvePrismHome(),
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
  .option("--token-env <name>", "Environment variable name used by the generated MCP server")
  .action(async (pluginPath: string, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      const result = await stopMcp({
        pluginPath,
        harness: options.harness,
        scope: options.scope,
        projectPath: options.project,
        prismHome: resolvePrismHome(),
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
  .option("--host <host>", "HTTP bind host")
  .option("--port <port>", "HTTP port or 'auto'")
  .option("--token-env <name>", "Environment variable name used by the generated MCP server")
  .action(async (pluginPath: string, options) => {
    try {
      assertProjectPathForProjectScope(options.scope, options.project);
      const result = await restartMcp({
        pluginPath,
        harness: options.harness,
        scope: options.scope,
        projectPath: options.project,
        prismHome: resolvePrismHome(),
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
  scope?: HarnessScope;
  overwrite?: boolean;
  validate?: boolean;
  dryRun?: boolean;
  compileRoot?: string;
  mcpLifecycle?: CompileMcpLifecycleMode;
};

type NormalizedInstallOptions = {
  all?: boolean;
  harness?: string;
  project?: string;
  scope: HarnessScope;
  overwrite: boolean;
  validate?: boolean;
  dryRun: boolean;
  compileRoot?: string;
  mcpLifecycle: CompileMcpLifecycleMode;
};

type InstallCommandContext = LoadedPlugin & {
  harnesses: HarnessId[];
  options: NormalizedInstallOptions;
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
  operations: FileOperation[];
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

type InstallAllRefreshOptions = {
  harnesses: HarnessId[];
  scope: HarnessScope;
  projectPath?: string;
  compileRoot?: string;
  mcpLifecycle: CompileMcpLifecycleMode;
  validate?: boolean;
  dryRun: boolean;
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
    dryRun: context.options.dryRun,
  });
  if (!compilePhase.success) {
    exitWith(EXIT_CODES.domainFailure);
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
    scope: options.scope ?? "global",
    overwrite: options.overwrite ?? false,
    dryRun: options.dryRun ?? false,
    mcpLifecycle: options.mcpLifecycle ?? "serve",
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
    dryRun: false,
  });

  printInstallCommandResult(result.operations, result.backups, result.errors, compileBackups);
  if (result.errors.length > 0) {
    exitWith(EXIT_CODES.domainFailure);
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
  exitWith(EXIT_CODES.usage);
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
    dryRun: options.dryRun,
  });

  if (!compilePhase.success) {
    return failedPluginRefresh(plugin, compilePhase.failure, compilePhase.backups);
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
    dryRun: false,
  });

  printPluginInstallResult(result.operations, result.backups, result.errors, compileBackups);
  return {
    pluginPath: plugin.pluginPath,
    name: plugin.manifest.name,
    success: result.success,
    operations: result.operations,
    errors: result.errors.map((error) => ({
      harness: error.operation.harness,
      path: error.operation.target,
      headline: error.message,
    })),
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
  failure: RefreshFailure,
  backups: string[]
): PluginRefreshResult {
  return {
    pluginPath: plugin.pluginPath,
    name: plugin.manifest.name,
    success: false,
    operations: [],
    errors: [failure],
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
      const isUpdate = isRuleSectionUpdate(op);
      const icon = operationIcon(op, isUpdate);
      const displayType = operationDisplayType(op, isUpdate);
      const status = operationStatus(op, isUpdate);
      console.log(`${indent}      ${icon} ${displayType.padEnd(6)} ${op.artifact}: ${op.target}${status}`);
    }
  }
}

const isRuleSectionUpdate = (op: FileOperation): boolean =>
  op.type === "append" && op.reason === "Updating existing section";

const operationIcon = (op: FileOperation, isUpdate: boolean): string => {
  switch (op.type) {
    case "copy":
      return "📄";
    case "append":
      return isUpdate ? "🔄" : "📝";
    case "skip":
      return "⏭️";
    case "prune":
      return "🧹";
    case "drift":
      return "⚠️";
    case "merge":
      return "🔀";
  }
};

const operationDisplayType = (op: FileOperation, isUpdate: boolean): string =>
  isUpdate ? "update" : op.type;

const operationStatus = (op: FileOperation, isUpdate: boolean): string => {
  if (isUpdate) return ` (${op.reason})`;
  switch (op.type) {
    case "skip":
    case "prune":
    case "drift":
      return ` (${op.reason})`;
    case "copy":
    case "append":
    case "merge":
      return "";
  }
};

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

async function runCompilePhaseForPlugin(options: {
  pluginPath: string;
  manifest: PluginManifest;
  harnesses: HarnessId[];
  scope: HarnessScope;
  projectPath?: string;
  compileRoot?: string;
  mcpLifecycle: CompileMcpLifecycleMode;
  dryRun: boolean;
  indent?: string;
}): Promise<
  | { success: true; backups: string[] }
  | { success: false; backups: string[]; failure: RefreshFailure }
> {
  const indent = options.indent ?? "";
  const compileBackups: string[] = [];

  for (const harnessId of options.harnesses) {
    if (!(await shouldRunCompilePhaseForHarness(options, harnessId))) continue;

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
      })
    );

    if (compileExit._tag === "Failure") {
      const described = describePrismCause(compileExit.cause);
      console.log(`\n${indent}❌ Compile failed for ${harnessId}: ${described.headline}`);
      for (const detail of described.detail ?? []) {
        console.log(`${indent}   ${detail}`);
      }
      if (described.hint) {
        console.log(`${indent}   hint: ${described.hint}`);
      }
      return {
        success: false,
        backups: compileBackups,
        failure: {
          harness: harnessId,
          ...(described.path ? { path: described.path } : {}),
          headline: described.headline,
          ...(described.hint ? { hint: described.hint } : {}),
        },
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

const LOWERER_OWNED_STALE_CONFIG_CLEANUP_HARNESSES = new Set<HarnessId>(["cursor"]);

const compileOutputRootForHarness = (options: {
  readonly harnessId: HarnessId;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly compileRoot?: string;
}): string | null =>
  options.compileRoot
    ? expandPath(options.compileRoot)
    : resolveHarnessRoot(getHarness(options.harnessId), options.scope, options.projectPath);

const hasLowererOwnedStaleCompileConfig = async (options: {
  readonly manifest: PluginManifest;
  readonly harnessId: HarnessId;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly compileRoot?: string;
}): Promise<boolean> => {
  if (!LOWERER_OWNED_STALE_CONFIG_CLEANUP_HARNESSES.has(options.harnessId)) {
    return false;
  }

  const outputRoot = compileOutputRootForHarness(options);
  if (!outputRoot) return false;

  const normalizedRoot = expandPath(outputRoot);
  const ledger = await readHarnessLedger(options.harnessId);
  return ledger.entries.some(
    (entry) =>
      entry.pluginName === options.manifest.name &&
      entry.artifact === "compile" &&
      entry.kind === "config" &&
      entry.scope === options.scope &&
      expandPath(entry.root) === normalizedRoot,
  );
};

const shouldRunCompilePhaseForHarness = async (
  options: {
    readonly manifest: PluginManifest;
    readonly scope: HarnessScope;
    readonly projectPath?: string;
    readonly compileRoot?: string;
  },
  harnessId: HarnessId,
): Promise<boolean> =>
  manifestHasCompileTargets(options.manifest, harnessId) ||
  await hasLowererOwnedStaleCompileConfig({ ...options, harnessId });

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

function printCliError(error: unknown, fallbackLabel: string): void {
  if (error instanceof PluginManifestError) {
    console.error(`\n❌ ${fallbackLabel}:\n`);
    console.error(indentBlock(formatManifestLoadError(error.pluginPath, error), "   "));
    return;
  }

  console.error(`\n❌ ${fallbackLabel}: ${error instanceof Error ? error.message : error}`);
}

program.parse();
