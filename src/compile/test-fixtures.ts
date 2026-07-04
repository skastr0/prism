import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js"
).replace(/\\/g, "/");

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const DEFAULT_TARGET_HARNESSES = ["opencode", "claude-code"] as const;
const GOLDEN_TARGET_HARNESSES = [
  "opencode",
  "claude-code",
  "antigravity-cli",
  "grok",
  "factory-droid",
  "pi",
  "kimi-code",
] as const;

interface CanonicalCompileFixtureOptions {
  pluginRoot: string;
  projectRoot: string;
  invalidOrbit?: boolean;
  invalidOrbitPermissionAgent?: boolean;
  inlineSlotSchema?: boolean;
  undeclaredSlot?: boolean;
  mixedTraitRefsBeforeSlotBinding?: boolean;
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
    readonly protocolRuntimeConfig?: Record<string, unknown>;
  },
): Promise<void> => {
  const pluginTargets: Record<string, string[]> = {
    agents: [...targetHarnesses],
    orbits: [...targetHarnesses],
    tools: [...targetHarnesses],
    toolspaces: [...targetHarnesses],
    modelspaces: [...targetHarnesses],
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
      toolspaces: [...targetHarnesses],
      modelspaces: [...targetHarnesses],
      skillspaces: [...targetHarnesses],
    },
  });

  const protocolManifest: Record<string, unknown> = {
    name: "protocol-core",
    version: "0.1.0",
    targets: {
      tools: [...targetHarnesses],
    },
  };
  if (options?.protocolRuntimeConfig !== undefined) {
    protocolManifest.runtime = options.protocolRuntimeConfig;
  }
  await writeJsonFixture(join(protocolRoot, "plugin.json"), protocolManifest);
};

const opencodeToolNames: Record<string, string> = {
  read_repo: "read",
  search_repo: "grep",
  run_shell: "bash",
};

const claudeCodeToolNames: Record<string, string> = {
  read_repo: "Read",
  search_repo: "Grep",
  run_shell: "Bash",
};

const nativeToolName = (harness: string, tool: string): string => {
  if (harness === "opencode") return opencodeToolNames[tool] ?? tool;
  if (harness === "claude-code") return claudeCodeToolNames[tool] ?? tool;
  return tool;
};

const renderToolTargets = (targetHarnesses: readonly string[], tool: string): string =>
  targetHarnesses
    .map((harness) => `        ${JSON.stringify(harness)}: { name: ${JSON.stringify(nativeToolName(harness, tool))} },`)
    .join("\n");

const writeWorkspaceToolspace = async (
  { coreRoot }: CanonicalFixturePaths,
  targetHarnesses: readonly string[],
): Promise<void> => {
  await writeText(
    join(coreRoot, "toolspaces", "workspace-tools.toolspace.ts"),
    `import { toolRef, type ToolspaceSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "workspace-tools",
  description: "Logical tool vocabulary shared across compile fixtures",
  tools: {
    read_repo: {
      description: "Read repository files",
      targets: {
${renderToolTargets(targetHarnesses, "read_repo")}
      },
    },
    search_repo: {
      description: "Search repository contents",
      targets: {
${renderToolTargets(targetHarnesses, "search_repo")}
      },
    },
    run_shell: {
      description: "Run shell commands",
      targets: {
${renderToolTargets(targetHarnesses, "run_shell")}
      },
    },
  },
  groups: {
    repo_inspection: {
      description: "Read and search the repository",
      tools: [
        toolRef("workspace-tools", "read_repo"),
        toolRef("workspace-tools", "search_repo"),
      ],
    },
  },
} satisfies ToolspaceSource;
`
  );
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
  await writeWorkspaceToolspace(paths, targetHarnesses);
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

const writeProtocolSchema = async ({ protocolRoot }: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(protocolRoot, "schemas", "review-evidence.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export const ProtocolReviewEvidence = Schema.Struct({
  source: Schema.String,
});
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

const writeSubmitWorkTool = async (pluginRoot: string): Promise<void> => {
  await writeLocalTool(pluginRoot, {
    name: "submit-work",
    description: "Submit completed work",
  });
};

const writeCommitWorkTool = async (pluginRoot: string): Promise<void> => {
  await writeLocalTool(pluginRoot, {
    name: "commit-work",
    description: "Commit validated implementation work",
  });
};

const writeSubmitReviewTool = async (pluginRoot: string): Promise<void> => {
  await writeLocalTool(pluginRoot, {
    name: "submit-review",
    description: "Submit review findings",
    reviewSlot: true,
  });
};

const writeLocalTools = async ({ pluginRoot }: CanonicalFixturePaths): Promise<void> => {
  await writeSubmitWorkTool(pluginRoot);
  await writeCommitWorkTool(pluginRoot);
  await writeSubmitReviewTool(pluginRoot);
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
    board: Schema.Literal("project-alpha", "project-beta"),
    id: Schema.String,
    title: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
    board: Schema.Literal("project-alpha", "project-beta"),
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

const writeSubmissionTraits = async ({
  pluginRoot,
  withCanonicalToolBindings,
}: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `import type { TraitSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "submittable",
  description: "Can submit completed work",
  instructions: "Submit completed work through the typed submission surface before handing off."${withCanonicalToolBindings ? `,
  tools: {
    submit_work: {
      ref: "protocol-core:external-submit",
    },
  },
  require: {
    tools: ["submit_work"],
  }` : ""},
} satisfies TraitSource;
`
  );

  await writeText(
    join(pluginRoot, "traits", "committable.trait.ts"),
    `import type { TraitSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "committable",
  description: "Can create implementation commits",
  instructions: "Commit owned implementation changes only after the submitted work is complete."${withCanonicalToolBindings ? `,
  tools: {
    commit_work: {
      ref: "commit-work",
    },
  },
  require: {
    tools: ["commit_work"],
  }` : ""},
} satisfies TraitSource;
`
  );
};

const writeReviewTraits = async ({
  pluginRoot,
  withCanonicalToolBindings,
}: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(pluginRoot, "traits", "reviewable.trait.ts"),
    `import { toolGroupRef, type TraitSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "reviewable",
  description: "Can submit review findings",
  access: {
    toolGroups: [toolGroupRef("agent-core", "workspace-tools", "repo_inspection")],
  }${withCanonicalToolBindings ? `,
  tools: {
    submit_review: {
      ref: "submit-review",
    },
  },
  require: {
    tools: ["submit_review"],
  }` : ""},
} satisfies TraitSource;
`
  );

  await writeText(
    join(pluginRoot, "traits", "self-assessing.trait.ts"),
    `import { toolGroupRef, type TraitSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "self-assessing",
  description: "Runs validation before handing work off",
  instructions: "Run the relevant validation before final response or handoff.",
  access: {
    toolGroups: [toolGroupRef("agent-core", "workspace-tools", "repo_inspection")],
  },
} satisfies TraitSource;
`
  );
};

const writeReviewSlotSchema = async ({ pluginRoot }: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(pluginRoot, "schemas", "review-slots.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { ProtocolReviewEvidence } from "../deps/protocol-core/schemas/review-evidence.ts";

export const ReviewFindingsSlot = Schema.Struct({
  verdict: Schema.Literal("approve", "request_changes"),
  evidence: Schema.optional(ProtocolReviewEvidence),
});

export const SecurityReviewSlot = Schema.Struct({
  severity: Schema.Literal("low", "medium", "high"),
  findings: Schema.Array(Schema.String),
});
`
  );
};

const writeFixtureTraits = async (paths: CanonicalFixturePaths): Promise<void> => {
  await writeSubmissionTraits(paths);
  await writeReviewSlotSchema(paths);
  await writeReviewTraits(paths);
};

const writeBuilderAgent = async ({ pluginRoot }: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(pluginRoot, "agents", "builder.agent.ts"),
    `import { modelProfileRef, skillspaceRef, toolRef, type AgentSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "builder",
  description: "Builder agent for canonical compile integration tests",
  identity: "builder",
  model: modelProfileRef("agent-core", "default-models", "builder"),
  traits: [
    "submittable",
    "committable",
    "self-assessing",
  ],
  access: {
    tools: [toolRef("agent-core", "workspace-tools", "run_shell")],
  },
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
  paths: CanonicalFixturePaths,
  options: CanonicalCompileFixtureOptions,
): Promise<void> => {
  const { pluginRoot, withCanonicalToolBindings } = paths;
  const reviewerSlotReference = options.inlineSlotSchema
    ? `Schema.Struct({
              verdict: Schema.Literal("approve", "request_changes"),
            })`
    : "ReviewFindingsSlot";
  const reviewerSlotName = options.undeclaredSlot ? "unknown_verdict" : "verdict";
  const reviewerTraitsHead = options.mixedTraitRefsBeforeSlotBinding
    ? `"submittable",`
    : `{ trait: "submittable" },`;
  const reviewerSchemaImport =
    withCanonicalToolBindings && !options.inlineSlotSchema
      ? `import { ReviewFindingsSlot } from "../schemas/review-slots.ts";`
      : "";

  await writeText(
    join(pluginRoot, "agents", "reviewer.agent.ts"),
    `import { modelProfileRef, skillspaceRef, type AgentSource } from ${JSON.stringify(prismImportPath)};
${options.inlineSlotSchema ? `import { Schema } from ${JSON.stringify(effectImportPath)};` : ""}
${reviewerSchemaImport}

export default {
  name: "reviewer",
  description: "Reviewer agent for canonical compile integration tests",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  traits: [
    ${reviewerTraitsHead}
    ${withCanonicalToolBindings ? `{
      trait: "reviewable",
      tools: {
        submit_review: {
          slots: {
            ${reviewerSlotName}: ${reviewerSlotReference},
          },
        },
      },
    }` : `"reviewable"`},
    "self-assessing",
  ],
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
  withCanonicalToolBindings,
}: CanonicalFixturePaths): Promise<void> => {
  await writeText(
    join(pluginRoot, "agents", "security-reviewer.agent.ts"),
    `import { modelProfileRef, skillspaceRef, type AgentSource } from ${JSON.stringify(prismImportPath)};
${withCanonicalToolBindings ? `import { SecurityReviewSlot } from "../schemas/review-slots.ts";` : ""}

export default {
  name: "security-reviewer",
  description: "Security reviewer variant using the same reviewable trait",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  traits: [
    "submittable",
    ${withCanonicalToolBindings ? `{
      trait: "reviewable",
      tools: {
        submit_review: {
          slots: {
            verdict: SecurityReviewSlot,
          },
        },
      },
    }` : `"reviewable"`},
    "self-assessing",
  ],
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

const writeFixtureAgents = async (
  paths: CanonicalFixturePaths,
  options: CanonicalCompileFixtureOptions,
): Promise<void> => {
  await writeBuilderAgent(paths);
  await writeReviewerAgent(paths, options);
  await writeSecurityReviewerAgent(paths);
};

const deliveryReviewAgentRefs = (options: CanonicalCompileFixtureOptions): string =>
  (options.invalidOrbit ? ["builder"] : ["reviewer"])
    .map((agent) => `agentRef(${JSON.stringify(agent)})`)
    .join(", ");

const deliveryOrbitOrchestratorAgent = (
  options: CanonicalCompileFixtureOptions,
): string => options.invalidOrbitPermissionAgent ? "ghost-orchestrator" : "builder";

const deliveryOrbitOrchestratorBlock = (
  paths: CanonicalFixturePaths,
  options: CanonicalCompileFixtureOptions,
): string => {
  if (!paths.withCanonicalToolBindings) return "";
  return `,
  orchestrator: {
    agent: agentRef(${JSON.stringify(deliveryOrbitOrchestratorAgent(options))}),
    tools: [
      {
        ref: "protocol-core:create_glyph",
        as: "create_glyph",
      },
    ],
  }`;
};

const deliveryOrbitSource = (
  paths: CanonicalFixturePaths,
  options: CanonicalCompileFixtureOptions,
): string => {
  const reviewAgents = deliveryReviewAgentRefs(options);

  return `import { agentRef, traitRef, type OrbitSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "delivery-contract",
  description: "Validate that work moves through the right trait-conforming agents",
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [
        {
          all: [traitRef("committable"), traitRef("self-assessing")],
        },
      ],
      notes: {
        "Input": "Work item is ready to build",
        "Done": "Implementation is ready for review",
      },
    },
    {
      name: "Review change",
      agents: [${reviewAgents}],
      requires: [
        {
          all: [traitRef("reviewable"), traitRef("self-assessing")],
        },
      ],
      notes: {
        "Input": "Implementation is ready for review",
        "Done": "Review findings are recorded",
      },
    },
    {
      name: "Hand off work",
      agents: [agentRef("builder"), agentRef("reviewer")],
      requires: [
        {
          all: [traitRef("submittable")],
          min: 2,
        },
      ],
      notes: {
        "Input": "Build and review are complete",
        "Done": "Work has been handed off cleanly",
      },
    },
  ]${deliveryOrbitOrchestratorBlock(paths, options)},
  body: "Use this orbit when you want the compile-time graph to prove that each phase has the right agents assigned.",
} satisfies OrbitSource;
`;
};

const writeDeliveryOrbit = async (
  paths: CanonicalFixturePaths,
  options: CanonicalCompileFixtureOptions,
): Promise<void> => {
  await writeText(
    join(paths.pluginRoot, "orbits", "delivery-contract.orbit.ts"),
    deliveryOrbitSource(paths, options),
  );
};

export const createCanonicalCompileFixture = async (
  options: CanonicalCompileFixtureOptions,
): Promise<{ pluginRoot: string; projectRoot: string }> => {
  const paths = fixturePaths(options);
  await mkdir(paths.projectRoot, { recursive: true });

  await writeFixtureManifests(paths, [...DEFAULT_TARGET_HARNESSES]);
  await writeFixtureSpaces(paths, [...DEFAULT_TARGET_HARNESSES]);
  await writeFixtureIdentities(paths);
  await writeProtocolSchema(paths);
  await writeFixtureTools(paths);
  await writeFixtureTraits(paths);
  await writeFixtureAgents(paths, options);
  await writeDeliveryOrbit(paths, options);

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

const goldenProtocolRuntimeConfig = (): Record<string, unknown> => {
  const mcp: Record<string, { port: number; transport: string }> = {};
  for (const [index, harness] of GOLDEN_TARGET_HARNESSES.entries()) {
    mcp[harness] = { port: 11000 + index, transport: "streamable-http" };
  }
  return { mcp };
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
    protocolRuntimeConfig: goldenProtocolRuntimeConfig(),
  });
  await writeFixtureSpaces(paths, GOLDEN_TARGET_HARNESSES);
  await writeFixtureIdentities(paths);
  await writeProtocolSchema(paths);
  await writeFixtureTools(paths);
  await writeFixtureTraits(paths);
  await writeFixtureAgents(paths, { pluginRoot: options.pluginRoot, projectRoot: options.projectRoot });
  await writeDeliveryOrbit(paths, { pluginRoot: options.pluginRoot, projectRoot: options.projectRoot });
  await writeGoldenHook(paths);
  await writeGoldenSkill(paths);

  return { pluginRoot: paths.pluginRoot, projectRoot: paths.projectRoot };
};
