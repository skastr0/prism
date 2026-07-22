import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/factory-droid.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

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
  const root = await mkdtemp(join(tmpdir(), "prism-factory-lowerer-"));
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
): DesiredFile | undefined =>
  files.find((file) => file.targetPath.endsWith(suffix));

const runGeneratedHookWrapper = (
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
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("factory-droid lowerer emits native plugin bundle surfaces", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".factory");
  const pluginRoot = join(root, "factory-plugin-fixture");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "factory-plugin-fixture",
        version: "0.4.0",
        targets: {
          skills: ["factory-droid"],
          toolspaces: ["factory-droid"],
          hooks: ["factory-droid"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    `---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n`,
  );

  await writeText(
    join(pluginRoot, "toolspaces", "workspace.toolspace.ts"),
    `
export default {
  name: "workspace",
  tools: { shell: { targets: { "factory-droid": { name: "Execute" } } } },
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "audit-shell.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-shell",
  description: "Audit shell commands",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "audit-echo.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-echo",
  description: "Audit canonical echo calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("echo") },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "session-ended.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-ended",
  description: "Observe session end",
  event: hookEvent.sessionEnd,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo",
  description: "Echo a message",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: input.message };
  },
};
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const shellHook = registry.hooks.get("audit-shell");
  const canonicalHook = registry.hooks.get("audit-echo");
  const sessionEndHook = registry.hooks.get("session-ended");
  if (!shellHook) throw new Error("expected audit-shell hook");
  if (!canonicalHook) throw new Error("expected audit-echo hook");
  if (!sessionEndHook) throw new Error("expected session-ended hook");

  const { files: operations } = await planLowering({
    agents: [
      {
        name: "reviewer",
        description: "Reviews through Factory plugin bundle",
        body: "# Reviewer\n\nUse the generated Factory plugin bundle.",
        color: undefined,
        model: { model: "gpt-5-codex", effort: "high" },
        targetOverride: {
          "factory-droid": {
            description: "Factory plugin reviewer",
            model: "inherit",
            tools: ["LS", "Read"],
            "allowed-tools": ["Grep"],
          },
        },
        skills: [],
        allowedSkills: ["testing"],
        allowedTools: ["Glob"],
        toolBindings: [
          {
            kind: "permission",
            logicalName: "echo",
            toolPluginName: "factory-plugin-fixture",
            toolName: "echo",
            toolSourcePath: toolPath,
          },
        ],
      },
    ],
    orbits: [],
    tools: [],
    skills: [...registry.skills.values()],
    hooks: [shellHook, canonicalHook, sessionEndHook],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "factory-plugin-fixture",
      sourcePluginVersion: "0.4.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const pluginManifest = findContentOperation(
    operations,
    join(".factory-plugin", "plugin.json"),
  );
  expect(pluginManifest?.targetPath).toContain(
    join(".factory", "plugins", "prism-generated-factory-plugin-fixture"),
  );
  expect(pluginManifest?.content).toContain('"name": "prism-generated-factory-plugin-fixture"');

  const droid = findContentOperation(operations, join("droids", "reviewer.md"));
  expect(droid?.targetPath).toContain(
    join(".factory", "plugins", "prism-generated-factory-plugin-fixture", "droids"),
  );
  expect(droid?.content).toContain('description: "Factory plugin reviewer"');
  expect(droid?.content).toContain('model: "inherit"');
  expect(droid?.content).toContain('reasoningEffort: "high"');
  expect(droid?.content).toContain("tools:");
  expect(droid?.content).toContain('- "LS"');
  expect(droid?.content).toContain('- "Glob"');
  expect(droid?.content).toContain('- "Grep"');
  expect(droid?.content).toContain('- "Read"');
  // Canonical tools are CLI-only; droid frontmatter keeps native tools only.
  expect(droid?.content).not.toContain("mcp__");
  expect(droid?.content).not.toContain("factory_plugin_fixture_echo");
  expect(droid?.content).not.toContain("skills:");

  const skill = findContentOperation(operations, join("skills", "testing", "SKILL.md"));
  expect(skill?.content).toContain("# Testing");

  // MCP config emission was excised — tools are CLI-only.
  expect(findContentOperation(operations, "mcp.json")).toBeUndefined();

  const bundle = operations.find(
    (operation) => operation.targetPath.endsWith("server.mjs"),
  );
  expect(bundle).toBeUndefined();

  const hookConfig = findContentOperation(operations, join("hooks", "hooks.json"));
  expect(hookConfig?.content).toContain('"PreToolUse"');
  expect(hookConfig?.content).toContain('"SessionEnd"');
  expect(hookConfig?.content).not.toContain('"hooks": {');
  expect(hookConfig?.content).toContain('"matcher": "Execute"');
  expect(hookConfig?.content).toContain(
    `"matcher": "factory_plugin_fixture_echo"`,
  );
  expect(hookConfig?.content).toContain('node \\"${DROID_PLUGIN_ROOT}/hooks/audit-shell.mjs\\"');

  const hookWrapper = findContentOperation(operations, join("hooks", "audit-shell.mjs"));
  expect(hookWrapper?.content).toContain('harness: "factory-droid"');
  expect(hookWrapper?.content).toContain('nativeEvent: "PreToolUse"');
  expect(hookWrapper?.content).toContain("tool_response");
  if (!hookWrapper) throw new Error("expected audit-shell wrapper");
  await writeText(hookWrapper.targetPath, hookWrapper.content);
  const blocked = await runGeneratedHookWrapper(hookWrapper.targetPath, {
    hook_event_name: "PreToolUse",
    tool_name: "Execute",
    tool_input: { block: true },
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: pluginRoot,
  });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stdout).toBe("");
  expect(blocked.stderr.trim()).toBe("blocked");
});

test("factory-droid lowerer preserves category-only tools mode", async () => {
  const root = await createTempRoot();
  const { files: operations } = await planLowering({
    agents: [
      {
        name: "reader",
        description: "Reads project context",
        body: "# Reader\n",
        color: undefined,
        model: {},
        targetOverride: { "factory-droid": { tools: "read-only" } },
        skills: [],
        allowedSkills: [],
        allowedTools: [],
        toolBindings: [],
      },
    ],
    orbits: [],
    tools: [],
    skills: [],
    hooks: [],
    target: {
      scope: "global",
      root,
      sourcePluginName: "factory-category-fixture",
      sourcePluginVersion: "0.1.0",
    },
  });

  const droid = findContentOperation(operations, join("droids", "reader.md"));
  expect(droid?.content).toContain('tools: "read-only"');
  expect(droid?.content).not.toContain("  - ");
});

test("factory-droid lowerer rejects unknown tools categories", async () => {
  const root = await createTempRoot();
  await expect(
    planLowering({
      agents: [
        {
          name: "broken",
          description: "Broken Factory tools",
          body: "# Broken\n",
          color: undefined,
          model: {},
          targetOverride: { "factory-droid": { tools: "everything" } },
          skills: [],
          allowedSkills: [],
          allowedTools: [],
          toolBindings: [],
        },
      ],
      orbits: [],
      tools: [],
      skills: [],
      hooks: [],
      target: {
        scope: "global",
        root,
        sourcePluginName: "factory-unknown-tools-fixture",
        sourcePluginVersion: "0.1.0",
      },
    }),
  ).rejects.toThrow("unknown Factory tools category");
});

test("factory-droid lowerer rejects mixed category and explicit tools", async () => {
  const root = await createTempRoot();
  await expect(
    planLowering({
      agents: [
        {
          name: "mixed",
          description: "Mixed Factory tools",
          body: "# Mixed\n",
          color: undefined,
          model: {},
          targetOverride: { "factory-droid": { tools: "read-only" } },
          skills: [],
          allowedSkills: [],
          allowedTools: ["Execute"],
          toolBindings: [],
        },
      ],
      orbits: [],
      tools: [],
      skills: [],
      hooks: [],
      target: {
        scope: "global",
        root,
        sourcePluginName: "factory-mixed-tools-fixture",
        sourcePluginVersion: "0.1.0",
      },
    }),
  ).rejects.toThrow("cannot combine tools category");
});
