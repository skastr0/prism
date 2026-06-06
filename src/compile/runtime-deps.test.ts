import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  effectBundleImportPath,
  mcpSdkMcpBundleImportPath,
  mcpSdkStdioBundleImportPath,
  mcpSdkWebStandardHttpBundleImportPath,
  opencodePluginBundleImportPath,
  typescriptBundleImportPath,
  zodV4BundleImportPath,
} from "./runtime-deps.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-runtime-deps-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const withRuntimeDepsRoot = async <A>(root: string, run: () => Promise<A>): Promise<A> => {
  const previous = process.env.PRISM_RUNTIME_DEPS_PACKAGE_ROOT;
  process.env.PRISM_RUNTIME_DEPS_PACKAGE_ROOT = root;

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.PRISM_RUNTIME_DEPS_PACKAGE_ROOT;
    } else {
      process.env.PRISM_RUNTIME_DEPS_PACKAGE_ROOT = previous;
    }
  }
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env.PRISM_RUNTIME_DEPS_PACKAGE_ROOT;
});

test("runtime dependency entrypoints resolve from the installed package root before source imports", async () => {
  const root = await createTempRoot();

  await writeText(join(root, "package.json"), `{"name":"prism-runtime","type":"module"}\n`);
  await writeText(
    join(root, "node_modules", "effect", "package.json"),
    `{"name":"effect","type":"module","main":"dist/esm/index.js"}\n`,
  );
  await writeText(join(root, "node_modules", "effect", "dist", "esm", "index.js"), "\n");
  await writeText(
    join(root, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
    `${JSON.stringify({
      name: "@modelcontextprotocol/sdk",
      type: "module",
      exports: {
        "./*": {
          import: "./dist/esm/*",
          require: "./dist/cjs/*",
        },
      },
    })}\n`,
  );
  await writeText(
    join(root, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "mcp.js"),
    "\n",
  );
  await writeText(
    join(root, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "stdio.js"),
    "\n",
  );
  await writeText(
    join(
      root,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "dist",
      "esm",
      "server",
      "webStandardStreamableHttp.js",
    ),
    "\n",
  );
  await writeText(
    join(root, "node_modules", "@opencode-ai", "plugin", "package.json"),
    `{"name":"@opencode-ai/plugin","type":"module","main":"dist/index.js"}\n`,
  );
  await writeText(join(root, "node_modules", "@opencode-ai", "plugin", "dist", "index.js"), "\n");
  await writeText(
    join(root, "node_modules", "typescript", "package.json"),
    `{"name":"typescript","type":"commonjs","main":"lib/typescript.js"}\n`,
  );
  await writeText(join(root, "node_modules", "typescript", "lib", "typescript.js"), "\n");
  await writeText(
    join(root, "node_modules", "zod", "package.json"),
    `{"name":"zod","type":"module"}\n`,
  );
  await writeText(join(root, "node_modules", "zod", "v4", "index.js"), "\n");

  await withRuntimeDepsRoot(root, async () => {
    const resolvedRoot = root;

    expect(effectBundleImportPath()).toBe(
      join(resolvedRoot, "node_modules", "effect", "dist", "esm", "index.js").replace(/\\/g, "/"),
    );
    expect(mcpSdkMcpBundleImportPath()).toBe(
      join(resolvedRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "mcp.js").replace(/\\/g, "/"),
    );
    expect(mcpSdkStdioBundleImportPath()).toBe(
      join(resolvedRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "stdio.js").replace(/\\/g, "/"),
    );
    expect(mcpSdkWebStandardHttpBundleImportPath()).toBe(
      join(
        resolvedRoot,
        "node_modules",
        "@modelcontextprotocol",
        "sdk",
        "dist",
        "esm",
        "server",
        "webStandardStreamableHttp.js",
      ).replace(/\\/g, "/"),
    );
    expect(opencodePluginBundleImportPath()).toBe(
      join(resolvedRoot, "node_modules", "@opencode-ai", "plugin", "dist", "index.js").replace(/\\/g, "/"),
    );
    expect(typescriptBundleImportPath()).toBe(
      join(resolvedRoot, "node_modules", "typescript", "lib", "typescript.js").replace(/\\/g, "/"),
    );
    expect(zodV4BundleImportPath()).toBe(
      join(resolvedRoot, "node_modules", "zod", "v4", "index.js").replace(/\\/g, "/"),
    );
  });
});

test("runtime dependency resolution rejects package exports that escape the package root", async () => {
  const root = await createTempRoot();
  const outside = join(root, "outside.js");

  await writeText(join(root, "package.json"), `{"name":"prism-runtime","type":"module"}\n`);
  await writeText(outside, "\n");
  await writeText(
    join(root, "node_modules", "effect", "package.json"),
    `${JSON.stringify({
      name: "effect",
      type: "module",
      exports: {
        ".": "../outside.js",
      },
    })}\n`,
  );

  await withRuntimeDepsRoot(root, async () => {
    expect(effectBundleImportPath()).not.toBe(outside.replace(/\\/g, "/"));
  });
});
