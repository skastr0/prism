/**
 * Shared plugin inventory + whole-plugin planning.
 *
 * Two pieces of orchestration used to live, private, inside `cli.ts`:
 *  - the one-level `plugin.json` folder scan (`discoverPluginPaths`), and
 *  - the compile-leg + file-router-leg union that `prism refresh`/`plan`
 *    hand-assembles per plugin.
 *
 * Both the CLI and the plugins TUI need them, so they are extracted here as the
 * single source of truth. The key difference from the CLI's private helpers:
 * `planAllForPlugin` SURVEYS every targeted harness independently and never
 * aborts on the first compile failure — the TUI must show per-harness state for
 * all harnesses, not stop at the first broken one.
 */

import { join } from "node:path";
import { Effect } from "effect";
import {
  type CompileResult,
  compilePluginForTarget,
} from "./compile/pipeline.js";
import {
  BlockedTargetError,
  describePrismCause,
  type PrismCauseDescription,
} from "./errors.js";
import { exists, expandPath } from "./fs.js";
import { getAllHarnessIds } from "./harnesses.js";
import { manifestHasCompileTargets } from "./manifest.js";
import { resolvePrismHome } from "./prism-home.js";
import { refreshPlugin, refreshTargetedHarnesses } from "./refresh.js";
import type { HarnessRootsEnv } from "./services/prism-env.js";
import type { SyncOpFailure, SyncOpListener, SyncReport } from "./sync/apply.js";
import type { SyncOp } from "./sync/plan.js";
import { blockedTargetErrors } from "./sync/run.js";
import type { HarnessId, HarnessScope, PluginManifest } from "./types.js";

/**
 * One-level scan: the immediate child directories of `dir` that contain a
 * `plugin.json`. Mirrors the original private `cli.ts` helper exactly.
 */
export const discoverPluginPaths = async (dir: string): Promise<string[]> => {
  const expandedDir = expandPath(dir);
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(expandedDir, { withFileTypes: true });
  const pluginPaths: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const potentialPluginPath = join(expandedDir, entry.name);
    if (await exists(join(potentialPluginPath, "plugin.json"))) {
      pluginPaths.push(potentialPluginPath);
    }
  }

  return pluginPaths.sort((a, b) => a.localeCompare(b));
};

/** Every harness a plugin targets, via either compile-phase or file-router artifacts. */
export const pluginTargetedHarnesses = (manifest: PluginManifest): HarnessId[] => {
  const all = getAllHarnessIds();
  const targeted = new Set<HarnessId>(refreshTargetedHarnesses({ manifest, harnesses: all }));
  for (const harness of all) {
    if (manifestHasCompileTargets(manifest, harness)) targeted.add(harness);
  }
  return all.filter((harness) => targeted.has(harness));
};

/** Result of the compile leg for a single harness. */
export type CompileLeg =
  | { readonly ok: true; readonly result: CompileResult }
  | { readonly ok: false; readonly error: PrismCauseDescription };

/** The unioned plan for one harness (compile leg + file-router leg). */
export interface HarnessPlan {
  readonly harness: HarnessId;
  readonly hasCompileLeg: boolean;
  readonly hasFileRouterLeg: boolean;
  /** Present iff the plugin has compile-phase targets for this harness. */
  readonly compile?: CompileLeg;
  /** File-router sync reports (one per root, e.g. global + project). */
  readonly fileRouter: ReadonlyArray<SyncReport>;
  /** Compile-failed before any plan could be produced (typed compile error). */
  readonly compileFailed: boolean;
  /** Unioned sync ops across both legs. */
  readonly ops: ReadonlyArray<SyncOp>;
  readonly blocked: ReadonlyArray<BlockedTargetError>;
  readonly failures: ReadonlyArray<SyncOpFailure>;
  /** True when nothing would be written for this harness (and no compile error). */
  readonly converged: boolean;
}

export interface PluginPlan {
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly scope: HarnessScope;
  readonly harnesses: ReadonlyArray<HarnessPlan>;
}

export interface PlanAllOptions {
  readonly pluginPath: string;
  readonly manifest: PluginManifest;
  /** Candidate harnesses to probe; filtered to those the plugin actually targets. */
  readonly harnesses: ReadonlyArray<HarnessId>;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  /** Defaults to `resolvePrismHome()`. */
  readonly prismHome?: string;
  /** `true` = inspect (no writes); `false` = real refresh. */
  readonly dryRun: boolean;
  /** Per-op progress listener; fires only when `dryRun` is false. */
  readonly onOp?: SyncOpListener;
  /** Optional harness-root resolver (file-router leg); for sandboxed runs/tests. */
  readonly roots?: HarnessRootsEnv;
}

/**
 * Plan (or apply, when `dryRun` is false) the full install of one plugin across
 * the harnesses it targets, unioning the compile leg and the file-router leg.
 *
 * Compile-first then file-router, matching `prism refresh`. Unlike the CLI, a
 * failing compile leg for one harness does not abort the others — each harness
 * is surveyed independently so the caller can render a complete status matrix.
 */
export const planAllForPlugin = async (options: PlanAllOptions): Promise<PluginPlan> => {
  const pluginPath = expandPath(options.pluginPath);
  const prismHome = options.prismHome ?? resolvePrismHome();
  const candidates = options.harnesses;

  // ── Compile leg: per compile-targeted harness, surveyed independently. ──
  const compileByHarness = new Map<HarnessId, CompileLeg>();
  for (const harness of candidates) {
    if (!manifestHasCompileTargets(options.manifest, harness)) continue;
    const exit = await Effect.runPromiseExit(
      compilePluginForTarget({
        pluginPath,
        target: harness,
        scope: options.scope,
        ...(options.projectPath ? { projectPath: options.projectPath } : {}),
        prismHome,
        dryRun: options.dryRun,
        ...(options.onOp ? { onOp: options.onOp } : {}),
      }),
    );
    compileByHarness.set(
      harness,
      exit._tag === "Success"
        ? { ok: true, result: exit.value }
        : { ok: false, error: describePrismCause(exit.cause) },
    );
  }

  // ── File-router leg: rules/commands/skills across all targeted harnesses. ──
  const fileRouterHarnesses = refreshTargetedHarnesses({
    manifest: options.manifest,
    harnesses: candidates,
  });
  const fileRouterByHarness = new Map<HarnessId, SyncReport[]>();
  if (fileRouterHarnesses.length > 0) {
    const refreshResult = await refreshPlugin({
      pluginPath,
      harnesses: fileRouterHarnesses,
      ...(options.projectPath ? { projectPath: options.projectPath } : {}),
      prismHome,
      overwrite: false,
      dryRun: options.dryRun,
      ...(options.onOp ? { onOp: options.onOp } : {}),
      ...(options.roots ? { roots: options.roots } : {}),
    });
    for (const report of refreshResult.reports) {
      const harness = report.harness as HarnessId;
      const list = fileRouterByHarness.get(harness) ?? [];
      list.push(report);
      fileRouterByHarness.set(harness, list);
    }
  }

  // ── Merge per harness (union of compile- and file-router-targeted). ──
  const harnessPlans: HarnessPlan[] = candidates
    .filter((harness) => compileByHarness.has(harness) || fileRouterByHarness.has(harness))
    .map((harness) => {
      const compile = compileByHarness.get(harness);
      const fileRouter = fileRouterByHarness.get(harness) ?? [];
      const compileFailed = compile?.ok === false;

      const compileOps = compile?.ok ? compile.result.operations : [];
      const compileBlocked = compile?.ok ? compile.result.blocked : [];
      const compileFailures = compile?.ok ? compile.result.failures : [];

      const ops: SyncOp[] = [...compileOps, ...fileRouter.flatMap((report) => report.ops)];
      const blocked: BlockedTargetError[] = [
        ...compileBlocked,
        ...fileRouter.flatMap(blockedTargetErrors),
      ];
      const failures: SyncOpFailure[] = [
        ...compileFailures,
        ...fileRouter.flatMap((report) => report.failures),
      ];

      const converged =
        !compileFailed &&
        (compile?.ok ? compile.result.converged : true) &&
        fileRouter.every((report) => report.converged);

      return {
        harness,
        hasCompileLeg: compile !== undefined,
        hasFileRouterLeg: fileRouter.length > 0,
        ...(compile ? { compile } : {}),
        fileRouter,
        compileFailed,
        ops,
        blocked,
        failures,
        converged,
      };
    });

  return {
    pluginName: options.manifest.name,
    pluginVersion: options.manifest.version,
    scope: options.scope,
    harnesses: harnessPlans,
  };
};
