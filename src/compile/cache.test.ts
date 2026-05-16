import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import {
  CACHE_FORMAT_VERSION,
  COMPILER_SEMANTICS_VERSION,
  computeAgentCacheDescriptor,
  computeCacheKey,
  computeContextHash,
  computeContentHash,
  computeStableHash,
  type CacheInputFile,
} from "./cache.js";
import { emptyRegistry } from "./registry.js";
import {
  Agent,
  CanonicalTool,
  Identity,
  Modelspace,
  Personality,
  Skill,
  Skillspace,
  Toolspace,
  Trait,
} from "./sources.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-cache-test-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("compile cache keys include compiler semantic version", () => {
  const contextShape = JSON.stringify({
    cacheFormatVersion: CACHE_FORMAT_VERSION,
    compilerSemanticsVersion: COMPILER_SEMANTICS_VERSION,
    scope: "global",
    target: "opencode",
  });

  const expectedContextHash = createHash("sha256")
    .update(contextShape)
    .digest("hex");
  expect(computeContextHash({ target: "opencode", scope: "global" })).toBe(
    expectedContextHash,
  );

  const expectedKey = createHash("sha256")
    .update("source-hash")
    .update(contextShape)
    .digest("hex");
  expect(computeCacheKey("source-hash", { target: "opencode", scope: "global" })).toBe(
    expectedKey,
  );
});

test("agent cache descriptor preserves fingerprint and input semantics", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "main");
  const depRoot = join(root, "dep");
  const writeSource = async (
    pluginRoot: string,
    relativePath: string,
    content: string,
  ): Promise<string> => {
    const path = join(pluginRoot, relativePath);
    await writeText(path, content);
    return path;
  };

  const agentPath = await writeSource(pluginRoot, "agents/worker.agent.ts", "agent");
  const identityPath = await writeSource(
    pluginRoot,
    "identities/worker.identity.md",
    "identity",
  );
  const personalityPath = await writeSource(
    pluginRoot,
    "personalities/steady.personality.md",
    "personality",
  );
  const modelspacePath = await writeSource(
    pluginRoot,
    "modelspaces/default-models.modelspace.ts",
    "modelspace",
  );
  const traitPath = await writeSource(pluginRoot, "traits/reviewable.trait.ts", "trait");
  const toolspacePath = await writeSource(
    pluginRoot,
    "toolspaces/workspace.toolspace.ts",
    "toolspace",
  );
  const skillspacePath = await writeSource(
    pluginRoot,
    "skillspaces/external.skillspace.ts",
    "skillspace",
  );
  const managedSkillPath = await writeSource(
    pluginRoot,
    "skills/contracts/SKILL.md",
    "managed skill",
  );
  const depToolPath = await writeSource(depRoot, "tools/submit_review.tool.ts", "dep tool");
  const depSkillspacePath = await writeSource(
    depRoot,
    "skillspaces/external.skillspace.ts",
    "dep skillspace",
  );
  const depManagedSkillPath = await writeSource(
    depRoot,
    "skills/shared-skill/SKILL.md",
    "dep managed skill",
  );

  const registry = emptyRegistry(pluginRoot, "main", "0.1.0");
  const depRegistry = emptyRegistry(depRoot, "dep", "0.1.0");
  registry.deps.set("dep", depRegistry);

  registry.identities.set(
    "worker",
    new Identity({
      name: "worker",
      sourcePath: identityPath,
      description: "Worker identity",
      body: "# Worker",
    }),
  );
  registry.personalities.set(
    "steady",
    new Personality({
      name: "steady",
      sourcePath: personalityPath,
      description: "Steady personality",
      body: "# Steady",
    }),
  );
  registry.modelspaces.set(
    "default-models",
    new Modelspace({
      name: "default-models",
      sourcePath: modelspacePath,
      profiles: {
        builder: { targets: { opencode: { model: "claude" } } },
      },
    }),
  );
  registry.toolspaces.set(
    "workspace",
    new Toolspace({
      name: "workspace",
      sourcePath: toolspacePath,
      tools: {
        run: { targets: { opencode: "bash" } },
      },
      groups: {
        repo: { tools: ["workspace/run"] },
      },
    }),
  );
  registry.skillspaces.set(
    "external",
    new Skillspace({
      name: "external",
      sourcePath: skillspacePath,
      skills: {
        method: { targets: { opencode: { name: "method-opencode" } } },
      },
    }),
  );
  registry.skills.set(
    "contracts",
    new Skill({
      name: "contracts",
      sourcePath: managedSkillPath,
    }),
  );
  depRegistry.tools.set(
    "submit_review",
    new CanonicalTool({
      name: "submit_review",
      sourcePath: depToolPath,
      description: "Submit review",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      slots: {},
      async handle() {
        return {};
      },
    }),
  );
  depRegistry.skillspaces.set(
    "external",
    new Skillspace({
      name: "external",
      sourcePath: depSkillspacePath,
      skills: {
        testing: { targets: { opencode: { name: "testing-opencode" } } },
      },
    }),
  );
  depRegistry.skills.set(
    "shared-skill",
    new Skill({
      name: "shared-skill",
      sourcePath: depManagedSkillPath,
    }),
  );

  registry.traits.set(
    "reviewable",
    new Trait({
      name: "reviewable",
      sourcePath: traitPath,
      instructions: [],
      access: {
        tools: ["missing-space/tool"],
        toolGroups: ["workspace#repo"],
        skills: ["dep:external/testing"],
      },
      tools: {
        submit: { ref: "dep:submit_review" },
      },
      inject: { skills: ["dep:shared-skill"] },
      require: { tools: [], skills: ["missing-skill"] },
    }),
  );

  const traitBinding = { ref: "reviewable", tools: {} };
  const agent = new Agent({
    name: "worker",
    sourcePath: agentPath,
    description: "Worker agent",
    identity: "worker",
    personality: "steady",
    model: "default-models/builder",
    traits: [traitBinding],
    access: {
      tools: ["workspace/run"],
      toolGroups: ["workspace#repo"],
      skills: ["external/method"],
    },
    skills: ["contracts"],
    targets: {},
  });
  const peer = new Agent({
    name: "assistant",
    sourcePath: join(pluginRoot, "agents", "assistant.agent.ts"),
    description: "Assistant peer",
    identity: "worker",
    model: "default-models/builder",
    traits: [],
    access: { tools: [], toolGroups: [], skills: [] },
    skills: [],
    targets: {},
  });
  registry.agents.set("worker", agent);
  registry.agents.set("assistant", peer);

  const descriptor = await computeAgentCacheDescriptor(agent, registry, {
    target: "opencode",
    scope: "project",
  });

  const input = (plugin: string, path: string, content: string): CacheInputFile => ({
    plugin,
    path,
    contentHash: computeContentHash(content),
  });
  const resolved = (ref: string, plugin: string, path: string, content: string) => ({
    ref,
    plugin,
    path,
    contentHash: computeContentHash(content),
  });
  const missing = (ref: string) => ({ ref, missing: true as const });

  const agentInput = input("main", "agents/worker.agent.ts", "agent");
  const identity = resolved("worker", "main", "identities/worker.identity.md", "identity");
  const personality = resolved(
    "steady",
    "main",
    "personalities/steady.personality.md",
    "personality",
  );
  const model = resolved(
    "default-models/builder",
    "main",
    "modelspaces/default-models.modelspace.ts",
    "modelspace",
  );
  const traitSource = resolved("reviewable", "main", "traits/reviewable.trait.ts", "trait");
  const depTool = resolved("dep:submit_review", "dep", "tools/submit_review.tool.ts", "dep tool");
  const toolspace = resolved(
    "workspace/run",
    "main",
    "toolspaces/workspace.toolspace.ts",
    "toolspace",
  );
  const toolGroupSpace = resolved(
    "workspace#repo",
    "main",
    "toolspaces/workspace.toolspace.ts",
    "toolspace",
  );
  const depSkillspace = resolved(
    "dep:external/testing",
    "dep",
    "skillspaces/external.skillspace.ts",
    "dep skillspace",
  );
  const skillspace = resolved(
    "external/method",
    "main",
    "skillspaces/external.skillspace.ts",
    "skillspace",
  );
  const managedSkill = resolved("contracts", "main", "skills/contracts/SKILL.md", "managed skill");
  const depManagedSkill = resolved(
    "dep:shared-skill",
    "dep",
    "skills/shared-skill/SKILL.md",
    "dep managed skill",
  );

  const expectedFingerprint = {
    agent: agentInput,
    references: {
      identity,
      personality,
      model,
      modelPeers: [
        { name: "assistant", sourcePath: peer.sourcePath },
        { name: "worker", sourcePath: agent.sourcePath },
      ],
      traits: [
        {
          ref: "reviewable",
          binding: agent.traits[0],
          source: traitSource,
          tools: [depTool],
        },
      ],
      access: {
        tools: ["missing-space/tool", "workspace/run"],
        toolGroups: ["workspace#repo"],
        skills: ["dep:external/testing", "external/method"],
      },
      toolspaces: [missing("missing-space/tool"), toolspace, toolGroupSpace],
      skillspaces: [depSkillspace, skillspace],
      managedSkills: [managedSkill, depManagedSkill, missing("missing-skill")],
    },
  };
  const expectedSourceHash = computeStableHash(expectedFingerprint);
  const expectedInputs = [
    agentInput,
    identity,
    personality,
    model,
    traitSource,
    depTool,
    toolspace,
    skillspace,
    depSkillspace,
    managedSkill,
    depManagedSkill,
  ]
    .map(({ plugin, path, contentHash }) => ({ plugin, path, contentHash }))
    .sort((left, right) => {
      const pluginOrder = left.plugin.localeCompare(right.plugin);
      return pluginOrder === 0 ? left.path.localeCompare(right.path) : pluginOrder;
    });

  expect(descriptor.sourceHash).toBe(expectedSourceHash);
  expect(descriptor.contextHash).toBe(
    computeContextHash({ target: "opencode", scope: "project" }),
  );
  expect(descriptor.key).toBe(
    computeCacheKey(expectedSourceHash, { target: "opencode", scope: "project" }),
  );
  expect(descriptor.inputs).toEqual(expectedInputs);
  expect(descriptor.inputs.map((file) => `${file.plugin}:${file.path}`)).not.toContain(
    "main:missing-space/tool",
  );
  expect(descriptor.inputs.map((file) => `${file.plugin}:${file.path}`)).not.toContain(
    "main:missing-skill",
  );
});
