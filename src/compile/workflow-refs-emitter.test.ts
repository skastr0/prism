import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { buildCompileManifestForTarget, emptyCompileManifest } from "./compile-manifest.js";
import type { AgentCacheDescriptor } from "./cache.js";
import type { ComposedAgent } from "./compose.js";
import { emptyRegistry } from "./registry.js";
import { Agent } from "./sources.js";
import { typescriptBundleImportPath } from "./runtime-deps.js";
import {
  jsonSchemaToEffectSchemaSource,
  planWorkflowRefsEmit,
  renderWorkflowAgentsModule,
  renderWorkflowModelsModule,
  renderWorkflowOrbitsModule,
  renderWorkflowSkillsModule,
  renderWorkflowTraitsModule,
  renderWorkflowToolsModule,
  WorkflowOrbitsEmitError,
  workflowAgentsPath,
  workflowModelsPath,
  workflowOrbitsPath,
  workflowSkillsPath,
  workflowTraitsPath,
  workflowToolsPath,
  workflowRefsRoot,
  WORKFLOW_REFS_HARNESS,
} from "./workflow-refs-emitter.js";
import { buildWorkflowPaths, resolveWorkflowTypeDirs } from "../workflow-tsconfig.js";

const ts = createRequire(import.meta.url)(typescriptBundleImportPath()) as typeof import("typescript");

const registry = () => {
  const registry = emptyRegistry("/tmp/forge", "forge", "1.0.0");
  registry.agents.set("codebase-archeologist", new Agent({
    name: "codebase-archeologist",
    sourcePath: "/tmp/forge/agents/codebase-archeologist.agent.ts",
    description: "Maps legacy strata",
    identity: "builder",
    traits: [],
    access: { tools: [], toolGroups: [], skills: [] },
    skills: [],
    targets: {},
  }));
  registry.agents.set("explorer", new Agent({
    name: "explorer",
    sourcePath: "/tmp/forge/agents/explorer.agent.ts",
    description: "Explores scope",
    identity: "builder",
    traits: [],
    access: { tools: [], toolGroups: [], skills: [] },
    skills: [],
    targets: {},
  }));
  return registry;
};

const descriptor: AgentCacheDescriptor = {
  key: "codebase-archeologist-key",
  sourceHash: "a".repeat(64),
  contextHash: "context",
  inputs: [{ plugin: "forge", path: "agents/codebase-archeologist.agent.ts", contentHash: "a".repeat(64) }],
};

const composed: ComposedAgent = {
  name: "codebase-archeologist",
  description: "Maps legacy strata",
  body: "# codebase-archeologist",
  color: undefined,
  model: { model: "grok-code-fast-1" },
  targetOverride: {},
  skills: ["testing"],
  allowedSkills: ["testing"],
  allowedTools: ["read"],
  toolBindings: [],
  manifest: {
    traits: [{ id: "forge:survey", ref: "survey" }],
    modelBindings: { modelspace: "forge:models", profile: "fast" },
  },
};

const explorerDescriptor: AgentCacheDescriptor = {
  key: "explorer-key",
  sourceHash: "b".repeat(64),
  contextHash: "context",
  inputs: [{ plugin: "forge", path: "agents/explorer.agent.ts", contentHash: "b".repeat(64) }],
};

const explorerComposed: ComposedAgent = {
  name: "explorer",
  description: "Explores scope",
  body: "# explorer",
  color: undefined,
  model: { model: "grok-code-fast-1" },
  targetOverride: {},
  skills: [],
  allowedSkills: [],
  allowedTools: [],
  toolBindings: [],
  manifest: {
    traits: [],
    modelBindings: {},
  },
};

const manifest = () =>
  buildCompileManifestForTarget({
    base: emptyCompileManifest(),
    registry: registry(),
    target: "grok",
    scope: "project",
    composed: [composed, explorerComposed],
    cacheDescriptors: new Map([
      ["codebase-archeologist", descriptor],
      ["explorer", explorerDescriptor],
    ]),
  });

const orbitManifest = () =>
  buildCompileManifestForTarget({
    base: {
      ...emptyCompileManifest(),
      orbits: {
        "forge:forge": {
          plugin: "forge",
          name: "forge",
          phases: [
            {
              name: "explore",
              agents: [{ plugin: "forge", name: "explorer" }],
              criteria: ["Scope is clear"],
              io: { inputs: ["Goal"], outputs: ["Scope note"] },
              framing: { telos: "Understand the work" },
              contract: {
                output: {
                  type: "object",
                  properties: {
                    summary: { type: "string" },
                    ok: { type: "boolean" },
                    mode: { enum: ["pass", "fail"] },
                    note: { anyOf: [{ type: "string" }, { type: "null" }] },
                  },
                  required: ["summary", "ok"],
                  additionalProperties: false,
                },
              },
            },
            {
              name: "build",
              agents: [{ plugin: "forge", name: "codebase-archeologist" }],
              criteria: ["Change lands"],
              io: { inputs: ["Scope note"], outputs: ["Patch report"] },
              framing: { telos: "Implement the change" },
            },
          ],
        },
      },
    },
    registry: registry(),
    target: "grok",
    scope: "project",
    composed: [composed, explorerComposed],
    cacheDescriptors: new Map([
      ["codebase-archeologist", descriptor],
      ["explorer", explorerDescriptor],
    ]),
  });

const typecheckGeneratedRefs = async (options: {
  readonly agentsSource: string;
  readonly orbitsSource: string;
  readonly probeSource: string;
  readonly expectErrors?: boolean;
}): Promise<readonly string[]> => {
  const dir = await mkdtemp(join(tmpdir(), "prism-workflow-refs-typecheck-"));
  try {
    await writeFile(join(dir, "agents.ts"), options.agentsSource, "utf8");
    await writeFile(join(dir, "orbits.ts"), options.orbitsSource, "utf8");
    await writeFile(join(dir, "probe.ts"), options.probeSource, "utf8");

    const typeDirs = resolveWorkflowTypeDirs();
    const paths = buildWorkflowPaths({ typeDirs, refsDir: dir });
    const { options: compilerOptions, errors } = ts.convertCompilerOptionsFromJson(
      {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        paths,
      },
      dir,
    );
    if (errors.length > 0) {
      throw new Error(`failed to build compiler options: ${errors.map((e) => e.messageText).join("; ")}`);
    }

    const host = ts.createCompilerHost(compilerOptions);
    const program = ts.createProgram([join(dir, "probe.ts")], compilerOptions, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const messages = diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
    if (options.expectErrors) {
      expect(messages.length).toBeGreaterThan(0);
    } else {
      expect(messages).toEqual([]);
    }
    return messages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("workflow refs emitter", () => {
  test("renders literal agent refs from the compile manifest", () => {
    const output = renderWorkflowAgentsModule({ manifest: manifest() });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('"forge": {');
    expect(output).toContain('"codebaseArcheologist":');
    expect(output).toContain('kind: "agent-ref"');
    expect(output).toContain('name: "codebase-archeologist"');
    expect(output).not.toContain("sourcePath");
    expect(output).toContain('installs: ["grok"]');
    expect(output).toContain('"targets":{"grok":{"model":"grok-code-fast-1"}}');
    expect(output).toContain('as const satisfies Record<string, Record<string, WorkflowAgentRef>>');
  });

  test("renders literal model profile refs from the compile manifest (no source paths)", () => {
    const output = renderWorkflowModelsModule({ manifest: manifest() });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('"forge": {');
    expect(output).toContain('"models": {');
    expect(output).toContain('"fast":');
    expect(output).toContain('kind":"model-profile-ref"');
    expect(output).toContain('plugin":"forge"');
    expect(output).toContain('modelspace":"models"');
    expect(output).toContain('profile":"fast"');
    expect(output).toContain('targets":{"grok":{"model":"grok-code-fast-1"}}');
    expect(output).not.toContain("sourcePath");
    expect(output).toContain('as const satisfies Record<string, Record<string, Record<string, WorkflowModelProfileRef>>>');
    expect(output).toContain("WorkflowModelspaceRef");
    expect(output).toContain("WorkflowModelProfileRef");
  });

  test("renders modelspace profiles not referenced by agents", () => {
    const base = manifest();
    const output = renderWorkflowModelsModule({
      manifest: {
        ...base,
        modelspaces: {
          ...base.modelspaces,
          "forge:models": {
            plugin: "forge",
            modelspace: "models",
            profiles: ["fast", "unreferenced"],
            profilesData: {
              fast: { grok: { model: "grok-code-fast-1" } },
              unreferenced: { opencode: { model: "provider/unreferenced" } },
            },
          },
        },
      },
    });

    expect(output).toContain('"fast":');
    expect(output).toContain('"unreferenced":');
    expect(output).toContain('"provider/unreferenced"');
  });

  test("plans a machine-global, project-keyed generated desired root for the sync engine", () => {
    const prismHome = "/tmp/prism-home";
    const projectKey = "workspace-key";
    const desired = planWorkflowRefsEmit({ prismHome, projectKey, manifest: manifest() });

    expect(desired.harness).toBe(WORKFLOW_REFS_HARNESS);
    expect(desired.root).toBe(workflowRefsRoot(prismHome, projectKey));
    // Refs are Prism-owned, never in the project tree: under ~/.prism/state.
    expect(desired.root).toContain(join("state", "projects", projectKey, "generated"));
    expect(desired.root).not.toContain(".prism/generated/workflows");
    expect(desired.files).toHaveLength(6);
    expect(desired.files[0]?.targetPath).toBe(workflowAgentsPath(prismHome, projectKey));
    expect(desired.files[0]?.plugin).toBe(WORKFLOW_REFS_HARNESS);
    expect(desired.files[1]?.targetPath).toBe(workflowModelsPath(prismHome, projectKey));
    expect(desired.files[1]?.plugin).toBe(WORKFLOW_REFS_HARNESS);
    expect(desired.files[2]?.targetPath).toBe(workflowSkillsPath(prismHome, projectKey));
    expect(desired.files[2]?.plugin).toBe(WORKFLOW_REFS_HARNESS);
    expect(desired.files[3]?.targetPath).toBe(workflowTraitsPath(prismHome, projectKey));
    expect(desired.files[3]?.plugin).toBe(WORKFLOW_REFS_HARNESS);
    expect(desired.files[4]?.targetPath).toBe(workflowOrbitsPath(prismHome, projectKey));
    expect(desired.files[4]?.plugin).toBe(WORKFLOW_REFS_HARNESS);
    expect(desired.files[5]?.targetPath).toBe(workflowToolsPath(prismHome, projectKey));
    expect(desired.files[5]?.plugin).toBe(WORKFLOW_REFS_HARNESS);
    expect(desired.regions).toEqual([]);
  });

  test("renders literal skill and skillspace refs (managed vs skillspace, bare vs prefixed, no sourcePath)", () => {
    // Use build to populate; pass space-form and prefixed/bare in composed.skills to exercise parse + classify
    const mixedManifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [
        {
          ...composed,
          skills: ["testing", "forge:build", "agent-core:core-skills/testing"],
          allowedSkills: ["testing", "forge:build", "agent-core:core-skills/testing"],
        },
      ],
      cacheDescriptors: new Map([["codebase-archeologist", descriptor]]),
    });

    const output = renderWorkflowSkillsModule({ manifest: mixedManifest });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain("WorkflowManagedSkillRef");
    expect(output).toContain("WorkflowSkillspaceRef");
    expect(output).toContain('"forge": {');
    expect(output).toContain('kind":"managed-skill-ref"');
    expect(output).toContain('"name":"testing"');
    expect(output).toContain('"name":"build"');
    expect(output).toContain('kind":"skillspace-ref"');
    expect(output).toContain('"skillspace":"core-skills"');
    expect(output).toContain('"skills":["testing"]');
    expect(output).not.toContain("sourcePath");
    expect(output).toContain('as const satisfies Record<string, Record<string, WorkflowManagedSkillRef | WorkflowSkillspaceRef>>');
  });

  test("empty manifest produces valid skills module with interfaces and empty skills", () => {
    const output = renderWorkflowSkillsModule({ manifest: emptyCompileManifest() });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain("export interface WorkflowManagedSkillRef");
    expect(output).toContain("export interface WorkflowSkillspaceRef");
    expect(output).toContain("export const skills = {");
    expect(output).not.toContain("sourcePath");
    expect(output).toContain("} as const satisfies Record<string, Record<string, WorkflowManagedSkillRef | WorkflowSkillspaceRef>>");
  });

  test("fallback derivation unions multiple skills per skillspace when top-level skills empty (bare manifest hit)", () => {
    const base = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [
        {
          ...composed,
          skills: ["agent-core:core-skills/testing", "agent-core:core-skills/extra"],
          allowedSkills: ["agent-core:core-skills/testing", "agent-core:core-skills/extra"],
        },
      ],
      cacheDescriptors: new Map([["codebase-archeologist", descriptor]]),
    });
    // zero top-level to force fallback path (mirrors legacy/empty case; build normally populates)
    const bare = { ...base, modelspaces: {}, skills: {} } as typeof base;
    const output = renderWorkflowSkillsModule({ manifest: bare });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('kind":"skillspace-ref"');
    expect(output).toContain('"skillspace":"core-skills"');
    // unioned + inner sorted, not dropped
    expect(output).toContain('"skills":["extra","testing"]');
    expect(output).not.toContain("sourcePath");
  });

  test("renders literal trait refs from the compile manifest (deterministic grouped, cross-plugin ids ok, no sourcePath)", () => {
    const output = renderWorkflowTraitsModule({ manifest: manifest() });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('"forge": {');
    expect(output).toContain('"survey":');
    expect(output).toContain('kind":"trait-ref"');
    expect(output).toContain('"id":"forge:survey"');
    expect(output).toContain('"ref":"survey"');
    expect(output).not.toContain("sourcePath");
    expect(output).toContain('as const satisfies Record<string, Record<string, WorkflowTraitRef>>');
  });

  test("renders deterministic grouped trait refs for cross-plugin ids", () => {
    const crossManifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [
        {
          ...composed,
          manifest: {
            traits: [
              { id: "forge:survey", ref: "survey" },
              { id: "core:committable", ref: "committable" },
            ],
            modelBindings: { modelspace: "forge:models", profile: "fast" },
          },
        },
      ],
      cacheDescriptors: new Map([["codebase-archeologist", descriptor]]),
    });

    const output = renderWorkflowTraitsModule({ manifest: crossManifest });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('"core": {');
    expect(output).toContain('"committable":');
    expect(output).toContain('"forge": {');
    expect(output).toContain('"survey":');
    expect(output).toContain('kind: "trait-ref"');
    expect(output).not.toContain("sourcePath");
    // plugins grouped deterministically (core before forge)
    const coreIdx = output.indexOf('"core"');
    const forgeIdx = output.indexOf('"forge"');
    expect(coreIdx).toBeGreaterThan(-1);
    expect(forgeIdx).toBeGreaterThan(coreIdx);
  });

  test("empty manifest produces valid traits module with interfaces and empty traits", () => {
    const output = renderWorkflowTraitsModule({ manifest: emptyCompileManifest() });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain("export interface WorkflowTraitRef");
    expect(output).toContain("export const traits = {");
    expect(output).not.toContain("sourcePath");
    expect(output).toContain("} as const satisfies Record<string, Record<string, WorkflowTraitRef>>");
  });

  test("renders typed orbit phases with agent cross-imports and sequence order", () => {
    const output = renderWorkflowOrbitsModule({ manifest: orbitManifest() });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('import { agents, type WorkflowAgentRef } from "./agents.ts";');
    expect(output).toContain('"forge": {');
    expect(output).toContain('"forge": {');
    expect(output).toContain('sequence: ["explore","build"] as const');
    expect(output).toContain('"explore": {');
    expect(output).toContain('"build": {');
    expect(output).toContain('"explorer": agents.forge.explorer');
    expect(output).toContain('"codebaseArcheologist": agents.forge.codebaseArcheologist');
    expect(output).toContain("export type ForgeForgeExploreAgent =");
    expect(output).toContain("export type ForgeForgeBuildAgent =");
    expect(output).not.toContain("sourcePath");
    expect(output).not.toContain("kind");
    expect(output).toContain("} as const satisfies Record<string, Record<string, WorkflowOrbit>>");
  });

  test("re-exports WorkflowAgentRef so orbit-phase authors need one specifier", () => {
    const output = renderWorkflowOrbitsModule({ manifest: orbitManifest() });

    expect(output).toContain('export type { WorkflowAgentRef } from "./agents.ts";');
  });

  test("per-phase agent type aliases include orbit name to avoid export collisions", () => {
    const sharedPhaseManifest = buildCompileManifestForTarget({
      base: {
        ...emptyCompileManifest(),
        orbits: {
          "forge:forge": {
            plugin: "forge",
            name: "forge",
            phases: [
              {
                name: "explore",
                agents: [{ plugin: "forge", name: "explorer" }],
                criteria: [],
                io: { inputs: [], outputs: [] },
                framing: {},
              },
            ],
          },
          "forge:delivery-contract": {
            plugin: "forge",
            name: "delivery-contract",
            phases: [
              {
                name: "explore",
                agents: [{ plugin: "forge", name: "codebase-archeologist" }],
                criteria: [],
                io: { inputs: [], outputs: [] },
                framing: {},
              },
            ],
          },
        },
      },
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [composed, explorerComposed],
      cacheDescriptors: new Map([
        ["codebase-archeologist", descriptor],
        ["explorer", explorerDescriptor],
      ]),
    });

    const output = renderWorkflowOrbitsModule({ manifest: sharedPhaseManifest });

    expect(output).toContain("export type ForgeForgeExploreAgent =");
    expect(output).toContain("export type ForgeDeliveryContractExploreAgent =");
    const forgeAliasCount = (output.match(/export type ForgeForgeExploreAgent =/g) ?? []).length;
    const deliveryAliasCount = (output.match(/export type ForgeDeliveryContractExploreAgent =/g) ?? []).length;
    expect(forgeAliasCount).toBe(1);
    expect(deliveryAliasCount).toBe(1);
    expect(output).not.toContain("export type ForgeExploreAgent =");
  });

  test("phase agent refs share object identity with the agents module", async () => {
    const manifest = orbitManifest();
    const agentsSource = renderWorkflowAgentsModule({ manifest });
    const orbitsSource = renderWorkflowOrbitsModule({ manifest });
    const dir = await mkdtemp(join(process.cwd(), ".tmp-workflow-refs-identity-"));
    try {
      const agentsPath = join(dir, "agents.ts");
      const orbitsPath = join(dir, "orbits.ts");
      const probePath = join(dir, "probe.ts");
      await writeFile(agentsPath, agentsSource, "utf8");
      await writeFile(orbitsPath, orbitsSource, "utf8");
      await writeFile(
        probePath,
        [
          `import { agents } from ${JSON.stringify(agentsPath)};`,
          `import { orbits } from ${JSON.stringify(orbitsPath)};`,
          "export const exploreSame =",
          "  orbits.forge.forge.phases.explore.agents.explorer === agents.forge.explorer;",
          "export const buildSame =",
          "  orbits.forge.forge.phases.build.agents.codebaseArcheologist ===",
          "  agents.forge.codebaseArcheologist;",
        ].join("\n"),
        "utf8",
      );
      const probe = await import(probePath);

      expect(probe.exploreSame).toBe(true);
      expect(probe.buildSame).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing phase agent is a hard emit error", () => {
    const base = orbitManifest();
    const manifest = {
      ...base,
      orbits: {
        ...base.orbits,
        "forge:forge": {
          ...base.orbits["forge:forge"]!,
          phases: base.orbits["forge:forge"]!.phases.map((phase, index) =>
            index === 0
              ? { ...phase, agents: [{ plugin: "forge", name: "missing-agent" }] }
              : phase,
          ),
        },
      },
    };
    expect(() => renderWorkflowOrbitsModule({ manifest })).toThrow(WorkflowOrbitsEmitError);
    try {
      renderWorkflowOrbitsModule({ manifest });
      throw new Error("expected emit failure");
    } catch (error) {
      expect((error as Error).message).toContain(
        "phase agent forge:missing-agent is missing from the emitted agents module",
      );
    }
  });

  test("contract codegen round-trips decode for valid payloads and rejects invalid ones", async () => {
    const schemaSource = jsonSchemaToEffectSchemaSource(
      {
        type: "object",
        properties: {
          summary: { type: "string" },
          ok: { type: "boolean" },
          mode: { enum: ["pass", "fail"] },
          note: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["summary", "ok"],
        additionalProperties: false,
      },
      "output",
    );
    const { Schema: EffectSchema } = await import("effect");
    const Output = Function("Schema", `return ${schemaSource}`)(EffectSchema) as Schema.Schema<
      {
        readonly summary: string;
        readonly ok: boolean;
        readonly mode?: "pass" | "fail";
        readonly note?: string | null;
      },
      unknown
    >;

    const valid = Schema.decodeUnknownSync(Output)({
      summary: "ready",
      ok: true,
      mode: "pass",
      note: null,
    });
    expect(valid).toEqual({
      summary: "ready",
      ok: true,
      mode: "pass",
      note: null,
    });
    expect(() =>
      Schema.decodeUnknownSync(Output)({
        summary: "ready",
        ok: "nope",
      }),
    ).toThrow();
  });

  test("cross-phase agent assignment does not typecheck", async () => {
    const manifest = orbitManifest();
    const agentsSource = renderWorkflowAgentsModule({ manifest });
    const orbitsSource = renderWorkflowOrbitsModule({ manifest });
    const probeSource = `
import { orbits } from "./orbits.ts";

const forge = orbits.forge.forge;
const _wrongAssignment: typeof forge.phases.explore.agents.explorer =
  forge.phases.build.agents.codebaseArcheologist;
void _wrongAssignment;
`;

    await typecheckGeneratedRefs({
      agentsSource,
      orbitsSource,
      probeSource,
      expectErrors: true,
    });
  });

  test("generated orbits module typechecks with agents cross-import", async () => {
    const manifest = orbitManifest();
    const agentsSource = renderWorkflowAgentsModule({ manifest });
    const orbitsSource = renderWorkflowOrbitsModule({ manifest });
    const probeSource = `
import { orbits } from "./orbits.ts";

const forge = orbits.forge.forge;
const exploreAgent = forge.phases.explore.agents.explorer;
void exploreAgent;
`;

    await typecheckGeneratedRefs({
      agentsSource,
      orbitsSource,
      probeSource,
    });
  });

  test("renders deterministic grouped orbit namespaces for cross-plugin manifests", () => {
    const crossManifest = buildCompileManifestForTarget({
      base: {
        ...emptyCompileManifest(),
        orbits: {
          "forge:delivery-contract": {
            plugin: "forge",
            name: "delivery-contract",
            phases: [
              {
                name: "Implement change",
                agents: [{ plugin: "forge", name: "codebase-archeologist" }],
                criteria: [],
                io: { inputs: [], outputs: [] },
                framing: {},
              },
            ],
          },
          "core:experiment": {
            plugin: "core",
            name: "experiment",
            phases: [],
          },
        },
      },
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [composed, explorerComposed],
      cacheDescriptors: new Map([
        ["codebase-archeologist", descriptor],
        ["explorer", explorerDescriptor],
      ]),
    });

    const output = renderWorkflowOrbitsModule({ manifest: crossManifest });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('"core": {');
    expect(output).toContain('"experiment":');
    expect(output).toContain('"forge": {');
    expect(output).toContain('"deliveryContract":');
    expect(output).not.toContain("sourcePath");
    const coreIdx = output.indexOf('"core"');
    const forgeIdx = output.indexOf('"forge"');
    expect(coreIdx).toBeGreaterThan(-1);
    expect(forgeIdx).toBeGreaterThan(coreIdx);
  });

  test("empty manifest produces valid orbits module with interfaces and empty orbits", () => {
    const output = renderWorkflowOrbitsModule({ manifest: emptyCompileManifest() });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain("export interface WorkflowOrbit");
    expect(output).toContain("export const orbits = {");
    expect(output).not.toContain("sourcePath");
    expect(output).toContain("} as const satisfies Record<string, Record<string, WorkflowOrbit>>");
  });

  test("renders literal tool and toolspace refs from the compile manifest (deterministic camel keys, cross-plugin, no sourcePath)", () => {
    const toolManifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [{
        ...composed,
        toolBindings: [
          { kind: "permission", logicalName: "commit_work", toolPluginName: "forge", toolName: "commit-work" },
          { kind: "permission", logicalName: "create_glyph", toolPluginName: "protocol-core", toolName: "create_glyph" },
          { kind: "permission", logicalName: "run_shell", toolPluginName: "agent-core", toolName: "workspace-tools/run_shell" },
        ],
      } as any],
      cacheDescriptors: new Map([["codebase-archeologist", descriptor]]),
    });

    const output = renderWorkflowToolsModule({ manifest: toolManifest });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain("WorkflowCanonicalToolRef");
    expect(output).toContain("WorkflowToolspaceToolRef");
    expect(output).toContain('"forge": {');
    expect(output).toContain('"commitWork":');
    expect(output).toContain('kind":"canonical-tool-ref"');
    expect(output).toContain('"name":"commit-work"');
    expect(output).toContain('"protocolCore": {');
    expect(output).toContain('"createGlyph":');
    expect(output).toContain('"agentCore": {');
    expect(output).toContain('"workspaceTools": {');
    expect(output).toContain('"runShell":');
    expect(output).toContain('kind":"toolspace-tool-ref"');
    expect(output).toContain('"toolspace":"workspace-tools"');
    expect(output).not.toContain("sourcePath");
    expect(output).not.toContain("input");
    expect(output).not.toContain("handle");
    expect(output).toContain('as const satisfies Record<string, Record<string, WorkflowCanonicalToolRef | Record<string, WorkflowToolspaceToolRef>>>');
  });

  test("empty manifest produces valid tools module with interfaces and empty tools", () => {
    const output = renderWorkflowToolsModule({ manifest: emptyCompileManifest() });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain("export interface WorkflowCanonicalToolRef");
    expect(output).toContain("export interface WorkflowToolspaceToolRef");
    expect(output).toContain("export const tools = {");
    expect(output).not.toContain("sourcePath");
    expect(output).toContain("} as const satisfies Record<string, Record<string, WorkflowCanonicalToolRef | Record<string, WorkflowToolspaceToolRef>>>");
  });

  test("renders deterministic grouped tool refs for cross-plugin and mixed canon+toolspace under one plugin", () => {
    const crossManifest = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [{
        ...composed,
        toolBindings: [
          { kind: "permission", logicalName: "exp", toolPluginName: "core", toolName: "experiment" },
          { kind: "permission", logicalName: "cw", toolPluginName: "forge", toolName: "commit-work" },
          { kind: "permission", logicalName: "rs", toolPluginName: "forge", toolName: "workspace-tools/run_shell" },
        ],
      } as any],
      cacheDescriptors: new Map([["codebase-archeologist", descriptor]]),
    });

    const output = renderWorkflowToolsModule({ manifest: crossManifest });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('"core": {');
    expect(output).toContain('"experiment":');
    expect(output).toContain('"forge": {');
    expect(output).toContain('"commitWork":');
    expect(output).toContain('"workspaceTools": {');
    expect(output).toContain('"runShell"');
    expect(output).toContain('kind: "canonical-tool-ref"');
    expect(output).toContain('kind: "toolspace-tool-ref"');
    expect(output).not.toContain("sourcePath");
    // plugins grouped deterministically (core before forge)
    const coreIdx = output.indexOf('"core"');
    const forgeIdx = output.indexOf('"forge"');
    expect(coreIdx).toBeGreaterThan(-1);
    expect(forgeIdx).toBeGreaterThan(coreIdx);
  });

  test("fallback derivation collects multiple tools per toolspace without loss when top-level tools empty", () => {
    const base = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [
        {
          ...composed,
          toolBindings: [
            { kind: "permission", logicalName: "read", toolPluginName: "agent-core", toolName: "read" },
            { kind: "permission", logicalName: "grep", toolPluginName: "agent-core", toolName: "grep" },
          ],
          // simulate grants in composed
        } as any,
      ],
      cacheDescriptors: new Map([["codebase-archeologist", descriptor]]),
    });
    // simulate bare manifest without top-level tools (force fallback)
    // patch grants to use space form
    const patched = {
      ...base,
      agents: {
        ...base.agents,
        "forge:codebase-archeologist": {
          ...base.agents["forge:codebase-archeologist"]!,
          composed: {
            ...base.agents["forge:codebase-archeologist"]!.composed,
            grants: { tools: ["agent-core:workspace-tools/read", "agent-core:workspace-tools/grep"], skills: [] },
          },
        },
      },
      tools: {},
    } as any;
    const output = renderWorkflowToolsModule({ manifest: patched });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('kind":"toolspace-tool-ref"');
    expect(output).toContain('"workspaceTools"');
    // multiple under same toolspace, not dropped
    expect(output).toContain('"read"');
    expect(output).toContain('"grep"');
    expect(output).not.toContain("sourcePath");
  });

  test("manifest.tools (populated from grants) yields source-free deterministic tools ref output", () => {
    const withGrants = buildCompileManifestForTarget({
      base: emptyCompileManifest(),
      registry: registry(),
      target: "grok",
      scope: "project",
      composed: [
        {
          ...composed,
          toolBindings: [
            { kind: "permission", logicalName: "run_shell", toolPluginName: "agent-core", toolName: "workspace-tools/run_shell" },
            { kind: "permission", logicalName: "create_glyph", toolPluginName: "protocol-core", toolName: "create_glyph" },
          ],
        } as any,
      ],
      cacheDescriptors: new Map([["codebase-archeologist", descriptor]]),
    });
    // ensure top-level tools got populated by build (from grants)
    expect(Object.keys(withGrants.tools || {}).length).toBeGreaterThan(0);
    const output = renderWorkflowToolsModule({ manifest: withGrants });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('kind":"toolspace-tool-ref"');
    expect(output).toContain('"protocolCore"');
    expect(output).toContain('"createGlyph"');
    expect(output).not.toContain("sourcePath");
    expect(output).not.toContain("/tmp");
    expect(output).not.toContain(".tool.ts");
  });
});
