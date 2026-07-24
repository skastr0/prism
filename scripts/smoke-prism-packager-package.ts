#!/usr/bin/env bun
/**
 * Pack + install + import smoke for @skastr0/prism-packager.
 * Mirrors scripts/smoke-prism-sdk-package.ts.
 */
import { mkdtemp, mkdir, rm, writeFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = resolve(import.meta.dir, "..");
const packageDir = join(repoRoot, "packages", "prism-packager");
const fixturePlugin = join(repoRoot, "examples", "my-standards");

const run = async (
  label: string,
  command: readonly string[],
  options?: { readonly cwd?: string; readonly capture?: boolean; readonly env?: Record<string, string> },
): Promise<string> => {
  console.log(`\n${label}`);
  const proc = Bun.spawn(command, {
    cwd: options?.cwd ?? repoRoot,
    stdout: options?.capture ? "pipe" : "inherit",
    stderr: "pipe",
    env: { ...process.env, ...options?.env },
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

const packPackage = async (tarballDir: string): Promise<string> => {
  // --ignore-scripts: prepack re-runs build and would pollute --json stdout.
  // Caller already built; publish workflow still runs prepack for safety.
  const stdout = await run(
    "Packing prism-packager",
    ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", tarballDir],
    { cwd: packageDir, capture: true },
  );
  const start = stdout.indexOf("[");
  if (start < 0) {
    throw new Error(`npm pack returned no JSON array: ${stdout.slice(0, 500)}`);
  }
  const parsed = JSON.parse(stdout.slice(start)) as Array<{ readonly filename: string }>;
  const filename = parsed[0]?.filename;
  if (!filename) {
    throw new Error("npm pack did not return a prism-packager tarball");
  }
  return join(tarballDir, filename);
};

// Build first so src/ is populated for pack.
await run("Building prism-packager", ["bun", "run", "build"], { cwd: packageDir });

if (!existsSync(join(packageDir, "src", "index.ts"))) {
  throw new Error("Missing packages/prism-packager/src/index.ts after build");
}
if (!existsSync(join(packageDir, "src", "packager.ts"))) {
  throw new Error("Missing packages/prism-packager/src/packager.ts after build");
}

// No workspace:* in published package.json
const pkgJson = JSON.parse(await Bun.file(join(packageDir, "package.json")).text()) as {
  dependencies?: Record<string, string>;
};
for (const [name, range] of Object.entries(pkgJson.dependencies ?? {})) {
  if (range.startsWith("workspace:")) {
    throw new Error(`Forbidden workspace:* dependency in prism-packager: ${name}@${range}`);
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), "prism-packager-smoke-"));

try {
  const tarballDir = join(tempRoot, "tarballs");
  const appRoot = join(tempRoot, "app");
  await mkdir(tarballDir, { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2) + "\n",
  );

  // Fixture plugin must be available inside the clean consumer project.
  const consumerPlugin = join(appRoot, "fixture-plugin");
  await cp(fixturePlugin, consumerPlugin, { recursive: true });

  const tarball = await packPackage(tarballDir);
  await run(
    "Installing packed prism-packager into clean project",
    ["bun", "add", tarball],
    { cwd: appRoot },
  );

  const consumerPath = join(appRoot, "consumer.ts");
  await writeFile(
    consumerPath,
    `
import {
  packagePluginForTarget,
  type DesiredFile,
  type PackageResult,
} from "@skastr0/prism-packager";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = await mkdtemp(join(tmpdir(), "packager-out-"));
const result: PackageResult = await packagePluginForTarget({
  pluginPath: "./fixture-plugin",
  target: "claude-code",
  dryRun: true,
  out,
  generatorVersion: "0.0.0-smoke",
});

if (!result.packageId.startsWith("prism-generated-")) {
  throw new Error(\`unexpected packageId: \${result.packageId}\`);
}
if (result.compileFiles.length === 0) {
  throw new Error("compileFiles empty — packager returned no payload");
}
const sample: DesiredFile | undefined = result.compileFiles[0];
if (!sample || typeof sample.targetPath !== "string" || typeof sample.content !== "string") {
  throw new Error("DesiredFile shape invalid");
}

const resolved = await import.meta.resolve("@skastr0/prism-packager");
if (!resolved.includes("node_modules/@skastr0/prism-packager")) {
  throw new Error(\`packager resolved outside packed install: \${resolved}\`);
}

console.log(JSON.stringify({
  packageId: result.packageId,
  files: result.compileFiles.length,
  regions: result.compileRegions.length,
}, null, 2));
`,
  );

  await run(
    "Importing packager + dry-run package from packed install",
    ["bun", "run", consumerPath],
    {
      cwd: appRoot,
      env: {
        PRISM_HOME: join(appRoot, ".prism-home"),
      },
    },
  );

  console.log("\nprism-packager package exports smoke passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
