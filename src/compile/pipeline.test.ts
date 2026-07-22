import { afterEach, expect, test } from "bun:test";

// --- stubs after MCP tree deletion (tests may still reference old names) ---
const __mcpDeleted = (name: string): any => {
  throw new Error(`MCP surface deleted: ${name}`);
};
const pluginServerKey = (pluginName: string): string =>
  pluginName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
const shimServerKey = (_harness: string): string => "prism";
const bareWireToolName = (_plugin: string, tool: string): string => tool;
const renderAllowlist = (...args: unknown[]): string => String(args[args.length - 1] ?? "");
const renderPluginAllowlist = (...args: unknown[]): string => {
  const tool = String(args[args.length - 1] ?? "");
  const plugin = String(args[args.length - 2] ?? "");
  return `${pluginServerKey(plugin)}__${tool}`;
};
const renderPluginWire = (plugin: string, tool: string, ..._rest: unknown[]): string =>
  `${pluginServerKey(plugin)}_${tool}`;
const generatedMcpWireServerName = (pluginName: string): string => `prism-generated-${pluginName}`;
const generatedMcpServerName = generatedMcpWireServerName;
const prismMcpServerPath = (prismHome: string, pluginName: string): string =>
  `${prismHome}/runtime/tools/${pluginName}/runtime.mjs`;
const prismMcpServerStdioPath = (prismHome: string, pluginName: string): string =>
  `${prismHome}/runtime/tools/${pluginName}/runtime.mjs`;
const writePrismMcpServerBundle = async (..._args: unknown[]): Promise<{ path: string }> =>
  __mcpDeleted("writePrismMcpServerBundle");
const resolveOwnerMcpRuntime = (..._args: unknown[]): any => __mcpDeleted("resolveOwnerMcpRuntime");
const generateMcpServerBundle = async (..._args: unknown[]): Promise<any> =>
  __mcpDeleted("generateMcpServerBundle");
const mcpServerRuntimeSourceSha256 = (): string => "deleted";
const readMcpServerSourceSha256FromBundle = (_c: string): string | undefined => undefined;
const cleanupPrismMcpProcessesUnder = async (_root: string): Promise<void> => {};
const pluginDaemonLogPath = (..._args: unknown[]): string => "/tmp/prism-mcp-deleted.log";
const registerDaemon = async (..._args: unknown[]): Promise<any> => __mcpDeleted("registerDaemon");
type RegistryEntry = { pluginName: string; pid?: number };
type RegistryResult = { ok: boolean };
// --- end stubs ---
const getFreePort = async (..._args: unknown[]): Promise<number> => 0;
const roundTripCompiledBundle = async (..._a: unknown[]): Promise<any> => ({ toolNames: [], callResult: {} });
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Option, Schema } from "effect";
import matter from "gray-matter";
import type { CompileError } from "./errors.js";
import { loadPlugin } from "./load.js";
import { readLockfile } from "./lockfile.js";
import {
  mcpToolNamesForBindings,
} from "./tool-runtime-bundle.js";
import { generatedSyntheticToolName } from "./generated-plugin.js";
import { bindingFromToolSource } from "./tool-bindings.js";
import {
  compileManifestPath,
  readCompileManifest,
  verifyAgentManifestHash,
  verifyCompileManifestHash,
} from "./compile-manifest.js";
import { WORKFLOW_REFS_HARNESS, workflowAgentsPath, workflowModelsPath, workflowRefsRoot, workflowSkillsPath, workflowToolsPath } from "./workflow-refs-emitter.js";
import { compilePluginForTarget, planPluginForTarget, type CompileResult } from "./pipeline.js";
import { deriveProjectKey } from "../project-key.js";
import { expandPath } from "../fs.js";
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
import { resolvePrismHome } from "../prism-home.js";
import { commitSnapshot, readSnapshot } from "../state/store.js";
import type { DesiredRegion } from "../sync/desired.js";
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
    join(
      projectRoot,
      ".opencode",
      "plugins",
      pluginId,
      "dist",
      "server.mjs",
    ),
  ).href;

const generatedStaleSourcePluginEntry = (projectRoot: string, pluginId: string): string =>
  pathToFileURL(
    join(projectRoot, ".opencode", "plugins", pluginId, "src", "server.ts"),
  ).href;

const sanitizeKimiMcpNamePart = (part: string): string =>
  part.replace(/[^a-zA-Z0-9_-]/gu, "_").replace(/_+/gu, "_");

const kimiStableHash8 = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.codePointAt(index)!;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  return hash.toString(16).padStart(8, "0");
};

const qualifyKimiMcpToolName = (serverName: string, toolName: string): string => {
  const full = `mcp__${sanitizeKimiMcpNamePart(serverName)}__${sanitizeKimiMcpNamePart(toolName)}`;
  if (full.length <= 64) return full;
  const hash = kimiStableHash8(full);
  return `${full.slice(0, 64 - hash.length - 1)}_${hash}`;
};

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
  description: "Echo through Hermes MCP.",
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
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `
export default {
  name: "workspace",
  tools: { read_repo: { targets: { "antigravity-cli": { name: "read_file" } } } },
};
`);
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "submit-work",
  description: "Submit completed work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input, context) { return { acknowledged: true }; },
};
`);
  await writeText(join(pluginRoot, "traits", "submittable.trait.ts"), `import { toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit work through the typed Antigravity plugin tool.",
  access: { tools: [toolRef("workspace", "read_repo")] },
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
};
`);
  await writeText(join(pluginRoot, "agents", "worker.agent.ts"), `import { skillRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "worker",
  description: "Antigravity plugin worker",
  identity: "worker",
  traits: ["submittable"],
  skills: [skillRef("testing")],
};
`);
  await writeText(join(pluginRoot, "orbits", "delivery.orbit.ts"), `import { agentRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "delivery",
  description: "Deliver work through Antigravity",
  phases: [{ name: "Build", agents: [agentRef("worker")], requires: [{ all: [traitRef("submittable")] }] }],
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-read.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-read",
  description: "Audit read calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "read_repo")) },
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
  match: { tool: hookTool.canonical("submit_work") },
  handle: (event) => Effect.succeed(
    event.tool.input?.block
      ? { decision: "block" as const, message: "canonical-blocked" }
      : { decision: "continue" as const },
  ),
};
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
          tools: ["codex-cli", "claude-code", "antigravity-cli", "factory-droid", "cursor"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "tools", "echo-message.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo-message",
  description: "Echo a message",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: input.message };
  },
};
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
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `
export default {
  name: "workspace",
  tools: { shell: { targets: { "codex-cli": { name: "shell.command" } } } },
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
  await writeText(join(pluginRoot, "traits", "submittable.trait.ts"), `
export default {
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit through the generated Codex MCP tool.",
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
};
`);
  await writeText(join(pluginRoot, "agents", "reviewer.agent.ts"), `import { skillRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "reviewer",
  description: "Codex project reviewer",
  identity: "reviewer",
  traits: ["submittable"],
  skills: [skillRef("testing")],
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-shell.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-shell",
  description: "Audit shell calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
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
          toolspaces: ["opencode"],
          tools: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "toolspaces", "core.toolspace.ts"), `
export default {
  name: "core",
  tools: { shell: { targets: { opencode: { name: "bash" } } } },
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-before.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-before",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("core", "shell")) },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-after.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-after",
  event: hookEvent.toolAfter,
  match: { tool: hookTool.tool(toolRef("core", "shell")) },
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
  match: { tool: hookTool.canonical("submit_work") },
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
    `
export default {
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
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `
export default {
  name: "worker",
  description: "Permission-only consumer worker",
  identity: "worker",
  traits: ["submittable"],
};
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
    `
export default {
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
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { bindTrait } from "prism";
import { WorkerDetails } from "../schemas/worker-details.ts";

export default {
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
};
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
import { schemaSlot } from "prism";
import { SharedInput } from "../schemas/shared.ts";

export default {
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
};
`,
  );

  return { pluginRoot, protocolRoot, projectRoot };
};

afterEach(async () => {
  process.env.PRISM_HOME = originalPrismHome;
  const roots = tempRoots.splice(0);
  await Promise.all(roots.map((root) => cleanupPrismMcpProcessesUnder(root).catch(() => undefined)));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
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

test("claw-harness preset targets OpenClaw and Hermes", () => {
  expect(resolveManifestTargets(["claw-harness"])).toEqual(["openclaw", "hermes"]);
});

test("coding-harness preset includes admitted coding harnesses", () => {
  expect(resolveManifestTargets(["coding-harness"])).toContain("grok");
  expect(resolveManifestTargets(["coding-harness"])).toContain("kimi-code");
  expect(resolveManifestTargets(["coding-harness"])).toContain("pi");
  expect(resolveManifestTargets(["coding-harness"])).toContain("omp");
  expect(resolveManifestTargets(["coding-harness"])).toContain("cursor");
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

test("Cursor compile support is tools-only", async () => {
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

  const agentRoot = join(root, "cursor-agent-unsupported");
  await writeText(
    join(agentRoot, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-agent-unsupported",
      version: "0.1.0",
      targets: { agents: ["cursor"] },
    })}\n`,
  );

  await expect(readManifest(agentRoot)).rejects.toThrow(
    "targets.agents resolves to unsupported compile harnesses: cursor",
  );
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

test("canonical TS-authored agents resolve shared toolspace and modelspace bindings", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

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

  const projectKey = deriveProjectKey(expandPath(projectRoot)).key;
  expect(await pathExists(compileManifestPath(testPrismHome(), projectKey))).toBe(true);
  const manifestRead = await readCompileManifest(testPrismHome(), projectKey);
  expect(manifestRead.quarantinedPath).toBeUndefined();
  expect(verifyCompileManifestHash(manifestRead.manifest)).toBe(true);
  expect(manifestRead.manifest.compileTargets).toEqual([
    { harness: "opencode", scope: "project" },
  ]);
  const builderEntry = manifestRead.manifest.agents["canonical-compile-fixture:builder"];
  expect(builderEntry).toBeDefined();
  if (!builder || !builderEntry) throw new Error("expected builder and manifest entry");
  expect(builderEntry && verifyAgentManifestHash(builderEntry)).toBe(true);
  expect(builderEntry?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(builderEntry?.traits.map((trait) => trait.id)).toEqual([
    "canonical-compile-fixture:committable",
    "canonical-compile-fixture:self-assessing",
    "canonical-compile-fixture:submittable",
  ]);
  expect(builderEntry?.composed.modelBindings).toEqual({
    modelspace: "agent-core:default-models",
    profile: "builder",
  });
  expect(builderEntry.composed.grants.tools).toEqual([
    "canonical-compile-fixture:commit-work",
    "protocol-core:create_glyph",
    "protocol-core:external-submit",
  ]);
  expect(builderEntry?.composed.perTarget.opencode).toEqual({
    scope: "project",
    model: builder.model ?? null,
    toolGrants: builderEntry.composed.grants.tools,
    allowedTools: builder.allowedTools,
    allowedSkills: builder.allowedSkills,
  });

  const workflowAgentsRefPath = workflowAgentsPath(testPrismHome(), projectKey);
  const workflowModelsRefPath = workflowModelsPath(testPrismHome(), projectKey);
  const workflowSkillsRefPath = workflowSkillsPath(testPrismHome(), projectKey);
  const workflowToolsRefPath = workflowToolsPath(testPrismHome(), projectKey);
  expect(await pathExists(workflowAgentsRefPath)).toBe(true);
  expect(await pathExists(workflowModelsRefPath)).toBe(true);
  expect(await pathExists(workflowSkillsRefPath)).toBe(true);
  expect(await pathExists(workflowToolsRefPath)).toBe(true);
  const workflowRefs = await readFile(workflowAgentsRefPath, "utf8");
  expect(workflowRefs).toContain("Generated by Prism. Do not edit.");
  expect(workflowRefs).toContain('"canonicalCompileFixture": {');
  expect(workflowRefs).toContain('"builder":');
  expect(workflowRefs).toContain(`manifestHash: ${JSON.stringify(builderEntry.manifestHash)}`);
  expect(workflowRefs).toContain('installs: ["opencode"]');
  const workflowModelsContent = await readFile(workflowModelsRefPath, "utf8");
  expect(workflowModelsContent).toContain("kind: \"model-profile-ref\"");
  expect(workflowModelsContent).toContain("default-models");
  expect(workflowModelsContent).toContain("agent-core");
  const workflowSkillsContent = await readFile(workflowSkillsRefPath, "utf8");
  expect(workflowSkillsContent).toContain("Generated by Prism. Do not edit.");
  expect(workflowSkillsContent).toContain("managed-skill-ref");
  expect(workflowSkillsContent).toContain('"testing"');
  expect(workflowSkillsContent).toContain("deliveryContract");
  const workflowToolsContent = await readFile(workflowToolsRefPath, "utf8");
  expect(workflowToolsContent).toContain("Generated by Prism. Do not edit.");
  expect(workflowToolsContent).toContain("canonical-tool-ref");
  expect(workflowToolsContent).toContain("toolspace-tool-ref");
  expect(workflowToolsContent).toContain("commitWork");
  expect(workflowToolsContent).toContain("protocolCore");
  expect(workflowToolsContent).toContain("createGlyph");
  expect(workflowToolsContent).not.toContain("sourcePath");
  expect(workflowToolsContent).not.toContain(".tool.ts");
  const workflowRefsSnapshot = await readSnapshot({
    prismHome: testPrismHome(),
    harness: WORKFLOW_REFS_HARNESS,
    root: workflowRefsRoot(testPrismHome(), projectKey),
  });
  expect(workflowRefsSnapshot.manifest.entries.some((entry) => entry.targetPath === workflowAgentsRefPath)).toBe(true);
  expect(workflowRefsSnapshot.manifest.entries.some((entry) => entry.targetPath === workflowModelsRefPath)).toBe(true);
  expect(workflowRefsSnapshot.manifest.entries.some((entry) => entry.targetPath === workflowSkillsRefPath)).toBe(true);
  expect(workflowRefsSnapshot.manifest.entries.some((entry) => entry.targetPath === workflowToolsRefPath)).toBe(true);
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

test("orbit phase validation succeeds when assigned agents satisfy requirements", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

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
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  const generatedPluginSkips = warmOpencode.operations.filter(
    (operation) =>
      operation.kind === "skip" &&
      operation.targetPath.includes(join(".opencode", "plugins", "prism-generated")),
  );
  expect(generatedPluginSkips.length).toBeGreaterThan(0);
  expect(warmOpencode.operations.filter(
    (operation) =>
      (operation.kind === "create" || operation.kind === "repair") &&
      operation.targetPath.includes(join(".opencode", "plugins", "prism-generated")),
  )).toEqual([]);
});

test("orbit validation fails when assigned agents do not satisfy requirements", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    invalidOrbit: true,
  });

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
  expect(failure._tag).toBe("OrbitValidationError");
  if (failure._tag === "OrbitValidationError") {
    expect(failure.field).toBe("phases[1].requires[0]");
    expect(failure.message).toContain("reviewable");
    expect(failure.message).toContain("only 0 match");
  }
});

test("loadPlugin normalizes orbit phase references requirements and metadata", async () => {
  const pluginRoot = await createOrbitLoadFixture(
    `import { agentRef, orbitRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default {
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
      workflow: {
        when: "Use when phase routing is repeatable.",
        inputs: ["glyph"],
        outputs: ["handoff"],
        sequence: ["run builder", "verify handoff"],
        coordination: "Keep one agent accountable for the phase output.",
        finish_criteria: ["handoff is reviewable"],
        escalation: "Stop when the handoff cannot be verified.",
      },
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
};
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
    workflow: {
      when: "Use when phase routing is repeatable.",
      inputs: ["glyph"],
      outputs: ["handoff"],
      sequence: ["run builder", "verify handoff"],
      coordination: "Keep one agent accountable for the phase output.",
      finish_criteria: ["handoff is reviewable"],
      escalation: "Stop when the handoff cannot be verified.",
    },
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
      prismHome: testPrismHome(),
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
      prismHome: testPrismHome(),
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
    `import { agentRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default {
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
};
`,
  );

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
    `
export default {
  name: "obsolete",
  description: "Uses the deprecated tool_permissions shape with agents",
  phases: [],
  tool_permissions: [
    { agents: ["builder"], tools: ["protocol-core:create_glyph"] },
  ],
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
  expect(failure.message).toContain("must be an imported schema identifier");
});

test("slot-filled trait tools fail closed on undeclared slots", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    undeclaredSlot: true,
  });

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
  expect(failure.message).toContain("fills undeclared tool slot(s): unknown_verdict");
});

test("slot source capture tolerates trait refs before slot-filled bindings", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    mixedTraitRefsBeforeSlotBinding: true,
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
    "prism-generated-canonical-compile-fixture",
  );
  const bundle = await readFile(join(generatedRoot, "dist", "server.mjs"), "utf8");
  expect(bundle).toContain(
    generatedSyntheticToolName(
      "canonical-compile-fixture",
      "submit_review__review_findings_slot",
    ),
  );
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

  // MCP config emission was excised — tools are CLI-only.
  expect(await pathExists(join(outputPluginRoot, "mcp_config.json"))).toBe(false);
  const antigravityServerKey = pluginServerKey("antigravity_plugin.demo");
  // Hook matchers still use the logical generated tool name (not MCP wire).
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
    skills: ["delivery", "testing"],
    tools: [
      "read_file",
    ],
  });
  expect(parsedAgent.data.tools ?? []).not.toContain(antigravityMcpToolName);
  expect(parsedAgent.content).toContain("# Worker");
  expect(parsedAgent.content).toContain("Submit work through the typed Antigravity plugin tool.");

  expect(await readFile(join(outputPluginRoot, "skills", "testing", "SKILL.md"), "utf8")).toContain("# Testing");
  const orbitSkill = await readFile(join(outputPluginRoot, "skills", "delivery", "SKILL.md"), "utf8");
  expect(orbitSkill).not.toContain("<!-- prism:");
  expect(orbitSkill).toContain("# delivery");
  expect(orbitSkill).toContain("### 1. Build — agent `worker`");

  expect(await pathExists(prismMcpServerPath(testPrismHome(), "antigravity_plugin.demo"))).toBe(false);

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

test.skip("compilePluginForTarget exposes standalone canonical tools through MCP bundle lowerers (MCP excised)", async () => {
  const { pluginRoot, projectRoot } = await createStandaloneToolFixture();
  const targets = ["codex-cli", "claude-code", "antigravity-cli", "factory-droid", "cursor"] as const;

  for (const target of targets) {
    await Effect.runPromise(
      compilePluginForTarget({
        prismHome: testPrismHome(),
        pluginPath: pluginRoot,
        target,
        scope: "project",
        projectPath: projectRoot,
        dryRun: false,
      }),
    );
  }

  const expectedToolName = "tool_only_demo_echo_message";
  const canonicalServerPath = prismMcpServerPath(testPrismHome(), "tool-only-demo");

  // UNION BUNDLE: supported generated-MCP harness compiles of one plugin converge on a single
  // canonical PRISM_HOME bundle file with a single hash.
  const unionBundle = await readFile(canonicalServerPath, "utf8");
  expect(unionBundle).toContain(expectedToolName);
  expect(unionBundle).toContain("tools/list");
  const bundleEntries = await readdir(join(testPrismHome(), "runtime", "mcp"), {
    withFileTypes: true,
  });
  expect(
    bundleEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  ).toEqual(["tool-only-demo"]);

  // codex-cli registers ONE server per owner plugin, keyed by the plugin's
  // own server key — never the retired aggregated `prism-mcp-shim` key —
  // advertising the bare (unprefixed) wire name.
  const codexServerKey = pluginServerKey("tool-only-demo");
  const codexConfig = await readFile(join(projectRoot, ".codex", "config.toml"), "utf8");
  expect(codexConfig).toContain(`["mcp_servers"."${codexServerKey}"]`);
  expect(codexConfig).not.toContain(`["mcp_servers"."${shimServerKey("codex-cli")}"]`);
  expect(codexConfig).toContain('command = "prism"');
  expect(codexConfig).toContain('args = ["mcp", "shim"]');
  expect(codexConfig).toContain(`enabled_tools = ["echo_message"]`);
  expect(codexConfig).toContain('PRISM_SHIM_PLUGINS = "tool-only-demo"');
  expect(codexConfig).toContain('PRISM_SHIM_HARNESS = "codex-cli"');
  expect(codexConfig).toContain('PRISM_SHIM_NAMING = "per-plugin"');
  // A per-plugin server always fronts exactly one daemon, so the shim
  // derives that owner's profile itself — never a single explicit
  // PRISM_SHIM_EXPOSURE value.
  expect(codexConfig).not.toContain("PRISM_SHIM_EXPOSURE");
  expect(codexConfig).not.toMatch(/url = "http/u);
  expect(await pathExists(join(projectRoot, ".codex", "mcp"))).toBe(false);

  const claudeRoot = join(projectRoot, ".claude", "skills", "prism-generated-tool-only-demo");
  const claudeMcp = JSON.parse(await readFile(join(claudeRoot, ".mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  const claudeShim = claudeMcp.mcpServers?.[pluginServerKey("tool-only-demo")];
  expect(claudeShim?.command).toBe("prism");
  expect(claudeShim?.args).toEqual(["mcp", "shim"]);
  expect(claudeShim?.env).toEqual({
    PRISM_SHIM_PLUGINS: "tool-only-demo",
    PRISM_SHIM_HARNESS: "claude-code",
    PRISM_SHIM_NAMING: "per-plugin",
    PRISM_SHIM_EXPOSURE: "prism-generated-tool-only-demo:claude-code",
  });
  expect(await pathExists(join(claudeRoot, "mcp"))).toBe(false);

  const antigravityRoot = join(projectRoot, ".agents", "plugins", "prism-generated-tool-only-demo");
  const antigravityMcpConfig = JSON.parse(await readFile(join(antigravityRoot, "mcp_config.json"), "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  const antigravityShim = antigravityMcpConfig.mcpServers?.[pluginServerKey("tool-only-demo")];
  expect(antigravityShim?.command).toBe("prism");
  expect(antigravityShim?.args).toEqual(["mcp", "shim"]);
  expect(antigravityShim?.env).toEqual({
    PRISM_SHIM_PLUGINS: "tool-only-demo",
    PRISM_SHIM_HARNESS: "antigravity-cli",
    PRISM_SHIM_NAMING: "per-plugin",
    PRISM_SHIM_EXPOSURE: "prism-generated-tool-only-demo:antigravity-cli",
  });
  expect(await pathExists(join(antigravityRoot, "mcp"))).toBe(false);

  const factoryRoot = join(projectRoot, ".factory", "plugins", "prism-generated-tool-only-demo");
  const factoryMcp = JSON.parse(await readFile(join(factoryRoot, "mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  const factoryShim = factoryMcp.mcpServers?.[pluginServerKey("tool-only-demo")];
  expect(factoryShim?.command).toBe("prism");
  expect(factoryShim?.args).toEqual(["mcp", "shim"]);
  expect(factoryShim?.env).toEqual({
    PRISM_SHIM_PLUGINS: "tool-only-demo",
    PRISM_SHIM_HARNESS: "factory-droid",
    PRISM_SHIM_NAMING: "per-plugin",
    PRISM_SHIM_EXPOSURE: "prism-generated-tool-only-demo:factory-droid",
  });
  expect(await pathExists(join(factoryRoot, "mcp"))).toBe(false);

  // cursor registers ONE server per owner plugin, keyed by the plugin's own
  // server key — never the retired aggregated `prism-mcp-shim` key.
  const cursorConfig = JSON.parse(await readFile(join(projectRoot, ".cursor", "mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  const cursorShim = cursorConfig.mcpServers?.[pluginServerKey("tool-only-demo")];
  expect(cursorConfig.mcpServers?.[shimServerKey("cursor")]).toBeUndefined();
  expect(cursorShim?.command).toBe("prism");
  expect(cursorShim?.args).toEqual(["mcp", "shim"]);
  expect(cursorShim?.env).toEqual({
    PRISM_SHIM_PLUGINS: "tool-only-demo",
    PRISM_SHIM_HARNESS: "cursor",
    PRISM_SHIM_NAMING: "per-plugin",
  });
  expect(await pathExists(join(projectRoot, ".cursor", "mcp"))).toBe(false);

  // Byte-identical across harness compiles: recompiling another harness must
  // not change the canonical bundle bytes.
  const firstHash = computeContentHash(unionBundle);
  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "codex-cli",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(computeContentHash(await readFile(canonicalServerPath, "utf8"))).toBe(firstHash);
});

test.skip("union MCP bundle keeps per-harness exposure deny-by-default (MCP excised)", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "exposure-demo");
  const coreRoot = join(root, "exposure-core");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(coreRoot, "plugin.json"),
    `${JSON.stringify({
      name: "exposure-core",
      version: "0.1.0",
      targets: { tools: ["codex-cli"] },
    }, null, 2)}\n`,
  );
  await writeText(
    join(coreRoot, "tools", "agent-only.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "agent-only",
  description: "Bound only through the codex agent",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ value: Schema.String }),
  async handle(input) {
    return { value: input.value };
  },
};
`,
  );
  await writeText(
    join(coreRoot, "traits", "agent-bound.trait.ts"),
    `
export default {
  name: "agent-bound",
  description: "Grants the agent-only tool",
  tools: { agent_only: { ref: "agent-only" } },
  require: { tools: ["agent_only"] },
};
`,
  );

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "exposure-demo",
      version: "0.1.0",
      deps: { core: "../exposure-core" },
      targets: {
        tools: ["codex-cli", "claude-code"],
        agents: ["codex-cli"],
      },
    }, null, 2)}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "shared.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "shared",
  description: "Exposed on both harnesses",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ value: Schema.String }),
  async handle(input) {
    return { value: input.value };
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    "---\ndescription: Worker identity\n---\n\n# Worker\n",
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `
export default {
  name: "worker",
  description: "Codex worker",
  identity: "worker",
  traits: ["core:agent-bound"],
};
`,
  );

  for (const target of ["codex-cli", "claude-code"] as const) {
    await Effect.runPromise(
      compilePluginForTarget({
        prismHome: testPrismHome(),
        pluginPath: pluginRoot,
        target,
        scope: "project",
        projectPath: projectRoot,
        dryRun: false,
      }),
    );
  }
  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: coreRoot,
      target: "codex-cli",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  // Owner-only runtime bundles: the consumer bundle contains consumer-owned
  // canonical tools, while dependency-owned tools stay in the dependency
  // owner's bundle.
  const consumerBundle = await readFile(
    prismMcpServerPath(testPrismHome(), "exposure-demo"),
    "utf8",
  );
  expect(consumerBundle).toContain("exposure_demo_shared");
  expect(consumerBundle).not.toContain("exposure_core_agent_only");
  const ownerBundle = await readFile(
    prismMcpServerPath(testPrismHome(), "exposure-core"),
    "utf8",
  );
  expect(ownerBundle).toContain("exposure_core_agent_only");
  expect(ownerBundle).not.toContain("exposure_demo_shared");

  // Codex (harness A): the agent TOML exposes the agent-bound tool, the
  // global table stays canonical-tools-only.
  const codexAgent = await readFile(
    join(projectRoot, ".codex", "agents", "worker.toml"),
    "utf8",
  );
  expect(codexAgent).toContain(
    `# MCP tools requested from ${pluginServerKey("exposure-core")} (shim wire): agent_only`,
  );
  // Each owner plugin renders its OWN per-plugin server region — never a
  // shared cross-plugin table. exposure-core's own compile emits ONLY its
  // own "agent_only" tool; exposure-demo's own compile emits ONLY its own
  // "shared" tool. exposure-demo's foreign reference to exposure-core's tool
  // never adds it to exposure-demo's server (a per-plugin server can only
  // ever front its own single daemon) — deny-by-default for the foreign
  // agent-bound tool lives entirely in the agent role file (asserted above).
  const codexConfig = await readFile(join(projectRoot, ".codex", "config.toml"), "utf8");
  expect(codexConfig).not.toContain(`["mcp_servers"."${shimServerKey("codex-cli")}"]`);

  const exposureCoreServerKey = pluginServerKey("exposure-core");
  expect(codexConfig).toContain(`["mcp_servers"."${exposureCoreServerKey}"]`);
  expect(codexConfig).toContain(`enabled_tools = ["agent_only"]`);
  expect(codexConfig).toContain('PRISM_SHIM_PLUGINS = "exposure-core"');

  const exposureDemoServerKey = pluginServerKey("exposure-demo");
  expect(codexConfig).toContain(`["mcp_servers"."${exposureDemoServerKey}"]`);
  expect(codexConfig).toContain(`enabled_tools = ["shared"]`);
  expect(codexConfig).toContain('PRISM_SHIM_PLUGINS = "exposure-demo"');
  // exposure-demo's own server never carries exposure-core's tool, and
  // vice versa.
  expect(codexConfig).not.toContain('enabled_tools = ["agent_only", "shared"]');
  expect(codexConfig).not.toContain('enabled_tools = ["shared", "agent_only"]');

  expect(consumerBundle).toContain('"prism-generated-exposure-demo:claude-code"');

  // Claude (harness B): deny-by-default moves to the `PRISM_SHIM_EXPOSURE`
  // env var carried in the shim's spawn env -- Claude's .mcp.json has no
  // per-role allowlist field of its own, so the shim itself gates by this
  // exposure profile at runtime.
  const claudeMcp = JSON.parse(
    await readFile(
      join(projectRoot, ".claude", "skills", "prism-generated-exposure-demo", ".mcp.json"),
      "utf8",
    ),
  ) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
  const claudeShimEnv = claudeMcp.mcpServers?.[pluginServerKey("exposure-demo")]?.env;
  expect(claudeShimEnv?.PRISM_SHIM_EXPOSURE).toBe("prism-generated-exposure-demo:claude-code");
  expect(JSON.stringify(claudeMcp)).not.toContain("PRISM_MCP_ENABLED_TOOLS");
});

test.skip("compilePluginForTarget lowers Cursor tool-only MCP config globally (MCP excised)", async () => {
  const { pluginRoot } = await createStandaloneToolFixture();
  const root = await createTempRoot();
  const cursorRoot = join(root, "cursor-home");

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "cursor",
      scope: "global",
      root: cursorRoot,
      dryRun: false,
    }),
  );

  expect(result.composed).toHaveLength(0);
  expect(result.operations).toContainEqual(
    expect.objectContaining({
      kind: "patch-regions",
      targetPath: join(cursorRoot, "mcp.json"),
    }),
  );
  const config = JSON.parse(await readFile(join(cursorRoot, "mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  // cursor registers ONE server keyed by the owner plugin's own server key —
  // never the retired aggregated `prism-mcp-shim` key.
  expect(config.mcpServers?.[shimServerKey("cursor")]).toBeUndefined();
  const cursorMcp = config.mcpServers?.[pluginServerKey("tool-only-demo")];
  expect(cursorMcp?.command).toBe("prism");
  expect(cursorMcp?.args).toEqual(["mcp", "shim"]);
  expect(cursorMcp?.env).toEqual({
    PRISM_SHIM_PLUGINS: "tool-only-demo",
    PRISM_SHIM_HARNESS: "cursor",
    PRISM_SHIM_NAMING: "per-plugin",
  });
  expect(await pathExists(prismMcpServerPath(testPrismHome(), "tool-only-demo"))).toBe(true);
  // The mcp.json server entry is a region in the snapshot manifest; the
  // canonical bundle is pipeline-owned and never appears as a managed target.
  const snapshot = await readSnapshot({
    prismHome: testPrismHome(),
    harness: "cursor",
    root: cursorRoot,
  });
  expect(snapshot.manifest.entries.some((entry) =>
    entry.targetPath.endsWith("server.mjs")
  )).toBe(false);
  // The per-plugin server region is attributed to the owner plugin itself.
  expect(snapshot.manifest.entries.some((entry) =>
    entry.plugin === "tool-only-demo" &&
    entry.targetPath === join(cursorRoot, "mcp.json") &&
    entry.mode === "region"
  )).toBe(true);
});

test.skip("compilePluginForTarget emits a runnable MCP bundle into PRISM_HOME (MCP excised)", async () => {
  const { pluginRoot } = await createStandaloneToolFixture();
  const root = await createTempRoot();
  const cursorRoot = join(root, "cursor-home");

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "cursor",
      scope: "global",
      root: cursorRoot,
      dryRun: false,
    }),
  );

  const serverPath = prismMcpServerPath(testPrismHome(), "tool-only-demo");
  const port = await getFreePort("127.0.0.1");
  const result = await roundTripCompiledBundle({
    serverPath,
    port,
    toolName: "tool_only_demo_echo_message",
    toolArgs: { message: "hello from pipeline round-trip" },
  });

  expect(result.toolNames).toContain("tool_only_demo_echo_message");
  expect(result.callResult.structuredContent).toEqual({
    message: "hello from pipeline round-trip",
  });
});

test("compilePluginForTarget removes the stale Cursor MCP config entry when tools target is removed", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "cursor-empty-cleanup");
  const cursorRoot = join(root, "cursor-home");
  const staleServerPath = join(cursorRoot, "mcp", "prism_generated_cursor_empty_cleanup", "server.mjs");
  const staleServerContent = "console.log('stale Cursor runtime');\n";
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-empty-cleanup",
      version: "0.1.0",
      targets: {},
    })}\n`,
  );
  await writeText(
    join(cursorRoot, "mcp.json"),
    `${JSON.stringify({
      mcpServers: {
        "prism-generated-cursor-empty-cleanup": {
          type: "stdio",
          command: "bun",
          args: [staleServerPath],
        },
        userServer: { url: "https://example.com/mcp" },
      },
    }, null, 2)}\n`,
  );
  await writeText(staleServerPath, staleServerContent);
  // Seed the snapshot with the previously compiled mcp.json region; the
  // recompile (with no tool targets) must remove it as orphaned.
  await commitSnapshot({
    prismHome: testPrismHome(),
    manifest: {
      version: 1,
      harness: "cursor",
      root: cursorRoot,
      entries: [{
        targetPath: join(cursorRoot, "mcp.json"),
        contentHash: "stale",
        mode: "region",
        regionKey: serializeRegionRef({
          kind: "json-key",
          targetPath: join(cursorRoot, "mcp.json"),
          regionKey: "mcpServers.prism-generated-cursor-empty-cleanup",
          jsonPath: ["mcpServers", "prism-generated-cursor-empty-cleanup"],
          value: undefined,
          plugin: "cursor-empty-cleanup",
        }),
        plugin: "cursor-empty-cleanup",
      }],
    },
  });

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "cursor",
      scope: "global",
      root: cursorRoot,
      dryRun: false,
    }),
  );

  // The config region is removed; stale in-root bundle files are NOT pruned
  // (they were never snapshot-managed) — old-layout leftovers are WS8
  // teardown's job.
  expect(result.operations.some((operation) => operation.kind === "prune")).toBe(false);
  expect(result.operations.some((operation) => operation.kind === "patch-regions")).toBe(true);
  expect(await pathExists(staleServerPath)).toBe(true);
  const config = JSON.parse(await readFile(join(cursorRoot, "mcp.json"), "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  expect(config.mcpServers?.["prism-generated-cursor-empty-cleanup"]).toBeUndefined();
  expect(config.mcpServers?.userServer).toEqual({ url: "https://example.com/mcp" });
});

test("compilePluginForTarget leaves unrelated Cursor MCP config untouched without tool targets", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "cursor-noop-cleanup");
  const cursorRoot = join(root, "cursor-home");
  const configPath = join(cursorRoot, "mcp.json");
  const collidingServerPath = join(cursorRoot, "mcp", "prism_generated_cursor_noop_cleanup", "server.mjs");
  const originalConfig = `{"mcpServers":{"prism-generated-cursor-noop-cleanup":{"type":"stdio","command":"bun","args":["${collidingServerPath}"]},"userServer":{"url":"https://example.com/mcp"}}}\n`;
  const collidingServerContent = "console.log('user-owned collision');\n";
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-noop-cleanup",
      version: "0.1.0",
      targets: {},
    })}\n`,
  );
  await writeText(configPath, originalConfig);
  await writeText(collidingServerPath, collidingServerContent);

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "cursor",
      scope: "global",
      root: cursorRoot,
      dryRun: false,
    }),
  );

  expect(result.operations.some((operation) => operation.kind === "patch-regions")).toBe(false);
  expect(result.operations.some((operation) => operation.kind === "prune")).toBe(false);
  expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  expect(await readFile(collidingServerPath, "utf8")).toBe(collidingServerContent);
});

test.skip("compilePluginForTarget leaves Cursor skills to install while lowering tools (MCP excised)", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "cursor-mixed-skills-tools");
  const cursorRoot = join(root, "cursor-home");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-mixed-skills-tools",
      version: "0.1.0",
      targets: {
        skills: ["cursor"],
        tools: ["cursor"],
      },
    })}\n`,
  );
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );
  await writeText(
    join(pluginRoot, "tools", "echo-message.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo-message",
  description: "Echo through Cursor MCP.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: input.message };
  },
};
`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "cursor",
      scope: "global",
      root: cursorRoot,
      dryRun: false,
    }),
  );

  expect(result.files.some((file) =>
    file.targetPath.endsWith(join("skills", "testing", "SKILL.md"))
  )).toBe(false);
  expect(await pathExists(join(cursorRoot, "skills", "testing", "SKILL.md"))).toBe(false);
  const config = JSON.parse(await readFile(join(cursorRoot, "mcp.json"), "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  expect(config.mcpServers?.[pluginServerKey("cursor-mixed-skills-tools")]).toBeDefined();
});

test("compilePluginForTarget leaves never-managed Cursor MCP entries untouched", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "cursor-stale-ledger-collision");
  const cursorRoot = join(root, "cursor-home");
  const configPath = join(cursorRoot, "mcp.json");
  const staleServerPath = join(
    cursorRoot,
    "mcp",
    "prism_generated_cursor_stale_ledger_collision",
    "server.mjs",
  );
  const staleServerContent = "console.log('stale Cursor runtime');\n";
  const currentConfig = `${JSON.stringify({
    mcpServers: {
      "prism-generated-cursor-stale-ledger-collision": {
        type: "stdio",
        command: "bun",
        args: [staleServerPath],
      },
      userServer: { url: "https://example.com/mcp" },
    },
  })}\n`;
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: "cursor-stale-ledger-collision",
      version: "0.1.0",
      targets: {},
    })}\n`,
  );
  await writeText(configPath, currentConfig);
  await writeText(staleServerPath, staleServerContent);
  // Nothing is seeded into the snapshot: the prism-named config entry and the
  // old-layout bundle file were never snapshot-managed, so the sync engine
  // must not touch them (no adopt, no name-based cleanup).

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "cursor",
      scope: "global",
      root: cursorRoot,
      dryRun: false,
    }),
  );

  expect(result.operations.some((operation) => operation.kind === "patch-regions")).toBe(false);
  expect(result.operations.some((operation) =>
    operation.kind === "prune" &&
    operation.targetPath === staleServerPath
  )).toBe(false);
  expect(await readFile(configPath, "utf8")).toBe(currentConfig);
  expect(await readFile(staleServerPath, "utf8")).toBe(staleServerContent);
});

test.skip("compilePluginForTarget emits a Codex project bundle (MCP excised)", async () => {
  const { pluginRoot, projectRoot } = await createCodexProjectFixture();

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
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
  // The features flag fence is anchored under a single [features] header.
  expect(config).toContain("[features]");
  expect(config).toContain("hooks = true");
  expect(config.split("[features]").length - 1).toBe(1);
  expect(config).toContain("# --- prism:codex.hooks.codex-project-demo begin ---");
  // Per-plugin server, keyed by the plugin's own server key — never the
  // retired aggregated `prism-mcp-shim` key.
  const codexProjectServerKey = pluginServerKey("codex-project-demo");
  expect(config).toContain(`# --- prism:codex.mcp.${codexProjectServerKey} begin ---`);
  expect(config).toContain(`["mcp_servers"."${codexProjectServerKey}"]`);
  expect(config).not.toContain(`["mcp_servers"."${shimServerKey("codex-cli")}"]`);
  expect(config).toContain(`enabled_tools = ["submit_work"]`);
  expect(config).toContain('PRISM_SHIM_NAMING = "per-plugin"');
  expect(config).toContain('[["hooks"."PreToolUse"]]');
  expect(config).toContain('matcher = "shell\\\\.command"');

  const agent = await readFile(join(codexRoot, "agents", "reviewer.toml"), "utf8");
  expect(agent).toContain('name = "reviewer"');
  expect(agent).toContain(`# MCP tools requested from ${codexProjectServerKey} (shim wire):`);

  expect(await pathExists(prismMcpServerPath(testPrismHome(), "codex-project-demo"))).toBe(true);
  expect(await pathExists(join(codexRoot, "mcp"))).toBe(false);
  expect(await pathExists(join(codexRoot, "hooks", "audit-shell.mjs"))).toBe(true);
  expect(await readFile(join(codexRoot, "skills", "testing", "SKILL.md"), "utf8")).toContain("# Testing");
  expect(await readFile(join(codexRoot, "AGENTS.md"), "utf8")).toContain("Use project-local Codex guidance.");
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
  const reviewFindingsToolName = generatedSyntheticToolName(
    "canonical-compile-fixture",
    "submit_review__review_findings_slot",
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
    `${reviewFindingsToolName}: deny`,
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
  expect(reviewerAgent).toContain(`${reviewFindingsToolName}: allow`);

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
  expect(generatedToolNames).toContain(reviewFindingsToolName);
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
  expect(generatedServerSource).toContain(reviewFindingsToolName);
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

export default {
  name: "echo",
  description: "Echo a message through Amp.",
  input: Schema.Struct({
    message: Schema.String.annotations({ description: "Message to echo" }),
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
          toolspaces: ["amp-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "toolspaces", "workspace.toolspace.ts"),
    `
export default {
  name: "workspace",
  tools: {
    echo: { targets: { "amp-code": { name: "amp_hook_demo_echo" } } },
  },
};
`,
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
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-after",
  event: hookEvent.toolAfter,
  match: { tool: hookTool.tool(toolRef("workspace", "echo")) },
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

test.skip("compilePluginForTarget lowers Hermes skills and canonical tools into MCP config (MCP excised)", async () => {
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

export default {
  name: "echo",
  description: "Echo a message through Hermes MCP.",
  input: Schema.Struct({
    message: Schema.String.annotations({ description: "Message to echo" }),
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
      target: "hermes",
      scope: "global",
      dryRun: true,
    }),
  );

  const hermesRoot = join(homedir(), ".hermes/");
  const serverPath = prismMcpServerPath(testPrismHome(), "hermes-tool-demo");
  expect(result.outputRoot).toBe(hermesRoot);

  const skillWrite = result.files.find(
    (file) => file.targetPath === join(hermesRoot, "skills", "hermes-demo", "SKILL.md"),
  );
  expect(skillWrite?.content).toContain("# Hermes Demo");

  // The bundle is written to PRISM_HOME by the pipeline, never planned as a
  // harness-root operation.
  expect(result.operations.some(
    (operation) => operation.targetPath.endsWith("server.mjs"),
  )).toBe(false);
  expect(result.files.some((file) => file.targetPath.endsWith("server.mjs"))).toBe(false);

  const configRegion = result.regions.find(
    (region) => region.targetPath === join(hermesRoot, "config.yaml"),
  );
  expect(configRegion?.kind).toBe("marker");
  if (configRegion?.kind === "marker") {
    // Anchored inside the user-shared top-level mcp_servers mapping.
    expect(configRegion.anchor).toBe("mcp_servers:");
    // Hermes registers ONE server per owner plugin, keyed by the plugin's
    // own server key — never the retired aggregated `prism-mcp-shim` key —
    // advertising the bare (unprefixed) wire name.
    expect(configRegion.content).toContain(`${pluginServerKey("hermes-tool-demo")}:`);
    expect(configRegion.content).not.toContain(`${shimServerKey("hermes")}:`);
    expect(configRegion.content).toContain("command: prism");
    expect(configRegion.content).toContain("- mcp");
    expect(configRegion.content).toContain("- shim");
    expect(configRegion.content).toContain('PRISM_SHIM_PLUGINS: "hermes-tool-demo"');
    expect(configRegion.content).toContain('PRISM_SHIM_HARNESS: "hermes"');
    expect(configRegion.content).toContain('PRISM_SHIM_NAMING: "per-plugin"');
    expect(configRegion.content).not.toContain("PRISM_SHIM_EXPOSURE");
    expect(configRegion.content).toContain("sampling:");
    expect(configRegion.content).toContain("enabled: false");
    expect(configRegion.content).toContain("echo");
  }
});

// Renamed from "...as Streamable HTTP MCP": HTTP transport is retired, only
// stdio-shim remains. This plugin still declares a legacy
// `runtime.mcp.hermes` HTTP block (host/port/timeouts) on purpose -- the
// point of the test is that it is silently ignored and the output is the
// same stdio-shim shape as any other Hermes tool plugin.
test.skip("compilePluginForTarget ignores legacy Hermes HTTP runtime config and still lowers via stdio-shim (MCP excised)", async () => {
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

export default {
  name: "echo",
  description: "Echo through Hermes Streamable HTTP MCP.",
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

  const hermesRoot = join(homedir(), ".hermes/");
  // No bundle write is planned into any root — the union bundle is a
  // pipeline-owned PRISM_HOME artifact (skipped entirely in dry-run).
  expect(result.operations.some(
    (operation) => operation.targetPath.endsWith("server.mjs"),
  )).toBe(false);

  const configRegion = result.regions.find(
    (region) => region.targetPath === join(hermesRoot, "config.yaml"),
  );
  expect(configRegion?.kind).toBe("marker");
  if (configRegion?.kind === "marker") {
    expect(configRegion.content).toContain(`${pluginServerKey("hermes-http-demo")}:`);
    expect(configRegion.content).not.toContain(`${shimServerKey("hermes")}:`);
    expect(configRegion.content).toContain("command: prism");
    expect(configRegion.content).toContain("- mcp");
    expect(configRegion.content).toContain("- shim");
    expect(configRegion.content).toContain('PRISM_SHIM_PLUGINS: "hermes-http-demo"');
    expect(configRegion.content).toContain('PRISM_SHIM_HARNESS: "hermes"');
    expect(configRegion.content).toContain('PRISM_SHIM_NAMING: "per-plugin"');
    expect(configRegion.content).not.toContain("PRISM_SHIM_EXPOSURE");
    expect(configRegion.content).toContain("sampling:");
    expect(configRegion.content).toContain("enabled: false");
    expect(configRegion.content).toContain("echo");
    // The legacy runtime.mcp.hermes HTTP block (host/port/timeouts) on this
    // plugin has no effect on the rendered config at all.
    expect(configRegion.content).not.toContain("url:");
    expect(configRegion.content).not.toContain("connect_timeout");
    expect(configRegion.content).not.toContain("15000");
    expect(configRegion.content).not.toContain("90000");
  }
});

test.skip("compilePluginForTarget lowers Codex MCP config via stdio-shim (legacy HTTP runtime config ignored) (MCP excised)", async () => {
  const port = await getFreePort("127.0.0.1");
  const { pluginRoot, hermesRoot: codexRoot } = await createHermesHttpToolPlugin({
    target: "codex-cli",
    pluginName: "codex-http-demo",
    port,
  });

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "codex-cli",
      scope: "global",
      root: codexRoot,
      dryRun: false,
    }),
  );

  expect(result.outputRoot).toBe(codexRoot);
  const config = await readFile(join(codexRoot, "config.toml"), "utf8");
  // Per-plugin server, keyed by the plugin's own server key.
  expect(config).toContain(`["mcp_servers"."${pluginServerKey("codex-http-demo")}"]`);
  expect(config).not.toContain(`["mcp_servers"."${shimServerKey("codex-cli")}"]`);
  expect(config).toContain('command = "prism"');
  expect(config).toContain('args = ["mcp", "shim"]');
  expect(config).toContain(`enabled_tools = ["echo"]`);
  expect(config).toContain('PRISM_SHIM_PLUGINS = "codex-http-demo"');
  expect(config).toContain('PRISM_SHIM_HARNESS = "codex-cli"');
  expect(config).toContain('PRISM_SHIM_NAMING = "per-plugin"');
  expect(config).not.toContain("PRISM_SHIM_EXPOSURE");
  // The legacy runtime.mcp.codex-cli HTTP block (host/port) on this plugin
  // has no effect on the rendered config at all.
  expect(config).not.toContain('command = "bun"');
  expect(config).not.toMatch(/url = "http/u);
  expect(await pathExists(prismMcpServerPath(testPrismHome(), "codex-http-demo"))).toBe(true);
  expect(
    result.operations.some((operation) => operation.targetPath.endsWith("server.mjs")),
  ).toBe(false);
  expect(
    await pathExists(join(codexRoot, "mcp")),
  ).toBe(false);
});

test.skip("planPluginForTarget lowers Codex MCP config via stdio-shim (legacy HTTP runtime config ignored) (MCP excised)", async () => {
  const port = await getFreePort("127.0.0.1");
  const { pluginRoot, hermesRoot: codexRoot } = await createHermesHttpToolPlugin({
    target: "codex-cli",
    pluginName: "codex-http-plan-demo",
    port,
  });

  const result = await Effect.runPromise(
    planPluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "codex-cli",
      scope: "global",
      root: codexRoot,
      dryRun: false,
    }),
  );

  const configRegion = result.regions.find((region): region is Extract<DesiredRegion, { kind: "marker" }> =>
    region.kind === "marker" &&
    region.regionKey === `codex.mcp.${pluginServerKey("codex-http-plan-demo")}`
  );
  expect(configRegion?.content).toContain('command = "prism"');
  expect(configRegion?.content).toContain('args = ["mcp", "shim"]');
  expect(configRegion?.content).toContain(`enabled_tools = ["echo"]`);
  expect(configRegion?.content).not.toMatch(/url = "http/u);
});

test.skip("compilePluginForTarget lowers Claude MCP config via stdio-shim (legacy HTTP runtime config ignored) (MCP excised)", async () => {
  const port = await getFreePort("127.0.0.1");
  const { pluginRoot, hermesRoot: claudeRoot } = await createHermesHttpToolPlugin({
    target: "claude-code",
    pluginName: "claude-http-demo",
    port,
  });
  const canonicalServerPath = prismMcpServerPath(testPrismHome(), "claude-http-demo");

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "claude-code",
      scope: "global",
      root: claudeRoot,
      dryRun: false,
    }),
  );

  expect(result.outputRoot).toBe(claudeRoot);
  const config = JSON.parse(
    await readFile(
      join(claudeRoot, "skills", "prism-generated-claude-http-demo", ".mcp.json"),
      "utf8",
    ),
  ) as {
    mcpServers?: Record<string, {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }>;
  };
  expect(config.mcpServers?.[pluginServerKey("claude-http-demo")]).toEqual({
    command: "prism",
    args: ["mcp", "shim"],
    env: {
      PRISM_SHIM_PLUGINS: "claude-http-demo",
      PRISM_SHIM_HARNESS: "claude-code",
      PRISM_SHIM_NAMING: "per-plugin",
      PRISM_SHIM_EXPOSURE: "prism-generated-claude-http-demo:claude-code",
    },
  });
  expect(await pathExists(canonicalServerPath)).toBe(true);
});

// The former "previews an auto-selected Hermes HTTP MCP port in dry-run"
// test is removed: port auto-selection is a retired HTTP-transport concept,
// and its `runtime.json`-absent-in-dry-run assertion is now trivially true
// in every case (that file is never written at all post-consolidation --
// see the bundle-not-written dry-run assertions in "compilePluginForTarget
// lowers Hermes skills and canonical tools into MCP config" above, which
// already cover the real dry-run invariant). The sibling below absorbs its
// only remaining value -- confirming an omitted port still compiles -- with
// a real assertion on the emitted config instead of a vacuous one.
test.skip("compilePluginForTarget accepts Hermes with stdio-shim (HTTP port config ignored) (MCP excised)", async () => {
  // Post-consolidation: HTTP mode is gone, only stdio-shim remains.
  // Configuration that would have required HTTP port now succeeds with stdio-shim.
  const { pluginRoot, hermesRoot } = await createHermesHttpToolPlugin({
    pluginName: "hermes-http-auto-port-none-demo",
    omitPort: true,
  });

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
  expect(result.operations.length).toBeGreaterThan(0);
  const config = await readFile(join(hermesRoot, "config.yaml"), "utf8");
  expect(config).toContain(`${pluginServerKey("hermes-http-auto-port-none-demo")}:`);
  expect(config).not.toContain(`${shimServerKey("hermes")}:`);
  expect(config).toContain("command: prism");
  expect(config).not.toMatch(/url:/u);
});

test("compilePluginForTarget accepts omitted HTTP MCP ports when no tools bind", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "http-no-tool-bindings");
  const hermesRoot = join(root, "hermes-root");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "http-no-tool-bindings",
        version: "0.1.0",
        targets: {
          tools: ["hermes"],
        },
        runtime: {
          mcp: {
            hermes: {
              transport: "streamable-http",
              host: "127.0.0.1",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "hermes",
      scope: "global",
      root: hermesRoot,
      dryRun: false,
      emitWorkflowRefs: false,
    }),
  );

  expect(result.operations).toHaveLength(0);
  expect(await pathExists(join(hermesRoot, "config.yaml"))).toBe(false);
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
  description: "Echo through Hermes Streamable HTTP MCP.",
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
          hooks: ["cursor"],
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
    `import { skillspaceRef, type TraitSource } from "prism";

export default {
  name: "marketing-enabled",
  description: "Can use marketing skills",
  access: {
    skills: [
      skillspaceRef("external-skills", "copy-engineering"),
      skillspaceRef("external-skills", "marketing"),
    ],
  },
} satisfies TraitSource;
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import type { SkillspaceSource } from "prism";

export default {
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
} satisfies SkillspaceSource;
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
    `import { skillRef, type AgentSource } from "prism";

export default {
  name: "worker",
  description: "Worker with skill permissions",
  identity: "worker",
  traits: ["marketing-enabled"],
  skills: [skillRef("contracts")],
} satisfies AgentSource;
`,
  );

  const firstCompile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
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
      prismHome: testPrismHome(),
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
    `import type { SkillspaceSource } from "prism";

export default {
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
} satisfies SkillspaceSource;
`,
  );

  const skillspaceChangedCompile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
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
    `import { skillspaceRef, type TraitSource } from "prism";

export default {
  name: "needs-testing",
  description: "Requires testing skill permission",
  require: {
    skills: [skillspaceRef("core-skills", "testing")],
  },
} satisfies TraitSource;
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "core-skills.skillspace.ts"),
    `import type { SkillspaceSource } from "prism";

export default {
  name: "core-skills",
  skills: {
    testing: {
      targets: {
        opencode: { name: "testing" },
      },
    },
  },
} satisfies SkillspaceSource;
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
    `import { skillRef, type AgentSource } from "prism";

export default {
  name: "worker",
  description: "Worker with concrete skill dependency",
  identity: "worker",
  traits: ["needs-testing"],
  skills: [skillRef("testing")],
} satisfies AgentSource;
`,
  );

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
      agentSource: `
export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  skills: ["testing"],
};
`,
    },
    {
      label: "agent.access.skills",
      expectedKind: "agent",
      agentSource: `
export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  access: {
    skills: ["testing"],
  },
};
`,
    },
    {
      label: "trait.access.skills",
      expectedKind: "trait",
      expectedMessage:
        "access.skills[0]: plain skill strings are not allowed; use skillRef(...) for managed plugin skills or skillspaceRef(...) for harness-native skills",
      traitSource: `
export default {
  name: "skillful",
  description: "Skill access",
  access: {
    skills: ["testing"],
  },
};
`,
    },
    {
      label: "trait.inject.skills",
      expectedKind: "trait",
      expectedMessage:
        "inject.skills[0]: plain skill strings are not allowed; use skillRef(...) for managed plugin skills or skillspaceRef(...) for harness-native skills",
      traitSource: `
export default {
  name: "skillful",
  description: "Skill injection",
  inject: {
    skills: ["testing"],
  },
};
`,
    },
    {
      label: "trait.require.skills",
      expectedKind: "trait",
      expectedMessage:
        "require.skills[0]: plain skill strings are not allowed; use skillRef(...) for managed plugin skills or skillspaceRef(...) for harness-native skills",
      traitSource: `
export default {
  name: "skillful",
  description: "Skill requirement",
  require: {
    skills: ["testing"],
  },
};
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
        `
export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["skillful"],
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
    `
export default {
  name: "reviewable",
  description: "Review capability",
  tools: {
    submit_review: { ref: "   " },
  },
};
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
    `
export default {
  name: "workspace",
  tools: {
    read: {
      targets: {
        opencode: { name: "read" },
      },
    },
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { toolRef } from "prism";

export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  access: {
    tools: [toolRef("workspace", "read")],
  },
};
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: testPrismHome(),
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
    `import { skillspaceRef } from "prism";

export default {
  name: "external",
  description: "Uses an external skill",
  access: {
    skills: [skillspaceRef("external-skills", "copy-engineering")],
  },
};
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
    `
export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["external"],
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
    `import { skillspaceRef } from "prism";

export default {
  name: "external",
  description: "Uses an external skill",
  access: {
    skills: [skillspaceRef("external-skills", "testing")],
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `
export default {
  name: "external-skills",
  skills: {
    testing: {
      targets: {
        "antigravity-cli": { name: "testing" },
      },
    },
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `
export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["external"],
};
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
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
    `import { skillspaceRef } from "prism";

export default {
  name: "external",
  description: "Uses an external skill",
  access: {
    skills: [skillspaceRef("external-skills", "testing")],
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `
export default {
  name: "external-skills",
  skills: {
    testing: {
      targets: {
        "factory-droid": { name: "testing" },
      },
    },
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `
export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["external"],
};
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: testPrismHome(),
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
      prismHome: testPrismHome(),
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

    const markdown = result.files.find(
      (file) => file.targetPath.endsWith(`agents/${agentName}.md`),
    );
    if (!markdown) {
      throw new Error(`expected ${agentName} markdown file`);
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
      `import { bindTrait } from "prism";

export default {
  name: ${JSON.stringify(family.agent)},
  description: ${JSON.stringify(`Uses ${family.trait} skill permissions`)},
  identity: "worker",
  traits: [bindTrait(${JSON.stringify(`agent-core:${family.trait}`)})],
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
      dryRun: true,
    }),
  );

  for (const family of traitFamilies) {
    const agent = result.composed.find((candidate) => candidate.name === family.agent);
    expect(agent?.skills).toEqual([]);
    expect(agent?.allowedSkills).toEqual(family.expected);

    const markdown = result.files.find(
      (file) => file.targetPath.endsWith(`agents/${family.agent}.md`),
    );
    if (!markdown) {
      throw new Error(`expected ${family.agent} markdown file`);
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
    `import { skillspaceRef } from "prism";

export default {
  name: "testing-enabled",
  description: "Can use test methodology",
  access: {
    skills: [skillspaceRef("external-skills", "testing")],
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `
export default {
  name: "external-skills",
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
  description: "Worker with direct and permission-only skills",
  identity: "worker",
  traits: ["testing-enabled"],
  skills: [skillRef("contracts")],
};
`,
  );

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
  const worker = result.composed.find((agent) => agent.name === "worker");
  expect(worker?.skills).toEqual(["contracts"]);
  expect(worker?.allowedSkills).toEqual(["contracts", "testing"]);

  const markdown = result.files.find(
    (file) => file.targetPath.endsWith("agents/worker.md"),
  );
  if (!markdown) {
    throw new Error("expected worker markdown file");
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
    `import { skillspaceRef } from "prism";

export default {
  name: "testing-enabled",
  description: "References a missing method skill",
  access: {
    skills: [skillspaceRef("external-skills", "missing-method")],
  },
};
`,
  );
  await writeText(
    join(missingPluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `
export default {
  name: "external-skills",
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
  await writeText(
    join(missingPluginRoot, "agents", "worker.agent.ts"),
    `
export default {
  name: "worker",
  description: "Worker with a missing skill permission",
  identity: "worker",
  traits: ["testing-enabled"],
};
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: testPrismHome(),
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
  const { pluginRoot, protocolRoot, projectRoot } = await createExternalPermissionOnlyFixture();

  // Per-plugin one-writer scheme: the owner (protocol-core) is the sole
  // producer of its own OpenCode bundle — compile it explicitly first (see
  // "tools-only plugins emit the complete owner runtime plugin" above). The
  // consumer no longer re-materializes it.
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
  // The desired generated-plugin entry is ensured as an array-membership
  // region; entries Prism never snapshot-managed (the legacy stale forms the
  // fixture seeds) are foreign content now — WS8 teardown cleans the old
  // ledger era, not the compile path.
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(projectRoot, "prism-generated-protocol-core"),
  );
  expect(opencodeConfig.plugin?.filter(
    (entry) => entry === generatedPluginEntry(projectRoot, "prism-generated-protocol-core"),
  )).toHaveLength(1);
  // No empty generated plugin shell is ever registered for the consumer.
  expect(opencodeConfig.plugin?.filter(
    (entry) =>
      entry === generatedPluginEntry(projectRoot, "prism-generated-permission-only-consumer"),
  )).toHaveLength(1); // the pre-seeded foreign entry only — Prism added none
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

test.skip("Cursor tools-only plugins bundle runtime helper imports from declared deps (MCP excised)", async () => {
  const { pluginRoot, projectRoot } = await createToolsOnlyRuntimeDepImportFixture("cursor");

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "cursor",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const server = await readFile(
    prismMcpServerPath(testPrismHome(), "signal-core"),
    "utf8",
  );
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
  expect(opencodeConfig.permission).toMatchObject({
    "protocol_core_*": "deny",
  });
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(projectRoot, "prism-generated-protocol-core"),
  );
  expect(opencodeConfig.plugin).not.toContain("prism-generated-protocol-core");
});

const createSharedOwnerFixture = async (): Promise<{
  ownerRoot: string;
  consumerARoot: string;
  consumerBRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const ownerRoot = join(root, "shared-owner");
  const consumerARoot = join(root, "consumer-a");
  const consumerBRoot = join(root, "consumer-b");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(ownerRoot, "plugin.json"),
    `${JSON.stringify(
      { name: "shared-owner", version: "0.1.0", targets: { tools: ["opencode"] } },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(ownerRoot, "tools", "acknowledge.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "acknowledge",
  description: "Acknowledge a request",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle() {
    return { acknowledged: true };
  },
};
`,
  );

  const writeConsumer = async (consumerRoot: string, name: string): Promise<void> => {
    await writeText(
      join(consumerRoot, "plugin.json"),
      `${JSON.stringify(
        {
          name,
          version: "0.1.0",
          deps: { "shared-owner": "../shared-owner" },
          targets: { agents: ["opencode"] },
        },
        null,
        2,
      )}\n`,
    );
    await writeText(
      join(consumerRoot, "identities", "worker.identity.md"),
      `---\ndescription: Worker identity\n---\n\n# Worker\n`,
    );
    await writeText(
      join(consumerRoot, "traits", "ack-capable.trait.ts"),
      `
export default {
  name: "ack-capable",
  description: "Can acknowledge via the shared owner tool",
  tools: { acknowledge: { ref: "shared-owner:acknowledge" } },
  require: { tools: ["acknowledge"] },
};
`,
    );
    await writeText(
      join(consumerRoot, "agents", "worker.agent.ts"),
      `
export default {
  name: "worker",
  description: "Worker agent",
  identity: "worker",
  traits: ["ack-capable"],
};
`,
    );
  };

  await writeConsumer(consumerARoot, "consumer-a");
  await writeConsumer(consumerBRoot, "consumer-b");

  return { ownerRoot, consumerARoot, consumerBRoot, projectRoot };
};

test("two independent consumers of the same foreign owner never conflict and never duplicate the owner's OpenCode bundle", async () => {
  const { ownerRoot, consumerARoot, consumerBRoot, projectRoot } =
    await createSharedOwnerFixture();

  const ownerBundlePath = join(
    projectRoot,
    ".opencode",
    "plugins",
    "prism-generated-shared-owner",
    "dist",
    "server.mjs",
  );

  // Neither consumer's own compile may materialize the owner's bundle file —
  // that would be exactly the per-consumer re-emission that collided across
  // a real multi-plugin corpus (src/compile/lowerers/opencode.ts).
  const consumerA = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: consumerARoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(consumerA.failures).toHaveLength(0);
  expect(
    consumerA.operations.some((operation) => operation.targetPath === ownerBundlePath),
  ).toBe(false);
  expect(await pathExists(ownerBundlePath)).toBe(false);

  // A second, independent consumer of the same owner must not conflict with
  // the first (no PathConflictError) and must likewise emit nothing at the
  // owner's path.
  const consumerB = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: consumerBRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(consumerB.failures).toHaveLength(0);
  expect(
    consumerB.operations.some((operation) => operation.targetPath === ownerBundlePath),
  ).toBe(false);
  expect(await pathExists(ownerBundlePath)).toBe(false);

  // Both consumers still wire the owner's canonical wire name into their own
  // opencode.json (allowlist/plugin-array reference), just without a file.
  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as { permission?: Record<string, string>; plugin?: string[] };
  expect(opencodeConfig.permission).toMatchObject({ "shared_owner_*": "deny" });
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(projectRoot, "prism-generated-shared-owner"),
  );

  // The owner's OWN compile is the sole producer of its bundle.
  const owner = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: ownerRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(owner.failures).toHaveLength(0);
  expect(await pathExists(ownerBundlePath)).toBe(true);
  const ownerBundle = await readFile(ownerBundlePath, "utf8");
  expect(ownerBundle).toContain("shared_owner_acknowledge");
});

test("external synthetic wrappers keep the owner runtime dependency without exposing the base tool", async () => {
  const { pluginRoot, protocolRoot, projectRoot } = await createExternalSyntheticOnlyFixture();

  // Per-plugin one-writer scheme: the owner (protocol-core) is the sole
  // producer of its own OpenCode bundle — compile it explicitly first. The
  // consumer's synthetic wrapper still references the owner's wire name but
  // no longer re-materializes its bundle.
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
  const workerDetailsToolName = generatedSyntheticToolName(
    "external-synthetic-consumer",
    "submit_work__worker_details",
  );
  expect(consumerServer).toContain(workerDetailsToolName);
  const protocolServer = await readFile(join(protocolGeneratedRoot, "dist", "server.mjs"), "utf8");
  expect(protocolServer).toContain("protocol_core_external_submit");

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "worker.md"),
    "utf8",
  );
  expect(opencodeAgent).toContain(
    `${workerDetailsToolName}: allow`,
  );
  expect(opencodeAgent).toContain("protocol_core_external_submit: deny");

  expect(consumerServer).toContain(workerDetailsToolName);
  expect(consumerServer).not.toContain("prism-generated-protocol-core/src/plugins/protocol-core/tools/external-submit.tool");

  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as { permission?: Record<string, string>; plugin?: string[] };
  expect(opencodeConfig.permission).toMatchObject({
    "external_synthetic_consumer_*": "deny",
    "protocol_core_*": "deny",
  });
  // Membership, not order: the owner (protocol-core) is now compiled first
  // per the per-plugin one-writer scheme, so its array entry lands before
  // the consumer's — insertion order was never a real contract here.
  expect(opencodeConfig.plugin).toHaveLength(2);
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(
      projectRoot,
      "prism-generated-external-synthetic-consumer",
    ),
  );
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(projectRoot, "prism-generated-protocol-core"),
  );
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
    await pathExists(prismMcpServerPath(testPrismHome(), "canonical-compile-fixture")),
  ).toBe(false);
  expect(await pathExists(join(pluginRootPath, "mcp"))).toBe(false);
  expect(await pathExists(join(projectRoot, ".claude", "agents", "builder.md"))).toBe(false);
});

test.skip("compilePluginForTarget migrates Grok project output from a stale bundle to native discovery paths (MCP excised)", async () => {
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

export default {
  name: "submit-work",
  description: "Submit completed Grok work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input) {
    return { acknowledged: true };
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `
export default {
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit completed work through the generated Grok MCP tool.",
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { skillRef } from ${JSON.stringify(prismImportPath)};

export default {
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
};
`,
  );

  const grokRoot = join(projectRoot, ".grok");
  const stalePluginRoot = join(
    grokRoot,
    "plugins",
    "prism-generated-grok-pipeline-demo",
  );
  const staleBundleFiles = [
    {
      targetPath: join(stalePluginRoot, ".claude-plugin", "plugin.json"),
      content: '{"name":"prism-generated-grok-pipeline-demo"}\n',
    },
    {
      targetPath: join(stalePluginRoot, "agents", "worker.md"),
      content: "---\nname: worker\nskills:\n  - testing\n---\n\n# Stale worker\n",
    },
    {
      targetPath: join(stalePluginRoot, "skills", "testing", "SKILL.md"),
      content: "---\nname: testing\ndescription: Stale testing\n---\n\n# Stale\n",
    },
    {
      targetPath: join(stalePluginRoot, "hooks", "hooks.json"),
      content: '{"hooks":{}}\n',
    },
  ];
  for (const stale of staleBundleFiles) {
    await writeText(stale.targetPath, stale.content);
  }
  await commitSnapshot({
    prismHome: testPrismHome(),
    manifest: {
      version: 1,
      harness: "grok",
      root: grokRoot,
      entries: staleBundleFiles.map((stale) => ({
        targetPath: stale.targetPath,
        contentHash: computeContentHash(stale.content),
        mode: "owned" as const,
        plugin: "grok-pipeline-demo",
      })),
    },
  });

  const grok = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "grok",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(grok.outputRoot).toBe(join(projectRoot, ".grok/"));
  const agentPath = join(grokRoot, "agents", "worker.md");
  const skillPath = join(grokRoot, "skills", "testing", "SKILL.md");
  const agent = await readFile(agentPath, "utf8");
  expect(agent).toContain('description: "Grok worker"');
  expect(agent).toContain('model: "grok-build"');
  expect(agent).toContain('- "read_file"');
  expect(agent).toContain('disallowedTools:\n  - "web_fetch"');
  // Grok must not emit frontmatter skills (full-body preload poison, 7ea1e27).
  expect(agent).not.toContain("\nskills:");
  expect(await pathExists(skillPath)).toBe(true);
  for (const stale of staleBundleFiles) {
    expect(grok.operations).toContainEqual(
      expect.objectContaining({
        kind: "prune",
        targetPath: stale.targetPath,
      }),
    );
    expect(await pathExists(stale.targetPath)).toBe(false);
  }
  expect(await directoryExists(stalePluginRoot)).toBe(false);
  const grokSnapshot = await readSnapshot({
    prismHome: testPrismHome(),
    harness: "grok",
    root: grokRoot,
  });
  expect(
    grokSnapshot.manifest.entries.some((entry) =>
      entry.targetPath.startsWith(`${stalePluginRoot}/`),
    ),
  ).toBe(false);
  expect(
    grokSnapshot.manifest.entries.some(
      (entry) => entry.targetPath === agentPath,
    ),
  ).toBe(true);
  expect(
    grokSnapshot.manifest.entries.some(
      (entry) => entry.targetPath === skillPath,
    ),
  ).toBe(true);
  // Shim registration lands in <grok-root>/config.toml (the only MCP source
  // grok resolves for installed plugins), never in an .mcp.json,
  // one server per MCP-owning plugin keyed by that plugin's own name.
  expect(await pathExists(join(grokRoot, ".mcp.json"))).toBe(false);
  const grokOwnerServerKey = pluginServerKey("grok-pipeline-demo");
  const grokConfig = await readFile(join(grokRoot, "config.toml"), "utf8");
  expect(grokConfig).toContain(`# --- prism:grok.mcp.${grokOwnerServerKey} begin ---`);
  expect(grokConfig).toContain(`["mcp_servers"."${grokOwnerServerKey}"]`);
  expect(grokConfig).toContain('command = "prism"');
  expect(grokConfig).toContain('args = ["mcp", "shim"]');
  expect(grokConfig).toContain(`["mcp_servers"."${grokOwnerServerKey}"."env"]`);
  expect(grokConfig).toContain('PRISM_SHIM_PLUGINS = "grok-pipeline-demo"');
  expect(grokConfig).toContain('PRISM_SHIM_HARNESS = "grok"');
  expect(grokConfig).toContain('PRISM_SHIM_NAMING = "per-plugin"');
  const mcpServer = await readFile(
    prismMcpServerPath(testPrismHome(), "grok-pipeline-demo"),
    "utf8",
  );
  expect(mcpServer).toContain("grok_pipeline_demo_submit_work");
  expect(await pathExists(join(grokRoot, "mcp"))).toBe(false);
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
          orbits: ["factory-droid"],
          tools: ["factory-droid"],
          toolspaces: ["factory-droid"],
          hooks: ["factory-droid"],
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
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `
export default {
  name: "workspace",
  tools: { read_repo: { targets: { "factory-droid": { name: "Read" } } } },
};
`);
  await writeText(
    join(pluginRoot, "tools", "submit-work.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "submit-work",
  description: "Submit completed Factory work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input) {
    return { acknowledged: true };
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `import { toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit completed work through the generated Factory MCP tool.",
  access: { tools: [toolRef("workspace", "read_repo")] },
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { skillRef } from ${JSON.stringify(prismImportPath)};

export default {
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
};
`,
  );
  await writeText(join(pluginRoot, "orbits", "delivery.orbit.ts"), `import { agentRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "delivery",
  description: "Deliver work through Factory Droid",
  phases: [{ name: "Build", agents: [agentRef("worker")], requires: [{ all: [traitRef("submittable")] }] }],
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-read.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-read",
  description: "Audit Factory read calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "read_repo")) },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-submit.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-submit",
  description: "Audit canonical submit calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("submit_work") },
  handle: (_event) => Effect.succeed({ decision: "block" as const, message: "canonical-blocked" }),
};
`);

  const factory = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
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
  const factoryMcpToolName = "factory_pipeline_demo_submit_work";
  const droid = await readFile(join(pluginRootPath, "droids", "worker.md"), "utf8");
  expect(droid).toContain('description: "Factory worker"');
  expect(droid).toContain('model: "inherit"');
  expect(droid).toContain('- "Read"');
  expect(droid).not.toContain("mcp__");
  expect(droid).not.toContain(`- "${factoryMcpToolName}"`);
  expect(droid).not.toContain("skills:");
  expect(await pathExists(join(pluginRootPath, "skills", "testing", "SKILL.md"))).toBe(true);
  expect(await pathExists(join(pluginRootPath, "skills", "delivery", "SKILL.md"))).toBe(true);
  expect(await pathExists(join(pluginRootPath, "mcp.json"))).toBe(false);
  // CLI runtime not emitted under test preload (PRISM_TOOLS_CLI_EMIT=0).
  expect(await pathExists(prismMcpServerPath(testPrismHome(), "factory-pipeline-demo"))).toBe(false);
  expect(await pathExists(join(pluginRootPath, "mcp"))).toBe(false);
  const hookConfig = await readFile(join(pluginRootPath, "hooks", "hooks.json"), "utf8");
  expect(hookConfig).toContain('"PreToolUse"');
  expect(hookConfig).toContain('"matcher": "Read"');
  expect(hookConfig).toContain(`"matcher": "${factoryMcpToolName}"`);
  expect(hookConfig).toContain('node \\"${DROID_PLUGIN_ROOT}/hooks/audit-read.mjs\\"');
  expect(hookConfig).toContain('node \\"${DROID_PLUGIN_ROOT}/hooks/audit-submit.mjs\\"');
  expect(await pathExists(join(pluginRootPath, "hooks", "audit-read.mjs"))).toBe(true);
  expect(await pathExists(join(pluginRootPath, "hooks", "audit-submit.mjs"))).toBe(true);

  const directHookProcess = Bun.spawn({
    cmd: [process.execPath, join(pluginRootPath, "hooks", "audit-read.mjs")],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  directHookProcess.stdin.write(JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { block: true },
    session_id: "session-1",
    cwd: pluginRoot,
  }));
  directHookProcess.stdin.end();
  const [directHookExit, directHookStdout, directHookStderr] = await Promise.all([
    directHookProcess.exited,
    new Response(directHookProcess.stdout).text(),
    new Response(directHookProcess.stderr).text(),
  ]);
  expect(directHookExit).toBe(2);
  expect(directHookStdout).toBe("");
  expect(directHookStderr.trim()).toBe("blocked");

  const canonicalHookProcess = Bun.spawn({
    cmd: [process.execPath, join(pluginRootPath, "hooks", "audit-submit.mjs")],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  canonicalHookProcess.stdin.write(JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: factoryMcpToolName,
    tool_input: { summary: "done" },
    session_id: "session-2",
    cwd: pluginRoot,
  }));
  canonicalHookProcess.stdin.end();
  const [canonicalHookExit, canonicalHookStdout, canonicalHookStderr] = await Promise.all([
    canonicalHookProcess.exited,
    new Response(canonicalHookProcess.stdout).text(),
    new Response(canonicalHookProcess.stderr).text(),
  ]);
  expect(canonicalHookExit).toBe(2);
  expect(canonicalHookStdout).toBe("");
  expect(canonicalHookStderr.trim()).toBe("canonical-blocked");

  expect(await pathExists(join(projectRoot, ".factory", "droids", "worker.md"))).toBe(false);
  expect(await pathExists(join(projectRoot, ".factory", "skills", "testing", "SKILL.md"))).toBe(false);

  const outputFiles = [
    join(pluginRootPath, ".factory-plugin", "plugin.json"),
    join(pluginRootPath, "droids", "worker.md"),
    join(pluginRootPath, "skills", "testing", "SKILL.md"),
    join(pluginRootPath, "skills", "delivery", "SKILL.md"),
    join(pluginRootPath, "hooks", "hooks.json"),
    join(pluginRootPath, "hooks", "audit-read.mjs"),
    join(pluginRootPath, "hooks", "audit-submit.mjs"),
  ];
  const outputSnapshot = Object.fromEntries(
    await Promise.all(
      outputFiles.map(async (path) => [path, computeContentHash(await readFile(path, "utf8"))]),
    ),
  );
  const warmCompile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "factory-droid",
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
          orbits: ["pi"],
          tools: ["pi"],
          toolspaces: ["pi"],
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
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `
export default {
  name: "workspace",
  tools: { read_repo: { targets: { pi: { name: "read" } } } },
};
`);
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
  await writeText(join(pluginRoot, "traits", "submittable.trait.ts"), `import { toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit work through the typed Pi extension tool.",
  access: { tools: [toolRef("workspace", "read_repo")] },
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
};
`);
  await writeText(join(pluginRoot, "agents", "worker.agent.ts"), `import { skillRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "worker",
  description: "Pi package worker",
  identity: "worker",
  traits: ["submittable"],
  skills: [skillRef("testing")],
};
`);
  await writeText(join(pluginRoot, "orbits", "delivery.orbit.ts"), `import { agentRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "delivery",
  description: "Deliver work through Pi",
  phases: [{ name: "Build", agents: [agentRef("worker")], requires: [{ all: [traitRef("submittable")] }] }],
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-read.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-read",
  description: "Audit read calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "read_repo")) },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-submit.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-submit",
  description: "Audit canonical submit calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("submit_work") },
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
  expect(piAgent).toContain('- "pi_pipeline_demo_submit_work"');
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
        toolspaces: ["pi"],
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
  traits: [],
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

test.skip("compilePluginForTarget lowers Kimi Code plugin, MCP, role skills, and hooks (MCP excised)", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "kimi-pipeline-demo");
  const kimiRoot = join(root, "kimi-home");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "kimi-pipeline-demo",
        version: "0.1.0",
        targets: {
          rules: ["kimi-code"],
          commands: ["kimi-code"],
          agents: ["kimi-code"],
          skills: ["kimi-code"],
          orbits: ["kimi-code"],
          tools: ["kimi-code"],
          toolspaces: ["kimi-code"],
          hooks: ["kimi-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "rules", "global", "context.md"), `# Kimi context\n\nUse the generated Kimi plugin context.\n`);
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
  await writeText(join(pluginRoot, "identities", "worker.identity.md"), `---
description: Worker identity
---

# Worker

Use Kimi plugin surfaces.
`);
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `
export default {
  name: "workspace",
  tools: { read_repo: { targets: { "kimi-code": { name: "Read" } } } },
};
`);
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "submit-work",
  description: "Submit work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input) {
    return { acknowledged: input.summary.length > 0 };
  },
};
`);
  await writeText(join(pluginRoot, "traits", "submittable.trait.ts"), `import { toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit work through the typed Kimi MCP tool.",
  access: { tools: [toolRef("workspace", "read_repo")] },
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
};
`);
  await writeText(join(pluginRoot, "agents", "worker.agent.ts"), `import { skillRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "worker",
  description: "Kimi plugin worker",
  identity: "worker",
  traits: ["submittable"],
  skills: [skillRef("testing")],
};
`);
  await writeText(join(pluginRoot, "orbits", "delivery.orbit.ts"), `import { agentRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "delivery",
  description: "Deliver work through Kimi",
  phases: [{ name: "Build", agents: [agentRef("worker")], requires: [{ all: [traitRef("submittable")] }] }],
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-read.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-read",
  description: "Audit reads",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "read_repo")) },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-submit.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-submit",
  description: "Audit canonical submit calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("submit_work") },
  handle: (_event) => Effect.succeed({ decision: "block" as const, message: "canonical-blocked" }),
};
`);

  const compiled = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "kimi-code",
      scope: "global",
      root: kimiRoot,
      dryRun: false,
      // This test asserts Kimi MCP/plugin surfaces, not project workflow-refs.
      // Orbit→agent projection into the project manifest can fail closed when
      // agent cache descriptors are absent; keep that path out of this gate.
      emitWorkflowRefs: false,
    }),
  );

  expect(compiled.outputRoot).toBe(kimiRoot);
  const kimiPluginId = "prism-generated-kimi-pipeline-demo";
  const kimiServerKey = pluginServerKey("kimi-pipeline-demo");
  const kimiDaemonToolName = "kimi_pipeline_demo_submit_work";
  const kimiWireToolName = bareWireToolName("kimi-pipeline-demo", kimiDaemonToolName);
  const qualifiedKimiToolName = qualifyKimiMcpToolName(kimiServerKey, kimiWireToolName);
  expect(qualifiedKimiToolName).toBe("mcp__kimi-pipeline-demo__submit_work");
  const pluginOutputRoot = join(kimiRoot, "plugins", "managed", kimiPluginId);
  const manifest = JSON.parse(await readFile(join(pluginOutputRoot, "kimi.plugin.json"), "utf8")) as {
    name: string;
    skills: string;
    sessionStart?: { skill?: string };
    mcpServers?: Record<string, {
      command?: string;
      args?: string[];
      cwd?: string;
      url?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      enabledTools?: string[];
    }>;
  };
  expect(manifest).toMatchObject({
    name: kimiPluginId,
    skills: "./skills/",
    sessionStart: { skill: "prism-context" },
  });
  expect(manifest.mcpServers).toBeUndefined();
  expect(await pathExists(prismMcpServerPath(testPrismHome(), "kimi-pipeline-demo"))).toBe(true);
  expect(await pathExists(join(pluginOutputRoot, "mcp"))).toBe(false);
  const installed = JSON.parse(await readFile(join(kimiRoot, "plugins", "installed.json"), "utf8")) as {
    plugins?: Array<Record<string, unknown>>;
  };
  expect(installed.plugins).toContainEqual(expect.objectContaining({
    id: kimiPluginId,
    root: pluginOutputRoot,
    source: "local-path",
    enabled: true,
    originalSource: pluginRoot,
  }));
  // A user (or Kimi itself) edits the registration and adds their own plugin.
  // Prism's record is a desired-state region — the next compile restores it —
  // while foreign array members are never touched.
  await writeText(join(kimiRoot, "plugins", "installed.json"), `${JSON.stringify({
    version: 1,
    plugins: [
      {
        id: kimiPluginId,
        root: pluginOutputRoot,
        source: "local-path",
        enabled: false,
        installedAt: "2026-05-30T00:00:00.000Z",
        originalSource: pluginRoot,
      },
      {
        id: "user-plugin",
        root: "/tmp/user-plugin",
        source: "local-path",
        enabled: true,
        installedAt: "2026-05-29T00:00:00.000Z",
        futureField: { preserved: true },
      },
    ],
  }, null, 2)}\n`);

  const roleSkill = await readFile(join(pluginOutputRoot, "skills", "prism-agent-worker", "SKILL.md"), "utf8");
  expect(roleSkill).toContain("name: \"prism-agent-worker\"");
  expect(roleSkill).toContain("<!-- prism:kimi-agent-role -->");
  expect(roleSkill).toContain(`\`${qualifiedKimiToolName}\``);
  expect(await pathExists(join(pluginOutputRoot, "skills", "testing", "SKILL.md"))).toBe(true);
  expect(await pathExists(join(pluginOutputRoot, "skills", "delivery", "SKILL.md"))).toBe(true);
  expect(await pathExists(join(pluginOutputRoot, "skills", "prism-command-review", "SKILL.md"))).toBe(true);
  expect(await readFile(join(pluginOutputRoot, "skills", "prism-context", "SKILL.md"), "utf8")).toContain("Kimi context");
  expect(await readFile(prismMcpServerPath(testPrismHome(), "kimi-pipeline-demo"), "utf8")).toContain("kimi_pipeline_demo_submit_work");

  const config = await readFile(join(kimiRoot, "config.toml"), "utf8");
  expect(config).toContain("# --- prism:kimi.hooks.kimi-pipeline-demo begin ---");
  expect(config).toContain('event = "PreToolUse"');
  expect(config).toContain('matcher = "Read"');
  expect(config).toContain(`matcher = "${qualifiedKimiToolName}"`);
  expect(config).toContain("audit-submit.mjs");

  const directHookProcess = Bun.spawn({
    cmd: [process.execPath, join(pluginOutputRoot, "hooks", "audit-read.mjs")],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  directHookProcess.stdin.write(JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { block: true },
    session_id: "session-1",
    cwd: pluginRoot,
  }));
  directHookProcess.stdin.end();
  const [directHookExit, directHookStdout, directHookStderr] = await Promise.all([
    directHookProcess.exited,
    new Response(directHookProcess.stdout).text(),
    new Response(directHookProcess.stderr).text(),
  ]);
  expect(directHookExit).toBe(2);
  expect(directHookStdout).toBe("");
  expect(directHookStderr.trim()).toBe("blocked");

  const canonicalHookProcess = Bun.spawn({
    cmd: [process.execPath, join(pluginOutputRoot, "hooks", "audit-submit.mjs")],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  canonicalHookProcess.stdin.write(JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: qualifiedKimiToolName,
    tool_input: { summary: "done" },
    session_id: "session-2",
    cwd: pluginRoot,
  }));
  canonicalHookProcess.stdin.end();
  const [canonicalHookExit, canonicalHookStdout, canonicalHookStderr] = await Promise.all([
    canonicalHookProcess.exited,
    new Response(canonicalHookProcess.stdout).text(),
    new Response(canonicalHookProcess.stderr).text(),
  ]);
  expect(canonicalHookExit).toBe(2);
  expect(canonicalHookStdout).toBe("");
  expect(canonicalHookStderr.trim()).toBe("canonical-blocked");

  const warmCompile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "kimi-code",
      scope: "global",
      root: kimiRoot,
      dryRun: false,
      emitWorkflowRefs: false,
    }),
  );
  expect(warmCompile.operations.filter(
    (operation) => operation.kind === "create" || operation.kind === "repair",
  )).toEqual([]);
  expect(warmCompile.operations.some((operation) => operation.kind === "skip")).toBe(true);
  // The user's edit to Prism's installed.json record drifts from desired
  // state — source is canonical, so the region is rewritten.
  expect(warmCompile.operations.some(
    (operation) =>
      operation.kind === "patch-regions" &&
      operation.targetPath === join(kimiRoot, "plugins", "installed.json"),
  )).toBe(true);
  const warmConfig = await readFile(join(kimiRoot, "config.toml"), "utf8");
  expect(warmConfig).toBe(config);
  expect(warmConfig.match(/prism:kimi\.hooks\.kimi-pipeline-demo begin/g) ?? []).toHaveLength(1);
  const warmInstalled = JSON.parse(await readFile(join(kimiRoot, "plugins", "installed.json"), "utf8")) as {
    plugins?: Array<Record<string, unknown>>;
  };
  expect(warmInstalled.plugins).toContainEqual(expect.objectContaining({
    id: kimiPluginId,
    enabled: true,
    originalSource: pluginRoot,
  }));
  expect(warmInstalled.plugins).toContainEqual(expect.objectContaining({
    id: "user-plugin",
    futureField: { preserved: true },
  }));

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "kimi-pipeline-demo",
        version: "0.1.0",
        targets: {},
      },
      null,
      2,
    )}\n`,
  );
  const pruneCompile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "kimi-code",
      scope: "global",
      root: kimiRoot,
      dryRun: false,
      emitWorkflowRefs: false,
    }),
  );
  expect(pruneCompile.operations.some((operation) =>
    operation.kind === "prune" &&
    operation.targetPath.startsWith(pluginOutputRoot)
  )).toBe(true);
  expect(await directoryExists(pluginOutputRoot)).toBe(false);
  expect(await readFile(join(kimiRoot, "config.toml"), "utf8")).not.toContain("prism:kimi.hooks");
  const prunedInstalled = JSON.parse(await readFile(join(kimiRoot, "plugins", "installed.json"), "utf8")) as {
    plugins?: Array<Record<string, unknown>>;
  };
  expect(prunedInstalled.plugins).toEqual([
    {
      id: "user-plugin",
      root: "/tmp/user-plugin",
      source: "local-path",
      enabled: true,
      installedAt: "2026-05-29T00:00:00.000Z",
      futureField: { preserved: true },
    },
  ]);
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

test.skip("compilePluginForTarget keeps Factory agent dependency tools owner-owned (MCP excised)", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "factory-http-agent-demo");
  const coreRoot = join(root, "factory-tool-core");
  const factoryRoot = join(root, "factory-root");
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

export default {
  name: "submit-work",
  description: "Submit completed Factory work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input) {
    return { acknowledged: true };
  },
};
`,
  );
  await writeText(
    join(coreRoot, "traits", "submittable.trait.ts"),
    `
export default {
  name: "submittable",
  description: "Can submit work",
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
};
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
    `
export default {
  name: "worker",
  description: "Factory worker",
  identity: "worker",
  traits: ["core:submittable"],
  targets: {
    "factory-droid": {
      model: "inherit",
    },
  },
};
`,
  );

  const ownerCompiled = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: coreRoot,
      target: "factory-droid",
      scope: "global",
      root: factoryRoot,
      dryRun: false,
    }),
  );

  const consumerCompiled = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "factory-droid",
      scope: "global",
      root: factoryRoot,
      dryRun: false,
    }),
  );

  expect(await pathExists(prismMcpServerPath(testPrismHome(), "factory-http-agent-demo"))).toBe(false);
  expect(consumerCompiled.operations.some((operation) =>
    operation.targetPath.endsWith("server.mjs")
  )).toBe(false);

  // A pure consumer owns no bindings, so it gets NO MCP server entry at all
  // under the per-plugin scheme — the owner's own bundle carries the server.
  const consumerMcpPath = join(
    factoryRoot,
    "plugins",
    "prism-generated-factory-http-agent-demo",
    "mcp.json",
  );
  expect(await pathExists(consumerMcpPath)).toBe(false);

  // The owner bundle carries the agent-bound dependency tool and lives at
  // the canonical PRISM_HOME path; the consumer does not duplicate it.
  const bundleContent = await readFile(
    prismMcpServerPath(testPrismHome(), "factory-tool-core"),
    "utf8",
  );
  expect(bundleContent).toContain("factory_tool_core_submit_work");
  expect(ownerCompiled.operations.some((operation) =>
    operation.targetPath.endsWith("server.mjs")
  )).toBe(false);
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
    `
export default {
  name: "template",
  description: "Template-only Factory orbit.",
  parameters: [{ name: "topic" }],
  phases: [{ name: "Work on \${topic}" }],
};
`,
  );
  const staleTarget = join(generatedRoot, "droids", "stale.md");
  const staleContent = "---\nname: stale\n---\n";
  await writeText(staleTarget, staleContent);
  await commitSnapshot({
    prismHome: testPrismHome(),
    manifest: {
      version: 1,
      harness: "factory-droid",
      root: join(projectRoot, ".factory"),
      entries: [{
        targetPath: staleTarget,
        contentHash: computeContentHash(staleContent),
        mode: "owned",
        plugin: "factory-source-only",
      }],
    },
  });

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "factory-droid",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.operations).toContainEqual(
    expect.objectContaining({
      kind: "prune",
      targetPath: staleTarget,
    }),
  );
  expect(await directoryExists(generatedRoot)).toBe(false);
  const factorySnapshot = await readSnapshot({
    prismHome: testPrismHome(),
    harness: "factory-droid",
    root: join(projectRoot, ".factory"),
  });
  expect(factorySnapshot.manifest.entries).toHaveLength(0);
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
    `
export default {
  name: "delivery",
  description: "Concrete Factory orbit.",
  phases: [{ name: "Deliver" }],
};
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
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
  // inherits all built-ins + wired MCP. Claude's `tools:` is an exclusive allowlist that would
  // otherwise strip Read/Write/Bash. See composeAgentFrontmatter in lowerers/claude-code.ts.
  expect(claudeAgent).not.toContain("tools:");
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
        prismHome: testPrismHome(),
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

export default {
  name: "echo",
  description: "Echo input",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  async handle(input) {
    return input;
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "traits", "echoer.trait.ts"),
    `
export default {
  name: "echoer",
  tools: {
    echo: { ref: "echo" },
  },
  require: { tools: ["echo"] },
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `
export default {
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["echoer"],
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
      prismHome: testPrismHome(),
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
    `import { agentRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default {
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
};
`,
  );

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
        workflow: {
          when: "Use a workflow when build work can be decomposed into deterministic agent tasks.",
          inputs: ["Committed work contract", "Current repository state"],
          outputs: ["Atomic commit", "Validation evidence"],
          sequence: ["Implement", "Validate", "Commit", "Review commit range"],
          coordination: "Builders commit the work unit before review starts.",
          finish_criteria: ["Focused validation passed", "Working tree is clean"],
          escalation: "Escalate if the task needs human taste or authority.",
        },
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
  expect(skill).toContain("- **Workflow trigger**: Use a workflow when build work");
  expect(skill).toContain("- **Workflow sequence**: Implement; Validate; Commit; Review commit range");
  expect(skill).toContain("- **Workflow finish criteria**: Focused validation passed; Working tree is clean");
  expect(skill).toContain("- **Input**: One committed glyph.");
  expect(skill).toContain("- **Reference**: see `references/build.md`");
});

test("derived orbit phase references render when body or workflow is present", async () => {
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
        name: "build",
        agents: [],
        requires: [],
        workflow: {
          when: "The phase needs repeatable agent execution.",
          inputs: ["Prepared task"],
          outputs: ["Reviewed outcome"],
          sequence: ["Run builder", "Run reviewer"],
          coordination: "Reviewers inspect explicit output, not ambient state.",
          finish_criteria: ["Output schema decodes"],
          escalation: "Stop if the workflow cannot observe the result.",
        },
      },
      {
        name: "commit",
        agents: [],
        requires: [],
        // No body or workflow — should produce no reference file.
      },
    ],
    tool_permissions: [],
    pulsar_checkpoints: [],
    body: "",
  });

  const refs = renderDerivedOrbitPhaseReferences(orbit);
  expect(refs).toHaveLength(2);
  expect(refs[0]?.filename).toBe("explore.md");
  expect(refs[0]?.content).toContain("# phase-refs:explore");
  expect(refs[0]?.content).toContain("## Telos");
  expect(refs[0]?.content).toContain("Reduce ambiguity");
  expect(refs[0]?.content).toContain("## Real-world change");
  expect(refs[0]?.content).toContain("## Cold-pickup test");
  expect(refs[0]?.content).toContain("## What good explore produces");
  expect(refs[1]?.filename).toBe("build.md");
  expect(refs[1]?.content).toContain("# phase-refs:build");
  expect(refs[1]?.content).toContain("## Workflow");
  expect(refs[1]?.content).toContain("### Sequence");
  expect(refs[1]?.content).toContain("- Run builder");
  expect(refs[1]?.content).toContain("### Finish criteria");
  expect(refs[1]?.content).toContain("- Output schema decodes");
  expect(refs[1]?.content).not.toContain("# phase-refs:commit");
});

test("orbit body declared in TS source flows into the generated orbit skill", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const declaredBody = "## The Orbit Principle\n\nForge is a routing utility, not the work.\n";

  await writeText(
    join(pluginRoot, "orbits", "delivery-contract.orbit.ts"),
    `import { agentRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default {
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
};
`,
  );

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
        workflow: {
          when: "Use when ${domain} can run as a workflow.",
          inputs: ["${domain} request"],
          outputs: ["${domain} result"],
          sequence: ["Plan ${domain}", "Build ${domain}", "Review ${domain}"],
          coordination: "Keep ${domain} boundaries explicit.",
          finish_criteria: ["${domain} validation passes"],
          escalation: "Escalate unclear ${domain} authority.",
        },
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
  expect(instantiated.phases[0]?.workflow?.when).toBe(
    "Use when Forge can run as a workflow.",
  );
  expect(instantiated.phases[0]?.workflow?.sequence).toEqual([
    "Plan Forge",
    "Build Forge",
    "Review Forge",
  ]);
  expect(instantiated.phases[0]?.workflow?.finish_criteria).toEqual([
    "Forge validation passes",
  ]);
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
    `import { agentRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default {
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
};
`,
  );

  // Parameterized orbits do not lower; only their templates exist. The
  // helper still gracefully describes them when invoked. Build a quick
  // unit-style invocation by compiling and asserting the skill is NOT emitted.
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
      prismHome: testPrismHome(),
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
      prismHome: testPrismHome(),
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
      prismHome: testPrismHome(),
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
      prismHome: testPrismHome(),
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
