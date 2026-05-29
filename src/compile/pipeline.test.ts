import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Option, Schema } from "effect";
import matter from "gray-matter";
import type { CompileError } from "./errors.js";
import { loadPlugin } from "./load.js";
import { readLockfile } from "./lockfile.js";
import { runtimeMcpServerDescriptor } from "./mcp-runtime.js";
import { compilePluginForTarget } from "./pipeline.js";
import { emptyRegistry, type PluginRegistry } from "./registry.js";
import { resolveAgent, resolveAgentCapabilities, validateOrbit } from "./resolve.js";
import {
  Agent,
  CanonicalTool,
  Identity,
  Orbit,
  Personality,
  Skill,
  Trait,
  type NormalizedAccess,
  type NormalizedOrbitPhase,
  type OrbitParameter,
} from "./sources.js";
import { createCanonicalCompileFixture } from "./test-fixtures.js";
import {
  formatManifestTargets,
  getManifestArtifactTargets,
  manifestHasCompileTargets,
  readManifest,
  resolveManifestTargets,
} from "../manifest.js";
import { computeContentHash } from "../content-hash.js";
import { managedEntryId, readHarnessLedger, writeHarnessLedger } from "../managed-ledger.js";
import { serveMcp, stopMcp } from "../mcp/lifecycle.js";

const tempRoots: string[] = [];
const compileTestToken = "prism-compile-test-token-with-enough-entropy";
const originalPrismHome = process.env.PRISM_HOME;

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-compile-"));
  tempRoots.push(root);
  process.env.PRISM_HOME = join(root, "prism-home");
  return root;
};

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

const readDirectoryTextFiles = async (
  path: string,
): Promise<Record<string, string>> => {
  const entries = (await readdir(path)).sort((left, right) =>
    left.localeCompare(right),
  );
  return Object.fromEntries(
    await Promise.all(
      entries.map(async (entry) => [
        entry,
        await readFile(join(path, entry), "utf8"),
      ]),
    ),
  );
};

const generatedPluginEntry = (projectRoot: string, pluginId: string): string =>
  pathToFileURL(
    join(projectRoot, ".opencode", "plugins", pluginId, "dist", "server.mjs"),
  ).href;

const generatedStaleSourcePluginEntry = (projectRoot: string, pluginId: string): string =>
  pathToFileURL(
    join(projectRoot, ".opencode", "plugins", pluginId, "src", "server.ts"),
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

  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error("Expected typed compile error");
  }

  return failure.value as CompileError;
};

const parseOpencodeSkillPermissions = (markdown: string): Record<string, string> => {
  const frontmatter = matter(markdown).data as {
    permission?: { skill?: Record<string, string> };
  };
  return frontmatter.permission?.skill ?? {};
};

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const withEnv = <A>(name: string, value: string, run: () => Promise<A>): Promise<A> => {
  const previous = process.env[name];
  process.env[name] = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
};

const getFreePort = (host: string): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });

const createHermesHttpToolPlugin = async (options?: {
  readonly pluginName?: string;
  readonly tokenEnv?: string;
  readonly transport?: "stdio" | "streamable-http";
  readonly port?: number;
}): Promise<{ readonly pluginRoot: string; readonly hermesRoot: string }> => {
  const root = await createTempRoot();
  const pluginName = options?.pluginName ?? "hermes-http-demo";
  const pluginRoot = join(root, pluginName);
  const hermesRoot = join(root, "hermes-root");
  await mkdir(hermesRoot, { recursive: true });
  const runtime = options?.transport === "stdio"
    ? undefined
    : {
        mcp: {
          hermes: {
            transport: "streamable-http",
            host: "127.0.0.1",
            port: options?.port ?? 38463,
            tokenEnv: options?.tokenEnv ?? "PRISM_MCP_TOKEN",
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
          tools: ["hermes"],
        },
        ...(runtime ? { runtime } : {}),
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo through Hermes MCP.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );

  return { pluginRoot, hermesRoot };
};

const skillPermissionAction = (
  permission: Record<string, string>,
  skill: string,
): string => permission[skill] ?? permission["*"] ?? "ask";

const visibleSkillsForPermission = (
  skills: ReadonlyArray<string>,
  permission: Record<string, string>,
): string[] =>
  skills
    .filter((skill) => skillPermissionAction(permission, skill) !== "deny")
    .sort((left, right) => left.localeCompare(right));

const emptyAccess = { tools: [], toolGroups: [], skills: [] };

const createValidationTrait = (name: string): Trait =>
  new Trait({
    name,
    sourcePath: `/tmp/${name}.trait.ts`,
    instructions: [],
    access: emptyAccess,
    tools: {},
    inject: { skills: [] },
    require: { tools: [], skills: [] },
  });

const createValidationAgent = (
  name: string,
  traits: ReadonlyArray<string> = [],
  sourcePath = `/tmp/${name}.agent.ts`,
): Agent =>
  new Agent({
    name,
    sourcePath,
    description: `${name} agent`,
    identity: "identity",
    traits: traits.map((ref) => ({ ref, tools: {} })),
    access: emptyAccess,
    skills: [],
    targets: {},
  });

const createCapabilityTrait = (options: {
  readonly name: string;
  readonly access?: NormalizedAccess;
  readonly tools?: Record<string, { ref: string }>;
  readonly injectSkills?: string[];
  readonly requireTools?: string[];
  readonly requireSkills?: string[];
}): Trait =>
  new Trait({
    name: options.name,
    sourcePath: `/tmp/${options.name}.trait.ts`,
    instructions: [],
    access: options.access ?? emptyAccess,
    tools: options.tools ?? {},
    inject: { skills: options.injectSkills ?? [] },
    require: {
      tools: options.requireTools ?? [],
      skills: options.requireSkills ?? [],
    },
  });

const createCapabilityAgent = (options: {
  readonly name?: string;
  readonly identity?: string;
  readonly personality?: string;
  readonly traits?: string[];
  readonly access?: NormalizedAccess;
  readonly skills?: string[];
}): Agent =>
  new Agent({
    name: options.name ?? "worker",
    sourcePath: `/tmp/${options.name ?? "worker"}.agent.ts`,
    description: "Capability worker",
    identity: options.identity ?? "identity",
    ...(options.personality ? { personality: options.personality } : {}),
    traits: (options.traits ?? []).map((ref) => ({ ref, tools: {} })),
    access: options.access ?? emptyAccess,
    skills: options.skills ?? [],
    targets: {},
  });

const createCapabilityTool = (name: string): CanonicalTool =>
  new CanonicalTool({
    name,
    sourcePath: `/tmp/${name}.tool.ts`,
    description: `${name} tool`,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    slots: {},
    async handle() {
      return {};
    },
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

const createValidationOrbit = (options: {
  readonly name?: string;
  readonly parameters?: ReadonlyArray<OrbitParameter>;
  readonly phase?: Partial<NormalizedOrbitPhase>;
}): Orbit =>
  new Orbit({
    name: options.name ?? "parent",
    sourcePath: `/tmp/${options.name ?? "parent"}.orbit.ts`,
    description: `${options.name ?? "parent"} orbit`,
    parameters: options.parameters ?? [],
    phases: [
      {
        name: "Validate phase",
        agents: [],
        requires: [],
        ...options.phase,
      },
    ],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });

const createOrbitValidationRegistry = (): PluginRegistry => {
  const registry = emptyRegistry("/tmp/orbit-validation", "orbit-validation", "0.1.0");
  registry.traits.set("reviewable", createValidationTrait("reviewable"));
  registry.traits.set("self-assessing", createValidationTrait("self-assessing"));
  registry.agents.set("builder", createValidationAgent("builder", ["self-assessing"]));
  registry.agents.set("reviewer", createValidationAgent("reviewer", ["reviewable"]));
  const depRegistry = emptyRegistry("/tmp/orbit-validation-dep", "orbit-validation-dep", "0.1.0");
  depRegistry.traits.set("self-assessing", createValidationTrait("self-assessing"));
  depRegistry.agents.set(
    "builder",
    createValidationAgent(
      "builder",
      ["self-assessing"],
      registry.agents.get("builder")!.sourcePath,
    ),
  );
  registry.deps.set("alias", depRegistry);
  registry.orbits.set("concrete", createValidationOrbit({ name: "concrete" }));
  registry.orbits.set(
    "template",
    createValidationOrbit({
      name: "template",
      parameters: [
        { name: "required" },
        { name: "optional", required: false },
      ],
    }),
  );
  return registry;
};

const expectOrbitValidationFailure = async (
  orbit: Orbit,
  registry: PluginRegistry,
): Promise<Extract<CompileError, { readonly _tag: "OrbitValidationError" }>> => {
  const exit = await Effect.runPromiseExit(validateOrbit(orbit, registry));
  const failure = getFailure(exit);
  expect(failure._tag).toBe("OrbitValidationError");
  if (failure._tag !== "OrbitValidationError") {
    throw new Error("Expected OrbitValidationError");
  }
  return failure;
};

const createOrbitLoadFixture = async (orbitSource: string): Promise<string> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "orbit-normalization-demo");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "orbit-normalization-demo",
        version: "0.1.0",
        targets: {
          orbits: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "orbits", "phase-normalization.orbit.ts"),
    orbitSource,
  );

  return pluginRoot;
};

const orbitSourceWithPhase = (phaseSource: string): string => `export default {
  name: "phase-normalization",
  description: "Phase normalization parser fixture",
  phases: [
    ${phaseSource},
  ],
};
`;

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

const expectOrbitSourceParseFailure = async (
  orbitSource: string,
): Promise<{
  readonly failure: Extract<CompileError, { readonly _tag: "SourceParseError" }>;
  readonly sourcePath: string;
}> => {
  const pluginRoot = await createOrbitLoadFixture(orbitSource);
  const sourcePath = join(pluginRoot, "orbits", "phase-normalization.orbit.ts");
  const exit = await Effect.runPromiseExit(loadPlugin(pluginRoot));
  const failure = getFailure(exit);
  expect(failure._tag).toBe("SourceParseError");
  if (failure._tag !== "SourceParseError") {
    throw new Error("Expected SourceParseError");
  }
  return { failure, sourcePath };
};

const createCanonicalLanguageFixture = async (options?: {
  invalidOrbit?: boolean;
  invalidOrbitPermissionAgent?: boolean;
  inlineSlotSchema?: boolean;
  undeclaredSlot?: boolean;
  mixedTraitRefsBeforeSlotBinding?: boolean;
  withCanonicalToolBindings?: boolean;
}) => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  return createCanonicalCompileFixture({
    pluginRoot,
    projectRoot,
    invalidOrbit: options?.invalidOrbit,
    invalidOrbitPermissionAgent: options?.invalidOrbitPermissionAgent,
    inlineSlotSchema: options?.inlineSlotSchema,
    undeclaredSlot: options?.undeclaredSlot,
    mixedTraitRefsBeforeSlotBinding: options?.mixedTraitRefsBeforeSlotBinding,
    withCanonicalToolBindings: options?.withCanonicalToolBindings,
  });
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
          orbits: ["antigravity-cli"],
          tools: ["antigravity-cli"],
          toolspaces: ["antigravity-cli"],
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
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `import { defineToolspace } from ${JSON.stringify(prismImportPath)};

export default defineToolspace({
  name: "workspace",
  tools: { read_repo: { targets: { "antigravity-cli": { name: "read_file" } } } },
});
`);
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "submit-work",
  description: "Submit completed work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input, context) { return { acknowledged: true }; },
});
`);
  await writeText(join(pluginRoot, "traits", "submittable.trait.ts"), `import { defineTrait, toolRef } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit work through the typed Antigravity plugin tool.",
  access: { tools: [toolRef("workspace", "read_repo")] },
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
});
`);
  await writeText(join(pluginRoot, "agents", "worker.agent.ts"), `import { defineAgent, skillRef } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "worker",
  description: "Antigravity plugin worker",
  identity: "worker",
  traits: ["submittable"],
  skills: [skillRef("testing")],
});
`);
  await writeText(join(pluginRoot, "orbits", "delivery.orbit.ts"), `import { agentRef, defineOrbit, traitRef } from ${JSON.stringify(prismImportPath)};

export default defineOrbit({
  name: "delivery",
  description: "Deliver work through Antigravity",
  phases: [{ name: "Build", agents: [agentRef("worker")], requires: [{ all: [traitRef("submittable")] }] }],
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-read.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "audit-read",
  description: "Audit read calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "read_repo")) },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-submit.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "audit-submit",
  description: "Audit canonical submit calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("submit_work") },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);

  return { pluginRoot, projectRoot };
};

const createStandaloneToolFixture = async (): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "tool-only-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "tool-only-demo",
        version: "0.1.0",
        targets: {
          tools: ["codex-cli", "claude-code", "antigravity-cli", "grok", "factory-droid"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "tools", "echo-message.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo-message",
  description: "Echo a message",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: input.message };
  },
});
`,
  );

  return { pluginRoot, projectRoot };
};

const createCodexProjectFixture = async (): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "codex-project-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "codex-project-demo",
        version: "0.4.0",
        targets: {
          rules: ["codex-cli"],
          skills: ["codex-cli"],
          agents: ["codex-cli"],
          tools: ["codex-cli"],
          toolspaces: ["codex-cli"],
          hooks: ["codex-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "rules", "global", "context.md"), `# Codex context\n\nUse project-local Codex guidance.\n`);
  await writeText(join(pluginRoot, "skills", "testing", "SKILL.md"), `---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n`);
  await writeText(join(pluginRoot, "identities", "reviewer.identity.md"), `---\ndescription: Reviewer identity\n---\n\n# Reviewer\n\nReview through Codex.\n`);
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `import { defineToolspace } from ${JSON.stringify(prismImportPath)};

export default defineToolspace({
  name: "workspace",
  tools: { shell: { targets: { "codex-cli": { name: "shell.command" } } } },
});
`);
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "submit-work",
  description: "Submit completed work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(_input, _context) { return { acknowledged: true }; },
});
`);
  await writeText(join(pluginRoot, "traits", "submittable.trait.ts"), `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit through the generated Codex MCP tool.",
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
});
`);
  await writeText(join(pluginRoot, "agents", "reviewer.agent.ts"), `import { defineAgent, skillRef } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "reviewer",
  description: "Codex project reviewer",
  identity: "reviewer",
  traits: ["submittable"],
  skills: [skillRef("testing")],
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-shell.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "audit-shell",
  description: "Audit shell calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);

  return { pluginRoot, projectRoot };
};

const createOpenCodeHookFixture = async (options?: {
  sessionHook?: boolean;
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
          toolspaces: ["opencode"],
          tools: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "toolspaces", "core.toolspace.ts"), `import { defineToolspace } from ${JSON.stringify(prismImportPath)};

export default defineToolspace({
  name: "core",
  tools: { shell: { targets: { opencode: { name: "bash" } } } },
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-before.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "audit-before",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("core", "shell")) },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-after.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "audit-after",
  event: hookEvent.toolAfter,
  match: { tool: hookTool.tool(toolRef("core", "shell")) },
  handle: (_event) => Effect.succeed({ decision: "block" as const, message: "ignored for observational hooks" }),
});
`);
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "submit-work",
  description: "Submit completed work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(_input, _context) { return { acknowledged: true }; },
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-submit.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "audit-submit",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("submit_work") },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);
  if (options?.sessionHook) {
    await writeText(join(pluginRoot, "hooks", "session-start.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "session-start",
  event: hookEvent.sessionStart,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);
    await writeText(join(pluginRoot, "hooks", "session-end.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "session-end",
  event: hookEvent.sessionEnd,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);
  }

  return { pluginRoot, projectRoot };
};

const createToolsOnlyRuntimeDepImportFixture = async (): Promise<{
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
          tools: ["opencode"],
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
          tools: ["opencode"],
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
import { defineTool } from ${JSON.stringify(prismImportPath)};
import { normalizeOrbitMessage } from "../deps/orbit-core/tools/shared/orbit-server-client.ts";

export default defineTool({
  name: "record_signal",
  description: "Record a signal",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: normalizeOrbitMessage(input.message) };
  },
});
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
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "permission-only-consumer",
        version: "0.1.0",
        deps: {
          "protocol-core": "./deps/protocol-core",
        },
        targets: {
          agents: ["opencode"],
          skills: ["opencode"],
          skillspaces: ["opencode"],
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
          tools: ["opencode"],
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

Use the protocol tool.
`,
  );
  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `import { defineTrait } from "prism";

export default defineTrait({
  name: "submittable",
  description: "Can submit externally",
  tools: {
    submit_work: {
      ref: "protocol-core:external-submit",
    },
  },
  require: {
    tools: ["submit_work"],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from "prism";

export default defineAgent({
  name: "worker",
  description: "Permission-only consumer worker",
  identity: "worker",
  traits: ["submittable"],
});
`,
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
import { defineTool } from "prism";
import { SharedInput } from "../schemas/shared.ts";

export default defineTool({
  name: "external-submit",
  description: "Submit completed work through an external protocol plugin",
  input: SharedInput,
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  async handle(input, context) {
    return { acknowledged: true };
  },
});
`,
  );
  await writeText(
    join(protocolRoot, "tools", "unreferenced.tool.ts"),
    `import { Schema } from "effect";
import { defineTool } from "prism";

export default defineTool({
  name: "unreferenced",
  description: "Should not be mirrored",
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  async handle(input, context) {
    return {};
  },
});
`,
  );
  await writeText(
    join(projectRoot, ".opencode", "opencode.json"),
    `${JSON.stringify(
      {
        plugin: [
          "prism-generated-permission-only-consumer",
          "prism-generated-stale-dep",
          generatedPluginEntry(
            projectRoot,
            "prism-generated-permission-only-consumer",
          ),
          generatedStaleSourcePluginEntry(
            projectRoot,
            "prism-generated-permission-only-consumer",
          ),
          generatedPluginEntry(projectRoot, "prism-generated-stale-dep"),
          generatedStaleSourcePluginEntry(projectRoot, "prism-generated-stale-dep"),
        ],
      },
      null,
      2,
    )}\n`,
  );

  return { pluginRoot, protocolRoot, projectRoot };
};

const createExternalSyntheticOnlyFixture = async (): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "consumer");
  const projectRoot = join(root, "project");
  const protocolRoot = join(pluginRoot, "deps", "protocol-core");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "external-synthetic-consumer",
        version: "0.1.0",
        deps: {
          "protocol-core": "./deps/protocol-core",
        },
        targets: {
          agents: ["opencode"],
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
          tools: ["opencode"],
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

Use the typed protocol wrapper.
`,
  );
  await writeText(
    join(pluginRoot, "schemas", "worker-details.ts"),
    `import { Schema } from "effect";

export const WorkerDetails = Schema.Struct({
  confidence: Schema.Literal("low", "high"),
});
`,
  );
  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `import { defineTrait } from "prism";

export default defineTrait({
  name: "submittable",
  description: "Can submit externally through a typed wrapper",
  tools: {
    submit_work: {
      ref: "protocol-core:external-submit",
    },
  },
  require: {
    tools: ["submit_work"],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { bindTrait, defineAgent } from "prism";
import { WorkerDetails } from "../schemas/worker-details.ts";

export default defineAgent({
  name: "worker",
  description: "Synthetic external worker",
  identity: "worker",
  traits: [
    bindTrait("submittable", {
      tools: {
        submit_work: {
          slots: {
            details: WorkerDetails,
          },
        },
      },
    }),
  ],
});
`,
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
import { defineTool, schemaSlot } from "prism";
import { SharedInput } from "../schemas/shared.ts";

export default defineTool({
  name: "external-submit",
  description: "Submit completed work through an external protocol plugin",
  input: SharedInput,
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  slots: {
    details: schemaSlot({
      description: "Consumer-specific details",
    }),
  },
  async handle(input, context) {
    return { acknowledged: true };
  },
});
`,
  );

  return { pluginRoot, projectRoot };
};

afterEach(async () => {
  process.env.PRISM_HOME = originalPrismHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("readManifest accepts canonical compile target keys", async () => {
  const { pluginRoot } = await createCanonicalLanguageFixture();

  const manifest = await readManifest(pluginRoot);

  expect(manifest.name).toBe("canonical-compile-fixture");
  expect(manifest.targets).toEqual({
    agents: ["opencode", "claude-code"],
    orbits: ["opencode", "claude-code"],
    tools: ["opencode", "claude-code"],
    toolspaces: ["opencode", "claude-code"],
    modelspaces: ["opencode", "claude-code"],
  });
});

test("canonical fixture writes local tool sources with review-only slot", async () => {
  const { pluginRoot } = await createCanonicalLanguageFixture();

  const submitWork = await readFile(
    join(pluginRoot, "tools", "submit-work.tool.ts"),
    "utf8",
  );
  const commitWork = await readFile(
    join(pluginRoot, "tools", "commit-work.tool.ts"),
    "utf8",
  );
  const submitReview = await readFile(
    join(pluginRoot, "tools", "submit-review.tool.ts"),
    "utf8",
  );

  expect(submitWork).toContain('name: "submit-work"');
  expect(submitWork).toContain('description: "Submit completed work"');
  expect(commitWork).toContain('name: "commit-work"');
  expect(commitWork).toContain(
    'description: "Commit validated implementation work"',
  );
  expect(submitReview).toContain('name: "submit-review"');
  expect(submitReview).toContain('description: "Submit review findings"');

  for (const source of [submitWork, commitWork, submitReview]) {
    expect(source).toContain("summary: Schema.String");
    expect(source).toContain("acknowledged: Schema.Boolean");
  }
  expect(submitWork).not.toContain("schemaSlot");
  expect(commitWork).not.toContain("schemaSlot");
  expect(submitReview).toContain("schemaSlot");
  expect(submitReview).toContain(
    'description: "Agent-specific review fields"',
  );
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
    `import { defineSkillspace } from "prism";

export default defineSkillspace({
  name: "core",
  skills: {
    testing: {
      targets: {
        opencode: { name: "testing" },
      },
    },
  },
});
`,
  );

  const manifest = await readManifest(pluginRoot);

  expect(manifest.targets.skillspaces).toEqual(["opencode"]);
  expect(manifestHasCompileTargets(manifest, "opencode")).toBe(true);
  expect(formatManifestTargets(manifest)).toBe("skillspaces=[opencode]");
});

test("claw-harness preset targets OpenClaw and Hermes", () => {
  expect(resolveManifestTargets(["claw-harness"])).toEqual(["openclaw", "hermes"]);
});

test("coding-harness preset includes Grok", () => {
  expect(resolveManifestTargets(["coding-harness"])).toContain("grok");
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
  expect(getManifestArtifactTargets(manifest, "rules")).toContain("grok");
  expect(getManifestArtifactTargets(manifest, "rules")).toContain("antigravity-cli");
  expect(getManifestArtifactTargets(manifest, "skills")).toContain("grok");
  expect(manifestHasCompileTargets(manifest, "antigravity-cli")).toBe(true);
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
    `import { defineModelspace } from ${JSON.stringify(prismImportPath)};

export default defineModelspace({
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
});
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
      `import { defineAgent, modelProfileRef } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "reviewer-${suffix}",
  description: "Reviewer ${suffix}",
  identity: "reviewer",
  model: modelProfileRef("reviewers", "verification-throughput"),
});
`,
    );
  }

  const result = await Effect.runPromise(
    compilePluginForTarget({
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

test("canonical TS-authored agents resolve shared toolspace and modelspace bindings", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const builder = result.composed.find((agent) => agent.name === "builder");
  const reviewer = result.composed.find((agent) => agent.name === "reviewer");
  const securityReviewer = result.composed.find(
    (agent) => agent.name === "security-reviewer",
  );

  expect(builder).toBeDefined();
  expect(reviewer).toBeDefined();
  expect(securityReviewer).toBeDefined();
  expect(builder?.skills).toEqual(["testing"]);
  expect(reviewer?.skills).toEqual(["testing"]);
  expect(securityReviewer?.skills).toEqual(["testing"]);
  expect(builder?.allowedTools).toEqual(["bash", "grep", "read"]);
  expect(reviewer?.allowedTools).toEqual(["grep", "read"]);
  expect(securityReviewer?.allowedTools).toEqual(["grep", "read"]);
  expect(builder?.toolBindings.map((binding) => binding.logicalName)).toEqual([
    "commit_work",
    "create_glyph",
    "submit_work",
  ]);
  expect(reviewer?.toolBindings.map((binding) => binding.logicalName)).toEqual([
    "submit_review",
    "submit_work",
  ]);
  expect(securityReviewer?.toolBindings.map((binding) => binding.logicalName)).toEqual([
    "submit_review",
    "submit_work",
  ]);
  expect(builder?.toolBindings.find((binding) => binding.logicalName === "submit_work")?.kind).toBe(
    "permission",
  );
  expect(
    reviewer?.toolBindings.find((binding) => binding.logicalName === "submit_work")?.kind,
  ).toBe("permission");
  expect(
    securityReviewer?.toolBindings.find((binding) => binding.logicalName === "submit_work")
      ?.kind,
  ).toBe("permission");
  expect(builder?.toolBindings.find((binding) => binding.logicalName === "commit_work")?.kind).toBe(
    "permission",
  );
  expect(builder?.toolBindings.find((binding) => binding.logicalName === "create_glyph")?.kind).toBe(
    "permission",
  );
  const reviewerSubmitReview = reviewer?.toolBindings.find(
    (binding) => binding.logicalName === "submit_review",
  );
  const securitySubmitReview = securityReviewer?.toolBindings.find(
    (binding) => binding.logicalName === "submit_review",
  );
  expect(reviewerSubmitReview?.kind).toBe("synthetic");
  if (!reviewerSubmitReview?.contract || !securitySubmitReview?.contract) {
    throw new Error("expected review slot fills to synthesize tool contracts");
  }
  expect(reviewerSubmitReview.contract.name).not.toBe(
    securitySubmitReview.contract.name,
  );
  expect(
    builder?.toolBindings.find((binding) => binding.logicalName === "submit_work")?.contract,
  ).toBeUndefined();
  expect(
    reviewer?.toolBindings.find((binding) => binding.logicalName === "submit_work")?.contract,
  ).toBeUndefined();
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

test("resolveAgent fails when trait required skills are not allowed", async () => {
  const registry = createResolveAgentRegistry();
  registry.skills.set(
    "reviewing",
    new Skill({
      name: "reviewing",
      sourcePath: "/tmp/skills/reviewing/SKILL.md",
    }),
  );
  registry.traits.set(
    "requires-reviewing",
    createCapabilityTrait({
      name: "requires-reviewing",
      requireSkills: ["reviewing"],
    }),
  );

  const exit = await Effect.runPromiseExit(
    resolveAgent(
      createCapabilityAgent({ traits: ["requires-reviewing"] }),
      registry,
      "opencode",
    ),
  );
  const failure = getFailure(exit);
  expect(failure._tag).toBe("AgentValidationError");
  if (failure._tag === "AgentValidationError") {
    expect(failure.field).toBe("traits");
    expect(failure.message).toBe(
      "trait 'resolve-agent-demo:requires-reviewing' requires missing skills: reviewing",
    );
  }
});

test("resolveAgentCapabilities merges trait grants and sorts capability output", async () => {
  const registry = emptyRegistry("/tmp/capability-demo", "capability-demo", "0.1.0");
  registry.tools.set("submit-work", createCapabilityTool("submit-work"));
  registry.traits.set(
    "zeta",
    createCapabilityTrait({
      name: "zeta",
      access: {
        tools: ["workspace/zeta"],
        toolGroups: ["workspace/group-zeta"],
        skills: ["skill-zeta"],
      },
      injectSkills: ["skill-injected"],
      tools: { submit_work: { ref: "submit-work" } },
    }),
  );
  registry.traits.set(
    "alpha",
    createCapabilityTrait({
      name: "alpha",
      requireTools: ["submit_work"],
    }),
  );
  const agent = createCapabilityAgent({
    traits: ["alpha", "zeta"],
    access: {
      tools: ["workspace/native"],
      toolGroups: ["workspace/group-native"],
      skills: ["skill-native"],
    },
    skills: ["direct-z", "direct-a"],
  });

  const capabilities = await Effect.runPromise(
    resolveAgentCapabilities(agent, registry),
  );

  expect(capabilities.traits.map((trait) => trait.canonicalId)).toEqual([
    "capability-demo:alpha",
    "capability-demo:zeta",
  ]);
  expect(capabilities.canonicalTraitIds).toEqual([
    "capability-demo:alpha",
    "capability-demo:zeta",
  ]);
  expect(capabilities.skills).toEqual(["direct-z", "direct-a"]);
  expect(capabilities.access).toEqual({
    tools: ["workspace/native", "workspace/zeta"],
    toolGroups: ["workspace/group-native", "workspace/group-zeta"],
    skills: ["skill-injected", "skill-native", "skill-zeta"],
  });
  expect(capabilities.toolRefs).toEqual([
    {
      logicalName: "submit_work",
      kind: "permission",
      toolPluginName: "capability-demo",
      toolName: "submit-work",
      toolSourcePath: "/tmp/submit-work.tool.ts",
    },
  ]);
});

test("resolveAgentCapabilities preserves trait duplicate and requirement failures", async () => {
  const registry = emptyRegistry("/tmp/capability-demo", "capability-demo", "0.1.0");
  registry.traits.set("alpha", createCapabilityTrait({ name: "alpha" }));
  registry.traits.set(
    "needs-tool",
    createCapabilityTrait({
      name: "needs-tool",
      requireTools: ["submit_work"],
    }),
  );

  const duplicateExit = await Effect.runPromiseExit(
    resolveAgentCapabilities(
      createCapabilityAgent({ traits: ["alpha", "alpha"] }),
      registry,
    ),
  );
  const duplicateFailure = getFailure(duplicateExit);
  expect(duplicateFailure._tag).toBe("AgentValidationError");
  if (duplicateFailure._tag === "AgentValidationError") {
    expect(duplicateFailure.field).toBe("traits[1]");
    expect(duplicateFailure.message).toBe(
      "declares duplicate trait 'capability-demo:alpha'",
    );
  }

  const missingExit = await Effect.runPromiseExit(
    resolveAgentCapabilities(
      createCapabilityAgent({ traits: ["needs-tool"] }),
      registry,
    ),
  );
  const missingFailure = getFailure(missingExit);
  expect(missingFailure._tag).toBe("AgentValidationError");
  if (missingFailure._tag === "AgentValidationError") {
    expect(missingFailure.field).toBe("traits");
    expect(missingFailure.message).toBe(
      "trait 'capability-demo:needs-tool' requires missing tools: submit_work",
    );
  }
});

test("resolveAgentCapabilities accepts identical logical tool bindings", async () => {
  const registry = emptyRegistry("/tmp/capability-demo", "capability-demo", "0.1.0");
  registry.tools.set("submit-work", createCapabilityTool("submit-work"));
  registry.traits.set(
    "left",
    createCapabilityTrait({
      name: "left",
      tools: { submit_work: { ref: "submit-work" } },
    }),
  );
  registry.traits.set(
    "right",
    createCapabilityTrait({
      name: "right",
      tools: { submit_work: { ref: "submit-work" } },
    }),
  );

  const capabilities = await Effect.runPromise(
    resolveAgentCapabilities(
      createCapabilityAgent({ traits: ["left", "right"] }),
      registry,
    ),
  );

  expect(capabilities.toolRefs).toEqual([
    {
      logicalName: "submit_work",
      kind: "permission",
      toolPluginName: "capability-demo",
      toolName: "submit-work",
      toolSourcePath: "/tmp/submit-work.tool.ts",
    },
  ]);
});

test("resolveAgentCapabilities rejects conflicting logical tool bindings", async () => {
  const registry = emptyRegistry("/tmp/capability-demo", "capability-demo", "0.1.0");
  registry.tools.set("left-tool", createCapabilityTool("left-tool"));
  registry.tools.set("right-tool", createCapabilityTool("right-tool"));
  registry.traits.set(
    "left",
    createCapabilityTrait({
      name: "left",
      tools: { submit_work: { ref: "left-tool" } },
    }),
  );
  registry.traits.set(
    "right",
    createCapabilityTrait({
      name: "right",
      tools: { submit_work: { ref: "right-tool" } },
    }),
  );

  const exit = await Effect.runPromiseExit(
    resolveAgentCapabilities(
      createCapabilityAgent({ traits: ["left", "right"] }),
      registry,
    ),
  );
  const failure = getFailure(exit);

  expect(failure._tag).toBe("AgentValidationError");
  if (failure._tag === "AgentValidationError") {
    expect(failure.field).toBe("traits");
    expect(failure.message).toBe(
      "traits 'capability-demo:left' and 'capability-demo:right' define conflicting tool bindings for 'submit_work'",
    );
  }
});

test("compilePluginForTarget dry-run leaves lowerer outputs cache and lockfile untouched", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const result = await Effect.runPromise(
    compilePluginForTarget({
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

test("compilePluginForTarget does not persist cache or lockfile after lowering failure", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();
  await writeText(join(projectRoot, ".opencode", "agents"), "not a directory\n");

  await expect(
    Effect.runPromise(
      compilePluginForTarget({
        pluginPath: pluginRoot,
        target: "opencode",
        scope: "project",
        projectPath: projectRoot,
        dryRun: false,
      }),
    ),
  ).rejects.toThrow();

  expect(await pathExists(join(pluginRoot, "prism.lock"))).toBe(false);
  expect(await directoryExists(join(pluginRoot, "dist", ".prism-cache"))).toBe(false);
});

test("orbit phase validation succeeds when assigned agents satisfy requirements", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );
  expect(
    skill.startsWith(
      "---\nname: delivery-contract\ndescription: Validate that work moves through the right trait-conforming agents\n---\n",
    ),
  ).toBe(true);
  expect(skill).toContain("### 1. Implement change — agent `builder`");
  expect(skill).toContain("### 3. Hand off work — agents `builder`, `reviewer`");
  // Derived skill renders trait protocols once, deduplicated across agents.
  expect(skill).toContain("## Trait protocols active in this orbit");
  expect(skill).toContain("`canonical-compile-fixture:reviewable`");
  expect(skill).toContain("`canonical-compile-fixture:self-assessing`");
  expect(
    await pathExists(
      join(projectRoot, ".opencode", "orbits", "delivery-contract.md"),
    ),
  ).toBe(false);

  const warmOpencode = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  const generatedPluginWrites = warmOpencode.operations.filter(
    (operation) =>
      operation.kind === "write-plugin-file" &&
      operation.target.includes(join(".opencode", "plugins", "prism-generated")),
  );
  expect(generatedPluginWrites.length).toBeGreaterThan(0);
  expect(generatedPluginWrites.every((operation) => operation.reason === "unchanged")).toBe(true);
});

test("orbit validation fails when assigned agents do not satisfy requirements", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    invalidOrbit: true,
  });

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("OrbitValidationError");
  if (failure._tag === "OrbitValidationError") {
    expect(failure.field).toBe("phases[1].requires[0]");
    expect(failure.message).toContain("reviewable");
    expect(failure.message).toContain("only 0 match");
  }
});

test("loadPlugin normalizes orbit phase references requirements and metadata", async () => {
  const pluginRoot = await createOrbitLoadFixture(
    `import { agentRef, defineOrbit, orbitRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default defineOrbit({
  name: "phase-normalization",
  description: "Phase normalization parser fixture",
  phases: [
    {
      name: "Singular agent",
      agent: agentRef("builder"),
      requires: [{ all: [traitRef("self-assessing"), traitRef("reviewable")], min: 2 }],
      notes: { Input: "scope", Done: "handoff" },
      telos: "Build the change",
      real_world_change: "User can finish the workflow",
      cold_pickup_test: "A fresh agent sees the next step",
      body: "Long phase body",
    },
    {
      name: "Bound template",
      orbit_binding: {
        orbit: orbitRef("template"),
        bindings: { required: "value" },
      },
    },
    {
      name: "Empty plural alias",
      agents: [],
      agent: agentRef("reviewer"),
    },
  ],
});
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const orbit = registry.orbits.get("phase-normalization");

  expect(orbit).toBeDefined();
  const [singularAgent, boundTemplate, emptyPluralAlias] = orbit?.phases ?? [];

  expect(singularAgent).toEqual({
    name: "Singular agent",
    agent: "builder",
    agents: ["builder"],
    requires: [{ all: ["self-assessing", "reviewable"], min: 2 }],
    notes: { Input: "scope", Done: "handoff" },
    telos: "Build the change",
    real_world_change: "User can finish the workflow",
    cold_pickup_test: "A fresh agent sees the next step",
    body: "Long phase body",
  });
  expect(boundTemplate).toEqual({
    name: "Bound template",
    orbit_binding: { orbit: "template", bindings: { required: "value" } },
    agents: [],
    requires: [],
    notes: undefined,
  });
  expect(Object.hasOwn(boundTemplate ?? {}, "notes")).toBe(true);
  expect(Object.hasOwn(boundTemplate?.orbit_binding ?? {}, "bindings")).toBe(true);
  expect(Object.keys(singularAgent?.notes ?? {})).toEqual(["Input", "Done"]);
  expect(emptyPluralAlias).toEqual({
    name: "Empty plural alias",
    agent: "reviewer",
    agents: [],
    requires: [],
    notes: undefined,
  });
});

test("loadPlugin reports SourceParseError paths for invalid orbit phase refs", async () => {
  const cases: Array<{
    readonly phase: string;
    readonly message: string;
  }> = [
    {
      phase: `{ name: "Invalid orbit", orbit: { kind: "orbit-ref", name: "" } }`,
      message:
        "phases[0].orbit: reference object must include a non-empty 'name'",
    },
    {
      phase: `{ name: "Invalid binding", orbit_binding: { orbit: { kind: "orbit-ref", name: "" } } }`,
      message:
        "phases[0].orbit_binding.orbit: reference object must include a non-empty 'name'",
    },
    {
      phase: `{ name: "Duplicate aliases", agent: "builder", agents: ["reviewer"] }`,
      message:
        "phase 1 ('Duplicate aliases') declares multiple agent assignment aliases (agents, agent); use only one of agent or agents",
    },
    {
      phase: `{ name: "Invalid plural", agents: [{ kind: "agent-ref", name: "" }] }`,
      message:
        "phases[0].agents[0]: reference object must include a non-empty 'name'",
    },
    {
      phase: `{ name: "Invalid singular through raw agents", agent: { kind: "agent-ref", name: "" } }`,
      message:
        "phases[0].agents[0]: reference object must include a non-empty 'name'",
    },
    {
      phase: `{ name: "Invalid raw singular and requirement", agent: { kind: "agent-ref", name: "" }, requires: [{ all: [{ kind: "trait-ref", name: "" }] }] }`,
      message:
        "phases[0].agents[0]: reference object must include a non-empty 'name'",
    },
    {
      phase: `{ name: "Invalid singular field", agents: [], agent: { kind: "agent-ref", name: "" } }`,
      message:
        "phases[0].agent: reference object must include a non-empty 'name'",
    },
    {
      phase: `{ name: "Invalid singular and requirement", agents: [], agent: { kind: "agent-ref", name: "" }, requires: [{ all: [{ kind: "trait-ref", name: "" }] }] }`,
      message:
        "phases[0].requires[0].all[0]: reference object must include a non-empty 'name'",
    },
    {
      phase: `{ name: "Invalid requirement", requires: [{ all: [{ kind: "trait-ref", name: "" }] }] }`,
      message:
        "phases[0].requires[0].all[0]: reference object must include a non-empty 'name'",
    },
  ];

  for (const current of cases) {
    const { failure, sourcePath } = await expectOrbitSourceParseFailure(
      orbitSourceWithPhase(current.phase),
    );

    expect(failure.kind).toBe("orbit");
    expect(failure.sourcePath).toBe(sourcePath);
    expect(failure.message).toBe(current.message);
  }
});

test("validateOrbit rejects direct parameterized orbit references", async () => {
  const registry = createOrbitValidationRegistry();
  const orbit = createValidationOrbit({
    phase: { orbit: "template" },
  });

  const failure = await expectOrbitValidationFailure(orbit, registry);

  expect(failure.field).toBe("phases[0].orbit");
  expect(failure.message).toContain("references parameterized orbit 'template'");
  expect(failure.message).toContain("use orbit_binding instead");
});

test("validateOrbit accepts direct concrete orbit references without checking phase-local requirements", async () => {
  const registry = createOrbitValidationRegistry();
  const orbit = createValidationOrbit({
    phase: { orbit: "concrete", requires: [{ all: ["missing-trait"], min: 0 }] },
  });

  await Effect.runPromise(validateOrbit(orbit, registry));
});

test("validateOrbit validates orbit_binding target and parameter contracts", async () => {
  const cases: Array<{
    readonly phase: Partial<NormalizedOrbitPhase>;
    readonly field: string;
    readonly message: string;
  }> = [
    {
      phase: { orbit_binding: { orbit: "builder", bindings: { required: "x" } } },
      field: "phases[0].orbit_binding",
      message: "resolves to an agent",
    },
    {
      phase: { orbit_binding: { orbit: "missing", bindings: { required: "x" } } },
      field: "phases[0].orbit_binding",
      message: "references unknown orbit 'missing'",
    },
    {
      phase: { orbit_binding: { orbit: "template", bindings: { extra: "x" } } },
      field: "phases[0].orbit_binding.bindings",
      message: "passes unknown binding(s) to 'template': extra",
    },
    {
      phase: { orbit_binding: { orbit: "template", bindings: {} } },
      field: "phases[0].orbit_binding.bindings",
      message: "is missing required binding(s) for 'template': required",
    },
  ];

  for (const current of cases) {
    const registry = createOrbitValidationRegistry();
    const orbit = createValidationOrbit({ phase: current.phase });

    const failure = await expectOrbitValidationFailure(orbit, registry);

    expect(failure.field).toBe(current.field);
    expect(failure.message).toContain(current.message);
  }
});

test("validateOrbit preserves phase reference and requirement failure ordering", async () => {
  const cases: Array<{
    readonly phase: Partial<NormalizedOrbitPhase>;
    readonly field: string;
    readonly message: string;
  }> = [
    {
      phase: { orbit: "concrete", agents: ["builder"] },
      field: "phases[0]",
      message: "declares multiple references",
    },
    {
      phase: { agents: ["missing"] },
      field: "phases[0].agents[0]",
      message: "references unknown agent 'missing'",
    },
    {
      phase: { agents: ["builder", "builder"] },
      field: "phases[0].agents[1]",
      message: "assigns duplicate agent 'builder'",
    },
    {
      phase: { agents: ["builder", "alias:builder"] },
      field: "phases[0].agents[1]",
      message: "assigns duplicate agent 'alias:builder'",
    },
    {
      phase: { requires: [{ all: ["reviewable"] }] },
      field: "phases[0].requires",
      message: "declares trait requirements but assigns no agents",
    },
    {
      phase: { orbit: "builder", requires: [{ all: ["reviewable"] }] },
      field: "phases[0].requires",
      message: "declares trait requirements but assigns no agents",
    },
    {
      phase: { agents: ["builder"], requires: [{ all: ["reviewable"], min: 0 }] },
      field: "phases[0].requires[0].min",
      message: "min must be an integer greater than or equal to 1",
    },
    {
      phase: { agents: ["builder"], requires: [{ all: [], min: 0 }] },
      field: "phases[0].requires[0].min",
      message: "min must be an integer greater than or equal to 1",
    },
    {
      phase: { agents: ["builder"], requires: [{ all: ["missing-trait"], min: 0 }] },
      field: "phases[0].requires[0].min",
      message: "min must be an integer greater than or equal to 1",
    },
    {
      phase: { agents: ["builder"], requires: [{ all: [] }] },
      field: "phases[0].requires[0].all",
      message: "trait requirement must include at least one trait",
    },
    {
      phase: { agents: ["builder"], requires: [{ all: ["missing-trait"] }] },
      field: "phases[0].requires[0].all[0]",
      message: "references unknown trait 'missing-trait'",
    },
  ];

  for (const current of cases) {
    const registry = createOrbitValidationRegistry();
    const orbit = createValidationOrbit({ phase: current.phase });

    const failure = await expectOrbitValidationFailure(orbit, registry);

    expect(failure.field).toBe(current.field);
    expect(failure.message).toContain(current.message);
  }
});

test("validateOrbit rejects template placeholders inside references before resolution", async () => {
  const registry = createOrbitValidationRegistry();
  const orbit = createValidationOrbit({
    parameters: [{ name: "Agent" }],
    phase: { agents: ["${Agent}"] },
  });

  const failure = await expectOrbitValidationFailure(orbit, registry);

  expect(failure.field).toBe("phases[0].agents[0]");
  expect(failure.message).toBe("reference names cannot contain template placeholders");
});

test("orbit orchestrator validation fails when the orchestrator agent does not exist", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    invalidOrbitPermissionAgent: true,
  });

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("OrbitValidationError");
  if (failure._tag === "OrbitValidationError") {
    expect(failure.field).toBe("orchestrator.agent");
    expect(failure.message).toContain("unknown agent");
  }
});

test("orbit skill renders orchestrator section and grants the orbit skill to the orchestrator", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );
  expect(skill).toContain("## Orchestrator");
  expect(skill).toContain("`builder`");
  expect(skill).toContain("`create_glyph`");

  // The orchestrator agent (builder) auto-receives the orbit skill.
  const builder = result.composed.find((agent) => agent.name === "builder");
  expect(builder?.allowedSkills).toContain("delivery-contract");
});

test("orbit-wide tool_permissions materialize on every phase agent", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  // Replace the orbit file with one that uses orbit-wide tool_permissions
  // and no orchestrator. Both phase agents (builder + reviewer) should get the
  // wide-granted tool.
  await writeText(
    join(pluginRoot, "orbits", "delivery-contract.orbit.ts"),
    `import { agentRef, defineOrbit, traitRef } from ${JSON.stringify(prismImportPath)};

export default defineOrbit({
  name: "delivery-contract",
  description: "Wide-grant variant",
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [{ all: [traitRef("committable"), traitRef("self-assessing")] }],
    },
    {
      name: "Review change",
      agents: [agentRef("reviewer")],
      requires: [{ all: [traitRef("reviewable"), traitRef("self-assessing")] }],
    },
  ],
  tool_permissions: [
    { ref: "protocol-core:create_glyph", as: "create_glyph" },
  ],
});
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const builder = result.composed.find((agent) => agent.name === "builder");
  const reviewer = result.composed.find((agent) => agent.name === "reviewer");
  expect(
    builder?.toolBindings.some((binding) => binding.logicalName === "create_glyph"),
  ).toBe(true);
  expect(
    reviewer?.toolBindings.some((binding) => binding.logicalName === "create_glyph"),
  ).toBe(true);

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );
  expect(skill).toContain("## Tools available to every phase agent");
  expect(skill).toContain("`create_glyph`");
});

test("orbit parser rejects the obsolete tool_permissions shape with agents", async () => {
  const projectRoot = await createTempRoot();
  const pluginRoot = join(projectRoot, "plugin");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "obsolete-shape",
        version: "0.1.0",
        targets: {
          orbits: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "orbits", "obsolete.orbit.ts"),
    `import { defineOrbit } from ${JSON.stringify(prismImportPath)};

export default defineOrbit({
  name: "obsolete",
  description: "Uses the deprecated tool_permissions shape with agents",
  phases: [],
  tool_permissions: [
    { agents: ["builder"], tools: ["protocol-core:create_glyph"] },
  ],
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error("expected typed compile failure");
  }
  const error = failure.value as CompileError;
  expect(error._tag).toBe("SourceParseError");
});

test("slot-filled trait tools fail closed on inline schemas", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    inlineSlotSchema: true,
  });

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("SourceParseError");
  expect(failure.message).toContain("must be an imported schema identifier");
});

test("slot-filled trait tools fail closed on undeclared slots", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    undeclaredSlot: true,
  });

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("AgentValidationError");
  expect(failure.message).toContain("fills undeclared tool slot(s): unknown_verdict");
});

test("slot source capture tolerates trait refs before slot-filled bindings", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    mixedTraitRefsBeforeSlotBinding: true,
  });

  await Effect.runPromise(
    compilePluginForTarget({
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
    "prism-generated-canonical-compile-fixture",
  );
  const bundle = await readFile(join(generatedRoot, "dist", "server.mjs"), "utf8");
  expect(bundle).toContain("submit_review__review_findings_slot");
  expect(await pathExists(join(generatedRoot, "src", "server.ts"))).toBe(false);
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
  traits: [{ kind: "trait-ref", name: "" }],
};
`,
      message: "AgentNameMismatchError:not-worker",
    },
    {
      agentSource: `export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: [{ kind: "trait-ref", name: "" }],
  model: "raw-model",
};
`,
      message: "traits[0]: reference object must include a non-empty 'name'",
    },
    {
      agentSource: `export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: [
    {
      kind: "trait-binding",
      trait: { kind: "trait-ref", name: "" },
      tools: {
        submit_review: {
          slots: { verdict: 42 },
        },
      },
    },
  ],
  model: "raw-model",
};
`,
      message: "traits[0]: reference object must include a non-empty 'name'",
    },
    {
      agentSource: `export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: [
    {
      kind: "trait-binding",
      trait: "reviewable",
      tools: {
        submit_review: {
          slots: { verdict: 42 },
        },
      },
    },
  ],
  model: "raw-model",
};
`,
      message:
        "traits[0].tools.submit_review.slots.verdict: must be an Effect Schema",
    },
    {
      agentSource: `export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  model: { kind: "model-profile-ref", modelspace: "", name: "reviewer" },
  access: {
    tools: [{ kind: "tool-ref", toolspace: "", name: "shell" }],
  },
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
  access: {
    tools: [{ kind: "tool-ref", toolspace: "", name: "shell" }],
  },
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
  access: {
    tools: [{ kind: "tool-ref", toolspace: "", name: "shell" }],
  },
  skills: ["testing"],
};
`,
      message:
        "access.tools[0]: tool ref object must include a non-empty 'toolspace'",
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
  await writeText(join(outputPluginRoot, "stale", "old.txt"), "stale\n");

  const result = await Effect.runPromise(
    compilePluginForTarget({
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

  const mcpConfig = JSON.parse(await readFile(join(outputPluginRoot, "mcp_config.json"), "utf8")) as {
    mcpServers?: Record<string, { command: string; args: string[]; trust?: unknown }>;
  };
  expect(mcpConfig).toEqual({
    mcpServers: {
      "prism-generated-antigravity-plugin-demo": {
        command: "bun",
        args: [join(outputPluginRoot, "mcp", "prism_generated_antigravity_plugin_demo", "server.mjs")],
      },
    },
  });
  expect(mcpConfig.mcpServers?.["prism-generated-antigravity-plugin-demo"]).not.toHaveProperty("trust");

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
    tools: [
      "mcp_prism-generated-antigravity-plugin-demo_antigravity_plugin_demo_submit_work",
      "read_file",
    ],
  });
  expect(parsedAgent.content).toContain("# Worker");
  expect(parsedAgent.content).toContain("Submit work through the typed Antigravity plugin tool.");

  expect(await readFile(join(outputPluginRoot, "skills", "testing", "SKILL.md"), "utf8")).toContain("# Testing");
  const orbitSkill = await readFile(join(outputPluginRoot, "skills", "delivery", "SKILL.md"), "utf8");
  expect(orbitSkill).toContain('<!-- prism:orbit-skill owner="antigravity_plugin.demo" -->');
  expect(orbitSkill).toContain("# delivery");
  expect(orbitSkill).toContain("### 1. Build — agent `worker`");

  expect(await pathExists(join(outputPluginRoot, "mcp", "prism_generated_antigravity_plugin_demo", "server.mjs"))).toBe(true);

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
          matcher: "mcp_prism-generated-antigravity-plugin-demo_antigravity_plugin_demo_submit_work",
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

  expect(await pathExists(join(outputPluginRoot, "stale", "old.txt"))).toBe(false);
  expect(result.operations.some((operation) => operation.kind === "prune-plugin-path" && operation.target.endsWith(join("stale", "old.txt")))).toBe(true);
});

test("compilePluginForTarget exposes standalone canonical tools through MCP bundle lowerers", async () => {
  const { pluginRoot, projectRoot } = await createStandaloneToolFixture();
  const targets = ["codex-cli", "claude-code", "antigravity-cli", "grok", "factory-droid"] as const;

  for (const target of targets) {
    await Effect.runPromise(
      compilePluginForTarget({
        pluginPath: pluginRoot,
        target,
        scope: "project",
        projectPath: projectRoot,
        dryRun: false,
      }),
    );
  }

  const expectedToolName = "tool_only_demo_echo_message";

  const codexConfig = await readFile(join(projectRoot, ".codex", "config.toml"), "utf8");
  expect(codexConfig).toContain('["mcp_servers"."prism-generated-tool-only-demo"]');
  expect(codexConfig).toContain('enabled_tools = ["tool_only_demo_echo_message"]');
  const codexBundle = await readFile(
    join(projectRoot, ".codex", "mcp", "prism_generated_tool_only_demo", "server.mjs"),
    "utf8",
  );
  expect(codexBundle).toContain(expectedToolName);
  expect(codexBundle).toContain("tools/list");

  const claudeRoot = join(projectRoot, ".claude", "plugins", "prism-generated-tool-only-demo");
  const claudeMcp = JSON.parse(await readFile(join(claudeRoot, ".mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { command: string; args: string[] }>;
  };
  expect(claudeMcp.mcpServers?.["prism-generated-tool-only-demo"]).toEqual({
    command: "bun",
    args: ["${CLAUDE_PLUGIN_ROOT}/mcp/prism_generated_tool_only_demo/server.mjs"],
  });
  const claudeBundle = await readFile(
    join(claudeRoot, "mcp", "prism_generated_tool_only_demo", "server.mjs"),
    "utf8",
  );
  expect(claudeBundle).toContain(expectedToolName);
  expect(claudeBundle).toContain("tools/list");

  const antigravityRoot = join(projectRoot, ".agents", "plugins", "prism-generated-tool-only-demo");
  const antigravityMcpConfig = JSON.parse(await readFile(join(antigravityRoot, "mcp_config.json"), "utf8")) as {
    mcpServers?: Record<string, { command: string; args: string[] }>;
  };
  expect(antigravityMcpConfig.mcpServers?.["prism-generated-tool-only-demo"]).toEqual({
    command: "bun",
    args: [join(antigravityRoot, "mcp", "prism_generated_tool_only_demo", "server.mjs")],
  });
  const antigravityBundle = await readFile(
    join(antigravityRoot, "mcp", "prism_generated_tool_only_demo", "server.mjs"),
    "utf8",
  );
  expect(antigravityBundle).toContain(expectedToolName);
  expect(antigravityBundle).toContain("tools/list");

  const grokRoot = join(projectRoot, ".grok", "plugins", "prism-generated-tool-only-demo");
  const grokMcp = JSON.parse(await readFile(join(grokRoot, ".mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { command: string; args: string[] }>;
  };
  expect(grokMcp.mcpServers?.["prism-generated-tool-only-demo"]?.command).toBe("bun");
  expect(grokMcp.mcpServers?.["prism-generated-tool-only-demo"]?.args).toEqual([
    join(grokRoot, "mcp", "prism_generated_tool_only_demo", "server.mjs"),
  ]);
  const grokBundle = await readFile(
    join(grokRoot, "mcp", "prism_generated_tool_only_demo", "server.mjs"),
    "utf8",
  );
  expect(grokBundle).toContain(expectedToolName);
  expect(grokBundle).toContain("tools/list");

  const factoryRoot = join(projectRoot, ".factory", "plugins", "prism-generated-tool-only-demo");
  const factoryMcp = JSON.parse(await readFile(join(factoryRoot, "mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { type: string; command: string; args: string[] }>;
  };
  expect(factoryMcp.mcpServers?.["prism-generated-tool-only-demo"]).toEqual({
    type: "stdio",
    command: "bun",
    args: ["${DROID_PLUGIN_ROOT}/mcp/prism_generated_tool_only_demo/server.mjs"],
  });
  const factoryBundle = await readFile(
    join(factoryRoot, "mcp", "prism_generated_tool_only_demo", "server.mjs"),
    "utf8",
  );
  expect(factoryBundle).toContain(expectedToolName);
  expect(factoryBundle).toContain("tools/list");
});

test("compilePluginForTarget emits a Codex project bundle", async () => {
  const { pluginRoot, projectRoot } = await createCodexProjectFixture();

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "codex-cli",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const codexRoot = join(projectRoot, ".codex");
  expect(result.composed).toHaveLength(1);
  expect(result.outputRoot.replace(/\/$/u, "")).toBe(codexRoot);

  const config = await readFile(join(codexRoot, "config.toml"), "utf8");
  expect(config).toContain("[features]\nhooks = true");
  expect(config).not.toContain("codex_hooks");
  expect(config).toContain("# --- prism codex-cli begin: codex-project-demo ---");
  expect(config).toContain('["mcp_servers"."prism-generated-codex-project-demo"]');
  expect(config).toContain('enabled_tools = ["codex_project_demo_submit_work"]');
  expect(config).toContain('[["hooks"."PreToolUse"]]');
  expect(config).toContain('matcher = "shell\\\\.command"');

  const agent = await readFile(join(codexRoot, "agents", "reviewer.toml"), "utf8");
  expect(agent).toContain('name = "reviewer"');
  expect(agent).toContain('["mcp_servers"."prism-generated-codex-project-demo"]');

  expect(await pathExists(join(codexRoot, "mcp", "prism_generated_codex_project_demo", "server.mjs"))).toBe(true);
  expect(await pathExists(join(codexRoot, "hooks", "audit-shell.mjs"))).toBe(true);
  expect(await readFile(join(codexRoot, "skills", "testing", "SKILL.md"), "utf8")).toContain("# Testing");
  expect(await readFile(join(codexRoot, "AGENTS.md"), "utf8")).toContain("Use project-local Codex guidance.");
});

test("compilePluginForTarget lowers OpenCode session hooks through plugin events", async () => {
  const { pluginRoot, projectRoot } = await createOpenCodeHookFixture({ sessionHook: true });

  await Effect.runPromise(
    compilePluginForTarget({
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

test("compilePluginForTarget lowers executable canonical tools for opencode", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const opencode = await Effect.runPromise(
    compilePluginForTarget({
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
  expect(opencodeAgent).toContain("name: builder");
  expect(opencodeAgent).toContain(
    "description: Builder agent for canonical compile integration tests",
  );
  expect(opencodeAgent).toContain("permission:");
  expect(opencodeAgent).not.toContain("tools:");
  expect(opencodeAgent).toContain("read: allow");
  expect(opencodeAgent).toContain("grep: allow");
  expect(opencodeAgent).toContain("bash: allow");
  expect(opencodeAgent).toContain("canonical_compile_fixture_commit_work: allow");
  expect(opencodeAgent).toContain("protocol_core_external_submit: allow");
  expect(opencodeAgent).toContain("protocol_core_create_glyph: allow");
  expect(opencodeAgent).not.toContain("canonical_compile_fixture_builder_submit_work");
  expect(opencodeAgent).not.toContain("canonical_compile_fixture_delivery_contract__builder__create_glyph");
  expect(opencodeAgent).toContain(
    "canonical_compile_fixture_submit_review__review_findings_slot: deny",
  );
  const submittableInstructionIndex = opencodeAgent.indexOf(
    "Submit completed work through the typed submission surface before handing off.",
  );
  const committableInstructionIndex = opencodeAgent.indexOf(
    "Commit owned implementation changes only after the submitted work is complete.",
  );
  const selfAssessingInstructionIndex = opencodeAgent.indexOf(
    "Run the relevant validation before final response or handoff.",
  );
  expect(submittableInstructionIndex).toBeGreaterThan(-1);
  expect(committableInstructionIndex).toBeGreaterThan(submittableInstructionIndex);
  expect(selfAssessingInstructionIndex).toBeGreaterThan(committableInstructionIndex);

  const reviewerAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "reviewer.md"),
    "utf8",
  );
  expect(reviewerAgent).toContain("protocol_core_external_submit: allow");
  expect(reviewerAgent).not.toContain("canonical_compile_fixture_builder_submit_work");
  expect(reviewerAgent).toContain("protocol_core_create_glyph: deny");
  expect(reviewerAgent).not.toContain("canonical_compile_fixture_delivery_contract__builder__create_glyph");
  expect(reviewerAgent).toMatch(
    /canonical_compile_fixture_submit_review__review_findings_slot: allow/,
  );

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
  expect(generatedToolNames).toContain("canonical_compile_fixture_submit_review__review_findings_slot");
  expect(generatedToolNames).not.toContain("protocol_core_external_submit");
  expect(generatedToolNames).not.toContain("canonical_compile_fixture_builder_submit_work");
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
  expect(generatedServerSource).not.toContain("canonical_compile_fixture_builder_submit_work");
  expect(generatedServerSource).not.toContain("delivery-contract__builder__create_glyph");
  expect(generatedServerSource).toContain("submit_review__review_findings_slot");
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
    permission: Record<string, string>;
  };
  expect(opencodeConfig.permission).toMatchObject({
    "canonical_compile_fixture_*": "deny",
    "protocol_core_*": "deny",
  });
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
      join(projectRoot, ".opencode", "orbits", "delivery-contract.md"),
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
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo a message through Amp.",
  input: Schema.Struct({
    message: Schema.String.annotations({ description: "Message to echo" }),
  }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
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

test("compilePluginForTarget rejects Amp hooks at the capability boundary", async () => {
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
          hooks: ["amp-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "hooks", "session-start.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "session-start",
  event: hookEvent.sessionStart,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("UnsupportedTargetCapabilityError");
  if (failure._tag === "UnsupportedTargetCapabilityError") {
    expect(failure.capability).toBe("hooks");
    expect(failure.message).toContain("does not support Prism hook lowering");
  }
});

test("compilePluginForTarget lowers Hermes skills and canonical tools into MCP config", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "hermes-tool-demo");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "hermes-tool-demo",
        version: "0.1.0",
        targets: {
          skills: ["hermes"],
          tools: ["hermes"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "skills", "hermes-demo", "SKILL.md"),
    `---\nname: hermes-demo\ndescription: Hermes-specific operating guidance\n---\n\n# Hermes Demo\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo a message through Hermes MCP.",
  input: Schema.Struct({
    message: Schema.String.annotations({ description: "Message to echo" }),
  }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "hermes",
      scope: "global",
      dryRun: true,
    }),
  );

  const hermesRoot = join(homedir(), ".hermes/");
  const serverPath = join(
    hermesRoot,
    "prism",
    "mcp",
    "prism_generated_hermes_tool_demo",
    "server.mjs",
  );
  expect(result.outputRoot).toBe(hermesRoot);

  const skillWrite = result.operations.find(
    (operation) =>
      operation.kind === "write-md" &&
      operation.target === join(hermesRoot, "skills", "hermes-demo", "SKILL.md"),
  );
  expect(skillWrite?.kind).toBe("write-md");
  if (skillWrite?.kind === "write-md") {
    expect(skillWrite.content).toContain("# Hermes Demo");
  }

  const serverWrite = result.operations.find(
    (operation) => operation.kind === "write-plugin-file" && operation.target === serverPath,
  );
  expect(serverWrite?.kind).toBe("write-plugin-file");
  if (serverWrite?.kind === "write-plugin-file") {
    expect(serverWrite.content).toContain("hermes_tool_demo_echo");
    expect(serverWrite.content).toContain("Echo a message through Hermes MCP.");
  }

  const configWrite = result.operations.find(
    (operation) =>
      operation.kind === "patch-config" &&
      operation.target === join(hermesRoot, "config.yaml"),
  );
  expect(configWrite?.kind).toBe("patch-config");
  if (configWrite?.kind === "patch-config") {
    const expectedBunCommand = /(?:^|[/\\])bun(?:\.exe)?$/iu.test(process.execPath)
      ? process.execPath
      : "bun";

    expect(configWrite.content).toContain("mcp_servers:");
    expect(configWrite.content).toContain("prism-generated-hermes-tool-demo:");
    expect(configWrite.content).toContain(`command: ${JSON.stringify(expectedBunCommand)}`);
    expect(configWrite.content).toContain(JSON.stringify(serverPath));
    expect(configWrite.content).toContain("connect_timeout: 10");
    expect(configWrite.content).toContain("timeout: 120");
    expect(configWrite.content).toContain("sampling:");
    expect(configWrite.content).toContain("enabled: false");
    expect(configWrite.content).toContain("PRISM_MCP_WORKING_DIRECTORY");
    expect(configWrite.content).toContain(`PRISM_MCP_REPO_ROOT: ${JSON.stringify(hermesRoot)}`);
    expect(configWrite.content).toContain("hermes_tool_demo_echo");
  }
});

test("compilePluginForTarget can lower Hermes canonical tools as Streamable HTTP MCP", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "hermes-http-demo");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "hermes-http-demo",
        version: "0.1.0",
        targets: {
          tools: ["hermes"],
        },
        runtime: {
          mcp: {
            hermes: {
              transport: "streamable-http",
              host: "127.0.0.1",
              port: 38463,
              tokenEnv: "PRISM_MCP_TOKEN",
              connectTimeoutMs: 15_000,
              toolTimeoutMs: 90_000,
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
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo through Hermes Streamable HTTP MCP.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "hermes",
      scope: "global",
      dryRun: true,
    }),
  );

  const hermesRoot = join(homedir(), ".hermes/");
  const serverPath = join(
    homedir(),
    ".config",
    "prism",
    "mcp",
    "prism_generated_hermes_http_demo",
    "server.mjs",
  );
  const serverWrite = result.operations.find(
    (operation) => operation.kind === "write-plugin-file" && operation.target === serverPath,
  );
  expect(serverWrite?.kind).toBe("write-plugin-file");
  if (serverWrite?.kind === "write-plugin-file") {
    expect(serverWrite.content).toContain("Bun.serve");
    expect(serverWrite.content).toContain("PRISM_MCP_TOKEN");
    expect(serverWrite.content).toContain('PRISM_MCP_TOOL_TIMEOUT_MS ?? "90000"');
    expect(serverWrite.content).toContain("hermes_http_demo_echo");
  }

  const configWrite = result.operations.find(
    (operation) =>
      operation.kind === "patch-config" &&
      operation.target === join(hermesRoot, "config.yaml"),
  );
  expect(configWrite?.kind).toBe("patch-config");
  if (configWrite?.kind === "patch-config") {
    expect(configWrite.content).toContain("prism-generated-hermes-http-demo:");
    expect(configWrite.content).toContain('url: "http://127.0.0.1:38463/mcp"');
    expect(configWrite.content).toContain("connect_timeout: 15");
    expect(configWrite.content).toContain("timeout: 90");
    expect(configWrite.content).toContain('Authorization: "Bearer ${PRISM_MCP_TOKEN}"');
    expect(configWrite.content).toContain("sampling:");
    expect(configWrite.content).toContain("enabled: false");
    expect(configWrite.content).toContain("hermes_http_demo_echo");
    expect(configWrite.content).not.toContain("prism-generated-hermes-http-demo:\n    command:");
  }
});

test("compilePluginForTarget serves Hermes HTTP MCP by default before config write", async () => {
  const port = await getFreePort("127.0.0.1");
  const tokenEnv = "PRISM_MCP_COMPILE_GATE_TOKEN";
  const { pluginRoot, hermesRoot } = await createHermesHttpToolPlugin({
    pluginName: "hermes-http-gate-demo",
    tokenEnv,
    port,
  });

  await withEnv(tokenEnv, compileTestToken, async () => {
    try {
      const result = await Effect.runPromise(
        compilePluginForTarget({
          pluginPath: pluginRoot,
          target: "hermes",
          scope: "global",
          root: hermesRoot,
          dryRun: false,
        }),
      );

      expect(result.outputRoot).toBe(hermesRoot);
      const config = await readFile(join(hermesRoot, "config.yaml"), "utf8");
      expect(config).toContain(`url: "http://127.0.0.1:${port}/mcp"`);
      expect(config).toContain(`Authorization: "Bearer ${compileTestToken}"`);
      const configWrite = result.operations.find(
        (
          operation,
        ): operation is Extract<
          (typeof result.operations)[number],
          { readonly kind: "patch-config" }
        > =>
          operation.kind === "patch-config" &&
          operation.target === join(hermesRoot, "config.yaml"),
      );
      expect(configWrite?.mode).toBe(0o600);
      expect(
        await pathExists(
          join(hermesRoot, "prism", "mcp", "prism_generated_hermes_http_gate_demo", "runtime.json"),
        ),
      ).toBe(true);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
});

test("compilePluginForTarget can write harness config to a profile root while sharing an MCP runtime root", async () => {
  const port = await getFreePort("127.0.0.1");
  const tokenEnv = "PRISM_MCP_COMPILE_SPLIT_ROOT_TOKEN";
  const { pluginRoot, hermesRoot } = await createHermesHttpToolPlugin({
    pluginName: "hermes-http-split-root-demo",
    tokenEnv,
    port,
  });
  const root = await createTempRoot();
  const runtimeRoot = join(root, "shared-runtime-root");

  await withEnv(tokenEnv, compileTestToken, async () => {
    try {
      const result = await Effect.runPromise(
        compilePluginForTarget({
          pluginPath: pluginRoot,
          target: "hermes",
          scope: "global",
          root: hermesRoot,
          mcpRoot: runtimeRoot,
          dryRun: false,
        }),
      );

      expect(result.outputRoot).toBe(hermesRoot);
      const config = await readFile(join(hermesRoot, "config.yaml"), "utf8");
      expect(config).toContain(`url: "http://127.0.0.1:${port}/mcp"`);
      expect(config).toContain(`Authorization: "Bearer ${compileTestToken}"`);
      expect(
        await pathExists(
          join(runtimeRoot, "prism", "mcp", "prism_generated_hermes_http_split_root_demo", "runtime.json"),
        ),
      ).toBe(true);
      expect(
        await pathExists(
          join(runtimeRoot, "prism", "mcp", "prism_generated_hermes_http_split_root_demo", "server.mjs"),
        ),
      ).toBe(true);
      expect(await pathExists(join(runtimeRoot, "prism", "tokens.json"))).toBe(true);
      expect(
        await pathExists(
          join(hermesRoot, "prism", "mcp", "prism_generated_hermes_http_split_root_demo", "runtime.json"),
        ),
      ).toBe(false);
      expect(
        await pathExists(
          join(hermesRoot, "prism", "mcp", "prism_generated_hermes_http_split_root_demo", "server.mjs"),
        ),
      ).toBe(false);
      expect(await pathExists(join(hermesRoot, "prism", "tokens.json"))).toBe(false);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: runtimeRoot,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
});

test("compilePluginForTarget can serve Hermes HTTP MCP without token env", async () => {
  const port = await getFreePort("127.0.0.1");
  const tokenEnv = "PRISM_MCP_COMPILE_MISSING_TOKEN";
  const { pluginRoot, hermesRoot } = await createHermesHttpToolPlugin({
    pluginName: "hermes-http-serve-order-demo",
    tokenEnv,
    port,
  });

  try {
    const result = await Effect.runPromise(
      compilePluginForTarget({
        pluginPath: pluginRoot,
        target: "hermes",
        scope: "global",
        root: hermesRoot,
        dryRun: false,
        mcpLifecycle: "serve",
      }),
    );

    expect(result.outputRoot).toBe(hermesRoot);
    const config = await readFile(join(hermesRoot, "config.yaml"), "utf8");
    expect(config).toContain(`url: "http://127.0.0.1:${port}/mcp"`);
    expect(config).toContain('Authorization: "Bearer ');
    expect(config).not.toContain("${");
    expect(await pathExists(join(hermesRoot, "prism", "tokens.json"))).toBe(true);
  } finally {
    await stopMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    }).catch(() => undefined);
  }
});

test("compilePluginForTarget verifies a running Hermes HTTP MCP daemon before config write", async () => {
  const port = await getFreePort("127.0.0.1");
  const tokenEnv = "PRISM_MCP_COMPILE_VERIFY_TOKEN";
  const { pluginRoot, hermesRoot } = await createHermesHttpToolPlugin({
    pluginName: "hermes-http-verify-demo",
    tokenEnv,
    port,
  });

  await withEnv(tokenEnv, compileTestToken, async () => {
    await serveMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    try {
      const result = await Effect.runPromise(
        compilePluginForTarget({
          pluginPath: pluginRoot,
          target: "hermes",
          scope: "global",
          root: hermesRoot,
          dryRun: false,
          mcpLifecycle: "verify",
        }),
      );

      expect(result.outputRoot).toBe(hermesRoot);
      const config = await readFile(join(hermesRoot, "config.yaml"), "utf8");
      expect(config).toContain("prism-generated-hermes-http-verify-demo:");
      expect(config).toContain(`url: "http://127.0.0.1:${port}/mcp"`);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
});

test("compilePluginForTarget rejects stale Hermes HTTP daemons before config write", async () => {
  const port = await getFreePort("127.0.0.1");
  const tokenEnv = "PRISM_MCP_COMPILE_STALE_TOKEN";
  const { pluginRoot, hermesRoot } = await createHermesHttpToolPlugin({
    pluginName: "hermes-http-stale-demo",
    tokenEnv,
    port,
  });

  await withEnv(tokenEnv, compileTestToken, async () => {
    await serveMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    try {
      await writeText(
        join(pluginRoot, "tools", "echo.tool.ts"),
        (await readFile(join(pluginRoot, "tools", "echo.tool.ts"), "utf8")).replace(
          "Echo through Hermes MCP.",
          "Echo through changed Hermes MCP.",
        ),
      );

      await expect(
        Effect.runPromise(
          compilePluginForTarget({
            pluginPath: pluginRoot,
            target: "hermes",
            scope: "global",
            root: hermesRoot,
            dryRun: false,
            mcpLifecycle: "verify",
          }),
        ),
      ).rejects.toThrow(/stale-build/);

      expect(await pathExists(join(hermesRoot, "config.yaml"))).toBe(false);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
});

test("compilePluginForTarget can start Hermes HTTP MCP before config write", async () => {
  const port = await getFreePort("127.0.0.1");
  const tokenEnv = "PRISM_MCP_COMPILE_SERVE_TOKEN";
  const { pluginRoot, hermesRoot } = await createHermesHttpToolPlugin({
    pluginName: "hermes-http-serve-demo",
    tokenEnv,
    port,
  });

  await withEnv(tokenEnv, compileTestToken, async () => {
    try {
      const result = await Effect.runPromise(
        compilePluginForTarget({
          pluginPath: pluginRoot,
          target: "hermes",
          scope: "global",
          root: hermesRoot,
          dryRun: false,
          mcpLifecycle: "serve",
        }),
      );

      expect(result.outputRoot).toBe(hermesRoot);
      expect(await pathExists(join(hermesRoot, "config.yaml"))).toBe(true);
      expect(
        await pathExists(
          join(hermesRoot, "prism", "mcp", "prism_generated_hermes_http_serve_demo", "runtime.json"),
        ),
      ).toBe(true);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
});

test("compilePluginForTarget leaves Hermes stdio MCP fallback ungated", async () => {
  const { pluginRoot, hermesRoot } = await createHermesHttpToolPlugin({
    pluginName: "hermes-stdio-gate-demo",
    transport: "stdio",
  });

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "hermes",
      scope: "global",
      root: hermesRoot,
      dryRun: false,
    }),
  );

  expect(result.outputRoot).toBe(hermesRoot);
  const config = await readFile(join(hermesRoot, "config.yaml"), "utf8");
  expect(config).toContain("prism-generated-hermes-stdio-gate-demo:");
  expect(config).toContain("command:");
  expect(config).not.toContain("url:");
});

test("compilePluginForTarget rejects non-loopback Hermes Streamable HTTP hosts", async () => {
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
              tokenEnv: "PRISM_MCP_TOKEN",
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
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo through Hermes Streamable HTTP MCP.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );

  await expect(
    Effect.runPromise(
      compilePluginForTarget({
        pluginPath: pluginRoot,
        target: "hermes",
        scope: "global",
        dryRun: true,
      }),
    ),
  ).rejects.toThrow("loopback host");
});

test("compilePluginForTarget rejects Hermes agents and hooks at the capability boundary", async () => {
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
    `import { defineAgent } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "worker",
  description: "Hermes worker",
  identity: "worker",
});
`,
  );

  const agentExit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: agentPluginRoot,
      target: "hermes",
      scope: "global",
      dryRun: true,
    }),
  );

  const agentFailure = getFailure(agentExit);
  expect(agentFailure._tag).toBe("UnsupportedTargetCapabilityError");
  if (agentFailure._tag === "UnsupportedTargetCapabilityError") {
    expect(agentFailure.capability).toBe("compiled-agents");
    expect(agentFailure.message).toContain("does not support compiled Prism agents");
  }

  await writeText(
    join(hookPluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "hermes-hook-demo",
        version: "0.1.0",
        targets: {
          hooks: ["hermes"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(hookPluginRoot, "hooks", "session-start.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "session-start",
  event: hookEvent.sessionStart,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`,
  );

  const hookExit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: hookPluginRoot,
      target: "hermes",
      scope: "global",
      dryRun: true,
    }),
  );

  const hookFailure = getFailure(hookExit);
  expect(hookFailure._tag).toBe("UnsupportedTargetCapabilityError");
  if (hookFailure._tag === "UnsupportedTargetCapabilityError") {
    expect(hookFailure.capability).toBe("hooks");
    expect(hookFailure.message).toContain("does not support Prism hook lowering");
  }
});

test("opencode trait skill access lowers to permission without becoming a dependency", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "skill-access-demo",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          skills: ["opencode"],
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

Use only the skills that fit the work.
`,
  );
  await writeText(
    join(pluginRoot, "traits", "marketing-enabled.trait.ts"),
    `import { defineTrait, skillspaceRef } from "prism";

export default defineTrait({
  name: "marketing-enabled",
  description: "Can use marketing skills",
  access: {
    skills: [
      skillspaceRef("external-skills", "copy-engineering"),
      skillspaceRef("external-skills", "marketing"),
    ],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "prism";

export default defineSkillspace({
  name: "external-skills",
  description: "Harness-native skills this plugin does not own",
  skills: {
    "copy-engineering": {
      targets: {
        opencode: { name: "copy-engineering-opencode" },
      },
    },
    marketing: {
      targets: {
        opencode: { name: "marketing-opencode" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skills", "contracts", "SKILL.md"),
    `---
name: contracts
description: Contract guidance
---

# Contracts

Lock down interfaces before implementation.
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent, skillRef } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker with skill permissions",
  identity: "worker",
  traits: ["marketing-enabled"],
  skills: [skillRef("contracts")],
});
`,
  );

  const firstCompile = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(firstCompile.built).toEqual(["worker"]);
  expect(firstCompile.fromCache).toEqual([]);

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "worker.md"),
    "utf8",
  );
  const frontmatter = matter(opencodeAgent).data as {
    permission?: { skill?: Record<string, string> };
  };

  expect(opencodeAgent).toContain("## Recommended Skills");
  expect(opencodeAgent).toContain("- `contracts`");
  expect(opencodeAgent).not.toContain("- `copy-engineering-opencode`");
  expect(opencodeAgent).not.toContain("- `marketing-opencode`");
  expect(frontmatter.permission?.skill).toEqual({
    "*": "deny",
    "contracts": "allow",
    "copy-engineering-opencode": "allow",
    "marketing-opencode": "allow",
  });

  const lockfile = await readLockfile(pluginRoot);
  expect(lockfile?.entries[0]?.sources.map((source) => source.path).sort()).toContain(
    "skills/contracts/SKILL.md",
  );
  expect(lockfile?.entries[0]?.sources.map((source) => source.path).sort()).toContain(
    "skillspaces/external-skills.skillspace.ts",
  );
  const cacheDir = join(pluginRoot, "dist", ".prism-cache");
  const cacheAfterFirstCompile = await readDirectoryTextFiles(cacheDir);
  const lockfileAfterFirstCompile = await readFile(
    join(pluginRoot, "prism.lock"),
    "utf8",
  );
  expect(Object.keys(cacheAfterFirstCompile)).toHaveLength(1);

  const warmCompile = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(warmCompile.built).toEqual([]);
  expect(warmCompile.fromCache).toEqual(["worker"]);
  expect(await readDirectoryTextFiles(cacheDir)).toEqual(cacheAfterFirstCompile);
  expect(await readFile(join(pluginRoot, "prism.lock"), "utf8")).toBe(
    lockfileAfterFirstCompile,
  );

  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "prism";

export default defineSkillspace({
  name: "external-skills",
  description: "Harness-native skills this plugin does not own",
  skills: {
    "copy-engineering": {
      targets: {
        opencode: { name: "copywriting-opencode" },
      },
    },
    marketing: {
      targets: {
        opencode: { name: "marketing-opencode" },
      },
    },
  },
});
`,
  );

  const skillspaceChangedCompile = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(skillspaceChangedCompile.built).toEqual(["worker"]);
  expect(skillspaceChangedCompile.fromCache).toEqual([]);
});

test("trait skill requirements compare resolved concrete skills", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "skill-requirement-demo",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          skills: ["opencode"],
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
    join(pluginRoot, "traits", "needs-testing.trait.ts"),
    `import { defineTrait, skillspaceRef } from "prism";

export default defineTrait({
  name: "needs-testing",
  description: "Requires testing skill permission",
  require: {
    skills: [skillspaceRef("core-skills", "testing")],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "core-skills.skillspace.ts"),
    `import { defineSkillspace } from "prism";

export default defineSkillspace({
  name: "core-skills",
  skills: {
    testing: {
      targets: {
        opencode: { name: "testing" },
      },
    },
  },
});
`,
  );
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
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent, skillRef } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker with concrete skill dependency",
  identity: "worker",
  traits: ["needs-testing"],
  skills: [skillRef("testing")],
});
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.composed[0]?.skills).toEqual(["testing"]);
  expect(result.composed[0]?.allowedSkills).toEqual(["testing"]);
});

test("plain skill strings fail closed in agent and trait source fields", async () => {
  const cases: ReadonlyArray<{
    label: string;
    expectedKind: "agent" | "trait";
    expectedMessage?: string;
    agentSource?: string;
    traitSource?: string;
  }> = [
    {
      label: "agent.skills",
      expectedKind: "agent",
      agentSource: `import { defineAgent } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  skills: ["testing"],
});
`,
    },
    {
      label: "agent.access.skills",
      expectedKind: "agent",
      agentSource: `import { defineAgent } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  access: {
    skills: ["testing"],
  },
});
`,
    },
    {
      label: "trait.access.skills",
      expectedKind: "trait",
      expectedMessage:
        "access.skills[0]: plain skill strings are not allowed; use skillRef(...) for managed plugin skills or skillspaceRef(...) for harness-native skills",
      traitSource: `import { defineTrait } from "prism";

export default defineTrait({
  name: "skillful",
  description: "Skill access",
  access: {
    skills: ["testing"],
  },
});
`,
    },
    {
      label: "trait.inject.skills",
      expectedKind: "trait",
      expectedMessage:
        "inject.skills[0]: plain skill strings are not allowed; use skillRef(...) for managed plugin skills or skillspaceRef(...) for harness-native skills",
      traitSource: `import { defineTrait } from "prism";

export default defineTrait({
  name: "skillful",
  description: "Skill injection",
  inject: {
    skills: ["testing"],
  },
});
`,
    },
    {
      label: "trait.require.skills",
      expectedKind: "trait",
      expectedMessage:
        "require.skills[0]: plain skill strings are not allowed; use skillRef(...) for managed plugin skills or skillspaceRef(...) for harness-native skills",
      traitSource: `import { defineTrait } from "prism";

export default defineTrait({
  name: "skillful",
  description: "Skill requirement",
  require: {
    skills: ["testing"],
  },
});
`,
    },
  ];

  for (const item of cases) {
    const root = await createTempRoot();
    const pluginRoot = join(root, item.label.replaceAll(".", "-"));
    const projectRoot = join(root, "project");
    await mkdir(projectRoot, { recursive: true });

    await writeText(
      join(pluginRoot, "plugin.json"),
      `${JSON.stringify(
        {
          name: `plain-${item.label.replaceAll(".", "-")}`,
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
    if (item.traitSource) {
      await writeText(join(pluginRoot, "traits", "skillful.trait.ts"), item.traitSource);
    }
    await writeText(
      join(pluginRoot, "agents", "worker.agent.ts"),
      item.agentSource ??
        `import { defineAgent } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["skillful"],
});
`,
    );

    const exit = await Effect.runPromiseExit(
      compilePluginForTarget({
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
      expect(failure.kind).toBe(item.expectedKind);
      if (item.expectedMessage) {
        expect(failure.message).toBe(item.expectedMessage);
      } else {
        expect(failure.message).toContain("plain skill strings are not allowed");
      }
    }
  }
});

test("trait parser rejects empty canonical tool refs with exact diagnostic", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "empty-trait-tool-ref");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "empty-trait-tool-ref",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  const traitPath = join(pluginRoot, "traits", "reviewable.trait.ts");
  await writeText(
    traitPath,
    `import { defineTrait } from "prism";

export default defineTrait({
  name: "reviewable",
  description: "Review capability",
  tools: {
    submit_review: { ref: "   " },
  },
});
`,
  );

  const exit = await Effect.runPromiseExit(loadPlugin(pluginRoot));

  const failure = getFailure(exit);
  expect(failure._tag).toBe("SourceParseError");
  if (failure._tag === "SourceParseError") {
    expect(failure.kind).toBe("trait");
    expect(failure.sourcePath).toBe(traitPath);
    expect(failure.message).toBe(
      "tools.submit_review.ref: must be a non-empty canonical tool reference",
    );
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
    `import { defineAgent, skillRef } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  skills: [skillRef("contracts")],
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
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

test("toolspace refs require a target mapping for the compile harness", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "toolspace-target-demo",
        version: "0.1.0",
        targets: {
          agents: ["claude-code"],
          toolspaces: ["claude-code"],
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
    join(pluginRoot, "toolspaces", "workspace.toolspace.ts"),
    `import { defineToolspace } from "prism";

export default defineToolspace({
  name: "workspace",
  tools: {
    read: {
      targets: {
        opencode: { name: "read" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent, toolRef } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  access: {
    tools: [toolRef("workspace", "read")],
  },
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "claude-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("MissingTargetResolutionError");
  if (failure._tag === "MissingTargetResolutionError") {
    expect(failure.referenceKind).toBe("tool");
    expect(failure.referenceName).toBe("workspace/read");
    expect(failure.target).toBe("claude-code");
  }
});

test("opencode skillspace target names must be valid permission keys", async () => {
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
    join(pluginRoot, "traits", "external.trait.ts"),
    `import { defineTrait, skillspaceRef } from "prism";

export default defineTrait({
  name: "external",
  description: "Uses an external skill",
  access: {
    skills: [skillspaceRef("external-skills", "copy-engineering")],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "prism";

export default defineSkillspace({
  name: "external-skills",
  skills: {
    "copy-engineering": {
      targets: {
        opencode: { name: "Copy_Engineering" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["external"],
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
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

test("permission-only skill access lowers into Antigravity agent skill frontmatter", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "unsupported-skill-permission-demo",
        version: "0.1.0",
        targets: {
          agents: ["antigravity-cli"],
          skillspaces: ["antigravity-cli"],
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
    join(pluginRoot, "traits", "external.trait.ts"),
    `import { defineTrait, skillspaceRef } from "prism";

export default defineTrait({
  name: "external",
  description: "Uses an external skill",
  access: {
    skills: [skillspaceRef("external-skills", "testing")],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "prism";

export default defineSkillspace({
  name: "external-skills",
  skills: {
    testing: {
      targets: {
        "antigravity-cli": { name: "testing" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["external"],
});
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "antigravity-cli",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const agentMarkdown = await readFile(
    join(projectRoot, ".agents", "plugins", "prism-generated-unsupported-skill-permission-demo", "agents", "worker.md"),
    "utf8",
  );
  expect(agentMarkdown).toContain("skills:");
  expect(agentMarkdown).toContain('- "testing"');
});

test("permission-only skill access fails closed for Factory Droid droids", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "factory-skill-permission-demo",
        version: "0.1.0",
        targets: {
          agents: ["factory-droid"],
          skillspaces: ["factory-droid"],
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
    join(pluginRoot, "traits", "external.trait.ts"),
    `import { defineTrait, skillspaceRef } from "prism";

export default defineTrait({
  name: "external",
  description: "Uses an external skill",
  access: {
    skills: [skillspaceRef("external-skills", "testing")],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "prism";

export default defineSkillspace({
  name: "external-skills",
  skills: {
    testing: {
      targets: {
        "factory-droid": { name: "testing" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["external"],
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "factory-droid",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("UnsupportedTargetCapabilityError");
  if (failure._tag === "UnsupportedTargetCapabilityError") {
    expect(failure.capability).toBe("skill-permissions");
    expect(failure.message).toContain("permission-only skills");
  }
});

test("trait-orbit example lowers assigned traits and orbit skill into opencode permissions", async () => {
  const projectRoot = await createTempRoot();
  const pluginRoot = join(process.cwd(), "examples", "trait-orbit-contracts");

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
    }),
  );

  const expectedSkillAccess = {
    builder: [
      "ast-grep",
      "backpressure",
      "build",
      "code-reviewer",
      "commit",
      "contracts",
      "ddd",
      "delivery-contract",
      "effect",
      "evolve",
      "forge",
      "harness-programming",
      "repo-research",
      "requirements",
      "review",
      "security-reviewer",
      "semgrep-usage",
      "testing",
      "type-level",
      "unslop",
    ],
    reviewer: [
      "ast-grep",
      "backpressure",
      "build",
      "code-reviewer",
      "commit",
      "contracts",
      "delivery-contract",
      "evolve",
      "forge",
      "harness-programming",
      "model-intelligence",
      "repo-research",
      "requirements",
      "research",
      "review",
      "security-reviewer",
      "semgrep-usage",
      "testing",
      "unslop",
      "video-research",
      "web-research",
    ],
    "security-reviewer": [
      "ast-grep",
      "backpressure",
      "build",
      "code-reviewer",
      "commit",
      "contracts",
      "ddd",
      "effect",
      "evolve",
      "forge",
      "harness-programming",
      "repo-research",
      "requirements",
      "review",
      "security-reviewer",
      "semgrep-usage",
      "testing",
      "type-level",
      "unslop",
    ],
  } as const;

  for (const [agentName, expectedSkills] of Object.entries(expectedSkillAccess)) {
    const agent = result.composed.find((candidate) => candidate.name === agentName);
    expect(agent?.skills).toEqual([]);
    expect(agent?.allowedSkills).toEqual(expectedSkills);

    const markdown = result.operations.find(
      (operation) =>
        operation.kind === "write-md" && operation.target.endsWith(`agents/${agentName}.md`),
    );
    if (!markdown || markdown.kind !== "write-md") {
      throw new Error(`expected ${agentName} markdown operation`);
    }
    const frontmatter = matter(markdown.content).data as {
      permission?: { skill?: Record<string, string> };
    };

    expect(markdown.content).not.toContain("## Recommended Skills");
    expect(frontmatter.permission?.skill).toEqual(
      Object.fromEntries([
        ["*", "deny"],
        ...expectedSkills.map((skill) => [skill, "allow"] as const),
      ]),
    );
    expect(expectedSkills).not.toContain("marketing");
    expect(expectedSkills).not.toContain("media-generation");
  }
});

test("domain skill permission traits compile one opencode agent per family", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  const agentCoreRoot = join(
    process.cwd(),
    "examples",
    "trait-orbit-contracts",
    "deps",
    "agent-core",
  );
  const traitFamilies = [
    {
      agent: "engineer",
      trait: "core-engineering",
      expected: [
        "ast-grep",
        "build",
        "code-reviewer",
        "contracts",
        "harness-programming",
        "repo-research",
        "security-reviewer",
        "semgrep-usage",
        "testing",
        "unslop",
      ],
    },
    {
      agent: "functional-programmer",
      trait: "functional-thinking",
      expected: ["contracts", "ddd", "effect", "testing", "type-level"],
    },
    {
      agent: "marketer",
      trait: "core-marketing",
      expected: [
        "brand-positioning",
        "copy-engineering",
        "marketing",
        "offer-architecture",
        "persuasion-architecture",
        "subscription-wedge",
      ],
    },
    {
      agent: "writer",
      trait: "writing-and-publishing",
      expected: [
        "content-mining",
        "copy-engineering",
        "platform-twitter",
        "scribe",
        "typefully-cli",
        "voice-profile",
      ],
    },
    {
      agent: "researcher",
      trait: "research-practice",
      expected: [
        "model-intelligence",
        "repo-research",
        "research",
        "video-research",
        "web-research",
      ],
    },
    {
      agent: "frontend-builder",
      trait: "frontend-implementation",
      expected: [
        "build",
        "frontend-design",
        "legend-state",
        "testing",
        "vercel-react-native-skills",
      ],
    },
    {
      agent: "media-producer",
      trait: "media-generation-practice",
      expected: [
        "fal-models",
        "media-generation",
        "mg-3d-workflow-authoring",
        "mg-schema",
        "mg-workflow-authoring",
        "suno-music-prompting",
        "video-research",
      ],
    },
  ] as const;

  await mkdir(projectRoot, { recursive: true });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "domain-skill-trait-consumer",
        version: "0.1.0",
        deps: {
          "agent-core": agentCoreRoot,
        },
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
description: Domain worker identity
---

# Worker
`,
  );

  for (const family of traitFamilies) {
    await writeText(
      join(pluginRoot, "agents", `${family.agent}.agent.ts`),
      `import { bindTrait, defineAgent } from "prism";

export default defineAgent({
  name: ${JSON.stringify(family.agent)},
  description: ${JSON.stringify(`Uses ${family.trait} skill permissions`)},
  identity: "worker",
  traits: [bindTrait(${JSON.stringify(`agent-core:${family.trait}`)})],
});
`,
    );
  }

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
    }),
  );

  for (const family of traitFamilies) {
    const agent = result.composed.find((candidate) => candidate.name === family.agent);
    expect(agent?.skills).toEqual([]);
    expect(agent?.allowedSkills).toEqual(family.expected);

    const markdown = result.operations.find(
      (operation) =>
        operation.kind === "write-md" &&
        operation.target.endsWith(`agents/${family.agent}.md`),
    );
    if (!markdown || markdown.kind !== "write-md") {
      throw new Error(`expected ${family.agent} markdown operation`);
    }

    const frontmatter = matter(markdown.content).data as {
      permission?: { skill?: Record<string, string> };
    };
    expect(markdown.content).not.toContain("## Recommended Skills");
    expect(frontmatter.permission?.skill?.["*"]).toBe("deny");
    expect(Object.keys(frontmatter.permission?.skill ?? {}).sort()).toEqual([
      "*",
      ...family.expected,
    ].sort());
  }
});

test("opencode skill audit harness verifies visibility, direct deps, and missing refs", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "skill-audit-demo",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          skills: ["opencode"],
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
    join(pluginRoot, "traits", "testing-enabled.trait.ts"),
    `import { defineTrait, skillspaceRef } from "prism";

export default defineTrait({
  name: "testing-enabled",
  description: "Can use test methodology",
  access: {
    skills: [skillspaceRef("external-skills", "testing")],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "prism";

export default defineSkillspace({
  name: "external-skills",
  skills: {
    testing: {
      targets: {
        opencode: { name: "testing" },
      },
    },
  },
});
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
    `import { defineAgent, skillRef } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker with direct and permission-only skills",
  identity: "worker",
  traits: ["testing-enabled"],
  skills: [skillRef("contracts")],
});
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
    }),
  );
  const worker = result.composed.find((agent) => agent.name === "worker");
  expect(worker?.skills).toEqual(["contracts"]);
  expect(worker?.allowedSkills).toEqual(["contracts", "testing"]);

  const markdown = result.operations.find(
    (operation) =>
      operation.kind === "write-md" && operation.target.endsWith("agents/worker.md"),
  );
  if (!markdown || markdown.kind !== "write-md") {
    throw new Error("expected worker markdown operation");
  }

  const permissions = parseOpencodeSkillPermissions(markdown.content);
  expect(permissions).toEqual({
    "*": "deny",
    contracts: "allow",
    testing: "allow",
  });
  expect(
    visibleSkillsForPermission(["contracts", "marketing", "testing"], permissions),
  ).toEqual(["contracts", "testing"]);
  expect(markdown.content).toContain("## Recommended Skills");
  expect(markdown.content).toContain("- `contracts`");
  expect(markdown.content).not.toContain("- `testing`");

  const missingRoot = await createTempRoot();
  const missingPluginRoot = join(missingRoot, "plugin");
  const missingProjectRoot = join(missingRoot, "project");
  await mkdir(missingProjectRoot, { recursive: true });
  await writeText(
    join(missingPluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "missing-skill-audit-demo",
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
    join(missingPluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(
    join(missingPluginRoot, "traits", "testing-enabled.trait.ts"),
    `import { defineTrait, skillspaceRef } from "prism";

export default defineTrait({
  name: "testing-enabled",
  description: "References a missing method skill",
  access: {
    skills: [skillspaceRef("external-skills", "missing-method")],
  },
});
`,
  );
  await writeText(
    join(missingPluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "prism";

export default defineSkillspace({
  name: "external-skills",
  skills: {
    testing: {
      targets: {
        opencode: { name: "testing" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(missingPluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from "prism";

export default defineAgent({
  name: "worker",
  description: "Worker with a missing skill permission",
  identity: "worker",
  traits: ["testing-enabled"],
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: missingPluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: missingProjectRoot,
      dryRun: true,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("UnknownReferenceError");
  if (failure._tag === "UnknownReferenceError") {
    expect(failure.field).toBe("skill");
    expect(failure.referenceName).toBe("external-skills/missing-method");
  }
});

test("external permission-only consumers do not emit empty generated plugin shells", async () => {
  const { pluginRoot, projectRoot } = await createExternalPermissionOnlyFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const consumerGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-permission-only-consumer",
  );
  const protocolGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-protocol-core",
  );

  expect(await pathExists(join(consumerGeneratedRoot, "package.json"))).toBe(false);
  expect(await pathExists(join(protocolGeneratedRoot, "package.json"))).toBe(false);
  expect(await pathExists(join(protocolGeneratedRoot, "dist", "server.mjs"))).toBe(true);
  expect(await pathExists(join(protocolGeneratedRoot, "src", "server.ts"))).toBe(false);
  const protocolBundle = await readFile(join(protocolGeneratedRoot, "dist", "server.mjs"), "utf8");
  expect(protocolBundle).toContain("protocol_core_external_submit");
  expect(protocolBundle).toContain("protocol_core_unreferenced");
  expect(protocolBundle).toContain("shared");

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "worker.md"),
    "utf8",
  );
  expect(opencodeAgent).toContain("permission:");
  expect(opencodeAgent).toContain("  skill:");
  expect(opencodeAgent).toContain('    "*": deny');
  expect(opencodeAgent).toContain("protocol_core_external_submit: allow");
  expect(opencodeAgent).toContain("protocol_core_unreferenced: deny");

  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as { permission?: Record<string, string>; plugin?: string[] };
  expect(opencodeConfig.permission).toMatchObject({
    "protocol_core_*": "deny",
  });
  expect(opencodeConfig.permission).not.toHaveProperty("permission_only_consumer_*");
  expect(opencodeConfig.plugin).toEqual([
    generatedPluginEntry(projectRoot, "prism-generated-stale-dep"),
    generatedPluginEntry(projectRoot, "prism-generated-protocol-core"),
  ]);
  expect(opencodeConfig.plugin).not.toContain("prism-generated-stale-dep");
  expect(opencodeConfig.plugin).not.toContain(
    generatedStaleSourcePluginEntry(projectRoot, "prism-generated-stale-dep"),
  );
  expect(opencodeConfig.plugin).not.toContain(
    "prism-generated-permission-only-consumer",
  );
  expect(opencodeConfig.plugin).not.toContain(
    generatedPluginEntry(
      projectRoot,
      "prism-generated-permission-only-consumer",
    ),
  );
});

test("opencode tools-only plugins bundle runtime helper imports from declared deps", async () => {
  const { pluginRoot, projectRoot } = await createToolsOnlyRuntimeDepImportFixture();

  await Effect.runPromise(
    compilePluginForTarget({
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

test("tools-only plugins emit the complete owner runtime plugin", async () => {
  const { protocolRoot, projectRoot } = await createExternalPermissionOnlyFixture();

  await Effect.runPromise(
    compilePluginForTarget({
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
  expect(opencodeConfig.permission).toMatchObject({
    "protocol_core_*": "deny",
  });
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(projectRoot, "prism-generated-protocol-core"),
  );
  expect(opencodeConfig.plugin).not.toContain("prism-generated-protocol-core");
});

test("external synthetic wrappers keep the owner runtime dependency without exposing the base tool", async () => {
  const { pluginRoot, projectRoot } = await createExternalSyntheticOnlyFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const consumerGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-external-synthetic-consumer",
  );
  const protocolGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-protocol-core",
  );

  expect(await pathExists(join(consumerGeneratedRoot, "package.json"))).toBe(false);
  expect(await pathExists(join(protocolGeneratedRoot, "package.json"))).toBe(false);
  expect(
    await pathExists(
      join(
        protocolGeneratedRoot,
        "dist",
        "server.mjs",
      ),
    ),
  ).toBe(true);
  expect(
    await pathExists(
      join(
        consumerGeneratedRoot,
        "src",
        "server.ts",
      ),
    ),
  ).toBe(false);

  const consumerServer = await readFile(join(consumerGeneratedRoot, "dist", "server.mjs"), "utf8");
  expect(consumerServer).toContain(
    "external_synthetic_consumer_submit_work__worker_details",
  );
  const protocolServer = await readFile(join(protocolGeneratedRoot, "dist", "server.mjs"), "utf8");
  expect(protocolServer).toContain("protocol_core_external_submit");

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "worker.md"),
    "utf8",
  );
  expect(opencodeAgent).toContain(
    "external_synthetic_consumer_submit_work__worker_details: allow",
  );
  expect(opencodeAgent).toContain("protocol_core_external_submit: deny");

  expect(consumerServer).toContain("submit_work__worker_details");
  expect(consumerServer).not.toContain("prism-generated-protocol-core/src/plugins/protocol-core/tools/external-submit.tool");

  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as { permission?: Record<string, string>; plugin?: string[] };
  expect(opencodeConfig.permission).toMatchObject({
    "external_synthetic_consumer_*": "deny",
    "protocol_core_*": "deny",
  });
  expect(opencodeConfig.plugin).toEqual([
    generatedPluginEntry(
      projectRoot,
      "prism-generated-external-synthetic-consumer",
    ),
    generatedPluginEntry(projectRoot, "prism-generated-protocol-core"),
  ]);
});

test("compilePluginForTarget lowers canonical tool bindings into a Claude plugin bundle", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const claude = await Effect.runPromise(
    compilePluginForTarget({
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
    "plugins",
    "prism-generated-canonical-compile-fixture",
  );
  const claudeAgent = await readFile(join(pluginRootPath, "agents", "builder.md"), "utf8");
  expect(claudeAgent).toContain('description: "Builder agent for canonical compile integration tests"');
  expect(claudeAgent).toContain('model: "sonnet"');
  expect(claudeAgent).toContain("protocol_core_external_submit");

  const mcpConfig = await readFile(join(pluginRootPath, ".mcp.json"), "utf8");
  expect(mcpConfig).toContain('"prism-generated-canonical-compile-fixture"');
  expect(mcpConfig).toContain('"command": "bun"');
  expect(mcpConfig).toContain(
    '"${CLAUDE_PLUGIN_ROOT}/mcp/prism_generated_canonical_compile_fixture/server.mjs"',
  );
  expect(
    await pathExists(
      join(pluginRootPath, "mcp", "prism_generated_canonical_compile_fixture", "server.mjs"),
    ),
  ).toBe(true);
  expect(await pathExists(join(projectRoot, ".claude", "agents", "builder.md"))).toBe(false);
});

test("compilePluginForTarget lowers Grok plugin-bundle surfaces", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "grok-pipeline-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "grok-pipeline-demo",
        version: "0.1.0",
        targets: {
          agents: ["grok"],
          skills: ["grok"],
          tools: ["grok"],
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
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    `---
name: testing
description: Testing guidance
---

# Testing
`,
  );
  await writeText(
    join(pluginRoot, "tools", "submit-work.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "submit-work",
  description: "Submit completed Grok work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input) {
    return { acknowledged: true };
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit completed work through the generated Grok MCP tool.",
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent, skillRef } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "worker",
  description: "Grok worker",
  identity: "worker",
  traits: ["submittable"],
  skills: [skillRef("testing")],
  targets: {
    grok: {
      model: "grok-build",
      tools: ["read_file"],
      disallowedTools: ["web_fetch"],
    },
  },
});
`,
  );

  const grok = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "grok",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(grok.outputRoot).toBe(join(projectRoot, ".grok/"));
  const pluginRootPath = join(
    projectRoot,
    ".grok",
    "plugins",
    "prism-generated-grok-pipeline-demo",
  );
  const agent = await readFile(join(pluginRootPath, "agents", "worker.md"), "utf8");
  expect(agent).toContain('description: "Grok worker"');
  expect(agent).toContain('model: "grok-build"');
  expect(agent).toContain('- "read_file"');
  expect(agent).toContain('disallowedTools:\n  - "web_fetch"');
  expect(agent).toContain('skills:\n  - "testing"');
  expect(await pathExists(join(pluginRootPath, "skills", "testing", "SKILL.md"))).toBe(true);
  const mcpConfig = await readFile(join(pluginRootPath, ".mcp.json"), "utf8");
  expect(mcpConfig).toContain('"prism-generated-grok-pipeline-demo"');
  expect(mcpConfig).toContain(
    join(
      pluginRootPath,
      "mcp",
      "prism_generated_grok_pipeline_demo",
      "server.mjs",
    ),
  );
  const mcpServer = await readFile(
    join(pluginRootPath, "mcp", "prism_generated_grok_pipeline_demo", "server.mjs"),
    "utf8",
  );
  expect(mcpServer).toContain("grok_pipeline_demo_submit_work");
  expect(await pathExists(join(projectRoot, ".grok", "agents", "worker.md"))).toBe(false);
});

test("compilePluginForTarget lowers Factory Droid plugin-bundle surfaces", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "factory-pipeline-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "factory-pipeline-demo",
        version: "0.1.0",
        targets: {
          agents: ["factory-droid"],
          skills: ["factory-droid"],
          tools: ["factory-droid"],
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
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    `---
name: testing
description: Testing guidance
---

# Testing
`,
  );
  await writeText(
    join(pluginRoot, "tools", "submit-work.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "submit-work",
  description: "Submit completed Factory work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input) {
    return { acknowledged: true };
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit completed work through the generated Factory MCP tool.",
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent, skillRef } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "worker",
  description: "Factory worker",
  identity: "worker",
  traits: ["submittable"],
  skills: [skillRef("testing")],
  targets: {
    "factory-droid": {
      model: "inherit",
      tools: ["Read"],
    },
  },
});
`,
  );

  const factory = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "factory-droid",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(factory.outputRoot).toBe(join(projectRoot, ".factory/"));
  const pluginRootPath = join(
    projectRoot,
    ".factory",
    "plugins",
    "prism-generated-factory-pipeline-demo",
  );
  expect(await pathExists(join(pluginRootPath, ".factory-plugin", "plugin.json"))).toBe(true);
  const droid = await readFile(join(pluginRootPath, "droids", "worker.md"), "utf8");
  expect(droid).toContain('description: "Factory worker"');
  expect(droid).toContain('model: "inherit"');
  expect(droid).toContain('- "Read"');
  expect(droid).toContain(
    '- "mcp__prism-generated-factory-pipeline-demo__factory_pipeline_demo_submit_work"',
  );
  expect(droid).not.toContain("skills:");
  expect(await pathExists(join(pluginRootPath, "skills", "testing", "SKILL.md"))).toBe(true);
  const mcpConfig = await readFile(join(pluginRootPath, "mcp.json"), "utf8");
  expect(mcpConfig).toContain('"prism-generated-factory-pipeline-demo"');
  expect(mcpConfig).toContain(
    '"${DROID_PLUGIN_ROOT}/mcp/prism_generated_factory_pipeline_demo/server.mjs"',
  );
  const mcpServer = await readFile(
    join(pluginRootPath, "mcp", "prism_generated_factory_pipeline_demo", "server.mjs"),
    "utf8",
  );
  expect(mcpServer).toContain("factory_pipeline_demo_submit_work");
  expect(await pathExists(join(projectRoot, ".factory", "droids", "worker.md"))).toBe(false);
});

test("compilePluginForTarget gates Factory HTTP MCP for agent-bound dependency tools", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "factory-http-agent-demo");
  const coreRoot = join(root, "factory-tool-core");
  const factoryRoot = join(root, "factory-root");
  const mcpRoot = join(root, "mcp-root");
  const port = await getFreePort("127.0.0.1");

  await writeText(
    join(coreRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "factory-tool-core",
        version: "0.1.0",
        targets: {
          tools: ["factory-droid"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(coreRoot, "tools", "submit-work.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "submit-work",
  description: "Submit completed Factory work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input) {
    return { acknowledged: true };
  },
});
`,
  );
  await writeText(
    join(coreRoot, "traits", "submittable.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "submittable",
  description: "Can submit work",
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
});
`,
  );

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "factory-http-agent-demo",
        version: "0.1.0",
        deps: {
          core: "../factory-tool-core",
        },
        targets: {
          agents: ["factory-droid"],
        },
        runtime: {
          mcp: {
            "factory-droid": {
              transport: "streamable-http",
              host: "127.0.0.1",
              port,
              tokenEnv: "PRISM_MCP_FACTORY_AGENT_TOKEN",
            },
          },
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
    `import { defineAgent } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "worker",
  description: "Factory worker",
  identity: "worker",
  traits: ["core:submittable"],
  targets: {
    "factory-droid": {
      model: "inherit",
    },
  },
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "factory-droid",
      scope: "global",
      root: factoryRoot,
      mcpRoot,
      dryRun: false,
      mcpLifecycle: "none",
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("PluginManifestError");
  if (failure._tag === "PluginManifestError") {
    expect(failure.message).toContain("factory-droid Streamable HTTP MCP daemon");
    expect(failure.message).toContain("refusing to write url config");
  }

  try {
    const compiled = await Effect.runPromise(
      compilePluginForTarget({
        pluginPath: pluginRoot,
        target: "factory-droid",
        scope: "global",
        root: factoryRoot,
        mcpRoot,
        dryRun: false,
        mcpLifecycle: "serve",
      }),
    );
    expect(compiled.operations.some((operation) =>
      operation.kind === "write-plugin-file" &&
      operation.content.includes("factory_tool_core_submit_work")
    )).toBe(true);
  } finally {
    await stopMcp({
      pluginPath: pluginRoot,
      harness: "factory-droid",
      scope: "global",
      root: mcpRoot,
      tokenEnv: "PRISM_MCP_FACTORY_AGENT_TOKEN",
    }).catch(() => undefined);
  }
});

test("compilePluginForTarget prunes stale Factory plugin bundle for template-only orbit targets", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "factory-source-only");
  const projectRoot = join(root, "project");
  const generatedRoot = join(
    projectRoot,
    ".factory",
    "plugins",
    "prism-generated-factory-source-only",
  );
  await mkdir(projectRoot, { recursive: true });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "factory-source-only",
      version: "0.1.0",
      targets: {
        skills: ["factory-droid"],
        orbits: ["factory-droid"],
      },
    })}\n`,
  );
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );
  await writeText(
    join(pluginRoot, "orbits", "template.orbit.ts"),
    `import { defineOrbit } from ${JSON.stringify(prismImportPath)};

export default defineOrbit({
  name: "template",
  description: "Template-only Factory orbit.",
  parameters: [{ name: "topic" }],
  phases: [{ name: "Work on \${topic}" }],
});
`,
  );
  const staleTarget = join(generatedRoot, "droids", "stale.md");
  const staleContent = "---\nname: stale\n---\n";
  await writeText(staleTarget, staleContent);
  const staleEntryId = managedEntryId({
    harness: "factory-droid",
    scope: "project",
    root: join(projectRoot, ".factory"),
    pluginName: "factory-source-only",
    artifact: "compile",
    targetPath: staleTarget,
    kind: "file",
  });
  await writeHarnessLedger({
    ...(await readHarnessLedger("factory-droid")),
    entries: [
      {
        id: staleEntryId,
        pluginName: "factory-source-only",
        pluginVersion: "0.1.0",
        pluginPath: pluginRoot,
        harness: "factory-droid",
        scope: "project",
        root: join(projectRoot, ".factory"),
        artifact: "compile",
        targetPath: staleTarget,
        kind: "file",
        contentHash: computeContentHash(staleContent),
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "factory-droid",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.operations).toContainEqual(
    expect.objectContaining({
      kind: "prune-plugin-path",
      target: generatedRoot,
      targetType: "dir",
    }),
  );
  expect(await directoryExists(generatedRoot)).toBe(false);
  expect((await readHarnessLedger("factory-droid")).entries).toHaveLength(0);
});

test("compilePluginForTarget forgets stale Factory shared MCP runtime when another harness owns it", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "factory-shared-runtime");
  const projectRoot = join(root, "project");
  const mcpRoot = join(root, "mcp-runtime");
  const factoryRoot = join(projectRoot, ".factory");
  const claudeRoot = join(projectRoot, ".claude");
  const targetPath = runtimeMcpServerDescriptor(mcpRoot, "factory-shared-runtime").absolutePath;
  const content = "console.log('shared runtime');\n";
  await mkdir(projectRoot, { recursive: true });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "factory-shared-runtime",
      version: "0.1.0",
      targets: { agents: ["factory-droid"] },
    })}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    "---\ndescription: Factory worker\n---\n\n# Worker\n\nFactory worker.\n",
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "worker",
  description: "Factory worker",
  identity: "worker",
  traits: [],
  targets: {
    "factory-droid": { tools: ["Read"] },
  },
});
`,
  );
  await writeText(targetPath, content);

  const factoryEntryId = managedEntryId({
    harness: "factory-droid",
    scope: "project",
    root: factoryRoot,
    pluginName: "factory-shared-runtime",
    artifact: "compile",
    targetPath,
    kind: "file",
  });
  const claudeEntryId = managedEntryId({
    harness: "claude-code",
    scope: "project",
    root: claudeRoot,
    pluginName: "factory-shared-runtime",
    artifact: "compile",
    targetPath,
    kind: "file",
  });
  const sharedEntry = {
    pluginName: "factory-shared-runtime",
    pluginVersion: "0.1.0",
    pluginPath: pluginRoot,
    scope: "project" as const,
    artifact: "compile",
    targetPath,
    kind: "file" as const,
    contentHash: computeContentHash(content),
    updatedAt: new Date().toISOString(),
  };
  await writeHarnessLedger({
    ...(await readHarnessLedger("factory-droid")),
    entries: [{ ...sharedEntry, id: factoryEntryId, harness: "factory-droid", root: factoryRoot }],
  });
  await writeHarnessLedger({
    ...(await readHarnessLedger("claude-code")),
    entries: [{ ...sharedEntry, id: claudeEntryId, harness: "claude-code", root: claudeRoot }],
  });

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "factory-droid",
      scope: "project",
      projectPath: projectRoot,
      mcpRoot,
      dryRun: false,
    }),
  );

  expect(result.operations).toContainEqual(
    expect.objectContaining({
      kind: "prune-plugin-path",
      target: targetPath,
      targetType: "file",
      shared: true,
    }),
  );
  expect(await readFile(targetPath, "utf8")).toBe(content);
  expect((await readHarnessLedger("factory-droid")).entries.some((entry) => entry.id === factoryEntryId)).toBe(false);
  expect((await readHarnessLedger("claude-code")).entries.some((entry) => entry.id === claudeEntryId)).toBe(true);
});

test("compilePluginForTarget keeps plugin skills out of Factory orbit-only bundles", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "factory-orbit-only");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "factory-orbit-only",
      version: "0.1.0",
      targets: {
        skills: ["factory-droid"],
        orbits: ["factory-droid"],
      },
    })}\n`,
  );
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );
  await writeText(
    join(pluginRoot, "orbits", "delivery.orbit.ts"),
    `import { defineOrbit } from ${JSON.stringify(prismImportPath)};

export default defineOrbit({
  name: "delivery",
  description: "Concrete Factory orbit.",
  phases: [{ name: "Deliver" }],
});
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "factory-droid",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const generatedRoot = join(
    projectRoot,
    ".factory",
    "plugins",
    "prism-generated-factory-orbit-only",
  );
  expect(await pathExists(join(generatedRoot, "skills", "delivery", "SKILL.md"))).toBe(true);
  expect(await pathExists(join(generatedRoot, "skills", "testing", "SKILL.md"))).toBe(false);
});

test("compilePluginForTarget lowers Claude plugin-bundle surfaces when no canonical tool runtime is required", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    withCanonicalToolBindings: false,
  });

  const claude = await Effect.runPromise(
    compilePluginForTarget({
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
    "plugins",
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
  expect(claudeAgent).toContain("tools:");
  expect(claudeAgent).toContain('- "Read"');
  expect(claudeAgent).toContain('- "Grep"');
  expect(claudeAgent).toContain('- "Bash"');
  expect(claudeAgent).toContain("skills:");
  expect(claudeAgent).toContain('- "testing"');
  expect(claudeAgent).toContain("## Trait Instructions");
  expect(claudeAgent).toContain(
    "Commit owned implementation changes only after the submitted work is complete.",
  );
  expect(
    await pathExists(
      join(pluginRootPath, "skills", "delivery-contract", "SKILL.md"),
    ),
  ).toBe(true);
  const deliveryOrbitSkill = await readFile(
    join(pluginRootPath, "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );
  expect(deliveryOrbitSkill).not.toContain("## Orchestrator");
  expect(deliveryOrbitSkill).not.toContain("create_glyph");
  expect(
    await pathExists(
      join(pluginRootPath, "orbits", "delivery-contract.md"),
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
          toolspaces: ["opencode", "claude-code", "antigravity-cli", "codex-cli"],
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
        pluginPath: pluginRoot,
        target,
        scope: "project",
        projectPath: projectRoot,
        dryRun: true,
      }),
    );

    expect(result.composed).toHaveLength(0);
    expect(result.orbits).toHaveLength(0);
    expect(result.operations).toHaveLength(0);
  }
});

test("compilePluginForTarget fails when targeted agents bind tools not targeted for that harness", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "tool-target-leak");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "tool-target-leak",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          tools: ["claude-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---\ndescription: Worker\n---\n\n# Worker\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo input",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  async handle(input) {
    return input;
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "traits", "echoer.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "echoer",
  tools: {
    echo: { ref: "echo" },
  },
  require: { tools: ["echo"] },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["echoer"],
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("AgentValidationError");
  if (failure._tag === "AgentValidationError") {
    expect(failure.field).toBe("tools");
    expect(failure.message).toContain("that plugin's targets.tools does not include 'opencode'");
  }
});

// ---------------------------------------------------------------------------
// Derived orbit skill rendering (AP-022)
// ---------------------------------------------------------------------------

test("derived orbit skill deduplicates traits and renders multi-agent phase sub-sections", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );

  // Multi-agent phase renders each agent as its own sub-section.
  expect(skill).toContain("### 3. Hand off work — agents `builder`, `reviewer`");
  expect(skill).toContain("Multiple agents may fulfil this phase");
  expect(skill).toContain("#### Agent `builder`");
  expect(skill).toContain("#### Agent `reviewer`");

  // Trait protocols section appears once and dedupes shared traits.
  const protocolsHeader = skill.match(/## Trait protocols active in this orbit/g);
  expect(protocolsHeader?.length).toBe(1);
  // self-assessing is shared by builder + reviewer + security-reviewer; render once.
  const selfAssessingHits = skill.match(/### `canonical-compile-fixture:self-assessing`/g);
  expect(selfAssessingHits?.length).toBe(1);
  const submittableHits = skill.match(/### `canonical-compile-fixture:submittable`/g);
  expect(submittableHits?.length).toBe(1);

  // Phase transitions and submission protocol sections are present.
  expect(skill).toContain("## Phase transitions");
  expect(skill).toContain("## Submission protocol per phase agent");
});

test("derived orbit skill deduplicates tools across orchestrator and phase grants", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  // Replace the orbit file with one that grants the SAME tool via the
  // orchestrator AND orbit-wide tool_permissions. The derived skill must
  // not double-render the tool.
  await writeText(
    join(pluginRoot, "orbits", "delivery-contract.orbit.ts"),
    `import { agentRef, defineOrbit, traitRef } from ${JSON.stringify(prismImportPath)};

export default defineOrbit({
  name: "delivery-contract",
  description: "Dedup tool variant",
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [{ all: [traitRef("committable"), traitRef("self-assessing")] }],
    },
    {
      name: "Review change",
      agents: [agentRef("reviewer")],
      requires: [{ all: [traitRef("reviewable"), traitRef("self-assessing")] }],
    },
  ],
  orchestrator: {
    agent: agentRef("builder"),
    tools: [{ ref: "protocol-core:create_glyph", as: "create_glyph_orch" }],
  },
  tool_permissions: [
    { ref: "protocol-core:create_glyph", as: "create_glyph_wide" },
  ],
});
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );

  // Each grant gets its own logical name in its own section, but the canonical
  // tool ref appears in both sections — check both sections are listed.
  expect(skill).toContain("`create_glyph_orch` (canonical `protocol-core:create_glyph`)");
  expect(skill).toContain("`create_glyph_wide` (canonical `protocol-core:create_glyph`)");

  // Wide tool description should appear in the wide section once, not twice.
  const wideMatches = skill.match(/## Tools available to every phase agent/g);
  expect(wideMatches?.length).toBe(1);
});

test("derived orbit skill helper renders parametric stub when invoked on a template", async () => {
  // Direct unit-level invocation of renderDerivedOrbitSkillBody to
  // exercise the parametric branch. We synthesize a minimal Orbit and
  // empty registry so the helper has to fall back gracefully.
  const { renderDerivedOrbitSkillBody } = await import("./derived-orbit-skill.js");
  const { Orbit } = await import("./sources.js");
  const { emptyRegistry } = await import("./registry.js");

  const orbit = new Orbit({
    name: "demo-template",
    sourcePath: "/tmp/demo-template.orbit.ts",
    description: "A parametric template",
    parameters: [{ name: "audience", required: true }],
    phases: [],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });
  const registry = emptyRegistry("/tmp", "demo", "0.0.0");

  const body = renderDerivedOrbitSkillBody(orbit, registry);
  expect(body).toContain("# demo-template");
  expect(body).toContain("This orbit is parameterized");
});

test("derived orbit skill renders orbit definitions", async () => {
  const { renderDerivedOrbitSkillBody } = await import("./derived-orbit-skill.js");
  const { Orbit } = await import("./sources.js");
  const { emptyRegistry } = await import("./registry.js");

  const orbit = new Orbit({
    name: "artifact-demo",
    sourcePath: "/tmp/artifact-demo.orbit.ts",
    description: "A demo orbit",
    definitions: {
      glyphs: {
        purpose: "Glyphs carry the moving work contract.",
        contains: ["Intent, scope, acceptance criteria, and durable notes."],
        boundaries: ["Glyph IDs are routing metadata, not domain vocabulary."],
        avoid: ["Do not turn glyph IDs into source code names."],
      },
      dispatches: {
        purpose: "Dispatches preserve phase outputs and evidence snapshots.",
      },
      chatter: {
        purpose: "Chatter is transient conversation until promoted into a durable artifact.",
      },
      signals: {
        purpose: "Signals are standalone orbit-bound inputs.",
        boundaries: ["Do not use signals as phase handoff packets."],
      },
    },
    parameters: [],
    phases: [],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });
  const registry = emptyRegistry("/tmp", "demo", "0.0.0");

  const body = renderDerivedOrbitSkillBody(orbit, registry);
  expect(body).toContain("## Definitions");
  expect(body).toContain("### Glyphs");
  expect(body).toContain("Glyph IDs are routing metadata, not domain vocabulary.");
  expect(body).toContain("### Dispatches");
  expect(body).toContain("### Chatter");
  expect(body).toContain("### Signals");
});

test("orbit definitions participate in template instantiation", async () => {
  const { instantiateOrbit } = await import("./resolve.js");
  const { Orbit } = await import("./sources.js");

  const orbit = new Orbit({
    name: "artifact-template",
    sourcePath: "/tmp/artifact-template.orbit.ts",
    description: "A ${domain} template",
    definitions: {
      glyphs: {
        purpose: "${domain} glyphs carry the active work contract.",
        contains: ["${domain} intent and acceptance criteria."],
      },
    },
    parameters: [{ name: "domain", required: true }],
    phases: [],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });

  const instantiated = await Effect.runPromise(
    instantiateOrbit(orbit, { domain: "Forge" }),
  );

  expect(instantiated.description).toBe("A Forge template");
  expect(instantiated.definitions?.glyphs?.purpose).toBe(
    "Forge glyphs carry the active work contract.",
  );
  expect(instantiated.definitions?.glyphs?.contains).toEqual([
    "Forge intent and acceptance criteria.",
  ]);
});

test("orbit instantiation reports top-level binding failures before templating", async () => {
  const { instantiateOrbit } = await import("./resolve.js");
  const { Orbit } = await import("./sources.js");

  const orbit = new Orbit({
    name: "binding-template",
    sourcePath: "/tmp/binding-template.orbit.ts",
    description: "${required} template",
    parameters: [
      { name: "required", required: true },
      { name: "second", required: true },
    ],
    phases: [],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });

  const unknownFailure = getFailure(
    await Effect.runPromiseExit(instantiateOrbit(orbit, { extra: "value" })),
  );
  expect(unknownFailure._tag).toBe("OrbitValidationError");
  if (unknownFailure._tag === "OrbitValidationError") {
    expect(unknownFailure.field).toBe("bindings");
    expect(unknownFailure.message).toBe("received unknown binding(s): extra");
  }

  const missingFailure = getFailure(await Effect.runPromiseExit(instantiateOrbit(orbit, {})));
  expect(missingFailure._tag).toBe("OrbitValidationError");
  if (missingFailure._tag === "OrbitValidationError") {
    expect(missingFailure.field).toBe("bindings");
    expect(missingFailure.message).toBe("missing required binding(s): required, second");
  }
});

test("orbit instantiation builds complete concrete orbit shape", async () => {
  const { instantiateOrbit } = await import("./resolve.js");
  const { Orbit } = await import("./sources.js");

  const orbit = new Orbit({
    name: "full-template",
    sourcePath: "/tmp/full-template.orbit.ts",
    description: "A ${domain} orbit",
    produces: "${domain} artifact",
    definitions: {
      glyphs: { purpose: "${domain} glyphs preserve the work contract." },
    },
    parameters: [{ name: "domain", required: true }],
    phases: [
      {
        name: "${domain} build",
        agents: ["builder"],
        requires: [],
        notes: { Done: "${domain} complete" },
        telos: "Build ${domain}.",
      },
    ],
    orchestrator: {
      agent: "builder",
      tools: [{ ref: "submit-work", logicalName: "submit_work" }],
    },
    tool_permissions: [{ ref: "create-glyph", logicalName: "create_glyph" }],
    pulsar_checkpoints: [
      {
        after: "${domain} build",
        before: "${domain} review",
        note: "${domain} checkpoint",
      },
    ],
    evolution: "${domain} backlog",
    body: "# ${domain}\n",
  });

  const instantiated = await Effect.runPromise(
    instantiateOrbit(orbit, { domain: "Forge" }),
  );

  expect(instantiated.name).toBe("full-template");
  expect(instantiated.sourcePath).toBe("/tmp/full-template.orbit.ts");
  expect(instantiated.description).toBe("A Forge orbit");
  expect(instantiated.produces).toBe("Forge artifact");
  expect(instantiated.definitions?.glyphs?.purpose).toBe(
    "Forge glyphs preserve the work contract.",
  );
  expect(instantiated.parameters).toEqual([]);
  expect(instantiated.phases).toEqual([
    {
      name: "Forge build",
      agents: ["builder"],
      requires: [],
      notes: { Done: "Forge complete" },
      telos: "Build Forge.",
    },
  ]);
  expect(instantiated.orchestrator).toEqual(orbit.orchestrator);
  expect(instantiated.orchestrator).not.toBe(orbit.orchestrator);
  expect(instantiated.orchestrator?.tools).not.toBe(orbit.orchestrator?.tools);
  expect(instantiated.tool_permissions).toEqual(orbit.tool_permissions);
  expect(instantiated.tool_permissions).not.toBe(orbit.tool_permissions);
  expect(instantiated.pulsar_checkpoints).toEqual([
    { after: "Forge build", before: "Forge review", note: "Forge checkpoint" },
  ]);
  expect(instantiated.evolution).toBe("Forge backlog");
  expect(instantiated.body).toBe("# Forge\n");
});

test("orbit instantiation preserves top-level failure ordering", async () => {
  const { instantiateOrbit } = await import("./resolve.js");
  const { Orbit } = await import("./sources.js");

  const cases: Array<{
    readonly orbit: Orbit;
    readonly field: string;
  }> = [
    {
      orbit: new Orbit({
        name: "description-missing-template",
        sourcePath: "/tmp/description-missing-template.orbit.ts",
        description: "${missingDescription}",
        parameters: [{ name: "missingDescription", required: false }],
        phases: [],
        tool_permissions: [],
        pulsar_checkpoints: [],
        body: "",
      }),
      field: "description",
    },
    {
      orbit: new Orbit({
        name: "produces-missing-template",
        sourcePath: "/tmp/produces-missing-template.orbit.ts",
        description: "Produces template",
        produces: "${missingProduces}",
        parameters: [{ name: "missingProduces", required: false }],
        phases: [],
        tool_permissions: [],
        pulsar_checkpoints: [],
        body: "",
      }),
      field: "produces",
    },
    {
      orbit: new Orbit({
        name: "definitions-missing-template",
        sourcePath: "/tmp/definitions-missing-template.orbit.ts",
        description: "Definitions template",
        definitions: {
          glyphs: { purpose: "${missingDefinition}" },
        },
        parameters: [{ name: "missingDefinition", required: false }],
        phases: [],
        tool_permissions: [],
        pulsar_checkpoints: [],
        body: "",
      }),
      field: "definitions.glyphs.purpose",
    },
    {
      orbit: new Orbit({
        name: "checkpoint-missing-template",
        sourcePath: "/tmp/checkpoint-missing-template.orbit.ts",
        description: "Checkpoint template",
        parameters: [{ name: "missingCheckpoint", required: false }],
        phases: [],
        tool_permissions: [],
        pulsar_checkpoints: [{ after: "${missingCheckpoint}" }],
        body: "",
      }),
      field: "pulsar_checkpoints[0].after",
    },
    {
      orbit: new Orbit({
        name: "evolution-missing-template",
        sourcePath: "/tmp/evolution-missing-template.orbit.ts",
        description: "Evolution template",
        parameters: [{ name: "missingEvolution", required: false }],
        phases: [],
        tool_permissions: [],
        pulsar_checkpoints: [],
        evolution: "${missingEvolution}",
        body: "",
      }),
      field: "evolution",
    },
    {
      orbit: new Orbit({
        name: "body-missing-template",
        sourcePath: "/tmp/body-missing-template.orbit.ts",
        description: "Body template",
        parameters: [{ name: "missingBody", required: false }],
        phases: [],
        tool_permissions: [],
        pulsar_checkpoints: [],
        body: "${missingBody}",
      }),
      field: "body",
    },
  ];

  for (const current of cases) {
    const failure = getFailure(await Effect.runPromiseExit(instantiateOrbit(current.orbit, {})));

    expect(failure._tag).toBe("OrbitValidationError");
    if (failure._tag === "OrbitValidationError") {
      expect(failure.field).toBe(current.field);
      expect(failure.message).toContain("missing binding");
    }
  }
});

test("derived orbit skill renders per-phase telos, real-world change, and cold-pickup test", async () => {
  const { renderDerivedOrbitSkillBody } = await import("./derived-orbit-skill.js");
  const { Orbit } = await import("./sources.js");
  const { emptyRegistry } = await import("./registry.js");

  const orbit = new Orbit({
    name: "phase-rich",
    sourcePath: "/tmp/phase-rich.orbit.ts",
    description: "Phase-rich orbit demo",
    parameters: [],
    phases: [
      {
        name: "build",
        agents: [],
        requires: [],
        notes: { Input: "One committed glyph.", Done: "Validation clean." },
        telos: "Bring working software into existence inside the bounds of the glyph.",
        real_world_change:
          "Code, tests, and product behavior are durably different and re-verifiable.",
        cold_pickup_test:
          "Could a reviewer judge satisfaction from only the diff and the glyph?",
        body: "## Procrastination shapes\n\n- Moving the glyph forward without changing the codebase.\n",
      },
    ],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });
  const registry = emptyRegistry("/tmp", "phase-rich", "0.0.0");

  const skill = renderDerivedOrbitSkillBody(orbit, registry);
  expect(skill).toContain("- **Telos**: Bring working software into existence");
  expect(skill).toContain("- **Real-world change**: Code, tests, and product behavior");
  expect(skill).toContain("- **Cold-pickup test**: Could a reviewer judge satisfaction");
  expect(skill).toContain("- **Input**: One committed glyph.");
  expect(skill).toContain("- **Reference**: see `references/build.md`");
});

test("derived orbit phase references render only when body is present", async () => {
  const { renderDerivedOrbitPhaseReferences } = await import(
    "./derived-orbit-skill.js"
  );
  const { Orbit } = await import("./sources.js");

  const orbit = new Orbit({
    name: "phase-refs",
    sourcePath: "/tmp/phase-refs.orbit.ts",
    description: "Phase reference demo",
    parameters: [],
    phases: [
      {
        name: "explore",
        agents: [],
        requires: [],
        telos: "Reduce ambiguity and recommend a direction.",
        real_world_change:
          "An option space exists with the alternatives considered and the rationale for the pick.",
        cold_pickup_test:
          "Could another agent pick up the recommendation cold and act?",
        body: "## What good explore produces\n\nA sharper problem statement and a recommendation.\n",
      },
      {
        name: "commit",
        agents: [],
        requires: [],
        // No body — should produce no reference file.
      },
    ],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });

  const refs = renderDerivedOrbitPhaseReferences(orbit);
  expect(refs).toHaveLength(1);
  expect(refs[0]?.filename).toBe("explore.md");
  expect(refs[0]?.content).toContain("# phase-refs:explore");
  expect(refs[0]?.content).toContain("## Telos");
  expect(refs[0]?.content).toContain("Reduce ambiguity");
  expect(refs[0]?.content).toContain("## Real-world change");
  expect(refs[0]?.content).toContain("## Cold-pickup test");
  expect(refs[0]?.content).toContain("## What good explore produces");
});

test("orbit body declared in TS source flows into the generated orbit skill", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const declaredBody = "## The Orbit Principle\n\nForge is a routing utility, not the work.\n";

  await writeText(
    join(pluginRoot, "orbits", "delivery-contract.orbit.ts"),
    `import { agentRef, defineOrbit, traitRef } from ${JSON.stringify(prismImportPath)};

export default defineOrbit({
  name: "delivery-contract",
  description: "Orbit body propagation check",
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [{ all: [traitRef("committable"), traitRef("self-assessing")] }],
    },
  ],
  body: ${JSON.stringify(declaredBody)},
});
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );

  expect(skill).toContain("## The Orbit Principle");
  expect(skill).toContain("Forge is a routing utility, not the work.");
});

test("orbit phase fields participate in template instantiation", async () => {
  const { instantiateOrbit } = await import("./resolve.js");
  const { Orbit } = await import("./sources.js");

  const orbit = new Orbit({
    name: "phase-template",
    sourcePath: "/tmp/phase-template.orbit.ts",
    description: "${domain} phase template",
    parameters: [{ name: "domain", required: true }],
    phases: [
      {
        name: "build",
        agents: [],
        requires: [],
        telos: "Bring ${domain} change into existence.",
        real_world_change: "${domain} reality is different and re-verifiable.",
        cold_pickup_test: "Could a ${domain} reviewer pick up the change cold?",
        body: "## ${domain} build notes\n\nKeep scope inside the glyph.\n",
      },
    ],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });

  const instantiated = await Effect.runPromise(
    instantiateOrbit(orbit, { domain: "Forge" }),
  );

  expect(instantiated.phases[0]?.telos).toBe(
    "Bring Forge change into existence.",
  );
  expect(instantiated.phases[0]?.real_world_change).toBe(
    "Forge reality is different and re-verifiable.",
  );
  expect(instantiated.phases[0]?.cold_pickup_test).toBe(
    "Could a Forge reviewer pick up the change cold?",
  );
  expect(instantiated.phases[0]?.body).toBe(
    "## Forge build notes\n\nKeep scope inside the glyph.\n",
  );
});

test("orbit phase template instantiation preserves references bindings and notes", async () => {
  const { instantiateOrbit } = await import("./resolve.js");
  const { Orbit } = await import("./sources.js");

  const orbit = new Orbit({
    name: "phase-shape-template",
    sourcePath: "/tmp/phase-shape-template.orbit.ts",
    description: "Phase shape template",
    parameters: [{ name: "domain", required: true }],
    phases: [
      {
        name: "${domain} build",
        orbit_binding: {
          orbit: "template",
          bindings: { required: "${domain}" },
        },
        agent: "builder",
        agents: ["builder"],
        requires: [{ all: ["reviewable"], min: 1 }],
        notes: { Input: "${domain} input", Done: "${domain} complete" },
        telos: "Build ${domain}.",
      },
      {
        name: "empty shape",
        orbit_binding: { orbit: "template", bindings: {} },
        agents: [],
        requires: [],
        notes: {},
      },
    ],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });

  const instantiated = await Effect.runPromise(
    instantiateOrbit(orbit, { domain: "Forge" }),
  );

  expect(instantiated.phases[0]).toEqual({
    name: "Forge build",
    orbit_binding: { orbit: "template", bindings: { required: "Forge" } },
    agent: "builder",
    agents: ["builder"],
    requires: [{ all: ["reviewable"], min: 1 }],
    notes: { Input: "Forge input", Done: "Forge complete" },
    telos: "Build Forge.",
  });
  expect(instantiated.phases[1]).toEqual({
    name: "empty shape",
    orbit_binding: { orbit: "template" },
    agents: [],
    requires: [],
  });
  expect(Object.hasOwn(instantiated.phases[1] ?? {}, "notes")).toBe(false);
});

test("orbit phase template instantiation reports missing phase binding field", async () => {
  const { instantiateOrbit } = await import("./resolve.js");
  const { Orbit } = await import("./sources.js");

  const orbit = new Orbit({
    name: "phase-missing-binding-template",
    sourcePath: "/tmp/phase-missing-binding-template.orbit.ts",
    description: "Phase missing binding template",
    parameters: [{ name: "domain", required: false }],
    phases: [
      {
        name: "plain phase",
        agents: [],
        requires: [],
        notes: { Input: "${domain} input" },
      },
    ],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });

  const exit = await Effect.runPromiseExit(instantiateOrbit(orbit, {}));
  const failure = getFailure(exit);

  expect(failure._tag).toBe("OrbitValidationError");
  if (failure._tag === "OrbitValidationError") {
    expect(failure.field).toBe("phases[0].notes.Input");
    expect(failure.message).toBe(
      "missing binding 'domain' required by template string",
    );
  }
});

test("orbit phase template instantiation preserves missing binding order", async () => {
  const { instantiateOrbit } = await import("./resolve.js");
  const { Orbit } = await import("./sources.js");

  const cases: Array<{
    readonly phase: NormalizedOrbitPhase;
    readonly field: string;
  }> = [
    {
      phase: {
        name: "${missingName}",
        orbit: "${missingOrbit}",
        orbit_binding: { orbit: "template", bindings: { required: "${missingBinding}" } },
        agents: [],
        requires: [],
        notes: { Input: "${missingNote}" },
        telos: "${missingTelos}",
      },
      field: "phases[0].name",
    },
    {
      phase: {
        name: "plain",
        orbit: "${missingOrbit}",
        orbit_binding: { orbit: "template", bindings: { required: "${missingBinding}" } },
        agents: [],
        requires: [],
        notes: { Input: "${missingNote}" },
      },
      field: "phases[0].orbit",
    },
    {
      phase: {
        name: "plain",
        orbit: "target",
        orbit_binding: { orbit: "template", bindings: { required: "${missingBinding}" } },
        agents: [],
        requires: [],
        notes: { Input: "${missingNote}" },
      },
      field: "phases[0].orbit_binding.bindings.required",
    },
    {
      phase: {
        name: "plain",
        orbit_binding: { orbit: "template", bindings: { required: "value" } },
        agents: [],
        requires: [],
        notes: { Input: "${missingNote}" },
        telos: "${missingTelos}",
      },
      field: "phases[0].notes.Input",
    },
    {
      phase: {
        name: "plain",
        agents: [],
        requires: [],
        telos: "${missingTelos}",
        real_world_change: "${missingChange}",
      },
      field: "phases[0].telos",
    },
    {
      phase: {
        name: "plain",
        agents: [],
        requires: [],
        telos: "value",
        real_world_change: "${missingChange}",
        cold_pickup_test: "${missingPickup}",
      },
      field: "phases[0].real_world_change",
    },
    {
      phase: {
        name: "plain",
        agents: [],
        requires: [],
        real_world_change: "value",
        cold_pickup_test: "${missingPickup}",
        body: "${missingBody}",
      },
      field: "phases[0].cold_pickup_test",
    },
    {
      phase: {
        name: "plain",
        agents: [],
        requires: [],
        cold_pickup_test: "value",
        body: "${missingBody}",
      },
      field: "phases[0].body",
    },
  ];

  for (const current of cases) {
    const orbit = new Orbit({
      name: "phase-order-template",
      sourcePath: "/tmp/phase-order-template.orbit.ts",
      description: "Phase order template",
      parameters: [
        { name: "missingName", required: false },
        { name: "missingOrbit", required: false },
        { name: "missingBinding", required: false },
        { name: "missingNote", required: false },
        { name: "missingTelos", required: false },
        { name: "missingChange", required: false },
        { name: "missingPickup", required: false },
        { name: "missingBody", required: false },
      ],
      phases: [current.phase],
      tool_permissions: [],
      pulsar_checkpoints: [],
      body: "",
    });

    const failure = getFailure(await Effect.runPromiseExit(instantiateOrbit(orbit, {})));

    expect(failure._tag).toBe("OrbitValidationError");
    if (failure._tag === "OrbitValidationError") {
      expect(failure.field).toBe(current.field);
      expect(failure.message).toContain("missing binding");
    }
  }
});

test("derived orbit skill renders parametric stub for parameterized orbit templates", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  await writeText(
    join(pluginRoot, "orbits", "parametric-template.orbit.ts"),
    `import { agentRef, defineOrbit, traitRef } from ${JSON.stringify(prismImportPath)};

export default defineOrbit({
  name: "parametric-template",
  description: "A parametric orbit template; remains uninstantiated.",
  parameters: [{ name: "audience" }],
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [{ all: [traitRef("committable"), traitRef("self-assessing")] }],
    },
  ],
});
`,
  );

  // Parameterized orbits do not lower; only their templates exist. The
  // helper still gracefully describes them when invoked. Build a quick
  // unit-style invocation by compiling and asserting the skill is NOT emitted.
  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(
    await pathExists(
      join(projectRoot, ".opencode", "skills", "parametric-template", "SKILL.md"),
    ),
  ).toBe(false);
});

test("derived orbit skill renders trait sections from description + bound-by + grants without instructions", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );

  // The committable trait carries a description and grants `commit_work`.
  expect(skill).toContain("### `canonical-compile-fixture:committable`");
  expect(skill).toContain("Can create implementation commits");
  expect(skill).toContain("- Bound by: `builder`");
  expect(skill).toContain("- Grants tool(s): `commit_work`");

  // Verbatim trait instructions must NOT leak into the orbit skill.
  expect(skill).not.toContain(
    "Commit owned implementation changes only after the submitted work is complete.",
  );
  expect(skill).not.toContain(
    "Submit completed work through the typed submission surface before handing off.",
  );

  // Reviewable trait is bound by the reviewer and grants `submit_review`.
  expect(skill).toContain("### `canonical-compile-fixture:reviewable`");
  expect(skill).toContain("- Bound by: `reviewer`");
  expect(skill).toContain("- Grants tool(s): `submit_review`");
});

test("derived orbit skill suppresses traits with no description and no grants", async () => {
  const { renderDerivedOrbitSkillBody } = await import("./derived-orbit-skill.js");
  const { Orbit, Trait, Agent } = await import("./sources.js");
  const { emptyRegistry } = await import("./registry.js");

  // Build a registry with a single agent whose trait has no description and
  // no granted tools or skills. The trait section should emit only the
  // suppression note.
  const registry = emptyRegistry("/tmp/min", "min", "0.0.0");
  const trait = new Trait({
    name: "bare",
    sourcePath: "/tmp/bare.trait.ts",
    instructions: ["These instructions should never be rendered in the orbit skill."],
    access: { tools: [], toolGroups: [], skills: [] },
    tools: {},
    inject: { skills: [] },
    require: { tools: [], skills: [] },
  });
  registry.traits.set("bare", trait);
  const agent = new Agent({
    name: "worker",
    sourcePath: "/tmp/worker.agent.ts",
    description: "Worker agent",
    identity: "worker",
    traits: [{ ref: "bare", tools: {} }],
    access: { tools: [], toolGroups: [], skills: [] },
    skills: [],
    targets: {},
  });
  registry.agents.set("worker", agent);

  const orbit = new Orbit({
    name: "min-orbit",
    sourcePath: "/tmp/min.orbit.ts",
    description: "minimal",
    parameters: [],
    phases: [
      {
        name: "Do work",
        agents: ["worker"],
        requires: [],
      },
    ],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });

  const body = renderDerivedOrbitSkillBody(orbit, registry);
  expect(body).toContain(
    "_`min:bare`: no orchestration-relevant surface; see trait source for agent-side instructions._",
  );
  // The bare trait's instructions never reach the orbit skill.
  expect(body).not.toContain("These instructions should never be rendered in the orbit skill.");
  // No `### \`min:bare\`` block is emitted for the suppressed trait.
  expect(body).not.toContain("### `min:bare`");
});

test("derived orbit skill drops the closure-discipline section", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );

  expect(skill).not.toContain("## Closure discipline");
});

test("derived orbit skill drops the input-shape placeholder line", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );

  expect(skill).not.toContain("Input: Structured input — see canonical tool schema for fields.");
  // Tool entries still render the head line itself.
  expect(skill).toContain("`create_glyph` (canonical `protocol-core:create_glyph`)");
});

test("derived orbit skill agent sub-sections do not render a duplicated **Identity** line", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );

  expect(skill).not.toMatch(/^\*\*Identity\*\*:/m);
});

test("derived orbit skill personality block renders only archetype + gloss", async () => {
  const { renderDerivedOrbitSkillBody } = await import("./derived-orbit-skill.js");
  const { Orbit, Personality, Agent, Identity } = await import("./sources.js");
  const { emptyRegistry } = await import("./registry.js");

  const registry = emptyRegistry("/tmp/persona", "persona", "0.0.0");
  registry.identities.set(
    "worker",
    new Identity({
      name: "worker",
      sourcePath: "/tmp/worker.identity.md",
      description: "Worker identity description",
      body: "",
    }),
  );
  registry.personalities.set(
    "passionate-screenwriter",
    new Personality({
      name: "passionate-screenwriter",
      sourcePath: "/tmp/passionate-screenwriter.personality.md",
      description: "Forward-projecting orchestration that drives momentum across phases without losing rigor.",
      temperament: "Passionate (`E-A-S`) — emotional, active, secondary",
      orientation: "affirms outward",
      virtues: "primary **Prudence**, secondary **Temperance**, ambition **magnanimous**",
      body: "",
    }),
  );
  const agent = new Agent({
    name: "worker",
    sourcePath: "/tmp/worker.agent.ts",
    description: "Agent paragraph description",
    identity: "worker",
    personality: "passionate-screenwriter",
    traits: [],
    access: { tools: [], toolGroups: [], skills: [] },
    skills: [],
    targets: {},
  });
  registry.agents.set("worker", agent);

  const orbit = new Orbit({
    name: "persona-demo",
    sourcePath: "/tmp/persona-demo.orbit.ts",
    description: "demo",
    parameters: [],
    phases: [
      {
        name: "Do work",
        agents: ["worker"],
        requires: [],
      },
    ],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });

  const body = renderDerivedOrbitSkillBody(orbit, registry);

  // Trimmed personality form.
  expect(body).toContain(
    "**Personality**: `passionate-screenwriter` — Forward-projecting orchestration that drives momentum across phases without losing rigor.",
  );
  // Temperament / orientation / virtues clauses are no longer rendered.
  expect(body).not.toContain("temperament Passionate");
  expect(body).not.toContain("orientation affirms outward");
  expect(body).not.toContain("virtues primary **Prudence**");
  // No double trailing period.
  expect(body).not.toContain("rigor..");
});
