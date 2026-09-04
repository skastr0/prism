/**
 * Pure manifest → install preview transform.
 * No side effects, no async.
 */

import type { InstallPreview, InstallPreviewRow } from "./model.js";
import type { PluginManifest } from "../types.js";
import { COMPILE_ARTIFACT_TYPES } from "../types.js";
import { sourceSelectionFromManifestTargets } from "../source-selection.js";
import { formatManifestTargets } from "../manifest.js";

export function buildPreview(manifest: PluginManifest): InstallPreview {
  const selection = sourceSelectionFromManifestTargets(
    manifest.targets,
    manifest.runtime ? { runtime: manifest.runtime } : {},
  );

  const compileSet = new Set<string>(COMPILE_ARTIFACT_TYPES as readonly string[]);

  const rows: InstallPreviewRow[] = selection.entries.map((e) => {
    const isCompile = compileSet.has(e.noun);
    return {
      noun: e.noun,
      phase: isCompile ? "compile" : "install",
      harnesses: [...e.harnesses],
      compileManaged: isCompile,
    };
  });

  const targetsSummary = formatManifestTargets(manifest);

  return { rows, targetsSummary };
}
