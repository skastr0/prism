#!/usr/bin/env bun

import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;
const distDir = "dist";
const binaryName = "agentpkg";

const targets = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
];

console.log("Cleaning dist directory...");
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

console.log(`\nBuilding ${binaryName} v${version}...\n`);

for (const { platform, arch } of targets) {
  const outfile = join(distDir, `${binaryName}-${platform}-${arch}`);

  console.log(`Building ${platform}-${arch}...`);

  try {
    const buildResult = await Bun.build({
      target: "bun",
      compile: {
        target: `bun-${platform}-${arch}`,
        outfile,
      },
      entrypoints: ["src/cli.ts"],
      define: {
        APP_VERSION: `'${version}'`,
        AGENTPKG_EFFECT_ENTRYPOINT: JSON.stringify(
          fileURLToPath(import.meta.resolve("effect")).replace(/\\/g, "/")
        ),
        SCHEMA_BRIDGE_SOURCE: JSON.stringify(
          readFileSync("src/compile/runtime/schema-bridge.ts", "utf8")
        ),
      },
      minify: true,
    });

    if (!buildResult.success) {
      console.error(`  ✗ Failed to build ${platform}-${arch}`);
      for (const log of buildResult.logs) {
        console.error(log);
      }
      continue;
    }

    await Bun.$`chmod +x ${outfile}`;
    console.log(`  ✓ ${outfile}`);
  } catch (error) {
    console.error(`  ✗ Error building ${platform}-${arch}:`, error);
  }
}

console.log(`
Build complete! Binaries in ${distDir}/

To install locally:
  bun run install:local
`);
