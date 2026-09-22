import { existsSync } from "node:fs";
import { getAllHarnessIds, getHarness, resolveHarnessRoot } from "./harnesses.js";
import type { HarnessId } from "./types.js";

/**
 * Detect installed harnesses from their registered global config roots.
 * Workflow binary availability is checked separately by the worker detector.
 */
export const detectInstalledHarnessIds = (): HarnessId[] =>
  getAllHarnessIds().filter((id) => {
    if (id === "amp-orb") return false;
    const root = resolveHarnessRoot(getHarness(id), "global");
    return root !== null && existsSync(root);
  });
