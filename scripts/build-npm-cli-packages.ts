#!/usr/bin/env bun

import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const licensePath = join(repoRoot, "LICENSE");

const npmPackageDirs = [
  "packages/npm/prism",
  "packages/npm/prism-darwin-arm64",
  "packages/npm/prism-darwin-x64",
  "packages/npm/prism-linux-arm64",
  "packages/npm/prism-linux-x64",
] as const;

const platformPackages = [
  { target: "darwin-arm64", packageDir: "packages/npm/prism-darwin-arm64" },
  { target: "darwin-x64", packageDir: "packages/npm/prism-darwin-x64" },
  { target: "linux-arm64", packageDir: "packages/npm/prism-linux-arm64" },
  { target: "linux-x64", packageDir: "packages/npm/prism-linux-x64" },
] as const;

const run = async (label: string, command: ReadonlyArray<string>): Promise<void> => {
  console.log(`\n${label}`);
  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`${label} failed with exit code ${exitCode}`);
    process.exit(exitCode);
  }
};

await run("Building standalone Prism CLI binaries", ["bun", "run", "build:cli"]);

for (const packageDir of npmPackageDirs) {
  await copyFile(licensePath, join(repoRoot, packageDir, "LICENSE"));
}

for (const { target, packageDir } of platformPackages) {
  const source = join(repoRoot, "dist", `prism-${target}`);
  const binDir = join(repoRoot, packageDir, "bin");
  const destination = join(binDir, "prism");

  await mkdir(binDir, { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755);

  console.log(`Copied ${source} -> ${destination}`);
}
