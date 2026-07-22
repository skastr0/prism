import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tombstone gates: deleted relics must stay deleted.
 *
 * Each rule greps every source file under src/ and fails the suite if the
 * relic identifier reappears outside its allowlisted files. Future
 * workstreams append rules here as deletions complete — e.g. marker-gated
 * skill-pruning relics in WS5.
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
      "deleted in WS3 — server bundle write/snapshot/restore APIs are gone; tool runtime " +
      "bundles live under PRISM_HOME/runtime/tools/ (CLI), not a live MCP supervisor path",
  },
  {
    pattern: /defaultMcpRuntimeRoot/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS3 — dual MCP runtime roots / --mcp-root / per-harness in-root bundles " +
      "are gone; tools are CLI under PRISM_HOME/runtime/tools/",
  },
  {
    pattern: /__PRISM_HTTP_PORT__/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS3 — baked HTTP identity tokens are gone with Streamable-HTTP MCP; " +
      "tool runtime is CLI, not a UDS/TCP MCP daemon",
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
  {
    pattern: /readHarnessLedger|writeHarnessLedger|managedEntryId|managed-ledger/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS7 — refresh uses snapshot manifests through the sync engine, not per-harness ledgers",
  },
  {
    pattern: /planInstallation|executeInstallation|executePlannedOperation/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in WS7 — direct artifacts now lower to DesiredRoot and sync through src/sync/apply.ts",
  },
  {
    pattern: /\bdefine(Agent|Trait|Orbit|Tool|Toolspace|Modelspace|Skillspace|Hook)\(/,
    allowedFiles: new Set([GATE_FILE]),
    reason:
      "deleted in PQ-087 — the define* identity wrappers are gone; plugin sources export a plain " +
      "object satisfying the matching *Source type directly (AgentSource, TraitSource, OrbitSource, " +
      "ToolSource, ToolspaceSource, ModelspaceSource, SkillspaceSource, HookSource). This gate matches " +
      "only the call form (trailing paren) so it does not flag unrelated string comparisons against " +
      "the bare relic name (e.g. import-specifier filtering) or prose describing the deletion.",
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

const WORKFLOW_RUNTIME_BUN_ALLOWLIST: ReadonlySet<string> = new Set([
  "workflow-bun-runtime.ts",
  "workflow-runtime.ts",
]);

const WORKFLOW_RUNTIME_BUN_PATTERNS = [
  { name: "bun: import", pattern: /from\s+["']bun:[^"']+["']/u },
  { name: "bun: require", pattern: /require\(\s*["']bun:[^"']+["']\s*\)/u },
  { name: "Bun global", pattern: /\bBun\./u },
  { name: "globalThis.Bun", pattern: /\bglobalThis\.Bun\b/u },
  {
    name: "casted globalThis.Bun",
    pattern: /\(\s*globalThis\s+as\b[\s\S]{0,200}?\)\s*\.Bun\b/u,
  },
  { name: "Bun typeof guard", pattern: /\btypeof\s+Bun\b/u },
] as const;

test("workflow engine Bun-only API gate catches casted globalThis seam access", () => {
  const blockedSamples = [
    { name: "direct", source: "globalThis.Bun" },
    { name: "single cast", source: "(globalThis as { Bun?: unknown }).Bun" },
    {
      name: "double cast",
      source: "(globalThis as unknown as { Bun?: unknown }).Bun",
    },
    {
      name: "multiline cast",
      source: `(
        globalThis as {
          Bun?: unknown;
        }
      ).Bun`,
    },
  ] as const;

  for (const sample of blockedSamples) {
    const matched = WORKFLOW_RUNTIME_BUN_PATTERNS.filter((gate) =>
      gate.pattern.test(sample.source),
    ).map((gate) => gate.name);
    expect(matched, sample.name).not.toEqual([]);
  }
});

test("workflow engine Bun-only APIs stay behind the runtime seam", async () => {
  const violations: string[] = [];

  for (const relativePath of await listSourceFiles()) {
    if (!relativePath.startsWith("workflow-")) continue;
    if (relativePath.includes(".test.")) continue;
    if (WORKFLOW_RUNTIME_BUN_ALLOWLIST.has(relativePath)) continue;

    const content = await readFile(join(SRC_ROOT, relativePath), "utf8");
    for (const gate of WORKFLOW_RUNTIME_BUN_PATTERNS) {
      if (gate.pattern.test(content)) {
        violations.push(`${relativePath}: ${gate.name}`);
      }
    }
  }

  expect(violations).toEqual([]);
});

/**
 * One-writer gate: among compile/sync modules plus the direct refresh planner,
 * only src/sync/apply.ts may import harness-root write primitives from fs.ts.
 * PRISM_HOME-side writers (compile cache, lockfile, tool runtime
 * catalog/bundle under runtime/tools/) are explicitly allowlisted — they never
 * touch harness roots.
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
const WRITE_GATED_PATH_PREFIXES = ["sync/", "compile/"] as const;
const WRITE_GATED_FILES: ReadonlySet<string> = new Set(["refresh.ts"]);

const WRITE_PRIMITIVE_ALLOWLIST: ReadonlySet<string> = new Set([
  "sync/apply.ts",
  // PRISM_HOME writers (never harness roots):
  "compile/cache.ts",
  "compile/compile-manifest.ts",
  "compile/lockfile.ts",
  "compile/pipeline.ts", // CLI tool runtime under PRISM_HOME/runtime/tools/
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
    if (
      !WRITE_GATED_FILES.has(relativePath) &&
      !WRITE_GATED_PATH_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
    ) {
      continue;
    }
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

test("tool runtime bundle (tool-runtime-bundle.ts) does not read ast-to-json-schema from disk at module load", async () => {
  const content = await readFile(join(SRC_ROOT, "compile/tool-runtime-bundle.ts"), "utf8");

  expect(content).not.toMatch(
    /(?:const|let|var)\s+\w+\s*=\s*readFileSync\([^)]*ast-to-json-schema/,
  );
  expect(content).toContain('from "./embedded-runtime-sources.js"');
  expect(content).not.toMatch(/\breadFileSync\b/);
});

test("process.exit is confined to exit helper and tool-runtime / lowerer strings", async () => {
  const allowed = new Set([
    "exit.ts",
    "compile/tool-runtime-bundle.ts",
    "compile/lowerers/claude-code.ts",
    "compile/lowerers/factory-droid.ts",
    "compile/lowerers/grok.ts",
    "compile/lowerers/kimi-code.ts",
    GATE_FILE,
  ]);
  const violations: string[] = [];

  for (const relativePath of await listSourceFiles()) {
    if (relativePath.endsWith(".test.ts") && relativePath !== GATE_FILE) continue;
    if (allowed.has(relativePath)) continue;

    const content = await readFile(join(SRC_ROOT, relativePath), "utf8");
    if (/\bprocess\.exit\s*\(/u.test(content)) {
      violations.push(`${relativePath}: calls process.exit directly`);
    }
  }

  expect(violations).toEqual([]);
});
