/**
 * Acceptance matrix library — shared harness fixture spec, temp-root lifecycle,
 * plan comparator, and cleanup assertions for cross-harness acceptance gates.
 *
 * This is intentionally an install-phase matrix: it exercises direct-file and
 * config-patch surface kinds without dragging in compile-phase MCP daemon
 * lifecycle, which has its own dedicated gates (TS-005/TS-006).
 */

import { exists, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getHarness } from "../../../src/harnesses.js";
import { refreshPlugin, type RefreshResult } from "../../../src/refresh.js";
import { readSnapshot } from "../../../src/state/store.js";
import { syncDesiredRoot } from "../../../src/sync/run.js";
import { createPrismSandbox, type PrismSandbox } from "../../../src/testing/prism-sandbox.js";
import type { HarnessId, HarnessScope } from "../../../src/types.js";

export type SurfaceKind = "direct-file" | "config-patch" | "generated-bundle" | "generated-mcp";

export interface HarnessSurfaceSpec {
  readonly harnessId: HarnessId;
  readonly kind: SurfaceKind | ReadonlyArray<SurfaceKind>;
  /** Relative paths inside the harness root that the fixture is expected to manage. */
  readonly expectedPaths: ReadonlyArray<string>;
  /** Name of the shared config file (e.g. config.toml, opencode.json). */
  readonly configFile?: string;
}

export interface MatrixFixtureSpec {
  readonly pluginPath: string;
  readonly pluginName: string;
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly surfaces: ReadonlyArray<HarnessSurfaceSpec>;
}

export interface MatrixRunResult {
  readonly fixture: MatrixFixtureSpec;
  readonly sandbox: PrismSandbox;
  readonly run1: RefreshResult;
  readonly run2: RefreshResult;
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

export const HARNESS_SURFACE_MATRIX: Readonly<Record<"codex-cli" | "opencode", HarnessSurfaceSpec>> = {
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
    kind: ["direct-file", "config-patch"],
    configFile: "opencode.json",
    expectedPaths: [
      "AGENTS.md",
      "opencode.json",
      "commands/qa-report.md",
      "commands/opencode-only.md",
      "skills/qa-helper/SKILL.md",
      "skills/opencode-helper/SKILL.md",
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
  if (!surfaceKinds(spec).includes("config-patch")) return false;
  if (relativePath === "AGENTS.md") return true;
  if (spec.configFile && relativePath === spec.configFile) return true;
  return false;
};

export const runMatrixRow = async (options: {
  readonly fixture: MatrixFixtureSpec;
}): Promise<MatrixRunResult> => {
  const sandbox = await createMatrixSandbox();
  const run1 = await runRefresh({ fixture: options.fixture, sandbox });
  const run2 = await runRefresh({ fixture: options.fixture, sandbox });
  return { fixture: options.fixture, sandbox, run1, run2 };
};

const runRefresh = async (options: {
  readonly fixture: MatrixFixtureSpec;
  readonly sandbox: PrismSandbox;
}): Promise<RefreshResult> =>
  refreshPlugin({
    pluginPath: options.fixture.pluginPath,
    harnesses: options.fixture.harnesses,
    prismHome: options.sandbox.prismHome,
    overwrite: false,
    dryRun: false,
    roots: options.sandbox.roots,
  });

export const countOps = (result: RefreshResult): OpCounts => {
  const counts: Record<string, number> = {};
  for (const report of result.reports) {
    for (const op of report.ops) {
      counts[op.kind] = (counts[op.kind] ?? 0) + 1;
    }
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

export const assertRun1Creates = (result: RefreshResult): PlanAssertion[] => {
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
    pass: counts.blocked === 0 && result.blocked.length === 0,
    detail: `blocked=${counts.blocked}, blockedErrors=${result.blocked.length}`,
  });
  assertions.push({
    name: "run-1-success",
    pass: result.success,
    detail: `success=${result.success}, failures=${result.failures.length}`,
  });
  return assertions;
};

export const assertRun2Converged = (result: RefreshResult): PlanAssertion[] => {
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
      pass: result.success,
      detail: `success=${result.success}, failures=${result.failures.length}`,
    },
  ];
};

export interface CleanupAssertion {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

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

  for (const harnessId of options.fixture.harnesses) {
    const root = options.sandbox.rootFor(harnessId);
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
        const absolutePath = join(root, relativePath);
        const stillExists = await exists(absolutePath);
        const isShared = isConfigPatchSurface(relativePath, surfaceSpec);
        if (isShared) {
          const hasPrismMarkers = stillExists && (await readFile(absolutePath, "utf8")).includes("<!-- --- prism:");
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
  details: {
    run1: options.run1,
    run2: options.run2,
    cleanup: options.cleanup,
  },
});
