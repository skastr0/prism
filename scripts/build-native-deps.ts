import { existsSync } from "node:fs";
import { join } from "node:path";

export const opentuiNativePackages = [
  "@opentui/core-darwin-x64",
  "@opentui/core-darwin-arm64",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-win32-x64",
  "@opentui/core-win32-arm64",
] as const;

export const opentuiNativePackagesByTarget = new Map<string, readonly string[]>([
  ["darwin-x64", ["@opentui/core-darwin-x64"]],
  ["darwin-arm64", ["@opentui/core-darwin-arm64"]],
  ["linux-x64", ["@opentui/core-linux-x64", "@opentui/core-linux-x64-musl"]],
  ["linux-arm64", ["@opentui/core-linux-arm64", "@opentui/core-linux-arm64-musl"]],
]);

export interface NativeExternalOptions {
  readonly target: string;
  readonly repoRoot: string;
  readonly packageExists?: (packageRoot: string) => boolean;
}

const installedPackageRoot = (repoRoot: string, packageName: string): string =>
  join(repoRoot, "node_modules", ...packageName.split("/"));

export const nativePackagesToExternalize = ({
  target,
  repoRoot,
  packageExists = existsSync,
}: NativeExternalOptions): string[] => {
  const targetPackages = new Set(
    (opentuiNativePackagesByTarget.get(target) ?? []).filter((packageName) =>
      packageExists(installedPackageRoot(repoRoot, packageName))
    )
  );

  return opentuiNativePackages.filter((packageName) => !targetPackages.has(packageName));
};
