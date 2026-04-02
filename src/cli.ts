#!/usr/bin/env bun
/**
 * agentpkg CLI - Unified plugin distribution for AI coding harnesses
 */

import { Command } from "commander";
import { getAllHarnessIds, getHarness, isValidHarnessId } from "./harnesses.js";
import { install, planInstallation } from "./installer.js";
import {
  formatManifestTargets,
  PluginManifestError,
  readManifest,
  validatePluginSkills,
  validatePluginAgents,
  manifestTargetsHarness,
} from "./manifest.js";
import { ensureDir, exists, expandPath, writeFile } from "./fs.js";
import type { FileOperation, HarnessId, PluginManifest, PluginManifestTargets } from "./types.js";
import { basename, join } from "node:path";

const program = new Command();

program
  .name("agentpkg")
  .description("Unified plugin distribution for AI coding harnesses")
  .version("0.1.0");

// Install command
program
  .command("install <plugin-path>")
  .description("Install a plugin to one or more harnesses")
  .option("--harness <harnesses>", "Comma-separated list of harness IDs")
  .option("--all", "Install to all supported harnesses")
  .option("-p, --project <path>", "Project path for project-specific rules")
  .option("--overwrite", "Overwrite existing files", false)
  .option("--no-backup", "Skip creating backups")
  .option("--no-validate", "Skip plugin validation before install")
  .option("--dry-run", "Preview operations without executing", false)
  .action(async (pluginPath: string, options) => {
    try {
      // Determine requested harness IDs
      let harnesses: HarnessId[];
      if (options.all) {
        harnesses = getAllHarnessIds();
      } else if (options.harness) {
        harnesses = options.harness.split(",").map((value: string) => value.trim());
        for (const harness of harnesses) {
          if (!isValidHarnessId(harness)) {
            console.error(`Unknown harness ID: ${harness}`);
            console.error(`Valid harness IDs: ${getAllHarnessIds().join(", ")}`);
            process.exit(1);
          }
        }
      } else {
        console.error("Please specify --harness <ids> or --all");
        process.exit(1);
      }

      // Read manifest to show info
      const manifest = await readManifest(pluginPath);
      
      // Filter requested harnesses to only those supported by the plugin
      const matchingHarnesses = harnesses.filter((id) =>
        manifestTargetsHarness(manifest, id as HarnessId)
      );
      
      console.log(`\n📦 Installing plugin: ${manifest.name} v${manifest.version}`);
      console.log(`   Manifest targets: ${formatManifestTargets(manifest)}`);
      console.log(`   Matching requested harnesses: ${matchingHarnesses.length > 0 ? matchingHarnesses.join(", ") : "None (check plugin.json)"}`);

      if (options.project) {
        console.log(`   Project: ${options.project}`);
      }

      // Validate plugin before installation (unless --no-validate)
      if (options.validate !== false) {
        const skillResults = await validatePluginSkills(pluginPath);
        const agentResults = await validatePluginAgents(pluginPath);
        const hasSkillErrors = skillResults.some((r) => !r.valid);
        const hasAgentErrors = agentResults.some((r) => !r.valid);

        if (hasSkillErrors || hasAgentErrors) {
          console.log("\n❌ Plugin validation failed:\n");
          
          if (hasSkillErrors) {
            console.log("   Skills:");
            for (const result of skillResults) {
              if (!result.valid) {
                console.log(`      ${result.skillName || "(unknown skill)"}:`);
                for (const error of result.errors) {
                  console.log(`         • ${error}`);
                }
              }
            }
          }
          
          if (hasAgentErrors) {
            console.log("   Agents:");
            for (const result of agentResults) {
              if (!result.valid) {
                console.log(`      ${result.agentName || "(unknown agent)"}:`);
                for (const error of result.errors) {
                  console.log(`         • ${error}`);
                }
              }
            }
          }
          
          console.log("\nUse --no-validate to skip validation.");
          process.exit(1);
        }
      }

      // Plan installation
      const operations = await planInstallation({
        pluginPath,
        harnesses: harnesses as HarnessId[],
        projectPath: options.project,
        overwrite: options.overwrite,
        backup: options.backup !== false,
        dryRun: options.dryRun,
      });

      if (options.dryRun) {
        console.log("\n🔍 Dry run - operations that would be performed:\n");
        printOperations(operations);
        return;
      }

      // Execute installation
      const result = await install({
        pluginPath,
        harnesses: harnesses as HarnessId[],
        projectPath: options.project,
        overwrite: options.overwrite,
        backup: options.backup !== false,
        dryRun: false,
      });

      // Print results
      console.log("\n📋 Installation complete:\n");
      printOperations(result.operations);

      if (result.backups.length > 0) {
        console.log("\n💾 Backups created:");
        for (const backup of result.backups) {
          console.log(`   ${backup}`);
        }
      }

      if (result.errors.length > 0) {
        console.log("\n❌ Errors:");
        for (const error of result.errors) {
          console.log(`   ${error.operation.target}: ${error.message}`);
        }
        process.exit(1);
      }

      console.log("\n✅ Done!");
    } catch (error) {
      printCliError(error, "Error");
      process.exit(1);
    }
  });

// Install-all command - discover and install all plugins in a directory
program
  .command("install-all <directory>")
  .description("Discover and install all plugins found in a directory (shallow scan)")
  .option("--harness <harnesses>", "Comma-separated list of harness IDs")
  .option("--all", "Install to all supported harnesses")
  .option("-p, --project <path>", "Project path for project-specific rules")
  .option("--overwrite", "Overwrite existing files", false)
  .option("--no-backup", "Skip creating backups")
  .option("--no-validate", "Skip plugin validation before install")
  .option("--dry-run", "Preview operations without executing", false)
  .action(async (directory: string, options) => {
    try {
      // Determine requested harness IDs
      let harnesses: HarnessId[];
      if (options.all) {
        harnesses = getAllHarnessIds();
      } else if (options.harness) {
        harnesses = options.harness.split(",").map((value: string) => value.trim());
        for (const harness of harnesses) {
          if (!isValidHarnessId(harness)) {
            console.error(`Unknown harness ID: ${harness}`);
            console.error(`Valid harness IDs: ${getAllHarnessIds().join(", ")}`);
            process.exit(1);
          }
        }
      } else {
        console.error("Please specify --harness <ids> or --all");
        process.exit(1);
      }

      const expandedDir = expandPath(directory);

      // Check directory exists
      if (!(await exists(expandedDir))) {
        console.error(`Directory not found: ${expandedDir}`);
        process.exit(1);
      }

      // Discover plugins (shallow scan - only first level directories)
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(expandedDir, { withFileTypes: true });
      const pluginPaths: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const potentialPluginPath = join(expandedDir, entry.name);
          const manifestPath = join(potentialPluginPath, "plugin.json");
          if (await exists(manifestPath)) {
            pluginPaths.push(potentialPluginPath);
          }
        }
      }

      if (pluginPaths.length === 0) {
        console.log(`\n📂 No plugins found in ${expandedDir}`);
        console.log("   (Looking for directories containing plugin.json)");
        return;
      }

      console.log(`\n📂 Found ${pluginPaths.length} plugin(s) in ${expandedDir}:`);

      const validPlugins: { pluginPath: string; manifest: PluginManifest }[] = [];
      const invalidPlugins: { pluginPath: string; error: unknown }[] = [];

      for (const pluginPath of pluginPaths) {
        try {
          const manifest = await readManifest(pluginPath);
          validPlugins.push({ pluginPath, manifest });
        } catch (error) {
          invalidPlugins.push({ pluginPath, error });
        }
      }

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

      // Track results across all plugins
      const results: {
        pluginPath: string;
        name: string;
        success: boolean;
        operations: FileOperation[];
        errors: string[];
        backups: string[];
      }[] = [];

      // Process each plugin
      for (const { pluginPath, manifest } of validPlugins) {
        // Filter requested harnesses to only those supported by the plugin
        const matchingHarnesses = harnesses.filter((id) =>
          manifestTargetsHarness(manifest, id as HarnessId)
        );
        
        console.log(`\n📦 Installing plugin: ${manifest.name} v${manifest.version}`);
        console.log(`   Manifest targets: ${formatManifestTargets(manifest)}`);
        console.log(`   Matching requested harnesses: ${matchingHarnesses.length > 0 ? matchingHarnesses.join(", ") : "None (check plugin.json)"}\n`);

        if (options.project) {
          console.log(`   Project: ${options.project}`);
        }

        // Validate plugin before installation (unless --no-validate)
        if (options.validate !== false) {
          const skillResults = await validatePluginSkills(pluginPath);
          const agentResults = await validatePluginAgents(pluginPath);
          const hasSkillErrors = skillResults.some((r) => !r.valid);
          const hasAgentErrors = agentResults.some((r) => !r.valid);

          if (hasSkillErrors || hasAgentErrors) {
            console.log("\n   ❌ Validation failed:\n");
            
            if (hasSkillErrors) {
              console.log("      Skills:");
              for (const result of skillResults) {
                if (!result.valid) {
                  console.log(`         ${result.skillName || "(unknown skill)"}:`);
                  for (const error of result.errors) {
                    console.log(`            • ${error}`);
                  }
                }
              }
            }
            
            if (hasAgentErrors) {
              console.log("      Agents:");
              for (const result of agentResults) {
                if (!result.valid) {
                  console.log(`         ${result.agentName || "(unknown agent)"}:`);
                  for (const error of result.errors) {
                    console.log(`            • ${error}`);
                  }
                }
              }
            }
            
            results.push({
              pluginPath,
              name: manifest.name,
              success: false,
              operations: [],
              errors: ["Validation failed"],
              backups: [],
            });
            continue;
          }
        }

        // Plan installation
        const operations = await planInstallation({
          pluginPath,
          harnesses: harnesses as HarnessId[],
          projectPath: options.project,
          overwrite: options.overwrite,
          backup: options.backup !== false,
          dryRun: options.dryRun,
        });

        if (options.dryRun) {
          console.log("\n   🔍 Operations that would be performed:\n");
          printOperations(operations, "      ");
          results.push({
            pluginPath,
            name: manifest.name,
            success: true,
            operations,
            errors: [],
            backups: [],
          });
          continue;
        }

        // Execute installation
        const result = await install({
          pluginPath,
          harnesses: harnesses as HarnessId[],
          projectPath: options.project,
          overwrite: options.overwrite,
          backup: options.backup !== false,
          dryRun: false,
        });

        results.push({
          pluginPath,
          name: manifest.name,
          success: result.success,
          operations: result.operations,
          errors: result.errors.map((e) => `${e.operation.target}: ${e.message}`),
          backups: result.backups,
        });

        // Print results for this plugin
        if (result.operations.length > 0) {
          console.log("\n   📋 Installation results:\n");
          printOperations(result.operations, "      ");
        }

        if (result.backups.length > 0) {
          console.log("\n   💾 Backups created:");
          for (const backup of result.backups) {
            console.log(`      ${backup}`);
          }
        }

        if (result.errors.length > 0) {
          console.log("\n   ❌ Errors:");
          for (const error of result.errors) {
            console.log(`      ${error.operation.target}: ${error.message}`);
          }
        }
      }

      // Print summary
      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;

      console.log("\n" + "─".repeat(60));
      console.log("\n📊 Summary:");
      console.log(`   Total discovered plugins: ${pluginPaths.length}`);
      console.log(`   Valid manifests: ${validPlugins.length}`);
      if (invalidPlugins.length > 0) {
        console.log(`   Invalid manifests: ${invalidPlugins.length}`);
      }
      console.log(`   Successful installs: ${successCount}`);
      if (failCount > 0) {
        console.log(`   Failed installs: ${failCount}`);
        for (const r of results.filter((r) => !r.success)) {
          console.log(`      • ${r.name}: ${r.errors.join(", ")}`);
        }
      }

      if (invalidPlugins.length > 0) {
        console.log("   Invalid plugin manifests:");
        for (const { pluginPath, error } of invalidPlugins) {
          console.log(`      • ${getManifestErrorLabel(pluginPath, error)}`);
        }
      }

      if (failCount > 0 || invalidPlugins.length > 0) {
        console.log("\n⚠️  Some plugins failed validation or install");
        process.exit(1);
      } else {
        console.log("\n✅ All plugins installed successfully!");
      }
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

      // Create directory structure
      await ensureDir(targetDir);
      await ensureDir(join(targetDir, "rules", "global"));
      await ensureDir(join(targetDir, "rules", "project"));
      await ensureDir(join(targetDir, "commands"));
      await ensureDir(join(targetDir, "agents"));

      // Create plugin.json
      const manifestTargets: PluginManifestTargets = {};
      if (!options.minimal) {
        manifestTargets.rules = ["coding-harness"];
        manifestTargets.commands = [
          "claude-code",
          "opencode",
          "codex-cli",
          "gemini-cli",
          "cursor",
          "factory-droid",
        ];
      }
      if (options.withAgent) {
        manifestTargets.agents = ["claude-code", "opencode"];
      }
      if (options.withSkill) {
        manifestTargets.skills = ["coding-harness", "claw-harness"];
      }

      const manifest = {
        name,
        version: "0.1.0",
        description: `${name} plugin for AI coding harnesses`,
        targets: manifestTargets,
      };
      await writeFile(
        join(targetDir, "plugin.json"),
        JSON.stringify(manifest, null, 2)
      );

      const created: string[] = ["plugin.json"];

      if (!options.minimal) {
        // Create example global rule
        const exampleRule = `---
description: Example coding guidelines
# No file-level targets. Install targeting lives in plugin.json -> targets.rules
---

# Coding Guidelines

- Write clean, readable code
- Add comments for complex logic
- Follow project conventions
`;
        await writeFile(join(targetDir, "rules", "global", "example.md"), exampleRule);
        created.push("rules/global/example.md");

        // Create example command with proper argument usage
        const exampleCommand = `---
description: Run tests with coverage
# No file-level targets. Install targeting lives in plugin.json -> targets.commands

# Agent-specific overrides:
# claude-code:
#   allowed-tools: [Bash]
# opencode:
#   mode: subagent
---

# Run Tests

**Test configuration:** $ARGUMENTS

Run the test suite with coverage reporting.

## Arguments

- \`$ARGUMENTS\` - The full test configuration or filter string provided by the user

## Usage Examples

\`\`\`bash
/test                           # Run all tests
/test src/utils                 # Run tests matching pattern
/test src/utils --watch         # Pattern with flag
\`\`\`

## Instructions

1. Run tests using the provided configuration: $ARGUMENTS
2. If the configuration is empty, run all tests
3. Generate coverage report
4. Highlight failures with clear explanations
`;
        await writeFile(join(targetDir, "commands", "test.md"), exampleCommand);
        created.push("commands/test.md");
      }

      // Create example agent if requested
      if (options.withAgent) {
        const exampleAgent = `---
description: Code reviewer that focuses on best practices
# No file-level targets. Install targeting lives in plugin.json -> targets.agents

# Claude Code specific
claude-code:
  model: sonnet

# OpenCode specific  
opencode:
  mode: subagent
  model: anthropic/claude-sonnet-4-20250514
  temperature: 0.1
  tools:
    write: false
    edit: false
---

You are a code review specialist. Your role is to:

1. Review code for potential bugs and issues
2. Check for security vulnerabilities
3. Suggest performance improvements
4. Ensure code follows best practices
5. Verify proper error handling

When reviewing:
- Be constructive and specific
- Provide examples of improvements
- Prioritize issues by severity
- Acknowledge good patterns you see

You have READ-ONLY access. Do not modify files directly.
`;
        await writeFile(join(targetDir, "agents", "reviewer.md"), exampleAgent);
        created.push("agents/reviewer.md");
      }

      // Create example skill if requested
      if (options.withSkill) {
        await ensureDir(join(targetDir, "skills", "example-skill", "references"));
        await ensureDir(join(targetDir, "skills", "example-skill", "scripts"));
        await ensureDir(join(targetDir, "skills", "example-skill", "assets"));

        const skillMd = `---
name: example-skill
description: Use this skill when users need help with [specific task or workflow]. Be explicit about when it should and should not trigger.
# compatibility: Requires Python 3.11+ for optional helper scripts
---

# Example Skill

A minimal skill scaffold showing progressive disclosure and eval-friendly instructions.

## Use This Skill For

- [Primary task the skill should handle]
- [Closely related task that should still trigger the skill]

## Do Not Use This Skill For

- [Nearby task that looks similar but needs a different skill]
- [Simple one-off request that does not need the full workflow]

## Workflow

1. Inspect the input and confirm the requested outcome.
2. Follow the documented process for the task.
3. Verify the final output before returning it.

## Resources

- Read \`references/domain-guide.md\` when you need domain-specific rules, examples, or edge cases.
- Add deterministic helpers to \`scripts/\` when instructions alone are not enough.
- Put reusable templates, sample inputs, or brand assets in \`assets/\`.
`;
        await writeFile(join(targetDir, "skills", "example-skill", "SKILL.md"), skillMd);
        await writeFile(
          join(targetDir, "skills", "example-skill", "references", "domain-guide.md"),
          `# Domain Guide

Use this file for detailed rules, examples, and edge cases that should not live in \`SKILL.md\`.

## Example Sections

- Input formats the skill supports
- Output conventions the skill must follow
- Common failure modes and how to recover
`
        );
        created.push("skills/example-skill/SKILL.md");
        created.push("skills/example-skill/references/domain-guide.md");
      }

      // Create README
      const readme = `# ${name}

A harness-aware plugin for AI coding harnesses.

Use \`plugin.json\` to declare per-artifact harness targets. Do not add file-level install targets to individual markdown files.

## Structure

\`\`\`
${name}/
├── plugin.json          # Manifest with per-artifact harness targets
├── rules/
│   ├── global/          # Shared rules appended to targeted global rules files
│   └── project/         # Shared project rules copied when --project is set
├── commands/            # Shared slash commands
├── agents/              # Shared custom agent definitions
├── skills/
│   └── example-skill/
│       ├── SKILL.md     # Main instructions + frontmatter
│       ├── references/  # Additional docs loaded as needed
│       ├── scripts/     # Optional deterministic helpers
│       └── assets/      # Templates, sample inputs, brand files
└── harness/             # Optional harness-specific overlays
    └── <id>/            # e.g. opencode, openclaw
\`\`\`

## Targeting model

Install targeting lives only in \`plugin.json\`.

\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`

- Use per-artifact \`targets\` entries to decide which harnesses receive rules, commands, agents, and skills.
- Use presets like \`coding-harness\` and \`claw-harness\` when they match the supported surface for that artifact.
- Do not add file-level \`targets:\` blocks to individual markdown files; frontmatter is for descriptions and harness-specific settings.

## Harness overlays

Use \`harness/<id>/...\` when one harness needs a different file than the shared default.

\`\`\`text
harness/
├── opencode/
│   └── commands/
│       └── test.md
└── openclaw/
    └── skills/
        └── example-skill/
            └── SKILL.md
\`\`\`

Matching overlay files replace shared files for that harness. Non-overridden files still come from the shared artifact directories.

## Installation

\`\`\`bash
# Install to all harnesses
agentpkg install ./${name} --all

# Install to specific harness IDs
agentpkg install ./${name} --harness claude-code,opencode,openclaw

# Install with project context
agentpkg install ./${name} --all --project ~/code/my-project

# Preview without installing
agentpkg install ./${name} --all --dry-run
\`\`\`

## Validation

\`\`\`bash
# Validate plugin structure and skill frontmatter
agentpkg validate ./${name}
\`\`\`

## Harness notes

- See \`agentpkg harnesses\` for the current harness support matrix.
- OpenClaw v1 installs shared skill files plus matching \`harness/openclaw/skills/...\` overlays into \`~/.openclaw/skills/\`.
- OpenClaw v1 does not install rules, commands, or custom agents.
`;
      await writeFile(join(targetDir, "README.md"), readme);
      created.push("README.md");

      console.log("Created:");
      for (const file of created) {
        console.log(`   ${file}`);
      }
      console.log("\n✅ Plugin created successfully!");
      console.log(`\nNext steps:`);
      console.log(`   cd ${name}`);
      console.log(`   agentpkg install . --all --dry-run`);
    } catch (error) {
      printCliError(error, "Error");
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
      let hasErrors = false;
      let hasWarnings = false;

      // Validate manifest
      const manifest = await readManifest(pluginPath);
      console.log(`\n📦 Plugin: ${manifest.name} v${manifest.version}`);
      console.log(`   Description: ${manifest.description || "(none)"}`);
      console.log(`   Targets: ${formatManifestTargets(manifest)}`);

      // Validate skills (if any)
      const skillResults = await validatePluginSkills(pluginPath);

      if (skillResults.length > 0) {
        console.log(`\n🎯 Skills validation:`);

        for (const result of skillResults) {
          const skillName = result.skillName || "(unknown)";

          if (result.valid) {
            console.log(`   ✅ ${skillName}`);
            if (options.verbose && result.warnings.length > 0) {
              for (const warning of result.warnings) {
                console.log(`      ⚠️  ${warning}`);
              }
              hasWarnings = true;
            }
          } else {
            console.log(`   ❌ ${skillName}`);
            for (const error of result.errors) {
              console.log(`      • ${error}`);
            }
            hasErrors = true;
          }

          if (result.warnings.length > 0 && !options.verbose) {
            hasWarnings = true;
          }
        }
      }

      // Validate agents (if any)
      const agentResults = await validatePluginAgents(pluginPath);

      if (agentResults.length > 0) {
        console.log(`\n🤖 Agents validation:`);

        for (const result of agentResults) {
          const agentName = result.agentName || "(unknown)";

          if (result.valid) {
            console.log(`   ✅ ${agentName}`);
            if (options.verbose && result.warnings.length > 0) {
              for (const warning of result.warnings) {
                console.log(`      ⚠️  ${warning}`);
              }
              hasWarnings = true;
            }
          } else {
            console.log(`   ❌ ${agentName}`);
            for (const error of result.errors) {
              console.log(`      • ${error}`);
            }
            hasErrors = true;
          }

          if (result.warnings.length > 0 && !options.verbose) {
            hasWarnings = true;
          }
        }
      }

      // Summary
      console.log();
      if (hasErrors) {
        console.log("❌ Validation failed with errors");
        process.exit(1);
      } else if (hasWarnings && !options.verbose) {
        console.log("✅ Plugin is valid (run with --verbose to see warnings)");
      } else {
        console.log("✅ Plugin is valid");
      }
    } catch (error) {
      printCliError(error, "Invalid plugin");
      process.exit(1);
    }
  });

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
