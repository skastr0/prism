import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { effectBundleImportPath } from "./runtime-deps.js";

// Track whatever Effect release is installed instead of a fixed dist layout:
// v3 shipped `dist/esm/index.js`, v4 ships `dist/index.js`.
const effectImportPath = effectBundleImportPath().replace(/\\/g, "/");

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const DEFAULT_TARGET_HARNESSES = ["opencode", "claude-code"] as const;
const GOLDEN_TARGET_HARNESSES = [
  "opencode",
  "claude-code",
  "antigravity-cli",
  "grok",
  "pi",
  "kimi-code",
] as const;

interface CanonicalCompileFixtureOptions {
  pluginRoot: string;
  projectRoot: string;
  /** Retained for callers; canonical tools are plugin-level surfaces now. */
  withCanonicalToolBindings?: boolean;
}

interface CanonicalFixturePaths {
  pluginRoot: string;
  projectRoot: string;
  coreRoot: string;
  protocolRoot: string;
  withCanonicalToolBindings: boolean;
}

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const writeJsonFixture = async (path: string, value: unknown): Promise<void> => {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
};

const fixturePaths = (options: CanonicalCompileFixtureOptions): CanonicalFixturePaths => ({
  pluginRoot: options.pluginRoot,
  projectRoot: options.projectRoot,
  coreRoot: join(options.pluginRoot, "deps", "agent-core"),
  protocolRoot: join(options.pluginRoot, "deps", "protocol-core"),
  withCanonicalToolBindings: options.withCanonicalToolBindings ?? true,
});

const writeFixtureManifests = async (
  { pluginRoot, coreRoot, protocolRoot }: CanonicalFixturePaths,
  targetHarnesses: readonly string[],
  options?: {
    readonly includeSkillsAndHooks?: boolean;
  },
): Promise<void> => {
  const pluginTargets: Record<string, string[]> = {
    agents: [...targetHarnesses],
    tools: [...targetHarnesses],
    modelspaces: [...targetHarnesses],
    skillspaces: [...targetHarnesses],
  };
  if (options?.includeSkillsAndHooks) {
    pluginTargets.skills = [...targetHarnesses];
    pluginTargets.hooks = [...targetHarnesses];
  }
  await writeJsonFixture(join(pluginRoot, "plugin.json"), {
    name: "canonical-compile-fixture",
    version: "0.1.0",
    deps: {
      "agent-core": "./deps/agent-core",
      "protocol-core": "./deps/protocol-core",
    },
    targets: pluginTargets,
  });

  await writeJsonFixture(join(coreRoot, "plugin.json"), {
    name: "agent-core",
    version: "0.1.0",
    targets: {
      modelspaces: [...targetHarnesses],
      skillspaces: [...targetHarnesses],
    },
  });

  await writeJsonFixture(join(protocolRoot, "plugin.json"), {
    name: "protocol-core",
    version: "0.1.0",
    targets: {
      tools: [...targetHarnesses],
    },
  });
};

const builderModelBlock = (harness: string): string => {
  if (harness === "opencode") {
    return JSON.stringify({ model: "openai/gpt-5.4", variant: "xhigh", temperature: 0.2 });
  }
  if (harness === "claude-code") {
    return JSON.stringify({ model: "sonnet", temperature: 0.1 });
  }
  return JSON.stringify({ model: `${harness}-builder` });
};

const reviewerModelBlock = (harness: string): string => {
  if (harness === "opencode") {
    return JSON.stringify({
      strategy: "round-robin",
      models: [
        { model: "openai/gpt-5.4-reviewer-a", variant: "medium", temperature: 0.1 },
        { model: "openai/gpt-5.4-reviewer-b", variant: "medium", temperature: 0.1 },
      ],
    });
  }
  if (harness === "claude-code") {
    return JSON.stringify({ model: "opus", temperature: 0.1 });
  }
  return JSON.stringify({ model: `${harness}-reviewer` });
};

const renderModelTargets = (targetHarnesses: readonly string[]): string =>
  targetHarnesses
    .map(
      (harness) =>
        `        ${JSON.stringify(harness)}: ${builderModelBlock(harness)},`,
    )
    .join("\n");

const renderReviewerModelTargets = (targetHarnesses: readonly string[]): string =>
  targetHarnesses
    .map(
      (harness) =>
        `        ${JSON.stringify(harness)}: ${reviewerModelBlock(harness)},`,
    )
    .join("\n");

const writeDefaultModelspace = async (
  { coreRoot }: CanonicalFixturePaths,
  targetHarnesses: readonly string[],
): Promise<void> => {
  await writeText(
    join(coreRoot, "modelspaces", "default-models.modelspace.ts"),
    `import type { ModelspaceSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "default-models",
  description: "Shared logical model profiles",
  profiles: {
    builder: {
      description: "Primary build profile",
      targets: {
${renderModelTargets(targetHarnesses)}
      },
    },
    reviewer: {
      description: "Primary review profile",
      targets: {
${renderReviewerModelTargets(targetHarnesses)}
      },
    },
  },
} satisfies ModelspaceSource;
`
  );
};

const renderSkillTargets = (targetHarnesses: readonly string[]): string =>
  targetHarnesses
    .map((harness) => `        ${JSON.stringify(harness)}: { name: "testing" },`)
    .join("\n");

const writeCoreSkillspace = async (
  { coreRoot }: CanonicalFixturePaths,
  targetHarnesses: readonly string[],
): Promise<void> => {
  await writeText(
    join(coreRoot, "skillspaces", "core-skills.skillspace.ts"),
    `import type { SkillspaceSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "core-skills",
  description: "Harness-native core skill names",
  skills: {
    testing: {
      targets: {
${renderSkillTargets(targetHarnesses)}
      },
    },
  },
} satisfies SkillspaceSource;
`
  );
};

const writeFixtureSpaces = async (
  paths: CanonicalFixturePaths,
  targetHarnesses: readonly string[],
): Promise<void> => {
  await writeDefaultModelspace(paths, targetHarnesses);
  await writeCoreSkillspace(paths, targetHarnesses);
};

const writeFixtureIdentities = async ({ pluginRoot }: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(pluginRoot, "identities", "builder.identity.md"),
    `---
description: Build specialist for canonical compile tests
---

# Builder

You implement one committed glyph and validate it before review.
`
  );

  await writeText(
    join(pluginRoot, "identities", "reviewer.identity.md"),
    `---
description: Review specialist for canonical compile tests
---

# Reviewer

You assess completed work and report whether it is ready to ship.
`
  );
};

interface LocalAcknowledgingToolSpec {
  readonly name: "submit-work" | "commit-work" | "submit-review";
  readonly description: string;
  readonly reviewSlot?: boolean;
}

const localToolImport = (reviewSlot: boolean): string =>
  reviewSlot
    ? `import { schemaSlot, type ToolSource } from ${JSON.stringify(prismImportPath)};`
    : `import type { ToolSource } from ${JSON.stringify(prismImportPath)};`;

const localToolSlotsBlock = (spec: LocalAcknowledgingToolSpec): string =>
  spec.reviewSlot
    ? `  slots: {
    verdict: schemaSlot({
      description: "Agent-specific review fields",
    }),
  },
`
    : "";

const localAcknowledgingToolSource = (spec: LocalAcknowledgingToolSpec): string => `import { Schema } from ${JSON.stringify(effectImportPath)};
${localToolImport(spec.reviewSlot ?? false)}

export default {
  name: ${JSON.stringify(spec.name)},
  description: ${JSON.stringify(spec.description)},
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
${localToolSlotsBlock(spec)}  async handle(input, context) {
    return { acknowledged: true };
  },
} satisfies ToolSource;
`;

const writeLocalTool = async (
  pluginRoot: string,
  spec: LocalAcknowledgingToolSpec,
): Promise<void> => {
  await writeText(
    join(pluginRoot, "tools", `${spec.name}.tool.ts`),
    localAcknowledgingToolSource(spec),
  );
};

const writeLocalTools = async ({ pluginRoot }: CanonicalFixturePaths): Promise<void> => {
  await writeLocalTool(pluginRoot, {
    name: "submit-work",
    description: "Submit completed work",
  });
  await writeLocalTool(pluginRoot, {
    name: "commit-work",
    description: "Commit validated implementation work",
  });
  await writeLocalTool(pluginRoot, {
    name: "submit-review",
    description: "Submit review findings",
    reviewSlot: true,
  });
};

const writeProtocolTools = async ({ protocolRoot }: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(protocolRoot, "tools", "external-submit.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import type { ToolSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "external-submit",
  description: "Submit completed work through an external protocol plugin",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  async handle(input, context) {
    return { acknowledged: true };
  },
} satisfies ToolSource;
`
  );

  await writeText(
    join(protocolRoot, "tools", "create_glyph.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import type { ToolSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "create_glyph",
  description: "Create a protocol-owned glyph",
  input: Schema.Struct({
    board: Schema.Literals(["project-alpha", "project-beta"]),
    id: Schema.String,
    title: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
    board: Schema.Literals(["project-alpha", "project-beta"]),
    id: Schema.String,
  }),
  async handle(input, context) {
    return { acknowledged: true, board: input.board, id: input.id };
  },
} satisfies ToolSource;
`
  );
};

const writeFixtureTools = async (paths: CanonicalFixturePaths): Promise<void> => {
  await writeLocalTools(paths);
  await writeProtocolTools(paths);
};

const writeBuilderAgent = async ({ pluginRoot }: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(pluginRoot, "agents", "builder.agent.ts"),
    `import { modelProfileRef, skillspaceRef, type AgentSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "builder",
  description: "Builder agent for canonical compile integration tests",
  identity: "builder",
  model: modelProfileRef("agent-core", "default-models", "builder"),
  skills: [skillspaceRef("agent-core", "core-skills", "testing")],
  targets: {
    opencode: {
      mode: "subagent",
      maxSteps: 12,
    },
    "claude-code": {
      top_p: 0.7,
    },
  },
} satisfies AgentSource;
`
  );
};

const writeReviewerAgent = async (
  { pluginRoot }: CanonicalFixturePaths,
): Promise<void> => {
  await writeText(
    join(pluginRoot, "agents", "reviewer.agent.ts"),
    `import { modelProfileRef, skillspaceRef, type AgentSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "reviewer",
  description: "Reviewer agent for canonical compile integration tests",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  skills: [skillspaceRef("agent-core", "core-skills", "testing")],
  targets: {
    opencode: {
      mode: "subagent",
    },
    "claude-code": {
      top_p: 0.5,
    },
  },
} satisfies AgentSource;
`
  );
};

const writeSecurityReviewerAgent = async ({
  pluginRoot,
}: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(pluginRoot, "agents", "security-reviewer.agent.ts"),
    `import { modelProfileRef, skillspaceRef, type AgentSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "security-reviewer",
  description: "Security reviewer variant of the reviewer role",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  skills: [skillspaceRef("agent-core", "core-skills", "testing")],
  targets: {
    opencode: {
      mode: "subagent",
    },
    "claude-code": {
      top_p: 0.4,
    },
  },
} satisfies AgentSource;
`
  );
};

const writeFixtureAgents = async (paths: CanonicalFixturePaths): Promise<void> => {
  await writeBuilderAgent(paths);
  await writeReviewerAgent(paths);
  await writeSecurityReviewerAgent(paths);
};

export const createCanonicalCompileFixture = async (
  options: CanonicalCompileFixtureOptions,
): Promise<{ pluginRoot: string; projectRoot: string }> => {
  const paths = fixturePaths(options);
  await mkdir(paths.projectRoot, { recursive: true });

  await writeFixtureManifests(paths, [...DEFAULT_TARGET_HARNESSES]);
  await writeFixtureSpaces(paths, [...DEFAULT_TARGET_HARNESSES]);
  await writeFixtureIdentities(paths);
  await writeFixtureTools(paths);
  await writeFixtureAgents(paths);

  return { pluginRoot: paths.pluginRoot, projectRoot: paths.projectRoot };
};

const writeGoldenHook = async ({ pluginRoot }: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(pluginRoot, "hooks", "session-start.hook.ts"),
    `import { hookEvent, type HookSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-start",
  description: "Run once at the start of each session",
  event: hookEvent.sessionStart,
  async handle(payload) {
    return { decision: "continue" };
  },
} satisfies HookSource;
`,
  );
};

const writeGoldenSkill = async ({ pluginRoot }: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(pluginRoot, "skills", "golden-skill", "SKILL.md"),
    `---
name: golden-skill
description: A targeted skill for golden lowerer tests
---

# Golden Skill

This skill is bundled by harnesses that copy targeted skills into generated plugins.
`,
  );
};

export const createGoldenCompileFixture = async (options: {
  pluginRoot: string;
  projectRoot: string;
}): Promise<{ pluginRoot: string; projectRoot: string }> => {
  const paths = fixturePaths({ pluginRoot: options.pluginRoot, projectRoot: options.projectRoot });
  await mkdir(paths.projectRoot, { recursive: true });

  await writeFixtureManifests(paths, GOLDEN_TARGET_HARNESSES, {
    includeSkillsAndHooks: true,
  });
  await writeFixtureSpaces(paths, GOLDEN_TARGET_HARNESSES);
  await writeFixtureIdentities(paths);
  await writeFixtureTools(paths);
  await writeFixtureAgents(paths);
  await writeGoldenHook(paths);
  await writeGoldenSkill(paths);

  return { pluginRoot: paths.pluginRoot, projectRoot: paths.projectRoot };
};
