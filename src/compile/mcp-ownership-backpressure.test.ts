import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../fs.js";

const tempRoots: string[] = [];

const prismDevCommand = ["bun", "run", "dev", "--"];

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
  const root = await mkdtemp(join(tmpdir(), "prism-mcp-backpressure-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
};

const runPrismDev = async (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([...prismDevCommand, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("prism-dev compile keeps MCP runtime dirs owner-only", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const codexRoot = join(root, "codex-root");
  const depRoot = join(root, "tower-tools");
  const consumerRoot = join(root, "orbit-consumer");
  await mkdir(codexRoot, { recursive: true });

  await writeText(
    join(depRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "tower-tools",
        version: "0.1.0",
        targets: { tools: ["codex-cli"] },

      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(depRoot, "tools", "claim_glyph.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "claim_glyph",
  description: "Claim a glyph",
  input: Schema.Struct({ glyphId: Schema.String }),
  output: Schema.Struct({ claimed: Schema.Boolean }),
  async handle() { return { claimed: true }; },
});
`,
  );

  await writeText(
    join(consumerRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "orbit-consumer",
        version: "0.1.0",
        deps: { "tower-tools": "../tower-tools" },
        targets: { agents: ["codex-cli"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(consumerRoot, "identities", "orchestrator.identity.md"),
    `---\ndescription: Orchestrator\n---\n\n# Orchestrator\n`,
  );
  await writeText(
    join(consumerRoot, "traits", "tower-capable.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "tower-capable",
  description: "Can use tower tools",
  tools: { claim_glyph: { ref: "tower-tools:claim_glyph" } },
});
`,
  );
  await writeText(
    join(consumerRoot, "agents", "orchestrator.agent.ts"),
    `import { bindTrait, defineAgent } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "orchestrator",
  description: "Consumes tower tools",
  identity: "orchestrator",
  traits: [bindTrait("tower-capable")],
});
`,
  );

  const env = {
    PRISM_HOME: prismHome,
  };

  const consumer = await runPrismDev(
    [
      "refresh",
      consumerRoot,
      "--harness",
      "codex-cli",
      "--scope",
      "global",
      "--compile-root",
      codexRoot,
      "--compile-only",
      "--mcp-lifecycle",
      "none",
    ],
    env,
  );
  if (consumer.exitCode !== 0) {
    throw new Error(`consumer refresh failed:\n${consumer.stdout}\n${consumer.stderr}`);
  }


  const runtimeRoot = join(prismHome, "runtime", "mcp");
  const runtimeDirs = (await exists(runtimeRoot))
    ? (await readdir(runtimeRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

  expect(runtimeDirs).not.toContain("orbit-consumer");
});