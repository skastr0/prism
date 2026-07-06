import { expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { compilePluginForTarget } from "./pipeline.js";
import { prismMcpServerPath } from "./mcp-runtime-path.js";
import { withPrismSandbox } from "../testing/prism-sandbox.js";
import type { HarnessId } from "../types.js";
import {
  getFreePort,
  httpRpc,
  roundTripCompiledBundle,
  socketPathForPort,
  waitForHttpServer,
  waitForChildClose,
} from "./test-helpers/mcp-http-roundtrip.js";

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const GENERATED_MCP_TARGETS: HarnessId[] = ["cursor", "hermes", "antigravity-cli"];
const MATRIX_TARGETS: HarnessId[] = ["opencode", ...GENERATED_MCP_TARGETS];

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
};

const createMatrixToolFixture = async (
  pluginRoot: string,
  targets: HarnessId[],
): Promise<void> => {
  await writeJson(join(pluginRoot, "plugin.json"), {
    name: "tool-matrix-demo",
    version: "0.1.0",
    targets: {
      tools: targets,
    },
  });

  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo a message",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: input.message };
  },
});
`,
  );
};

test(
  "generated canonical tool execution matrix",
  async () => {
    await withPrismSandbox(async (sandbox) => {
      const pluginRoot = join(sandbox.root, "plugins", "tool-matrix-demo");
      await createMatrixToolFixture(pluginRoot, MATRIX_TARGETS);

      for (const target of MATRIX_TARGETS) {
        await Effect.runPromise(
          compilePluginForTarget({
            prismHome: sandbox.prismHome,
            pluginPath: pluginRoot,
            target,
            scope: "global",
            root: sandbox.rootFor(target),
            dryRun: false,
          }),
        );
      }

      const serverPath = prismMcpServerPath(sandbox.prismHome, "tool-matrix-demo");

      for (const target of MATRIX_TARGETS) {
        const port = await getFreePort("127.0.0.1");
        const result = await roundTripCompiledBundle({
          serverPath,
          port,
          toolName: "tool_matrix_demo_echo",
          toolArgs: { message: `hello from ${target}` },
        });

        expect(result.toolNames).toContain("tool_matrix_demo_echo");
        expect(result.callResult.structuredContent).toEqual({
          message: `hello from ${target}`,
        });
      }
    });
  },
  { timeout: 120_000 },
);

test(
  "generated canonical tool returns typed JSON-RPC error for invalid input",
  async () => {
    await withPrismSandbox(async (sandbox) => {
      const pluginRoot = join(sandbox.root, "plugins", "tool-matrix-demo");
      await createMatrixToolFixture(pluginRoot, ["cursor"]);

      await Effect.runPromise(
        compilePluginForTarget({
          prismHome: sandbox.prismHome,
          pluginPath: pluginRoot,
          target: "cursor",
          scope: "global",
          root: sandbox.rootFor("cursor"),
          dryRun: false,
        }),
      );

      const serverPath = prismMcpServerPath(sandbox.prismHome, "tool-matrix-demo");
      const port = await getFreePort("127.0.0.1");
      const socketPath = await socketPathForPort(port);
      const child = spawn("bun", [serverPath], {
        cwd: sandbox.prismHome,
        env: {
          ...process.env,
          PRISM_MCP_UDS_PATH: socketPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;

      try {
        await waitForHttpServer(port);

        const init = await httpRpc({
          port,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "prism-invalid-input-test", version: "0.1.0" },
          },
        });
        expect(init.response.status).toBe(200);
        const sessionId = init.response.headers.get("mcp-session-id");
        expect(sessionId).not.toBeNull();

        const called = await httpRpc({
          port,
          sessionId: sessionId!,
          method: "tools/call",
          params: {
            name: "tool_matrix_demo_echo",
            arguments: {},
          },
        });

        const result = (called.body as { result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> } }).result;
        expect(result?.isError).toBe(true);
        const errorText = result?.content?.[0]?.text ?? "";
        expect(errorText).toContain("-32602");
        expect(errorText).toContain("Input validation error");
        expect(errorText).toContain("tool_matrix_demo_echo");
      } finally {
        child.kill("SIGTERM");
        await waitForChildClose(child).catch(() => undefined);
      }
    });
  },
  { timeout: 120_000 },
);

test(
  "cross-plugin owner/consumer canonical tool execution",
  async () => {
    await withPrismSandbox(async (sandbox) => {
      const ownerRoot = join(sandbox.root, "plugins", "owner-demo");
      const consumerRoot = join(sandbox.root, "plugins", "consumer-demo");

      // Owner plugin defines the canonical tool and targets a generated-MCP harness
      // so the PRISM_HOME runtime bundle is emitted.
      await writeJson(join(ownerRoot, "plugin.json"), {
        name: "owner-demo",
        version: "0.1.0",
        targets: {
          tools: ["cursor", "opencode"],
        },
      });

      await writeText(
        join(ownerRoot, "tools", "greet.tool.ts"),
        `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "greet",
  description: "Greet someone",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ greeting: Schema.String }),
  async handle(input) {
    return { greeting: \`Hello, \${input.name}!\` };
  },
});
`,
      );

      // Consumer plugin defines a trait that binds the owner tool and an agent
      // that conforms to the trait, targeting OpenCode.
      await writeJson(join(consumerRoot, "plugin.json"), {
        name: "consumer-demo",
        version: "0.1.0",
        deps: {
          "owner-demo": ownerRoot,
        },
        targets: {
          agents: ["opencode"],
        },
      });

      await writeText(
        join(consumerRoot, "identities", "worker.identity.md"),
        `---
description: Worker agent for cross-plugin tool execution tests
---

# Worker

A worker that greets through an owner-provided canonical tool.
`,
      );

      await writeText(
        join(consumerRoot, "traits", "greeter.trait.ts"),
        `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "greeter",
  description: "Can greet through the owner tool",
  tools: {
    greet: {
      ref: "owner-demo:greet",
    },
  },
  require: {
    tools: ["greet"],
  },
});
`,
      );

      await writeText(
        join(consumerRoot, "agents", "worker.agent.ts"),
        `import { bindTrait, defineAgent } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "worker",
  description: "Worker that greets via owner tool",
  identity: "worker",
  traits: [bindTrait("greeter")],
});
`,
      );

      await Effect.runPromise(
        compilePluginForTarget({
          prismHome: sandbox.prismHome,
          pluginPath: ownerRoot,
          target: "cursor",
          scope: "global",
          root: sandbox.rootFor("cursor"),
          dryRun: false,
        }),
      );

      await Effect.runPromise(
        compilePluginForTarget({
          prismHome: sandbox.prismHome,
          pluginPath: consumerRoot,
          target: "opencode",
          scope: "global",
          root: sandbox.rootFor("opencode"),
          dryRun: false,
        }),
      );

      const opencodeRoot = sandbox.rootFor("opencode");
      const opencodeConfig = JSON.parse(
        await readFile(join(opencodeRoot, "opencode.json"), "utf8"),
      ) as { plugin?: string[] };

      const ownerPluginEntry = pathToFileURL(
        join(opencodeRoot, "plugins", "prism-generated-owner-demo", "dist", "server.mjs"),
      ).href;
      expect(opencodeConfig.plugin ?? []).toContain(ownerPluginEntry);

      const serverPath = prismMcpServerPath(sandbox.prismHome, "owner-demo");
      const port = await getFreePort("127.0.0.1");
      const result = await roundTripCompiledBundle({
        serverPath,
        port,
        toolName: "owner_demo_greet",
        toolArgs: { name: "TS-010" },
      });

      expect(result.toolNames).toContain("owner_demo_greet");
      expect(result.callResult.structuredContent).toEqual({
        greeting: "Hello, TS-010!",
      });
    });
  },
  { timeout: 120_000 },
);
