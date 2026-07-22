import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateToolCliRuntimeBundle } from "../compile/tool-runtime-bundle.js";
import { bindingFromToolSource } from "../compile/tool-bindings.js";
import { writeToolCliCatalog } from "./catalog.js";
import { invokeToolViaCli, ToolsCliInvokeError } from "./invoke.js";
import { prismToolRuntimePath } from "./paths.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

test("CLI invoke runs tools in-process without a daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-tools-cli-runtime-"));
  tempRoots.push(root);
  const prismHome = join(root, "prism-home");
  const pluginName = "session-cleanup";
  const pluginRoot = join(root, "plugin");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");
  const effectImportPath = join(
    process.cwd(),
    "node_modules",
    "effect",
    "dist",
    "esm",
    "index.js",
  ).replace(/\\/g, "/");

  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo",
  description: "Exercise in-process CLI invoke.",
  input: Schema.Struct({ message: Schema.String, fail: Schema.optional(Schema.Boolean) }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    if (input.fail) throw new Error("fixture tool failure");
    return { echoed: input.message };
  },
};
`,
  );

  const bindings = [bindingFromToolSource(pluginName, toolPath)];
  const bundle = await generateToolCliRuntimeBundle({
    sourcePluginName: pluginName,
    sourcePluginRoot: pluginRoot,
    version: "0.1.0",
    bindings,
  });

  await mkdir(dirname(prismToolRuntimePath(prismHome, pluginName)), { recursive: true });
  await writeText(prismToolRuntimePath(prismHome, pluginName), bundle.content);
  await writeToolCliCatalog({
    prismHome,
    pluginName,
    pluginVersion: "0.1.0",
    bindings,
  });

  for (let index = 0; index < 20; index += 1) {
    await expect(
      invokeToolViaCli({
        prismHome,
        pluginName,
        toolName: "echo",
        input: { message: `call-${index}` },
      }),
    ).resolves.toEqual({ echoed: `call-${index}` });
  }

  await expect(
    invokeToolViaCli({
      prismHome,
      pluginName,
      toolName: "echo",
      input: { message: "x", fail: true },
    }),
  ).rejects.toBeInstanceOf(ToolsCliInvokeError);

  await expect(
    invokeToolViaCli({
      prismHome,
      pluginName,
      toolName: "missing",
      input: {},
    }),
  ).rejects.toBeInstanceOf(ToolsCliInvokeError);
});
