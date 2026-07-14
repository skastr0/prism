#!/usr/bin/env bun
/**
 * Workflow-store schema-version discipline guard (WFE-007).
 *
 * `WORKFLOW_STORE_SCHEMA_VERSION` (src/workflow-store.ts) stamps every
 * workflow SQLite store on open, but `package.json`'s `version` field is
 * what humans and install tooling actually use to tell two builds apart.
 * The bug this guards against: commit 08cee98 landed a new schema table on
 * 2026-07-07 while `package.json` stayed pinned to the v0.3.4 tag for 38
 * more commits — two indistinguishable-looking installed binaries silently
 * wrote different schemas (root-caused on WFE-007).
 *
 * This is a diff check, not a static scan: it reads
 * `WORKFLOW_STORE_SCHEMA_VERSION` and `package.json`'s `version` at the
 * merge-base with the default branch, compares them against their current
 * (working-tree) values, and fails only when the schema version moved
 * without the package version also moving. A base ref that cannot be
 * resolved (e.g. a shallow checkout with no default-branch history) is
 * reported as a skip, never a failure — there is nothing to diff against.
 *
 * Usage:
 *   bun scripts/workflow-store-schema-version-guard.ts [--base <ref>]
 *
 * `--base <ref>` compares directly against that exact ref (bypassing
 * merge-base resolution) — used by the colocated tests, and available for
 * a caller that wants a specific comparison point.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SCHEMA_FILE_REL = "src/workflow-store.ts";
export const PACKAGE_JSON_REL = "package.json";

export const parseSchemaVersion = (sourceText: string): number | null => {
  const match = /export const WORKFLOW_STORE_SCHEMA_VERSION\s*=\s*(\d+)\s*;/u.exec(sourceText);
  return match?.[1] !== undefined ? Number(match[1]) : null;
};

export const parsePackageVersion = (packageJsonText: string): string | null => {
  try {
    const parsed = JSON.parse(packageJsonText) as { readonly version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
};

export interface SchemaVersionDisciplineInput {
  readonly baseSchemaVersion: number | null;
  readonly headSchemaVersion: number | null;
  readonly basePackageVersion: string | null;
  readonly headPackageVersion: string | null;
}

export type SchemaVersionDisciplineVerdict =
  | { readonly kind: "pass"; readonly reason: string }
  | { readonly kind: "fail"; readonly reason: string };

/** Pure decision: did WORKFLOW_STORE_SCHEMA_VERSION change without package.json's version also changing? */
export const evaluateSchemaVersionDiscipline = (
  input: SchemaVersionDisciplineInput,
): SchemaVersionDisciplineVerdict => {
  if (input.baseSchemaVersion === null || input.headSchemaVersion === null) {
    return { kind: "pass", reason: "WORKFLOW_STORE_SCHEMA_VERSION not found at base or head; nothing to compare" };
  }
  if (input.baseSchemaVersion === input.headSchemaVersion) {
    return { kind: "pass", reason: `WORKFLOW_STORE_SCHEMA_VERSION unchanged (${input.headSchemaVersion})` };
  }
  if (input.basePackageVersion === null || input.headPackageVersion === null) {
    return {
      kind: "fail",
      reason: "WORKFLOW_STORE_SCHEMA_VERSION changed but package.json's version could not be read at base or head",
    };
  }
  if (input.basePackageVersion === input.headPackageVersion) {
    return {
      kind: "fail",
      reason: `WORKFLOW_STORE_SCHEMA_VERSION changed (${input.baseSchemaVersion} -> ${input.headSchemaVersion}) but package.json's version did not (still ${input.headPackageVersion})`,
    };
  }
  return {
    kind: "pass",
    reason: `WORKFLOW_STORE_SCHEMA_VERSION changed (${input.baseSchemaVersion} -> ${input.headSchemaVersion}) alongside a package.json version bump (${input.basePackageVersion} -> ${input.headPackageVersion})`,
  };
};

const runGit = (args: ReadonlyArray<string>, cwd: string = REPO_ROOT): string | null => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString("utf8").trim();
};

/**
 * Prefers a local `main` over `origin/main`. Worktrees on this machine fork from a local `main`
 * that moves ahead of `origin/main` between pushes (`origin/main` is routinely stale here — see
 * the WFE-007 worktree brief), so a fresh checkout's own `main` is the more current comparison
 * point when it exists. A from-scratch CI checkout of a PR ref typically has no local `main` at
 * all, so it falls through to the fetched `origin/main`. Null if neither resolves (e.g. a shallow
 * checkout with no history).
 */
export const resolveDefaultBranchRef = (git: (args: ReadonlyArray<string>) => string | null): string | null => {
  for (const candidate of ["main", "origin/main"]) {
    if (git(["rev-parse", "--verify", `${candidate}^{commit}`]) !== null) return candidate;
  }
  return null;
};

const readFileAtRef = (ref: string, relPath: string, cwd: string): string | null =>
  runGit(["show", `${ref}:${relPath}`], cwd);

export const runWorkflowStoreSchemaVersionGuard = (options: {
  readonly repoRoot: string;
  readonly explicitBase?: string;
}): { readonly skipped: true; readonly message: string } | {
  readonly skipped: false;
  readonly base: string;
  readonly verdict: SchemaVersionDisciplineVerdict;
} => {
  const { repoRoot, explicitBase } = options;
  const git = (args: ReadonlyArray<string>): string | null => runGit(args, repoRoot);

  let base: string | null;
  if (explicitBase !== undefined) {
    base = explicitBase;
  } else {
    const defaultRef = resolveDefaultBranchRef(git);
    base = defaultRef === null ? null : git(["merge-base", "HEAD", defaultRef]);
  }
  if (base === null) {
    return {
      skipped: true,
      message: "no origin/main or main ref resolvable (shallow checkout with no history); nothing to diff against",
    };
  }

  const headSchemaText = readFileSync(join(repoRoot, SCHEMA_FILE_REL), "utf8");
  const headPackageText = readFileSync(join(repoRoot, PACKAGE_JSON_REL), "utf8");
  const baseSchemaText = readFileAtRef(base, SCHEMA_FILE_REL, repoRoot);
  const basePackageText = readFileAtRef(base, PACKAGE_JSON_REL, repoRoot);

  const verdict = evaluateSchemaVersionDiscipline({
    baseSchemaVersion: baseSchemaText !== null ? parseSchemaVersion(baseSchemaText) : null,
    headSchemaVersion: parseSchemaVersion(headSchemaText),
    basePackageVersion: basePackageText !== null ? parsePackageVersion(basePackageText) : null,
    headPackageVersion: parsePackageVersion(headPackageText),
  });
  return { skipped: false, base, verdict };
};

const main = (): void => {
  const baseArgIndex = process.argv.indexOf("--base");
  const explicitBase = baseArgIndex !== -1 ? process.argv[baseArgIndex + 1] : undefined;

  const result = runWorkflowStoreSchemaVersionGuard({ repoRoot: REPO_ROOT, explicitBase });
  if (result.skipped) {
    console.log(`workflow-store-schema-version-guard: SKIP — ${result.message}`);
    return;
  }
  if (result.verdict.kind === "fail") {
    console.error(`workflow-store-schema-version-guard: FAIL (base ${result.base}) — ${result.verdict.reason}`);
    console.error(
      '    Fix: bump the "version" field in package.json in the same change that edits WORKFLOW_STORE_SCHEMA_VERSION.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`workflow-store-schema-version-guard: PASS (base ${result.base}) — ${result.verdict.reason}`);
};

// Allow direct invocation: bun scripts/workflow-store-schema-version-guard.ts
if (import.meta.main) {
  main();
}
