import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Option } from "effect";
import type { CompileError } from "./errors.js";
import { compilePluginForTarget } from "./pipeline.js";
import { createCanonicalCompileFixture } from "./test-fixtures.js";
import { readManifest } from "../manifest.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "agentpkg-compile-"));
  tempRoots.push(root);
  return root;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
};

const getFailure = (
  exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>,
): CompileError => {
  if (exit._tag !== "Failure") {
    throw new Error("Expected compile to fail");
  }

  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error("Expected typed compile error");
  }

  return failure.value as CompileError;
};

const createCanonicalLanguageFixture = async (options?: {
  invalidLifecycle?: boolean;
  invalidLifecycleGrantAgent?: boolean;
  invalidLifecycleGrantBinding?: boolean;
  withCanonicalToolBindings?: boolean;
}) => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  return createCanonicalCompileFixture({
    pluginRoot,
    projectRoot,
    invalidLifecycle: options?.invalidLifecycle,
    invalidLifecycleGrantAgent: options?.invalidLifecycleGrantAgent,
    invalidLifecycleGrantBinding: options?.invalidLifecycleGrantBinding,
    withCanonicalToolBindings: options?.withCanonicalToolBindings,
  });
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("readManifest accepts canonical compile target keys", async () => {
  const { pluginRoot } = await createCanonicalLanguageFixture();

  const manifest = await readManifest(pluginRoot);

  expect(manifest.name).toBe("canonical-compile-fixture");
  expect(manifest.targets).toEqual({
    agents: ["opencode", "claude-code"],
    lifecycles: ["opencode", "claude-code"],
    tools: ["opencode", "claude-code"],
    toolspaces: ["opencode", "claude-code"],
    modelspaces: ["opencode", "claude-code"],
  });
});

test("canonical TS-authored agents resolve shared toolspace and modelspace bindings", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const builder = result.composed.find((agent) => agent.name === "builder");
  const reviewer = result.composed.find((agent) => agent.name === "reviewer");
  const securityReviewer = result.composed.find(
    (agent) => agent.name === "security-reviewer",
  );

  expect(builder).toBeDefined();
  expect(reviewer).toBeDefined();
  expect(securityReviewer).toBeDefined();
  expect(builder?.skills).toEqual(["testing"]);
  expect(reviewer?.skills).toEqual(["testing"]);
  expect(securityReviewer?.skills).toEqual(["testing"]);
  expect(builder?.allowedTools).toEqual(["bash", "grep", "read"]);
  expect(reviewer?.allowedTools).toEqual(["grep", "read"]);
  expect(securityReviewer?.allowedTools).toEqual(["grep", "read"]);
  expect(builder?.toolBindings.map((binding) => binding.logicalName)).toEqual([
    "commit_work",
    "create_item",
    "submit_work",
  ]);
  expect(reviewer?.toolBindings.map((binding) => binding.logicalName)).toEqual([
    "submit_review",
    "submit_work",
  ]);
  expect(securityReviewer?.toolBindings.map((binding) => binding.logicalName)).toEqual([
    "submit_review",
    "submit_work",
  ]);
  expect(reviewer?.toolBindings[0]?.contract.name).not.toBe(
    securityReviewer?.toolBindings[0]?.contract.name,
  );
});

test("lifecycle phase validation succeeds when assigned agents satisfy requirements", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );
  expect(skill).toContain("### 1. Implement change — agent `builder`");
  expect(skill).toContain("### 3. Hand off work — agents `builder`, `reviewer`");
  expect(skill).not.toContain("reviewable");
  expect(skill).not.toContain("self-assessing");
  expect(
    await pathExists(
      join(projectRoot, ".opencode", "lifecycles", "delivery-contract.md"),
    ),
  ).toBe(false);
});

test("lifecycle validation fails when assigned agents do not satisfy requirements", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    invalidLifecycle: true,
  });

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("LifecycleValidationError");
  if (failure._tag === "LifecycleValidationError") {
    expect(failure.field).toBe("phases[1].requires[0]");
    expect(failure.message).toContain("reviewable");
    expect(failure.message).toContain("only 0 match");
  }
});

test("lifecycle tool grants fail when targeting an unassigned agent", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    invalidLifecycleGrantAgent: true,
  });

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("LifecycleValidationError");
  if (failure._tag === "LifecycleValidationError") {
    expect(failure.field).toBe("tool_grants[0].agents[0]");
    expect(failure.message).toContain("not assigned");
  }
});

test("lifecycle tool grants fail closed on non-serializable bound inputs", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    invalidLifecycleGrantBinding: true,
  });

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("LifecycleValidationError");
  if (failure._tag === "LifecycleValidationError") {
    expect(failure.field).toBe("tool_grants[0].tools[0]");
    expect(failure.message).toContain("must not contain undefined values");
  }
});

test("compilePluginForTarget lowers canonical agent sources for opencode and claude-code", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const opencode = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const claude = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "claude-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  expect(opencode.composed).toHaveLength(3);
  expect(claude.composed).toHaveLength(3);

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "builder.md"),
    "utf8",
  );
  expect(opencodeAgent).toContain("name: builder");
  expect(opencodeAgent).toContain(
    "description: Builder agent for canonical compile integration tests",
  );
  expect(opencodeAgent).toContain("read: true");
  expect(opencodeAgent).toContain("grep: true");
  expect(opencodeAgent).toContain("bash: true");
  expect(opencodeAgent).toContain("canonical_compile_fixture_builder_create_item: true");
  expect(opencodeAgent).toContain("canonical_compile_fixture_builder_submit_work: true");
  expect(opencodeAgent).toContain("canonical_compile_fixture_reviewer_submit_review: false");
  expect(opencodeAgent).toContain(
    "canonical_compile_fixture_security_reviewer_submit_review: false",
  );
  const submittableInstructionIndex = opencodeAgent.indexOf(
    "Submit completed work through the typed submission surface before handing off.",
  );
  const committableInstructionIndex = opencodeAgent.indexOf(
    "Commit owned implementation changes only after the submitted work is complete.",
  );
  const selfAssessingInstructionIndex = opencodeAgent.indexOf(
    "Run the relevant validation before final response or handoff.",
  );
  expect(submittableInstructionIndex).toBeGreaterThan(-1);
  expect(committableInstructionIndex).toBeGreaterThan(submittableInstructionIndex);
  expect(selfAssessingInstructionIndex).toBeGreaterThan(committableInstructionIndex);

  const reviewerAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "reviewer.md"),
    "utf8",
  );
  expect(reviewerAgent).toContain("canonical_compile_fixture_builder_submit_work: false");
  expect(reviewerAgent).toContain("canonical_compile_fixture_builder_create_item: false");
  expect(reviewerAgent).toContain("canonical_compile_fixture_reviewer_submit_review: true");

  const generatedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "agentpkg-generated-canonical-compile-fixture",
  );
  const adapterDir = join(generatedRoot, "src", "adapters", "canonical-compile-fixture");
  const adapterFiles = await readdir(adapterDir);
  expect(adapterFiles.length).toBeGreaterThan(0);

  const adapter = await readFile(join(adapterDir, adapterFiles[0]!), "utf8");
  expect(adapter).toContain("await contract.handle(input, runtimeContext)");
  expect(adapter).not.toContain("canonical.handle");
  expect(
    await pathExists(
      join(
        generatedRoot,
        "src",
        "plugins",
        "protocol-core",
        "tools",
        "create_item.tool.ts",
      ),
    ),
  ).toBe(true);
  expect(
    await pathExists(
      join(
        generatedRoot,
        "src",
        "plugins",
        "protocol-core",
        "tools",
        "external-submit.tool.ts",
      ),
    ),
  ).toBe(true);

  const grantContractFiles = await readdir(
    join(generatedRoot, "src", "plugins", "canonical-compile-fixture", "contracts"),
  );
  const grantContractName = grantContractFiles.find((file) =>
    file.includes("delivery-contract__builder__create_item"),
  );
  expect(grantContractName).toBeDefined();
  const grantContract = await readFile(
    join(
      generatedRoot,
      "src",
      "plugins",
      "canonical-compile-fixture",
      "contracts",
      grantContractName!,
    ),
    "utf8",
  );
  expect(grantContract).toContain('Schema.omit("board")');
  expect(grantContract).toContain('"board":"project-alpha"');

  const opencodePluginStub = join(
    generatedRoot,
    "node_modules",
    "@opencode-ai",
    "plugin",
  );
  await mkdir(opencodePluginStub, { recursive: true });
  await writeFile(
    join(opencodePluginStub, "package.json"),
    JSON.stringify({ type: "module", main: "./index.js" }),
  );
  await writeFile(
    join(opencodePluginStub, "index.js"),
    `const node = () => ({ describe: () => node(), optional: () => node() });
const schema = {
  string: node,
  number: node,
  boolean: node,
  literal: node,
  enum: node,
  array: node,
  object: node,
};
export const tool = Object.assign((definition) => definition, { schema });
`,
  );
  const effectStub = join(generatedRoot, "node_modules", "effect");
  await mkdir(effectStub, { recursive: true });
  await writeFile(
    join(effectStub, "package.json"),
    JSON.stringify({ type: "module", main: "./index.js" }),
  );
  await writeFile(
    join(effectStub, "index.js"),
    `export * from ${JSON.stringify(import.meta.resolve("effect"))};\n`,
  );

  const generatedServer = await import(
    pathToFileURL(join(generatedRoot, "src", "server.ts")).href
  );
  expect(generatedServer.default.id).toBe("agentpkg-generated-canonical-compile-fixture");

  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as {
    agent: Record<string, Record<string, unknown>>;
  };
  expect(opencodeConfig.agent.builder?.model).toBe("openai/gpt-5.4");
  expect(opencodeConfig.agent.builder?.variant).toBe("xhigh");
  expect(opencodeConfig.agent.builder?.temperature).toBe(0.2);
  expect(opencodeConfig.agent.builder?.mode).toBe("subagent");
  expect(opencodeConfig.agent.builder?.maxSteps).toBe(12);
  expect(
    await pathExists(
      join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    ),
  ).toBe(true);

  const claudeAgent = await readFile(
    join(projectRoot, ".claude", "agents", "builder.md"),
    "utf8",
  );
  expect(claudeAgent).toContain(
    'description: "Builder agent for canonical compile integration tests"',
  );
  expect(claudeAgent).toContain('model: "sonnet"');
  expect(claudeAgent).toContain("temperature: 0.1");
  expect(claudeAgent).toContain("top_p: 0.7");
  expect(claudeAgent).toContain("allowed-tools:");
  expect(claudeAgent).toContain('- "Read"');
  expect(claudeAgent).toContain('- "Grep"');
  expect(claudeAgent).toContain('- "Bash"');
  expect(claudeAgent).toContain("## Trait Instructions");
  expect(claudeAgent).toContain(
    "Commit owned implementation changes only after the submitted work is complete.",
  );
  expect(
    await pathExists(
      join(projectRoot, ".claude", "skills", "delivery-contract", "SKILL.md"),
    ),
  ).toBe(true);
  expect(
    await pathExists(
      join(projectRoot, ".claude", "lifecycles", "delivery-contract.md"),
    ),
  ).toBe(false);
  expect(await pathExists(join(projectRoot, ".claude", "settings.json"))).toBe(false);
});
