import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCanonicalCompileFixture } from "./compile/test-fixtures.js";
import { prismOxlintPluginJs } from "./init-templates.js";
import { computeContentHash } from "./content-hash.js";
import {
  managedEntryId,
  readHarnessLedger,
  writeHarnessLedger,
} from "./managed-ledger.js";

const tempRoots: string[] = [];
const cliTestToken = "prism-cli-test-token-with-enough-entropy";

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-cli-"));
  tempRoots.push(root);
  return root;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const mergeEnv = (overrides: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );

const runCli = async (
  args: string[],
  envOverrides: Record<string, string>
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", join(process.cwd(), "src", "cli.ts"), ...args],
    cwd: process.cwd(),
    env: mergeEnv(envOverrides),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const getFreePort = (host: string): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });

test("install and compile help use managed backup policy instead of a per-run backup flag", async () => {
  for (const command of ["install", "install-all", "compile"]) {
    const result = await runCli([command, "--help"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).not.toContain("--backup");
    expect(result.stdout).not.toContain(".bak");
    if (command === "compile") {
      expect(result.stdout).toContain("'pi'");
      expect(result.stdout).toContain("'kimi-code'");
    }
  }
});

type JsonObject = Record<string, unknown>;

type LintRule = {
  create: (context: {
    getFilename: () => string;
    report: (diagnostic: JsonObject) => void;
  }) => Record<string, ((node: JsonObject) => void) | undefined>;
};

type LintPlugin = {
  rules: Record<string, LintRule>;
};

const readJson = async (path: string): Promise<JsonObject> =>
  JSON.parse(await readFile(path, "utf8")) as JsonObject;

const loadGeneratedLintPlugin = async (): Promise<LintPlugin> => {
  const root = await createTempRoot();
  const pluginPath = join(root, "prism-oxlint-plugin.mjs");
  await writeFile(pluginPath, prismOxlintPluginJs);
  const module = (await import(pathToFileURL(pluginPath).href)) as { default: LintPlugin };
  return module.default;
};

const identifier = (name: string): JsonObject => ({ type: "Identifier", name });
const literal = (value: string): JsonObject => ({ type: "Literal", value });
const memberExpression = (object: JsonObject, property: JsonObject): JsonObject => ({
  type: "MemberExpression",
  object,
  property,
});
const callExpression = (callee: JsonObject, args: JsonObject[]): JsonObject => ({
  type: "CallExpression",
  callee,
  arguments: args,
});
const property = (name: string, value: JsonObject): JsonObject => ({
  type: "Property",
  key: identifier(name),
  value,
});
const objectExpression = (properties: JsonObject[]): JsonObject => ({
  type: "ObjectExpression",
  properties,
});
const schemaStructCall = (): JsonObject =>
  callExpression(memberExpression(identifier("Schema"), identifier("Struct")), [
    objectExpression([]),
  ]);

const runGeneratedRule = async (
  ruleName: string,
  node: JsonObject,
  filename = "agents/builder.agent.ts"
): Promise<JsonObject[]> => {
  const plugin = await loadGeneratedLintPlugin();
  const reports: JsonObject[] = [];
  const visitors = plugin.rules[ruleName]?.create({
    getFilename: () => filename,
    report: (diagnostic) => reports.push(diagnostic),
  });

  visitors?.CallExpression?.(node);
  return reports;
};

const createInstallAllFixture = async (): Promise<{
  monorepoRoot: string;
  projectRoot: string;
  homeRoot: string;
}> => {
  const root = await createTempRoot();
  const monorepoRoot = join(root, "monorepo");
  const projectRoot = join(root, "project-root");
  const homeRoot = join(root, "home");
  const compilePluginRoot = join(monorepoRoot, "trait-orbit-contracts");

  await mkdir(monorepoRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeRoot, { recursive: true });

  await createCanonicalCompileFixture({
    pluginRoot: compilePluginRoot,
    projectRoot,
    withCanonicalToolBindings: false,
  });

  return { monorepoRoot, projectRoot, homeRoot };
};

const createCliMcpFixture = async (options?: {
  readonly harness?: "hermes" | "codex-cli" | "cursor";
  readonly streamableHttp?: boolean;
  readonly port?: number;
  readonly tokenEnv?: string;
}): Promise<{
  pluginRoot: string;
  hermesRoot: string;
}> => {
  const root = await createTempRoot();
  const harness = options?.harness ?? "hermes";
  const pluginRoot = join(root, "cli-hermes-tools");
  const hermesRoot = join(root, "hermes-root");
  await mkdir(hermesRoot, { recursive: true });
  await writeFile(join(hermesRoot, "config.yaml"), "existing: true\n");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "cli-hermes-tools",
        version: "0.1.0",
        targets: { tools: [harness] },
        ...(options?.streamableHttp
          ? {
              runtime: {
                mcp: {
                  [harness]: {
                    transport: "streamable-http",
                    host: "127.0.0.1",
                    port: options.port,
                    tokenEnv: options.tokenEnv ?? "PRISM_MCP_CLI_TEST_TOKEN",
                  },
                },
              },
            }
          : {}),
      },
      null,
      2,
    ),
  );
  await mkdir(join(pluginRoot, "tools"), { recursive: true });
  await writeFile(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo through CLI lifecycle.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );
  return { pluginRoot, hermesRoot };
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test("init --typescript scaffolds OXC configs, scripts, and local plugin", async () => {
  const root = await createTempRoot();

  const result = await runCli(["init", "typed-plugin", "--dir", root, "--typescript"], {});

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(".oxlintrc.json");
  expect(result.stdout).toContain(".oxfmtrc.json");
  expect(result.stdout).toContain("prism-oxlint-plugin.js");

  const pluginRoot = join(root, "typed-plugin");
  const packageJson = await readJson(join(pluginRoot, "package.json"));
  expect(packageJson.scripts).toMatchObject({
    lint: "oxlint .",
    "lint:fix": "oxlint . --fix",
    format: "oxfmt . --write",
    "format:check": "oxfmt . --check",
    typecheck: "tsc --noEmit",
  });
  expect(packageJson.devDependencies).toMatchObject({
    oxlint: "^1.62.0",
    oxfmt: "^0.47.0",
    typescript: "^5.8.3",
  });

  const oxlintConfig = await readJson(join(pluginRoot, ".oxlintrc.json"));
  expect(oxlintConfig.jsPlugins).toEqual([
    {
      name: "prism",
      specifier: "./prism-oxlint-plugin.js",
    },
  ]);
  expect(oxlintConfig.rules).toMatchObject({
    "prism/no-inline-slot-schemas": "error",
    "prism/no-trait-tool-contract-overrides": "error",
  });

  const oxfmtConfig = await readJson(join(pluginRoot, ".oxfmtrc.json"));
  expect(oxfmtConfig.$schema).toBe("./node_modules/oxfmt/configuration_schema.json");

  expect(await pathExists(join(pluginRoot, "README.md"))).toBe(false);
});

test("mcp serve/status/stop manages a Hermes daemon under an override root", async () => {
  const { pluginRoot, hermesRoot } = await createCliMcpFixture();
  const env = { PRISM_MCP_CLI_TEST_TOKEN: cliTestToken };
  const common = [
    pluginRoot,
    "--harness",
    "hermes",
    "--root",
    hermesRoot,
    "--token-env",
    "PRISM_MCP_CLI_TEST_TOKEN",
  ];

  const originalConfig = await readFile(join(hermesRoot, "config.yaml"), "utf8").catch(() => "");
  const serve = await runCli(["mcp", "serve", ...common, "--port", "auto"], env);
  try {
    expect(serve.exitCode).toBe(0);
    expect(serve.stdout).toContain("started prism-generated-cli-hermes-tools");

    const status = await runCli(["mcp", "status", ...common], env);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("running");
    expect(status.stdout).toContain("prism-generated-cli-hermes-tools");

    const listStatus = await runCli([
      "mcp",
      "status",
      "--harness",
      "hermes",
      "--root",
      hermesRoot,
      "--token-env",
      "PRISM_MCP_CLI_TEST_TOKEN",
    ], env);
    expect(listStatus.exitCode).toBe(0);
    expect(listStatus.stdout).toContain("running");
    expect(listStatus.stdout).toContain("prism-generated-cli-hermes-tools");

    const secondServe = await runCli(["mcp", "serve", ...common, "--port", "auto"], env);
    expect(secondServe.exitCode).toBe(0);
    expect(secondServe.stdout).toContain("already-running prism-generated-cli-hermes-tools");

    const restart = await runCli(["mcp", "restart", ...common, "--port", "auto"], env);
    expect(restart.exitCode).toBe(0);
    expect(restart.stdout).toContain("started prism-generated-cli-hermes-tools");

    const stop = await runCli(["mcp", "stop", ...common], env);
    if (stop.exitCode !== 0) {
      throw new Error(`mcp stop failed\nstdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`);
    }
    expect(stop.stdout).toContain("stopped prism-generated-cli-hermes-tools");

    const stopped = await runCli(["mcp", "status", ...common], env);
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toContain("stopped");
    expect(await readFile(join(hermesRoot, "config.yaml"), "utf8").catch(() => "")).toBe(originalConfig);
  } finally {
    await runCli(["mcp", "stop", ...common], env).catch(() => undefined);
  }
}, 15_000);

test("mcp status accepts supported non-Hermes lifecycle harnesses", async () => {
  const { pluginRoot, hermesRoot } = await createCliMcpFixture({ harness: "cursor" });

  const status = await runCli([
    "mcp",
    "status",
    pluginRoot,
    "--harness",
    "cursor",
    "--root",
    hermesRoot,
  ], {});

  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("stopped");
  expect(status.stdout).toContain("prism-generated-cli-hermes-tools");
});

test("install runs Cursor lowerer cleanup when tools target is removed", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "cursor-cleanup-plugin");
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");
  const cursorRoot = join(homeRoot, ".cursor");
  const configPath = join(cursorRoot, "mcp.json");
  const serverPath = join(
    cursorRoot,
    "mcp",
    "prism_generated_cursor_cleanup_plugin",
    "server.mjs",
  );
  const serverContent = "console.log('stale Cursor MCP runtime');\n";

  await mkdir(pluginRoot, { recursive: true });
  await mkdir(join(cursorRoot, "mcp", "prism_generated_cursor_cleanup_plugin"), {
    recursive: true,
  });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "cursor-cleanup-plugin",
        version: "0.1.0",
        targets: {},
      },
      null,
      2,
    ),
  );
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        mcpServers: {
          "prism-generated-cursor-cleanup-plugin": {
            type: "stdio",
            command: "bun",
            args: [serverPath],
          },
          userServer: { url: "https://example.com/mcp" },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(serverPath, serverContent);

  const configEntryId = managedEntryId({
    harness: "cursor",
    scope: "global",
    root: cursorRoot,
    pluginName: "cursor-cleanup-plugin",
    artifact: "compile",
    targetPath: configPath,
    kind: "config",
  });
  const serverEntryId = managedEntryId({
    harness: "cursor",
    scope: "global",
    root: cursorRoot,
    pluginName: "cursor-cleanup-plugin",
    artifact: "compile",
    targetPath: serverPath,
    kind: "file",
  });
  await writeHarnessLedger({
    ...(await readHarnessLedger("cursor", prismHome)),
    entries: [
      {
        id: configEntryId,
        pluginName: "cursor-cleanup-plugin",
        pluginVersion: "0.1.0",
        pluginPath: pluginRoot,
        harness: "cursor",
        scope: "global",
        root: cursorRoot,
        artifact: "compile",
        targetPath: configPath,
        kind: "config",
        contentHash: computeContentHash(await readFile(configPath, "utf8")),
        updatedAt: new Date().toISOString(),
      },
      {
        id: serverEntryId,
        pluginName: "cursor-cleanup-plugin",
        pluginVersion: "0.1.0",
        pluginPath: pluginRoot,
        harness: "cursor",
        scope: "global",
        root: cursorRoot,
        artifact: "compile",
        targetPath: serverPath,
        kind: "file",
        contentHash: computeContentHash(serverContent),
        updatedAt: new Date().toISOString(),
      },
    ],
  }, prismHome);

  const result = await runCli(
    [
      "install",
      pluginRoot,
      "--harness",
      "cursor",
      "--compile-root",
      cursorRoot,
      "--no-validate",
    ],
    { HOME: homeRoot, PRISM_HOME: prismHome },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Compile (cursor, global)");
  expect(await pathExists(serverPath)).toBe(false);
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  expect(config.mcpServers?.["prism-generated-cursor-cleanup-plugin"]).toBeUndefined();
  expect(config.mcpServers?.userServer).toEqual({ url: "https://example.com/mcp" });
  expect(
    (await readHarnessLedger("cursor", prismHome)).entries.some(
      (entry) => entry.id === serverEntryId,
    ),
  ).toBe(false);
});

test("install serves Hermes HTTP MCP by default", async () => {
  const port = await getFreePort("127.0.0.1");
  const tokenEnv = "PRISM_MCP_CLI_INSTALL_GATE_TOKEN";
  const { pluginRoot, hermesRoot } = await createCliMcpFixture({
    streamableHttp: true,
    port,
    tokenEnv,
  });
  const env = { [tokenEnv]: cliTestToken };
  const common = [
    "install",
    pluginRoot,
    "--harness",
    "hermes",
    "--compile-root",
    hermesRoot,
    "--no-validate",
  ];

  const served = await runCli(common, env);
  try {
    expect(served.exitCode).toBe(0);
    expect(served.stdout).toContain("Compile (hermes, global)");
    const config = await readFile(join(hermesRoot, "config.yaml"), "utf8");
    expect(config).toContain(`url: "http://127.0.0.1:${port}/mcp"`);
    expect(config).toContain(`Authorization: "Bearer ${cliTestToken}"`);
  } finally {
    await runCli([
      "mcp",
      "stop",
      pluginRoot,
      "--harness",
      "hermes",
      "--root",
      hermesRoot,
      "--token-env",
      tokenEnv,
    ], env).catch(() => undefined);
  }
}, 20_000);

test("init --with-agent scaffolds TypeScript agent sources, not source markdown agents", async () => {
  const root = await createTempRoot();

  const result = await runCli(["init", "typed-agent", "--dir", root, "--with-agent"], {});

  expect(result.exitCode).toBe(0);

  const pluginRoot = join(root, "typed-agent");
  expect(await pathExists(join(pluginRoot, "agents", "reviewer.agent.ts"))).toBe(true);
  expect(await pathExists(join(pluginRoot, "identities", "reviewer.identity.md"))).toBe(true);
  expect(await pathExists(join(pluginRoot, "agents", "reviewer.md"))).toBe(false);
});

test("validate rejects source markdown agents", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "source-markdown-agent");
  await mkdir(join(pluginRoot, "agents"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "source-markdown-agent",
        version: "0.1.0",
        targets: { agents: ["opencode"] },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginRoot, "agents", "reviewer.md"),
    `---
description: Source markdown agent
---

You are a reviewer.
`,
  );

  const result = await runCli(["validate", pluginRoot], {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Source markdown agents are not supported");
});

test("validate rejects file-level install targets in shared and overlay artifacts", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "file-level-targets");
  await mkdir(join(pluginRoot, "rules", "global"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "testing"), { recursive: true });
  await mkdir(join(pluginRoot, "harness", "opencode", "commands"), { recursive: true });
  await mkdir(join(pluginRoot, "harness", "opencode", "skills", "debugging"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "file-level-targets",
        version: "0.1.0",
        targets: {
          rules: ["opencode"],
          commands: ["opencode"],
          skills: ["opencode"],
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginRoot, "rules", "global", "standards.md"),
    "---\ntargets: [opencode]\n---\n\n# Standards\n",
  );
  await writeFile(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\ntargets: [opencode]\n---\n\n# Testing\n",
  );
  await writeFile(
    join(pluginRoot, "harness", "opencode", "commands", "review.md"),
    "---\ntargets: [opencode]\n---\n\n# Review\n",
  );
  await writeFile(
    join(pluginRoot, "harness", "opencode", "skills", "debugging", "SKILL.md"),
    "---\nname: debugging\ndescription: Debugging guidance\ntargets: [opencode]\n---\n\n# Debugging\n",
  );
  await writeFile(
    join(pluginRoot, "harness", "opencode", "skills", "debugging", "notes.md"),
    "---\ntargets: [opencode]\n---\n\nIgnored support file.\n",
  );

  const result = await runCli(["validate", pluginRoot], {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "File-level install targets are not supported in rules/global/standards.md. Move install scope to plugin.json targets.rules",
  );
  expect(result.stderr).toContain(
    "File-level install targets are not supported in skills/testing/SKILL.md. Move install scope to plugin.json targets.skills",
  );
  expect(result.stderr).toContain(
    "File-level install targets are not supported in harness/opencode/commands/review.md. Move install scope to plugin.json targets.commands",
  );
  expect(result.stderr).toContain(
    "File-level install targets are not supported in harness/opencode/skills/debugging/SKILL.md. Move install scope to plugin.json targets.skills",
  );
  expect(result.stderr).not.toContain("notes.md. Move install scope");
});

test("validate rejects agent targets for harnesses without compile lowerers", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "unsupported-agent-target");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "unsupported-agent-target",
        version: "0.1.0",
        targets: { agents: ["opencode", "cursor"] },
      },
      null,
      2,
    ),
  );

  const result = await runCli(["validate", pluginRoot], {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("targets.agents resolves to unsupported compile harnesses");
});

test("validate summarizes warnings when not verbose", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "skill-warning-summary");
  await mkdir(join(pluginRoot, "skills", "testing"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "skill-warning-summary",
        version: "0.1.0",
        targets: { skills: ["codex-cli"] },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    `---
name: renamed-testing
description: Testing guidance
---

# Testing
`,
  );

  const result = await runCli(["validate", pluginRoot], {});

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("✅ renamed-testing");
  expect(result.stdout).toContain("Plugin is valid (run with --verbose to see warnings)");
  expect(result.stdout).not.toContain(
    "Skill name 'renamed-testing' does not match directory name 'testing'",
  );
});

test("validate --verbose prints warnings", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "skill-warning-verbose");
  await mkdir(join(pluginRoot, "skills", "testing"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "skill-warning-verbose",
        version: "0.1.0",
        targets: { skills: ["codex-cli"] },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    `---
name: renamed-testing
description: Testing guidance
---

# Testing
`,
  );

  const result = await runCli(["validate", pluginRoot, "--verbose"], {});

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("✅ renamed-testing");
  expect(result.stdout).toContain(
    "Skill name 'renamed-testing' does not match directory name 'testing'",
  );
  expect(result.stdout).toContain("✅ Plugin is valid");
  expect(result.stdout).not.toContain("run with --verbose");
});

test("generated Oxlint rule rejects inline Schema slot fills but allows imported schemas", async () => {
  const invalidBinding = callExpression(identifier("bindTrait"), [
    literal("submittable"),
    objectExpression([
      property(
        "tools",
        objectExpression([
          property(
            "submit_work",
            objectExpression([
              property(
                "slots",
                objectExpression([property("builder_report", schemaStructCall())])
              ),
            ])
          ),
        ])
      ),
    ]),
  ]);
  const validBinding = callExpression(identifier("bindTrait"), [
    literal("submittable"),
    objectExpression([
      property(
        "tools",
        objectExpression([
          property(
            "submit_work",
            objectExpression([
              property(
                "slots",
                objectExpression([property("builder_report", identifier("BuilderReport"))])
              ),
            ])
          ),
        ])
      ),
    ]),
  ]);

  await expect(
    runGeneratedRule("no-inline-slot-schemas", invalidBinding)
  ).resolves.toHaveLength(1);
  await expect(
    runGeneratedRule("no-inline-slot-schemas", validBinding)
  ).resolves.toHaveLength(0);
  await expect(
    runGeneratedRule("no-inline-slot-schemas", invalidBinding, "tools/submit_work.tool.ts")
  ).resolves.toHaveLength(0);
});

test("generated Oxlint rule rejects trait-owned slots and tool input/output replacement", async () => {
  const traitDefinition = callExpression(identifier("defineTrait"), [
    objectExpression([
      property("name", literal("submittable")),
      property("slots", objectExpression([property("builder_report", objectExpression([]))])),
      property(
        "tools",
        objectExpression([
          property(
            "submit_work",
            objectExpression([
              property("ref", literal("orbit-core:submit_work")),
              property("input", identifier("WorkSubmissionBase")),
              property("output", identifier("OrbitDispatchReceipt")),
            ])
          ),
        ])
      ),
    ]),
  ]);

  const reports = await runGeneratedRule("no-trait-tool-contract-overrides", traitDefinition);

  expect(reports).toHaveLength(3);
  expect(reports.map((report) => String(report.message))).toEqual([
    expect.stringContaining("root-level slots"),
    expect.stringContaining("input/output replacement"),
    expect.stringContaining("input/output replacement"),
  ]);
});

test("install requires --project when project scope is requested", async () => {
  const result = await runCli(
    ["install", ".", "--harness", "opencode", "--scope", "project"],
    {}
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Project-local scope requires --project <path>");
});

test("install compiles Antigravity rules into a generated plugin bundle", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "antigravity-rules-plugin");
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");
  const rulePath = join(pluginRoot, "rules", "global", "standards.md");

  await mkdir(join(pluginRoot, "rules", "global"), { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "antigravity-rules-plugin",
        version: "0.1.0",
        targets: { rules: ["antigravity-cli"] },
      },
      null,
      2,
    ),
  );
  await writeFile(rulePath, "Always prefer managed Antigravity plugin rules.\n");

  const result = await runCli(
    ["install", pluginRoot, "--harness", "antigravity-cli", "--dry-run"],
    { HOME: homeRoot, PRISM_HOME: prismHome },
  );

  const generatedPluginRoot = join(
    homeRoot,
    ".gemini",
    "antigravity-cli",
    "plugins",
    "prism-generated-antigravity-rules-plugin",
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Compile (antigravity-cli, global)");
  expect(result.stdout).toContain(join(generatedPluginRoot, "rules", "context.md"));
  expect(result.stdout).toContain(join(generatedPluginRoot, "plugin.json"));
  expect(result.stdout).not.toContain(
    join(homeRoot, ".gemini", "antigravity-cli", "rules", "standards.md"),
  );
});

test("install CLI stores managed backups under Prism home", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "managed-rules-plugin");
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");
  const rulePath = join(pluginRoot, "rules", "global", "standards.md");
  const opencodeRulesPath = join(homeRoot, ".config", "opencode", "AGENTS.md");

  await mkdir(join(pluginRoot, "rules", "global"), { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "managed-rules-plugin",
        version: "0.1.0",
        targets: { rules: ["opencode"] },
      },
      null,
      2,
    ),
  );
  await writeFile(rulePath, "First managed rule.\n");

  const env = { HOME: homeRoot, PRISM_HOME: prismHome };
  const first = await runCli(["install", pluginRoot, "--harness", "opencode"], env);
  expect(first.exitCode).toBe(0);

  await writeFile(rulePath, "Second managed rule.\n");
  const second = await runCli(["install", pluginRoot, "--harness", "opencode"], env);

  expect(second.exitCode).toBe(0);
  expect(second.stdout).toContain("Backups created");
  expect(second.stdout).toContain(join(prismHome, "backups", "opencode"));
  expect(second.stdout).not.toContain(".bak");
  expect(await pathExists(`${opencodeRulesPath}.bak`)).toBe(false);
  expect(await readFile(opencodeRulesPath, "utf8")).toContain("Second managed rule.");
});

test("install dry-run reports unmanaged target drift reasons", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "managed-command-plugin");
  const homeRoot = join(root, "home");
  const prismHome = join(root, "prism-home");
  const commandTarget = join(homeRoot, ".config", "opencode", "commands", "review.md");

  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await mkdir(join(homeRoot, ".config", "opencode", "commands"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        name: "managed-command-plugin",
        version: "0.1.0",
        targets: { commands: ["opencode"] },
      },
      null,
      2,
    ),
  );
  await writeFile(join(pluginRoot, "commands", "review.md"), "Managed review command.\n");
  await writeFile(commandTarget, "User-owned review command.\n");

  const result = await runCli(
    ["install", pluginRoot, "--harness", "opencode", "--dry-run"],
    { HOME: homeRoot, PRISM_HOME: prismHome },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("drift");
  expect(result.stdout).toContain("Target exists but is not owned by Prism");
});

test("install dry-run compiles targeted plugin with project scope", async () => {
  const { monorepoRoot, projectRoot, homeRoot } = await createInstallAllFixture();
  const pluginRoot = join(monorepoRoot, "trait-orbit-contracts");

  const result = await runCli(
    [
      "install",
      pluginRoot,
      "--harness",
      "opencode",
      "--scope",
      "project",
      "--project",
      projectRoot,
      "--dry-run",
    ],
    { HOME: homeRoot }
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Installing plugin: canonical-compile-fixture");
  expect(result.stdout).toContain("Matching requested harnesses: opencode");
  expect(result.stdout).toContain("Compile output scope: project");
  expect(result.stdout).toContain("Compile (opencode, project)");
  expect(result.stdout).toContain("Dry run - operations that would be performed");
  expect(
    await pathExists(join(projectRoot, ".opencode", "agents", "builder.md"))
  ).toBe(false);
});

test("install-all requires --project when project scope is requested", async () => {
  const { monorepoRoot, homeRoot } = await createInstallAllFixture();

  const result = await runCli(
    ["install-all", monorepoRoot, "--harness", "opencode", "--scope", "project"],
    { HOME: homeRoot }
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Project-local scope requires --project <path>");
});

test("install-all compiles discovered child plugins with project scope", async () => {
  const { monorepoRoot, projectRoot, homeRoot } = await createInstallAllFixture();

  const result = await runCli(
    [
      "install-all",
      monorepoRoot,
      "--harness",
      "opencode,claude-code",
      "--scope",
      "project",
      "--project",
      projectRoot,

    ],
    { HOME: homeRoot }
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    "Manifest targets: agents=[opencode, claude-code]; orbits=[opencode, claude-code]; tools=[opencode, claude-code]; toolspaces=[opencode, claude-code]; modelspaces=[opencode, claude-code]"
  );
  expect(result.stdout).toContain("Matching requested harnesses: opencode, claude-code");
  expect(result.stdout).toContain("Compile output scope: project");
  expect(result.stdout).toContain("Compile (opencode, project)");
  expect(result.stdout).toContain("Compile (claude-code, project)");
  expect(result.stdout).toContain("All plugin refreshes completed successfully");

  expect(
    await pathExists(join(projectRoot, ".opencode", "agents", "builder.md"))
  ).toBe(true);
  expect(
    await pathExists(join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"))
  ).toBe(true);
  expect(
    await pathExists(
      join(
        projectRoot,
        ".claude",
        "plugins",
        "prism-generated-canonical-compile-fixture",
        "agents",
        "builder.md",
      ),
    )
  ).toBe(true);
  expect(
    await pathExists(
      join(
        projectRoot,
        ".claude",
        "plugins",
        "prism-generated-canonical-compile-fixture",
        "skills",
        "delivery-contract",
        "SKILL.md",
      ),
    )
  ).toBe(true);
  expect(
    await pathExists(join(homeRoot, ".config", "opencode", "agents", "builder.md"))
  ).toBe(false);
  expect(
    await pathExists(
      join(homeRoot, ".claude", "plugins", "prism-generated-canonical-compile-fixture", "agents", "builder.md"),
    )
  ).toBe(false);
});

test("install-all skips skill validation when skills are not targeted", async () => {
  const { monorepoRoot, projectRoot, homeRoot } = await createInstallAllFixture();

  await mkdir(
    join(monorepoRoot, "trait-orbit-contracts", "skills", "leaf-agent-protocol"),
    { recursive: true }
  );

  const result = await runCli(
    [
      "install-all",
      monorepoRoot,
      "--harness",
      "opencode",
      "--scope",
      "project",
      "--project",
      projectRoot,

    ],
    { HOME: homeRoot }
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain("Validation failed");
  expect(result.stdout).toContain("All plugin refreshes completed successfully");
});
