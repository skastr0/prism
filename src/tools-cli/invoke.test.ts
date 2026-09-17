import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateToolCliRuntimeBundle } from "../compile/tool-runtime-bundle.js";
import { bindingFromToolSource } from "../compile/tool-bindings.js";
import { writeToolCliCatalog } from "./catalog.js";
import { invokeToolViaCli, ToolsCliInvokeError } from "./invoke.js";
import { prismToolRuntimePath } from "./paths.js";
import { effectImportPath } from "../testing/prism-sandbox.js";

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

  const hangToolPath = join(pluginRoot, "tools", "hang.tool.ts");
  await writeText(
    hangToolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "hang",
  description: "Never resolves; rejects the moment the runtime aborts it.",
  input: Schema.Struct({}),
  output: Schema.Struct({ ok: Schema.Boolean }),
  async handle(_input, context) {
    return await new Promise((_resolve, reject) => {
      context.signal?.addEventListener("abort", () => reject(new Error("hang aborted by signal")), { once: true });
    });
  },
};
`,
  );

  const bindings = [
    bindingFromToolSource(pluginName, toolPath),
    bindingFromToolSource(pluginName, hangToolPath),
  ];
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

  // Strict input decode: a misspelled field is rejected at the tool boundary
  // instead of being silently stripped before the handler runs.
  const typo = await invokeToolViaCli({
    prismHome,
    pluginName,
    toolName: "echo",
    input: { message: "x", mesage: "typo" },
  }).catch((error: unknown) => error);
  expect(typo).toBeInstanceOf(ToolsCliInvokeError);
  expect((typo as ToolsCliInvokeError).message).toMatch(/mesage|excess|unexpected/i);

  // Timeout settles its own error BEFORE aborting: the hang tool rejects on
  // abort, yet the caller consistently sees the timeout message and exit
  // code 2 — not the tool's abort message. The aborted tool's cleanup gets a
  // bounded grace period before the error propagates.
  (globalThis as Record<string, unknown>).__jevInvokeHangCleanup = false;
  const timedOut = await invokeToolViaCli({
    prismHome,
    pluginName,
    toolName: "hang",
    input: {},
    timeoutMs: 50,
  }).catch((error: unknown) => error);
  expect(timedOut).toBeInstanceOf(ToolsCliInvokeError);
  expect((timedOut as ToolsCliInvokeError).message).toContain("timed out after 50ms");
  expect((timedOut as ToolsCliInvokeError).message).not.toContain("hang aborted");
  expect((timedOut as ToolsCliInvokeError).exitCode).toBe(2);

  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = await invokeToolViaCli({
      prismHome,
      pluginName,
      toolName: "echo",
      input: { message: "x" },
      timeoutMs: bad,
    }).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(ToolsCliInvokeError);
    expect((invalid as ToolsCliInvokeError).message).toContain(
      "--timeout-ms must be a positive finite number",
    );
    expect((invalid as ToolsCliInvokeError).exitCode).toBe(1);
  }
});
