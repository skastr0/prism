import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { buildCompileManifestForTarget, emptyCompileManifest } from "./compile-manifest.js";
import { phase, type AnyWorkflowTask } from "../workflows.js";
import type { AgentCacheDescriptor } from "./cache.js";
import type { ComposedAgent } from "./compose.js";
import { emptyRegistry } from "./registry.js";
import { Agent } from "./sources.js";
import { typescriptBundleImportPath } from "./runtime-deps.js";
import {
  jsonSchemaToEffectSchemaSource,
  planWorkflowRefsEmit,
  renderWorkflowModelsModule,
  renderWorkflowSopsModule,
  workflowModelsPath,
  workflowSopsPath,
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
    skills: [],
    targets: {},
  }));
  registry.agents.set("explorer", new Agent({
    name: "explorer",
    sourcePath: "/tmp/forge/agents/explorer.agent.ts",
    description: "Explores scope",
    identity: "builder",
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
  manifest: {
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
  manifest: {
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

const sopManifest = () =>
  buildCompileManifestForTarget({
    base: {
      ...emptyCompileManifest(),
      sops: {
        "forge:beacon": {
          plugin: "forge",
          name: "beacon",
          phases: [
            {
              name: "explore",
              purpose: "Map the space before committing.",
              acceptanceCriteria: ["Hypothesis is falsifiable"],
              escalation: "Ask a human when the audience is unclear",
              input: {
                type: "object",
                properties: { brief: { type: "string" } },
                required: ["brief"],
              },
              output: {
                type: "object",
                properties: { summary: { type: "string" } },
                required: ["summary"],
              },
            },
            {
              name: "build",
              purpose: "Build what the phase contract describes.",
              acceptanceCriteria: [],
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
  readonly modelsSource?: string;
  readonly sopsSource: string;
  readonly probeSource: string;
  readonly expectErrors?: boolean;
}): Promise<readonly string[]> => {
  const dir = await mkdtemp(join(tmpdir(), "prism-workflow-refs-typecheck-"));
  try {
    if (options.modelsSource !== undefined) {
      await writeFile(join(dir, "models.ts"), options.modelsSource, "utf8");
    }
    await writeFile(join(dir, "sops.ts"), options.sopsSource, "utf8");
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
    expect(desired.files).toHaveLength(2);
    expect(desired.files[0]?.targetPath).toBe(workflowModelsPath(prismHome, projectKey));
    expect(desired.files[0]?.plugin).toBe(WORKFLOW_REFS_HARNESS);
    expect(desired.files[1]?.targetPath).toBe(workflowSopsPath(prismHome, projectKey));
    expect(desired.files[1]?.plugin).toBe(WORKFLOW_REFS_HARNESS);
    expect(desired.regions).toEqual([]);
  });

  test("renders typed sop phases with live Effect Schema values and no agent cross-imports", () => {
    const output = renderWorkflowSopsModule({ manifest: sopManifest() });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain('"forge": {');
    expect(output).toContain('"beacon": {');
    expect(output).toContain('"explore": {');
    expect(output).toContain('"build": {');
    expect(output).toContain('name: "explore"');
    expect(output).toContain('sop: "beacon"');
    expect(output).toContain('plugin: "forge"');
    expect(output).toContain('purpose: "Map the space before committing."');
    expect(output).toContain('criteria: ["Hypothesis is falsifiable"]');
    expect(output).toContain('escalation: "Ask a human when the audience is unclear"');
    expect(output).toContain('input: Schema.Struct({ "brief": Schema.String }),');
    expect(output).toContain('output: Schema.Struct({ "summary": Schema.String }),');
    expect(output).toContain("framing: {");
    expect(output).not.toContain('./agents.ts');
    expect(output).not.toContain("sourcePath");
    expect(output).not.toContain("renderPhaseAgents");
    expect(output).toContain("} as const satisfies Record<string, Record<string, WorkflowSop>>");
  });

  test("empty manifest produces valid sops module with interfaces and empty sops", () => {
    const output = renderWorkflowSopsModule({ manifest: emptyCompileManifest() });

    expect(output).toContain("Generated by Prism. Do not edit.");
    expect(output).toContain("export interface WorkflowSopPhase");
    expect(output).toContain("export const sops = {");
    expect(output).not.toContain("sourcePath");
    expect(output).toContain("} as const satisfies Record<string, Record<string, WorkflowSop>>");
  });

  test("generated sops module typechecks under the workflow tsconfig and schemas decode at runtime", async () => {
    const manifest = sopManifest();
    const sopsSource = renderWorkflowSopsModule({ manifest });
    await typecheckGeneratedRefs({
      modelsSource: renderWorkflowModelsModule({ manifest }),
      sopsSource,
      probeSource: `
import { Schema } from "effect";
import { sops } from "./sops.ts";

const explore = sops.forge.beacon.phases.explore;
const _name: string = explore.name;
const _sop: string = explore.sop;
const _plugin: string = explore.plugin;
const _criteria: ReadonlyArray<string> = explore.criteria ?? [];
const _escalation: string | undefined = explore.framing?.escalation;
const _input: Schema.Schema.Any | undefined = explore.input;
const _output: Schema.Schema.Any | undefined = explore.output;
void _name; void _sop; void _plugin; void _criteria; void _escalation; void _input; void _output;
`,
    });

    // Runtime parity: the generated module runs and its live schemas decode.
    const dir = await mkdtemp(join(process.cwd(), ".tmp-workflow-sops-runtime-"));
    try {
      const sopsPath = join(dir, "sops.ts");
      await writeFile(sopsPath, sopsSource, "utf8");
      const mod = (await import(sopsPath)) as {
        readonly sops: {
          readonly forge: {
            readonly beacon: {
              readonly phases: {
                readonly explore: {
                  readonly name: "explore";
                  readonly sop: "beacon";
                  readonly plugin: "forge";
                  readonly input: Schema.Schema.AnyNoContext;
                  readonly output: Schema.Schema.AnyNoContext;
                  readonly criteria: ReadonlyArray<string>;
                  readonly framing: { readonly purpose?: string; readonly escalation?: string };
                };
                readonly build: { readonly input?: unknown };
              };
            };
          };
        };
      };
      const explore = mod.sops.forge.beacon.phases.explore;
      const inputSchema = explore.input as Schema.Schema<unknown>;
      expect(Schema.decodeUnknownSync(inputSchema)({ brief: "hello" })).toEqual({ brief: "hello" });
      expect(() => Schema.decodeUnknownSync(inputSchema)({})).toThrow();
      expect(explore.criteria).toEqual(["Hypothesis is falsifiable"]);
      expect(explore.framing.escalation).toBe("Ask a human when the audience is unclear");
      expect(mod.sops.forge.beacon.phases.build.input).toBeUndefined();

      // Binding parity: the generated phase value flows through the real
      // `phase()` DSL with a typed input, no casts.
      const captured: AnyWorkflowTask[] = [];
      const runtime = {
        runTask: (task: AnyWorkflowTask) =>
          Effect.sync(() => {
            captured.push(task);
            return {};
          }) as never,
      };
      await Effect.runPromise(
        phase(runtime, explore, (ctx) =>
          ctx.task({ id: "scope", input: { brief: "typed" }, prompt: "go" })),
      );
      expect(captured[0]?.phase).toBe("beacon:explore");
      expect(captured[0]?.prompt).toContain("## Phase beacon:explore");
      expect(captured[0]?.prompt).toContain('"brief": "typed"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});
