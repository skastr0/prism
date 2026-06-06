#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = packageJson.version;
const distDir = join(repoRoot, "dist");
const binaryName = "prism";

const targets = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
];

console.log("Cleaning dist directory...");
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

console.log(`\nBuilding ${binaryName} v${version}...\n`);

for (const { platform, arch } of targets) {
  const target = `${platform}-${arch}`;
  const outfile = join(distDir, `${binaryName}-${target}`);

  console.log(`Building ${target}...`);

  try {
    const buildResult = await Bun.build({
      target: "bun",
      compile: {
        target: `bun-${platform}-${arch}`,
        outfile,
      },
      entrypoints: [join(repoRoot, "src", "cli.ts")],
      define: {
        APP_VERSION: `'${version}'`,
        SCHEMA_BRIDGE_SOURCE: JSON.stringify(
          readFileSync(join(repoRoot, "src", "compile", "runtime", "schema-bridge.ts"), "utf8")
        ),
      },
      minify: true,
    });

    if (!buildResult.success) {
      console.error(`  ✗ Failed to build ${target}`);
      for (const log of buildResult.logs) {
        console.error(log);
      }
      process.exit(1);
    }

    await Bun.$`chmod +x ${outfile}`;
    console.log(`  ✓ ${outfile}`);
  } catch (error) {
    console.error(`  ✗ Error building ${target}`);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}

console.log(`
Build complete! Binaries in ${distDir}/

To install locally:
  bun run install:local
`);
