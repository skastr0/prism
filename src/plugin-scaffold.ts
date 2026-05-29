import { join } from "node:path";
import { ensureDir, writeFile } from "./fs.js";
import {
  createTypescriptPackageJson,
  oxlintConfigJson,
  oxfmtConfigJson,
  prismOxlintPluginJs,
  typescriptTsconfigJson,
} from "./init-templates.js";
import type { PluginManifestTargets } from "./types.js";

export interface PluginScaffoldOptions {
  readonly minimal?: boolean;
  readonly typescript?: boolean;
  readonly withAgent?: boolean;
  readonly withSkill?: boolean;
}

export interface PluginScaffoldInput extends PluginScaffoldOptions {
  readonly name: string;
  readonly targetDir: string;
}

export interface PluginScaffoldResult {
  readonly created: string[];
}

const exampleRule = `---
description: Example coding guidelines
# No file-level targets. Install targeting lives in plugin.json -> targets.rules
---

# Coding Guidelines

- Write clean, readable code
- Add comments for complex logic
- Follow project conventions
`;

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

const exampleIdentity = `---
description: Code reviewer identity for the example agent
---

# Reviewer

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

const exampleAgent = `import { defineAgent } from "prism";

export default defineAgent({
  name: "reviewer",
  description: "Code reviewer that focuses on best practices",
  identity: "reviewer",
  targets: {
    opencode: {
      mode: "subagent",
      model: "anthropic/claude-sonnet-4-20250514",
      temperature: 0.1,
      tools: {
        write: false,
        edit: false,
      },
    },
    "claude-code": {
      model: "sonnet",
    },
  },
});
`;

const exampleSkill = `---
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

## Resources Policy

- Add deterministic helpers to \`scripts/\` when instructions alone are not enough.
- Put reusable templates, sample inputs, or brand assets in \`assets/\`.
- Add reference markdown only when it is real skill material loaded intentionally through progressive disclosure; do not add placeholder docs.
`;

const buildManifestTargets = (options: PluginScaffoldOptions): PluginManifestTargets => {
  const targets: PluginManifestTargets = {};
  if (!options.minimal) {
    targets.rules = ["coding-harness"];
    targets.commands = [
      "claude-code",
      "opencode",
      "codex-cli",
      "cursor",
      "factory-droid",
    ];
  }
  if (options.withAgent) targets.agents = ["claude-code", "opencode"];
  if (options.withSkill) targets.skills = ["coding-harness", "claw-harness"];
  return targets;
};

const createBaseDirectories = async (input: PluginScaffoldInput): Promise<void> => {
  await ensureDir(input.targetDir);
  await ensureDir(join(input.targetDir, "rules", "global"));
  await ensureDir(join(input.targetDir, "rules", "project"));
  await ensureDir(join(input.targetDir, "commands"));
  await ensureDir(join(input.targetDir, "agents"));
  if (input.withAgent) await ensureDir(join(input.targetDir, "identities"));
};

const writePluginManifest = async (input: PluginScaffoldInput): Promise<void> => {
  const manifest = {
    name: input.name,
    version: "0.1.0",
    description: `${input.name} plugin for AI coding harnesses`,
    targets: buildManifestTargets(input),
  };
  await writeFile(join(input.targetDir, "plugin.json"), JSON.stringify(manifest, null, 2));
};

const writeTypescriptGuardrails = async (
  input: PluginScaffoldInput,
  created: string[],
): Promise<void> => {
  if (input.minimal || !input.typescript) return;
  await writeFile(join(input.targetDir, "package.json"), createTypescriptPackageJson(input.name));
  await writeFile(join(input.targetDir, "tsconfig.json"), typescriptTsconfigJson);
  await writeFile(join(input.targetDir, ".oxlintrc.json"), oxlintConfigJson);
  await writeFile(join(input.targetDir, ".oxfmtrc.json"), oxfmtConfigJson);
  await writeFile(join(input.targetDir, "prism-oxlint-plugin.js"), prismOxlintPluginJs);
  created.push(
    "package.json",
    "tsconfig.json",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    "prism-oxlint-plugin.js",
  );
};

const writeExampleCommandArtifacts = async (
  input: PluginScaffoldInput,
  created: string[],
): Promise<void> => {
  if (input.minimal) return;
  await writeFile(join(input.targetDir, "rules", "global", "example.md"), exampleRule);
  await writeFile(join(input.targetDir, "commands", "test.md"), exampleCommand);
  created.push("rules/global/example.md", "commands/test.md");
};

const writeExampleAgentArtifacts = async (
  input: PluginScaffoldInput,
  created: string[],
): Promise<void> => {
  if (!input.withAgent) return;
  await writeFile(join(input.targetDir, "identities", "reviewer.identity.md"), exampleIdentity);
  await writeFile(join(input.targetDir, "agents", "reviewer.agent.ts"), exampleAgent);
  created.push("identities/reviewer.identity.md", "agents/reviewer.agent.ts");
};

const writeExampleSkillArtifacts = async (
  input: PluginScaffoldInput,
  created: string[],
): Promise<void> => {
  if (!input.withSkill) return;
  await ensureDir(join(input.targetDir, "skills", "example-skill", "scripts"));
  await ensureDir(join(input.targetDir, "skills", "example-skill", "assets"));
  await writeFile(join(input.targetDir, "skills", "example-skill", "SKILL.md"), exampleSkill);
  created.push("skills/example-skill/SKILL.md");
};

export const createPluginScaffold = async (
  input: PluginScaffoldInput,
): Promise<PluginScaffoldResult> => {
  const created: string[] = ["plugin.json"];
  await createBaseDirectories(input);
  await writePluginManifest(input);
  await writeTypescriptGuardrails(input, created);
  await writeExampleCommandArtifacts(input, created);
  await writeExampleAgentArtifacts(input, created);
  await writeExampleSkillArtifacts(input, created);
  return { created };
};
