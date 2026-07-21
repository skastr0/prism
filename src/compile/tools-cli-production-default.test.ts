import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { prismMcpServerPath } from "./mcp-runtime-path.js";
import { compilePluginForTarget } from "./pipeline.js";
import { prismToolCatalogPath } from "../tools-cli/paths.js";
import { runDoctor } from "../doctor.js";

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

const createSyntheticOnlyFixture = async (options: {
  readonly target?: "antigravity-cli" | "codex-cli" | "kimi-code";
  readonly pluginName?: string;
} = {}): Promise<{
  readonly pluginRoot: string;
  readonly projectRoot: string;
}> => {
  const target = options.target ?? "codex-cli";
  const pluginName = options.pluginName ?? "synthetic-cli-consumer";
  const root = await createTempRoot();
  const pluginRoot = join(root, "consumer");
  const projectRoot = join(root, "project");
  const protocolRoot = join(pluginRoot, "deps", "protocol-core");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({
      name: pluginName,
      version: "0.1.0",
      deps: { "protocol-core": "./deps/protocol-core" },
      targets: { agents: [target] },
    }, null, 2)}\n`,
  );
  await writeText(
    join(protocolRoot, "plugin.json"),
    `${JSON.stringify({
      name: "protocol-core",
      version: "0.1.0",
      targets: { tools: [target] },
    }, null, 2)}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---\ndescription: Worker identity\n---\n\n# Worker\n\nUse the typed protocol wrapper.\n`,
  );
  await writeText(
    join(pluginRoot, "schemas", "worker-details.ts"),
    `import { Schema } from "effect";\n\nexport const WorkerDetails = Schema.Struct({ confidence: Schema.Literal("low", "high") });\n`,
  );
  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `export default {
  name: "submittable",
  description: "Can submit through a typed wrapper",
  tools: { submit_work: { ref: "protocol-core:external-submit" } },
  require: { tools: ["submit_work"] },
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import { bindTrait } from "prism";
import { WorkerDetails } from "../schemas/worker-details.ts";

export default {
  name: "worker",
  description: "Synthetic-only CLI worker",
  identity: "worker",
  traits: [bindTrait("submittable", {
    tools: { submit_work: { slots: { details: WorkerDetails } } },
  })],
};
`,
  );
  await writeText(
    join(protocolRoot, "tools", "external-submit.tool.ts"),
    `import { Schema } from "effect";
import { schemaSlot } from "prism";

export default {
  name: "external-submit",
  description: "Submit through the protocol core",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  slots: { details: schemaSlot({ description: "Consumer details" }) },
  async handle() { return { acknowledged: true }; },
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

test("production defaults inject a CLI skill for a synthetic-only tool owner without MCP config", async () => {
  const { pluginRoot, projectRoot } = await createSyntheticOnlyFixture();
  const prismHome = join(projectRoot, ".prism-home");
  await withProductionToolDefaults(async () => {
    const result = await Effect.runPromise(
      compilePluginForTarget({
        prismHome,
        pluginPath: pluginRoot,
        target: "codex-cli",
        scope: "project",
        projectPath: projectRoot,
        dryRun: false,
      }),
    );
    expect(result.failures).toEqual([]);

    const catalog = JSON.parse(
      await readFile(
        prismToolCatalogPath(prismHome, "synthetic-cli-consumer"),
        "utf8",
      ),
    ) as { readonly tools?: ReadonlyArray<{ readonly name?: string }> };
    expect(catalog.tools?.map((tool) => tool.name)).toEqual(["submit_work"]);

    const skillPath = join(
      projectRoot,
      ".codex",
      "skills",
      "prism-tools-synthetic-cli-consumer",
      "SKILL.md",
    );
    const skill = await readFile(skillPath, "utf8");
    expect(skill).toContain("prism tools invoke synthetic-cli-consumer submit_work");

    const rules = await readFile(join(projectRoot, ".codex", "AGENTS.md"), "utf8");
    expect(rules).toContain("Load skill `prism-tools-synthetic-cli-consumer`");
    expect(rules).toContain("`submit_work`");
    const bundlePath = prismMcpServerPath(prismHome, "synthetic-cli-consumer");
    expect(await pathExists(bundlePath)).toBe(true);
    expect(await pathExists(join(projectRoot, ".codex", "config.toml"))).toBe(false);

    await rm(bundlePath);
    const doctor = await runDoctor({
      pluginPath: pluginRoot,
      harnesses: ["codex-cli"],
      scope: "project",
      projectPath: projectRoot,
      prismHome,
      fix: false,
    });
    expect(
      doctor.findings
        .filter((finding) => finding.family === "mcp.health")
        .map((finding) => finding.code),
    ).toEqual(["mcp.missing-bundle"]);
  });
});

test("Antigravity production defaults keep an assigned canonical tool discoverable via a bundle-local CLI skill", async () => {
  const pluginName = "antigravity_cli.consumer";
  const { pluginRoot, projectRoot } = await createSyntheticOnlyFixture({
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
    expect(agent).toContain(`Load skill \`prism-tools-${pluginName}\``);
    expect(agent).toContain(`prism tools invoke ${pluginName} <tool-name>`);
    expect(agent).not.toContain("mcp_");
    expect(await pathExists(join(pluginRootOut, "mcp_config.json"))).toBe(false);
  });
});

test("Kimi production defaults keep an assigned canonical tool discoverable via a bundle-local CLI skill", async () => {
  const pluginName = "kimi-cli-consumer";
  const { pluginRoot, projectRoot } = await createSyntheticOnlyFixture({
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
    expect(role).toContain(`Load skill \`prism-tools-${pluginName}\``);
    expect(role).toContain(`prism tools invoke ${pluginName} <tool-name>`);
    expect(role).not.toContain("Generated MCP tools for this role:");
    expect(role).not.toContain("mcp__");

    const manifest = JSON.parse(
      await readFile(join(pluginRootOut, "kimi.plugin.json"), "utf8"),
    ) as { readonly skills?: string; readonly mcpServers?: unknown };
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBeUndefined();
  });
});
