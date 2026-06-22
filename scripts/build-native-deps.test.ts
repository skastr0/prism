import { expect, test } from "bun:test";
import { join } from "node:path";
import { nativePackagesToExternalize, opentuiNativePackages } from "./build-native-deps.js";

const repoRoot = "/repo";

const packageRoot = (name: string): string => join(repoRoot, "node_modules", ...name.split("/"));

test("installed target-native OpenTUI package is bundled into the build", () => {
  const external = nativePackagesToExternalize({
    target: "darwin-arm64",
    repoRoot,
    packageExists: (path) => path === packageRoot("@opentui/core-darwin-arm64"),
  });

  expect(external).not.toContain("@opentui/core-darwin-arm64");
  expect(external).toContain("@opentui/core-darwin-x64");
  expect(external).toContain("@opentui/core-linux-x64");
});

test("unavailable cross-target OpenTUI packages stay external", () => {
  const external = nativePackagesToExternalize({
    target: "linux-x64",
    repoRoot,
    packageExists: (path) => path === packageRoot("@opentui/core-darwin-arm64"),
  });

  expect(external).toEqual([...opentuiNativePackages]);
});

test("installed linux glibc and musl packages are bundled together", () => {
  const installed = new Set([
    packageRoot("@opentui/core-linux-x64"),
    packageRoot("@opentui/core-linux-x64-musl"),
  ]);

  const external = nativePackagesToExternalize({
    target: "linux-x64",
    repoRoot,
    packageExists: (path) => installed.has(path),
  });

  expect(external).not.toContain("@opentui/core-linux-x64");
  expect(external).not.toContain("@opentui/core-linux-x64-musl");
  expect(external).toContain("@opentui/core-darwin-arm64");
});
