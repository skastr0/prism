import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readFile } from "../fs.js";
import type { AgentCacheDescriptor } from "./cache.js";
import {
  buildCompileManifestForTarget,
  commitCompileManifest,
  compileManifestPath,
  emptyCompileManifest,
  readCompileManifest,
  verifyCompileManifestHash,
} from "./compile-manifest.js";
import type { ComposedAgent } from "./compose.js";
import { emptyRegistry } from "./registry.js";
import { projectOrbitsForCompileManifest, validateOrbit } from "./resolve.js";
import { Modelspace } from "./sources.js";
import {
  addToRegistry,
  makeAgent,
  makeOrbit,
  makeRegistry,
} from "./test-support.js";

let home: string;
const projectKey = "test-project-key";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "prism-compile-manifest-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const registry = () => emptyRegistry("/tmp/forge", "forge", "1.0.0");

const registryWithModels = () => {
  const reg = registry();
  reg.modelspaces.set("models", new Modelspace({
    name: "models",
    sourcePath: "/tmp/forge/modelspaces/models.modelspace.ts",
    profiles: {
      builder: { targets: { opencode: { model: "builder-opencode" } } },
      unreferenced: { targets: { opencode: { model: "unreferenced-opencode" } } },
    },
  }));
  return reg;
};

const descriptorFor = (name: string, hash: string): AgentCacheDescriptor => ({
  key: `${name}-key`,
  sourceHash: hash,
  contextHash: `${name}-context`,
  inputs: [{ plugin: "forge", path: `agents/${name}.agent.ts`, contentHash: hash }],
});

const agent = (name: string, hash: string, tools: readonly string[] = []): ComposedAgent => ({
  name,
  description: `${name} agent`,
  body: `# ${name}`,
  color: undefined,
  model: { model: `${name}-model` },
  targetOverride: {},
  skills: ["forge:testing"],
  allowedSkills: ["forge:testing"],
  allowedTools: [...tools],
  toolBindings: tools.map((tool) => ({
    kind: "permission" as const,
    logicalName: tool,
    toolPluginName: "forge",
    toolName: tool,
    toolSourcePath: `/tmp/forge/tools/${tool}.tool.ts`,
  })),
  manifest: {
    traits: [{ id: "forge:builder", ref: "builder" }],
    modelBindings: { modelspace: "forge:models", profile: name },
  },
});

describe("compile manifest writer", () => {
  test("merges target slices and prunes retired agents for the current target", () => {
    const first = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "a".repeat(64), ["run_shell"]), agent("reviewer", "b".repeat(64))],
      cacheDescriptors: new Map([
        ["builder", descriptorFor("builder", "a".repeat(64))],
        ["reviewer", descriptorFor("reviewer", "b".repeat(64))],
      ]),
    });
    const second = buildCompileManifestForTarget({
      base: first,
      registry: registry(),
      target: "claude-code",
      scope: "global",
      composed: [agent("builder", "a".repeat(64), ["run_shell"])],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "a".repeat(64))]]),
    });
    const pruned = buildCompileManifestForTarget({
      base: second,
      registry: registry(),
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "a".repeat(64), ["run_shell", "read_file"])],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "a".repeat(64))]]),
    });

    expect(Object.keys(pruned.agents).sort()).toEqual(["forge:builder"]);
    expect(Object.keys(pruned.agents["forge:builder"]!.composed.perTarget).sort()).toEqual([
      "claude-code",
      "opencode",
    ]);
    expect(pruned.agents["forge:builder"]!.composed.perTarget.opencode?.allowedTools).toEqual([
      "run_shell",
      "read_file",
    ]);
    expect(pruned.agents["forge:builder"]!.composed.perTarget.opencode?.toolGrants).toEqual([
      "forge:run_shell",
      "forge:read_file",
    ]);
    expect(pruned.agents["forge:builder"]!.composed.grants.tools).toEqual([
      "forge:read_file",
      "forge:run_shell",
    ]);
    expect(pruned.compileTargets).toEqual([
      { harness: "claude-code", scope: "global" },
      { harness: "opencode", scope: "project" },
    ]);
    expect(verifyCompileManifestHash(pruned)).toBe(true);
    // tools top-level populated from grants (minimal plugin+name or plugin+toolspace+name, source-free)
    expect(Object.keys(pruned.tools || {}).sort()).toEqual(["forge:read_file", "forge:run_shell"]);
    expect(pruned.tools?.["forge:run_shell"]).toEqual({ plugin: "forge", name: "run_shell" });
    expect(pruned.tools?.["forge:read_file"]).toEqual({ plugin: "forge", name: "read_file" });
    expect(JSON.stringify(pruned.tools)).not.toContain("sourcePath");
    expect(JSON.stringify(pruned.tools)).not.toContain("input");
    expect(JSON.stringify(pruned.tools)).not.toContain("handle");
    // modelspaces populated from bindings (no source paths)
    expect(Object.keys(pruned.modelspaces).sort()).toEqual(["forge:models"]);
    expect(pruned.modelspaces["forge:models"]).toEqual({
      plugin: "forge",
      modelspace: "models",
      profiles: ["builder"],
    });
    // traits populated from per-agent traits only (deduped by id, source-path free)
    expect(Object.keys(pruned.traits).sort()).toEqual(["forge:builder"]);
    expect(pruned.traits["forge:builder"]).toEqual({ id: "forge:builder", ref: "builder" });

    // orbits support: explicit pass on build populates minimal source-free entries for the plugin
    const withOrbits = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "a".repeat(64), ["run_shell"])],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "a".repeat(64))]]),
      orbits: [
        { name: "delivery-contract", phases: [] },
        { name: "experiment-template", phases: [] },
      ],
    });
    expect(Object.keys(withOrbits.orbits).sort()).toEqual(["forge:delivery-contract", "forge:experiment-template"]);
    expect(withOrbits.orbits["forge:delivery-contract"]).toEqual({
      plugin: "forge",
      name: "delivery-contract",
      phases: [],
    });
    expect(withOrbits.orbits["forge:experiment-template"]).toEqual({
      plugin: "forge",
      name: "experiment-template",
      phases: [],
    });
    // no sourcePath etc in manifest orbit entries
    expect(JSON.stringify(withOrbits.orbits)).not.toContain("sourcePath");
    expect(verifyCompileManifestHash(withOrbits)).toBe(true);
    // tools also populated (from the agent grants in this build)
    expect(Object.keys(withOrbits.tools || {}).length).toBeGreaterThan(0);
    expect(JSON.stringify(withOrbits.tools)).not.toContain("sourcePath");
  });

  test("includes every loaded modelspace profile, not only agent-bound profiles", () => {
    const manifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registryWithModels(),
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "a".repeat(64), ["run_shell"])],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "a".repeat(64))]]),
    });

    expect(manifest.modelspaces["forge:models"]?.profiles).toEqual(["builder", "unreferenced"]);
    expect(manifest.modelspaces["forge:models"]?.profilesData?.unreferenced).toEqual({
      opencode: { model: "unreferenced-opencode" },
    });
  });

  test("commit/read round-trips deterministically and corrupt files quarantine", async () => {
    const manifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [agent("builder", "c".repeat(64))],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "c".repeat(64))]]),
    });

    await commitCompileManifest({ prismHome: home, projectKey, manifest });
    const path = compileManifestPath(home, projectKey);
    const firstBytes = await readFile(path);
    await commitCompileManifest({ prismHome: home, projectKey, manifest: (await readCompileManifest(home, projectKey)).manifest });
    expect(await readFile(path)).toBe(firstBytes);

    await nodeWriteFile(path, "{ not json");
    const corrupt = await readCompileManifest(home, projectKey);
    expect(corrupt.quarantinedPath).toContain(".corrupt-");
    expect(await exists(corrupt.quarantinedPath!)).toBe(true);
    expect(corrupt.manifest.agents).toEqual({});
    expect(verifyCompileManifestHash(corrupt.manifest)).toBe(true);
  });

  test("schema-valid hash drift quarantines instead of poisoning the next write", async () => {
    const manifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [agent("builder", "d".repeat(64))],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "d".repeat(64))]]),
    });

    await commitCompileManifest({ prismHome: home, projectKey, manifest });
    const path = compileManifestPath(home, projectKey);
    await nodeWriteFile(path, (await readFile(path)).replace("builder agent", "tampered agent"));

    const corrupt = await readCompileManifest(home, projectKey);
    expect(corrupt.quarantinedPath).toContain(".corrupt-");
    expect(await exists(corrupt.quarantinedPath!)).toBe(true);
    expect(corrupt.manifest.agents).toEqual({});
    expect(verifyCompileManifestHash(corrupt.manifest)).toBe(true);
  });

  test("per-project partition: two project keys with a same-named local plugin/agent do not clobber each other", async () => {
    // The clobbering bug: the old flat global manifest keyed "<plugin>:<agent>"
    // meant two projects with a same-named local plugin ("forge") and a
    // same-named agent ("builder") stomped each other's entry. The per-project
    // manifest partition isolates them under distinct project keys.
    const keyA = "project-a-key";
    const keyB = "project-b-key";

    const manifestA = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "a".repeat(64), ["tool_a"])],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "a".repeat(64))]]),
    });
    const manifestB = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "b".repeat(64), ["tool_b"])],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "b".repeat(64))]]),
    });

    // Same manifest id in both partitions — only the project key differs.
    expect(Object.keys(manifestA.agents)).toEqual(["forge:builder"]);
    expect(Object.keys(manifestB.agents)).toEqual(["forge:builder"]);

    await commitCompileManifest({ prismHome: home, projectKey: keyA, manifest: manifestA });
    await commitCompileManifest({ prismHome: home, projectKey: keyB, manifest: manifestB });

    // Distinct on-disk partitions (no shared flat manifest).
    expect(compileManifestPath(home, keyA)).not.toBe(compileManifestPath(home, keyB));

    const readA = await readCompileManifest(home, keyA);
    const readB = await readCompileManifest(home, keyB);

    // Neither write stomped the other: each key keeps its own distinct entry.
    expect(readA.quarantinedPath).toBeUndefined();
    expect(readB.quarantinedPath).toBeUndefined();
    const builderA = readA.manifest.agents["forge:builder"];
    const builderB = readB.manifest.agents["forge:builder"];
    expect(builderA?.sourceHash).toBe("a".repeat(64));
    expect(builderB?.sourceHash).toBe("b".repeat(64));
    expect(builderA?.composed.grants.tools).toEqual(["forge:tool_a"]);
    expect(builderB?.composed.grants.tools).toEqual(["forge:tool_b"]);
    expect(verifyCompileManifestHash(readA.manifest)).toBe(true);
    expect(verifyCompileManifestHash(readB.manifest)).toBe(true);
  });

  test("projects multi-phase orbits with resolved agents into manifest phase entries", async () => {
    const reg = makeRegistry({ pluginName: "forge" });
    addToRegistry(reg, {
      agents: [
        makeAgent({ name: "builder" }),
        makeAgent({ name: "reviewer" }),
      ],
      orbits: [
        makeOrbit({
          name: "delivery-contract",
          phases: [
            {
              name: "Implement change",
              agents: ["builder"],
              workflow: {
                inputs: ["Work item is ready"],
                outputs: ["Implementation is ready"],
                finish_criteria: ["Tests pass"],
                when: "glyph is claimed",
                coordination: "single owner",
                escalation: "orchestrator",
              },
              telos: "Ship the change",
              notes: { Done: "Implementation is ready" },
            },
            {
              name: "Review change",
              agents: ["reviewer"],
              workflow: {
                finish_criteria: ["Findings recorded"],
              },
            },
          ],
        }),
      ],
    });

    const orbit = reg.orbits.get("delivery-contract")!;
    await Effect.runPromise(validateOrbit(orbit, reg));
    const projections = await Effect.runPromise(projectOrbitsForCompileManifest([orbit], reg));
    const manifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: reg,
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "a".repeat(64))],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "a".repeat(64))]]),
      orbits: projections,
    });

    const entry = manifest.orbits["forge:delivery-contract"];
    expect(entry?.phases).toHaveLength(2);
    expect(entry?.phases[0]).toEqual({
      name: "Implement change",
      agents: [{ plugin: "forge", name: "builder" }],
      criteria: ["Tests pass"],
      io: { inputs: ["Work item is ready"], outputs: ["Implementation is ready"] },
      framing: {
        telos: "Ship the change",
        when: "glyph is claimed",
        coordination: "single owner",
        escalation: "orchestrator",
      },
      notes: { Done: "Implementation is ready" },
    });
    expect(entry?.phases[1]?.agents).toEqual([{ plugin: "forge", name: "reviewer" }]);
    expect(JSON.stringify(manifest.orbits)).not.toContain("sourcePath");
    expect(JSON.stringify(manifest.orbits)).not.toContain("body");
    expect(verifyCompileManifestHash(manifest)).toBe(true);
  });

  test("resolves cross-plugin phase agents into manifest projections", async () => {
    const core = makeRegistry({ pluginName: "agent-core" });
    addToRegistry(core, {
      agents: [makeAgent({ name: "reviewer" })],
    });
    const reg = makeRegistry({
      pluginName: "forge",
      dependencyPaths: { "agent-core": core.pluginPath },
    });
    reg.deps.set("agent-core", core);
    addToRegistry(reg, {
      agents: [makeAgent({ name: "builder" })],
      orbits: [
        makeOrbit({
          name: "delivery-contract",
          phases: [
            { name: "Implement change", agents: ["builder"] },
            { name: "Review change", agents: ["agent-core:reviewer"] },
          ],
        }),
      ],
    });

    const orbit = reg.orbits.get("delivery-contract")!;
    const projections = await Effect.runPromise(projectOrbitsForCompileManifest([orbit], reg));
    expect(projections[0]?.phases[1]?.agents).toEqual([
      { plugin: "agent-core", name: "reviewer" },
    ]);
  });

  test("serializes supported phase contract schemas into manifest JSON Schema", async () => {
    const outputSchema = Schema.Struct({
      summary: Schema.String,
      ok: Schema.Boolean,
    });
    const reg = makeRegistry({ pluginName: "forge" });
    addToRegistry(reg, {
      agents: [makeAgent({ name: "builder" })],
      orbits: [
        makeOrbit({
          name: "delivery-contract",
          phases: [
            {
              name: "Explore",
              agents: ["builder"],
              contract: { output: outputSchema },
            },
          ],
        }),
      ],
    });

    const orbit = reg.orbits.get("delivery-contract")!;
    const projections = await Effect.runPromise(projectOrbitsForCompileManifest([orbit], reg));
    const manifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: reg,
      target: "opencode",
      scope: "project",
      composed: [agent("builder", "a".repeat(64))],
      cacheDescriptors: new Map([["builder", descriptorFor("builder", "a".repeat(64))]]),
      orbits: projections,
    });

    const contract = manifest.orbits["forge:delivery-contract"]?.phases[0]?.contract;
    expect(contract?.output).toEqual({
      type: "object",
      properties: {
        summary: { type: "string" },
        ok: { type: "boolean" },
      },
      required: ["summary", "ok"],
      additionalProperties: false,
    });
  });
});
