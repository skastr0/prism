import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { planLowering } from "./lowerers/pi.js";
import type { ComposedAgent } from "./compose.js";
import { CanonicalTool } from "./sources.js";
import type { DesiredFile } from "../sync/desired.js";
import { PathConflictError } from "../errors.js";
import { readSnapshot } from "../state/store.js";
import { planSync } from "../sync/plan.js";
import { applySync } from "../sync/apply.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-pi-ownership-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const findContentOperation = (
  files: ReadonlyArray<DesiredFile>,
  suffix: string,
): DesiredFile | undefined => files.find((file) => file.targetPath.endsWith(suffix));

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const ownedToolSource = `
import { Schema } from "effect";

export default {
  name: "owned",
  description: "Owned tool for the consumer plugin.",
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  async handle() {
    return {};
  },
};
`;

test("pi lowerer extension registers only the source plugin's canonical tools", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".pi");

  const sourcePluginPath = join(root, "consumer-plugin");
  const ownedToolPath = join(sourcePluginPath, "tools", "owned.tool.ts");
  await writeText(ownedToolPath, ownedToolSource);

  const ownedTool = new CanonicalTool({
    name: "owned",
    sourcePath: ownedToolPath,
    description: "Owned tool for the consumer plugin.",
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    slots: {},
    async handle() {
      return {};
    },
  });

  const consumerAgent: ComposedAgent = {
    name: "consumer",
    description: "Consumer agent",
    body: "# Consumer\n",
    color: undefined,
    model: {},
    targetOverride: {},
    skills: [],
  };

  const { files: operations } = await planLowering({
    agents: [consumerAgent],
    sops: [],
    tools: [ownedTool],
    skills: [],
    hooks: [],
    registry: undefined,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "consumer-plugin",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath,
    },
  });

  const extension = findContentOperation(operations, join("extensions", "prism-extension.js"));
  expect(extension).toBeDefined();
  expect(extension?.content).toContain("consumer_plugin_owned");

  const bundle = operations.find((operation) => operation.targetPath.endsWith("server.mjs"));
  expect(bundle).toBeUndefined();
});

// PQ-162: agents = crash. Pi (like OMP) writes compiled agents to a direct,
// un-namespaced target path (`agents/<name>.md`) rather than a per-plugin
// generated bundle, so two plugins compiling an agent with the same bare
// name are not namespaced apart by construction the way Claude/Antigravity/
// Grok/etc.'s bundled agent surfaces are. This proves the real lowerer
// output for that collision fails closed through the shared sync engine
// (the same `PathConflictError` guard PQ-156/PQ-162 give every owned-file
// artifact kind), naming both plugins — never a silent last write.
test("two plugins compiling a same-named agent to Pi's direct agent surface fail closed, naming both plugins", async () => {
  const root = await createTempRoot();
  const home = await createTempRoot();
  const outputRoot = join(root, ".pi");

  const agentNamed = (name: string, description: string): ComposedAgent => ({
    name,
    description,
    body: `# Agent\n\nAuthored independently by ${description}.\n`,
    color: undefined,
    model: {},
    targetOverride: {},
    skills: [],
    });

  const lowerFor = (sourcePluginName: string) =>
    planLowering({
      // Distinct content per plugin — two independent authors of "builder"
      // never coincidentally hash identical, unlike a shared deterministic
      // mirror (see the content-gate comment on assertNoForeignOwnerConflicts
      // in src/sync/plan.ts). This is the realistic shape the law targets.
      agents: [agentNamed("builder", sourcePluginName)],
      sops: [],
      skills: [],
      hooks: [],
      registry: undefined,
      target: {
        scope: "project",
        root: outputRoot,
        sourcePluginName,
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: join(root, sourcePluginName),
      },
    });

  const first = await lowerFor("agent-forge");
  const second = await lowerFor("agent-quasar");

  const agentTargetPath = join(outputRoot, "agents", "builder.md");
  expect(first.files.some((file) => file.targetPath === agentTargetPath)).toBe(true);
  expect(second.files.some((file) => file.targetPath === agentTargetPath)).toBe(true);

  // Mirrors production: compile/pipeline.ts scopes every planSync call to
  // exactly one plugin (`scopePlugins: new Set([registry.pluginName])`).
  const refreshScoped = async (desired: typeof first, plugin: string) => {
    const snapshot = await readSnapshot({ prismHome: home, harness: "pi", root: outputRoot });
    const plan = await planSync({
      desired: { harness: "pi", root: outputRoot, files: desired.files, regions: desired.regions },
      snapshot: snapshot.manifest,
      scopePlugins: new Set([plugin]),
    });
    return applySync({ prismHome: home, plan });
  };

  await refreshScoped(first, "agent-forge");

  await expect(refreshScoped(second, "agent-quasar")).rejects.toBeInstanceOf(PathConflictError);
  try {
    await refreshScoped(second, "agent-quasar");
    throw new Error("expected a PathConflictError");
  } catch (error) {
    expect(error).toBeInstanceOf(PathConflictError);
    if (!(error instanceof PathConflictError)) throw error;
    expect(error.targetPath).toBe(agentTargetPath);
    expect(error.firstPlugin).toBe("agent-forge");
    expect(error.secondPlugin).toBe("agent-quasar");
  }
});
