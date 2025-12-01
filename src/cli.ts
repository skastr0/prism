#!/usr/bin/env bun
/**
 * agentpkg CLI - Unified plugin distribution for AI coding agents
 */

import { Command } from "commander";
import { getAllAgentIds, isValidAgentId } from "./agents.js";
import { install, planInstallation } from "./installer.js";
import { readManifest, validatePluginSkills } from "./manifest.js";
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
      console.log(`\n📦 Installing plugin: ${manifest.name} v${manifest.version}`);
      console.log(`   Targets: ${agents.join(", ")}`);

      if (options.project) {
        console.log(`   Project: ${options.project}`);
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

        // Create example command
        const exampleCommand = `---
description: Run tests with coverage
# targets: [claude-code, opencode]  # Uncomment to limit to specific agents

# Agent-specific overrides:
# claude-code:
#   allowed-tools: [Bash]
# opencode:
#   agent: build
---

Run the test suite with coverage reporting.
Use $ARGUMENTS for any additional flags.

Focus on:
1. Running all tests
2. Generating coverage report
3. Highlighting any failures
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

      // Create example skill if requested (Claude Code specific)
      if (options.withSkill) {
        await ensureDir(join(targetDir, "skills", "debugging"));
        
        const skillMd = `---
description: Advanced debugging techniques and tools
targets: [claude-code]
---

# Debugging Skill

You have expertise in debugging complex issues. Use these techniques:

## Systematic Approach
1. Reproduce the issue consistently
2. Isolate the problem area
3. Form hypotheses
4. Test each hypothesis
5. Document findings

## Tools to Use
- Add strategic console.log/print statements
- Use debugger breakpoints
- Check error stack traces
- Review recent changes (git diff)

## Common Patterns
- Check for null/undefined values
- Verify async/await handling
- Look for race conditions
- Validate input data types
`;
        await writeFile(join(targetDir, "skills", "debugging", "SKILL.md"), skillMd);
        created.push("skills/debugging/SKILL.md");

        // Add helper files for the skill
        const debugChecklist = `# Debug Checklist

## Before Starting
- [ ] Can you reproduce the issue?
- [ ] Do you have the error message/stack trace?
- [ ] What changed recently?

## Investigation
- [ ] Check input values
- [ ] Verify function arguments
- [ ] Review async operations
- [ ] Check external dependencies

## Resolution
- [ ] Root cause identified
- [ ] Fix implemented
- [ ] Tests added/updated
- [ ] Edge cases handled
`;
        await writeFile(join(targetDir, "skills", "debugging", "checklist.md"), debugChecklist);
        created.push("skills/debugging/checklist.md");
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
function printOperations(operations: FileOperation[]): void {
  const byAgent = new Map<AgentId, FileOperation[]>();

  for (const op of operations) {
    const list = byAgent.get(op.agent) || [];
    list.push(op);
    byAgent.set(op.agent, list);
  }

  for (const [agent, ops] of byAgent) {
    console.log(`   ${agent}:`);
    for (const op of ops) {
      const icon =
        op.type === "copy"
          ? "📄"
          : op.type === "append"
            ? "📝"
            : op.type === "skip"
              ? "⏭️"
              : "🔀";
      const status = op.type === "skip" ? ` (${op.reason})` : "";
      console.log(`      ${icon} ${op.type.padEnd(6)} ${op.artifact}: ${op.target}${status}`);
    }
    console.log();
  }
}

program.parse();
