#!/usr/bin/env bun

import { existsSync, mkdirSync, rmSync } from "fs";
import { homedir, platform, arch } from "os";
import { join } from "path";
import { compile, repoRoot, targetLabel, type Target } from "./compile.js";

const INSTALL_DIR = process.env.INSTALL_DIR || join(homedir(), ".local", "bin");
const DEV_BINARY_NAME = process.env.PRISM_DEV_BIN || "prism-dev";
const PRODUCTION_BINARY_NAME = "prism";

function detectTarget(): Target {
  const os = platform();
  const cpu = arch();

  let platformStr: Target["platform"];
  switch (os) {
    case "darwin":
      platformStr = "darwin";
      break;
    case "linux":
      platformStr = "linux";
      break;
    default:
      console.error(`Unsupported operating system: ${os}`);
      process.exit(1);
  }

  let archStr: Target["arch"];
  switch (cpu) {
    case "x64":
      archStr = "x64";
      break;
    case "arm64":
      archStr = "arm64";
      break;
    default:
      console.error(`Unsupported architecture: ${cpu}`);
      process.exit(1);
  }

  return { platform: platformStr, arch: archStr };
}

async function install() {
  const target = detectTarget();
  const label = targetLabel(target);
  console.log(`Building ${DEV_BINARY_NAME} for ${label}...`);

  mkdirSync(INSTALL_DIR, { recursive: true });
  mkdirSync(join(repoRoot, "dist"), { recursive: true });

  const productionPath = join(INSTALL_DIR, PRODUCTION_BINARY_NAME);
  if (existsSync(productionPath)) {
    console.log(`Leaving production binary untouched: ${productionPath}`);
  }

  const destPath = join(INSTALL_DIR, DEV_BINARY_NAME);

  if (existsSync(destPath)) {
    rmSync(destPath);
  }

  // Keep the dev binary under the repo so Prism's runtime dependency resolver
  // can find the source checkout's node_modules without an npm wrapper.
  const binaryPath = join(repoRoot, "dist", `prism-${label}`);
  await compile(target, binaryPath);
  await Bun.$`ln -s ${binaryPath} ${destPath}`;

  console.log(`\n✓ Installed ${DEV_BINARY_NAME} to ${destPath}`);
  console.log(`  Production prism stays on mise/rig: prism`);
  console.log(`  Re-run 'bun run install:local' to rebuild ${DEV_BINARY_NAME}.`);

  const pathDirs = (process.env.PATH || "").split(":");
  if (!pathDirs.includes(INSTALL_DIR)) {
    console.log(`
Note: ${INSTALL_DIR} is not in your PATH.
Add it to your shell configuration:

  # bash (~/.bashrc or ~/.bash_profile)
  export PATH="$HOME/.local/bin:$PATH"

  # zsh (~/.zshrc)
  export PATH="$HOME/.local/bin:$PATH"

  # fish (~/.config/fish/config.fish)
  set -gx PATH $HOME/.local/bin $PATH
`);
  }

  console.log(`\nRun '${DEV_BINARY_NAME} --help' to try the dev build.`);
}

install();
