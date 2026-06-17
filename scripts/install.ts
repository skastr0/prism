#!/usr/bin/env bun

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync } from "fs";
import { homedir, platform, arch } from "os";
import { isAbsolute, join, resolve } from "path";

const INSTALL_DIR = process.env.INSTALL_DIR || join(homedir(), ".local", "bin");
const DEV_BINARY_NAME = process.env.PRISM_DEV_BIN || "prism-dev";
const PRODUCTION_BINARY_NAME = "prism";

function detectPlatform(): string {
  const os = platform();
  const cpu = arch();

  let platformStr: string;
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

  let archStr: string;
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

  return `${platformStr}-${archStr}`;
}

const repoRoot = resolve(import.meta.dir, "..");

const resolveSymlinkTarget = (linkPath: string): string | undefined => {
  try {
    const target = readlinkSync(linkPath);
    return isAbsolute(target) ? resolve(target) : resolve(linkPath, "..", target);
  } catch {
    return undefined;
  }
};

const isLegacyDevPrismInstall = (linkPath: string, distBinaryPath: string): boolean => {
  const target = resolveSymlinkTarget(linkPath);
  return target === distBinaryPath;
};

async function install() {
  const platformArch = detectPlatform();
  console.log(`Detected platform: ${platformArch}`);

  const binaryPath = resolve(repoRoot, "dist", `prism-${platformArch}`);

  if (!existsSync(binaryPath)) {
    console.error(`Binary not found: ${binaryPath}`);
    console.error("Run 'bun run build:cli' first to create the binaries.");
    process.exit(1);
  }

  mkdirSync(INSTALL_DIR, { recursive: true });

  const productionPath = join(INSTALL_DIR, PRODUCTION_BINARY_NAME);
  if (existsSync(productionPath) && isLegacyDevPrismInstall(productionPath, binaryPath)) {
    rmSync(productionPath);
    console.log(
      `Removed legacy dev symlink at ${productionPath}.`,
    );
    console.log("Use mise-managed prism for production and prism-dev for local builds.");
  } else if (existsSync(productionPath)) {
    console.log(`Leaving production binary untouched: ${productionPath}`);
  }

  const destPath = join(INSTALL_DIR, DEV_BINARY_NAME);

  if (existsSync(destPath)) {
    rmSync(destPath);
  }

  // Sign the dist binary on macOS so the dev symlink stays executable.
  if (platform() === "darwin") {
    await Bun.$`codesign --sign - --force ${binaryPath}`;
    console.log("Dev binary signed (ad-hoc)");
  }

  console.log(`Linking ${destPath} -> ${binaryPath}...`);
  await Bun.$`ln -s ${binaryPath} ${destPath}`;

  console.log(`\n✓ Installed ${DEV_BINARY_NAME} to ${destPath}`);
  console.log(`  Production prism stays on mise/rig: prism`);
  console.log(`  Rebuild with 'bun run build:cli' — ${DEV_BINARY_NAME} picks up dist/ automatically.`);

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