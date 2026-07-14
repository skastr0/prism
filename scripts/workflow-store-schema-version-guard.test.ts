import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  evaluateSchemaVersionDiscipline,
  parsePackageVersion,
  parseSchemaVersion,
  PACKAGE_JSON_REL,
  resolveDefaultBranchRef,
  runWorkflowStoreSchemaVersionGuard,
  SCHEMA_FILE_REL,
} from "./workflow-store-schema-version-guard.js";

describe("parseSchemaVersion", () => {
  test("reads the declared constant", () => {
    expect(parseSchemaVersion("export const WORKFLOW_STORE_SCHEMA_VERSION = 3;\n")).toBe(3);
  });

  test("returns null when the constant is absent", () => {
    expect(parseSchemaVersion("export const SOMETHING_ELSE = 3;\n")).toBeNull();
  });
});

describe("parsePackageVersion", () => {
  test("reads the version field", () => {
    expect(parsePackageVersion(JSON.stringify({ version: "0.3.5" }))).toBe("0.3.5");
  });

  test("returns null for malformed JSON", () => {
    expect(parsePackageVersion("not json")).toBeNull();
  });

  test("returns null when version is missing or not a string", () => {
    expect(parsePackageVersion(JSON.stringify({ version: 5 }))).toBeNull();
    expect(parsePackageVersion(JSON.stringify({}))).toBeNull();
  });
});

describe("evaluateSchemaVersionDiscipline", () => {
  test("passes when the schema version is unchanged", () => {
    const verdict = evaluateSchemaVersionDiscipline({
      baseSchemaVersion: 3,
      headSchemaVersion: 3,
      basePackageVersion: "0.3.5",
      headPackageVersion: "0.3.5",
    });
    expect(verdict.kind).toBe("pass");
  });

  test("fails when the schema version changed but the package version did not", () => {
    const verdict = evaluateSchemaVersionDiscipline({
      baseSchemaVersion: 2,
      headSchemaVersion: 3,
      basePackageVersion: "0.3.5",
      headPackageVersion: "0.3.5",
    });
    expect(verdict).toEqual({
      kind: "fail",
      reason: "WORKFLOW_STORE_SCHEMA_VERSION changed (2 -> 3) but package.json's version did not (still 0.3.5)",
    });
  });

  test("passes when the schema version changed alongside a package version bump", () => {
    const verdict = evaluateSchemaVersionDiscipline({
      baseSchemaVersion: 2,
      headSchemaVersion: 3,
      basePackageVersion: "0.3.5",
      headPackageVersion: "0.4.0",
    });
    expect(verdict.kind).toBe("pass");
  });

  test("fails when the schema version changed but a package version could not be read at either side", () => {
    const verdict = evaluateSchemaVersionDiscipline({
      baseSchemaVersion: 2,
      headSchemaVersion: 3,
      basePackageVersion: null,
      headPackageVersion: "0.4.0",
    });
    expect(verdict.kind).toBe("fail");
  });

  test("passes (nothing to compare) when the schema constant is absent at either side", () => {
    const verdict = evaluateSchemaVersionDiscipline({
      baseSchemaVersion: null,
      headSchemaVersion: 3,
      basePackageVersion: "0.3.5",
      headPackageVersion: "0.3.5",
    });
    expect(verdict.kind).toBe("pass");
  });
});

describe("resolveDefaultBranchRef", () => {
  test("prefers a local main over origin/main (local main is the fresher trunk on this machine)", () => {
    const ref = resolveDefaultBranchRef((args) =>
      args.includes("main^{commit}") || args.includes("origin/main^{commit}") ? "sha" : null);
    expect(ref).toBe("main");
  });

  test("falls back to origin/main when no local main resolves (fresh CI checkout of a PR ref)", () => {
    const ref = resolveDefaultBranchRef((args) => (args.includes("origin/main^{commit}") ? "sha" : null));
    expect(ref).toBe("origin/main");
  });

  test("returns null when neither resolves", () => {
    expect(resolveDefaultBranchRef(() => null)).toBeNull();
  });
});

// End-to-end coverage of the git plumbing itself: a synthetic repo, exercised through
// runWorkflowStoreSchemaVersionGuard exactly as the CLI entrypoint does.
describe("runWorkflowStoreSchemaVersionGuard (git integration)", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const schemaFileContents = (version: number): string =>
    `export const WORKFLOW_STORE_SCHEMA_VERSION = ${version};\n`;
  const packageJsonContents = (version: string): string =>
    `${JSON.stringify({ name: "fixture", version }, null, 2)}\n`;

  const git = async (repoRoot: string, args: ReadonlyArray<string>): Promise<void> => {
    const proc = Bun.spawn(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
    }
  };

  const createBaseRepo = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "schema-version-guard-"));
    tempRoots.push(root);
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.email", "guard-test@example.com"]);
    await git(root, ["config", "user.name", "Guard Test"]);
    await mkdir(dirname(join(root, SCHEMA_FILE_REL)), { recursive: true });
    await writeFile(join(root, SCHEMA_FILE_REL), schemaFileContents(1));
    await writeFile(join(root, PACKAGE_JSON_REL), packageJsonContents("0.1.0"));
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "base"]);
    return root;
  };

  test("skips when no default-branch ref is resolvable", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema-version-guard-no-main-"));
    tempRoots.push(root);
    // No git repo at all here — origin/main and main both fail to resolve.
    const result = runWorkflowStoreSchemaVersionGuard({ repoRoot: root });
    expect(result.skipped).toBe(true);
  });

  test("passes when neither the schema version nor the package version changed", async () => {
    const root = await createBaseRepo();
    const result = runWorkflowStoreSchemaVersionGuard({ repoRoot: root });
    expect(result).toMatchObject({ skipped: false, verdict: { kind: "pass" } });
  });

  test("fails when the working tree bumps the schema version without touching package.json", async () => {
    const root = await createBaseRepo();
    await writeFile(join(root, SCHEMA_FILE_REL), schemaFileContents(2));

    const result = runWorkflowStoreSchemaVersionGuard({ repoRoot: root });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.verdict).toEqual({
      kind: "fail",
      reason: "WORKFLOW_STORE_SCHEMA_VERSION changed (1 -> 2) but package.json's version did not (still 0.1.0)",
    });
  });

  test("passes when the working tree bumps the schema version and the package version together", async () => {
    const root = await createBaseRepo();
    await writeFile(join(root, SCHEMA_FILE_REL), schemaFileContents(2));
    await writeFile(join(root, PACKAGE_JSON_REL), packageJsonContents("0.2.0"));

    const result = runWorkflowStoreSchemaVersionGuard({ repoRoot: root });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.verdict.kind).toBe("pass");
  });

  test("compares against an explicit --base ref, bypassing merge-base resolution", async () => {
    const root = await createBaseRepo();
    // Commits the schema bump (still no package bump) so the explicit-base comparison reads
    // committed history rather than the working tree.
    await writeFile(join(root, SCHEMA_FILE_REL), schemaFileContents(2));
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "bump schema"]);

    const result = runWorkflowStoreSchemaVersionGuard({ repoRoot: root, explicitBase: "HEAD~1" });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.base).toBe("HEAD~1");
    expect(result.verdict.kind).toBe("fail");
  });
});
