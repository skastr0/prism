#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const platformKey = `${process.platform}-${process.arch}`;

const packageMap = {
  "darwin-arm64": "@skastr0/prism-darwin-arm64",
  "darwin-x64": "@skastr0/prism-darwin-x64",
  "linux-arm64": "@skastr0/prism-linux-arm64",
  "linux-x64": "@skastr0/prism-linux-x64",
};

const packageName = packageMap[platformKey];

if (packageName === undefined) {
  console.error(`prism: unsupported platform ${platformKey}`);
  process.exit(1);
}

let packageJsonPath;
try {
  packageJsonPath = require.resolve(`${packageName}/package.json`);
} catch {
  console.error(`prism: missing platform package ${packageName}`);
  console.error("Reinstall @skastr0/prism with optional dependencies enabled.");
  process.exit(1);
}

const platformPackageRoot = dirname(packageJsonPath);
const binaryPath = join(platformPackageRoot, "bin", "prism");

if (!existsSync(binaryPath)) {
  console.error(`prism: platform binary not found at ${binaryPath}`);
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  env: {
    ...process.env,
    PRISM_RUNTIME_DEPS_PACKAGE_ROOT: platformPackageRoot,
  },
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
