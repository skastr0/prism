import { afterEach, expect, test } from "bun:test";

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Option, Schema } from "effect";
import matter from "gray-matter";
import type { CompileError } from "./errors.js";
import { loadPlugin } from "./load.js";
import { compilePluginForTarget } from "./pipeline.js";
import { emptyRegistry, type PluginRegistry } from "./registry.js";
import { resolveAgent } from "./resolve.js";
import { effectImportPath } from "../testing/prism-sandbox.js";
import {
  Agent,
  Identity,
  Personality,
  Skill,
} from "./sources.js";
import {
  formatManifestTargets,
  getManifestArtifactTargets,
  manifestHasCompileTargets,
  readManifest,
  resolveManifestTargets,
} from "../manifest.js";
import { computeContentHash } from "../content-hash.js";
import { resolvePrismHome } from "../prism-home.js";
import { commitSnapshot, readSnapshot } from "../state/store.js";
import { serializeRegionRef } from "../sync/plan.js";

const tempRoots: string[] = [];
const originalPrismHome = process.env.PRISM_HOME;

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-compile-"));
  tempRoots.push(root);
  process.env.PRISM_HOME = join(root, "prism-home");
  return root;
};

/** The sandboxed PRISM_HOME for the current test root (set by createTempRoot). */
const testPrismHome = (): string => resolvePrismHome();

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
};

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
};

const generatedPluginEntry = (projectRoot: string, pluginId: string): string =>
  pathToFileURL(
    join(
      projectRoot,
      ".opencode",
      "plugins",
      pluginId,
      "dist",
      "server.mjs",
    ),
  ).href;

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const getFailure = (
  exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>,
): CompileError => {
  if (exit._tag !== "Failure") {
    throw new Error("Expected compile to fail");
  }

  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error("Expected typed compile error");
  }

  return failure.value as CompileError;
};

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const createHermesHttpToolPlugin = async (options?: {
  readonly target?: "hermes" | "codex-cli" | "claude-code";
  readonly pluginName?: string;
  readonly port?: number;
  readonly omitPort?: boolean;
}): Promise<{ readonly pluginRoot: string; readonly hermesRoot: string }> => {
  const root = await createTempRoot();
  const target = options?.target ?? "hermes";
  const pluginName = options?.pluginName ?? "hermes-http-demo";
  const pluginRoot = join(root, pluginName);
  const hermesRoot = join(
    root,
    target === "hermes" ? "hermes-root" : target === "codex-cli" ? "codex-root" : "claude-root",
  );
  await mkdir(hermesRoot, { recursive: true });
  const runtime = {
    mcp: {
      [target]: {
        transport: "streamable-http",
        host: "127.0.0.1",
        ...(options?.omitPort ? {} : { port: options?.port ?? 38463 }),
      },
    },
  };

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: pluginName,
        version: "0.1.0",
        targets: {
          tools: [target],
        },
        runtime,
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo",
  description: "Echo via Hermes worker.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
};
`,
  );

  return { pluginRoot, hermesRoot };
};

const createValidationAgent = (
  name: string,
  sourcePath = `/tmp/${name}.agent.ts`,
): Agent =>
  new Agent({
    name,
    sourcePath,
    description: `${name} agent`,
    identity: "identity",
    skills: [],
    targets: {},
  });

const createCapabilityAgent = (options: {
  readonly name?: string;
  readonly identity?: string;
  readonly personality?: string;
  readonly skills?: string[];
}): Agent =>
  new Agent({
    name: options.name ?? "worker",
    sourcePath: `/tmp/${options.name ?? "worker"}.agent.ts`,
    description: "Capability worker",
    identity: options.identity ?? "identity",
    ...(options.personality ? { personality: options.personality } : {}),
    skills: options.skills ?? [],
    targets: {},
  });

const createResolveAgentRegistry = (): PluginRegistry => {
  const registry = emptyRegistry(
    "/tmp/resolve-agent-demo",
    "resolve-agent-demo",
    "0.1.0",
    {},
    { skills: ["opencode"] },
  );
  registry.identities.set(
    "identity",
    new Identity({
      name: "identity",
      sourcePath: "/tmp/identity.identity.md",
      description: "Identity description",
      body: "# Identity",
    }),
  );
  registry.personalities.set(
    "steady",
    new Personality({
      name: "steady",
      sourcePath: "/tmp/steady.personality.md",
      description: "Steady personality",
      body: "# Steady",
    }),
  );
  return registry;
};

const createAgentLoadFixture = async (agentSource: string): Promise<{
  readonly pluginRoot: string;
  readonly sourcePath: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "agent-normalization-demo");
  const sourcePath = join(pluginRoot, "agents", "worker.agent.ts");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "agent-normalization-demo",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(sourcePath, agentSource);

  return { pluginRoot, sourcePath };
};


const canonicalFixtureModelBlock = (harness: string): string => {
  if (harness === "opencode") {
    return JSON.stringify({
      model: "openai/gpt-5.4",
      variant: "xhigh",
      temperature: 0.2,
    });
  }
  if (harness === "claude-code") {
    return JSON.stringify({ model: "sonnet", temperature: 0.1 });
  }
  return JSON.stringify({ model: `${harness}-builder` });
};

const canonicalFixtureReviewerModelBlock = (harness: string): string => {
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

/**
 * Self-contained canonical compile fixture (migrated to the no-grants
 * contract): shared agent-core modelspace/skillspace deps, canonical
 * protocol-core tools, local canonical tools, three agents, and a
 * delivery-contract sop.
 */
const createCanonicalLanguageFixture = async (): Promise<{ pluginRoot: string; projectRoot: string }> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  const coreRoot = join(pluginRoot, "deps", "agent-core");
  const protocolRoot = join(pluginRoot, "deps", "protocol-core");
  const targetHarnesses = ["opencode", "claude-code"] as const;

  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "canonical-compile-fixture",
        version: "0.1.0",
        deps: {
          "agent-core": "./deps/agent-core",
          "protocol-core": "./deps/protocol-core",
        },
        targets: {
          agents: [...targetHarnesses],
          sops: [...targetHarnesses],
          tools: [...targetHarnesses],
          modelspaces: [...targetHarnesses],
          skillspaces: [...targetHarnesses],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(coreRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "agent-core",
        version: "0.1.0",
        targets: {
          modelspaces: [...targetHarnesses],
          skillspaces: [...targetHarnesses],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(protocolRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "protocol-core",
        version: "0.1.0",
        targets: {
          tools: [...targetHarnesses],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(coreRoot, "modelspaces", "default-models.modelspace.ts"),
    `
export default {
  name: "default-models",
  description: "Shared logical model profiles",
  profiles: {
    builder: {
      description: "Primary build profile",
      targets: {
        opencode: ${canonicalFixtureModelBlock("opencode")},
        "claude-code": ${canonicalFixtureModelBlock("claude-code")},
      },
    },
    reviewer: {
      description: "Primary review profile",
      targets: {
        opencode: ${canonicalFixtureReviewerModelBlock("opencode")},
        "claude-code": ${canonicalFixtureReviewerModelBlock("claude-code")},
      },
    },
  },
};
`,
  );

  await writeText(
    join(coreRoot, "skillspaces", "core-skills.skillspace.ts"),
    `
export default {
  name: "core-skills",
  description: "Harness-native core skill names",
  skills: {
    testing: {
      targets: {
        opencode: { name: "testing" },
        "claude-code": { name: "testing" },
      },
    },
  },
};
`,
  );

  await writeText(
    join(protocolRoot, "tools", "external-submit.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

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
};
`,
  );

  await writeText(
    join(protocolRoot, "tools", "create_glyph.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

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
};
`,
  );

  for (const tool of [
    { name: "submit-work", description: "Submit completed work" },
    { name: "commit-work", description: "Commit validated implementation work" },
    { name: "submit-review", description: "Submit review findings" },
  ] as const) {
    await writeText(
      join(pluginRoot, "tools", `${tool.name}.tool.ts`),
      `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: ${JSON.stringify(tool.name)},
  description: ${JSON.stringify(tool.description)},
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  async handle(input, context) {
    return { acknowledged: true };
  },
};
`,
    );
  }

  await writeText(
    join(pluginRoot, "identities", "builder.identity.md"),
    `---
description: Build specialist for canonical compile tests
---

# Builder

You implement one committed glyph and validate it before review.
`,
  );

  await writeText(
    join(pluginRoot, "identities", "reviewer.identity.md"),
    `---
description: Review specialist for canonical compile tests
---

# Reviewer

You assess completed work and report whether it is ready to ship.
`,
  );

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
`,
  );

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
`,
  );

  await writeText(
    join(pluginRoot, "agents", "security-reviewer.agent.ts"),
    `import { modelProfileRef, skillspaceRef, type AgentSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "security-reviewer",
  description: "Security reviewer variant using the same review profile",
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
`,
  );

  await writeText(
    join(pluginRoot, "sops", "delivery-contract.sop.ts"),
    `import type { SopSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "delivery-contract",
  description: "Validate that work moves through the right agents",
  phases: [
    {
      name: "Implement change",
      purpose: "Turn a ready work item into a reviewable implementation.",
      acceptance_criteria: ["Implementation is ready for review"],
      body: "Input: work item is ready to build. Done: implementation is ready for review.",
    },
    {
      name: "Review change",
      purpose: "Record review findings on the implementation.",
      acceptance_criteria: ["Review findings are recorded"],
      body: "Input: implementation is ready for review. Done: review findings are recorded.",
    },
    {
      name: "Hand off work",
      purpose: "Hand the reviewed work off cleanly.",
      acceptance_criteria: ["Work has been handed off cleanly"],
      body: "Input: build and review are complete. Done: work has been handed off cleanly.",
    },
  ],
  body: "Use this sop when you want a typed delivery procedure with explicit acceptance criteria.",
} satisfies SopSource;
`,
  );

  return { pluginRoot, projectRoot };
};


const createAntigravityPluginFixture = async (): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "antigravity-plugin-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "antigravity_plugin.demo",
        version: "0.2.0",
        targets: {
          rules: ["antigravity-cli"],
          skills: ["antigravity-cli"],
          agents: ["antigravity-cli"],
          sops: ["antigravity-cli"],
          tools: ["antigravity-cli"],
          hooks: ["antigravity-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "rules", "global", "context.md"), `# Antigravity context\n\nUse the generated plugin context.\n`);
  await writeText(join(pluginRoot, "rules", "project", "project-context.md"), `# Project context\n\nKeep plugin-local project guidance.\n`);
  await writeText(join(pluginRoot, "skills", "testing", "SKILL.md"), `---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n`);
  await writeText(join(pluginRoot, "identities", "worker.identity.md"), `---\ndescription: Worker identity\n---\n\n# Worker\n\nUse the plugin bundle.\n`);
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "submit-work",
  description: "Submit completed work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input, context) { return { acknowledged: true }; },
};
`);
  await writeText(join(pluginRoot, "agents", "worker.agent.ts"), `import { skillRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "worker",
  description: "Antigravity plugin worker",
  identity: "worker",
  skills: [skillRef("testing")],
  targets: {
    "antigravity-cli": {
      tools: ["read_file"],
    },
  },
};
`);
  await writeText(join(pluginRoot, "sops", "delivery.sop.ts"), `import type { SopSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "delivery",
  description: "Deliver work through Antigravity",
  phases: [{ name: "Build", purpose: "Ship the change.", body: "Do the work." }],
} satisfies SopSource;
`);
  await writeText(join(pluginRoot, "hooks", "audit-read.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-read",
  description: "Audit read calls",
  event: hookEvent.toolBefore,
  match: { tool: { kind: "hook-native-tool", name: "read_file" } },
  handle: (event) => Effect.succeed(
    event.tool.input?.block
      ? { decision: "block" as const, message: "read-blocked" }
      : { decision: "continue" as const },
  ),
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-submit.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-submit",
  description: "Audit canonical submit calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("submit-work") },
  handle: (event) => Effect.succeed(
    event.tool.input?.block
      ? { decision: "block" as const, message: "canonical-blocked" }
      : { decision: "continue" as const },
  ),
};
`);

  return { pluginRoot, projectRoot };
};

const createOpenCodeHookFixture = async (options?: {
  sessionHook?: boolean;
  promptAndPermissionHooks?: boolean;
}): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "opencode-hook-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "opencode-hook-demo",
        version: "0.1.0",
        targets: {
          hooks: ["opencode"],
          tools: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "hooks", "audit-before.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-before",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.native("bash") },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-after.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-after",
  event: hookEvent.toolAfter,
  match: { tool: hookTool.native("bash") },
  handle: (_event) => Effect.succeed({ decision: "block" as const, message: "ignored for observational hooks" }),
};
`);
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "submit-work",
  description: "Submit completed work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(_input, _context) { return { acknowledged: true }; },
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-submit.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-submit",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("submit-work") },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`);
  if (options?.sessionHook) {
    await writeText(join(pluginRoot, "hooks", "session-start.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-start",
  event: hookEvent.sessionStart,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`);
    await writeText(join(pluginRoot, "hooks", "session-end.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-end",
  event: hookEvent.sessionEnd,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`);
  }
  if (options?.promptAndPermissionHooks) {
    await writeText(join(pluginRoot, "hooks", "prompt-context.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "prompt-context",
  event: hookEvent.promptSubmit,
  handle: (event) => Effect.succeed({
    decision: "continue" as const,
    additionalContext: "prompt:" + event.prompt,
    systemMessage: "system:" + event.target.harness,
  }),
};
`);
    await writeText(join(pluginRoot, "hooks", "permission-guard.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "permission-guard",
  event: hookEvent.permissionRequest,
  match: { tool: hookTool.any() },
  handle: (event) => Effect.succeed(
    event.tool?.input?.metadata?.block
      ? { decision: "block" as const, message: "permission-blocked" }
      : { decision: "continue" as const },
  ),
};
`);
  }

  return { pluginRoot, projectRoot };
};

const createToolsOnlyRuntimeDepImportFixture = async (
  target: "opencode" | "cursor" | "amp-code" = "opencode",
): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "signal-core");
  const projectRoot = join(root, "project");
  const orbitRoot = join(pluginRoot, "deps", "orbit-core");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "signal-core",
        version: "0.1.0",
        deps: {
          "orbit-core": "./deps/orbit-core",
        },
        targets: {
          tools: [target],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(orbitRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "orbit-core",
        version: "0.1.0",
        targets: {
          tools: [target],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(orbitRoot, "tools", "shared", "orbit-server-client.ts"),
    `export const normalizeOrbitMessage = (value: string): string => value.trim().toUpperCase();
`,
  );
  await writeText(
    join(pluginRoot, "tools", "record_signal.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { normalizeOrbitMessage } from "../deps/orbit-core/tools/shared/orbit-server-client.ts";

export default {
  name: "record_signal",
  description: "Record a signal",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: normalizeOrbitMessage(input.message) };
  },
};
`,
  );

  return { pluginRoot, projectRoot };
};

const createExternalPermissionOnlyFixture = async (): Promise<{
  pluginRoot: string;
  protocolRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "consumer");
  const projectRoot = join(root, "project");
  const protocolRoot = join(pluginRoot, "deps", "protocol-core");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(protocolRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "protocol-core",
        version: "0.1.0",
        targets: {
          tools: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(protocolRoot, "schemas", "shared.ts"),
    `import { Schema } from "effect";

export const SharedInput = Schema.Struct({
  summary: Schema.String,
});
`,
  );
  await writeText(
    join(protocolRoot, "tools", "external-submit.tool.ts"),
    `import { Schema } from "effect";
import { SharedInput } from "../schemas/shared.ts";

export default {
  name: "external-submit",
  description: "Submit completed work through an external protocol plugin",
  input: SharedInput,
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  async handle(input, context) {
    return { acknowledged: true };
  },
};
`,
  );
  await writeText(
    join(protocolRoot, "tools", "unreferenced.tool.ts"),
    `import { Schema } from "effect";

export default {
  name: "unreferenced",
  description: "Should not be mirrored",
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  async handle(input, context) {
    return {};
  },
};
`,
  );

  return { pluginRoot, protocolRoot, projectRoot };
};

afterEach(async () => {
  process.env.PRISM_HOME = originalPrismHome;
  const roots = tempRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("readManifest accepts canonical compile target keys", async () => {
  const { pluginRoot } = await createCanonicalLanguageFixture();

  const manifest = await readManifest(pluginRoot);

  expect(manifest.name).toBe("canonical-compile-fixture");
  expect(manifest.targets).toEqual({
    agents: ["opencode", "claude-code"],
    sops: ["opencode", "claude-code"],
    tools: ["opencode", "claude-code"],
    modelspaces: ["opencode", "claude-code"],
    skillspaces: ["opencode", "claude-code"],
  });
});

test("readManifest treats skillspaces as compile artifacts", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "skillspace-manifest-demo",
        version: "0.1.0",
        targets: {
          skillspaces: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "core.skillspace.ts"),
    `
export default {
  name: "core",
  skills: {
    testing: {
      targets: {
        opencode: { name: "testing" },
      },
    },
  },
};
`,
  );

  const manifest = await readManifest(pluginRoot);

  expect(manifest.targets.skillspaces).toEqual(["opencode"]);
  expect(manifestHasCompileTargets(manifest, "opencode")).toBe(true);
  expect(formatManifestTargets(manifest)).toBe("skillspaces=[opencode]");
});

test("claw-harness preset targets Hermes", () => {
  expect(resolveManifestTargets(["claw-harness"])).toEqual(["hermes"]);
});

test("coding-harness preset includes admitted coding harnesses", () => {
  expect(resolveManifestTargets(["coding-harness"])).toContain("grok");
  expect(resolveManifestTargets(["coding-harness"])).toContain("kimi-code");
  expect(resolveManifestTargets(["coding-harness"])).toContain("pi");
  expect(resolveManifestTargets(["coding-harness"])).toContain("omp");
  expect(resolveManifestTargets(["coding-harness"])).toContain("cursor");
  expect(resolveManifestTargets(["coding-harness"])).toContain("opencode");
  expect(resolveManifestTargets(["coding-harness"])).not.toContain("amp-orb");
});

test("artifact target resolution filters unsupported preset members", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "preset-filter-demo");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "preset-filter-demo",
        version: "0.1.0",
        targets: {
          commands: ["coding-harness"],
          rules: ["coding-harness"],
          skills: ["coding-harness"],
        },
      },
      null,
      2,
    )}\n`,
  );

  const manifest = await readManifest(pluginRoot);

  expect(getManifestArtifactTargets(manifest, "commands")).not.toContain("grok");
  expect(getManifestArtifactTargets(manifest, "commands")).not.toContain("antigravity-cli");
  expect(getManifestArtifactTargets(manifest, "commands")).toContain("claude-code");
  expect(getManifestArtifactTargets(manifest, "commands")).toContain("amp-code");
  expect(getManifestArtifactTargets(manifest, "commands")).toContain("cursor");
  expect(getManifestArtifactTargets(manifest, "commands")).toContain("kimi-code");
  expect(getManifestArtifactTargets(manifest, "commands")).toContain("pi");
  expect(getManifestArtifactTargets(manifest, "rules")).toContain("grok");
  expect(getManifestArtifactTargets(manifest, "rules")).toContain("antigravity-cli");
  expect(getManifestArtifactTargets(manifest, "rules")).toContain("kimi-code");
  expect(getManifestArtifactTargets(manifest, "rules")).toContain("pi");
  expect(getManifestArtifactTargets(manifest, "skills")).toContain("grok");
  expect(getManifestArtifactTargets(manifest, "skills")).toContain("kimi-code");
  expect(getManifestArtifactTargets(manifest, "skills")).toContain("pi");
  expect(getManifestArtifactTargets(manifest, "skills")).toContain("cursor");
  expect(manifestHasCompileTargets(manifest, "antigravity-cli")).toBe(true);
  expect(manifestHasCompileTargets(manifest, "kimi-code")).toBe(true);
  expect(manifestHasCompileTargets(manifest, "pi")).toBe(true);
  expect(manifestHasCompileTargets(manifest, "cursor")).toBe(true);
});

test("Cursor compile support includes tools, agents, and hooks", async () => {
  const root = await createTempRoot();
  const toolOnlyRoot = join(root, "cursor-tools-only");
  await writeText(
    join(toolOnlyRoot, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-tools-only",
      version: "0.1.0",
      targets: { tools: ["cursor"] },
    })}\n`,
  );

  const manifest = await readManifest(toolOnlyRoot);
  expect(manifestHasCompileTargets(manifest, "cursor")).toBe(true);

  const agentRoot = join(root, "cursor-agent-supported");
  await writeText(
    join(agentRoot, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-agent-supported",
      version: "0.1.0",
      targets: { agents: ["cursor"] },
    })}\n`,
  );

  const agentManifest = await readManifest(agentRoot);
  expect(getManifestArtifactTargets(agentManifest, "agents")).toContain("cursor");
});

test("compilePluginForTarget lowers Cursor agents and plugin hooks", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "cursor-compile-demo");
  const cursorRoot = join(root, "cursor-home");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-compile-demo",
      version: "0.1.0",
      targets: {
        agents: ["cursor"],
        hooks: ["cursor"],
      },
    })}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "reviewer.identity.md"),
    `---\ndescription: Reviewer identity\n---\n\n# Reviewer\n\nReview carefully.\n`,
  );
  await writeText(
    join(pluginRoot, "agents", "reviewer.agent.ts"),
    `export default {
  name: "reviewer",
  description: "Cursor plugin reviewer",
  identity: "reviewer",
};
`,
  );
  await writeText(
    join(pluginRoot, "hooks", "session-start.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-start",
  event: hookEvent.sessionStart,
  handle: () => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  try {
    const result = await Effect.runPromise(
      compilePluginForTarget({
        prismHome: testPrismHome(),
        pluginPath: pluginRoot,
        target: "cursor",
        scope: "global",
        dryRun: true,
        root: cursorRoot,
      }),
    );
    const targets = result.operations
      .map((operation) => ("targetPath" in operation ? operation.targetPath : ""))
      .filter((path) => path.length > 0);
    const pluginDir = join(cursorRoot, "plugins", "local", "prism-generated-cursor-compile-demo");
    expect(targets).toContain(join(pluginDir, ".cursor-plugin", "plugin.json"));
    expect(targets).toContain(join(pluginDir, "agents", "reviewer.md"));
    expect(targets).toContain(join(pluginDir, "hooks", "hooks.json"));
    expect(targets).toContain(join(pluginDir, "hooks", "session-start.mjs"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("direct unsupported Grok command targets are rejected", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "direct-grok-command-demo");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "direct-grok-command-demo",
        version: "0.1.0",
        targets: {
          commands: ["grok"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await expect(readManifest(pluginRoot)).rejects.toThrow(
    "targets.commands resolves to unsupported harnesses for commands: grok (Grok Build)",
  );
});

test("direct unsupported Antigravity command targets are rejected", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "direct-antigravity-command-demo");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "direct-antigravity-command-demo",
        version: "0.1.0",
        targets: {
          commands: ["antigravity-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await expect(readManifest(pluginRoot)).rejects.toThrow(
    "targets.commands resolves to unsupported harnesses for commands: antigravity-cli (Antigravity CLI)",
  );
});

test("direct Amp, Claude, Kimi, and Pi commands are compile-managed plugin artifact targets", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "managed-plugin-artifact-demo");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "managed-plugin-artifact-demo",
        version: "0.1.0",
        targets: {
          rules: ["kimi-code", "pi"],
          commands: ["amp-code", "claude-code", "kimi-code", "pi"],
        },
      },
      null,
      2,
    )}\n`,
  );

  const manifest = await readManifest(pluginRoot);
  expect(getManifestArtifactTargets(manifest, "rules")).toContain("pi");
  expect(getManifestArtifactTargets(manifest, "rules")).toContain("kimi-code");
  expect(getManifestArtifactTargets(manifest, "commands")).toContain("amp-code");
  expect(getManifestArtifactTargets(manifest, "commands")).toContain("claude-code");
  expect(getManifestArtifactTargets(manifest, "commands")).toContain("pi");
  expect(getManifestArtifactTargets(manifest, "commands")).toContain("kimi-code");
  expect(manifestHasCompileTargets(manifest, "amp-code")).toBe(true);
  expect(manifestHasCompileTargets(manifest, "claude-code")).toBe(true);
  expect(manifestHasCompileTargets(manifest, "pi")).toBe(true);
  expect(manifestHasCompileTargets(manifest, "kimi-code")).toBe(true);
});

test("opencode model pools distribute same-profile agents by stable peer order", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "model-pool-plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "model-pool-plugin",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          modelspaces: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "modelspaces", "reviewers.modelspace.ts"),
    `
export default {
  name: "reviewers",
  profiles: {
    "verification-throughput": {
      targets: {
        opencode: {
          strategy: "any-of",
          models: [
            { model: "provider-a/kimi-k2.6" },
            { model: "provider-b/kimi-k2.6" },
            { model: "provider-c/kimi-k2.6" },
            { model: "provider-d/kimi-k2.6" },
          ],
        },
      },
    },
  },
};
`,
  );

  await writeText(
    join(pluginRoot, "identities", "reviewer.identity.md"),
    `---
description: Model pool reviewer identity
---

# Reviewer

You verify work.
`,
  );

  for (let index = 0; index < 10; index++) {
    const suffix = String(index).padStart(2, "0");
    await writeText(
      join(pluginRoot, "agents", `reviewer-${suffix}.agent.ts`),
      `import { modelProfileRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "reviewer-${suffix}",
  description: "Reviewer ${suffix}",
  identity: "reviewer",
  model: modelProfileRef("reviewers", "verification-throughput"),
};
`,
    );
  }

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const models = result.composed
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((agent) => agent.model?.model);

  expect(models).toEqual([
    "provider-a/kimi-k2.6",
    "provider-b/kimi-k2.6",
    "provider-c/kimi-k2.6",
    "provider-d/kimi-k2.6",
    "provider-a/kimi-k2.6",
    "provider-b/kimi-k2.6",
    "provider-c/kimi-k2.6",
    "provider-d/kimi-k2.6",
    "provider-a/kimi-k2.6",
    "provider-b/kimi-k2.6",
  ]);
});

test("amp agents do not demand modelspace target cells because the surface is model-free", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "amp-model-free-plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "amp-model-free-plugin",
        version: "0.1.0",
        targets: {
          agents: ["amp-code"],
          modelspaces: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "modelspaces", "models.modelspace.ts"),
    `
export default {
  name: "models",
  profiles: {
    default: {
      targets: {
        opencode: { model: "openai/gpt-5" },
      },
    },
  },
};
`,
  );

  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker

You work through Amp role-skill guidance.
`,
  );

  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { modelProfileRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  model: modelProfileRef("models", "default"),
};
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.composed).toHaveLength(1);
  expect(result.composed[0]!.name).toBe("worker");
  expect(result.composed[0]!.model).toBeUndefined();
});

test("resolveAgent reports missing identity and personality references", async () => {
  const missingIdentityRegistry = createResolveAgentRegistry();
  missingIdentityRegistry.identities.clear();

  const missingIdentityExit = await Effect.runPromiseExit(
    resolveAgent(
      createCapabilityAgent({ identity: "missing-identity" }),
      missingIdentityRegistry,
      "opencode",
    ),
  );
  const missingIdentityFailure = getFailure(missingIdentityExit);
  expect(missingIdentityFailure._tag).toBe("UnknownReferenceError");
  if (missingIdentityFailure._tag === "UnknownReferenceError") {
    expect(missingIdentityFailure.field).toBe("identity");
    expect(missingIdentityFailure.referenceName).toBe("missing-identity");
  }

  const missingPersonalityRegistry = createResolveAgentRegistry();
  const missingPersonalityExit = await Effect.runPromiseExit(
    resolveAgent(
      createCapabilityAgent({ personality: "missing-personality" }),
      missingPersonalityRegistry,
      "opencode",
    ),
  );
  const missingPersonalityFailure = getFailure(missingPersonalityExit);
  expect(missingPersonalityFailure._tag).toBe("UnknownReferenceError");
  if (missingPersonalityFailure._tag === "UnknownReferenceError") {
    expect(missingPersonalityFailure.field).toBe("personality");
    expect(missingPersonalityFailure.referenceName).toBe("missing-personality");
  }
});

test("compilePluginForTarget dry-run leaves lowerer outputs cache and lockfile untouched", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
    }),
  );

  expect(result.operations.length).toBeGreaterThan(0);
  expect(result.backups).toEqual([]);
  expect(result.lockfilePath).toBeNull();
  expect(await pathExists(join(pluginRoot, "prism.lock"))).toBe(false);
  expect(await directoryExists(join(pluginRoot, "dist", ".prism-cache"))).toBe(false);
  expect(
    await pathExists(join(projectRoot, ".opencode", "agents", "builder.md")),
  ).toBe(false);
  expect(await directoryExists(join(projectRoot, ".opencode", "plugins"))).toBe(
    false,
  );
});

test("compilePluginForTarget collects per-op failures instead of aborting the batch", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();
  await writeText(join(projectRoot, ".opencode", "agents"), "not a directory\n");

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  // Agent markdown writes under the foreign `agents` file fail, but the rest
  // of the batch (skills, generated plugin, opencode.json regions) lands.
  expect(result.failures.length).toBeGreaterThan(0);
  expect(result.failures.every((failure) =>
    failure.op.targetPath.includes(join(".opencode", "agents")),
  )).toBe(true);
  expect(await pathExists(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
  )).toBe(true);

  // Failed targets are withheld from the snapshot so the next run retries
  // them from disk truth.
  const snapshot = await readSnapshot({
    prismHome: testPrismHome(),
    harness: "opencode",
    root: result.outputRoot,
  });
  for (const failure of result.failures) {
    expect(snapshot.manifest.entries.some(
      (entry) => entry.targetPath === failure.op.targetPath,
    )).toBe(false);
  }
});

test("loadPlugin preserves agent normalization failure order", async () => {
  const cases: ReadonlyArray<{
    readonly agentSource: string;
    readonly message: string;
  }> = [
    {
      agentSource: `export default {
  name: "not-worker",
  description: "Worker",
  identity: "worker",
};
`,
      message: "AgentNameMismatchError:not-worker",
    },
    {
      agentSource: `export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  model: { kind: "model-profile-ref", modelspace: "", name: "reviewer" },
};
`,
      message:
        "model: model profile ref object must include a non-empty 'modelspace'",
    },
    {
      agentSource: `export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  model: "raw-model",
};
`,
      message:
        "model: must reference a canonical model profile (<modelspace>/<name> or modelProfileRef(...))",
    },
    {
      agentSource: `export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  skills: ["testing"],
};
`,
      message:
        "skills[0]: plain skill strings are not allowed; use skillRef(...) for managed plugin skills or skillspaceRef(...) for harness-native skills",
    },
  ];

  for (const current of cases) {
    const { pluginRoot, sourcePath } = await createAgentLoadFixture(current.agentSource);
    const exit = await Effect.runPromiseExit(loadPlugin(pluginRoot));
    const failure = getFailure(exit);

    if (current.message.startsWith("AgentNameMismatchError:")) {
      expect(failure._tag).toBe("AgentNameMismatchError");
      if (failure._tag === "AgentNameMismatchError") {
        expect(failure.sourcePath).toBe(sourcePath);
        expect(failure.agentName).toBe(
          current.message.slice("AgentNameMismatchError:".length),
        );
      }
      continue;
    }

    expect(failure._tag).toBe("SourceParseError");
    if (failure._tag === "SourceParseError") {
      expect(failure.kind).toBe("agent");
      expect(failure.sourcePath).toBe(sourcePath);
      expect(failure.message).toBe(current.message);
    }
  }
});

test("compilePluginForTarget emits an Antigravity plugin bundle", async () => {
  const { pluginRoot, projectRoot } = await createAntigravityPluginFixture();
  const outputPluginRoot = join(projectRoot, ".agents", "plugins", "prism-generated-antigravity-plugin-demo");
  const stalePath = join(outputPluginRoot, "stale", "old.txt");
  const staleContent = "stale\n";
  await writeText(stalePath, staleContent);
  // Snapshot membership is ownership: a previously managed file that is no
  // longer desired gets pruned by the sync engine.
  await commitSnapshot({
    prismHome: testPrismHome(),
    manifest: {
      version: 1,
      harness: "antigravity-cli",
      root: join(projectRoot, ".agents"),
      entries: [{
        targetPath: stalePath,
        contentHash: computeContentHash(staleContent),
        mode: "owned",
        plugin: "antigravity_plugin.demo",
      }],
    },
  });

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "antigravity-cli",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.composed).toHaveLength(1);
  expect(result.outputRoot.replace(/\/$/u, "")).toBe(join(projectRoot, ".agents"));

  const manifest = JSON.parse(await readFile(join(outputPluginRoot, "plugin.json"), "utf8")) as {
    name: string;
    version: string;
  };

  expect(manifest).toEqual({
    name: "prism-generated-antigravity-plugin-demo",
    version: "0.2.0",
  });

  // 
  expect(await pathExists(join(outputPluginRoot, "mcp_config.json"))).toBe(false);
  // 
  const antigravityMcpToolName = "antigravity_plugin_demo_submit_work";

  const context = await readFile(join(outputPluginRoot, "rules", "context.md"), "utf8");
  expect(context).toContain("<!-- prism:context-source global/context.md -->");
  expect(context).toContain("# Antigravity context");
  expect(context).toContain("<!-- prism:context-source project/project-context.md -->");
  expect(context).toContain("# Project context");

  const agent = await readFile(join(outputPluginRoot, "agents", "worker.md"), "utf8");
  const parsedAgent = matter(agent);
  expect(parsedAgent.data).toMatchObject({
    name: "worker",
    description: "Antigravity plugin worker",
    skills: ["testing"],
    tools: [
      "read_file",
    ],
  });
  expect(parsedAgent.data.tools ?? []).not.toContain(antigravityMcpToolName);
  expect(parsedAgent.content).toContain("# Worker");

  expect(await readFile(join(outputPluginRoot, "skills", "testing", "SKILL.md"), "utf8")).toContain("# Testing");
  const sopSkill = await readFile(join(outputPluginRoot, "skills", "delivery", "SKILL.md"), "utf8");
  expect(sopSkill).not.toContain("<!-- prism:");
  expect(sopSkill).toContain("# delivery");
  expect(sopSkill).toContain("Ship the change.");

  expect(await pathExists(join(testPrismHome(), "runtime", "mcp", "antigravity_plugin.demo", "server.mjs"))).toBe(false);

  const hookConfig = JSON.parse(await readFile(join(outputPluginRoot, "hooks.json"), "utf8")) as {
    "audit-read": { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    "audit-submit": { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };
  expect(hookConfig).toEqual({
    "audit-read": {
      PreToolUse: [
        {
          matcher: "read_file",
          hooks: [{ type: "command", command: 'node "./hooks/audit-read.mjs"' }],
        },
      ],
    },
    "audit-submit": {
      PreToolUse: [
        {
          matcher: antigravityMcpToolName,
          hooks: [{ type: "command", command: 'node "./hooks/audit-submit.mjs"' }],
        },
      ],
    },
  });
  const hookWrapper = await readFile(join(outputPluginRoot, "hooks", "audit-submit.mjs"), "utf8");
  expect(hookWrapper).toStartWith("#!/usr/bin/env node");
  expect(hookWrapper).toContain("antigravity-cli");
  expect(hookWrapper).toContain("PreToolUse");
  expect(hookWrapper).not.toContain("hookSpecificOutput");
  expect(hookWrapper).toContain('decision: "deny"');
  expect(hookWrapper).toContain("reason:");
  expect(hookWrapper).not.toContain("stopReason");
  expect(hookWrapper).not.toContain("continue:!1");
  expect(hookWrapper).not.toContain("continue:false");
  expect(hookWrapper).toContain("validation failed");
  expect(hookWrapper).toContain("result");

  const directHookProcess = Bun.spawn({
    cmd: [process.execPath, join(outputPluginRoot, "hooks", "audit-read.mjs")],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  directHookProcess.stdin.write(JSON.stringify({
    toolCall: { name: "read_file", args: { block: true } },
    conversationId: "session-1",
    artifactDirectoryPath: join(pluginRoot, "artifacts"),
    workspacePaths: [pluginRoot],
  }));
  directHookProcess.stdin.end();
  const [directHookExit, directHookStdout, directHookStderr] = await Promise.all([
    directHookProcess.exited,
    new Response(directHookProcess.stdout).text(),
    new Response(directHookProcess.stderr).text(),
  ]);
  expect(directHookExit).toBe(0);
  expect(directHookStderr).toBe("");
  expect(JSON.parse(directHookStdout.trim())).toEqual({
    decision: "deny",
    reason: "read-blocked",
  });

  const canonicalHookProcess = Bun.spawn({
    cmd: [process.execPath, join(outputPluginRoot, "hooks", "audit-submit.mjs")],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  canonicalHookProcess.stdin.write(JSON.stringify({
    toolCall: {
      name: antigravityMcpToolName,
      args: { block: true },
    },
    conversationId: "session-2",
    workspacePaths: [pluginRoot],
  }));
  canonicalHookProcess.stdin.end();
  const [canonicalHookExit, canonicalHookStdout, canonicalHookStderr] = await Promise.all([
    canonicalHookProcess.exited,
    new Response(canonicalHookProcess.stdout).text(),
    new Response(canonicalHookProcess.stderr).text(),
  ]);
  expect(canonicalHookExit).toBe(0);
  expect(canonicalHookStderr).toBe("");
  expect(JSON.parse(canonicalHookStdout.trim())).toEqual({
    decision: "deny",
    reason: "canonical-blocked",
  });

  expect(await pathExists(join(outputPluginRoot, "stale", "old.txt"))).toBe(false);
  expect(result.operations.some((operation) => operation.kind === "prune" && operation.targetPath.endsWith(join("stale", "old.txt")))).toBe(true);

  const outputFiles = [
    join(outputPluginRoot, "plugin.json"),
    join(outputPluginRoot, "rules", "context.md"),
    join(outputPluginRoot, "agents", "worker.md"),
    join(outputPluginRoot, "skills", "testing", "SKILL.md"),
    join(outputPluginRoot, "skills", "delivery", "SKILL.md"),
    join(outputPluginRoot, "hooks.json"),
    join(outputPluginRoot, "hooks", "audit-read.mjs"),
    join(outputPluginRoot, "hooks", "audit-submit.mjs"),
  ];
  const outputSnapshot = Object.fromEntries(
    await Promise.all(
      outputFiles.map(async (path) => [path, computeContentHash(await readFile(path, "utf8"))]),
    ),
  );
  const snapshotBefore = await readSnapshot({
    prismHome: testPrismHome(),
    harness: "antigravity-cli",
    root: join(projectRoot, ".agents"),
  });

  const warmCompile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "antigravity-cli",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(warmCompile.converged).toBe(true);
  expect(warmCompile.operations.filter(
    (operation) => operation.kind === "create" || operation.kind === "repair",
  )).toEqual([]);
  expect(warmCompile.operations.some((operation) => operation.kind === "skip")).toBe(true);
  expect(warmCompile.operations.some((operation) => operation.kind === "prune")).toBe(false);
  expect(Object.fromEntries(
    await Promise.all(
      outputFiles.map(async (path) => [path, computeContentHash(await readFile(path, "utf8"))]),
    ),
  )).toEqual(outputSnapshot);
  // A converged run leaves the snapshot manifest byte-identical.
  expect(await readSnapshot({
    prismHome: testPrismHome(),
    harness: "antigravity-cli",
    root: join(projectRoot, ".agents"),
  })).toEqual(snapshotBefore);
});

test("compilePluginForTarget lowers OpenCode session hooks through plugin events", async () => {
  const { pluginRoot, projectRoot } = await createOpenCodeHookFixture({ sessionHook: true });

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const generatedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-opencode-hook-demo",
  );
  const serverSource = await readFile(join(generatedRoot, "dist", "server.mjs"), "utf8");

  expect(serverSource).toContain('"tool.execute.before"');
  expect(serverSource).toContain('"tool.execute.after"');
  expect(serverSource).toContain('"opencode_hook_demo_submit_work"');
  expect(serverSource).not.toContain("/Projects/prism/src/compile/sources.ts");
  expect(serverSource).toContain('"session.status"');
  expect(serverSource).toContain('"busy"');
  expect(serverSource).toContain('"session.start"');
  expect(serverSource).toContain('"idle"');
  expect(serverSource).toContain('"session.idle"');
  expect(serverSource).toContain('"session.end"');
  expect(serverSource).toContain("decodeNativeHookPayloadForEvent");
  expect(serverSource).toContain("decodeHookResultForEvent");
  expect(serverSource).not.toContain(prismImportPath);
  expect(await pathExists(join(generatedRoot, "src", "server.ts"))).toBe(false);
  expect(await pathExists(join(generatedRoot, "src", "runtime", "hook-runtime.ts"))).toBe(false);
  expect(await pathExists(join(generatedRoot, "src", "runtime", "hook-authoring-bridge.ts"))).toBe(false);
});

test("compilePluginForTarget lowers OpenCode prompt and permission hooks through plugin events", async () => {
  const { pluginRoot, projectRoot } = await createOpenCodeHookFixture({
    promptAndPermissionHooks: true,
  });

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const generatedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-opencode-hook-demo",
  );
  const serverSource = await readFile(join(generatedRoot, "dist", "server.mjs"), "utf8");

  expect(serverSource).toContain('"chat.message"');
  expect(serverSource).toContain('"prompt.submit"');
  expect(serverSource).toContain("promptText(output)");
  expect(serverSource).toContain("appendPromptContext");
  expect(serverSource).toContain('"permission.ask"');
  expect(serverSource).toContain('"permission.request"');
  expect(serverSource).toContain('output.status = "deny"');
  expect(serverSource).toContain('output.status = "allow"');
  expect(serverSource).toContain("additionalContext");
  expect(serverSource).toContain("systemMessage");
  expect(serverSource).toContain("permission-guard");
  expect(serverSource).toContain("prompt-context");
  expect(serverSource).not.toContain(prismImportPath);
});

test("compilePluginForTarget lowers executable canonical tools for opencode", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();
  const protocolRoot = join(pluginRoot, "deps", "protocol-core");

  // Per-plugin one-writer scheme: the owner (protocol-core) is the sole
  // producer of its own OpenCode bundle. Compile it explicitly first, the
  // same way the claude-code precedent below does — the consumer no longer
  // re-materializes it (src/compile/lowerers/opencode.ts).
  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: protocolRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const opencode = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(opencode.composed).toHaveLength(3);

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "builder.md"),
    "utf8",
  );
  expect(opencodeAgent).toContain('name: "builder"');
  expect(opencodeAgent).toContain(
    'description: "Builder agent for canonical compile integration tests"',
  );
  expect(opencodeAgent).not.toContain("permission:");
  expect(opencodeAgent).not.toContain("tools:");
  expect(opencodeAgent).toContain("## Recommended Skills");
  expect(opencodeAgent).toContain("- `testing`");

  const reviewerAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "reviewer.md"),
    "utf8",
  );
  expect(reviewerAgent).toContain('name: "reviewer"');
  expect(reviewerAgent).toContain("- `testing`");

  const generatedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-canonical-compile-fixture",
  );
  const protocolGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-protocol-core",
  );
  const generatedBundlePath = join(generatedRoot, "dist", "server.mjs");
  const protocolBundlePath = join(protocolGeneratedRoot, "dist", "server.mjs");
  const generatedServer = await import(pathToFileURL(generatedBundlePath).href);
  expect(generatedServer.default.id).toBe("prism-generated-canonical-compile-fixture");
  const generatedPlugin = await generatedServer.default.server({
    directory: projectRoot,
    worktree: projectRoot,
  });
  const generatedToolNames = Object.keys(generatedPlugin.tool ?? {});
  expect(generatedToolNames).toContain("canonical_compile_fixture_submit_work");
  expect(generatedToolNames).toContain("canonical_compile_fixture_commit_work");
  expect(generatedToolNames).toContain("canonical_compile_fixture_submit_review");
  expect(generatedToolNames).not.toContain("protocol_core_external_submit");
  expect(await pathExists(join(generatedRoot, "src", "server.ts"))).toBe(false);
  expect(await pathExists(join(generatedRoot, "package.json"))).toBe(false);
  expect(await pathExists(join(generatedRoot, "node_modules", "effect", "package.json"))).toBe(false);

  const generatedServerSource = await readFile(generatedBundlePath, "utf8");
  expect(generatedServerSource).not.toContain("canonical.handle");
  expect(generatedServerSource).not.toContain('from "prism"');
  expect(generatedServerSource).not.toContain("src/index.ts");
  expect(generatedServerSource).not.toContain("schemaSlot");
  expect(generatedServerSource).not.toContain("defineTool");
  expect(generatedServerSource).not.toContain('from "effect"');
  expect(generatedServerSource).not.toContain('from "@opencode-ai/plugin"');
  expect(generatedServerSource).not.toContain('"protocol_core_external_submit":');
  expect(generatedServerSource).toContain("canonical_compile_fixture_submit_work");
  expect(generatedServerSource).not.toContain("Schema.omit");
  expect(generatedServerSource).not.toContain("prism-generated-protocol-core/src/plugins");

  const protocolServer = await import(pathToFileURL(protocolBundlePath).href);
  const protocolPlugin = await protocolServer.default.server({
    directory: projectRoot,
    worktree: projectRoot,
  });
  const protocolToolNames = Object.keys(protocolPlugin.tool ?? {});
  expect(protocolToolNames).toContain("protocol_core_external_submit");
  expect(protocolToolNames).toContain("protocol_core_create_glyph");
  const protocolGeneratedServerSource = await readFile(protocolBundlePath, "utf8");
  expect(protocolGeneratedServerSource).not.toContain('from "effect"');
  expect(protocolGeneratedServerSource).not.toContain('from "@opencode-ai/plugin"');
  expect(await pathExists(join(protocolGeneratedRoot, "src", "server.ts"))).toBe(false);
  expect(await pathExists(join(protocolGeneratedRoot, "package.json"))).toBe(false);

  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as {
    agent: Record<string, Record<string, unknown>>;
    plugin: string[];
    permission?: Record<string, string>;
  };
  expect(opencodeConfig.permission).toBeUndefined();
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(
      projectRoot,
      "prism-generated-canonical-compile-fixture",
    ),
  );
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(projectRoot, "prism-generated-protocol-core"),
  );
  expect(opencodeConfig.agent.builder?.model).toBe("openai/gpt-5.4");
  expect(opencodeConfig.agent.builder?.variant).toBe("xhigh");
  expect(opencodeConfig.agent.builder?.temperature).toBe(0.2);
  expect(opencodeConfig.agent.reviewer?.model).toBe("openai/gpt-5.4-reviewer-a");
  expect(opencodeConfig.agent["security-reviewer"]?.model).toBe(
    "openai/gpt-5.4-reviewer-b",
  );
  expect(opencodeConfig.agent.reviewer?.variant).toBe("medium");
  expect(opencodeConfig.agent["security-reviewer"]?.variant).toBe("medium");
  expect(opencodeConfig.agent.builder?.mode).toBe("subagent");
  expect(opencodeConfig.agent.builder?.maxSteps).toBe(12);
  expect(
    await pathExists(
      join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    ),
  ).toBe(true);
  expect(
    await pathExists(
      join(projectRoot, ".opencode", "sops", "delivery-contract.md"),
    ),
  ).toBe(false);
});

test("compilePluginForTarget lowers executable canonical tools for Amp plugins", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "amp-tool-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "amp-tool-demo",
        version: "0.1.0",
        targets: {
          tools: ["amp-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo",
  description: "Echo a message through Amp.",
  input: Schema.Struct({
    message: Schema.String.annotate({ description: "Message to echo" }),
  }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
};
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.outputRoot).toBe(join(projectRoot, ".agents/"));
  const pluginPath = join(projectRoot, ".amp", "plugins", "prism-generated-amp-tool-demo.ts");
  expect(await pathExists(pluginPath)).toBe(true);

  const generated = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`) as {
    readonly default: (amp: { registerTool(definition: unknown): void }) => void;
  };
  const registeredTools: unknown[] = [];
  generated.default({ registerTool: (definition) => { registeredTools.push(definition); } });

  expect(registeredTools).toHaveLength(1);
  const echo = registeredTools[0] as {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: {
      readonly type: string;
      readonly properties?: Record<string, { description?: string }>;
      readonly required?: string[];
    };
    readonly execute: (
      input: Record<string, unknown>,
      ctx: { logger: { log: (...args: unknown[]) => void } },
    ) => Promise<string>;
  };
  expect(echo.name).toBe("amp_tool_demo_echo");
  expect(echo.description).toBe("Echo a message through Amp.");
  expect(echo.inputSchema.type).toBe("object");
  expect(echo.inputSchema.properties?.message?.description).toBe("Message to echo");
  expect(echo.inputSchema.required).toEqual(["message"]);
  await expect(echo.execute({ message: "hello" }, { logger: { log: () => undefined } }))
    .resolves.toBe(JSON.stringify({ echoed: "hello" }, null, 2));

  const source = await readFile(pluginPath, "utf8");
  expect(source).toContain("registerTool");
  expect(source).not.toContain('from "prism"');
  expect(source).not.toContain('from "effect"');
  expect(source).not.toContain("defineTool");
});

test("compilePluginForTarget lowers Amp tools and hooks through one native plugin", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "amp-hook-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "amp-hook-demo",
        version: "0.1.0",
        targets: {
          tools: ["amp-code"],
          hooks: ["amp-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo",
  description: "Echo a message through Amp hooks.",
  input: Schema.Struct({
    message: Schema.String,
  }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "hooks", "audit-before.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-before",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.any() },
  handle: (event) => Effect.succeed(
    typeof event.tool.input === "object" &&
      event.tool.input !== null &&
      "block" in event.tool.input &&
      event.tool.input.block === true
      ? { decision: "block" as const, message: \`blocked \${event.tool.nativeName}\` }
      : { decision: "continue" as const },
  ),
};
`,
  );
  await writeText(
    join(pluginRoot, "hooks", "session-start.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-start",
  event: hookEvent.sessionStart,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );
  await writeText(
    join(pluginRoot, "hooks", "audit-after.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-after",
  event: hookEvent.toolAfter,
  match: { tool: { kind: "hook-native-tool", name: "amp_hook_demo_echo" } },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.outputRoot).toBe(join(projectRoot, ".agents/"));
  const pluginPath = join(projectRoot, ".amp", "plugins", "prism-generated-amp-hook-demo.ts");
  expect(await pathExists(pluginPath)).toBe(true);

  const generated = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`) as {
    readonly default: (amp: {
      readonly registerTool: (definition: unknown) => void;
      readonly on: (event: string, handler: (...args: unknown[]) => unknown) => void;
    }) => void;
  };
  const registeredTools: unknown[] = [];
  const registeredEvents = new Map<string, Array<(...args: unknown[]) => unknown>>();
  generated.default({
    registerTool: (definition) => { registeredTools.push(definition); },
    on: (event, handler) => {
      registeredEvents.set(event, [...(registeredEvents.get(event) ?? []), handler]);
    },
  });

  expect(registeredTools).toHaveLength(1);
  expect([...registeredEvents.keys()].sort()).toEqual([
    "session.start",
    "tool.call",
    "tool.result",
  ]);
  const toolCall = registeredEvents.get("tool.call")?.[0];
  const toolResult = registeredEvents.get("tool.result")?.[0];
  const sessionStart = registeredEvents.get("session.start")?.[0];
  if (!toolCall || !toolResult || !sessionStart) {
    throw new Error("expected generated Amp hook handlers");
  }

  await expect(toolCall({
    thread: { id: "T-1" },
    tool: "amp_hook_demo_echo",
    input: { block: false },
  }, { thread: { id: "T-1" } })).resolves.toEqual({ action: "allow" });
  await expect(toolCall({
    thread: { id: "T-1" },
    tool: "amp_hook_demo_echo",
    input: { block: true },
  }, { thread: { id: "T-1" } })).resolves.toEqual({
    action: "reject-and-continue",
    message: "blocked amp_hook_demo_echo",
  });
  await expect(toolResult({
    thread: { id: "T-1" },
    toolUseID: "toolu_1",
    tool: "amp_hook_demo_echo",
    input: { message: "hello" },
    status: "done",
    output: "ok",
  }, { thread: { id: "T-1" } })).resolves.toBeUndefined();
  await expect(toolResult({
    thread: { id: "T-1" },
    toolUseID: "toolu_2",
    tool: "unmatched_tool",
    input: { message: "ignored" },
    status: "done",
    output: "ignored",
  }, { thread: { id: "T-1" } })).resolves.toBeUndefined();
  await expect(sessionStart({
    thread: { id: "T-1" },
  }, { thread: { id: "T-1" } })).resolves.toBeUndefined();

  const source = await readFile(pluginPath, "utf8");
  expect(source).toContain("registerTool");
  expect(source).toContain('on?.("tool.call"');
  expect(source).toContain('on?.("tool.result"');
  expect(source).toContain('on?.("session.start"');
});

test("compilePluginForTarget lowers hook-only Amp plugins without tool registrations", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "amp-hook-only-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "amp-hook-only-demo",
        version: "0.1.0",
        targets: {
          hooks: ["amp-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "hooks", "audit-before.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-before",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.any() },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );
  await writeText(
    join(pluginRoot, "hooks", "session-start.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-start",
  event: hookEvent.sessionStart,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const pluginPath = join(projectRoot, ".amp", "plugins", "prism-generated-amp-hook-only-demo.ts");
  const generated = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`) as {
    readonly default: (amp: {
      readonly registerTool: (definition: unknown) => void;
      readonly on: (event: string, handler: (...args: unknown[]) => unknown) => void;
    }) => void;
  };
  const registeredTools: unknown[] = [];
  const registeredEvents = new Map<string, Array<(...args: unknown[]) => unknown>>();
  generated.default({
    registerTool: (definition) => { registeredTools.push(definition); },
    on: (event, handler) => {
      registeredEvents.set(event, [...(registeredEvents.get(event) ?? []), handler]);
    },
  });

  expect(registeredTools).toHaveLength(0);
  expect([...registeredEvents.keys()].sort()).toEqual(["session.start", "tool.call"]);
});

test("compilePluginForTarget lowers Amp commands through the native plugin API", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "amp-command-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "amp-command-demo",
        version: "0.1.0",
        targets: {
          commands: ["amp-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "commands", "review.md"),
    `---
description: Review current branch changes
amp-code:
  title: Review Current Branch
  category: Prism Commands
---

# Review

Review the current branch and report findings first.
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const pluginPath = join(projectRoot, ".amp", "plugins", "prism-generated-amp-command-demo.ts");
  expect(await pathExists(pluginPath)).toBe(true);

  const generated = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`) as {
    readonly default: (amp: {
      readonly registerTool: (definition: unknown) => void;
      readonly registerCommand: (
        id: string,
        options: Record<string, unknown>,
        handler: (ctx: { thread?: { append: (messages: unknown[]) => Promise<void> } }) => Promise<void>,
      ) => void;
    }) => void;
  };
  const registeredCommands: Array<{
    id: string;
    options: Record<string, unknown>;
    handler: (ctx: { thread?: { append: (messages: unknown[]) => Promise<void> } }) => Promise<void>;
  }> = [];
  generated.default({
    registerTool: () => undefined,
    registerCommand: (id, options, handler) => {
      registeredCommands.push({ id, options, handler });
    },
  });

  expect(registeredCommands).toHaveLength(1);
  const command = registeredCommands[0]!;
  expect(command.id).toBe("prism-generated-amp-command-demo-review");
  expect(command.options).toEqual({
    title: "Review Current Branch",
    category: "Prism Commands",
    description: "Review current branch changes",
  });

  const appended: unknown[][] = [];
  await command.handler({
    thread: {
      append: async (messages) => {
        appended.push(messages);
      },
    },
  });
  expect(appended).toEqual([[
    {
      type: "user-message",
      content: "# Review\n\nReview the current branch and report findings first.",
    },
  ]]);
  await expect(command.handler({})).rejects.toThrow("active Amp thread");

  const source = await readFile(pluginPath, "utf8");
  const sourceHash = computeContentHash(source);
  const warmCompile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(computeContentHash(await readFile(pluginPath, "utf8"))).toBe(sourceHash);
  expect(warmCompile.operations.some((operation) => operation.kind === "prune")).toBe(false);

  await rm(join(pluginRoot, "commands"), { recursive: true, force: true });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name: "amp-command-demo", version: "0.1.0", targets: {} }, null, 2)}\n`,
  );
  // The plugin file drifted outside Prism; drift is never an error — the
  // orphaned target is pruned with a backup (converge, don't refuse).
  await writeFile(pluginPath, `${source}\n// external change\n`);
  const pruneCompile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(pruneCompile.operations).toContainEqual(
    expect.objectContaining({
      kind: "prune",
      targetPath: pluginPath,
      reason: "orphaned",
      backup: true,
    }),
  );
  expect(await pathExists(pluginPath)).toBe(false);
  expect(pruneCompile.backups.length).toBeGreaterThan(0);
  const ampSnapshot = await readSnapshot({
    prismHome: testPrismHome(),
    harness: "amp-code",
    root: pruneCompile.outputRoot,
  });
  expect(ampSnapshot.manifest.entries.some((entry) => entry.targetPath === pluginPath)).toBe(false);
});

test("compilePluginForTarget lowers Claude commands into skills-dir plugin bundles", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "claude-command-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "claude-command-demo",
        version: "0.1.0",
        targets: {
          commands: ["claude-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "commands", "review.md"),
    `---\ndescription: Review current branch changes\n---\n\n# Review\n\nReview the current branch.\n`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "claude-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const commandPath = join(
    projectRoot,
    ".claude",
    "skills",
    "prism-generated-claude-command-demo",
    "commands",
    "review.md",
  );
  expect(await readFile(commandPath, "utf8")).toContain("Review the current branch.");
  expect(await pathExists(join(projectRoot, ".claude", "commands", "review.md"))).toBe(false);
});

test("compilePluginForTarget rejects Amp command id collisions", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "amp-command-collision-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "amp-command-collision-demo",
        version: "0.1.0",
        targets: {
          commands: ["amp-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "commands", "foo-bar.md"), "# Foo bar\n");
  await writeText(join(pluginRoot, "commands", "foo", "bar.md"), "# Foo nested bar\n");

  await expect(
    Effect.runPromise(
      compilePluginForTarget({
        prismHome: testPrismHome(),
        pluginPath: pluginRoot,
        target: "amp-code",
        scope: "project",
        projectPath: projectRoot,
        dryRun: true,
      }),
    ),
  ).rejects.toThrow("Amp command id collision");
});

test("compilePluginForTarget rejects Amp session-end hooks because Amp has no native event", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "amp-session-end-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "amp-session-end-demo",
        version: "0.1.0",
        targets: {
          hooks: ["amp-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "hooks", "session-end.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-end",
  event: hookEvent.sessionEnd,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  // Under the default "degrade" policy, the unsupported hook is skipped and compilation succeeds
  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
    }),
  );
  expect(result).toBeDefined();

  // Create a separate plugin root for onDegraded: "fail" to avoid import caching
  const pluginRootFail = join(root, "amp-session-end-demo-fail");
  await writeText(
    join(pluginRootFail, "plugin.json"),
    `${JSON.stringify(
      {
        name: "amp-session-end-demo-fail",
        version: "0.1.0",
        targets: {
          hooks: ["amp-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRootFail, "hooks", "session-end.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-end",
  event: hookEvent.sessionEnd,
  onDegraded: "fail",
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  await expect(
    Effect.runPromise(
      compilePluginForTarget({
        prismHome: testPrismHome(),
        pluginPath: pluginRootFail,
        target: "amp-code",
        scope: "project",
        projectPath: projectRoot,
        dryRun: true,
      }),
    ),
  ).rejects.toThrow("is unsupported on target 'amp-code'");
});

test("compilePluginForTarget accepts Hermes with stdio transport config (ignored post-consolidation)", async () => {
  // Post-consolidation: stdio-shim is the only transport, HTTP config is ignored.
  // Stdio config in plugin.json is now ignored (shim uses stdio unconditionally).
  const { pluginRoot, hermesRoot } = await createHermesHttpToolPlugin({
    pluginName: "hermes-stdio-gate-demo",
  });
  const manifestPath = join(pluginRoot, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.runtime = {
    mcp: {
      hermes: {
        transport: "stdio",
        host: "127.0.0.1",
        port: 38463,
      },
    },
  };
  await writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "hermes",
      scope: "global",
      root: hermesRoot,
      dryRun: false,
    }),
  );
  expect(result.operations.length).toBeGreaterThanOrEqual(0);
});

test("compilePluginForTarget accepts Hermes with non-loopback HTTP host (ignored post-consolidation)", async () => {
  // Post-consolidation: HTTP host config is ignored, only stdio-shim is used.
  // Non-loopback HTTP configuration no longer causes rejection.
  const root = await createTempRoot();
  const pluginRoot = join(root, "hermes-http-host-demo");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "hermes-http-host-demo",
        version: "0.1.0",
        targets: {
          tools: ["hermes"],
        },
        runtime: {
          mcp: {
            hermes: {
              transport: "streamable-http",
              host: "0.0.0.0",
              port: 38463,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo",
  description: "Echo via Hermes worker.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
};
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "hermes",
      scope: "global",
      dryRun: true,
    }),
  );
  expect(result.operations.length).toBeGreaterThanOrEqual(0);
});

test("compilePluginForTarget rejects Hermes agents and hooks during source selection", async () => {
  const root = await createTempRoot();
  const agentPluginRoot = join(root, "hermes-agent-demo");
  const hookPluginRoot = join(root, "hermes-hook-demo");

  await writeText(
    join(agentPluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "hermes-agent-demo",
        version: "0.1.0",
        targets: {
          agents: ["hermes"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(agentPluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(
    join(agentPluginRoot, "agents", "worker.agent.ts"),
    `
export default {
  name: "worker",
  description: "Hermes worker",
  identity: "worker",
};
`,
  );

  const agentExit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: agentPluginRoot,
      target: "hermes",
      scope: "global",
      dryRun: true,
    }),
  );

  const agentFailure = getFailure(agentExit);
  expect(agentFailure._tag).toBe("PluginManifestError");
  expect(agentFailure.message).toContain("targets.agents resolves to unsupported compile harnesses");

  await writeText(
    join(hookPluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "hermes-hook-demo",
        version: "0.1.0",
        targets: {
          hooks: ["amp-orb"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(hookPluginRoot, "hooks", "session-start.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-start",
  event: hookEvent.sessionStart,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  const hookExit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: hookPluginRoot,
      target: "cursor",
      scope: "global",
      dryRun: true,
    }),
  );

  const hookFailure = getFailure(hookExit);
  expect(hookFailure._tag).toBe("PluginManifestError");
  expect(hookFailure.message).toContain("targets.hooks resolves to unsupported harnesses for hooks");
});

test("plain skill strings fail closed in agent source skills", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plain-agent-skills");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "plain-agent-skills",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `
export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  skills: ["testing"],
};
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("SourceParseError");
  if (failure._tag === "SourceParseError") {
    expect(failure.kind).toBe("agent");
    expect(failure.message).toContain("plain skill strings are not allowed");
  }
});

test("managed skill refs require the source plugin to target the compile harness", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "managed-skill-target-demo",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          skills: ["claude-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(
    join(pluginRoot, "skills", "contracts", "SKILL.md"),
    `---
name: contracts
description: Contract guidance
---

# Contracts
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { skillRef } from "prism";

export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  skills: [skillRef("contracts")],
};
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("MissingTargetResolutionError");
  if (failure._tag === "MissingTargetResolutionError") {
    expect(failure.referenceKind).toBe("skill");
    expect(failure.referenceName).toBe("contracts");
    expect(failure.target).toBe("opencode");
  }
});

test("opencode skillspace target names must be valid skill names", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "invalid-opencode-skill-demo",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          skillspaces: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `
export default {
  name: "external-skills",
  skills: {
    "copy-engineering": {
      targets: {
        opencode: { name: "Copy_Engineering" },
      },
    },
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { skillspaceRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  skills: [skillspaceRef("external-skills", "copy-engineering")],
};
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("AgentValidationError");
  if (failure._tag === "AgentValidationError") {
    expect(failure.field).toBe("skill");
    expect(failure.message).toContain("invalid OpenCode skill name");
  }
});

test("opencode tools-only plugins bundle runtime helper imports from declared deps", async () => {
  const { pluginRoot, projectRoot } = await createToolsOnlyRuntimeDepImportFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const generatedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-signal-core",
  );
  const server = await readFile(join(generatedRoot, "dist", "server.mjs"), "utf8");

  expect(server).toContain("signal_core_record_signal");
  expect(server).toContain("normalizeOrbitMessage");
});

test("Amp tools-only plugins bundle runtime helper imports from declared deps", async () => {
  const { pluginRoot, projectRoot } = await createToolsOnlyRuntimeDepImportFixture("amp-code");

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const plugin = await readFile(
    join(projectRoot, ".amp", "plugins", "prism-generated-signal-core.ts"),
    "utf8",
  );
  expect(plugin).toContain("signal_core_record_signal");
  expect(plugin).toContain("normalizeOrbitMessage");
});

test("tools-only plugins emit the complete owner runtime plugin", async () => {
  const { protocolRoot, projectRoot } = await createExternalPermissionOnlyFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: protocolRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const protocolGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-protocol-core",
  );

  expect(await pathExists(join(protocolGeneratedRoot, "dist", "server.mjs"))).toBe(true);
  expect(await pathExists(join(protocolGeneratedRoot, "src", "server.ts"))).toBe(false);
  expect(await pathExists(join(protocolGeneratedRoot, "package.json"))).toBe(false);

  const server = await readFile(
    join(protocolGeneratedRoot, "dist", "server.mjs"),
    "utf8",
  );
  expect(server).toContain("protocol_core_external_submit");
  expect(server).toContain("protocol_core_unreferenced");

  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as { permission?: Record<string, string>; plugin?: string[] };
  expect(opencodeConfig.permission).toBeUndefined();
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(projectRoot, "prism-generated-protocol-core"),
  );
  expect(opencodeConfig.plugin).not.toContain("prism-generated-protocol-core");
});

test("compilePluginForTarget lowers canonical tool bindings into a Claude plugin bundle", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();
  const protocolRoot = join(pluginRoot, "deps", "protocol-core");

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: protocolRoot,
      target: "claude-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const claude = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "claude-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(claude.composed).toHaveLength(3);

  const pluginRootPath = join(
    projectRoot,
    ".claude",
    "skills",
    "prism-generated-canonical-compile-fixture",
  );
  const claudeAgent = await readFile(join(pluginRootPath, "agents", "builder.md"), "utf8");
  expect(claudeAgent).toContain('description: "Builder agent for canonical compile integration tests"');
  expect(claudeAgent).toContain('model: "sonnet"');
  // Generated agents omit `tools:` (Claude's exclusive allowlist would strip built-ins).
  // Canonical tools are CLI-only under PRISM_HOME/runtime/tools.
  expect(claudeAgent).not.toContain("tools:");
  expect(await pathExists(join(pluginRootPath, ".mcp.json"))).toBe(false);
  expect(
    await pathExists(join(testPrismHome(), "runtime", "mcp", "canonical-compile-fixture", "server.mjs")),
  ).toBe(false);
  expect(await pathExists(join(pluginRootPath, "mcp"))).toBe(false);
  expect(await pathExists(join(projectRoot, ".claude", "agents", "builder.md"))).toBe(false);
});

test("compilePluginForTarget lowers Pi package and extension surfaces", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "pi-pipeline-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "pi-pipeline-demo",
        version: "0.1.0",
        targets: {
          rules: ["pi"],
          commands: ["pi"],
          agents: ["pi"],
          skills: ["pi"],
          sops: ["pi"],
          tools: ["pi"],
          hooks: ["pi"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "rules", "global", "context.md"), `# Pi context\n\nUse the generated Pi package context.\n`);
  await writeText(join(pluginRoot, "commands", "review.md"), `# Review\n\nReview the current change.\n`);
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    `---
name: testing
description: Testing guidance
---

# Testing
`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker

Use Pi package surfaces.
`,
  );
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "submit-work",
  description: "Submit completed Pi work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input, context) {
    return { acknowledged: input.summary.length > 0 && context.agent === "pi" };
  },
};
`);
  await writeText(join(pluginRoot, "agents", "worker.agent.ts"), `import { skillRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "worker",
  description: "Pi package worker",
  identity: "worker",
  skills: [skillRef("testing")],
  targets: {
    pi: {
      tools: ["read"],
    },
  },
};
`);
  await writeText(join(pluginRoot, "sops", "delivery.sop.ts"), `import type { SopSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "delivery",
  description: "Deliver work through Pi",
  phases: [{ name: "Build", purpose: "Ship the change.", body: "Do the work." }],
} satisfies SopSource;
`);
  await writeText(join(pluginRoot, "hooks", "audit-read.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-read",
  description: "Audit read calls",
  event: hookEvent.toolBefore,
  match: { tool: { kind: "hook-native-tool", name: "read" } },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-submit.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-submit",
  description: "Audit canonical submit calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("submit-work") },
  handle: (_event) => Effect.succeed({ decision: "block" as const, message: "canonical-blocked" }),
};
`);

  const compiled = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "pi",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(compiled.outputRoot).toBe(join(projectRoot, ".pi/"));
  const packageRoot = join(projectRoot, ".pi", "packages", "prism-generated-pi-pipeline-demo");
  const settings = JSON.parse(await readFile(join(projectRoot, ".pi", "settings.json"), "utf8")) as {
    packages?: string[];
  };
  expect(settings.packages).toContain("./packages/prism-generated-pi-pipeline-demo");
  expect(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))).toMatchObject({
    name: "prism-generated-pi-pipeline-demo",
    keywords: ["pi-package"],
    pi: {
      extensions: ["./extensions"],
      skills: ["./skills"],
      prompts: ["./prompts"],
    },
  });

  const piAgent = await readFile(
    join(projectRoot, ".pi", "agents", "worker.md"),
    "utf8",
  );
  expect(piAgent).toContain('name: "worker"');
  expect(piAgent).toContain('description: "Pi package worker"');
  expect(piAgent).toContain('tools:');
  expect(piAgent).toContain('- "read"');
  expect(piAgent).toContain('skills:');
  expect(piAgent).toContain('- "testing"');
  expect(piAgent).not.toContain("<!-- prism:");
  expect(await pathExists(join(packageRoot, "skills", "prism-agent-worker", "SKILL.md"))).toBe(false);
  expect(await pathExists(join(packageRoot, "skills", "testing", "SKILL.md"))).toBe(true);
  expect(await pathExists(join(packageRoot, "skills", "delivery", "SKILL.md"))).toBe(true);
  expect(await pathExists(join(packageRoot, "prompts", "review.md"))).toBe(true);
  expect(await pathExists(join(projectRoot, ".pi", "skills", "testing", "SKILL.md"))).toBe(false);

  const extensionPath = join(packageRoot, "extensions", "prism-extension.js");
  const extensionSource = await readFile(extensionPath, "utf8");
  expect(extensionSource).toContain("registerTool");
  expect(extensionSource).toContain("before_agent_start");
  expect(extensionSource).toContain("tool_call");
  expect(extensionSource).toContain("tool_result");
  expect(extensionSource).toContain("pi_pipeline_demo_submit_work");
  expect(await pathExists(join(packageRoot, "hooks", "audit-read.mjs"))).toBe(true);
  expect(await pathExists(join(packageRoot, "hooks", "audit-submit.mjs"))).toBe(true);

  const loaded = await import(`${pathToFileURL(extensionPath).href}?test=${Date.now()}`) as {
    readonly default: (pi: {
      readonly registerTool: (definition: any) => void;
      readonly on: (event: string, handler: any) => void;
    }) => void;
  };
  const registeredTools: any[] = [];
  const handlers = new Map<string, any>();
  loaded.default({
    registerTool: (definition) => {
      registeredTools.push(definition);
    },
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  });

  expect(registeredTools.map((tool) => tool.name)).toContain("pi_pipeline_demo_submit_work");
  const submitTool = registeredTools.find((tool) => tool.name === "pi_pipeline_demo_submit_work");
  const toolResult = await submitTool.execute(
    "tool-call-1",
    { summary: "done" },
    undefined,
    undefined,
    {
      cwd: projectRoot,
      sessionManager: { getSessionFile: () => "session-1.json" },
    },
  );
  expect(JSON.parse(toolResult.content[0].text)).toEqual({ acknowledged: true });
  expect(toolResult.details.structuredContent).toEqual({ acknowledged: true });

  const contextPatch = await handlers.get("before_agent_start")?.({ systemPrompt: "Base" });
  expect(contextPatch.systemPrompt).toContain("Base");
  expect(contextPatch.systemPrompt).toContain("Pi context");
  const blocked = await handlers.get("tool_call")?.(
    { toolName: "read", input: { block: true } },
    { cwd: pluginRoot, sessionManager: { getSessionFile: () => "session-2.json" } },
  );
  expect(blocked).toEqual({ block: true, reason: "blocked" });
  const canonicalBlocked = await handlers.get("tool_call")?.(
    { toolName: "pi_pipeline_demo_submit_work", input: { summary: "stop" } },
    { cwd: pluginRoot, sessionManager: { getSessionFile: () => "session-3.json" } },
  );
  expect(canonicalBlocked).toEqual({ block: true, reason: "canonical-blocked" });
  const directHookWrapper = join(packageRoot, "hooks", "audit-read.mjs");
  const directHookProcess = Bun.spawn({
    cmd: [process.execPath, directHookWrapper],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  directHookProcess.stdin.write(JSON.stringify({
    toolName: "read",
    input: { block: true },
    cwd: pluginRoot,
    sessionId: "session-4",
  }));
  directHookProcess.stdin.end();
  const [directHookExit, directHookStdout, directHookStderr] = await Promise.all([
    directHookProcess.exited,
    new Response(directHookProcess.stdout).text(),
    new Response(directHookProcess.stderr).text(),
  ]);
  expect(directHookExit).toBe(0);
  expect(directHookStderr).toBe("");
  expect(JSON.parse(directHookStdout.trim())).toEqual({
    decision: "block",
    message: "blocked",
  });
  const canonicalHookWrapper = join(packageRoot, "hooks", "audit-submit.mjs");
  const canonicalHookProcess = Bun.spawn({
    cmd: [process.execPath, canonicalHookWrapper],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  canonicalHookProcess.stdin.write(JSON.stringify({
    toolName: "pi_pipeline_demo_submit_work",
    input: { summary: "stop" },
    cwd: pluginRoot,
    sessionId: "session-5",
  }));
  canonicalHookProcess.stdin.end();
  const [canonicalHookExit, canonicalHookStdout, canonicalHookStderr] = await Promise.all([
    canonicalHookProcess.exited,
    new Response(canonicalHookProcess.stdout).text(),
    new Response(canonicalHookProcess.stderr).text(),
  ]);
  expect(canonicalHookExit).toBe(0);
  expect(canonicalHookStderr).toBe("");
  expect(JSON.parse(canonicalHookStdout.trim())).toEqual({
    decision: "block",
    message: "canonical-blocked",
  });

  const warmCompile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "pi",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(warmCompile.converged).toBe(true);
  expect(warmCompile.operations.filter(
    (operation) => operation.kind === "create" || operation.kind === "repair",
  )).toEqual([]);
  expect(warmCompile.operations.some((operation) => operation.kind === "skip")).toBe(true);
  // The settings.json region is byte-stable on warm runs.
  expect(warmCompile.operations.some((operation) => operation.kind === "patch-regions")).toBe(false);
  expect(warmCompile.operations.some((operation) => operation.kind === "skip-regions")).toBe(true);
  const warmSettings = JSON.parse(await readFile(join(projectRoot, ".pi", "settings.json"), "utf8")) as {
    packages?: string[];
  };
  expect(warmSettings.packages?.filter((entry) => entry === "./packages/prism-generated-pi-pipeline-demo")).toHaveLength(1);
});

test("compilePluginForTarget prunes stale Pi package and settings entry for source-only targets", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "pi-source-only");
  const projectRoot = join(root, "project");
  const piRoot = join(projectRoot, ".pi");
  const generatedRoot = join(piRoot, "packages", "prism-generated-pi-source-only");
  const stalePackageSkillPath = join(generatedRoot, "skills", "stale", "SKILL.md");
  const stalePackageSkillContent = "---\nname: stale\ndescription: Stale\n---\n\n# Stale\n";
  const staleAgentPath = join(piRoot, "agents", "stale.md");
  await mkdir(projectRoot, { recursive: true });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "pi-source-only",
      version: "0.1.0",
      targets: {
        modelspaces: ["pi"],
      },
    })}\n`,
  );
  await writeText(stalePackageSkillPath, stalePackageSkillContent);
  const staleAgentContent = "---\nname: stale\ndescription: Stale\n---\n\n# Stale\n";
  await writeText(staleAgentPath, staleAgentContent);
  await writeText(
    join(piRoot, "settings.json"),
    `${JSON.stringify({
      packages: [
        "./packages/prism-generated-pi-source-only",
        "./packages/keep-me",
      ],
    }, null, 2)}\n`,
  );
  await commitSnapshot({
    prismHome: testPrismHome(),
    manifest: {
      version: 1,
      harness: "pi",
      root: piRoot,
      entries: [
        {
          targetPath: stalePackageSkillPath,
          contentHash: computeContentHash(stalePackageSkillContent),
          mode: "owned",
          plugin: "pi-source-only",
        },
        {
          targetPath: staleAgentPath,
          contentHash: computeContentHash(staleAgentContent),
          mode: "owned",
          plugin: "pi-source-only",
        },
        {
          targetPath: join(piRoot, "settings.json"),
          contentHash: "stale",
          mode: "region",
          regionKey: serializeRegionRef({
            kind: "json-array-member",
            targetPath: join(piRoot, "settings.json"),
            regionKey: "packages.prism-generated-pi-source-only",
            jsonPath: ["packages"],
            value: "./packages/prism-generated-pi-source-only",
            plugin: "pi-source-only",
          }),
          plugin: "pi-source-only",
        },
      ],
    },
  });

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "pi",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.operations).toContainEqual(
    expect.objectContaining({
      kind: "prune",
      targetPath: stalePackageSkillPath,
    }),
  );
  expect(result.operations).toContainEqual(
    expect.objectContaining({
      kind: "prune",
      targetPath: staleAgentPath,
    }),
  );
  expect(await directoryExists(generatedRoot)).toBe(false);
  expect(await pathExists(staleAgentPath)).toBe(false);
  const settings = JSON.parse(await readFile(join(piRoot, "settings.json"), "utf8")) as {
    packages?: string[];
  };
  expect(settings.packages).toEqual(["./packages/keep-me"]);
  const piSnapshot = await readSnapshot({ prismHome: testPrismHome(), harness: "pi", root: piRoot });
  expect(piSnapshot.manifest.entries.some((entry) => entry.targetPath === staleAgentPath)).toBe(false);
});

test("compilePluginForTarget leaves absent Pi cleanup settings absent", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "pi-empty-cleanup");
  const piRoot = join(root, "pi-home", "agent");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "pi-empty-cleanup",
      version: "0.1.0",
      targets: {},
    })}\n`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "pi",
      scope: "global",
      root: piRoot,
      dryRun: false,
    }),
  );

  expect(result.operations.some((operation) =>
    operation.kind === "patch-regions" &&
    operation.targetPath === join(piRoot, "settings.json")
  )).toBe(false);
  expect(await pathExists(join(piRoot, "settings.json"))).toBe(false);
});

test("compilePluginForTarget lowers Pi package surfaces in global scope with an override root", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "pi-global-demo");
  const piHome = join(root, "pi-home");
  const piRoot = join(piHome, "agent");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "pi-global-demo",
      version: "0.1.0",
      targets: {
        agents: ["pi"],
        skills: ["pi"],
      },
    })}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    "---\ndescription: Pi global worker\n---\n\n# Worker\n",
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `
export default {
  name: "worker",
  description: "Pi global worker",
  identity: "worker",
};
`,
  );
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );

  const compiled = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "pi",
      scope: "global",
      root: piRoot,
      dryRun: false,
    }),
  );

  expect(compiled.outputRoot).toBe(piRoot);
  expect(await pathExists(join(piRoot, "packages", "prism-generated-pi-global-demo", "skills", "testing", "SKILL.md"))).toBe(true);
  expect(await pathExists(join(piHome, "agents", "worker.md"))).toBe(true);
  const settings = JSON.parse(await readFile(join(piRoot, "settings.json"), "utf8")) as {
    packages?: string[];
  };
  expect(settings.packages).toContain("./packages/prism-generated-pi-global-demo");
});

test("compilePluginForTarget rejects Kimi Code project scope", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "kimi-project-scope-demo");
  const projectRoot = join(root, "project");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "kimi-project-scope-demo",
      version: "0.1.0",
      targets: { skills: ["kimi-code"] },
    })}\n`,
  );
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "kimi-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
    }),
  );
  const failure = getFailure(exit);
  expect(failure._tag).toBe("InvalidTargetScopeError");
  expect(failure).toMatchObject({
    target: "kimi-code",
    scope: "project",
    message: "this harness has no project-local config root",
  });
});

test("compilePluginForTarget lowers Claude plugin-bundle surfaces when no canonical tool runtime is required", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const claude = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "claude-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(claude.composed).toHaveLength(3);

  const pluginRootPath = join(
    projectRoot,
    ".claude",
    "skills",
    "prism-generated-canonical-compile-fixture",
  );
  const claudeAgent = await readFile(
    join(pluginRootPath, "agents", "builder.md"),
    "utf8",
  );
  expect(claudeAgent).toContain(
    'description: "Builder agent for canonical compile integration tests"',
  );
  expect(claudeAgent).toContain('model: "sonnet"');
  expect(claudeAgent).toContain("temperature: 0.1");
  expect(claudeAgent).toContain("top_p: 0.7");
  // Generated agents (no explicit author tools override) omit `tools:` so the Claude subagent
  // inherits all built-ins. Claude's `tools:` is an exclusive allowlist that would
  // otherwise strip Read/Write/Bash. See composeAgentFrontmatter in lowerers/claude-code.ts.
  expect(claudeAgent).not.toContain("tools:");
  expect(claudeAgent).toContain("skills:");
  expect(claudeAgent).toContain('- "testing"');
  expect(
    await pathExists(
      join(pluginRootPath, "skills", "delivery-contract", "SKILL.md"),
    ),
  ).toBe(true);
  const deliverySopSkill = await readFile(
    join(pluginRootPath, "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );
  expect(deliverySopSkill).not.toContain("## Orchestrator");
  expect(deliverySopSkill).not.toContain("create_glyph");
  expect(
    await pathExists(
      join(pluginRootPath, "sops", "delivery-contract.md"),
    ),
  ).toBe(false);
  expect(await pathExists(join(projectRoot, ".claude", "agents", "builder.md"))).toBe(false);
  expect(await pathExists(join(projectRoot, ".claude", "settings.json"))).toBe(false);
});

test("compilePluginForTarget does not lower runtime artifacts for metadata-only target declarations", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "metadata-only-plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "metadata-only-plugin",
        version: "0.1.0",
        targets: {
          modelspaces: ["opencode", "claude-code", "antigravity-cli", "codex-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );

  for (const target of ["opencode", "claude-code", "antigravity-cli", "codex-cli"] as const) {
    const result = await Effect.runPromise(
      compilePluginForTarget({
        prismHome: testPrismHome(),
        pluginPath: pluginRoot,
        target,
        scope: "project",
        projectPath: projectRoot,
        dryRun: true,
      }),
    );

    expect(result.composed).toHaveLength(0);
    expect(result.operations).toHaveLength(0);
  }
});
