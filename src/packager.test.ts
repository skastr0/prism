import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeContentHash } from "./content-hash.js";
import { packagePluginForTarget } from "./packager.js";

const tempRoots: string[] = [];
const originalPrismHome = process.env.PRISM_HOME;

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");
const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-package-"));
  tempRoots.push(root);
  process.env.PRISM_HOME = join(root, "prism-home");
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const pathExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const renderJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const renderManifestWithHash = (body: Record<string, unknown>): string =>
  renderJson({ ...body, manifestHash: computeContentHash(renderJson(body)) });

const runHook = (
  wrapperPath: string,
  payload: unknown,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn("node", [wrapperPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(payload));
  });

afterEach(async () => {
  process.env.PRISM_HOME = originalPrismHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createCodexPromptPlugin = async (root: string): Promise<string> => {
  const pluginRoot = join(root, "prompt-plugin");
  await writeText(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "prompt-plugin",
        version: "0.1.0",
        targets: {
          hooks: ["codex-cli"],
        },
      },
      null,
      2,
    ),
  );
  await writeText(
    join(pluginRoot, "hooks", "prompt-context.hook.ts"),
    `import { defineHook, hookEvent } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "prompt-context",
  event: hookEvent.promptSubmit,
  targets: ["codex-cli"],
  handle: (event) => ({
    decision: "continue",
    additionalContext: "prompt:" + event.prompt,
  }),
});
`,
  );
  return pluginRoot;
};

const createCursorToolPlugin = async (root: string): Promise<string> => {
  const pluginRoot = join(root, "cursor-tool-plugin");
  await writeText(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "cursor-tool-plugin",
        version: "0.1.0",
        targets: {
          tools: ["cursor"],
        },
      },
      null,
      2,
    ),
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo a message",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: input.message };
  },
});
`,
  );
  return pluginRoot;
};

test("packagePluginForTarget writes package payload and activation manifest", async () => {
  const root = await createTempRoot();
  const pluginRoot = await createCodexPromptPlugin(root);

  const result = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "codex-cli",
    generatorVersion: "test",
  });

  expect(result.packageRoot).toBe(
    join(pluginRoot, "dist", "prism", "codex-cli", "prism-generated-prompt-plugin"),
  );
  expect(await pathExists(join(result.packageRoot, ".prism-package.json"))).toBe(true);
  expect(await pathExists(join(result.packageRoot, "prism.activation.json"))).toBe(true);
  expect(await pathExists(join(result.packageRoot, "payload", "hooks", "prompt-context.mjs"))).toBe(true);

  const activation = await readFile(join(result.packageRoot, "prism.activation.json"), "utf8");
  expect(activation).toContain("UserPromptSubmit");
  expect(activation).toContain("config.toml");

});

test("packagePluginForTarget includes MCP HTTP and stdio bundle entries", async () => {
  const root = await createTempRoot();
  const pluginRoot = await createCursorToolPlugin(root);

  const result = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "cursor",
  });

  const mcpRoot = join(
    result.packageRoot,
    "payload",
    "mcp",
    "prism_generated_cursor_tool_plugin",
  );
  expect(await pathExists(join(mcpRoot, "server.mjs"))).toBe(true);
  expect(await pathExists(join(mcpRoot, "entry-stdio.mjs"))).toBe(true);
  const stdio = await readFile(join(mcpRoot, "entry-stdio.mjs"), "utf8");
  expect(stdio).toContain("PRISM_MCP_ENABLED_TOOLS");
  expect(stdio).not.toContain("Bun.serve");
});

test("packaged Codex prompt hook emits additional context JSON", async () => {
  const root = await createTempRoot();
  const pluginRoot = await createCodexPromptPlugin(root);
  const result = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "codex-cli",
  });

  const hookResult = await runHook(
    join(result.packageRoot, "payload", "hooks", "prompt-context.mjs"),
    {
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      prompt: "hello",
      session_id: "s1",
    },
  );

  expect(hookResult.exitCode).toBe(0);
  const output = JSON.parse(hookResult.stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  expect(output.hookSpecificOutput?.additionalContext).toBe("prompt:hello");
});

test("prism.json controls package output positioning", async () => {
  const root = await createTempRoot();
  await writeText(
    join(root, "prism.json"),
    JSON.stringify(
      {
        distribution: {
          outDir: "build/prism",
          packages: {
            "codex-cli": {
              packageId: "codex-prompt",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  const pluginRoot = await createCodexPromptPlugin(root);

  const result = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "codex-cli",
  });

  expect(result.packageRoot).toBe(join(root, "build", "prism", "codex-cli", "codex-prompt"));
});

test("projectPath controls package output positioning when the plugin is outside the project", async () => {
  const root = await createTempRoot();
  const projectRoot = join(root, "project");
  await writeText(
    join(projectRoot, "prism.json"),
    JSON.stringify(
      {
        distribution: {
          outDir: "build/prism",
          packages: {
            "codex-cli": {
              packageId: "project-codex-prompt",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  const pluginRoot = await createCodexPromptPlugin(join(root, "external"));

  const result = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "codex-cli",
    scope: "project",
    projectPath: projectRoot,
  });

  expect(result.packageRoot).toBe(
    join(projectRoot, "build", "prism", "codex-cli", "project-codex-prompt"),
  );
});

test("packagePluginForTarget refuses drifted managed files", async () => {
  const root = await createTempRoot();
  const pluginRoot = await createCodexPromptPlugin(root);
  const first = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "codex-cli",
  });
  await writeText(
    join(first.packageRoot, "payload", "hooks", "prompt-context.mjs"),
    "user edit\n",
  );

  await expect(
    packagePluginForTarget({
      pluginPath: pluginRoot,
      target: "codex-cli",
    }),
  ).rejects.toThrow(/Refusing to overwrite package output/);
});

test("packagePluginForTarget refuses unowned files inside an owned package root", async () => {
  const root = await createTempRoot();
  const pluginRoot = await createCodexPromptPlugin(root);
  const first = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "codex-cli",
  });
  await writeText(join(first.packageRoot, "stray.txt"), "user file\n");

  await expect(
    packagePluginForTarget({
      pluginPath: pluginRoot,
      target: "codex-cli",
    }),
  ).rejects.toThrow(/unowned file exists/);
});

test("packagePluginForTarget refuses edited package manifests", async () => {
  const root = await createTempRoot();
  const pluginRoot = await createCodexPromptPlugin(root);
  const first = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "codex-cli",
  });
  const manifestPath = join(first.packageRoot, ".prism-package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  await writeText(manifestPath, JSON.stringify({ ...manifest, version: 2 }, null, 2));

  await expect(
    packagePluginForTarget({
      pluginPath: pluginRoot,
      target: "codex-cli",
    }),
  ).rejects.toThrow(/Package manifest is invalid/);
});

test("packagePluginForTarget refuses manifest file paths that escape the package root", async () => {
  const root = await createTempRoot();
  const pluginRoot = await createCodexPromptPlugin(root);
  const first = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "codex-cli",
  });
  const outsidePath = join(first.packageRoot, "..", "outside.txt");
  await writeText(outsidePath, "outside\n");

  const manifestPath = join(first.packageRoot, ".prism-package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const { manifestHash: _manifestHash, ...body } = manifest;
  const files = Array.isArray(body.files) ? body.files : [];
  await writeText(
    manifestPath,
    renderManifestWithHash({
      ...body,
      files: [
        ...files,
        {
          path: "../outside.txt",
          role: "payload",
          hash: computeContentHash("outside\n"),
        },
      ],
    }),
  );

  await expect(
    packagePluginForTarget({
      pluginPath: pluginRoot,
      target: "codex-cli",
    }),
  ).rejects.toThrow(/safe package-relative path/);
  expect(await pathExists(outsidePath)).toBe(true);
});

test("packagePluginForTarget updates owned package output when source changes", async () => {
  const root = await createTempRoot();
  const pluginRoot = await createCodexPromptPlugin(root);
  const first = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "codex-cli",
  });

  await writeText(
    join(pluginRoot, "hooks", "prompt-context.hook.ts"),
    `import { defineHook, hookEvent } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "prompt-context",
  event: hookEvent.promptSubmit,
  targets: ["codex-cli"],
  handle: (event) => ({
    decision: "continue",
    additionalContext: "updated:" + event.prompt,
  }),
});
`,
  );

  const second = await packagePluginForTarget({
    pluginPath: pluginRoot,
    target: "codex-cli",
  });

  expect(second.packageRoot).toBe(first.packageRoot);
  expect(
    second.operations.some((operation) =>
      operation.type === "write" && operation.path.endsWith(".prism-package.json")
    ),
  ).toBe(true);

  const hookResult = await runHook(
    join(second.packageRoot, "payload", "hooks", "prompt-context.mjs"),
    {
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      prompt: "hello",
      session_id: "s1",
    },
  );
  const output = JSON.parse(hookResult.stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  expect(output.hookSpecificOutput?.additionalContext).toBe("updated:hello");
});
