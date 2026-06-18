/**
 * Acceptance matrix library — shared harness fixture spec, temp-root lifecycle,
 * plan comparator, and cleanup assertions for cross-harness acceptance gates.
 *
 * This matrix covers both the install phase (direct-file and config-patch surface
 * kinds) and the compile phase (plugin-bundle and generated-MCP surface kinds).
 * MCP daemon lifecycle is kept disabled ("none") throughout; rows that require a
 * running Streamable HTTP MCP daemon are expected to fail and are registered as
 * tracked debt rather than regressions.
 */

import { exists, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { getHarness } from "../../../src/harnesses.js";
import { refreshPlugin, type RefreshResult } from "../../../src/refresh.js";
import { readSnapshot } from "../../../src/state/store.js";
import { syncDesiredRoot } from "../../../src/sync/run.js";
import { createPrismSandbox, type PrismSandbox } from "../../../src/testing/prism-sandbox.js";
import { HarnessRootsTest } from "../../../src/services/prism-env.js";
import { compilePluginForTarget, type CompileResult } from "../../../src/compile/pipeline.js";
import type { HarnessId, HarnessScope } from "../../../src/types.js";
import type { SyncOp } from "../../../src/sync/plan.js";
import type { BlockedTargetError } from "../../../src/errors.js";

export type SurfaceKind = "direct-file" | "config-patch" | "plugin-bundle" | "generated-mcp";

export interface HarnessSurfaceSpec {
  readonly harnessId: HarnessId;
  readonly kind: SurfaceKind | ReadonlyArray<SurfaceKind>;
  /** Relative paths inside the harness root that the fixture is expected to manage. */
  readonly expectedPaths: ReadonlyArray<string>;
  /** Name of the shared config file (e.g. config.toml, opencode.json). */
  readonly configFile?: string;
  /**
   * When true, this harness's expected paths may live outside the nominal
   * harness root (e.g. Pi global agents). Cleanup still prunes them via the
   * snapshot manifest.
   */
  readonly rootAnchored?: boolean;
}

export interface MatrixFixtureSpec {
  readonly pluginPath: string;
  readonly pluginName: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  /** Harnesses that also run the compile phase (before install). */
  readonly compileTargets?: ReadonlyArray<HarnessId>;
  readonly surfaces: ReadonlyArray<HarnessSurfaceSpec>;
  /** Optional project path for project-scoped compile targets. */
  readonly projectPath?: string;
}

export type PhaseResult = RefreshResult | CompileResult;

export interface MatrixRunResult {
  readonly fixture: MatrixFixtureSpec;
  readonly sandbox: PrismSandbox;
  /** Combined install + compile result for the first refresh. */
  readonly run1: PhaseResult;
  /** Combined install + compile result for the second refresh. */
  readonly run2: PhaseResult;
}

export interface OpCounts {
  readonly create: number;
  readonly repair: number;
  readonly skip: number;
  readonly "patch-regions": number;
  readonly "skip-regions": number;
  readonly prune: number;
  readonly blocked: number;
  readonly chmod: number;
}

export const HARNESS_SURFACE_MATRIX: Readonly<Record<string, HarnessSurfaceSpec>> = {
  "codex-cli": {
    harnessId: "codex-cli",
    kind: ["direct-file", "config-patch"],
    configFile: "config.toml",
    expectedPaths: [
      "AGENTS.md",
      "config.toml",
      "prompts/qa-report.md",
      "prompts/codex-only.md",
      "skills/qa-helper/SKILL.md",
      "skills/codex-helper/SKILL.md",
    ],
  },
  opencode: {
    harnessId: "opencode",
    kind: ["direct-file", "config-patch", "plugin-bundle"],
    configFile: "opencode.json",
    expectedPaths: [
      "AGENTS.md",
      "opencode.json",
      "commands/qa-report.md",
      "commands/opencode-only.md",
      "skills/qa-helper/SKILL.md",
      "skills/opencode-helper/SKILL.md",
      "agents/qa-tester.md",
      "skills/qa-orbit/SKILL.md",
      "plugins/prism-generated-prism-harness-qa/dist/server.mjs",
    ],
  },
  "factory-droid": {
    harnessId: "factory-droid",
    kind: "direct-file",
    configFile: "settings.json",
    expectedPaths: [
      "AGENTS.md",
      "commands/qa-report.md",
      "commands/factory-droid-only.md",
    ],
  },
  openclaw: {
    harnessId: "openclaw",
    kind: "direct-file",
    expectedPaths: ["skills/qa-helper/SKILL.md", "skills/openclaw-helper/SKILL.md"],
  },
  hermes: {
    harnessId: "hermes",
    kind: "generated-mcp",
    configFile: "config.yaml",
    expectedPaths: ["config.yaml"],
  },
  cursor: {
    harnessId: "cursor",
    kind: ["direct-file", "generated-mcp"],
    configFile: "mcp.json",
    expectedPaths: [
      ".cursorrules",
      "skills/qa-helper/SKILL.md",
      "skills/cursor-helper/SKILL.md",
      "plugins/local/prism-generated-prism-harness-qa/.cursor-plugin/plugin.json",
      "plugins/local/prism-generated-prism-harness-qa/commands/qa-report.md",
    ],
  },
  "kimi-code": {
    harnessId: "kimi-code",
    kind: ["config-patch", "plugin-bundle", "generated-mcp"],
    configFile: "config.toml",
    expectedPaths: [
      "config.toml",
      "plugins/installed.json",
      "plugins/managed/prism-generated-prism-harness-qa/kimi.plugin.json",
      "plugins/managed/prism-generated-prism-harness-qa/skills/prism-context/SKILL.md",
      "plugins/managed/prism-generated-prism-harness-qa/skills/qa-helper/SKILL.md",
    ],
  },
  grok: {
    harnessId: "grok",
    kind: ["direct-file", "plugin-bundle", "generated-mcp"],
    configFile: "config.toml",
    expectedPaths: [
      "AGENTS.md",
      "config.toml",
      "plugins/prism-generated-prism-harness-qa/agents/qa-tester.md",
      "plugins/prism-generated-prism-harness-qa/skills/qa-helper/SKILL.md",
      "plugins/prism-generated-prism-harness-qa/skills/qa-orbit/SKILL.md",
      "plugins/prism-generated-prism-harness-qa/.mcp.json",
    ],
  },
  "amp-code": {
    harnessId: "amp-code",
    kind: ["direct-file", "plugin-bundle"],
    configFile: "settings.json",
    expectedPaths: [
      "AGENTS.md",
      "skills/qa-helper/SKILL.md",
      "skills/prism-agent-qa-tester/SKILL.md",
      "skills/qa-orbit/SKILL.md",
      "plugins/prism-generated-prism-harness-qa.ts",
    ],
  },
  pi: {
    harnessId: "pi",
    kind: ["config-patch", "plugin-bundle"],
    configFile: "settings.json",
    rootAnchored: false,
    expectedPaths: [
      "settings.json",
      "packages/prism-generated-prism-harness-qa/skills/qa-helper/SKILL.md",
      "packages/prism-generated-prism-harness-qa/skills/qa-orbit/SKILL.md",
      "packages/prism-generated-prism-harness-qa/prompts/qa-report.md",
      "packages/prism-generated-prism-harness-qa/hooks/session-start.mjs",
      "packages/prism-generated-prism-harness-qa/extensions/prism-extension.js",
      "packages/prism-generated-prism-harness-qa/package.json",
      "agents/qa-tester.md",
    ],
  },
  "claude-code": {
    harnessId: "claude-code",
    kind: ["plugin-bundle", "generated-mcp"],
    configFile: "settings.json",
    expectedPaths: [
      "skills/prism-generated-prism-harness-qa/.claude-plugin/plugin.json",
      "skills/prism-generated-prism-harness-qa/agents/qa-tester.md",
      "skills/prism-generated-prism-harness-qa/skills/qa-helper/SKILL.md",
      "skills/prism-generated-prism-harness-qa/skills/qa-orbit/SKILL.md",
      "skills/prism-generated-prism-harness-qa/.mcp.json",
    ],
  },
  "antigravity-cli": {
    harnessId: "antigravity-cli",
    kind: ["plugin-bundle", "generated-mcp"],
    configFile: "mcp_config.json",
    expectedPaths: [
      "plugins/prism-generated-prism-harness-qa/plugin.json",
      "plugins/prism-generated-prism-harness-qa/agents/qa-tester.md",
      "plugins/prism-generated-prism-harness-qa/skills/qa-helper/SKILL.md",
      "plugins/prism-generated-prism-harness-qa/skills/qa-orbit/SKILL.md",
      "plugins/prism-generated-prism-harness-qa/mcp_config.json",
    ],
  },
} as const;

export const createMatrixSandbox = (): Promise<PrismSandbox> => createPrismSandbox();

const surfaceKinds = (spec: HarnessSurfaceSpec): ReadonlyArray<SurfaceKind> => {
  const { kind } = spec;
  if (typeof kind === "string") return [kind];
  return kind;
};

const isConfigPatchSurface = (relativePath: string, spec: HarnessSurfaceSpec): boolean => {
  if (!surfaceKinds(spec).includes("config-patch") && !surfaceKinds(spec).includes("direct-file")) {
    return false;
  }
  const harness = getHarness(spec.harnessId);
  if (harness.rulesFile && relativePath === harness.rulesFile) return true;
  if (spec.configFile && relativePath === spec.configFile) return true;
  return false;
};

const phaseOps = (result: PhaseResult): ReadonlyArray<SyncOp> => {
  if ("reports" in result) {
    return result.reports.flatMap((report) => report.ops);
  }
  return result.operations;
};

const phaseBlocked = (result: PhaseResult): ReadonlyArray<BlockedTargetError> => {
  if ("reports" in result) return result.blocked;
  return result.blocked;
};

const phaseFailures = (result: PhaseResult): ReadonlyArray<{ readonly op: SyncOp; readonly message: string }> => {
  if ("reports" in result) return result.failures;
  return result.failures;
};

export const phaseSuccess = (result: PhaseResult): boolean =>
  phaseFailures(result).length === 0 && phaseBlocked(result).length === 0;

const emptyPhaseResult = (options: { readonly converged?: boolean } = {}): PhaseResult => ({
  converged: options.converged ?? true,
  success: true,
  failures: [],
  blocked: [],
  backups: [],
  reports: [{ harness: "none", root: "", ops: [], failures: [], backups: [], blocked: [], converged: true }],
} as unknown as PhaseResult);

const mergePhaseResults = (results: ReadonlyArray<PhaseResult>): PhaseResult => {
  const filtered = results.filter((result) => "reports" in result || result.operations.length > 0);
  if (filtered.length === 0) return emptyPhaseResult();
  if (filtered.length === 1) return filtered[0]!;
  return {
    converged: filtered.every((result) => result.converged),
    success: filtered.every(phaseSuccess),
    failures: filtered.flatMap(phaseFailures),
    blocked: filtered.flatMap(phaseBlocked),
    backups: filtered.flatMap((result) => result.backups),
    reports: filtered.flatMap((result) =>
      "reports" in result ? result.reports : [{ harness: result.target, root: result.outputRoot, ops: result.operations, failures: result.failures, backups: result.backups, blocked: result.blocked, converged: result.converged }],
    ),
  } as unknown as PhaseResult;
};

export const runCompileForHarness = async (options: {
  readonly pluginPath: string;
  readonly harnessId: HarnessId;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  readonly prismHome: string;
  readonly root: string;
  readonly mcpLifecycle?: "none" | "verify" | "serve";
}): Promise<CompileResult> => {
  const program = compilePluginForTarget({
    pluginPath: options.pluginPath,
    target: options.harnessId,
    scope: options.scope,
    projectPath: options.projectPath,
    root: options.root,
    prismHome: options.prismHome,
    dryRun: false,
    mcpLifecycle: options.mcpLifecycle ?? "none",
  });

  return Effect.runPromise(
    program.pipe(
      Effect.provide(
        HarnessRootsTest({
          [options.harnessId]: options.root,
        }),
      ),
    ),
  );
};

const runInstall = async (options: {
  readonly fixture: MatrixFixtureSpec;
  readonly sandbox: PrismSandbox;
}): Promise<RefreshResult> =>
  refreshPlugin({
    pluginPath: options.fixture.pluginPath,
    harnesses: options.fixture.harnesses,
    projectPath: options.fixture.projectPath,
    prismHome: options.sandbox.prismHome,
    overwrite: false,
    dryRun: false,
    roots: options.sandbox.roots,
  });

export const runMatrixRow = async (options: {
  readonly fixture: MatrixFixtureSpec;
}): Promise<MatrixRunResult> => {
  const sandbox = await createMatrixSandbox();
  const compileTargets = options.fixture.compileTargets ?? [];
  const compileRoot = (harnessId: HarnessId): string => {
    if (options.fixture.scope === "project") {
      if (!options.fixture.projectPath) {
        throw new Error(`project scope requires projectPath for ${harnessId}`);
      }
      const harness = getHarness(harnessId);
      if (!harness.projectConfigPath) {
        throw new Error(`${harnessId} does not support project scope`);
      }
      return resolve(options.fixture.projectPath, harness.projectConfigPath);
    }
    return sandbox.rootFor(harnessId);
  };

  const runCompile = async (): Promise<PhaseResult> => {
    if (compileTargets.length === 0) return emptyPhaseResult();
    const results = await Promise.all(
      compileTargets.map((harnessId) =>
        runCompileForHarness({
          pluginPath: options.fixture.pluginPath,
          harnessId,
          scope: options.fixture.scope,
          projectPath: options.fixture.projectPath,
          prismHome: sandbox.prismHome,
          root: compileRoot(harnessId),
          mcpLifecycle: "none",
        }),
      ),
    );
    return mergePhaseResults(results);
  };

  const run1compile = await runCompile();
  const run1install = await runInstall({ fixture: options.fixture, sandbox });
  const run2compile = await runCompile();
  const run2install = await runInstall({ fixture: options.fixture, sandbox });

  return {
    fixture: options.fixture,
    sandbox,
    run1: mergePhaseResults([run1compile, run1install]),
    run2: mergePhaseResults([run2compile, run2install]),
  };
};

export const countOps = (result: PhaseResult): OpCounts => {
  const counts: Record<string, number> = {};
  for (const op of phaseOps(result)) {
    counts[op.kind] = (counts[op.kind] ?? 0) + 1;
  }
  return {
    create: counts.create ?? 0,
    repair: counts.repair ?? 0,
    skip: counts.skip ?? 0,
    "patch-regions": counts["patch-regions"] ?? 0,
    "skip-regions": counts["skip-regions"] ?? 0,
    prune: counts.prune ?? 0,
    blocked: counts.blocked ?? 0,
    chmod: counts.chmod ?? 0,
  } as OpCounts;
};

export interface PlanAssertion {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

export const assertRun1Creates = (result: PhaseResult): PlanAssertion[] => {
  const counts = countOps(result);
  const assertions: PlanAssertion[] = [];
  const created = counts.create + counts["patch-regions"];
  assertions.push({
    name: "run-1-converged-false",
    pass: !result.converged,
    detail: `converged=${result.converged}`,
  });
  assertions.push({
    name: "run-1-creates-or-patches",
    pass: created > 0,
    detail: `create=${counts.create}, patch-regions=${counts["patch-regions"]}`,
  });
  assertions.push({
    name: "run-1-no-prune",
    pass: counts.prune === 0,
    detail: `prune=${counts.prune}`,
  });
  assertions.push({
    name: "run-1-no-blocked",
    pass: counts.blocked === 0 && phaseBlocked(result).length === 0,
    detail: `blocked=${counts.blocked}, blockedErrors=${phaseBlocked(result).length}`,
  });
  assertions.push({
    name: "run-1-success",
    pass: phaseSuccess(result),
    detail: `success=${phaseSuccess(result)}, failures=${phaseFailures(result).length}`,
  });
  return assertions;
};

export const assertRun2Converged = (result: PhaseResult): PlanAssertion[] => {
  const counts = countOps(result);
  const writeKinds = ["create", "repair", "patch-regions", "prune", "chmod"] as const;
  const writes = writeKinds.reduce((sum, kind) => sum + counts[kind], 0);
  return [
    {
      name: "run-2-converged",
      pass: result.converged,
      detail: `converged=${result.converged}`,
    },
    {
      name: "run-2-zero-writes",
      pass: writes === 0,
      detail: `writes=${writes} (create=${counts.create}, repair=${counts.repair}, patch-regions=${counts["patch-regions"]}, prune=${counts.prune}, chmod=${counts.chmod})`,
    },
    {
      name: "run-2-success",
      pass: phaseSuccess(result),
      detail: `success=${phaseSuccess(result)}, failures=${phaseFailures(result).length}`,
    },
  ];
};

export interface CleanupAssertion {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const resolveExpectedPath = (root: string, harnessId: HarnessId, relativePath: string): string => {
  // Pi global agents are emitted to a sibling of the configured Pi root.
  if (harnessId === "pi" && relativePath.startsWith("agents/")) {
    return join(dirname(root), relativePath);
  }
  return join(root, relativePath);
};

/**
 * Simulate plugin removal by syncing an empty desired state for every harness
 * root in the matrix. With no `scopePlugins`, the sync engine uses full-world
 * prune semantics, dropping every Prism-owned file and region for the fixture.
 */
export const vacuumAndAssertCleanup = async (options: {
  readonly fixture: MatrixFixtureSpec;
  readonly sandbox: PrismSandbox;
}): Promise<CleanupAssertion[]> => {
  const assertions: CleanupAssertion[] = [];
  const pruneOps: Array<{ harness: HarnessId; targetPath: string }> = [];

  const cleanupRoots = new Map<HarnessId, string>();
  for (const harnessId of options.fixture.harnesses) {
    cleanupRoots.set(harnessId, options.sandbox.rootFor(harnessId));
  }
  for (const harnessId of options.fixture.compileTargets ?? []) {
    if (!cleanupRoots.has(harnessId)) {
      cleanupRoots.set(harnessId, options.sandbox.rootFor(harnessId));
    }
  }

  for (const [harnessId, root] of cleanupRoots) {
    const report = await syncDesiredRoot({
      prismHome: options.sandbox.prismHome,
      desired: { harness: harnessId, root, files: [], regions: [] },
      dryRun: false,
    });
    for (const op of report.ops) {
      if (op.kind === "prune") {
        pruneOps.push({ harness: harnessId, targetPath: op.targetPath });
      }
    }

    const surfaceSpec = options.fixture.surfaces.find((s) => s.harnessId === harnessId);
    if (surfaceSpec) {
      for (const relativePath of surfaceSpec.expectedPaths) {
        const absolutePath = resolveExpectedPath(root, harnessId, relativePath);
        const stillExists = await exists(absolutePath);
        const isShared = isConfigPatchSurface(relativePath, surfaceSpec);
        if (isShared) {
          const hasPrismMarkers =
            stillExists && (await readFile(absolutePath, "utf8")).includes("<!-- --- prism:");
          assertions.push({
            name: `cleanup-${harnessId}-${relativePath}`,
            pass: !hasPrismMarkers,
            detail: hasPrismMarkers
              ? `Prism markers remain in shared file: ${absolutePath}`
              : stillExists
                ? `shared file empty of Prism markers: ${absolutePath}`
                : `shared file removed: ${absolutePath}`,
          });
        } else {
          assertions.push({
            name: `cleanup-${harnessId}-${relativePath}`,
            pass: !stillExists,
            detail: stillExists ? `still exists: ${absolutePath}` : `removed: ${absolutePath}`,
          });
        }
      }
    }

    const { manifest } = await readSnapshot({
      prismHome: options.sandbox.prismHome,
      harness: harnessId,
      root,
    });
    const fixtureEntries = manifest.entries.filter((entry) =>
      entry.plugin.includes(options.fixture.pluginName),
    );
    assertions.push({
      name: `cleanup-${harnessId}-snapshot-empty`,
      pass: fixtureEntries.length === 0,
      detail: `fixture entries remaining in snapshot: ${fixtureEntries.length}`,
    });
  }

  assertions.unshift({
    name: "cleanup-prune-ops-emitted",
    pass: pruneOps.length > 0,
    detail: `prune ops emitted: ${pruneOps.length}`,
  });

  return assertions;
};

/**
 * Build a human-readable row summary for a gate's JSON output.
 */
export const formatMatrixSummary = (options: {
  readonly gate: string;
  readonly fixture: MatrixFixtureSpec;
  readonly run1: PlanAssertion[];
  readonly run2: PlanAssertion[];
  readonly cleanup: CleanupAssertion[];
  readonly pass: boolean;
}): unknown => ({
  gate: options.gate,
  pass: options.pass,
  fixture: options.fixture.pluginName,
  harnesses: options.fixture.harnesses,
  compileTargets: options.fixture.compileTargets,
  details: {
    run1: options.run1,
    run2: options.run2,
    cleanup: options.cleanup,
  },
});
