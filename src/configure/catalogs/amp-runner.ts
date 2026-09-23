import type { HarnessCatalog } from "./types.js";

/**
 * Amp Runner is Amp executing on an operator-declared runner, not a local Amp home.
 * Researched 2026-09-22 from `amp --help`, `amp runner list`, and live runner
 * dispatch (`amp --execute … --executor runner:<id> --runner-dir <dir>`).
 */
export const ampRunnerCatalog: HarnessCatalog = {
  harness: "amp-runner",
  displayName: "Amp Runner",
  binaryNames: ["amp"],
  binaryEnvVars: ["PRISM_WORKFLOW_AMP_BIN"],
  globalRoot: "~/.prism/amp-runner/",
  projectRoot: null,
  settingsFiles: [],
  scanDirs: [],
  prismNamespaceMarkers: [],
  fields: [],
  refresh: {
    lastResearched: "2026-09-22",
    procedure: [
      "Run `amp --help` and confirm `--executor runner:<id>`, `--runner-dir`, and `threads continue --orb-execute` still exist",
      "Run `amp runner list` and confirm runners are declared with `amp --no-tui --runner-id <id>`",
      "Dispatch a trivial `--stream-json` task to a runner and confirm the result/session_id JSONL shape",
    ],
    sources: [
      "amp --help",
      "amp runner list",
      "src/workflow-amp-remote-worker.ts",
    ],
  },
  notes: [
    "Workflow-worker only. No install surface: runners execute in existing checkouts whose own harness targets own install.",
    "Placeholder global root ~/.prism/amp-runner/ is never written.",
    "Excluded from --all and from installed-harness auto-detect because it has no install surface.",
    "Runner ids are operator-declared (`amp --no-tui --runner-id <id>`); the CLI has no cross-machine runner listing.",
  ],
};
