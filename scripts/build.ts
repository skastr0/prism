#!/usr/bin/env bun

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compile, targetLabel, version, type Target } from "./compile.js";

const repoRoot = resolve(import.meta.dir, "..");
const distDir = join(repoRoot, "dist");
const binaryName = "prism";

const targets: readonly Target[] = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
];

console.log("Cleaning dist directory...");
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

console.log(`\nBuilding ${binaryName} v${version}...\n`);

const failedTargets: string[] = [];

for (const target of targets) {
  const label = targetLabel(target);
  const outfile = join(distDir, `${binaryName}-${label}`);

  console.log(`Building ${label}...`);
  try {
    await compile(target, outfile);
    console.log(`  ✓ ${outfile}`);
  } catch (error) {
    failedTargets.push(label);
    console.error(`  ✗ Error building ${label}`);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

if (failedTargets.length > 0) {
  console.error(`
Build failed for: ${failedTargets.join(", ")}

If OpenTUI native packages are missing for cross-target builds, run:
  bun install --cpu='*' --os='*'
`);
  process.exit(1);
}

console.log(`
Build complete! Binaries in ${distDir}/

To install a dev binary (does not touch production prism):
  bun run install:dev
`);
