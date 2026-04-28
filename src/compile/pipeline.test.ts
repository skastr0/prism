import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Option } from "effect";
import matter from "gray-matter";
import type { CompileError } from "./errors.js";
import { readLockfile } from "./lockfile.js";
import { compilePluginForTarget } from "./pipeline.js";
import { createCanonicalCompileFixture } from "./test-fixtures.js";
import {
  formatManifestTargets,
  manifestHasCompileTargets,
  readManifest,
} from "../manifest.js";

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

const generatedPluginEntry = (projectRoot: string, pluginId: string): string =>
  pathToFileURL(
    join(projectRoot, ".opencode", "plugins", pluginId, "src", "server.ts"),
  ).href;

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
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
  invalidLifecyclePermissionAgent?: boolean;
  inlineSlotSchema?: boolean;
  undeclaredSlot?: boolean;
  mixedTraitRefsBeforeSlotBinding?: boolean;
  withCanonicalToolBindings?: boolean;
}) => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  return createCanonicalCompileFixture({
    pluginRoot,
    projectRoot,
    invalidLifecycle: options?.invalidLifecycle,
    invalidLifecyclePermissionAgent: options?.invalidLifecyclePermissionAgent,
    inlineSlotSchema: options?.inlineSlotSchema,
    undeclaredSlot: options?.undeclaredSlot,
    mixedTraitRefsBeforeSlotBinding: options?.mixedTraitRefsBeforeSlotBinding,
    withCanonicalToolBindings: options?.withCanonicalToolBindings,
  });
};

const createExternalPermissionOnlyFixture = async (): Promise<{
  pluginRoot: string;
  protocolRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "consumer");
  const projectRoot = join(root, "project");
  const protocolRoot = join(pluginRoot, "deps", "protocol-core");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "permission-only-consumer",
        version: "0.1.0",
        deps: {
          "protocol-core": "./deps/protocol-core",
        },
        targets: {
          agents: ["opencode"],
          skills: ["opencode"],
          skillspaces: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(protocolRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "protocol-core",
        version: "0.1.0",
        targets: {
          tools: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker

Use the protocol tool.
`,
  );
  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `import { defineTrait } from "agentpkg";

export default defineTrait({
  name: "submittable",
  description: "Can submit externally",
  tools: {
    submit_work: {
      ref: "protocol-core:external-submit",
    },
  },
  require: {
    tools: ["submit_work"],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Permission-only consumer worker",
  identity: "worker",
  traits: ["submittable"],
});
`,
  );
  await writeText(
    join(protocolRoot, "schemas", "shared.ts"),
    `import { Schema } from "effect";

export const SharedInput = Schema.Struct({
  summary: Schema.String,
});
`,
  );
  await writeText(
    join(protocolRoot, "tools", "external-submit.tool.ts"),
    `import { Schema } from "effect";
import { defineTool } from "agentpkg";
import { SharedInput } from "../schemas/shared.ts";

export default defineTool({
  name: "external-submit",
  description: "Submit completed work through an external protocol plugin",
  input: SharedInput,
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  async handle(input, context) {
    return { acknowledged: true };
  },
});
`,
  );
  await writeText(
    join(protocolRoot, "tools", "unreferenced.tool.ts"),
    `import { Schema } from "effect";
import { defineTool } from "agentpkg";

export default defineTool({
  name: "unreferenced",
  description: "Should not be mirrored",
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  async handle(input, context) {
    return {};
  },
});
`,
  );
  await writeText(
    join(projectRoot, ".opencode", "opencode.json"),
    `${JSON.stringify(
      {
        plugin: [
          "agentpkg-generated-permission-only-consumer",
          "agentpkg-generated-stale-dep",
          generatedPluginEntry(
            projectRoot,
            "agentpkg-generated-permission-only-consumer",
          ),
          generatedPluginEntry(projectRoot, "agentpkg-generated-stale-dep"),
        ],
      },
      null,
      2,
    )}\n`,
  );

  return { pluginRoot, protocolRoot, projectRoot };
};

const createExternalSyntheticOnlyFixture = async (): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "consumer");
  const projectRoot = join(root, "project");
  const protocolRoot = join(pluginRoot, "deps", "protocol-core");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "external-synthetic-consumer",
        version: "0.1.0",
        deps: {
          "protocol-core": "./deps/protocol-core",
        },
        targets: {
          agents: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(protocolRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "protocol-core",
        version: "0.1.0",
        targets: {
          tools: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker

Use the typed protocol wrapper.
`,
  );
  await writeText(
    join(pluginRoot, "schemas", "worker-details.ts"),
    `import { Schema } from "effect";

export const WorkerDetails = Schema.Struct({
  confidence: Schema.Literal("low", "high"),
});
`,
  );
  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `import { defineTrait } from "agentpkg";

export default defineTrait({
  name: "submittable",
  description: "Can submit externally through a typed wrapper",
  tools: {
    submit_work: {
      ref: "protocol-core:external-submit",
    },
  },
  require: {
    tools: ["submit_work"],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { bindTrait, defineAgent } from "agentpkg";
import { WorkerDetails } from "../schemas/worker-details.ts";

export default defineAgent({
  name: "worker",
  description: "Synthetic external worker",
  identity: "worker",
  traits: [
    bindTrait("submittable", {
      tools: {
        submit_work: {
          slots: {
            details: WorkerDetails,
          },
        },
      },
    }),
  ],
});
`,
  );
  await writeText(
    join(protocolRoot, "schemas", "shared.ts"),
    `import { Schema } from "effect";

export const SharedInput = Schema.Struct({
  summary: Schema.String,
});
`,
  );
  await writeText(
    join(protocolRoot, "tools", "external-submit.tool.ts"),
    `import { Schema } from "effect";
import { defineTool, schemaSlot } from "agentpkg";
import { SharedInput } from "../schemas/shared.ts";

export default defineTool({
  name: "external-submit",
  description: "Submit completed work through an external protocol plugin",
  input: SharedInput,
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  slots: {
    details: schemaSlot({
      description: "Consumer-specific details",
    }),
  },
  async handle(input, context) {
    return { acknowledged: true };
  },
});
`,
  );

  return { pluginRoot, projectRoot };
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

test("readManifest treats skillspaces as compile artifacts", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "skillspace-manifest-demo",
        version: "0.1.0",
        targets: {
          skillspaces: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "core.skillspace.ts"),
    `import { defineSkillspace } from "agentpkg";

export default defineSkillspace({
  name: "core",
  skills: {
    testing: {
      targets: {
        opencode: { name: "testing" },
      },
    },
  },
});
`,
  );

  const manifest = await readManifest(pluginRoot);

  expect(manifest.targets.skillspaces).toEqual(["opencode"]);
  expect(manifestHasCompileTargets(manifest, "opencode")).toBe(true);
  expect(formatManifestTargets(manifest)).toBe("skillspaces=[opencode]");
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
  expect(builder?.toolBindings.find((binding) => binding.logicalName === "submit_work")?.kind).toBe(
    "permission",
  );
  expect(
    reviewer?.toolBindings.find((binding) => binding.logicalName === "submit_work")?.kind,
  ).toBe("permission");
  expect(
    securityReviewer?.toolBindings.find((binding) => binding.logicalName === "submit_work")
      ?.kind,
  ).toBe("permission");
  expect(builder?.toolBindings.find((binding) => binding.logicalName === "commit_work")?.kind).toBe(
    "permission",
  );
  expect(builder?.toolBindings.find((binding) => binding.logicalName === "create_item")?.kind).toBe(
    "permission",
  );
  const reviewerSubmitReview = reviewer?.toolBindings.find(
    (binding) => binding.logicalName === "submit_review",
  );
  const securitySubmitReview = securityReviewer?.toolBindings.find(
    (binding) => binding.logicalName === "submit_review",
  );
  expect(reviewerSubmitReview?.kind).toBe("synthetic");
  if (!reviewerSubmitReview?.contract || !securitySubmitReview?.contract) {
    throw new Error("expected review slot fills to synthesize tool contracts");
  }
  expect(reviewerSubmitReview.contract.name).not.toBe(
    securitySubmitReview.contract.name,
  );
  expect(
    builder?.toolBindings.find((binding) => binding.logicalName === "submit_work")?.contract,
  ).toBeUndefined();
  expect(
    reviewer?.toolBindings.find((binding) => binding.logicalName === "submit_work")?.contract,
  ).toBeUndefined();
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

test("lifecycle tool permissions fail when targeting an unassigned agent", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    invalidLifecyclePermissionAgent: true,
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
    expect(failure.field).toBe("tool_permissions[0].agents[0]");
    expect(failure.message).toContain("not assigned");
  }
});

test("slot-filled trait tools fail closed on inline schemas", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    inlineSlotSchema: true,
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
  expect(failure._tag).toBe("SourceParseError");
  expect(failure.message).toContain("must be an imported schema identifier");
});

test("slot-filled trait tools fail closed on undeclared slots", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    undeclaredSlot: true,
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
  expect(failure._tag).toBe("AgentValidationError");
  expect(failure.message).toContain("fills undeclared tool slot(s): unknown_verdict");
});

test("slot source capture tolerates trait refs before slot-filled bindings", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    mixedTraitRefsBeforeSlotBinding: true,
  });

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

  const generatedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "agentpkg-generated-canonical-compile-fixture",
  );
  const contractFiles = await readdir(
    join(generatedRoot, "src", "plugins", "canonical-compile-fixture", "contracts"),
  );
  const reviewContractName = contractFiles.find((file) =>
    file.includes("submit_review__review_findings_slot"),
  );
  expect(reviewContractName).toBeDefined();
  const reviewContract = await readFile(
    join(
      generatedRoot,
      "src",
      "plugins",
      "canonical-compile-fixture",
      "contracts",
      reviewContractName!,
    ),
    "utf8",
  );
  expect(reviewContract).toContain("../schemas/review-slots");
});

test("compilePluginForTarget lowers executable canonical tools for opencode", async () => {
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

  expect(opencode.composed).toHaveLength(3);

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "builder.md"),
    "utf8",
  );
  expect(opencodeAgent).toContain("name: builder");
  expect(opencodeAgent).toContain(
    "description: Builder agent for canonical compile integration tests",
  );
  expect(opencodeAgent).toContain("permission:");
  expect(opencodeAgent).not.toContain("tools:");
  expect(opencodeAgent).toContain("read: allow");
  expect(opencodeAgent).toContain("grep: allow");
  expect(opencodeAgent).toContain("bash: allow");
  expect(opencodeAgent).toContain("canonical_compile_fixture_commit_work: allow");
  expect(opencodeAgent).toContain("protocol_core_external_submit: allow");
  expect(opencodeAgent).toContain("protocol_core_create_item: allow");
  expect(opencodeAgent).not.toContain("canonical_compile_fixture_builder_submit_work");
  expect(opencodeAgent).not.toContain("canonical_compile_fixture_delivery_contract__builder__create_item");
  expect(opencodeAgent).toContain(
    "canonical_compile_fixture_submit_review__review_findings_slot: deny",
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
  expect(reviewerAgent).toContain("protocol_core_external_submit: allow");
  expect(reviewerAgent).not.toContain("canonical_compile_fixture_builder_submit_work");
  expect(reviewerAgent).toContain("protocol_core_create_item: deny");
  expect(reviewerAgent).not.toContain("canonical_compile_fixture_delivery_contract__builder__create_item");
  expect(reviewerAgent).toMatch(
    /canonical_compile_fixture_submit_review__review_findings_slot: allow/,
  );

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
  expect(adapter).toContain("await (surface as any).handle(input, runtimeContext)");
  expect(adapter).not.toContain("canonical.handle");
  const protocolGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "agentpkg-generated-protocol-core",
  );
  expect(
    await pathExists(
      join(
        protocolGeneratedRoot,
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
        protocolGeneratedRoot,
        "src",
        "plugins",
        "protocol-core",
        "tools",
        "external-submit.tool.ts",
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
  ).toBe(false);
  const mirroredSubmitReviewTool = await readFile(
    join(
      generatedRoot,
      "src",
      "plugins",
      "canonical-compile-fixture",
      "tools",
      "submit-review.tool.ts",
    ),
    "utf8",
  );
  expect(mirroredSubmitReviewTool).not.toContain('from "agentpkg"');
  expect(mirroredSubmitReviewTool).not.toContain("src/index.ts");
  expect(mirroredSubmitReviewTool).not.toContain("schemaSlot");
  expect(mirroredSubmitReviewTool).not.toContain("defineTool");

  const contractFiles = await readdir(
    join(generatedRoot, "src", "plugins", "canonical-compile-fixture", "contracts"),
  );
  expect(
    contractFiles.some((file) =>
      file.includes("delivery-contract__builder__create_item"),
    ),
  ).toBe(false);
  const reviewContractName = contractFiles.find((file) =>
    file.includes("submit_review__review_findings_slot"),
  );
  expect(reviewContractName).toBeDefined();
  const reviewContract = await readFile(
    join(
      generatedRoot,
      "src",
      "plugins",
      "canonical-compile-fixture",
      "contracts",
      reviewContractName!,
    ),
    "utf8",
  );
  expect(reviewContract).toContain("../schemas/review-slots");
  expect(reviewContract).not.toContain("Schema.omit");

  const mirroredReviewSlots = await readFile(
    join(
      generatedRoot,
      "src",
      "plugins",
      "canonical-compile-fixture",
      "schemas",
      "review-slots.ts",
    ),
    "utf8",
  );
  expect(mirroredReviewSlots).toContain(
    "agentpkg-generated-protocol-core/src/plugins/protocol-core/schemas/review-evidence",
  );

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
  const generatedServerSource = await readFile(join(generatedRoot, "src", "server.ts"), "utf8");
  expect(generatedServerSource).not.toContain('"protocol_core_external_submit":');
  expect(generatedServerSource).not.toContain("canonical_compile_fixture_builder_submit_work");
  const protocolGeneratedServerSource = await readFile(
    join(protocolGeneratedRoot, "src", "server.ts"),
    "utf8",
  );
  expect(protocolGeneratedServerSource).toContain('"protocol_core_external_submit":');
  expect(protocolGeneratedServerSource).toContain('"protocol_core_create_item":');
  expect(
    (protocolGeneratedServerSource.match(/"protocol_core_external_submit":/g) ?? []).length,
  ).toBe(1);
  expect((protocolGeneratedServerSource.match(/"protocol_core_create_item":/g) ?? []).length).toBe(
    1,
  );

  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as {
    agent: Record<string, Record<string, unknown>>;
    plugin: string[];
    permission: Record<string, string>;
  };
  expect(opencodeConfig.permission).toMatchObject({
    "canonical_compile_fixture_*": "deny",
    "protocol_core_*": "deny",
  });
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(
      projectRoot,
      "agentpkg-generated-canonical-compile-fixture",
    ),
  );
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(projectRoot, "agentpkg-generated-protocol-core"),
  );
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
  expect(
    await pathExists(
      join(projectRoot, ".opencode", "lifecycles", "delivery-contract.md"),
    ),
  ).toBe(false);
});

test("opencode trait skill access lowers to permission without becoming a dependency", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "skill-access-demo",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          skills: ["opencode"],
          skillspaces: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker

Use only the skills that fit the work.
`,
  );
  await writeText(
    join(pluginRoot, "traits", "marketing-enabled.trait.ts"),
    `import { defineTrait, skillspaceRef } from "agentpkg";

export default defineTrait({
  name: "marketing-enabled",
  description: "Can use marketing skills",
  access: {
    skills: [
      skillspaceRef("external-skills", "copy-engineering"),
      skillspaceRef("external-skills", "marketing"),
    ],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "agentpkg";

export default defineSkillspace({
  name: "external-skills",
  description: "Harness-native skills this plugin does not own",
  skills: {
    "copy-engineering": {
      targets: {
        opencode: { name: "copy-engineering-opencode" },
      },
    },
    marketing: {
      targets: {
        opencode: { name: "marketing-opencode" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skills", "contracts", "SKILL.md"),
    `---
name: contracts
description: Contract guidance
---

# Contracts

Lock down interfaces before implementation.
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent, skillRef } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker with skill permissions",
  identity: "worker",
  traits: ["marketing-enabled"],
  skills: [skillRef("contracts")],
});
`,
  );

  const firstCompile = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  expect(firstCompile.built).toEqual(["worker"]);
  expect(firstCompile.fromCache).toEqual([]);

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "worker.md"),
    "utf8",
  );
  const frontmatter = matter(opencodeAgent).data as {
    permission?: { skill?: Record<string, string> };
  };

  expect(opencodeAgent).toContain("## Recommended Skills");
  expect(opencodeAgent).toContain("- `contracts`");
  expect(opencodeAgent).not.toContain("- `copy-engineering-opencode`");
  expect(opencodeAgent).not.toContain("- `marketing-opencode`");
  expect(frontmatter.permission?.skill).toEqual({
    "*": "deny",
    "contracts": "allow",
    "copy-engineering-opencode": "allow",
    "marketing-opencode": "allow",
  });

  const lockfile = await readLockfile(pluginRoot);
  expect(lockfile?.entries[0]?.sources.map((source) => source.path).sort()).toContain(
    "skills/contracts/SKILL.md",
  );
  expect(lockfile?.entries[0]?.sources.map((source) => source.path).sort()).toContain(
    "skillspaces/external-skills.skillspace.ts",
  );

  const warmCompile = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );
  expect(warmCompile.built).toEqual([]);
  expect(warmCompile.fromCache).toEqual(["worker"]);

  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "agentpkg";

export default defineSkillspace({
  name: "external-skills",
  description: "Harness-native skills this plugin does not own",
  skills: {
    "copy-engineering": {
      targets: {
        opencode: { name: "copywriting-opencode" },
      },
    },
    marketing: {
      targets: {
        opencode: { name: "marketing-opencode" },
      },
    },
  },
});
`,
  );

  const skillspaceChangedCompile = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );
  expect(skillspaceChangedCompile.built).toEqual(["worker"]);
  expect(skillspaceChangedCompile.fromCache).toEqual([]);
});

test("trait skill requirements compare resolved concrete skills", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "skill-requirement-demo",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          skills: ["opencode"],
          skillspaces: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(
    join(pluginRoot, "traits", "needs-testing.trait.ts"),
    `import { defineTrait, skillspaceRef } from "agentpkg";

export default defineTrait({
  name: "needs-testing",
  description: "Requires testing skill permission",
  require: {
    skills: [skillspaceRef("core-skills", "testing")],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "core-skills.skillspace.ts"),
    `import { defineSkillspace } from "agentpkg";

export default defineSkillspace({
  name: "core-skills",
  skills: {
    testing: {
      targets: {
        opencode: { name: "testing" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    `---
name: testing
description: Testing guidance
---

# Testing
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent, skillRef } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker with concrete skill dependency",
  identity: "worker",
  traits: ["needs-testing"],
  skills: [skillRef("testing")],
});
`,
  );

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

  expect(result.composed[0]?.skills).toEqual(["testing"]);
  expect(result.composed[0]?.allowedSkills).toEqual(["testing"]);
});

test("plain skill strings fail closed in agent and trait source fields", async () => {
  const cases: ReadonlyArray<{
    label: string;
    expectedKind: "agent" | "trait";
    agentSource?: string;
    traitSource?: string;
  }> = [
    {
      label: "agent.skills",
      expectedKind: "agent",
      agentSource: `import { defineAgent } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  skills: ["testing"],
});
`,
    },
    {
      label: "agent.access.skills",
      expectedKind: "agent",
      agentSource: `import { defineAgent } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  access: {
    skills: ["testing"],
  },
});
`,
    },
    {
      label: "trait.access.skills",
      expectedKind: "trait",
      traitSource: `import { defineTrait } from "agentpkg";

export default defineTrait({
  name: "skillful",
  description: "Skill access",
  access: {
    skills: ["testing"],
  },
});
`,
    },
    {
      label: "trait.inject.skills",
      expectedKind: "trait",
      traitSource: `import { defineTrait } from "agentpkg";

export default defineTrait({
  name: "skillful",
  description: "Skill injection",
  inject: {
    skills: ["testing"],
  },
});
`,
    },
    {
      label: "trait.require.skills",
      expectedKind: "trait",
      traitSource: `import { defineTrait } from "agentpkg";

export default defineTrait({
  name: "skillful",
  description: "Skill requirement",
  require: {
    skills: ["testing"],
  },
});
`,
    },
  ];

  for (const item of cases) {
    const root = await createTempRoot();
    const pluginRoot = join(root, item.label.replaceAll(".", "-"));
    const projectRoot = join(root, "project");
    await mkdir(projectRoot, { recursive: true });

    await writeText(
      join(pluginRoot, "plugin.json"),
      `${JSON.stringify(
        {
          name: `plain-${item.label.replaceAll(".", "-")}`,
          version: "0.1.0",
          targets: {
            agents: ["opencode"],
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeText(
      join(pluginRoot, "identities", "worker.identity.md"),
      `---
description: Worker identity
---

# Worker
`,
    );
    if (item.traitSource) {
      await writeText(join(pluginRoot, "traits", "skillful.trait.ts"), item.traitSource);
    }
    await writeText(
      join(pluginRoot, "agents", "worker.agent.ts"),
      item.agentSource ??
        `import { defineAgent } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["skillful"],
});
`,
    );

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
    expect(failure._tag).toBe("SourceParseError");
    if (failure._tag === "SourceParseError") {
      expect(failure.kind).toBe(item.expectedKind);
      expect(failure.message).toContain("plain skill strings are not allowed");
    }
  }
});

test("managed skill refs require the source plugin to target the compile harness", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "managed-skill-target-demo",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          skills: ["claude-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(
    join(pluginRoot, "skills", "contracts", "SKILL.md"),
    `---
name: contracts
description: Contract guidance
---

# Contracts
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent, skillRef } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  skills: [skillRef("contracts")],
});
`,
  );

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
  expect(failure._tag).toBe("MissingTargetResolutionError");
  if (failure._tag === "MissingTargetResolutionError") {
    expect(failure.referenceKind).toBe("skill");
    expect(failure.referenceName).toBe("contracts");
    expect(failure.target).toBe("opencode");
  }
});

test("opencode skillspace target names must be valid permission keys", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "invalid-opencode-skill-demo",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          skillspaces: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(
    join(pluginRoot, "traits", "external.trait.ts"),
    `import { defineTrait, skillspaceRef } from "agentpkg";

export default defineTrait({
  name: "external",
  description: "Uses an external skill",
  access: {
    skills: [skillspaceRef("external-skills", "copy-engineering")],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "agentpkg";

export default defineSkillspace({
  name: "external-skills",
  skills: {
    "copy-engineering": {
      targets: {
        opencode: { name: "Copy_Engineering" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["external"],
});
`,
  );

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
  expect(failure._tag).toBe("AgentValidationError");
  if (failure._tag === "AgentValidationError") {
    expect(failure.field).toBe("skill");
    expect(failure.message).toContain("invalid OpenCode skill name");
  }
});

test("permission-only skill access fails on targets without skill permission support", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "unsupported-skill-permission-demo",
        version: "0.1.0",
        targets: {
          agents: ["claude-code"],
          skillspaces: ["claude-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(
    join(pluginRoot, "traits", "external.trait.ts"),
    `import { defineTrait, skillspaceRef } from "agentpkg";

export default defineTrait({
  name: "external",
  description: "Uses an external skill",
  access: {
    skills: [skillspaceRef("external-skills", "testing")],
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "agentpkg";

export default defineSkillspace({
  name: "external-skills",
  skills: {
    testing: {
      targets: {
        "claude-code": { name: "testing" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["external"],
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "claude-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("UnsupportedTargetCapabilityError");
  if (failure._tag === "UnsupportedTargetCapabilityError") {
    expect(failure.capability).toBe("skill-permissions");
    expect(failure.message).toContain("worker (testing)");
  }
});

test("trait-lifecycle example lowers lifecycle skill traits into opencode permissions", async () => {
  const projectRoot = await createTempRoot();
  const pluginRoot = join(process.cwd(), "examples", "trait-lifecycle-contracts");

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
      backup: false,
    }),
  );

  const builder = result.composed.find((agent) => agent.name === "builder");
  expect(builder?.skills).toEqual([]);
  expect(builder?.allowedSkills).toEqual([
    "backpressure",
    "build",
    "commit",
    "evolve",
    "requirements",
    "review",
    "sdlc",
    "testing",
  ]);

  const builderMarkdown = result.operations.find(
    (operation) =>
      operation.kind === "write-md" && operation.target.endsWith("agents/builder.md"),
  );
  if (!builderMarkdown || builderMarkdown.kind !== "write-md") {
    throw new Error("expected builder markdown operation");
  }
  const frontmatter = matter(builderMarkdown.content).data as {
    permission?: { skill?: Record<string, string> };
  };

  expect(builderMarkdown.content).not.toContain("## Recommended Skills");
  expect(frontmatter.permission?.skill).toEqual({
    "*": "deny",
    backpressure: "allow",
    build: "allow",
    commit: "allow",
    evolve: "allow",
    requirements: "allow",
    review: "allow",
    sdlc: "allow",
    testing: "allow",
  });
});

test("external permission-only consumers do not emit empty generated plugin shells", async () => {
  const { pluginRoot, projectRoot } = await createExternalPermissionOnlyFixture();

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

  const consumerGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "agentpkg-generated-permission-only-consumer",
  );
  const protocolGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "agentpkg-generated-protocol-core",
  );

  expect(await pathExists(join(consumerGeneratedRoot, "package.json"))).toBe(false);
  expect(await pathExists(join(protocolGeneratedRoot, "package.json"))).toBe(true);
  expect(
    await pathExists(
      join(
        protocolGeneratedRoot,
        "src",
        "plugins",
        "protocol-core",
        "tools",
        "external-submit.tool.ts",
      ),
    ),
  ).toBe(true);
  expect(
    await pathExists(
      join(
        protocolGeneratedRoot,
        "src",
        "plugins",
        "protocol-core",
        "schemas",
        "shared.ts",
      ),
    ),
  ).toBe(true);
  expect(
    await pathExists(
      join(
        protocolGeneratedRoot,
        "src",
        "plugins",
        "protocol-core",
        "tools",
        "unreferenced.tool.ts",
      ),
    ),
  ).toBe(true);

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "worker.md"),
    "utf8",
  );
  expect(opencodeAgent).toContain("permission:");
  expect(opencodeAgent).toContain("  skill:");
  expect(opencodeAgent).toContain('    "*": deny');
  expect(opencodeAgent).toContain("protocol_core_external_submit: allow");
  expect(opencodeAgent).toContain("protocol_core_unreferenced: deny");

  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as { permission?: Record<string, string>; plugin?: string[] };
  expect(opencodeConfig.permission).toMatchObject({
    "protocol_core_*": "deny",
  });
  expect(opencodeConfig.permission).not.toHaveProperty("permission_only_consumer_*");
  expect(opencodeConfig.plugin).toEqual([
    "agentpkg-generated-stale-dep",
    generatedPluginEntry(projectRoot, "agentpkg-generated-stale-dep"),
    generatedPluginEntry(projectRoot, "agentpkg-generated-protocol-core"),
  ]);
  expect(opencodeConfig.plugin).not.toContain(
    "agentpkg-generated-permission-only-consumer",
  );
  expect(opencodeConfig.plugin).not.toContain(
    generatedPluginEntry(
      projectRoot,
      "agentpkg-generated-permission-only-consumer",
    ),
  );
});

test("tools-only plugins emit the complete owner runtime plugin", async () => {
  const { protocolRoot, projectRoot } = await createExternalPermissionOnlyFixture();

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: protocolRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const protocolGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "agentpkg-generated-protocol-core",
  );

  expect(
    await pathExists(
      join(
        protocolGeneratedRoot,
        "src",
        "plugins",
        "protocol-core",
        "tools",
        "external-submit.tool.ts",
      ),
    ),
  ).toBe(true);
  expect(
    await pathExists(
      join(
        protocolGeneratedRoot,
        "src",
        "plugins",
        "protocol-core",
        "tools",
        "unreferenced.tool.ts",
      ),
    ),
  ).toBe(true);

  const server = await readFile(
    join(protocolGeneratedRoot, "src", "server.ts"),
    "utf8",
  );
  expect(server).toContain("protocol_core_external_submit");
  expect(server).toContain("protocol_core_unreferenced");

  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as { permission?: Record<string, string>; plugin?: string[] };
  expect(opencodeConfig.permission).toMatchObject({
    "protocol_core_*": "deny",
  });
  expect(opencodeConfig.plugin).toContain(
    generatedPluginEntry(projectRoot, "agentpkg-generated-protocol-core"),
  );
  expect(opencodeConfig.plugin).not.toContain("agentpkg-generated-protocol-core");
});

test("external synthetic wrappers keep the owner runtime dependency without exposing the base tool", async () => {
  const { pluginRoot, projectRoot } = await createExternalSyntheticOnlyFixture();

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

  const consumerGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "agentpkg-generated-external-synthetic-consumer",
  );
  const protocolGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "agentpkg-generated-protocol-core",
  );

  expect(await pathExists(join(consumerGeneratedRoot, "package.json"))).toBe(true);
  expect(await pathExists(join(protocolGeneratedRoot, "package.json"))).toBe(true);
  expect(
    await pathExists(
      join(
        protocolGeneratedRoot,
        "src",
        "plugins",
        "protocol-core",
        "tools",
        "external-submit.tool.ts",
      ),
    ),
  ).toBe(true);
  expect(
    await pathExists(
      join(
        consumerGeneratedRoot,
        "src",
        "plugins",
        "external-synthetic-consumer",
        "tools",
        "external-submit.tool.ts",
      ),
    ),
  ).toBe(false);

  const consumerServer = await readFile(join(consumerGeneratedRoot, "src", "server.ts"), "utf8");
  expect(consumerServer).toContain(
    "external_synthetic_consumer_submit_work__worker_details",
  );
  const protocolServer = await readFile(join(protocolGeneratedRoot, "src", "server.ts"), "utf8");
  expect(protocolServer).toContain("protocol_core_external_submit");

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "worker.md"),
    "utf8",
  );
  expect(opencodeAgent).toContain(
    "external_synthetic_consumer_submit_work__worker_details: allow",
  );
  expect(opencodeAgent).toContain("protocol_core_external_submit: deny");

  const contractFiles = await readdir(
    join(
      consumerGeneratedRoot,
      "src",
      "plugins",
      "external-synthetic-consumer",
      "contracts",
    ),
  );
  const contractName = contractFiles.find((file) =>
    file.includes("submit_work__worker_details"),
  );
  expect(contractName).toBeDefined();
  const contract = await readFile(
    join(
      consumerGeneratedRoot,
      "src",
      "plugins",
      "external-synthetic-consumer",
      "contracts",
      contractName!,
    ),
    "utf8",
  );
  expect(contract).toContain("agentpkg-generated-protocol-core/src/plugins/protocol-core/tools/external-submit.tool");

  const opencodeConfig = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"),
  ) as { permission?: Record<string, string>; plugin?: string[] };
  expect(opencodeConfig.permission).toMatchObject({
    "external_synthetic_consumer_*": "deny",
    "protocol_core_*": "deny",
  });
  expect(opencodeConfig.plugin).toEqual([
    generatedPluginEntry(
      projectRoot,
      "agentpkg-generated-external-synthetic-consumer",
    ),
    generatedPluginEntry(projectRoot, "agentpkg-generated-protocol-core"),
  ]);
});

test("compilePluginForTarget fails closed when target cannot execute canonical tool bindings", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "claude-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("UnsupportedTargetCapabilityError");
  if (failure._tag === "UnsupportedTargetCapabilityError") {
    expect(failure.target).toBe("claude-code");
    expect(failure.capability).toBe("generated-canonical-tools");
    expect(failure.message).toContain("builder");
  }
});

test("compilePluginForTarget lowers native Claude surfaces when no canonical tool runtime is required", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture({
    withCanonicalToolBindings: false,
  });

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

  expect(claude.composed).toHaveLength(3);

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
  expect(claudeAgent).toContain("## Recommended Skills");
  expect(claudeAgent).toContain("- `testing`");
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
