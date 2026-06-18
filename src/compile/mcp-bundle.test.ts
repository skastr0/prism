import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { compilePluginForTarget } from "./pipeline.js";
import { generateMcpServerBundle, mcpServerArtifactRelativePath } from "./mcp-bundle.js";
import { Contract } from "./sources.js";
import { resolvePrismHome } from "../prism-home.js";
import {
  getFreePort,
  httpRpc,
  waitForChildClose,
  waitForHttpServer,
} from "./test-helpers/mcp-http-roundtrip.js";

const tempRoots: string[] = [];
const originalPrismHome = process.env.PRISM_HOME;

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
  process.env.PRISM_HOME = join(root, "prism-home");
  return root;
};

/** The sandboxed PRISM_HOME for the current test root (set by createTempRoot). */
const testPrismHome = (): string => resolvePrismHome();

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
    delayMs: Schema.optional(Schema.Number),
    markerPath: Schema.optional(Schema.String),
  }),
  output: Schema.Struct({
    created: Schema.Boolean,
    orbit: Schema.Literal("forge", "survey"),
    id: Schema.String,
  }),
  async handle(input, context) {
    if (typeof input.delayMs === "number" && input.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, input.delayMs);
        const onAbort = () => {
          clearTimeout(timeout);
          reject(context.signal?.reason ?? new Error("aborted"));
        };
        if (context.signal?.aborted) {
          onAbort();
          return;
        }
        context.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (typeof input.markerPath === "string") {
      await Bun.write(input.markerPath, "completed\\n");
    }
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

const httpNotify = async (args: {
  readonly port: number;
  readonly sessionId: string;
  readonly method: string;
  readonly params?: unknown;
}): Promise<Response> => {
  return await fetch(`http://127.0.0.1:${args.port}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": args.sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: args.method,
      params: args.params,
    }),
  });
};

const httpDeleteSession = async (args: {
  readonly port: number;
  readonly sessionId: string;
}): Promise<Response> =>
  fetch(`http://127.0.0.1:${args.port}/mcp`, {
    method: "DELETE",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-session-id": args.sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
  });

afterEach(async () => {
  process.env.PRISM_HOME = originalPrismHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("MCP bundle exposes only resolved orbit-core canonical and Forge slot wrapper tools", async () => {
  const { pluginRoot, projectRoot } = await createSdlcMcpFixture();
  const compile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
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
  expect(bundle.content).toContain("PRISM_MCP_WORKING_DIRECTORY");
  expect(bundle.content).toContain("PRISM_MCP_REPO_ROOT");
  expect(bundle.content).toContain("PRISM_MCP_TOOL_TIMEOUT_MS");
  expect(bundle.content).not.toContain("unreferenced");

});

test("MCP bundle Streamable HTTP serves multiple sessions from one process", async () => {
  const { pluginRoot, projectRoot } = await createSdlcMcpFixture();
  const compile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const port = await getFreePort();
  const builder = compile.composed.find((agent) => agent.name === "builder");
  const bundle = await generateMcpServerBundle({
    sourcePluginName: "forge",
    serverName: "prism-mcp-forge",
    bundleId: "forge",
    bindings: builder?.toolBindings ?? [],
  });
  expect(bundle.content).toContain("Bun.serve");
  expect(bundle.content).toContain("PRISM_MCP_TOOL_TIMEOUT_MS");
  expect(bundle.content).toContain("PRISM_MCP_MAX_CONCURRENT_CALLS");
  expect(bundle.content).toContain("PRISM_MCP_MAX_SESSIONS");
  expect(bundle.content).toContain("PRISM_MCP_MAX_REQUEST_BYTES");
  expect(bundle.content).toContain("PRISM_MCP_SERVER_SHA256");
  expect(bundle.content).toContain("/healthz");

  const serverPath = join(projectRoot, bundle.relativePath);
  await writeText(serverPath, bundle.content);
  const child = spawn("bun", [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PRISM_MCP_HTTP_PORT: String(port),
      PRISM_MCP_SERVER_SHA256: "f".repeat(64),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForHttpServer(port);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`, {
      method: "GET",
      headers: {
      },
    });
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody).toMatchObject({
      schema: "prism.mcp-health.v1",
      serverName: "prism-mcp-forge",
      transport: "streamable-http",
      pid: child.pid,
      toolCount: 2,
      serverSha256: "f".repeat(64),
    });
    expect(typeof healthBody.startedAt).toBe("string");
    expect(Date.parse(healthBody.startedAt)).toBeGreaterThan(0);
    expect(typeof healthBody.uptimeMs).toBe("number");
    expect(healthBody.uptimeMs).toBeGreaterThanOrEqual(0);

    const forbiddenHost = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "evil.example",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "evil", version: "0.1.0" },
        },
      }),
    });
    expect(forbiddenHost.status).toBe(403);

    const forbidden = await httpRpc({
      port,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "evil", version: "0.1.0" } },
      origin: "http://evil.example",
    });
    expect(forbidden.response.status).toBe(403);

    const invalidProtocol = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "1900-01-01",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(invalidProtocol.status).toBe(400);

    const firstInit = await httpRpc({
      port,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "client-a", version: "0.1.0" } },
    });
    const firstSession = firstInit.response.headers.get("mcp-session-id");
    expect(firstInit.response.status).toBe(200);
    expect(firstSession).toBeTruthy();
    expect(firstInit.body.result.serverInfo.name).toBe("prism-mcp-forge");

    const secondInit = await httpRpc({
      port,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "client-b", version: "0.1.0" } },
    });
    const secondSession = secondInit.response.headers.get("mcp-session-id");
    expect(secondInit.response.status).toBe(200);
    expect(secondSession).toBeTruthy();
    expect(secondSession).not.toBe(firstSession);

    const missingSession = await httpRpc({ port, method: "tools/list" });
    expect(missingSession.response.status).toBe(400);

    const [firstList, secondList] = await Promise.all([
      httpRpc({ port, sessionId: firstSession!, method: "tools/list" }),
      httpRpc({ port, sessionId: secondSession!, method: "tools/list" }),
    ]);
    expect(firstList.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "forge_submit_review__review_details",
      "orbit_core_create_glyph",
    ]);
    expect(secondList.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "forge_submit_review__review_details",
      "orbit_core_create_glyph",
    ]);

    const calls = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        httpRpc({
          port,
          sessionId: index % 2 === 0 ? firstSession! : secondSession!,
          method: "tools/call",
          params: {
            name: "orbit_core_create_glyph",
            arguments: { orbit: "forge", id: `AP-${index}`, title: "HTTP MCP" },
          },
        }),
      ),
    );
    expect(calls.every((call) => call.response.status === 200)).toBe(true);
    expect(calls.map((call) => JSON.parse(call.body.result.content[0].text).id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `AP-${index}`),
    );

    const shutdown = await httpDeleteSession({
      port,
      sessionId: firstSession!,
    });
    expect([200, 202]).toContain(shutdown.status);
    const firstAfterShutdown = await httpRpc({
      port,
      sessionId: firstSession!,
      method: "tools/list",
    });
    expect(firstAfterShutdown.response.status).toBe(404);

    const exit = await httpDeleteSession({
      port,
      sessionId: secondSession!,
    });
    expect([200, 202]).toContain(exit.status);
    const secondAfterExit = await httpRpc({
      port,
      sessionId: secondSession!,
      method: "tools/list",
    });
    expect(secondAfterExit.response.status).toBe(404);
    expect(child.killed).toBe(false);
  } finally {
    child.kill();
    await waitForChildClose(child).catch(() => undefined);
  }
});

test("MCP bundle Streamable HTTP works with the official SDK client", async () => {
  const { pluginRoot, projectRoot } = await createSdlcMcpFixture();
  const port = await getFreePort();
  const compile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  const builder = compile.composed.find((agent) => agent.name === "builder");
  if (!builder) throw new Error("builder agent was not composed");
  const bundle = await generateMcpServerBundle({
    sourcePluginName: "forge",
    sourcePluginRoot: pluginRoot,
    serverName: "prism-mcp-forge",
    bundleId: "forge",
    bindings: builder.toolBindings,
  });
  const serverPath = join(projectRoot, bundle.relativePath);
  await writeText(serverPath, bundle.content);

  const child = spawn("bun", [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PRISM_MCP_HTTP_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: {},
  });
  const client = new Client({ name: "prism-sdk-test", version: "0.1.0" });

  try {
    await waitForHttpServer(port);
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("orbit_core_create_glyph");

    const called = await client.callTool({
      name: "orbit_core_create_glyph",
      arguments: {
        orbit: "forge",
        id: "SDK-1",
        title: "SDK smoke",
        extra: "ignored by Effect decoder",
      },
    });
    expect(called.structuredContent).toEqual({ created: true, orbit: "forge", id: "SDK-1" });
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
    child.kill("SIGTERM");
    await waitForChildClose(child);
  }
});

test("MCP bundle tool schemas emit enum instead of const for string literals", async () => {
  const { pluginRoot, projectRoot } = await createSdlcMcpFixture();
  const compile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  const builder = compile.composed.find((agent) => agent.name === "builder");
  if (!builder) throw new Error("builder agent was not composed");
  const bundle = await generateMcpServerBundle({
    sourcePluginName: "forge",
    sourcePluginRoot: pluginRoot,
    serverName: "prism-mcp-forge",
    bundleId: "forge",
    bindings: builder.toolBindings,
  });
  const serverPath = join(projectRoot, bundle.relativePath);
  await writeText(serverPath, bundle.content);

  const port = await getFreePort();
  const child = spawn("bun", [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PRISM_MCP_HTTP_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForHttpServer(port);
    const init = await httpRpc({ port, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "schema-test", version: "0.1.0" } } });
    expect(init.response.status).toBe(200);
    const sessionId = init.response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const listed = await httpRpc({ port, sessionId: sessionId!, method: "tools/list" });
    expect(listed.response.status).toBe(200);
    const schemas = JSON.stringify(listed.body.result.tools.map((tool: { inputSchema?: unknown }) => tool.inputSchema));
    // Kimi and some other MCP clients reject JSON Schema "const" and report
    // "must be equal to constant". Prism emits "enum": [value] instead.
    expect(schemas).not.toContain('"const":');
    expect(schemas).toContain('"enum":');
  } finally {
    child.kill("SIGTERM");
    await waitForChildClose(child).catch(() => undefined);
  }
});

test("MCP bundle Streamable HTTP rejects tool calls over concurrency limit", async () => {
  const { pluginRoot, projectRoot } = await createSdlcMcpFixture();
  const compile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const port = await getFreePort();
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
    env: {
      ...process.env,
      PRISM_MCP_HTTP_PORT: String(port),
      PRISM_MCP_MAX_CONCURRENT_CALLS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForHttpServer(port);
    const initialized = await httpRpc({
      port,
      origin: "http://127.0.0.1:12345",
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "client-a", version: "0.1.0" } },
    });
    const sessionId = initialized.response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(initialized.response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:12345");
    expect(initialized.response.headers.get("access-control-expose-headers")).toContain("mcp-session-id");
    const secondInitialized = await httpRpc({
      port,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "client-b", version: "0.1.0" } },
    });
    const secondSessionId = secondInitialized.response.headers.get("mcp-session-id");
    expect(secondSessionId).toBeTruthy();

    const calls = await Promise.all(
      [0, 1].map((index) =>
        httpRpc({
          port,
          sessionId: index === 0 ? sessionId! : secondSessionId!,
          method: "tools/call",
          params: {
            name: "orbit_core_create_glyph",
            arguments: { orbit: "forge", id: `AP-${index}`, title: "HTTP MCP", delayMs: 200 },
          },
        }),
      ),
    );
    const results = calls.map((call) => call.body.result);
    expect(results.filter((result) => result.isError).length).toBe(1);
    expect(results.filter((result) => !result.isError).length).toBe(1);
    expect(
      results.find((result) => result.isError)?.content[0].text,
    ).toContain("already running");
  } finally {
    child.kill();
    await waitForChildClose(child).catch(() => undefined);
  }
});

test("MCP bundle Streamable HTTP releases concurrency slot when timed-out work is aborted", async () => {
  const { pluginRoot, projectRoot } = await createSdlcMcpFixture();
  const compile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const port = await getFreePort();
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
    env: {
      ...process.env,
      PRISM_MCP_HTTP_PORT: String(port),
      PRISM_MCP_MAX_CONCURRENT_CALLS: "1",
      PRISM_MCP_TOOL_TIMEOUT_MS: "50",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForHttpServer(port);
    const initialized = await httpRpc({
      port,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "client-a", version: "0.1.0" } },
    });
    const sessionId = initialized.response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const markerPath = join(projectRoot, "timeout-marker.txt");

    const timedOut = await httpRpc({
      port,
      sessionId: sessionId!,
      method: "tools/call",
      params: {
        name: "orbit_core_create_glyph",
        arguments: {
          orbit: "forge",
          id: "AP-timeout",
          title: "HTTP MCP",
          delayMs: 200,
          markerPath,
        },
      },
    });
    expect(timedOut.body.result.isError).toBe(true);
    expect(timedOut.body.result.content[0].text).toContain("timed out");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await pathExists(markerPath)).toBe(false);

    const afterTimedOut = await httpRpc({
      port,
      sessionId: sessionId!,
      method: "tools/call",
      params: {
        name: "orbit_core_create_glyph",
        arguments: { orbit: "forge", id: "AP-after-timeout", title: "HTTP MCP" },
      },
    });
    expect(JSON.parse(afterTimedOut.body.result.content[0].text).id).toBe("AP-after-timeout");
  } finally {
    child.kill();
    await waitForChildClose(child).catch(() => undefined);
  }
});

test("MCP bundle Streamable HTTP enforces session and request-size caps", async () => {
  const { pluginRoot, projectRoot } = await createSdlcMcpFixture();
  const compile = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: testPrismHome(),
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const port = await getFreePort();
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
    env: {
      ...process.env,
      PRISM_MCP_HTTP_PORT: String(port),
      PRISM_MCP_MAX_SESSIONS: "1",
      PRISM_MCP_MAX_REQUEST_BYTES: "512",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForHttpServer(port);
    const initializations = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        httpRpc({
          port,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: `client-${index}`, version: "0.1.0" },
          },
        }),
      ),
    );
    expect(initializations.filter((init) => init.response.status === 200)).toHaveLength(1);
    expect(initializations.filter((init) => init.response.status === 429)).toHaveLength(5);

    const oversized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { payload: "x".repeat(1024) },
      }),
    });
    expect(oversized.status).toBe(400);
  } finally {
    child.kill();
    await waitForChildClose(child).catch(() => undefined);
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

test("MCP bundle generation supports refined object output schemas", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "schema-fixture");
  const toolPath = join(pluginRoot, "tools", "inspect.tool.ts");
  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "inspect",
  description: "Returns a refined object output",
  input: Schema.Struct({ payload: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }).pipe(
    Schema.filter((value) => value.ok === true),
  ),
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

test("MCP bundle validates tool output at runtime", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "schema-fixture");
  const projectRoot = join(root, "project");
  const toolPath = join(pluginRoot, "tools", "inspect.tool.ts");
  await mkdir(projectRoot, { recursive: true });
  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "inspect",
  description: "Returns an invalid output payload",
  input: Schema.Struct({ payload: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  async handle() {
    return { ok: "not-a-boolean" };
  },
});
`,
  );

  const bundle = await generateMcpServerBundle({
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
  });
  const serverPath = join(projectRoot, bundle.relativePath);
  await writeText(serverPath, bundle.content);

  const port = await getFreePort();
  const child = spawn("bun", [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PRISM_MCP_HTTP_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await waitForHttpServer(port);
    const initialized = await httpRpc({
      port,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "prism-test", version: "0.1.0" },
      },
    });
    const sessionId = initialized.response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const invalid = await httpRpc({
      port,
      sessionId: sessionId!,
      method: "tools/call",
      params: {
        name: "schema_fixture_inspect",
        arguments: { payload: "demo" },
      },
    });
    expect(invalid.body.result.isError).toBe(true);
    expect(invalid.body.result.content[0].text).toContain("ok");
  } finally {
    child.kill();
    await waitForChildClose(child).catch(() => undefined);
  }
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

test("MCP bundle generation rejects generated contract mirror collisions", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "mirror-demo");
  const sourcePath = join(pluginRoot, "traits", "review.trait.ts");
  const toolPath = join(pluginRoot, "tools", "submit.tool.ts");
  const generatedPath = "contracts/submit.contract.ts";
  const firstContract = new Contract({
    name: "submit-a",
    sourcePath,
    pluginName: "mirror-demo",
    generatedFiles: [
      { relativePath: generatedPath, content: "export const value = 1;\n" },
    ],
  });
  const secondContract = new Contract({
    name: "submit-b",
    sourcePath,
    pluginName: "mirror-demo",
    generatedFiles: [
      { relativePath: generatedPath, content: "export const value = 2;\n" },
    ],
  });

  await expect(
    generateMcpServerBundle({
      sourcePluginName: "mirror-demo",
      sourcePluginRoot: pluginRoot,
      serverName: "prism-mcp-mirror-demo",
      bindings: [
        {
          kind: "synthetic",
          logicalName: "submitA",
          contract: firstContract,
          toolPluginName: "mirror-demo",
          toolName: "submit-a",
          toolSourcePath: toolPath,
        },
        {
          kind: "synthetic",
          logicalName: "submitB",
          contract: secondContract,
          toolPluginName: "mirror-demo",
          toolName: "submit-b",
          toolSourcePath: toolPath,
        },
      ],
    }),
  ).rejects.toThrow(
    "generated contract name collision at mirror-demo:contracts/submit.contract.ts",
  );
});

test("MCP bundle generation uses sourcePluginRoot for source-owned synthetic contracts", async () => {
  const root = await createTempRoot();
  const hostRoot = join(root, "host");
  const dependencyRoot = join(root, "dependency");
  const contract = new Contract({
    name: "submit",
    sourcePath: join(dependencyRoot, "traits", "review.trait.ts"),
    pluginName: "host",
    generatedFiles: [
      {
        relativePath: "contracts/submit.contract.ts",
        content: `import { Schema } from ${JSON.stringify(effectImportPath)};
import { Details } from "../schemas/details.ts";

export const description = "Submit a source-owned synthetic contract";
export const input = Schema.Struct({ details: Details });
export const output = Schema.Struct({ ok: Schema.Boolean });
export async function handle() {
  return { ok: true };
}
`,
      },
    ],
  });

  await writeText(
    join(hostRoot, "schemas", "details.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export const Details = Schema.Struct({
  verdict: Schema.Literal("approve"),
});
`,
  );
  await writeText(
    join(dependencyRoot, "tools", "submit.tool.ts"),
    "export default {};\n",
  );

  const bundle = await generateMcpServerBundle({
    sourcePluginName: "host",
    sourcePluginRoot: hostRoot,
    serverName: "prism-mcp-host",
    bindings: [
      {
        kind: "synthetic",
        logicalName: "submit",
        contract,
        toolPluginName: "dependency",
        toolName: "submit",
        toolSourcePath: join(dependencyRoot, "tools", "submit.tool.ts"),
      },
    ],
  });

  expect(bundle.toolNames).toEqual(["host_submit"]);
});
