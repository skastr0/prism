import { afterEach, expect, test } from "bun:test";

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { compilePluginForTarget } from "./pipeline.js";
import { prismToolCatalogPath, prismToolRuntimePath } from "../tools-cli/paths.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-tools-cli-production-default-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const createOwnedToolFixture = async (options: {
  readonly target?: "antigravity-cli" | "codex-cli" | "kimi-code";
  readonly pluginName?: string;
} = {}): Promise<{
  readonly pluginRoot: string;
  readonly projectRoot: string;
}> => {
  const target = options.target ?? "codex-cli";
  const pluginName = options.pluginName ?? "cli-consumer";
  const root = await createTempRoot();
  const pluginRoot = join(root, "consumer");
  const projectRoot = join(root, "project");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: pluginName,
      version: "0.1.0",
      targets: { agents: [target], tools: [target] },
    }, null, 2)}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---\ndescription: Worker identity\n---\n\n# Worker\n\nUse the typed submission tool.\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "submit_work.tool.ts"),
    `import { Schema } from "effect";

export default {
  name: "submit_work",
  description: "Submit completed work through the CLI runtime",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle() { return { acknowledged: true }; },
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `export default {
  name: "worker",
  description: "CLI worker",
  identity: "worker",
};
`,
  );

  return { pluginRoot, projectRoot };
};

const withProductionToolDefaults = async <A>(run: () => Promise<A>): Promise<A> => {
  const previousMcp = process.env.PRISM_TOOLS_MCP_EMIT;
  const previousCli = process.env.PRISM_TOOLS_CLI_EMIT;
  const previousInject = process.env.PRISM_TOOLS_CLI_INJECT;
  delete process.env.PRISM_TOOLS_MCP_EMIT;
  delete process.env.PRISM_TOOLS_CLI_EMIT;
  delete process.env.PRISM_TOOLS_CLI_INJECT;
  try {
    return await run();
  } finally {
    if (previousMcp === undefined) delete process.env.PRISM_TOOLS_MCP_EMIT;
    else process.env.PRISM_TOOLS_MCP_EMIT = previousMcp;
    if (previousCli === undefined) delete process.env.PRISM_TOOLS_CLI_EMIT;
    else process.env.PRISM_TOOLS_CLI_EMIT = previousCli;
    if (previousInject === undefined) delete process.env.PRISM_TOOLS_CLI_INJECT;
    else process.env.PRISM_TOOLS_CLI_INJECT = previousInject;
  }
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Antigravity production defaults keep an assigned canonical tool discoverable via a bundle-local CLI skill", async () => {
  const pluginName = "antigravity_cli.consumer";
  const { pluginRoot, projectRoot } = await createOwnedToolFixture({
    target: "antigravity-cli",
    pluginName,
  });
  const prismHome = join(projectRoot, ".prism-home");

  await withProductionToolDefaults(async () => {
    const result = await Effect.runPromise(
      compilePluginForTarget({
        prismHome,
        pluginPath: pluginRoot,
        target: "antigravity-cli",
        scope: "project",
        projectPath: projectRoot,
        dryRun: false,
      }),
    );
    expect(result.failures).toEqual([]);

    const pluginRootOut = join(
      projectRoot,
      ".agents",
      "plugins",
      "prism-generated-antigravity-cli-consumer",
    );
    const skill = await readFile(
      join(pluginRootOut, "skills", `prism-tools-${pluginName}`, "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("`submit_work`");
    expect(skill).toContain(`prism tools invoke ${pluginName} submit_work`);

    const pointer = await readFile(
      join(pluginRootOut, "rules", `prism-tools-${pluginName}.md`),
      "utf8",
    );
    expect(pointer).toContain(`Load skill \`prism-tools-${pluginName}\``);
    const agent = await readFile(join(pluginRootOut, "agents", "worker.md"), "utf8");
    // Agents no longer carry per-agent tool grants; the plugin-level pointer
    // rule is the discovery surface.
    expect(agent).not.toContain("mcp_");
    expect(await pathExists(join(pluginRootOut, "mcp_config.json"))).toBe(false);
  });
});

test("Kimi production defaults keep an assigned canonical tool discoverable via a bundle-local CLI skill", async () => {
  const pluginName = "kimi-cli-consumer";
  const { pluginRoot, projectRoot } = await createOwnedToolFixture({
    target: "kimi-code",
    pluginName,
  });
  const prismHome = join(projectRoot, ".prism-home");
  const kimiRoot = join(projectRoot, ".kimi-code-test");

  await withProductionToolDefaults(async () => {
    const result = await Effect.runPromise(
      compilePluginForTarget({
        prismHome,
        pluginPath: pluginRoot,
        target: "kimi-code",
        scope: "global",
        root: kimiRoot,
        dryRun: false,
        emitWorkflowRefs: false,
      }),
    );
    expect(result.failures).toEqual([]);

    const pluginRootOut = join(
      kimiRoot,
      "plugins",
      "managed",
      `prism-generated-${pluginName}`,
    );
    const skill = await readFile(
      join(pluginRootOut, "skills", `prism-tools-${pluginName}`, "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("`submit_work`");
    expect(skill).toContain(`prism tools invoke ${pluginName} submit_work`);

    const role = await readFile(
      join(pluginRootOut, "skills", "prism-agent-worker", "SKILL.md"),
      "utf8",
    );
    expect(role).toContain("# worker");
    expect(role).not.toContain("Generated MCP tools for this role:");
    expect(role).not.toContain("mcp__");

    const manifest = JSON.parse(
      await readFile(join(pluginRootOut, "kimi.plugin.json"), "utf8"),
    ) as { readonly skills?: string; readonly mcpServers?: unknown };
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBeUndefined();
  });
});
