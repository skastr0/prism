#!/usr/bin/env bun
/**
 * Applies an already-derived release version across every Prism-owned package
 * in the workspace, in lockstep.
 *
 * Scope of the rewrite:
 *   - the workspace root package.json (the version scripts/compile.ts stamps
 *     into the built binary as APP_VERSION), and
 *   - every workspace package (packages/prism-core + packages/npm/*), and
 *   - any @skastr0/prism* dependency pin that is exact-equal to the current
 *     version. The umbrella (@skastr0/prism) pins its platform packages by
 *     exact version in optionalDependencies; those pins must move with the
 *     release so the umbrella resolves the freshly-cut platform builds rather
 *     than the previous release. Range pins (e.g. workspace:* or ^x) are left
 *     untouched because they do not carry a frozen release version.
 *
 * The bump is *derived* by svu in .github/workflows/release.yml; this script
 * only *applies* a decided version, keeping derivation and file rewrite
 * separable and independently testable.
 *
 * Usage:
 *   bun scripts/apply-release-version.ts 0.3.0
 *   bun scripts/apply-release-version.ts v0.3.0   # leading v tolerated
 *   bun scripts/apply-release-version.ts --self-test
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRISM_DEP_PREFIX = "@skastr0/prism";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type PackageJson = {
  version?: string;
  workspaces?: ReadonlyArray<string>;
  [key: string]: unknown;
};

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const normalizeVersion = (raw: string): string => {
  const version = raw.startsWith("v") ? raw.slice(1) : raw;
  if (!SEMVER.test(version)) {
    throw new Error(`Not a valid semantic version: ${JSON.stringify(raw)}`);
  }
  return version;
};

/**
 * Pure rewrite: set the package version and re-pin exact-current @skastr0/prism*
 * dependencies to the target. Returns whether anything changed so callers can
 * report a minimal, auditable set of touched files.
 */
export const applyVersion = (
  pkg: PackageJson,
  current: string,
  target: string,
): { readonly pkg: PackageJson; readonly changed: boolean } => {
  const next: PackageJson = { ...pkg };
  let changed = false;

  if (next.version !== undefined && next.version !== target) {
    next.version = target;
    changed = true;
  }

  for (const field of DEPENDENCY_FIELDS) {
    const deps = next[field];
    if (deps === null || typeof deps !== "object") continue;
    const rewritten: Record<string, unknown> = { ...(deps as Record<string, unknown>) };
    for (const [name, range] of Object.entries(rewritten)) {
      if (!name.startsWith(PRISM_DEP_PREFIX)) continue;
      if (range === current && range !== target) {
        rewritten[name] = target;
        changed = true;
      }
    }
    next[field] = rewritten;
  }

  return { pkg: next, changed };
};

const expandWorkspaceGlobs = async (
  root: PackageJson,
): Promise<ReadonlyArray<string>> => {
  const patterns = root.workspaces ?? [];
  const paths: string[] = [];
  for (const pattern of patterns) {
    const glob = new Bun.Glob(join(pattern, "package.json"));
    for await (const match of glob.scan({ cwd: REPO_ROOT, onlyFiles: true })) {
      paths.push(join(REPO_ROOT, match));
    }
  }
  return paths.sort();
};

const readJson = async (path: string): Promise<PackageJson> =>
  JSON.parse(await readFile(path, "utf8")) as PackageJson;

const writeJson = async (path: string, pkg: PackageJson): Promise<void> =>
  writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

const runApply = async (targetRaw: string): Promise<void> => {
  const target = normalizeVersion(targetRaw);
  const rootPath = join(REPO_ROOT, "package.json");
  const root = await readJson(rootPath);
  const current = root.version;
  if (current === undefined) {
    throw new Error("Workspace root package.json has no version field");
  }

  const paths = [rootPath, ...(await expandWorkspaceGlobs(root))];
  const touched: string[] = [];
  for (const path of paths) {
    const pkg = await readJson(path);
    const { pkg: next, changed } = applyVersion(pkg, current, target);
    if (!changed) continue;
    await writeJson(path, next);
    touched.push(path.slice(REPO_ROOT.length));
  }

  console.log(`apply-release-version: ${current} -> ${target}`);
  for (const path of touched) console.log(`  updated ${path}`);
  if (touched.length === 0) {
    console.log("  (no files changed; already at target version)");
  }
};

const assert = (label: string, condition: boolean): void => {
  if (!condition) throw new Error(`self-test FAIL: ${label}`);
};

const runSelfTest = (): void => {
  const root = applyVersion({ version: "0.2.2", private: true }, "0.2.2", "0.3.0");
  assert("root version bumped", root.pkg.version === "0.3.0");
  assert("root reports changed", root.changed);

  const umbrella = applyVersion(
    {
      version: "0.2.2",
      optionalDependencies: {
        "@skastr0/prism-darwin-arm64": "0.2.2",
        "@skastr0/prism-linux-x64": "0.2.2",
      },
      dependencies: {
        "@skastr0/prism-core": "workspace:*",
        effect: "^3.21.1",
      },
    },
    "0.2.2",
    "0.3.0",
  );
  const opt = umbrella.pkg.optionalDependencies as Record<string, string>;
  assert("exact platform pin bumped", opt["@skastr0/prism-darwin-arm64"] === "0.3.0");
  assert("exact platform pin bumped 2", opt["@skastr0/prism-linux-x64"] === "0.3.0");
  const deps = umbrella.pkg.dependencies as Record<string, string>;
  assert("workspace:* pin untouched", deps["@skastr0/prism-core"] === "workspace:*");
  assert("non-prism dep untouched", deps["effect"] === "^3.21.1");

  const noop = applyVersion({ version: "0.3.0" }, "0.3.0", "0.3.0");
  assert("idempotent when already at target", noop.changed === false);

  const versionless = applyVersion({ name: "x" }, "0.2.2", "0.3.0");
  assert("versionless package left unchanged", versionless.changed === false);

  assert("normalizeVersion strips leading v", normalizeVersion("v1.2.3") === "1.2.3");
  let rejected = false;
  try {
    normalizeVersion("not-a-version");
  } catch {
    rejected = true;
  }
  assert("normalizeVersion rejects garbage", rejected);

  console.log("apply-release-version: self-test PASS");
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }
  const target = args[0];
  if (target === undefined) {
    console.error("Usage: bun scripts/apply-release-version.ts <version> | --self-test");
    process.exitCode = 1;
    return;
  }
  await runApply(target);
};

await main();
