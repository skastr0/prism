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
    join(projectRoot, ".opencode", "plugins", pluginId, "dist", "server.mjs"),
  ).href;

const generatedLegacySourcePluginEntry = (projectRoot: string, pluginId: string): string =>
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

const parseOpencodeSkillPermissions = (markdown: string): Record<string, string> => {
  const frontmatter = matter(markdown).data as {
    permission?: { skill?: Record<string, string> };
  };
  return frontmatter.permission?.skill ?? {};
};

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const agentpkgImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const skillPermissionAction = (
  permission: Record<string, string>,
  skill: string,
): string => permission[skill] ?? permission["*"] ?? "ask";

const visibleSkillsForPermission = (
  skills: ReadonlyArray<string>,
  permission: Record<string, string>,
): string[] =>
  skills
    .filter((skill) => skillPermissionAction(permission, skill) !== "deny")
    .sort((left, right) => left.localeCompare(right));

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

const createGeminiExtensionFixture = async (): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "gemini-extension-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "gemini_extension.demo",
        version: "0.2.0",
        targets: {
          rules: ["gemini-cli"],
          commands: ["gemini-cli"],
          skills: ["gemini-cli"],
          agents: ["gemini-cli"],
          lifecycles: ["gemini-cli"],
          tools: ["gemini-cli"],
          toolspaces: ["gemini-cli"],
          hooks: ["gemini-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "rules", "global", "context.md"), `# Gemini context\n\nUse the generated extension context.\n`);
  await writeText(join(pluginRoot, "rules", "project", "project-context.md"), `# Project context\n\nKeep extension-local project guidance.\n`);
  await writeText(join(pluginRoot, "commands", "hello.md"), `---\ndescription: Say hello\n---\n\nSay hello from the generated command.\n`);
  await writeText(join(pluginRoot, "skills", "testing", "SKILL.md"), `---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n`);
  await writeText(join(pluginRoot, "identities", "worker.identity.md"), `---\ndescription: Worker identity\n---\n\n# Worker\n\nUse the extension bundle.\n`);
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `import { defineToolspace } from ${JSON.stringify(agentpkgImportPath)};

export default defineToolspace({
  name: "workspace",
  tools: { read_repo: { targets: { "gemini-cli": { name: "read_file" } } } },
});
`);
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "submit-work",
  description: "Submit completed work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input, context) { return { acknowledged: true }; },
});
`);
  await writeText(join(pluginRoot, "traits", "submittable.trait.ts"), `import { defineTrait, toolRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineTrait({
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit work through the typed Gemini extension tool.",
  access: { tools: [toolRef("workspace", "read_repo")] },
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
});
`);
  await writeText(join(pluginRoot, "agents", "worker.agent.ts"), `import { defineAgent, skillRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineAgent({
  name: "worker",
  description: "Gemini extension worker",
  identity: "worker",
  traits: ["submittable"],
  skills: [skillRef("testing")],
});
`);
  await writeText(join(pluginRoot, "lifecycles", "delivery.lifecycle.ts"), `import { agentRef, defineLifecycle, traitRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineLifecycle({
  name: "delivery",
  description: "Deliver work through Gemini",
  phases: [{ name: "Build", agents: [agentRef("worker")], requires: [{ all: [traitRef("submittable")] }] }],
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-read.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineHook({
  name: "audit-read",
  description: "Audit read calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "read_repo")) },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-submit.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineHook({
  name: "audit-submit",
  description: "Audit canonical submit calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("submit_work") },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);

  return { pluginRoot, projectRoot };
};

const createCodexProjectFixture = async (): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "codex-project-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "codex-project-demo",
        version: "0.4.0",
        targets: {
          rules: ["codex-cli"],
          skills: ["codex-cli"],
          agents: ["codex-cli"],
          tools: ["codex-cli"],
          toolspaces: ["codex-cli"],
          hooks: ["codex-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "rules", "global", "context.md"), `# Codex context\n\nUse project-local Codex guidance.\n`);
  await writeText(join(pluginRoot, "skills", "testing", "SKILL.md"), `---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n`);
  await writeText(join(pluginRoot, "identities", "reviewer.identity.md"), `---\ndescription: Reviewer identity\n---\n\n# Reviewer\n\nReview through Codex.\n`);
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `import { defineToolspace } from ${JSON.stringify(agentpkgImportPath)};

export default defineToolspace({
  name: "workspace",
  tools: { shell: { targets: { "codex-cli": { name: "shell.command" } } } },
});
`);
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "submit-work",
  description: "Submit completed work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(_input, _context) { return { acknowledged: true }; },
});
`);
  await writeText(join(pluginRoot, "traits", "submittable.trait.ts"), `import { defineTrait } from ${JSON.stringify(agentpkgImportPath)};

export default defineTrait({
  name: "submittable",
  description: "Can submit work",
  instructions: "Submit through the generated Codex MCP tool.",
  tools: { submit_work: { ref: "submit-work" } },
  require: { tools: ["submit_work"] },
});
`);
  await writeText(join(pluginRoot, "agents", "reviewer.agent.ts"), `import { defineAgent, skillRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineAgent({
  name: "reviewer",
  description: "Codex project reviewer",
  identity: "reviewer",
  traits: ["submittable"],
  skills: [skillRef("testing")],
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-shell.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineHook({
  name: "audit-shell",
  description: "Audit shell calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);

  return { pluginRoot, projectRoot };
};

const createOpenCodeHookFixture = async (options?: {
  sessionHook?: boolean;
}): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "opencode-hook-demo");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "opencode-hook-demo",
        version: "0.1.0",
        targets: {
          hooks: ["opencode"],
          toolspaces: ["opencode"],
          tools: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(pluginRoot, "toolspaces", "core.toolspace.ts"), `import { defineToolspace } from ${JSON.stringify(agentpkgImportPath)};

export default defineToolspace({
  name: "core",
  tools: { shell: { targets: { opencode: { name: "bash" } } } },
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-before.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineHook({
  name: "audit-before",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("core", "shell")) },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-after.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineHook({
  name: "audit-after",
  event: hookEvent.toolAfter,
  match: { tool: hookTool.tool(toolRef("core", "shell")) },
  handle: (_event) => Effect.succeed({ decision: "block" as const, message: "ignored for observational hooks" }),
});
`);
  await writeText(join(pluginRoot, "tools", "submit-work.tool.ts"), `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "submit-work",
  description: "Submit completed work",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(_input, _context) { return { acknowledged: true }; },
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-submit.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineHook({
  name: "audit-submit",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("submit_work") },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);
  if (options?.sessionHook) {
    await writeText(join(pluginRoot, "hooks", "session-start.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent } from ${JSON.stringify(agentpkgImportPath)};

export default defineHook({
  name: "session-start",
  event: hookEvent.sessionStart,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);
    await writeText(join(pluginRoot, "hooks", "session-end.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent } from ${JSON.stringify(agentpkgImportPath)};

export default defineHook({
  name: "session-end",
  event: hookEvent.sessionEnd,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`);
  }

  return { pluginRoot, projectRoot };
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
          generatedLegacySourcePluginEntry(
            projectRoot,
            "agentpkg-generated-permission-only-consumer",
          ),
          generatedPluginEntry(projectRoot, "agentpkg-generated-stale-dep"),
          generatedLegacySourcePluginEntry(projectRoot, "agentpkg-generated-stale-dep"),
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
  // Derived skill renders trait protocols once, deduplicated across agents.
  expect(skill).toContain("## Trait protocols active in this lifecycle");
  expect(skill).toContain("`canonical-compile-fixture:reviewable`");
  expect(skill).toContain("`canonical-compile-fixture:self-assessing`");
  expect(
    await pathExists(
      join(projectRoot, ".opencode", "lifecycles", "delivery-contract.md"),
    ),
  ).toBe(false);

  const warmOpencode = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );
  const generatedPluginWrites = warmOpencode.operations.filter(
    (operation) =>
      operation.kind === "write-plugin-file" &&
      operation.target.includes(join(".opencode", "plugins", "agentpkg-generated")),
  );
  expect(generatedPluginWrites.length).toBeGreaterThan(0);
  expect(generatedPluginWrites.every((operation) => operation.reason === "unchanged")).toBe(true);
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

test("lifecycle orchestrator validation fails when the orchestrator agent does not exist", async () => {
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
    expect(failure.field).toBe("orchestrator.agent");
    expect(failure.message).toContain("unknown agent");
  }
});

test("lifecycle skill renders orchestrator section and grants the lifecycle skill to the orchestrator", async () => {
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

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );
  expect(skill).toContain("## Orchestrator");
  expect(skill).toContain("`builder`");
  expect(skill).toContain("`create_item`");

  // The orchestrator agent (builder) auto-receives the lifecycle skill.
  const builder = result.composed.find((agent) => agent.name === "builder");
  expect(builder?.allowedSkills).toContain("delivery-contract");
});

test("lifecycle-wide tool_permissions materialize on every phase agent", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  // Replace the lifecycle file with one that uses lifecycle-wide tool_permissions
  // and no orchestrator. Both phase agents (builder + reviewer) should get the
  // wide-granted tool.
  await writeText(
    join(pluginRoot, "lifecycles", "delivery-contract.lifecycle.ts"),
    `import { agentRef, defineLifecycle, traitRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineLifecycle({
  name: "delivery-contract",
  description: "Wide-grant variant",
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [{ all: [traitRef("committable"), traitRef("self-assessing")] }],
    },
    {
      name: "Review change",
      agents: [agentRef("reviewer")],
      requires: [{ all: [traitRef("reviewable"), traitRef("self-assessing")] }],
    },
  ],
  tool_permissions: [
    { ref: "protocol-core:create_item", as: "create_item" },
  ],
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

  const builder = result.composed.find((agent) => agent.name === "builder");
  const reviewer = result.composed.find((agent) => agent.name === "reviewer");
  expect(
    builder?.toolBindings.some((binding) => binding.logicalName === "create_item"),
  ).toBe(true);
  expect(
    reviewer?.toolBindings.some((binding) => binding.logicalName === "create_item"),
  ).toBe(true);

  const skill = await readFile(
    join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"),
    "utf8",
  );
  expect(skill).toContain("## Tools available to every phase agent");
  expect(skill).toContain("`create_item`");
});

test("lifecycle parser rejects the legacy tool_permissions shape with agents", async () => {
  const projectRoot = await createTempRoot();
  const pluginRoot = join(projectRoot, "plugin");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "legacy-shape",
        version: "0.1.0",
        targets: {
          lifecycles: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "lifecycles", "legacy.lifecycle.ts"),
    `import { defineLifecycle } from ${JSON.stringify(agentpkgImportPath)};

export default defineLifecycle({
  name: "legacy",
  description: "Uses the deprecated tool_permissions shape with agents",
  phases: [],
  tool_permissions: [
    { agents: ["builder"], tools: ["protocol-core:create_item"] },
  ],
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

  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error("expected typed compile failure");
  }
  const error = failure.value as CompileError;
  expect(error._tag).toBe("SourceParseError");
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
  const bundle = await readFile(join(generatedRoot, "dist", "server.mjs"), "utf8");
  expect(bundle).toContain("submit_review__review_findings_slot");
  expect(await pathExists(join(generatedRoot, "src", "server.ts"))).toBe(false);
});

test("compilePluginForTarget emits a Gemini extension bundle", async () => {
  const { pluginRoot, projectRoot } = await createGeminiExtensionFixture();
  const extensionRoot = join(projectRoot, ".gemini", "extensions", "agentpkg-generated-gemini-extension-demo");
  await writeText(join(extensionRoot, "stale", "old.txt"), "stale\n");

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "gemini-cli",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  expect(result.composed).toHaveLength(1);
  expect(result.outputRoot.replace(/\/$/u, "")).toBe(join(projectRoot, ".gemini"));

  const manifest = JSON.parse(await readFile(join(extensionRoot, "gemini-extension.json"), "utf8")) as {
    name: string;
    version: string;
    contextFileName?: string | string[];
    mcpServers?: Record<string, { command: string; args: string[]; trust?: unknown }>;
  };

  expect(manifest).toEqual({
    name: "agentpkg-generated-gemini-extension-demo",
    version: "0.2.0",
    contextFileName: "GEMINI.md",
    mcpServers: {
      "agentpkg-generated-gemini-extension-demo": {
        command: "bun",
        args: ["${extensionPath}/mcp/agentpkg_generated_gemini_extension_demo/server.mjs"],
      },
    },
  });
  expect(manifest.mcpServers?.["agentpkg-generated-gemini-extension-demo"]).not.toHaveProperty("trust");

  const context = await readFile(join(extensionRoot, "GEMINI.md"), "utf8");
  expect(context).toContain("<!-- agentpkg:context-source global/context.md -->");
  expect(context).toContain("# Gemini context");
  expect(context).toContain("<!-- agentpkg:context-source project/project-context.md -->");
  expect(context).toContain("# Project context");

  const agent = await readFile(join(extensionRoot, "agents", "worker.md"), "utf8");
  const parsedAgent = matter(agent);
  expect(parsedAgent.data).toMatchObject({
    name: "worker",
    description: "Gemini extension worker",
    tools: [
      "mcp_agentpkg-generated-gemini-extension-demo_gemini_extension_demo_submit_work",
      "read_file",
    ],
  });
  expect(parsedAgent.content).toContain("# Worker");
  expect(parsedAgent.content).toContain("Submit work through the typed Gemini extension tool.");

  expect(await readFile(join(extensionRoot, "skills", "testing", "SKILL.md"), "utf8")).toContain("# Testing");
  const lifecycleSkill = await readFile(join(extensionRoot, "skills", "delivery", "SKILL.md"), "utf8");
  expect(lifecycleSkill).toContain('<!-- agentpkg:lifecycle-skill owner="gemini_extension.demo" -->');
  expect(lifecycleSkill).toContain("# delivery");
  expect(lifecycleSkill).toContain("### 1. Build — agent `worker`");

  const command = await readFile(join(extensionRoot, "commands", "hello.toml"), "utf8");
  expect(command).toBe('description = "Say hello"\nprompt = """Say hello from the generated command."""\n');

  expect(await pathExists(join(extensionRoot, "mcp", "agentpkg_generated_gemini_extension_demo", "server.mjs"))).toBe(true);

  const hookConfig = JSON.parse(await readFile(join(extensionRoot, "hooks", "hooks.json"), "utf8")) as {
    hooks: { BeforeTool: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };
  expect(hookConfig).toEqual({
    hooks: {
      BeforeTool: [
        {
          matcher: "read_file",
          hooks: [{ type: "command", command: 'node "${extensionPath}/hooks/audit-read.mjs"' }],
        },
        {
          matcher: "mcp_agentpkg-generated-gemini-extension-demo_gemini_extension_demo_submit_work",
          hooks: [{ type: "command", command: 'node "${extensionPath}/hooks/audit-submit.mjs"' }],
        },
      ],
    },
  });
  const hookWrapper = await readFile(join(extensionRoot, "hooks", "audit-submit.mjs"), "utf8");
  expect(hookWrapper).toStartWith("#!/usr/bin/env node");
  expect(hookWrapper).toContain("gemini-cli");
  expect(hookWrapper).toContain("BeforeTool");
  expect(hookWrapper).toContain("hookSpecificOutput");
  expect(hookWrapper).toContain('decision: "deny"');
  expect(hookWrapper).toContain("reason:");
  expect(hookWrapper).not.toContain("stopReason");
  expect(hookWrapper).not.toContain("continue:!1");
  expect(hookWrapper).not.toContain("continue:false");
  expect(hookWrapper).toContain("validation failed");
  expect(hookWrapper).toContain("result");

  expect(await pathExists(join(extensionRoot, "stale", "old.txt"))).toBe(false);
  expect(result.operations.some((operation) => operation.kind === "prune-plugin-path" && operation.target.endsWith(join("stale", "old.txt")))).toBe(true);
});

test("compilePluginForTarget emits a Codex project bundle", async () => {
  const { pluginRoot, projectRoot } = await createCodexProjectFixture();

  const result = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "codex-cli",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const codexRoot = join(projectRoot, ".codex");
  expect(result.composed).toHaveLength(1);
  expect(result.outputRoot.replace(/\/$/u, "")).toBe(codexRoot);

  const config = await readFile(join(codexRoot, "config.toml"), "utf8");
  expect(config).toContain("# --- agentpkg codex-cli begin: codex-project-demo ---");
  expect(config).toContain('["mcp_servers"."agentpkg-generated-codex-project-demo"]');
  expect(config).toContain('enabled_tools = ["codex_project_demo_submit_work"]');
  expect(config).toContain('[["hooks"."PreToolUse"]]');
  expect(config).toContain('matcher = "shell\\\\.command"');

  const agent = await readFile(join(codexRoot, "agents", "reviewer.toml"), "utf8");
  expect(agent).toContain('name = "reviewer"');
  expect(agent).toContain('["mcp_servers"."agentpkg-generated-codex-project-demo"]');

  expect(await pathExists(join(codexRoot, "mcp", "agentpkg_generated_codex_project_demo", "server.mjs"))).toBe(true);
  expect(await pathExists(join(codexRoot, "hooks", "audit-shell.mjs"))).toBe(true);
  expect(await readFile(join(codexRoot, "skills", "testing", "SKILL.md"), "utf8")).toContain("# Testing");
  expect(await readFile(join(codexRoot, "AGENTS.md"), "utf8")).toContain("Use project-local Codex guidance.");
});

test("compilePluginForTarget lowers OpenCode session hooks through plugin events", async () => {
  const { pluginRoot, projectRoot } = await createOpenCodeHookFixture({ sessionHook: true });

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
    "agentpkg-generated-opencode-hook-demo",
  );
  const serverSource = await readFile(join(generatedRoot, "dist", "server.mjs"), "utf8");

  expect(serverSource).toContain('"tool.execute.before"');
  expect(serverSource).toContain('"tool.execute.after"');
  expect(serverSource).toContain('"opencode_hook_demo_submit_work"');
  expect(serverSource).not.toContain("/Projects/agentpkg/src/compile/sources.ts");
  expect(serverSource).toContain('"session.created"');
  expect(serverSource).toContain('"session.start"');
  expect(serverSource).toContain('"session.deleted"');
  expect(serverSource).toContain('"session.end"');
  expect(serverSource).toContain("decodeNativeHookPayloadForEvent");
  expect(serverSource).toContain("decodeHookResultForEvent");
  expect(serverSource).not.toContain(agentpkgImportPath);
  expect(await pathExists(join(generatedRoot, "src", "server.ts"))).toBe(false);
  expect(await pathExists(join(generatedRoot, "src", "runtime", "hook-runtime.ts"))).toBe(false);
  expect(await pathExists(join(generatedRoot, "src", "runtime", "hook-authoring-bridge.ts"))).toBe(false);
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
  const protocolGeneratedRoot = join(
    projectRoot,
    ".opencode",
    "plugins",
    "agentpkg-generated-protocol-core",
  );
  const generatedBundlePath = join(generatedRoot, "dist", "server.mjs");
  const protocolBundlePath = join(protocolGeneratedRoot, "dist", "server.mjs");
  const generatedServer = await import(pathToFileURL(generatedBundlePath).href);
  expect(generatedServer.default.id).toBe("agentpkg-generated-canonical-compile-fixture");
  const generatedPlugin = await generatedServer.default.server({
    directory: projectRoot,
    worktree: projectRoot,
  });
  const generatedToolNames = Object.keys(generatedPlugin.tool ?? {});
  expect(generatedToolNames).toContain("canonical_compile_fixture_submit_review__review_findings_slot");
  expect(generatedToolNames).not.toContain("protocol_core_external_submit");
  expect(generatedToolNames).not.toContain("canonical_compile_fixture_builder_submit_work");
  expect(await pathExists(join(generatedRoot, "src", "server.ts"))).toBe(false);
  expect(await pathExists(join(generatedRoot, "package.json"))).toBe(false);
  expect(await pathExists(join(generatedRoot, "node_modules", "effect", "package.json"))).toBe(false);

  const generatedServerSource = await readFile(generatedBundlePath, "utf8");
  expect(generatedServerSource).not.toContain("canonical.handle");
  expect(generatedServerSource).not.toContain('from "agentpkg"');
  expect(generatedServerSource).not.toContain("src/index.ts");
  expect(generatedServerSource).not.toContain("schemaSlot");
  expect(generatedServerSource).not.toContain("defineTool");
  expect(generatedServerSource).not.toContain('from "effect"');
  expect(generatedServerSource).not.toContain('from "@opencode-ai/plugin"');
  expect(generatedServerSource).not.toContain('"protocol_core_external_submit":');
  expect(generatedServerSource).not.toContain("canonical_compile_fixture_builder_submit_work");
  expect(generatedServerSource).not.toContain("delivery-contract__builder__create_item");
  expect(generatedServerSource).toContain("submit_review__review_findings_slot");
  expect(generatedServerSource).not.toContain("Schema.omit");
  expect(generatedServerSource).not.toContain("agentpkg-generated-protocol-core/src/plugins");

  const protocolServer = await import(pathToFileURL(protocolBundlePath).href);
  const protocolPlugin = await protocolServer.default.server({
    directory: projectRoot,
    worktree: projectRoot,
  });
  const protocolToolNames = Object.keys(protocolPlugin.tool ?? {});
  expect(protocolToolNames).toContain("protocol_core_external_submit");
  expect(protocolToolNames).toContain("protocol_core_create_item");
  const protocolGeneratedServerSource = await readFile(protocolBundlePath, "utf8");
  expect(protocolGeneratedServerSource).not.toContain('from "effect"');
  expect(protocolGeneratedServerSource).not.toContain('from "@opencode-ai/plugin"');
  expect(await pathExists(join(protocolGeneratedRoot, "src", "server.ts"))).toBe(false);
  expect(await pathExists(join(protocolGeneratedRoot, "package.json"))).toBe(false);

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

test("toolspace refs require a target mapping for the compile harness", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "toolspace-target-demo",
        version: "0.1.0",
        targets: {
          agents: ["claude-code"],
          toolspaces: ["claude-code"],
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
    join(pluginRoot, "toolspaces", "workspace.toolspace.ts"),
    `import { defineToolspace } from "agentpkg";

export default defineToolspace({
  name: "workspace",
  tools: {
    read: {
      targets: {
        opencode: { name: "read" },
      },
    },
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent, toolRef } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  access: {
    tools: [toolRef("workspace", "read")],
  },
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
  expect(failure._tag).toBe("MissingTargetResolutionError");
  if (failure._tag === "MissingTargetResolutionError") {
    expect(failure.referenceKind).toBe("tool");
    expect(failure.referenceName).toBe("workspace/read");
    expect(failure.target).toBe("claude-code");
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

test("permission-only skill access lowers into Gemini agent skill frontmatter", async () => {
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
          agents: ["gemini-cli"],
          skillspaces: ["gemini-cli"],
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
        "gemini-cli": { name: "testing" },
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

  await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "gemini-cli",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const agentMarkdown = await readFile(
    join(projectRoot, ".gemini", "extensions", "agentpkg-generated-unsupported-skill-permission-demo", "agents", "worker.md"),
    "utf8",
  );
  expect(agentMarkdown).toContain("skills:");
  expect(agentMarkdown).toContain('- "testing"');
});

test("trait-lifecycle example lowers assigned traits and lifecycle skill into opencode permissions", async () => {
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

  const expectedSkillAccess = {
    builder: [
      "ast-grep",
      "backpressure",
      "build",
      "code-reviewer",
      "commit",
      "contracts",
      "ddd",
      "delivery-contract",
      "effect",
      "evolve",
      "harness-programming",
      "repo-research",
      "requirements",
      "review",
      "sdlc",
      "security-reviewer",
      "semgrep-usage",
      "testing",
      "type-level",
      "unslop",
    ],
    reviewer: [
      "ast-grep",
      "backpressure",
      "build",
      "code-reviewer",
      "commit",
      "contracts",
      "delivery-contract",
      "evolve",
      "harness-programming",
      "model-intelligence",
      "repo-research",
      "requirements",
      "research",
      "review",
      "sdlc",
      "security-reviewer",
      "semgrep-usage",
      "testing",
      "unslop",
      "video-research",
      "web-research",
    ],
    "security-reviewer": [
      "ast-grep",
      "backpressure",
      "build",
      "code-reviewer",
      "commit",
      "contracts",
      "ddd",
      "effect",
      "evolve",
      "harness-programming",
      "repo-research",
      "requirements",
      "review",
      "sdlc",
      "security-reviewer",
      "semgrep-usage",
      "testing",
      "type-level",
      "unslop",
    ],
  } as const;

  for (const [agentName, expectedSkills] of Object.entries(expectedSkillAccess)) {
    const agent = result.composed.find((candidate) => candidate.name === agentName);
    expect(agent?.skills).toEqual([]);
    expect(agent?.allowedSkills).toEqual(expectedSkills);

    const markdown = result.operations.find(
      (operation) =>
        operation.kind === "write-md" && operation.target.endsWith(`agents/${agentName}.md`),
    );
    if (!markdown || markdown.kind !== "write-md") {
      throw new Error(`expected ${agentName} markdown operation`);
    }
    const frontmatter = matter(markdown.content).data as {
      permission?: { skill?: Record<string, string> };
    };

    expect(markdown.content).not.toContain("## Recommended Skills");
    expect(frontmatter.permission?.skill).toEqual(
      Object.fromEntries([
        ["*", "deny"],
        ...expectedSkills.map((skill) => [skill, "allow"] as const),
      ]),
    );
    expect(expectedSkills).not.toContain("marketing");
    expect(expectedSkills).not.toContain("media-generation");
  }
});

test("domain skill permission traits compile one opencode agent per family", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  const agentCoreRoot = join(
    process.cwd(),
    "examples",
    "trait-lifecycle-contracts",
    "deps",
    "agent-core",
  );
  const traitFamilies = [
    {
      agent: "engineer",
      trait: "core-engineering",
      expected: [
        "ast-grep",
        "build",
        "code-reviewer",
        "contracts",
        "harness-programming",
        "repo-research",
        "security-reviewer",
        "semgrep-usage",
        "testing",
        "unslop",
      ],
    },
    {
      agent: "functional-programmer",
      trait: "functional-thinking",
      expected: ["contracts", "ddd", "effect", "testing", "type-level"],
    },
    {
      agent: "marketer",
      trait: "core-marketing",
      expected: [
        "brand-positioning",
        "copy-engineering",
        "marketing",
        "offer-architecture",
        "persuasion-architecture",
        "subscription-wedge",
      ],
    },
    {
      agent: "writer",
      trait: "writing-and-publishing",
      expected: [
        "content-mining",
        "copy-engineering",
        "platform-twitter",
        "typefully-cli",
        "voice-profile",
        "wlc",
      ],
    },
    {
      agent: "researcher",
      trait: "research-practice",
      expected: [
        "model-intelligence",
        "repo-research",
        "research",
        "video-research",
        "web-research",
      ],
    },
    {
      agent: "frontend-builder",
      trait: "frontend-implementation",
      expected: [
        "build",
        "frontend-design",
        "legend-state",
        "testing",
        "vercel-react-native-skills",
      ],
    },
    {
      agent: "media-producer",
      trait: "media-generation-practice",
      expected: [
        "fal-models",
        "media-generation",
        "mg-3d-workflow-authoring",
        "mg-schema",
        "mg-workflow-authoring",
        "suno-music-prompting",
        "video-research",
      ],
    },
  ] as const;

  await mkdir(projectRoot, { recursive: true });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "domain-skill-trait-consumer",
        version: "0.1.0",
        deps: {
          "agent-core": agentCoreRoot,
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
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Domain worker identity
---

# Worker
`,
  );

  for (const family of traitFamilies) {
    await writeText(
      join(pluginRoot, "agents", `${family.agent}.agent.ts`),
      `import { bindTrait, defineAgent } from "agentpkg";

export default defineAgent({
  name: ${JSON.stringify(family.agent)},
  description: ${JSON.stringify(`Uses ${family.trait} skill permissions`)},
  identity: "worker",
  traits: [bindTrait(${JSON.stringify(`agent-core:${family.trait}`)})],
});
`,
    );
  }

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

  for (const family of traitFamilies) {
    const agent = result.composed.find((candidate) => candidate.name === family.agent);
    expect(agent?.skills).toEqual([]);
    expect(agent?.allowedSkills).toEqual(family.expected);

    const markdown = result.operations.find(
      (operation) =>
        operation.kind === "write-md" &&
        operation.target.endsWith(`agents/${family.agent}.md`),
    );
    if (!markdown || markdown.kind !== "write-md") {
      throw new Error(`expected ${family.agent} markdown operation`);
    }

    const frontmatter = matter(markdown.content).data as {
      permission?: { skill?: Record<string, string> };
    };
    expect(markdown.content).not.toContain("## Recommended Skills");
    expect(frontmatter.permission?.skill?.["*"]).toBe("deny");
    expect(Object.keys(frontmatter.permission?.skill ?? {}).sort()).toEqual([
      "*",
      ...family.expected,
    ].sort());
  }
});

test("opencode skill audit harness verifies visibility, direct deps, and missing refs", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "skill-audit-demo",
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
    join(pluginRoot, "traits", "testing-enabled.trait.ts"),
    `import { defineTrait, skillspaceRef } from "agentpkg";

export default defineTrait({
  name: "testing-enabled",
  description: "Can use test methodology",
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
        opencode: { name: "testing" },
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
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent, skillRef } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker with direct and permission-only skills",
  identity: "worker",
  traits: ["testing-enabled"],
  skills: [skillRef("contracts")],
});
`,
  );

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
  const worker = result.composed.find((agent) => agent.name === "worker");
  expect(worker?.skills).toEqual(["contracts"]);
  expect(worker?.allowedSkills).toEqual(["contracts", "testing"]);

  const markdown = result.operations.find(
    (operation) =>
      operation.kind === "write-md" && operation.target.endsWith("agents/worker.md"),
  );
  if (!markdown || markdown.kind !== "write-md") {
    throw new Error("expected worker markdown operation");
  }

  const permissions = parseOpencodeSkillPermissions(markdown.content);
  expect(permissions).toEqual({
    "*": "deny",
    contracts: "allow",
    testing: "allow",
  });
  expect(
    visibleSkillsForPermission(["contracts", "marketing", "testing"], permissions),
  ).toEqual(["contracts", "testing"]);
  expect(markdown.content).toContain("## Recommended Skills");
  expect(markdown.content).toContain("- `contracts`");
  expect(markdown.content).not.toContain("- `testing`");

  const missingRoot = await createTempRoot();
  const missingPluginRoot = join(missingRoot, "plugin");
  const missingProjectRoot = join(missingRoot, "project");
  await mkdir(missingProjectRoot, { recursive: true });
  await writeText(
    join(missingPluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "missing-skill-audit-demo",
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
    join(missingPluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );
  await writeText(
    join(missingPluginRoot, "traits", "testing-enabled.trait.ts"),
    `import { defineTrait, skillspaceRef } from "agentpkg";

export default defineTrait({
  name: "testing-enabled",
  description: "References a missing method skill",
  access: {
    skills: [skillspaceRef("external-skills", "missing-method")],
  },
});
`,
  );
  await writeText(
    join(missingPluginRoot, "skillspaces", "external-skills.skillspace.ts"),
    `import { defineSkillspace } from "agentpkg";

export default defineSkillspace({
  name: "external-skills",
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
    join(missingPluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from "agentpkg";

export default defineAgent({
  name: "worker",
  description: "Worker with a missing skill permission",
  identity: "worker",
  traits: ["testing-enabled"],
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: missingPluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: missingProjectRoot,
      dryRun: true,
      backup: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("UnknownReferenceError");
  if (failure._tag === "UnknownReferenceError") {
    expect(failure.field).toBe("skill");
    expect(failure.referenceName).toBe("external-skills/missing-method");
  }
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
  expect(await pathExists(join(protocolGeneratedRoot, "package.json"))).toBe(false);
  expect(await pathExists(join(protocolGeneratedRoot, "dist", "server.mjs"))).toBe(true);
  expect(await pathExists(join(protocolGeneratedRoot, "src", "server.ts"))).toBe(false);
  const protocolBundle = await readFile(join(protocolGeneratedRoot, "dist", "server.mjs"), "utf8");
  expect(protocolBundle).toContain("protocol_core_external_submit");
  expect(protocolBundle).toContain("protocol_core_unreferenced");
  expect(protocolBundle).toContain("shared");

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
    generatedPluginEntry(projectRoot, "agentpkg-generated-stale-dep"),
    generatedPluginEntry(projectRoot, "agentpkg-generated-protocol-core"),
  ]);
  expect(opencodeConfig.plugin).not.toContain("agentpkg-generated-stale-dep");
  expect(opencodeConfig.plugin).not.toContain(
    generatedLegacySourcePluginEntry(projectRoot, "agentpkg-generated-stale-dep"),
  );
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

  expect(await pathExists(join(protocolGeneratedRoot, "dist", "server.mjs"))).toBe(true);
  expect(await pathExists(join(protocolGeneratedRoot, "src", "server.ts"))).toBe(false);
  expect(await pathExists(join(protocolGeneratedRoot, "package.json"))).toBe(false);

  const server = await readFile(
    join(protocolGeneratedRoot, "dist", "server.mjs"),
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

  expect(await pathExists(join(consumerGeneratedRoot, "package.json"))).toBe(false);
  expect(await pathExists(join(protocolGeneratedRoot, "package.json"))).toBe(false);
  expect(
    await pathExists(
      join(
        protocolGeneratedRoot,
        "dist",
        "server.mjs",
      ),
    ),
  ).toBe(true);
  expect(
    await pathExists(
      join(
        consumerGeneratedRoot,
        "src",
        "server.ts",
      ),
    ),
  ).toBe(false);

  const consumerServer = await readFile(join(consumerGeneratedRoot, "dist", "server.mjs"), "utf8");
  expect(consumerServer).toContain(
    "external_synthetic_consumer_submit_work__worker_details",
  );
  const protocolServer = await readFile(join(protocolGeneratedRoot, "dist", "server.mjs"), "utf8");
  expect(protocolServer).toContain("protocol_core_external_submit");

  const opencodeAgent = await readFile(
    join(projectRoot, ".opencode", "agents", "worker.md"),
    "utf8",
  );
  expect(opencodeAgent).toContain(
    "external_synthetic_consumer_submit_work__worker_details: allow",
  );
  expect(opencodeAgent).toContain("protocol_core_external_submit: deny");

  expect(consumerServer).toContain("submit_work__worker_details");
  expect(consumerServer).not.toContain("agentpkg-generated-protocol-core/src/plugins/protocol-core/tools/external-submit.tool");

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

test("compilePluginForTarget lowers canonical tool bindings into a Claude plugin bundle", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

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

  const pluginRootPath = join(
    projectRoot,
    ".claude",
    "plugins",
    "agentpkg-generated-canonical-compile-fixture",
  );
  const claudeAgent = await readFile(join(pluginRootPath, "agents", "builder.md"), "utf8");
  expect(claudeAgent).toContain('description: "Builder agent for canonical compile integration tests"');
  expect(claudeAgent).toContain('model: "sonnet"');
  expect(claudeAgent).toContain("protocol_core_external_submit");

  const mcpConfig = await readFile(join(pluginRootPath, ".mcp.json"), "utf8");
  expect(mcpConfig).toContain('"agentpkg-generated-canonical-compile-fixture"');
  expect(mcpConfig).toContain('"command": "bun"');
  expect(mcpConfig).toContain(
    '"${CLAUDE_PLUGIN_ROOT}/mcp/agentpkg_generated_canonical_compile_fixture/server.mjs"',
  );
  expect(
    await pathExists(
      join(pluginRootPath, "mcp", "agentpkg_generated_canonical_compile_fixture", "server.mjs"),
    ),
  ).toBe(true);
  expect(await pathExists(join(projectRoot, ".claude", "agents", "builder.md"))).toBe(false);
});

test("compilePluginForTarget lowers Claude plugin-bundle surfaces when no canonical tool runtime is required", async () => {
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

  const pluginRootPath = join(
    projectRoot,
    ".claude",
    "plugins",
    "agentpkg-generated-canonical-compile-fixture",
  );
  const claudeAgent = await readFile(
    join(pluginRootPath, "agents", "builder.md"),
    "utf8",
  );
  expect(claudeAgent).toContain(
    'description: "Builder agent for canonical compile integration tests"',
  );
  expect(claudeAgent).toContain('model: "sonnet"');
  expect(claudeAgent).toContain("temperature: 0.1");
  expect(claudeAgent).toContain("top_p: 0.7");
  expect(claudeAgent).toContain("tools:");
  expect(claudeAgent).toContain('- "Read"');
  expect(claudeAgent).toContain('- "Grep"');
  expect(claudeAgent).toContain('- "Bash"');
  expect(claudeAgent).toContain("skills:");
  expect(claudeAgent).toContain('- "testing"');
  expect(claudeAgent).toContain("## Trait Instructions");
  expect(claudeAgent).toContain(
    "Commit owned implementation changes only after the submitted work is complete.",
  );
  expect(
    await pathExists(
      join(pluginRootPath, "skills", "delivery-contract", "SKILL.md"),
    ),
  ).toBe(true);
  expect(
    await pathExists(
      join(pluginRootPath, "lifecycles", "delivery-contract.md"),
    ),
  ).toBe(false);
  expect(await pathExists(join(projectRoot, ".claude", "agents", "builder.md"))).toBe(false);
  expect(await pathExists(join(projectRoot, ".claude", "settings.json"))).toBe(false);
});

test("compilePluginForTarget does not lower runtime artifacts for metadata-only target declarations", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "metadata-only-plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "metadata-only-plugin",
        version: "0.1.0",
        targets: {
          toolspaces: ["opencode", "claude-code", "gemini-cli", "codex-cli"],
          modelspaces: ["opencode", "claude-code", "gemini-cli", "codex-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );

  for (const target of ["opencode", "claude-code", "gemini-cli", "codex-cli"] as const) {
    const result = await Effect.runPromise(
      compilePluginForTarget({
        pluginPath: pluginRoot,
        target,
        scope: "project",
        projectPath: projectRoot,
        dryRun: true,
        backup: false,
      }),
    );

    expect(result.composed).toHaveLength(0);
    expect(result.lifecycles).toHaveLength(0);
    expect(result.operations).toHaveLength(0);
  }
});

test("compilePluginForTarget fails when targeted agents bind tools not targeted for that harness", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "tool-target-leak");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "tool-target-leak",
        version: "0.1.0",
        targets: {
          agents: ["opencode"],
          tools: ["claude-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---\ndescription: Worker\n---\n\n# Worker\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo input",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  async handle(input) {
    return input;
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "traits", "echoer.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(agentpkgImportPath)};

export default defineTrait({
  name: "echoer",
  tools: {
    echo: { ref: "echo" },
  },
  require: { tools: ["echo"] },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { defineAgent } from ${JSON.stringify(agentpkgImportPath)};

export default defineAgent({
  name: "worker",
  description: "Worker",
  identity: "worker",
  traits: ["echoer"],
});
`,
  );

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: true,
      backup: false,
    }),
  );

  const failure = getFailure(exit);
  expect(failure._tag).toBe("AgentValidationError");
  if (failure._tag === "AgentValidationError") {
    expect(failure.field).toBe("tools");
    expect(failure.message).toContain("that plugin's targets.tools does not include 'opencode'");
  }
});

// ---------------------------------------------------------------------------
// Derived lifecycle skill rendering (AP-022)
// ---------------------------------------------------------------------------

test("derived lifecycle skill deduplicates traits and renders multi-agent phase sub-sections", async () => {
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

  // Multi-agent phase renders each agent as its own sub-section.
  expect(skill).toContain("### 3. Hand off work — agents `builder`, `reviewer`");
  expect(skill).toContain("Multiple agents may fulfil this phase");
  expect(skill).toContain("#### Agent `builder`");
  expect(skill).toContain("#### Agent `reviewer`");

  // Trait protocols section appears once and dedupes shared traits.
  const protocolsHeader = skill.match(/## Trait protocols active in this lifecycle/g);
  expect(protocolsHeader?.length).toBe(1);
  // self-assessing is shared by builder + reviewer + security-reviewer; render once.
  const selfAssessingHits = skill.match(/### `canonical-compile-fixture:self-assessing`/g);
  expect(selfAssessingHits?.length).toBe(1);
  const submittableHits = skill.match(/### `canonical-compile-fixture:submittable`/g);
  expect(submittableHits?.length).toBe(1);

  // Phase transitions and submission protocol sections are present.
  expect(skill).toContain("## Phase transitions");
  expect(skill).toContain("## Submission protocol per phase agent");
});

test("derived lifecycle skill deduplicates tools across orchestrator and phase grants", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  // Replace the lifecycle file with one that grants the SAME tool via the
  // orchestrator AND lifecycle-wide tool_permissions. The derived skill must
  // not double-render the tool.
  await writeText(
    join(pluginRoot, "lifecycles", "delivery-contract.lifecycle.ts"),
    `import { agentRef, defineLifecycle, traitRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineLifecycle({
  name: "delivery-contract",
  description: "Dedup tool variant",
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [{ all: [traitRef("committable"), traitRef("self-assessing")] }],
    },
    {
      name: "Review change",
      agents: [agentRef("reviewer")],
      requires: [{ all: [traitRef("reviewable"), traitRef("self-assessing")] }],
    },
  ],
  orchestrator: {
    agent: agentRef("builder"),
    tools: [{ ref: "protocol-core:create_item", as: "create_item_orch" }],
  },
  tool_permissions: [
    { ref: "protocol-core:create_item", as: "create_item_wide" },
  ],
});
`,
  );

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

  // Each grant gets its own logical name in its own section, but the canonical
  // tool ref appears in both sections — check both sections are listed.
  expect(skill).toContain("`create_item_orch` (canonical `protocol-core:create_item`)");
  expect(skill).toContain("`create_item_wide` (canonical `protocol-core:create_item`)");

  // Wide tool description should appear in the wide section once, not twice.
  const wideMatches = skill.match(/## Tools available to every phase agent/g);
  expect(wideMatches?.length).toBe(1);
});

test("derived lifecycle skill helper renders parametric stub when invoked on a template", async () => {
  // Direct unit-level invocation of renderDerivedLifecycleSkillBody to
  // exercise the parametric branch. We synthesize a minimal Lifecycle and
  // empty registry so the helper has to fall back gracefully.
  const { renderDerivedLifecycleSkillBody } = await import("./derived-lifecycle-skill.js");
  const { Lifecycle } = await import("./sources.js");
  const { emptyRegistry } = await import("./registry.js");

  const lifecycle = new Lifecycle({
    name: "demo-template",
    sourcePath: "/tmp/demo-template.lifecycle.ts",
    description: "A parametric template",
    parameters: [{ name: "audience", required: true }],
    phases: [],
    tool_permissions: [],
    taste_checkpoints: [],
    body: "",
  });
  const registry = emptyRegistry("/tmp", "demo", "0.0.0");

  const body = renderDerivedLifecycleSkillBody(lifecycle, registry);
  expect(body).toContain("# demo-template");
  expect(body).toContain("This lifecycle is parameterized");
});

test("derived lifecycle skill renders parametric stub for parameterized lifecycle templates", async () => {
  const { pluginRoot, projectRoot } = await createCanonicalLanguageFixture();

  await writeText(
    join(pluginRoot, "lifecycles", "parametric-template.lifecycle.ts"),
    `import { agentRef, defineLifecycle, traitRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineLifecycle({
  name: "parametric-template",
  description: "A parametric lifecycle template; remains uninstantiated.",
  parameters: [{ name: "audience" }],
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [{ all: [traitRef("committable"), traitRef("self-assessing")] }],
    },
  ],
});
`,
  );

  // Parameterized lifecycles do not lower; only their templates exist. The
  // helper still gracefully describes them when invoked. Build a quick
  // unit-style invocation by compiling and asserting the skill is NOT emitted.
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

  expect(
    await pathExists(
      join(projectRoot, ".opencode", "skills", "parametric-template", "SKILL.md"),
    ),
  ).toBe(false);
});
