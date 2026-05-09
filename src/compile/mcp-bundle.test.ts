import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { compilePluginForTarget } from "./pipeline.js";
import { generateMcpServerBundle, mcpServerArtifactRelativePath } from "./mcp-bundle.js";

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
  const root = await mkdtemp(join(tmpdir(), "prism-mcp-test-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const createSdlcMcpFixture = async (): Promise<{
  pluginRoot: string;
  projectRoot: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "forge");
  const projectRoot = join(root, "project");
  const orbitRoot = join(pluginRoot, "deps", "orbit-core");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "forge",
        version: "0.1.0",
        deps: {
          "orbit-core": "./deps/orbit-core",
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
    join(orbitRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "orbit-core",
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
    join(pluginRoot, "identities", "builder.identity.md"),
    `---
description: Builder identity
---

# Builder

Use orbit-core canonical tools through Forge wrappers.
`,
  );
  await writeText(
    join(pluginRoot, "schemas", "review-details.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export const ReviewDetails = Schema.Struct({
  verdict: Schema.Literal("approve", "request_changes"),
});
`,
  );
  await writeText(
    join(orbitRoot, "tools", "create_glyph.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "create_glyph",
  description: "Create an orbit glyph",
  input: Schema.Struct({
    orbit: Schema.Literal("forge", "survey"),
    id: Schema.String,
    title: Schema.String,
  }),
  output: Schema.Struct({
    created: Schema.Boolean,
    orbit: Schema.Literal("forge", "survey"),
    id: Schema.String,
  }),
  async handle(input, context) {
    return { created: true, orbit: input.orbit, id: input.id };
  },
});
`,
  );
  await writeText(
    join(orbitRoot, "tools", "submit_review.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool, schemaSlot } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "submit_review",
  description: "Submit orbit review findings",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
    verdict: Schema.Literal("approve", "request_changes"),
  }),
  slots: {
    details: schemaSlot({ description: "Forge review details" }),
  },
  async handle(input, context) {
    return { acknowledged: true, verdict: input.details.verdict };
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "traits", "glyph-writer.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "glyph-writer",
  description: "Can create orbit glyphs",
  tools: {
    create_glyph: { ref: "orbit-core:create_glyph" },
  },
  require: { tools: ["create_glyph"] },
});
`,
  );
  await writeText(
    join(pluginRoot, "traits", "review-submitter.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "review-submitter",
  description: "Can submit Forge-specialized review findings",
  tools: {
    submit_review: { ref: "orbit-core:submit_review" },
  },
  require: { tools: ["submit_review"] },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "builder.agent.ts"),
    `import { bindTrait, defineAgent } from ${JSON.stringify(prismImportPath)};
import { ReviewDetails } from "../schemas/review-details.ts";

export default defineAgent({
  name: "builder",
  description: "Builder with orbit-core tools",
  identity: "builder",
  traits: [
    bindTrait("glyph-writer"),
    bindTrait("review-submitter", {
      tools: {
        submit_review: {
          slots: { details: ReviewDetails },
        },
      },
    }),
  ],
});
`,
  );

  return { pluginRoot, projectRoot };
};

type RpcFraming = "content-length" | "newline";

const encodeRpc = (message: unknown, framing: RpcFraming = "content-length"): string => {
  const payload = JSON.stringify(message);
  if (framing === "newline") return `${payload}\n`;
  return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
};

class RpcClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly waiters: Array<(value: unknown) => void> = [];

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly framing: RpcFraming = "content-length",
  ) {
    child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.drain();
    });
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.child.stdin.write(encodeRpc({ jsonrpc: "2.0", id, method, params }, this.framing));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 5_000);
      this.waiters.push((value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
  }

  private drain(): void {
    while (true) {
      if (this.framing === "newline") {
        const newlineEnd = this.buffer.indexOf("\n");
        if (newlineEnd === -1) return;
        const line = this.buffer.subarray(0, newlineEnd).toString("utf8").trim();
        this.buffer = this.buffer.subarray(newlineEnd + 1);
        if (line.length === 0) continue;
        const waiter = this.waiters.shift();
        waiter?.(JSON.parse(line));
        continue;
      }

      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error(`missing Content-Length in response: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.byteLength < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      const waiter = this.waiters.shift();
      waiter?.(JSON.parse(body));
    }
  }
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("MCP bundle exposes only resolved orbit-core canonical and Forge slot wrapper tools", async () => {
  const { pluginRoot, projectRoot } = await createSdlcMcpFixture();
  const compile = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const builder = compile.composed.find((agent) => agent.name === "builder");
  expect(builder).toBeDefined();

  const bundle = await generateMcpServerBundle({
    sourcePluginName: "forge",
    serverName: "prism-mcp-forge",
    bundleId: "forge",
    bindings: builder?.toolBindings ?? [],
  });

  expect(bundle.relativePath).toBe(mcpServerArtifactRelativePath("forge"));
  expect(bundle.toolNames).toEqual([
    "forge_submit_review__review_details",
    "orbit_core_create_glyph",
  ]);
  expect(bundle.content).toContain("tools/list");
  expect(bundle.content).toContain("tools/call");
  expect(bundle.content).toContain("orbit_core_create_glyph");
  expect(bundle.content).toContain("forge_submit_review__review_details");
  expect(bundle.content).not.toContain("unreferenced");

  const serverPath = join(projectRoot, bundle.relativePath);
  await writeText(serverPath, bundle.content);

  const child = spawn("bun", [serverPath], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new RpcClient(child);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "prism-test", version: "0.1.0" },
    });
    expect(initialized.result.serverInfo.name).toBe("prism-mcp-forge");

    const listed = await client.request("tools/list");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "forge_submit_review__review_details",
      "orbit_core_create_glyph",
    ]);

    const created = await client.request("tools/call", {
      name: "orbit_core_create_glyph",
      arguments: { orbit: "forge", id: "AP-999", title: "Compile MCP" },
    });
    expect(JSON.parse(created.result.content[0].text)).toEqual({
      created: true,
      orbit: "forge",
      id: "AP-999",
    });

    const reviewed = await client.request("tools/call", {
      name: "forge_submit_review__review_details",
      arguments: { summary: "Looks good", details: { verdict: "approve" } },
    });
    expect(JSON.parse(reviewed.result.content[0].text)).toEqual({
      acknowledged: true,
      verdict: "approve",
    });

    const invalid = await client.request("tools/call", {
      name: "forge_submit_review__review_details",
      arguments: { summary: "Missing details" },
    });
    expect(invalid.result.isError).toBe(true);
    expect(invalid.result.content[0].text).toContain("details");
  } finally {
    child.kill();
  }
});

test("MCP bundle stdio accepts newline-delimited JSON-RPC", async () => {
  const { pluginRoot, projectRoot } = await createSdlcMcpFixture();
  const compile = await Effect.runPromise(
    compilePluginForTarget({
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
      backup: false,
    }),
  );

  const builder = compile.composed.find((agent) => agent.name === "builder");
  const bundle = await generateMcpServerBundle({
    sourcePluginName: "forge",
    serverName: "prism-mcp-forge",
    bundleId: "forge",
    bindings: builder?.toolBindings ?? [],
  });
  const serverPath = join(projectRoot, bundle.relativePath);
  await writeText(serverPath, bundle.content);

  const child = spawn("bun", [serverPath], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new RpcClient(child, "newline");
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "prism-test", version: "0.1.0" },
    });
    expect(initialized.result.serverInfo.name).toBe("prism-mcp-forge");

    const listed = await client.request("tools/list");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "forge_submit_review__review_details",
      "orbit_core_create_glyph",
    ]);
  } finally {
    child.kill();
  }
});

test("MCP bundle generation supports unknown object payload schemas", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "schema-fixture");
  const toolPath = join(pluginRoot, "tools", "inspect.tool.ts");
  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "inspect",
  description: "Accepts an arbitrary JSON object payload",
  input: Schema.Struct({
    payload: Schema.Unknown,
  }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  async handle() {
    return { ok: true };
  },
});
`,
  );

  await expect(
    generateMcpServerBundle({
      sourcePluginName: "schema-fixture",
      serverName: "prism-mcp-schema-fixture",
      bindings: [
        {
          kind: "permission",
          logicalName: "inspect",
          toolPluginName: "schema-fixture",
          toolName: "inspect",
          toolSourcePath: toolPath,
        },
      ],
    }),
  ).resolves.toMatchObject({ toolNames: ["schema_fixture_inspect"] });
});

test("MCP bundle generation fails closed when a tool input schema cannot become JSON Schema", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "schema-fixture");
  const toolPath = join(pluginRoot, "tools", "inspect.tool.ts");
  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "inspect",
  description: "Uses an intentionally unsupported MCP input schema",
  input: Schema.Struct({
    payload: Schema.BigIntFromSelf,
  }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  async handle() {
    return { ok: true };
  },
});
`,
  );

  await expect(
    generateMcpServerBundle({
      sourcePluginName: "schema-fixture",
      serverName: "prism-mcp-schema-fixture",
      bindings: [
        {
          kind: "permission",
          logicalName: "inspect",
          toolPluginName: "schema-fixture",
          toolName: "inspect",
          toolSourcePath: toolPath,
        },
      ],
    }),
  ).rejects.toThrow(/MCP tool 'schema_fixture_inspect'.*unsupported AST tag: BigIntKeyword/);
});

test("MCP bundle generation rejects non-identical tool-name collisions", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "collision-fixture");
  const firstToolPath = join(pluginRoot, "tools", "read-file.tool.ts");
  const secondToolPath = join(pluginRoot, "tools", "read_file.tool.ts");

  await writeText(firstToolPath, "export default {} as any;\n");
  await writeText(secondToolPath, "export default {} as any;\n");

  await expect(
    generateMcpServerBundle({
      sourcePluginName: "collision-fixture",
      serverName: "prism-mcp-collision-fixture",
      bindings: [
        {
          kind: "permission",
          logicalName: "dash",
          toolPluginName: "collision-fixture",
          toolName: "read-file",
          toolSourcePath: firstToolPath,
        },
        {
          kind: "permission",
          logicalName: "underscore",
          toolPluginName: "collision-fixture",
          toolName: "read_file",
          toolSourcePath: secondToolPath,
        },
      ],
    }),
  ).rejects.toThrow(
    /MCP tool name collision for 'collision_fixture_read_file'.*read-file.*read_file/,
  );
});
