import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FINDING_CATALOG, FINDING_CODES } from "./finding-catalog.js";

/**
 * Extract every literal finding code emitted by `src/doctor.ts`.
 *
 * The source contains two dynamic families:
 *   - `sync.${op.kind}` from refresh ops
 *   - `code: violation.code` from `topology.*` (the literal codes live in
 *     `./mcp-topology-checks.ts`'s `TOPOLOGY_FINDING_CODES`, the single
 *     source of truth also used by `finding-catalog.ts`)
 *
 * We enumerate the concrete suffixes that can reach a `finding(...)` call.
 */
const expectedCodesFromSource = async (): Promise<Set<string>> => {
  const sourcePath = join(import.meta.dir, "..", "doctor.ts");
  const source = await readFile(sourcePath, "utf8");

  const codes = new Set<string>();

  // Static string codes: `code: "..."`
  const literalPattern = /code:\s*"([^"]+)"/g;
  for (const match of source.matchAll(literalPattern)) {
    codes.add(match[1]!);
  }

  // Dynamic sync op kinds that survive the `skip`/`blocked` filters.
  if (source.includes("code: `sync.${op.kind}`")) {
    for (const kind of ["create", "repair", "prune"]) {
      codes.add(`sync.${kind}`);
    }
  }

  // Dynamic topology codes: `findingFromTopologyViolation` reads
  // `violation.code` (never a literal), so its codes come from the shared
  // module rather than a grep of doctor.ts itself.
  if (source.includes("code: violation.code,")) {
    const { TOPOLOGY_FINDING_CODES } = await import("./mcp-topology-checks.js");
    for (const code of TOPOLOGY_FINDING_CODES) codes.add(code);
  }

  return codes;
};

test("every emitted doctor finding code has a catalog entry", async () => {
  const expected = await expectedCodesFromSource();
  const catalog = new Set(FINDING_CODES);

  const missing = [...expected].filter((code) => !catalog.has(code));
  const extra = [...catalog].filter((code) => !expected.has(code));

  expect(missing).toEqual([]);
  expect(extra).toEqual([]);
});

test("catalog codes are unique", () => {
  const codes = FINDING_CATALOG.map((entry) => entry.code);
  expect(new Set(codes).size).toBe(codes.length);
});
