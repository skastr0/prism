#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const skipBuild = process.argv.includes("--skip-build");

const platformPackageByTarget = {
  "darwin-arm64": "packages/npm/prism-darwin-arm64",
  "darwin-x64": "packages/npm/prism-darwin-x64",
  "linux-arm64": "packages/npm/prism-linux-arm64",
  "linux-x64": "packages/npm/prism-linux-x64",
} as const;

type SupportedTarget = keyof typeof platformPackageByTarget;

const currentTarget = (): SupportedTarget => {
  const target = `${process.platform}-${process.arch}`;
  if (target in platformPackageByTarget) {
    return target as SupportedTarget;
  }

  throw new Error(`Unsupported npm smoke platform: ${target}`);
};

const target = currentTarget();
const platformPackageDir = platformPackageByTarget[target];
const wrapperPackageDir = "packages/npm/prism";

const run = async (
  label: string,
  command: readonly string[],
  options?: { readonly cwd?: string; readonly capture?: boolean; readonly env?: Record<string, string> },
): Promise<string> => {
  console.log(`\n${label}`);
  const proc = Bun.spawn(command, {
    cwd: options?.cwd ?? repoRoot,
    env: { ...process.env, ...options?.env },
    stdout: options?.capture ? "pipe" : "inherit",
    stderr: "pipe",
  });
  const stdout = options?.capture ? await new Response(proc.stdout).text() : "";
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }

  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }

  return stdout;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const packPackage = async (packageDir: string, tarballDir: string): Promise<string> => {
  const stdout = await run(
    `Packing ${packageDir}`,
    ["npm", "pack", "--json", "--pack-destination", tarballDir],
    { cwd: join(repoRoot, packageDir), capture: true },
  );
  const parsed = JSON.parse(stdout) as Array<{ readonly filename: string }>;
  const filename = parsed[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not return a tarball for ${packageDir}`);
  }
  return join(tarballDir, filename);
};

const bufferIncludes = (buffer: Buffer, needle: string): boolean =>
  buffer.includes(Buffer.from(needle));

const assertNoForbiddenPaths = (label: string, buffer: Buffer, forbiddenPaths: readonly string[]): void => {
  const matched = forbiddenPaths.find((path) => bufferIncludes(buffer, path));
  if (matched) {
    throw new Error(`${label} contains build-machine path: ${matched}`);
  }
};

const walkFiles = async (root: string): Promise<string[]> => {
  const info = await stat(root);
  if (info.isFile()) return [root];
  if (!info.isDirectory()) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
};

const assertTreeDoesNotContainForbiddenPaths = async (
  root: string,
  forbiddenPaths: readonly string[],
): Promise<void> => {
  for (const file of await walkFiles(root)) {
    assertNoForbiddenPaths(file, await readFile(file), forbiddenPaths);
  }
};

const createCanonicalToolFixture = async (pluginRoot: string): Promise<void> => {
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "runtime-smoke",
        version: "0.1.0",
        targets: {
          tools: ["hermes"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from "effect";
import { defineTool } from "prism";

export default defineTool({
  name: "echo",
  description: "Echo a smoke-test message.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );
};

const createPoisonedRuntimeRoot = async (root: string): Promise<string> => {
  await writeText(join(root, "package.json"), `{"name":"poisoned-runtime","type":"module"}\n`);
  await writeText(
    join(root, "node_modules", "typescript", "package.json"),
    `{"name":"typescript","type":"commonjs","main":"lib/typescript.js"}\n`,
  );
  await writeText(
    join(root, "node_modules", "typescript", "lib", "typescript.js"),
    `throw new Error("poisoned runtime dependency root was used");\n`,
  );
  return root;
};

const main = async (): Promise<void> => {
  if (!skipBuild) {
    await run("Building npm CLI packages", ["bun", "run", "build:npm-cli"]);
  }

  const realRepoRoot = await realpath(repoRoot);
  const forbiddenPaths = [
    join(repoRoot, "node_modules").replace(/\\/g, "/"),
    join(realRepoRoot, "node_modules").replace(/\\/g, "/"),
  ];
  for (const binaryTarget of Object.keys(platformPackageByTarget)) {
    const binaryPath = join(repoRoot, "dist", `prism-${binaryTarget}`);
    assertNoForbiddenPaths(`dist/${basename(binaryPath)}`, await readFile(binaryPath), forbiddenPaths);
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "prism-npm-cli-smoke-"));
  let failed = true;

  try {
    const tarballDir = join(tempRoot, "tarballs");
    const appRoot = join(tempRoot, "app");
    const pluginRoot = join(tempRoot, "runtime-smoke-plugin");
    const hermesRoot = join(tempRoot, "hermes");
    const prismHome = join(tempRoot, "prism-home");
    const poisonedRuntimeRoot = await createPoisonedRuntimeRoot(join(tempRoot, "poisoned-runtime"));
    await mkdir(tarballDir, { recursive: true });
    await mkdir(appRoot, { recursive: true });
    await mkdir(hermesRoot, { recursive: true });
    await writeText(join(appRoot, "package.json"), `{"private":true,"type":"module"}\n`);
    await createCanonicalToolFixture(pluginRoot);

    const platformTarball = await packPackage(platformPackageDir, tarballDir);
    const wrapperTarball = await packPackage(wrapperPackageDir, tarballDir);

    await run(
      "Installing packed Prism CLI into clean project",
      [
        "npm",
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=optional",
        platformTarball,
        wrapperTarball,
      ],
      { cwd: appRoot },
    );

    const prismBin = join(appRoot, "node_modules", ".bin", "prism");
    await run(
      "Checking installed Prism CLI version with poisoned parent runtime env",
      ["node", prismBin, "--version"],
      {
        cwd: appRoot,
        env: {
          PRISM_RUNTIME_DEPS_PACKAGE_ROOT: poisonedRuntimeRoot,
        },
      },
    );
    await run(
      "Refreshing canonical tool fixture with installed Prism CLI",
      [
        "node",
        prismBin,
        "refresh",
        "--plugin",
        pluginRoot,
        "--harness",
        "hermes",
        "--compile-only",
        "--compile-root",
        hermesRoot,
        "--mcp-lifecycle",
        "none",
      ],
      {
        cwd: appRoot,
        env: {
          PRISM_HOME: prismHome,
        },
      },
    );

    await assertTreeDoesNotContainForbiddenPaths(hermesRoot, forbiddenPaths);
    failed = false;
    console.log("\nNpm CLI smoke passed.");
  } finally {
    if (failed) {
      console.error(`\nSmoke workspace preserved for inspection: ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
};

await main();
