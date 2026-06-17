import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planLowering } from "./lowerers/pi.js";
import type { ComposedAgent } from "./compose.js";
import type { DesiredFile } from "../sync/desired.js";

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

test("pi lowerer owner-qualifies foreign tool bindings and extension only registers owned bindings", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".pi");
  const ownerPluginName = "ot";

  // Create a real owned tool so the Pi extension bundle can be built.
  const sourcePluginPath = join(root, "consumer-plugin");
  const ownedToolPath = join(sourcePluginPath, "tools", "owned.tool.ts");
  await writeText(ownedToolPath, ownedToolSource);

  const consumerAgent: ComposedAgent = {
    name: "consumer",
    description: "Consumer agent that references an owner tool",
    body: "# Consumer\n",
    color: undefined,
    model: {},
    targetOverride: {},
    skills: [],
    allowedSkills: [],
    allowedTools: [],
    toolBindings: [
      {
        kind: "permission",
        logicalName: "echo",
        toolPluginName: ownerPluginName,
        toolName: "echo",
        toolSourcePath: join(root, "owner-tools", "tools", "echo.tool.ts"),
      },
      {
        kind: "permission",
        logicalName: "owned",
        toolPluginName: "consumer-plugin",
        toolName: "owned",
        toolSourcePath: ownedToolPath,
      },
    ],
  };

  const { files: operations } = await planLowering({
    agents: [consumerAgent],
    orbits: [],
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

  const agent = findContentOperation(operations, join("agents", "consumer.md"));
  expect(agent?.content).toContain("ot_echo");

  const extension = findContentOperation(operations, join("extensions", "prism-extension.js"));
  expect(extension).toBeDefined();
  expect(extension?.content).toContain("consumer_plugin_owned");
  expect(extension?.content).not.toContain("ot_echo");

  const bundle = operations.find((operation) => operation.targetPath.endsWith("server.mjs"));
  expect(bundle).toBeUndefined();
});
