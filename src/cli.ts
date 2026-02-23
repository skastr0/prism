#!/usr/bin/env bun
/**
 * agentpkg CLI - Unified plugin distribution for AI coding agents
 */

import { Command } from "commander";
import { getAllAgentIds, isValidAgentId } from "./agents.js";
import { install, planInstallation } from "./installer.js";
import { readManifest, validatePluginSkills, validatePluginAgents, manifestTargetsAgent } from "./manifest.js";
import { ensureDir, exists, expandPath, writeFile } from "./fs.js";
import type { AgentId, FileOperation } from "./types.js";
import { join } from "node:path";

const program = new Command();

program
  .name("agentpkg")
  .description("Unified plugin distribution for AI coding agents")
  .version("0.1.0");

// Install command
program
  .command("install <plugin-path>")
  .description("Install a plugin to one or more agents")
  .option("-a, --agent <agents>", "Comma-separated list of agent IDs")
  .option("--all", "Install to all supported agents")
  .option("-p, --project <path>", "Project path for project-specific rules")
  .option("--overwrite", "Overwrite existing files", false)
  .option("--no-backup", "Skip creating backups")
  .option("--no-validate", "Skip plugin validation before install")
  .option("--dry-run", "Preview operations without executing", false)
  .action(async (pluginPath: string, options) => {
    try {
      // Determine target agents
      let agents: AgentId[];
      if (options.all) {
        agents = getAllAgentIds();
      } else if (options.agent) {
        agents = options.agent.split(",").map((a: string) => a.trim());
        for (const agent of agents) {
          if (!isValidAgentId(agent)) {
            console.error(`Unknown agent: ${agent}`);
            console.error(`Valid agents: ${getAllAgentIds().join(", ")}`);
            process.exit(1);
          }
        }
      } else {
        console.error("Please specify --agent <agents> or --all");
        process.exit(1);
      }

      // Read manifest to show info
      const manifest = await readManifest(pluginPath);
      
      // Filter agents to only those supported by the plugin
      const supportedAgents = agents.filter(a => manifestTargetsAgent(manifest, a as AgentId));
      
      console.log(`\n📦 Installing plugin: ${manifest.name} v${manifest.version}`);
      console.log(`   Targets: ${supportedAgents.length > 0 ? supportedAgents.join(", ") : "None (check plugin.json)"}`);

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
        agents: agents as AgentId[],
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
        agents: agents as AgentId[],
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
      console.error(
        `\n❌ Error: ${error instanceof Error ? error.message : error}`
      );
      process.exit(1);
    }
  });

// Install-all command - discover and install all plugins in a directory
program
  .command("install-all <directory>")
  .description("Discover and install all plugins found in a directory (shallow scan)")
  .option("-a, --agent <agents>", "Comma-separated list of agent IDs")
  .option("--all", "Install to all supported agents")
  .option("-p, --project <path>", "Project path for project-specific rules")
  .option("--overwrite", "Overwrite existing files", false)
  .option("--no-backup", "Skip creating backups")
  .option("--no-validate", "Skip plugin validation before install")
  .option("--dry-run", "Preview operations without executing", false)
  .action(async (directory: string, options) => {
    try {
      // Determine target agents
      let agents: AgentId[];
      if (options.all) {
        agents = getAllAgentIds();
      } else if (options.agent) {
        agents = options.agent.split(",").map((a: string) => a.trim());
        for (const agent of agents) {
          if (!isValidAgentId(agent)) {
            console.error(`Unknown agent: ${agent}`);
            console.error(`Valid agents: ${getAllAgentIds().join(", ")}`);
            process.exit(1);
          }
        }
      } else {
        console.error("Please specify --agent <agents> or --all");
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
      for (const p of pluginPaths) {
        const manifest = await readManifest(p);
        console.log(`   • ${manifest.name} v${manifest.version}`);
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
      for (const pluginPath of pluginPaths) {
        const manifest = await readManifest(pluginPath);
        
        // Filter agents to only those supported by the plugin
        const supportedAgents = agents.filter(a => manifestTargetsAgent(manifest, a as AgentId));
        
        console.log(`\n📦 Installing plugin: ${manifest.name} v${manifest.version}`);
        console.log(`   Targets: ${supportedAgents.length > 0 ? supportedAgents.join(", ") : "None (check plugin.json)"}\n`);

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
          agents: agents as AgentId[],
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
          agents: agents as AgentId[],
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
      console.log(`   Total plugins: ${results.length}`);
      console.log(`   Successful: ${successCount}`);
      if (failCount > 0) {
        console.log(`   Failed: ${failCount}`);
        for (const r of results.filter((r) => !r.success)) {
          console.log(`      • ${r.name}: ${r.errors.join(", ")}`);
        }
      }

      if (failCount > 0) {
        console.log("\n⚠️  Some plugins failed to install");
        process.exit(1);
      } else {
        console.log("\n✅ All plugins installed successfully!");
      }
    } catch (error) {
      console.error(
        `\n❌ Error: ${error instanceof Error ? error.message : error}`
      );
      process.exit(1);
    }
  });

// Init command - create a new plugin
program
  .command("init <name>")
  .description("Create a new plugin from template")
  .option("-d, --dir <path>", "Directory to create plugin in", ".")
  .option("--with-agent", "Include example agent definition")
  .option("--with-skill", "Include example skill (Claude Code)")
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
      const manifest = {
        name,
        version: "0.1.0",
        description: `${name} plugin for AI coding agents`,
        targets: "all",
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
# targets: [claude-code, opencode]  # Uncomment to limit to specific agents
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
# targets: [claude-code, opencode]  # Uncomment to limit to specific agents

# Agent-specific overrides:
# claude-code:
#   allowed-tools: [Bash]
# opencode:
#   mode: subagent
---

# Run Tests

**Test pattern:** $1
**Additional flags:** $2

Run the test suite with coverage reporting.

## Arguments

- \`$1\` - Test file or pattern (optional, runs all if empty)
- \`$2\` - Additional flags like --watch, --verbose
- \`$ARGUMENTS\` - Use this instead for free-form input

## Usage Examples

\`\`\`bash
/test                           # Run all tests
/test src/utils                 # Run tests matching pattern
/test "auth tests" --watch      # Quoted pattern with flag
\`\`\`

## Instructions

1. Run tests matching $1 (or all tests if not provided)
2. Apply any additional flags from $2
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
targets: [claude-code, opencode]

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
        await ensureDir(join(targetDir, "skills", "example-skill"));
        
        const skillMd = `---
name: example-skill
description: Example skill demonstrating basic structure and pattern usage
---

# Example Skill

This is an example skill showing the recommended structure.

## Core Instructions

Keep your main instructions concise and focused. Only include what the agent doesn't already know.

## When to Use

This skill triggers when users need help with [specific task].

## Progressive Disclosure

For larger documentation, split into sibling files:
- See [advanced.md](advanced.md) for advanced features
- See [examples.md](examples.md) for detailed examples
`;
        await writeFile(join(targetDir, "skills", "example-skill", "SKILL.md"), skillMd);
        created.push("skills/example-skill/SKILL.md");
      }

      // Create README
      const readme = `# ${name}

A plugin for AI coding agents.

## Structure

\`\`\`
${name}/
├── plugin.json          # Plugin manifest
├── rules/
│   ├── global/          # Rules applied globally
│   └── project/         # Rules for specific projects
├── commands/            # Custom slash commands
├── agents/              # Custom agent definitions
└── skills/              # Skills (Claude Code)
\`\`\`

## Installation

\`\`\`bash
# Install to all agents
agentpkg install ./${name} --all

# Install to specific agents
agentpkg install ./${name} --agent claude-code,opencode

# Install with project context
agentpkg install ./${name} --all --project ~/code/my-project

# Preview without installing
agentpkg install ./${name} --all --dry-run
\`\`\`

## Supported Agents

- claude-code (commands, agents, skills)
- opencode (commands, agents)
- codex-cli (prompts/commands)
- gemini-cli (commands)
- amp-code (commands)
- cursor (rules only)
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
      console.error(
        `\n❌ Error: ${error instanceof Error ? error.message : error}`
      );
      process.exit(1);
    }
  });

// List command - show supported agents
program
  .command("agents")
  .description("List all supported agents")
  .action(() => {
    console.log("\n📋 Supported agents:\n");
    const agents = getAllAgentIds();
    for (const id of agents) {
      const { getAgent } = require("./agents.js");
      const agent = getAgent(id);
      console.log(`   ${id.padEnd(12)} - ${agent.name}`);
      console.log(`                  Global: ${agent.globalConfigPath}`);
      if (agent.projectConfigPath) {
        console.log(`                  Project: ${agent.projectConfigPath}`);
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
      console.log(
        `   Targets: ${manifest.targets === "all" ? "all agents" : manifest.targets.join(", ")}`
      );

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
      console.error(
        `\n❌ Invalid plugin: ${error instanceof Error ? error.message : error}`
      );
      process.exit(1);
    }
  });

/**
 * Print operations in a readable format
 */
function printOperations(operations: FileOperation[], indent = ""): void {
  const byAgent = new Map<AgentId, FileOperation[]>();

  for (const op of operations) {
    const list = byAgent.get(op.agent) || [];
    list.push(op);
    byAgent.set(op.agent, list);
  }

  for (const [agent, ops] of byAgent) {
    console.log(`${indent}   ${agent}:`);
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
    console.log();
  }
}

program.parse();
