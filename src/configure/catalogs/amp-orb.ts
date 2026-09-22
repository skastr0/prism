import type { HarnessCatalog } from "./types.js";

/**
 * Amp Orb is a hosted skills checkout, not a local Amp home.
 * Researched 2026-09-22 from amp skills repositories, amp clone, and
 * https://ampcode.com/docs/customize/skills.
 */
export const ampOrbCatalog: HarnessCatalog = {
  harness: "amp-orb",
  displayName: "Amp Orb",
  binaryNames: ["amp"],
  binaryEnvVars: [],
  globalRoot: "~/.prism/amp-orb/",
  projectRoot: null,
  settingsFiles: [],
  scanDirs: ["."],
  prismNamespaceMarkers: [],
  fields: [],
  refresh: {
    lastResearched: "2026-09-22",
    procedure: [
      "Run `amp skills repositories --json` and record cloneURL plus viewerCanWrite",
      "Confirm `amp clone user-skills` and `amp clone workspace-skills` still clone hosted skills repos",
      "Re-read hosted skill limits at https://ampcode.com/docs/customize/skills",
      "Confirm src/amp-orb-skills.ts still matches those limits and fails closed",
    ],
    sources: [
      "amp skills repositories --json",
      "amp clone --help",
      "https://ampcode.com/docs/customize/skills",
      "https://ampcode.com/docs/customize/global-plugins-and-skills",
      "src/amp-orb-skills.ts",
      "src/harnesses.ts",
    ],
  },
  notes: [
    "Skills only. Not a root alias of amp-code. No plugins, agents, tools, hooks, commands, or AGENTS.md.",
    "The checkout root is explicit (`prism refresh --harness amp-orb --root <clone>`). Scope is never inferred.",
    "Placeholder global root ~/.prism/amp-orb/ is not an Amp store. Refresh refuses it until --root names a real checkout.",
    "Hosted limits (200 skills, 200 files/skill, 10 MiB/file, 25 MiB/skill, 25 MiB/repo, text only, flat top-level dirs, name match) fail the plan. Nested text resources under a skill are allowed. These are not warnings.",
    "amp-orb is excluded from --all and from installed-harness auto-detect. It runs only with an explicit --harness amp-orb --root <checkout>.",
    "Clone, commit, push, and reload stay outside Prism.",
  ],
};
