#!/usr/bin/env bun
/**
 * Harness-enumeration guard (PQ-163).
 *
 * `src/lowerer-capabilities.ts` is the canonical harness registry, and its
 * `workflowWorker` bit is the single source for which harnesses Prism
 * Workflows may dispatch tasks to (see `workflowWorkerHarnessIds()` and
 * `WORKFLOW_WORKERS` in `src/workflow-catalog.ts`). Prism grew from 8 to 12
 * harnesses while a hand-maintained copy of that exact 8-harness set
 * (`WORKFLOW_WORKERS`) stood still and silently dropped `antigravity-cli`.
 *
 * This guard scans non-test source files for a literal array (or `Set`)
 * whose string-literal elements are *exactly* that same harness set —
 * i.e. a second hand-maintained copy of the workflow-worker enumeration —
 * and fails. It is intentionally narrow: it does not flag every array that
 * happens to contain harness ids (compile-target presets, per-agent
 * `installs` lists, etc. are a different concept with a different, often
 * larger or smaller, set) — only an exact re-listing of the workflow-worker
 * set this glyph's bug was about.
 *
 * Usage:
 *   bun scripts/harness-enumeration-guard.ts
 *   bun scripts/harness-enumeration-guard.ts --self-test
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { workflowWorkerHarnessIds } from "../src/lowerer-capabilities.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(REPO_ROOT, "src");

/**
 * Known, already-tracked exact copies of the workflow-worker set that this
 * guard intentionally does not fail on. Every entry needs a reason; adding
 * one back here for a *new* drift is the wrong fix — derive from
 * `lowerer-capabilities.ts` instead.
 */
const allowedExactCopies: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [];

export interface HarnessEnumerationViolation {
  readonly file: string;
  readonly line: number;
  readonly elements: ReadonlyArray<string>;
}

export interface GuardResult {
  readonly violations: ReadonlyArray<HarnessEnumerationViolation>;
  readonly allowed: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
}

const stringLiteralElements = (node: ts.ArrayLiteralExpression): ReadonlyArray<string> | null => {
  const values: string[] = [];
  for (const element of node.elements) {
    if (!ts.isStringLiteralLike(element)) return null;
    values.push(element.text);
  }
  return values;
};

/** Pure check: does this source text contain a literal array whose exact string-literal set equals `targetSet`? */
export const findExactSetArrayLiterals = (
  sourceText: string,
  fileName: string,
  targetSet: ReadonlySet<string>,
): ReadonlyArray<HarnessEnumerationViolation> => {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const violations: HarnessEnumerationViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const values = stringLiteralElements(node);
      if (values !== null && values.length === targetSet.size) {
        const asSet = new Set(values);
        if (asSet.size === targetSet.size && [...asSet].every((v) => targetSet.has(v))) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push({ file: fileName, line: line + 1, elements: values });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
};

const listSourceFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(path)));
    } else if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      files.push(path);
    }
  }
  return files;
};

const runGuard = async (): Promise<GuardResult> => {
  const targetSet = new Set<string>(workflowWorkerHarnessIds());
  const files = await listSourceFiles(SRC_DIR);
  const violations: HarnessEnumerationViolation[] = [];
  const allowed: Array<{ readonly file: string; readonly reason: string }> = [];

  for (const path of files) {
    const relPath = relative(SRC_DIR, path);
    const text = readFileSync(path, "utf8");
    const found = findExactSetArrayLiterals(text, path, targetSet);
    if (found.length === 0) continue;
    const allowEntry = allowedExactCopies.find((entry) => relPath === entry.file || relPath.endsWith(`/${entry.file}`));
    if (allowEntry) {
      allowed.push({ file: relPath, reason: allowEntry.reason });
      continue;
    }
    for (const violation of found) violations.push({ ...violation, file: relPath });
  }
  return { violations, allowed };
};

const printResult = (result: GuardResult): void => {
  for (const entry of result.allowed) {
    console.log(`harness-enumeration-guard: note: allowed exact copy in ${entry.file}: ${entry.reason}`);
  }
  if (result.violations.length === 0) {
    console.log(
      "harness-enumeration-guard: PASS — no hand-maintained copy of the workflow-worker harness set found outside lowerer-capabilities.ts.",
    );
    return;
  }
  console.error(
    "harness-enumeration-guard: FAIL — found a literal array that hand-re-lists the exact workflow-worker harness set:",
  );
  for (const violation of result.violations) {
    console.error(
      `  - ${violation.file}:${violation.line} [${violation.elements.join(", ")}]`,
    );
  }
  console.error(
    "    Derive this from lowerer-capabilities.ts's `workflowWorker` bit (see workflowWorkerHarnessIds()) instead of relisting it.",
  );
};

const expectNoViolations = (name: string, sourceText: string, targetSet: ReadonlySet<string>): void => {
  const found = findExactSetArrayLiterals(sourceText, "fixture.ts", targetSet);
  if (found.length > 0) {
    throw new Error(`${name} should find no violations, got: ${JSON.stringify(found)}`);
  }
};

const expectViolation = (name: string, sourceText: string, targetSet: ReadonlySet<string>): void => {
  const found = findExactSetArrayLiterals(sourceText, "fixture.ts", targetSet);
  if (found.length === 0) {
    throw new Error(`${name} should find a violation, got none`);
  }
};

const runSelfTest = (): void => {
  const targetSet = new Set(["alpha", "beta", "gamma"]);

  expectViolation(
    "exact re-listing of the target set",
    `export const RELISTED = ["alpha", "beta", "gamma"] as const;`,
    targetSet,
  );

  expectViolation(
    "exact re-listing inside a Set",
    `const s = new Set(["gamma", "alpha", "beta"]);`,
    targetSet,
  );

  expectNoViolations(
    "a subset is not a violation",
    `export const SUBSET = ["alpha", "beta"] as const;`,
    targetSet,
  );

  expectNoViolations(
    "a superset is not a violation",
    `export const SUPERSET = ["alpha", "beta", "gamma", "delta"] as const;`,
    targetSet,
  );

  expectNoViolations(
    "a same-size but different set is not a violation",
    `export const DIFFERENT = ["alpha", "beta", "epsilon"] as const;`,
    targetSet,
  );

  expectNoViolations(
    "an array with non-string elements is not a violation",
    `export const MIXED = [alpha, "beta", "gamma"];`,
    targetSet,
  );

  console.log("harness-enumeration-guard: self-test PASS");
};

const main = async (): Promise<void> => {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }
  const result = await runGuard();
  printResult(result);
  if (result.violations.length > 0) process.exitCode = 1;
};

await main();
