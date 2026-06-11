import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tombstone gates: deleted relics must stay deleted.
 *
 * Each rule greps every source file under src/ and fails the suite if the
 * relic identifier reappears outside its allowlisted files. Future
 * workstreams append rules here as deletions complete — e.g. marker-gated
 * skill-pruning relics in WS5, and the `define*` transitional wrappers once
 * the plugin corpus no longer imports them.
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
  {
    pattern: /writeServerBundle/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS3 — the MCP lifecycle consumes the compiled canonical bundle at " +
      "PRISM_HOME/runtime/mcp/<plugin>/server.mjs; it never writes (or snapshots/restores) bundles",
  },
  {
    pattern: /defaultMcpRuntimeRoot/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS3 — the ~/.config dual MCP runtime root died with the canonical " +
      "PRISM_HOME/runtime/mcp relocation (no --mcp-root, no per-harness in-root bundles)",
  },
  {
    pattern: /__PRISM_HTTP_PORT__/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS3 — HTTP identity (host/port/token) is never baked into bundle bytes; " +
      "the server reads PRISM_MCP_HTTP_HOST/PRISM_MCP_HTTP_PORT/PRISM_MCP_HTTP_TOKEN at startup",
  },
  {
    pattern: /executeStandardLowering/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS5 — lowerers are pure desired-state producers; the sync engine " +
      "(src/sync/apply.ts) is the only harness-root writer",
  },
  {
    pattern: /assertLoweringWriteAuthority/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS5 — drift-as-error died with the lowering executor; the sync engine " +
      "converges (repair + backup) using snapshot-manifest ownership",
  },
  {
    pattern: /LoweringOwnershipError/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS5 — ownership gates are gone; the only guarded case is the sync plan's " +
      "blocked classification (BlockedTargetError, collected, never thrown mid-batch)",
  },
  {
    pattern: /prismOwnerMarker/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS5 — owner markers and their prune-time readers are gone; ownership is " +
      "snapshot-manifest membership",
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

/**
 * One-writer gate: among compile-path modules (src/sync/** and src/compile/**),
 * only src/sync/apply.ts may import harness-root write primitives from fs.ts.
 * installer.ts stays allowed until WS7 by scoping the gate to compile-path
 * modules; PRISM_HOME-side writers (compile cache, lockfile, canonical MCP
 * bundle) are explicitly allowlisted — they never touch harness roots.
 *
 * Lowerer modules get an additional stricter check below: even temp build
 * writes must flow through compile/temp-build-fs.ts so lowerers stay pure
 * desired-state producers.
 */
const WRITE_PRIMITIVES = ["writeFile", "removeFile", "removeDir", "chmodFile", "copyFile"] as const;
const NODE_FS_WRITE_PRIMITIVES = [
  "writeFile",
  "mkdir",
  "mkdtemp",
  "rm",
  "rmdir",
  "copyFile",
  "chmod",
] as const;

const COMPILE_PATH_PREFIXES = ["sync/", "compile/"] as const;

const WRITE_PRIMITIVE_ALLOWLIST: ReadonlySet<string> = new Set([
  "sync/apply.ts",
  // PRISM_HOME writers (never harness roots):
  "compile/cache.ts",
  "compile/lockfile.ts",
  "compile/mcp-runtime-path.ts",
]);

const importedFsWritePrimitives = (content: string): string[] => {
  const found = new Set<string>();
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/fs\.js["']/g;
  for (const match of content.matchAll(importPattern)) {
    for (const rawSpecifier of match[1]!.split(",")) {
      const name = rawSpecifier.replace(/\s+as\s+.*$/u, "").trim();
      if ((WRITE_PRIMITIVES as readonly string[]).includes(name)) found.add(name);
    }
  }
  return [...found].sort();
};

const importedNodeFsWritePrimitives = (content: string): string[] => {
  const found = new Set<string>();
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*["']node:fs\/promises["']/g;
  for (const match of content.matchAll(importPattern)) {
    for (const rawSpecifier of match[1]!.split(",")) {
      const name = rawSpecifier.replace(/\s+as\s+.*$/u, "").trim();
      if ((NODE_FS_WRITE_PRIMITIVES as readonly string[]).includes(name)) found.add(name);
    }
  }
  return [...found].sort();
};

test("only src/sync/apply.ts imports harness-root write primitives among compile-path modules", async () => {
  const violations: string[] = [];

  for (const relativePath of await listSourceFiles()) {
    if (!COMPILE_PATH_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue;
    if (relativePath.endsWith(".test.ts")) continue;
    if (WRITE_PRIMITIVE_ALLOWLIST.has(relativePath)) continue;

    const content = await readFile(join(SRC_ROOT, relativePath), "utf8");
    const primitives = importedFsWritePrimitives(content);
    if (primitives.length > 0) {
      violations.push(`${relativePath}: imports ${primitives.join(", ")} from fs.ts`);
    }
  }

  expect(violations).toEqual([]);
});

test("compile lowerers do not import node fs write primitives directly", async () => {
  const violations: string[] = [];

  for (const relativePath of await listSourceFiles()) {
    if (!relativePath.startsWith("compile/lowerers/")) continue;
    if (relativePath.endsWith(".test.ts")) continue;

    const content = await readFile(join(SRC_ROOT, relativePath), "utf8");
    const primitives = importedNodeFsWritePrimitives(content);
    if (primitives.length > 0) {
      violations.push(
        `${relativePath}: imports ${primitives.join(", ")} from node:fs/promises`,
      );
    }
  }

  expect(violations).toEqual([]);
});
