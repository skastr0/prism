import { expect, test } from "bun:test";
import { blockedSkipRow, parseSkipList, summarizeGates } from "./run-all";

test("parseSkipList splits, trims, and drops empty names", () => {
  expect(parseSkipList("idempotency-git,crash-convergence")).toEqual(
    new Set(["idempotency-git", "crash-convergence"]),
  );
  expect(parseSkipList(" idempotency-git , , crash-convergence ")).toEqual(
    new Set(["idempotency-git", "crash-convergence"]),
  );
});

test("parseSkipList returns an empty set for undefined or blank input", () => {
  expect(parseSkipList(undefined)).toEqual(new Set());
  expect(parseSkipList("")).toEqual(new Set());
  expect(parseSkipList("   ")).toEqual(new Set());
});

test("blockedSkipRow always reports expected: null regardless of the gate's normal expectation", () => {
  const row = blockedSkipRow("idempotency-git", "PASS");
  expect(row.pass).toBeNull();
  expect(row.expected).toBeNull();
  expect(row.blocked).toContain("PRISM_ACCEPTANCE_SKIP");
  expect(row.blocked).toContain("normally expected PASS");
});

test("blockedSkipRow names a null normal expectation explicitly", () => {
  const row = blockedSkipRow("mcp-determinism", null);
  expect(row.blocked).toContain("no fixed expectation");
});

test("summarizeGates classifies PASS/FAIL rows against their declared expectation", () => {
  const rows = [
    { gate: "a", pass: true, expected: "PASS" as const },
    { gate: "b", pass: false, expected: "PASS" as const },
    { gate: "c", pass: false, expected: "FAIL" as const },
    { gate: "d", pass: true, expected: "FAIL" as const },
  ];
  const { regressions, trackedDebt, flipCandidates, blocked } = summarizeGates(rows);
  expect(regressions.map((r) => r.gate)).toEqual(["b"]);
  expect(trackedDebt.map((r) => r.gate)).toEqual(["c"]);
  expect(flipCandidates.map((r) => r.gate)).toEqual(["d"]);
  expect(blocked).toEqual([]);
});

test("summarizeGates never counts a PRISM_ACCEPTANCE_SKIP row as a regression, even for a normally-PASS gate", () => {
  const skipRow = blockedSkipRow("idempotency-git", "PASS");
  const { regressions, blocked } = summarizeGates([skipRow]);
  expect(regressions).toEqual([]);
  expect(blocked).toEqual([skipRow]);
});

test("summarizeGates still treats a crashed (non-skip) blocked row against a PASS gate as a regression", () => {
  // A gate that crashes or prints no parseable JSON reports pass: null while
  // still carrying its real declared `expected` (unlike blockedSkipRow) —
  // that is the "gate infrastructure breakage -> exit 1" contract.
  const crashedRow = { gate: "idempotency-git", pass: null, expected: "PASS" as const };
  const { regressions, blocked } = summarizeGates([crashedRow]);
  expect(regressions).toEqual([crashedRow]);
  expect(blocked).toEqual([crashedRow]);
});
