#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const distDir = "dist";

console.log("Cleaning dist directory...");
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

console.log("Building with Bun bundler...");

const buildResult = spawnSync(
  "bun",
  [
    "build",
    "--target=node",
    "--outdir=dist",
    "--sourcemap",
    "src/cli.ts",
  ],
  { stdio: "inherit" },
);

if (buildResult.status !== 0) {
  console.error("Build failed");
  process.exit(1);
}

// Add shebang to the CLI output
const cliPath = join(distDir, "cli.js");
const cliContent = readFileSync(cliPath, "utf8");
if (!cliContent.startsWith("#!")) {
  writeFileSync(cliPath, `#!/usr/bin/env node\n${cliContent}`);
}

console.log(`
Build complete!

Output: ${distDir}/cli.js
To install locally: bun run install:local
`);
