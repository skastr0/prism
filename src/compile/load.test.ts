import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Cause, Effect, Option, Schema } from "effect";
import type { CompileError } from "./errors.js";
import { loadPlugin } from "./load.js";
import type { PluginRegistry } from "./registry.js";
import type { Agent } from "./sources.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-load-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const getFailure = (
  exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>,
): CompileError => {
  if (exit._tag !== "Failure") {
    throw new Error("Expected load to fail");
  }

  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error("Expected typed load error");
  }

  return failure.value as CompileError;
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

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const writeManifest = (pluginRoot: string): Promise<void> =>
  writeText(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "noun-first-fixture",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          orbits: ["opencode"],
          tools: ["opencode"],
          toolspaces: ["opencode"],
          modelspaces: ["opencode"],
          skillspaces: ["opencode"],
          hooks: ["opencode"],
        },
      },
      null,
      2,
    ),
  );

const writeSharedNounSources = async (pluginRoot: string): Promise<void> => {
  await writeManifest(pluginRoot);
  await writeText(
    join(pluginRoot, "schemas.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export const VerdictSchema = Schema.Struct({ summary: Schema.String });
`,
  );
  await writeText(
    join(pluginRoot, "traits", "reviewable.trait.ts"),
    `export default {
  name: "reviewable",
  description: "Can review work.",
  instructions: ["Review the implementation."],
  tools: { submit_review: { ref: "submit_review" } },
};
`,
  );
  await writeText(
    join(pluginRoot, "tools", "submit_review.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "submit_review",
  description: "Submit review findings.",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle() {
    return { acknowledged: true };
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "toolspaces", "workspace.toolspace.ts"),
    `export default {
  name: "workspace",
  description: "Workspace tool bindings.",
  tools: {
    run_shell: {
      description: "Run a shell command.",
      targets: { opencode: { name: "bash" } },
    },
  },
  groups: {
    repo: {
      description: "Repository tools.",
      tools: [{ kind: "tool-ref", toolspace: "workspace", name: "run_shell" }],
    },
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "modelspaces", "models.modelspace.ts"),
    `export default {
  name: "models",
  description: "Model bindings.",
  profiles: {
    default: {
      description: "Default model.",
      targets: { opencode: { model: "openai/gpt-5" } },
    },
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "global.skillspace.ts"),
    `export default {
  name: "global",
  description: "Global skills.",
  skills: {
    testing: {
      description: "Testing skill.",
      targets: { opencode: { name: "testing" } },
    },
  },
};
`,
  );
  await writeText(
    join(pluginRoot, "orbits", "delivery.orbit.ts"),
    `export default {
  name: "delivery",
  description: "Delivery orbit.",
  phases: [{
    name: "Build",
    agents: [{ kind: "agent-ref", name: "builder" }],
    requires: [{ all: [{ kind: "trait-ref", name: "reviewable" }] }],
  }],
};
`,
  );
  await writeText(
    join(pluginRoot, "hooks", "session-start.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};

export default {
  name: "session-start",
  event: "session.start",
  handle: () => Effect.succeed({ decision: "continue" }),
};
`,
  );
};

const agentSnapshot = (agent: Agent) => ({
  name: agent.name,
  description: agent.description,
  identity: agent.identity,
  model: agent.model,
  traits: agent.traits.map((trait) => ({
    ref: trait.ref,
    tools: Object.fromEntries(
      Object.entries(trait.tools).map(([toolName, tool]) => [
        toolName,
        {
          slots: Object.fromEntries(
            Object.entries(tool.slots).map(([slotName, slot]) => [
              slotName,
              {
                isSchema: Schema.isSchema(slot.schema),
                source: {
                  sourcePath: slot.source.sourcePath.endsWith("schemas.ts")
                    ? "<plugin>/schemas.ts"
                    : slot.source.sourcePath,
                  exportName: slot.source.exportName,
                },
              },
            ]),
          ),
        },
      ]),
    ),
  })),
  access: agent.access,
  skills: agent.skills,
  targets: agent.targets,
});

const sourceFamilySnapshot = (registry: PluginRegistry) => {
  const tool = registry.tools.get("submit_review");
  const hook = registry.hooks.get("session-start");
  const trait = registry.traits.get("reviewable");
  const toolspace = registry.toolspaces.get("workspace");
  const modelspace = registry.modelspaces.get("models");
  const skillspace = registry.skillspaces.get("global");
  const orbit = registry.orbits.get("delivery");
  return {
    trait: trait === undefined
      ? undefined
      : {
        name: trait.name,
        description: trait.description,
        instructions: trait.instructions,
        tools: trait.tools,
        access: trait.access,
        inject: trait.inject,
        require: trait.require,
      },
    tool: tool === undefined
      ? undefined
      : {
        name: tool.name,
        description: tool.description,
        inputIsSchema: Schema.isSchema(tool.input),
        outputIsSchema: Schema.isSchema(tool.output),
      },
    toolspace: toolspace === undefined
      ? undefined
      : {
        name: toolspace.name,
        description: toolspace.description,
        tools: toolspace.tools,
        groups: toolspace.groups,
      },
    modelspace: modelspace === undefined
      ? undefined
      : {
        name: modelspace.name,
        description: modelspace.description,
        profiles: modelspace.profiles,
      },
    skillspace: skillspace === undefined
      ? undefined
      : {
        name: skillspace.name,
        description: skillspace.description,
        skills: skillspace.skills,
      },
    orbit: orbit === undefined
      ? undefined
      : {
        name: orbit.name,
        description: orbit.description,
        phases: orbit.phases,
        tool_permissions: orbit.tool_permissions,
      },
    hook: hook === undefined
      ? undefined
      : {
        name: hook.name,
        event: hook.event,
      },
  };
};

test("loadPlugin loads default-exported noun source objects across source families", async () => {
  const pluginRoot = await createTempRoot();
  await writeSharedNounSources(pluginRoot);
  await writeText(
    join(pluginRoot, "agents", "builder.agent.ts"),
    `import { VerdictSchema } from "../schemas";
import type { AgentSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "builder",
  description: "Builds scoped changes.",
  identity: "builder",
  model: { kind: "model-profile-ref", modelspace: "models", name: "default" },
  traits: [{
    trait: { kind: "trait-ref", name: "reviewable" },
    tools: { submit_review: { slots: { verdict: VerdictSchema } } },
  }],
  access: {
    tools: [{ kind: "tool-ref", toolspace: "workspace", name: "run_shell" }],
    toolGroups: [{ kind: "tool-group-ref", toolspace: "workspace", name: "repo" }],
    skills: [{ kind: "skillspace-ref", skillspace: "global", name: "testing" }],
  },
} satisfies AgentSource;
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const agent = registry.agents.get("builder");

  expect(agent).toBeDefined();
  expect(agent?.model).toBe("models/default");
  expect(agent?.access).toEqual({
    tools: ["workspace/run_shell"],
    toolGroups: ["workspace#repo"],
    skills: ["global/testing"],
  });
  expect(agent?.traits[0]?.ref).toBe("reviewable");
  const slot = agent?.traits[0]?.tools.submit_review?.slots.verdict;
  expect(slot && Schema.isSchema(slot.schema)).toBe(true);
  expect(slot?.source).toEqual({
    sourcePath: join(pluginRoot, "schemas.ts"),
    exportName: "VerdictSchema",
  });
  expect(registry.traits.has("reviewable")).toBe(true);
  expect(registry.tools.has("submit_review")).toBe(true);
  expect(registry.toolspaces.get("workspace")?.groups.repo?.tools).toEqual([
    "workspace/run_shell",
  ]);
  expect(registry.modelspaces.has("models")).toBe(true);
  expect(registry.skillspaces.has("global")).toBe(true);
  expect(registry.orbits.get("delivery")?.phases[0]?.agents).toEqual(["builder"]);
  expect(registry.hooks.get("session-start")?.event).toBe("session.start");
});

test("noun-first trait binding aliases preserve imported slot provenance", async () => {
  const pluginRoot = await createTempRoot();
  await writeManifest(pluginRoot);
  await writeText(
    join(pluginRoot, "schemas.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export const VerdictSchema = Schema.Struct({ summary: Schema.String });
`,
  );
  await writeText(
    join(pluginRoot, "agents", "builder.agent.ts"),
    `import { VerdictSchema } from "../schemas";

const reviewBinding = {
  trait: "reviewable",
  tools: { submit_review: { slots: { verdict: VerdictSchema } } },
};

export default {
  name: "builder",
  description: "Builds scoped changes.",
  identity: "builder",
  traits: [reviewBinding],
};
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const slot = registry.agents.get("builder")?.traits[0]?.tools.submit_review?.slots.verdict;

  expect(slot && Schema.isSchema(slot.schema)).toBe(true);
  expect(slot?.source).toEqual({
    sourcePath: join(pluginRoot, "schemas.ts"),
    exportName: "VerdictSchema",
  });
});

test("noun-first trait bindings reject inline slot schemas with field provenance", async () => {
  const pluginRoot = await createTempRoot();
  await writeManifest(pluginRoot);
  await writeText(
    join(pluginRoot, "agents", "builder.agent.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "builder",
  description: "Builds scoped changes.",
  identity: "builder",
  traits: [{
    trait: "reviewable",
    tools: {
      submit_review: {
        slots: { verdict: Schema.Struct({ summary: Schema.String }) },
      },
    },
  }],
};
`,
  );

  const exit = await Effect.runPromiseExit(loadPlugin(pluginRoot));
  const failure = getFailure(exit);

  expect(failure.name).toBe("SourceParseError");
  expect(failure.message).toContain("traits[0].tools.submit_review.slots.verdict");
  expect(failure.message).toContain("must be an imported schema identifier");
});

test("hook match.tool is accepted on tool.failure and rejected on non-tool events", async () => {
  const okRoot = await createTempRoot();
  await writeManifest(okRoot);
  await writeText(
    join(okRoot, "hooks", "failure-audit.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};

export default {
  name: "failure-audit",
  event: "tool.failure",
  match: { tool: { kind: "hook-any-tool" } },
  handle: () => Effect.succeed({ decision: "continue" }),
};
`,
  );
  const okRegistry = await Effect.runPromise(loadPlugin(okRoot));
  expect(okRegistry.hooks.get("failure-audit")?.event).toBe("tool.failure");

  const badRoot = await createTempRoot();
  await writeManifest(badRoot);
  await writeText(
    join(badRoot, "hooks", "prompt-audit.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};

export default {
  name: "prompt-audit",
  event: "prompt.submit",
  match: { tool: { kind: "hook-any-tool" } },
  handle: () => Effect.succeed({ decision: "continue" }),
};
`,
  );
  const exit = await Effect.runPromiseExit(loadPlugin(badRoot));
  const failure = getFailure(exit);
  expect(failure.name).toBe("SourceParseError");
  expect(failure.message).toContain("tool.failure");
});

test("helper-based and noun-first agent sources produce equivalent normalized objects", async () => {
  const helperRoot = await createTempRoot();
  const nounRoot = await createTempRoot();
  await writeManifest(helperRoot);
  await writeManifest(nounRoot);
  for (const pluginRoot of [helperRoot, nounRoot]) {
    await writeText(
      join(pluginRoot, "schemas.ts"),
      `import { Schema } from ${JSON.stringify(effectImportPath)};

export const VerdictSchema = Schema.Struct({ summary: Schema.String });
`,
    );
  }

  await writeText(
    join(helperRoot, "agents", "builder.agent.ts"),
    `import { bindTrait, modelProfileRef, skillspaceRef, toolGroupRef, toolRef } from ${JSON.stringify(prismImportPath)};
import { VerdictSchema } from "../schemas";

export default {
  name: "builder",
  description: "Builds scoped changes.",
  identity: "builder",
  model: modelProfileRef("models", "default"),
  traits: [bindTrait("reviewable", {
    tools: { submit_review: { slots: { verdict: VerdictSchema } } },
  })],
  access: {
    tools: [toolRef("workspace", "run_shell")],
    toolGroups: [toolGroupRef("workspace", "repo")],
    skills: [skillspaceRef("global", "testing")],
  },
  targets: { opencode: { mode: "primary" } },
};
`,
  );
  await writeText(
    join(nounRoot, "agents", "builder.agent.ts"),
    `import { VerdictSchema } from "../schemas";

export default {
  name: "builder",
  description: "Builds scoped changes.",
  identity: "builder",
  model: { kind: "model-profile-ref", modelspace: "models", name: "default" },
  traits: [{
    trait: "reviewable",
    tools: { submit_review: { slots: { verdict: VerdictSchema } } },
  }],
  access: {
    tools: [{ kind: "tool-ref", toolspace: "workspace", name: "run_shell" }],
    toolGroups: [{ kind: "tool-group-ref", toolspace: "workspace", name: "repo" }],
    skills: [{ kind: "skillspace-ref", skillspace: "global", name: "testing" }],
  },
  targets: { opencode: { mode: "primary" } },
};
`,
  );

  const helperRegistry = await Effect.runPromise(loadPlugin(helperRoot));
  const nounRegistry = await Effect.runPromise(loadPlugin(nounRoot));

  expect(agentSnapshot(helperRegistry.agents.get("builder")!)).toEqual(
    agentSnapshot(nounRegistry.agents.get("builder")!),
  );
});

test("helper-based and noun-first non-agent source families produce equivalent normalized objects", async () => {
  const helperRoot = await createTempRoot();
  const nounRoot = await createTempRoot();
  await writeManifest(helperRoot);
  await writeSharedNounSources(nounRoot);

  await writeText(
    join(helperRoot, "traits", "reviewable.trait.ts"),
    `
export default {
  name: "reviewable",
  description: "Can review work.",
  instructions: ["Review the implementation."],
  tools: { submit_review: { ref: "submit_review" } },
};
`,
  );
  await writeText(
    join(helperRoot, "tools", "submit_review.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "submit_review",
  description: "Submit review findings.",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle() {
    return { acknowledged: true };
  },
};
`,
  );
  await writeText(
    join(helperRoot, "toolspaces", "workspace.toolspace.ts"),
    `import { toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "workspace",
  description: "Workspace tool bindings.",
  tools: {
    run_shell: {
      description: "Run a shell command.",
      targets: { opencode: { name: "bash" } },
    },
  },
  groups: {
    repo: {
      description: "Repository tools.",
      tools: [toolRef("workspace", "run_shell")],
    },
  },
};
`,
  );
  await writeText(
    join(helperRoot, "modelspaces", "models.modelspace.ts"),
    `
export default {
  name: "models",
  description: "Model bindings.",
  profiles: {
    default: {
      description: "Default model.",
      targets: { opencode: { model: "openai/gpt-5" } },
    },
  },
};
`,
  );
  await writeText(
    join(helperRoot, "skillspaces", "global.skillspace.ts"),
    `
export default {
  name: "global",
  description: "Global skills.",
  skills: {
    testing: {
      description: "Testing skill.",
      targets: { opencode: { name: "testing" } },
    },
  },
};
`,
  );
  await writeText(
    join(helperRoot, "orbits", "delivery.orbit.ts"),
    `import { agentRef, traitRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "delivery",
  description: "Delivery orbit.",
  phases: [{
    name: "Build",
    agents: [agentRef("builder")],
    requires: [{ all: [traitRef("reviewable")] }],
  }],
};
`,
  );
  await writeText(
    join(helperRoot, "hooks", "session-start.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-start",
  event: hookEvent.sessionStart,
  handle: () => Effect.succeed({ decision: "continue" }),
};
`,
  );

  const helperRegistry = await Effect.runPromise(loadPlugin(helperRoot));
  const nounRegistry = await Effect.runPromise(loadPlugin(nounRoot));

  expect(sourceFamilySnapshot(helperRegistry)).toEqual(sourceFamilySnapshot(nounRegistry));
});
