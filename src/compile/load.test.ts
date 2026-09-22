import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Cause, Effect, Option, Schema } from "effect";
import type { CompileError } from "./errors.js";
import { loadPlugin, prepareImportWrapper } from "./load.js";
import type { PluginRegistry } from "./registry.js";
import type { Agent } from "./sources.js";
import { effectImportPath } from "../testing/prism-sandbox.js";

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

  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error("Expected typed load error");
  }

  return failure.value as CompileError;
};

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("workflow imports never reuse a transformed tree with stale prism refs", async () => {
  const root = await createTempRoot();
  await writeText(join(root, "plugin.json"), JSON.stringify({ name: "workflow-cache-fixture", version: "0.1.0" }));
  const sourcePath = join(root, "workflow.ts");
  await writeText(sourcePath, 'import { agents } from "prism/refs";\nexport default agents;\n');

  // Explicit prism home keeps the named-workers module generation (and any
  // generated-refs rewrite) inside the temp root instead of the real ~/.prism.
  const first = await prepareImportWrapper(sourcePath, { workflow: true, prismHome: root });
  const firstSource = await readFile(first.transformedPath, "utf8");
  await first.cleanup();

  const second = await prepareImportWrapper(sourcePath, { workflow: true, prismHome: root });
  try {
    const secondSource = await readFile(second.transformedPath, "utf8");
    expect(second.transformedPath).not.toBe(first.transformedPath);
    expect(secondSource).not.toBe(firstSource);
    expect(secondSource).toContain("/generated/sops.ts?t=");
  } finally {
    await second.cleanup();
  }
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
          tools: ["opencode"],
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
  skills: agent.skills,
  targets: agent.targets,
});

const sourceFamilySnapshot = (registry: PluginRegistry) => {
  const tool = registry.tools.get("submit_review");
  const hook = registry.hooks.get("session-start");
  const modelspace = registry.modelspaces.get("models");
  const skillspace = registry.skillspaces.get("global");
  return {
    tool: tool === undefined
      ? undefined
      : {
        name: tool.name,
        description: tool.description,
        inputIsSchema: Schema.isSchema(tool.input),
        outputIsSchema: Schema.isSchema(tool.output),
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
    `import type { AgentSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "builder",
  description: "Builds scoped changes.",
  identity: "builder",
  model: { kind: "model-profile-ref", modelspace: "models", name: "default" },
  skills: [{ kind: "skillspace-ref", skillspace: "global", name: "testing" }],
} satisfies AgentSource;
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const agent = registry.agents.get("builder");

  expect(agent).toBeDefined();
  expect(agent?.model).toBe("models/default");
  expect(agent?.skills).toEqual(["global/testing"]);
  expect(registry.tools.has("submit_review")).toBe(true);
  expect(registry.modelspaces.has("models")).toBe(true);
  expect(registry.skillspaces.has("global")).toBe(true);
  expect(registry.hooks.get("session-start")?.event).toBe("session.start");
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

test("deleted trait and toolspace source files are not loaded", async () => {
  const pluginRoot = await createTempRoot();
  await writeManifest(pluginRoot);
  await writeText(
    join(pluginRoot, "traits", "reviewable.trait.ts"),
    `export default {
  name: "reviewable",
  description: "Should not load.",
  tools: { submit_review: { ref: "submit_review" } },
};
`,
  );
  await writeText(
    join(pluginRoot, "toolspaces", "workspace.toolspace.ts"),
    `export default {
  name: "workspace",
  tools: { shell: { targets: { opencode: { name: "bash" } } } },
};
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  expect(registry.tools.size).toBe(0);
  expect("traits" in registry).toBe(false);
  expect("toolspaces" in registry).toBe(false);
});

test("helper-based and noun-first agent sources produce equivalent normalized objects", async () => {
  const helperRoot = await createTempRoot();
  const nounRoot = await createTempRoot();
  await writeManifest(helperRoot);
  await writeManifest(nounRoot);

  await writeText(
    join(helperRoot, "agents", "builder.agent.ts"),
    `import { modelProfileRef, skillspaceRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "builder",
  description: "Builds scoped changes.",
  identity: "builder",
  model: modelProfileRef("models", "default"),
  skills: [skillspaceRef("global", "testing")],
  targets: { opencode: { mode: "primary" } },
};
`,
  );
  await writeText(
    join(nounRoot, "agents", "builder.agent.ts"),
    `export default {
  name: "builder",
  description: "Builds scoped changes.",
  identity: "builder",
  model: { kind: "model-profile-ref", modelspace: "models", name: "default" },
  skills: [{ kind: "skillspace-ref", skillspace: "global", name: "testing" }],
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

const writeSopManifest = (pluginRoot: string, name: string): Promise<void> =>
  writeText(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        targets: { sops: ["claude-code"] },
      },
      null,
      2,
    ),
  );

test("loadPlugin loads a sop source with validated typed phase IO", async () => {
  const pluginRoot = await createTempRoot();
  await writeSopManifest(pluginRoot, "sop-fixture");
  await writeText(
    join(pluginRoot, "sops", "beacon.sop.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import type { SopSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "beacon",
  description: "Marketing method.",
  phases: [
    {
      name: "explore",
      purpose: "Map the space.",
      input: Schema.Struct({ brief: Schema.String }),
      output: Schema.Struct({ summary: Schema.String }),
      acceptance_criteria: ["Hypothesis is falsifiable"],
      escalation: "Ask a human when the audience is unclear",
      body: "## Steps\\n\\nDo the work.",
    },
    {
      name: "build",
      purpose: "Build the artifact.",
      body: "Write it.",
    },
  ],
  body: "Cross-phase frame.",
} satisfies SopSource;
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const sop = registry.sops.get("beacon");

  expect(sop).toBeDefined();
  expect(sop?.description).toBe("Marketing method.");
  expect(sop?.body).toBe("Cross-phase frame.");
  expect(sop?.phases.map((phase) => phase.name)).toEqual(["explore", "build"]);
  expect(sop?.phases[0]?.acceptanceCriteria).toEqual(["Hypothesis is falsifiable"]);
  expect(sop?.phases[0]?.escalation).toBe("Ask a human when the audience is unclear");
  expect(Schema.isSchema(sop?.phases[0]?.input)).toBe(true);
  expect(Schema.isSchema(sop?.phases[0]?.output)).toBe(true);
  expect(sop?.phases[1]?.input).toBeUndefined();
  expect(sop?.phases[1]?.body).toBe("Write it.");
});

test("loadPlugin rejects sop non-schema phase IO", async () => {
  const pluginRoot = await createTempRoot();
  await writeSopManifest(pluginRoot, "bad-sop-io");
  await writeText(
    join(pluginRoot, "sops", "beacon.sop.ts"),
    `export default {
  name: "beacon",
  description: "Bad IO.",
  phases: [{ name: "explore", purpose: "P", input: { type: "object" }, body: "b" }],
};
`,
  );

  const exit = await Effect.runPromiseExit(loadPlugin(pluginRoot));
  const failure = getFailure(exit);
  expect(failure._tag).toBe("SourceParseError");
  expect((failure as { readonly message: string }).message).toContain(
    "phases[0].input: must be an Effect Schema",
  );
});

test("loadPlugin rejects forbidden executor fields in sop sources with remediation", async () => {
  const pluginRoot = await createTempRoot();
  await writeSopManifest(pluginRoot, "bad-sop-field");
  await writeText(
    join(pluginRoot, "sops", "beacon.sop.ts"),
    `export default {
  name: "beacon",
  description: "Bad field.",
  phases: [{ name: "explore", purpose: "P", body: "b", agents: ["builder"] }],
};
`,
  );

  const exit = await Effect.runPromiseExit(loadPlugin(pluginRoot));
  const failure = getFailure(exit);
  expect(failure._tag).toBe("SourceParseError");
  expect((failure as { readonly message: string }).message).toContain(
    "phases[0].agents: is not part of the SOP phase schema",
  );
});

test("loadPlugin rejects sop names that are not valid skill names or do not match the stem", async () => {
  const mismatchRoot = await createTempRoot();
  await writeSopManifest(mismatchRoot, "mismatch-sop");
  await writeText(
    join(mismatchRoot, "sops", "beacon.sop.ts"),
    `export default {
  name: "signal",
  description: "Mismatch.",
  phases: [{ name: "explore", purpose: "P", body: "b" }],
};
`,
  );

  const mismatchExit = await Effect.runPromiseExit(loadPlugin(mismatchRoot));
  const mismatchFailure = getFailure(mismatchExit);
  expect(mismatchFailure._tag).toBe("SourceParseError");
  expect((mismatchFailure as { readonly message: string }).message).toContain(
    "sop 'name' field ('signal') must match file stem ('beacon')",
  );

  const badNameRoot = await createTempRoot();
  await writeSopManifest(badNameRoot, "bad-sop-name");
  await writeText(
    join(badNameRoot, "sops", "BadName.sop.ts"),
    `export default {
  name: "BadName",
  description: "Bad name.",
  phases: [{ name: "explore", purpose: "P", body: "b" }],
};
`,
  );

  const nameExit = await Effect.runPromiseExit(loadPlugin(badNameRoot));
  const nameFailure = getFailure(nameExit);
  expect(nameFailure._tag).toBe("SourceParseError");
  expect((nameFailure as { readonly message: string }).message).toContain(
    "must be a valid skill name",
  );
});

test("loadPlugin discovers only sops/*.sop.ts files in the sops directory", async () => {
  const pluginRoot = await createTempRoot();
  await writeSopManifest(pluginRoot, "sop-discovery");
  await writeText(
    join(pluginRoot, "sops", "beacon.sop.ts"),
    `export default {
  name: "beacon",
  description: "Beacon.",
  phases: [{ name: "explore", purpose: "P", body: "b" }],
};
`,
  );
  await writeText(
    join(pluginRoot, "sops", "helper.ts"),
    `export const ignored = true;\n`,
  );
  await writeText(
    join(pluginRoot, "sops", "not-a-sop.md"),
    `# ignored\n`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  expect([...registry.sops.keys()]).toEqual(["beacon"]);
});
