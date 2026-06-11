import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComposedAgent } from "./compose.js";
import { planLowering } from "./lowerers/opencode.js";
import { applySync } from "../sync/apply.js";
import { planSync } from "../sync/plan.js";
import { emptySnapshotManifest } from "../state/snapshot.js";
import type { ResolvedContractBinding } from "./resolve.js";
import { Contract } from "./sources.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-opencode-lowerer-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

const createComposedAgent = (
  toolBindings: ReadonlyArray<ResolvedContractBinding>,
  overrides: Partial<ComposedAgent> = {},
): ComposedAgent => ({
  name: "worker",
  description: "Worker agent",
  body: "# Worker\n",
  color: undefined,
  model: undefined,
  targetOverride: {},
  skills: [],
  allowedSkills: [],
  toolBindings,
  allowedTools: [],
  ...overrides,
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("opencode planLowering is pure desired state: agent files plus per-key config regions", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".opencode");

  const lowered = await planLowering({
    agents: [
      createComposedAgent([], {
        model: { model: "anthropic/claude", temperature: 0.2 },
        color: "green",
      }),
    ],
    orbits: [],
    tools: [],
    target: {
      scope: "global",
      root: outputRoot,
      sourcePluginName: "opencode-lowerer-test",
    },
  });

  const agentMd = lowered.files.find((file) =>
    file.targetPath.endsWith(join("agents", "worker.md")),
  );
  expect(agentMd).toBeDefined();
  expect(agentMd!.content).toContain("name: worker");
  // Owner markers are gone — ownership is snapshot-manifest membership.
  expect(agentMd!.content).not.toContain("<!-- prism:");

  const regionKeys = lowered.regions.map((region) => region.regionKey).sort();
  expect(regionKeys).toEqual([
    "agent.worker.color",
    "agent.worker.model",
    "agent.worker.temperature",
  ]);
  for (const region of lowered.regions) {
    expect(region.targetPath).toBe(join(outputRoot, "opencode.json"));
    expect(region.kind).toBe("json-key");
  }
});

test("opencode config regions preserve hand-authored opencode.json content", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".opencode");
  const prismHome = join(root, "prism-home");
  const jsonTarget = join(outputRoot, "opencode.json");

  await writeText(
    jsonTarget,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: ["user-plugin"],
        agent: { worker: { handAuthored: true }, other: { model: "user/model" } },
        permission: { bash: "ask" },
      },
      null,
      2,
    )}\n`,
  );

  const lowered = await planLowering({
    agents: [createComposedAgent([], { model: { model: "anthropic/claude" } })],
    orbits: [],
    tools: [],
    target: {
      scope: "global",
      root: outputRoot,
      sourcePluginName: "opencode-lowerer-test",
    },
  });

  const plan = await planSync({
    desired: {
      harness: "opencode",
      root: outputRoot,
      files: lowered.files,
      regions: lowered.regions,
    },
    snapshot: emptySnapshotManifest({ harness: "opencode", root: outputRoot }),
  });
  await applySync({ prismHome, plan });

  const config = await readJson<{
    $schema: string;
    plugin: string[];
    agent: Record<string, Record<string, unknown>>;
    permission: Record<string, string>;
  }>(jsonTarget);

  // Owned keys landed; everything hand-authored survived untouched.
  expect(config.agent.worker).toEqual({ handAuthored: true, model: "anthropic/claude" });
  expect(config.agent.other).toEqual({ model: "user/model" });
  expect(config.plugin).toEqual(["user-plugin"]);
  expect(config.permission).toEqual({ bash: "ask" });
  expect(config.$schema).toBe("https://opencode.ai/config.json");
});

test("opencode orphaned regions are removed without touching neighbors", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".opencode");
  const prismHome = join(root, "prism-home");
  const jsonTarget = join(outputRoot, "opencode.json");

  const lower = (agents: ComposedAgent[]) =>
    planLowering({
      agents,
      orbits: [],
      tools: [],
      target: {
        scope: "global",
        root: outputRoot,
        sourcePluginName: "opencode-lowerer-test",
      },
    });

  const first = await lower([
    createComposedAgent([], { model: { model: "anthropic/claude", temperature: 0.2 } }),
  ]);
  const firstPlan = await planSync({
    desired: { harness: "opencode", root: outputRoot, files: first.files, regions: first.regions },
    snapshot: emptySnapshotManifest({ harness: "opencode", root: outputRoot }),
  });
  await applySync({ prismHome, plan: firstPlan });

  // User adds their own key next to Prism's.
  const withUserKey = await readJson<Record<string, any>>(jsonTarget);
  withUserKey.agent.worker.handAuthored = true;
  await writeFile(jsonTarget, `${JSON.stringify(withUserKey, null, 2)}\n`);

  // Second compile drops temperature — its region must be removed as orphaned.
  const second = await lower([createComposedAgent([], { model: { model: "anthropic/claude" } })]);
  const { readSnapshot } = await import("../state/store.js");
  const snapshot = await readSnapshot({ prismHome, harness: "opencode", root: outputRoot });
  const secondPlan = await planSync({
    desired: { harness: "opencode", root: outputRoot, files: second.files, regions: second.regions },
    snapshot: snapshot.manifest,
  });
  await applySync({ prismHome, plan: secondPlan });

  const config = await readJson<Record<string, any>>(jsonTarget);
  expect(config.agent.worker).toEqual({ model: "anthropic/claude", handAuthored: true });
});

test("opencode generated plugin registration is a plugin-array membership region", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".opencode");
  const pluginRoot = join(root, "plugin-src");
  const toolSource = join(pluginRoot, "tools", "submit.tool.ts");
  await writeText(
    toolSource,
    [
      `import { Schema } from "effect";`,
      ``,
      `export default {`,
      `  description: "submit",`,
      `  Input: Schema.Struct({ message: Schema.String }),`,
      `  handle: async (input: { message: string }) => ({ ok: true, message: input.message }),`,
      `};`,
      ``,
    ].join("\n"),
  );

  const lowered = await planLowering({
    agents: [
      createComposedAgent([
        {
          kind: "permission",
          logicalName: "submit",
          toolPluginName: "opencode-lowerer-test",
          toolName: "submit",
          toolSourcePath: toolSource,
        },
      ]),
    ],
    orbits: [],
    tools: [],
    target: {
      scope: "global",
      root: outputRoot,
      sourcePluginName: "opencode-lowerer-test",
    },
  });

  const bundle = lowered.files.find((file) =>
    file.targetPath.endsWith(join("dist", "server.mjs")),
  );
  expect(bundle).toBeDefined();

  const pluginRegion = lowered.regions.find(
    (region) => region.kind === "json-array-member" && region.regionKey.startsWith("plugin."),
  );
  expect(pluginRegion).toBeDefined();
  if (pluginRegion?.kind !== "json-array-member") throw new Error("unreachable");
  expect(pluginRegion.jsonPath).toEqual(["plugin"]);
  expect(pluginRegion.value).toBe(
    pathToFileURL(join(outputRoot, "plugins", "prism-generated-opencode-lowerer-test")).href,
  );

  const permissionRegion = lowered.regions.find(
    (region) => region.kind === "json-key" && region.regionKey.startsWith("permission."),
  );
  expect(permissionRegion).toBeDefined();
  if (permissionRegion?.kind !== "json-key") throw new Error("unreachable");
  expect(permissionRegion.value).toBe("deny");
}, 60000);

test("opencode planLowering reports generated contract mirror collisions", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".opencode");
  const pluginRoot = join(root, "mirror-demo");
  const sourcePath = join(pluginRoot, "tools", "submit.tool.ts");
  const generatedPath = "contracts/submit.contract.ts";

  const firstContract = new Contract({
    name: "submit-a",
    sourcePath,
    pluginName: "mirror-demo",
    generatedFiles: [{ relativePath: generatedPath, content: "export const value = 1;\n" }],
  });
  const secondContract = new Contract({
    name: "submit-b",
    sourcePath,
    pluginName: "mirror-demo",
    generatedFiles: [{ relativePath: generatedPath, content: "export const value = 2;\n" }],
  });

  await expect(
    planLowering({
      agents: [
        createComposedAgent([
          {
            kind: "synthetic",
            logicalName: "submitA",
            contract: firstContract,
            toolPluginName: "mirror-demo",
            toolName: "submit-a",
            toolSourcePath: sourcePath,
          },
          {
            kind: "synthetic",
            logicalName: "submitB",
            contract: secondContract,
            toolPluginName: "mirror-demo",
            toolName: "submit-b",
            toolSourcePath: sourcePath,
          },
        ]),
      ],
      orbits: [],
      tools: [],
      target: {
        scope: "project",
        root: outputRoot,
        sourcePluginName: "mirror-demo",
      },
    }),
  ).rejects.toThrow(
    "generated contract name collision at mirror-demo:contracts/submit.contract.ts",
  );
});
