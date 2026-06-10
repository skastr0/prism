import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tombstone gates: deleted relics must stay deleted.
 *
 * Each rule greps every source file under src/ and fails the suite if the
 * relic identifier reappears outside its allowlisted files. Future
 * workstreams append rules here as deletions complete — e.g.
 * `prismOwnerMarker` once WS5 replaces marker-gated skill pruning with
 * manifest-membership ownership, and the `define*` transitional wrappers
 * once the plugin corpus no longer imports them.
 */
interface TombstoneRule {
  /** Matched against file contents. */
  readonly pattern: RegExp;
  /** src/-relative paths (forward slashes) allowed to mention the relic. */
  readonly allowedFiles: ReadonlySet<string>;
  /** Why the relic must stay dead. */
  readonly reason: string;
}

const GATE_FILE = "static-gates.test.ts";

const TOMBSTONE_RULES: readonly TombstoneRule[] = [
  {
    pattern: /mergeCodexAgentConfig/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS0 — installer codex agent-role config merge had zero call sites",
  },
  {
    pattern: /convertAgentToCodexToml/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS0 — companion of mergeCodexAgentConfig in the dead codex agent-role install path",
  },
];

const SRC_ROOT = import.meta.dir;

const listSourceFiles = async (): Promise<string[]> => {
  const glob = new Bun.Glob("**/*.{ts,tsx,js,mjs,cjs}");
  const files: string[] = [];
  for await (const relativePath of glob.scan({ cwd: SRC_ROOT })) {
    files.push(relativePath.split("\\").join("/"));
  }
  return files.sort((left, right) => left.localeCompare(right));
};

test("tombstoned relics do not reappear in src/", async () => {
  const violations: string[] = [];

  for (const relativePath of await listSourceFiles()) {
    const content = await readFile(join(SRC_ROOT, relativePath), "utf8");
    for (const rule of TOMBSTONE_RULES) {
      if (rule.allowedFiles.has(relativePath)) continue;
      if (rule.pattern.test(content)) {
        violations.push(`${relativePath}: ${rule.pattern.source} (${rule.reason})`);
      }
    }
  }

  expect(violations).toEqual([]);
});
