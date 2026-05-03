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

const agentpkgImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "agentpkg-mcp-test-"));
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
  const pluginRoot = join(root, "sdlc");
  const projectRoot = join(root, "project");
  const lifecycleRoot = join(pluginRoot, "deps", "lifecycle-core");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "sdlc",
        version: "0.1.0",
        deps: {
          "lifecycle-core": "./deps/lifecycle-core",
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
    join(lifecycleRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "lifecycle-core",
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

Use lifecycle-core canonical tools through SDLC wrappers.
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
    join(lifecycleRoot, "tools", "create_item.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "create_item",
  description: "Create a lifecycle work item",
  input: Schema.Struct({
    lifecycle: Schema.Literal("sdlc", "rlc"),
    id: Schema.String,
    title: Schema.String,
  }),
  output: Schema.Struct({
    created: Schema.Boolean,
    lifecycle: Schema.Literal("sdlc", "rlc"),
    id: Schema.String,
  }),
  async handle(input, context) {
    return { created: true, lifecycle: input.lifecycle, id: input.id };
  },
});
`,
  );
  await writeText(
    join(lifecycleRoot, "tools", "submit_review.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool, schemaSlot } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "submit_review",
  description: "Submit lifecycle review findings",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
    verdict: Schema.Literal("approve", "request_changes"),
  }),
  slots: {
    details: schemaSlot({ description: "SDLC review details" }),
  },
  async handle(input, context) {
    return { acknowledged: true, verdict: input.details.verdict };
  },
});
`,
  );
  await writeText(
    join(pluginRoot, "traits", "work-item-writer.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(agentpkgImportPath)};

export default defineTrait({
  name: "work-item-writer",
  description: "Can create lifecycle work items",
  tools: {
    create_item: { ref: "lifecycle-core:create_item" },
  },
  require: { tools: ["create_item"] },
});
`,
  );
  await writeText(
    join(pluginRoot, "traits", "review-submitter.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(agentpkgImportPath)};

export default defineTrait({
  name: "review-submitter",
  description: "Can submit SDLC-specialized review findings",
  tools: {
    submit_review: { ref: "lifecycle-core:submit_review" },
  },
  require: { tools: ["submit_review"] },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "builder.agent.ts"),
    `import { bindTrait, defineAgent } from ${JSON.stringify(agentpkgImportPath)};
import { ReviewDetails } from "../schemas/review-details.ts";

export default defineAgent({
  name: "builder",
  description: "Builder with lifecycle-core tools",
  identity: "builder",
  traits: [
    bindTrait("work-item-writer"),
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

test("MCP bundle exposes only resolved lifecycle-core canonical and SDLC slot wrapper tools", async () => {
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
    sourcePluginName: "sdlc",
    serverName: "agentpkg-mcp-sdlc",
    bundleId: "sdlc",
    bindings: builder?.toolBindings ?? [],
  });

  expect(bundle.relativePath).toBe(mcpServerArtifactRelativePath("sdlc"));
  expect(bundle.toolNames).toEqual([
    "lifecycle_core_create_item",
    "sdlc_submit_review__review_details",
  ]);
  expect(bundle.content).toContain("tools/list");
  expect(bundle.content).toContain("tools/call");
  expect(bundle.content).toContain("lifecycle_core_create_item");
  expect(bundle.content).toContain("sdlc_submit_review__review_details");
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
      clientInfo: { name: "agentpkg-test", version: "0.1.0" },
    });
    expect(initialized.result.serverInfo.name).toBe("agentpkg-mcp-sdlc");

    const listed = await client.request("tools/list");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "lifecycle_core_create_item",
      "sdlc_submit_review__review_details",
    ]);

    const created = await client.request("tools/call", {
      name: "lifecycle_core_create_item",
      arguments: { lifecycle: "sdlc", id: "AP-999", title: "Compile MCP" },
    });
    expect(JSON.parse(created.result.content[0].text)).toEqual({
      created: true,
      lifecycle: "sdlc",
      id: "AP-999",
    });

    const reviewed = await client.request("tools/call", {
      name: "sdlc_submit_review__review_details",
      arguments: { summary: "Looks good", details: { verdict: "approve" } },
    });
    expect(JSON.parse(reviewed.result.content[0].text)).toEqual({
      acknowledged: true,
      verdict: "approve",
    });

    const invalid = await client.request("tools/call", {
      name: "sdlc_submit_review__review_details",
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
    sourcePluginName: "sdlc",
    serverName: "agentpkg-mcp-sdlc",
    bundleId: "sdlc",
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
      clientInfo: { name: "agentpkg-test", version: "0.1.0" },
    });
    expect(initialized.result.serverInfo.name).toBe("agentpkg-mcp-sdlc");

    const listed = await client.request("tools/list");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "lifecycle_core_create_item",
      "sdlc_submit_review__review_details",
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
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

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
      serverName: "agentpkg-mcp-schema-fixture",
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
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

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
      serverName: "agentpkg-mcp-schema-fixture",
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
      serverName: "agentpkg-mcp-collision-fixture",
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
