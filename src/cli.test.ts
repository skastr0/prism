import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCanonicalCompileFixture } from "./compile/test-fixtures.js";
import { prismOxlintPluginJs } from "./init-templates.js";

const tempRoots: string[] = [];

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
        targets: { agents: ["opencode", "factory-droid"] },
      },
      null,
      2,
    ),
  );

  const result = await runCli(["validate", pluginRoot], {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("targets.agents resolves to unsupported compile harnesses");
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
