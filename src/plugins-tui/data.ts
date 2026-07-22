/**
 * Impure async loaders that wrap prism APIs for the plugins TUI.
 * No side effects at module-load time; all side effects happen inside the
 * exported async functions.
 */

import { basename } from "node:path";
import { Effect } from "effect";
import type { DoctorReport } from "../doctor.js";
import { runDoctor } from "../doctor.js";
import {
  discoverPluginPaths,
  planAllForPlugin,
  pluginTargetedHarnesses,
} from "../plugin-inventory.js";
import { readManifest } from "../manifest.js";
import { loadPlugin } from "../compile/load.js";
import { buildIntrospection } from "./introspect.js";
import { resolvePrismHome } from "../prism-home.js";
import { readSnapshot } from "../state/store.js";
import { computeContentHash } from "../content-hash.js";
import { describePrismCause } from "../errors.js";
import { exists, readFile } from "../fs.js";
import type { SyncOpListener } from "../sync/apply.js";
import type {
  PluginRow,
  PluginPlan,
  IntrospectionResult,
  DriftDetail,
  HarnessScope,
  HarnessId,
} from "./model.js";
import type { PluginManifest } from "./model.js";

/**
 * Discover all plugins under `dir` and return a sorted list of rows.
 * Invalid (unreadable) manifests yield rows with `valid: false`.
 */
export const loadPluginRows = async (options: { dir: string }): Promise<PluginRow[]> => {
  const paths = await discoverPluginPaths(options.dir);
  const rows: PluginRow[] = await Promise.all(
    paths.map(async (pluginPath): Promise<PluginRow> => {
      try {
        const manifest = await readManifest(pluginPath);
        return {
          pluginPath,
          name: manifest.name,
          version: manifest.version ?? "",
          valid: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          pluginPath,
          name: basename(pluginPath),
          version: "",
          valid: false,
          manifestError: message,
        };
      }
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Plan the install of one plugin (dry-run: true) and return the plan.
 */
export const loadPluginPlan = async (options: {
  pluginPath: string;
  manifest: PluginManifest;
  scope: HarnessScope;
  projectPath?: string;
}): Promise<PluginPlan> => {
  return planAllForPlugin({
    pluginPath: options.pluginPath,
    manifest: options.manifest,
    harnesses: pluginTargetedHarnesses(options.manifest),
    scope: options.scope,
    ...(options.projectPath ? { projectPath: options.projectPath } : {}),
    dryRun: true,
  });
};

/**
 * Load the plugin registry via the compile pipeline and build an introspection summary.
 */
export const loadIntrospection = async (pluginPath: string): Promise<IntrospectionResult> => {
  const exit = await Effect.runPromiseExit(loadPlugin(pluginPath));
  if (exit._tag === "Success") {
    return { ok: true, value: buildIntrospection(exit.value) };
  }
  return { ok: false, error: describePrismCause(exit.cause) };
};

/**
 * Run the prism doctor for a plugin and return the report.
 */
export const loadDoctorReport = async (options: {
  pluginPath: string;
  harnesses: ReadonlyArray<HarnessId>;
  scope: HarnessScope;
  projectPath?: string;
}): Promise<DoctorReport> => {
  const prismHome = resolvePrismHome();
  return runDoctor({
    pluginPath: options.pluginPath,
    harnesses: options.harnesses,
    scope: options.scope,
    ...(options.projectPath ? { projectPath: options.projectPath } : {}),
    prismHome,
    fix: false,
  });
};


/**
 * Compute drift detail for a single tracked file: compare the snapshot hash
 * against the current on-disk hash.
 */
export const loadDriftDetail = async (options: {
  harness: string;
  root: string;
  targetPath: string;
}): Promise<DriftDetail> => {
  const snap = await readSnapshot({
    prismHome: resolvePrismHome(),
    harness: options.harness,
    root: options.root,
  });
  const entry = snap.manifest.entries.find((e) => e.targetPath === options.targetPath);
  const snapshotHash = entry?.contentHash;
  const diskHash = (await exists(options.targetPath))
    ? computeContentHash(await readFile(options.targetPath))
    : undefined;
  return {
    targetPath: options.targetPath,
    ...(snapshotHash !== undefined ? { snapshotHash } : {}),
    ...(diskHash !== undefined ? { diskHash } : {}),
    ...(snap.quarantinedPath !== undefined ? { quarantinedPath: snap.quarantinedPath } : {}),
  };
};

/**
 * Apply a real refresh (dryRun: false) for a plugin and return the resulting plan.
 */
export const applyRefresh = async (options: {
  pluginPath: string;
  manifest: PluginManifest;
  scope: HarnessScope;
  projectPath?: string;
  onOp?: SyncOpListener;
}): Promise<PluginPlan> => {
  return planAllForPlugin({
    pluginPath: options.pluginPath,
    manifest: options.manifest,
    harnesses: pluginTargetedHarnesses(options.manifest),
    scope: options.scope,
    ...(options.projectPath ? { projectPath: options.projectPath } : {}),
    dryRun: false,
    ...(options.onOp ? { onOp: options.onOp } : {}),
  });
};
