import type { HarnessCatalog } from "./types.js";
import { opencodeCatalog } from "./opencode.js";

/**
 * OpenCode 2 settings catalogue — same shared home as OpenCode 1.x
 * (`~/.config/opencode/`) until V1/V2 consolidate. Detected by the
 * `opencode2` binary, not by that shared config root.
 */
export const opencode2Catalog: HarnessCatalog = {
  ...opencodeCatalog,
  harness: "opencode2",
  displayName: "OpenCode 2",
  binaryNames: ["opencode2"],
  binaryEnvVars: ["PRISM_WORKFLOW_OPENCODE2_BIN"],
  refresh: {
    lastResearched: "2026-09-11",
    procedure: [
      "Run `opencode2 --help` and `opencode2 run --help` (note --model, --format json, --auto; no --dir, no --dangerously-skip-permissions)",
      "Confirm the binary is `opencode2` on PATH (do not treat ~/.config/opencode/ as V2-only)",
      "Read ~/.config/opencode/opencode.json top-level keys (redact mcp.*.environment, provider.*.options.apiKey)",
      "Read ~/.config/opencode/tui.json",
      "Confirm Prism still reuses the OpenCode 1.x lowerer (src/compile/lowerers/opencode.ts)",
      "Update fields[] and lastResearched",
    ],
    sources: [
      "opencode2 --help",
      "opencode2 run --help",
      "~/.config/opencode/opencode.json",
      "~/.config/opencode/tui.json",
      "src/harnesses.ts",
      "src/lowerer-capabilities.ts",
      "src/compile/lowerers/opencode.ts",
      "src/workflow-opencode-worker.ts",
    ],
  },
  notes: [
    "Shares ~/.config/opencode/ with OpenCode 1.x until they consolidate. Do not convert opencode.json to native V2 while 1.x is still in daily use.",
    "Detected by `opencode2` on PATH (or PRISM_WORKFLOW_OPENCODE2_BIN), not by the shared config root. coding-harness targets opencode2, not opencode.",
    "Prism does not whole-file own opencode.json. Regions: agent.<name>.<compiler-key>, plugin[] members for prism-generated-*, permission.<ns>_* deny.",
    "Compile reuses the OpenCode 1.x lowerer for agents/<name>.md, skills/<sop>/SKILL.md, and plugins/prism-generated-<plugin>/dist/server.mjs.",
    "Workflow worker: PRISM_WORKFLOW_OPENCODE2_BIN or `opencode2`; args `run --format json [--model] [--auto]`. No `--dir` (process cwd). Never falls back to `opencode`.",
    "MCP env blocks and provider apiKey are secrets — never display raw.",
  ],
};
