/**
 * Shared-shim union rendering: grok holds ONE shim config region per harness
 * root, so its lowerer must render the union of the recorded prior exposure
 * (other installed plugins) and its own contribution — byte-identical
 * regardless of which plugin compiles, never narrowed to the compiling
 * plugin's own view, and still emitted when the compiling plugin itself
 * contributes nothing.
 *
 * codex-cli / hermes / cursor moved off this shared-union shape to
 * per-owner-plugin server regions (see
 * `src/compile/single-config-per-plugin-mcp.test.ts`); this file now covers
 * grok only.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { shimServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
import { CanonicalTool } from "./sources.js";
import { planLowering as planGrokLowering } from "./lowerers/grok.js";
import { SHIM_REGION_OWNER, type ShimExposureContribution } from "./lowerers/shared.js";
import type { DesiredRegion } from "../sync/desired.js";

const fixtureTool = (pluginRoot: string, toolName: string): CanonicalTool =>
  new CanonicalTool({
    name: toolName,
    sourcePath: join(pluginRoot, "tools", `${toolName}.tool.ts`),
    description: `${toolName} fixture tool`,
    input: {},
    output: {},
    slots: {},
    handle: () => ({}),
  });

const markerRegion = (
  regions: ReadonlyArray<DesiredRegion>,
  regionKey: string,
): Extract<DesiredRegion, { kind: "marker" }> => {
  const region = regions.find((candidate) => candidate.regionKey === regionKey);
  if (!region || region.kind !== "marker") throw new Error(`expected marker region ${regionKey}`);
  return region;
};

// ---------------------------------------------------------------------------
// grok
// ---------------------------------------------------------------------------

const planGrokFor = async (options: {
  readonly root: string;
  readonly plugin: string;
  readonly toolName?: string;
  readonly prior?: ShimExposureContribution;
}) => {
  const pluginRoot = join(options.root, options.plugin);
  return planGrokLowering({
    agents: [],
    orbits: [],
    tools: options.toolName ? [fixtureTool(pluginRoot, options.toolName)] : [],
    skills: [],
    hooks: [],
    target: {
      scope: "global",
      root: join(options.root, ".grok"),
      sourcePluginName: options.plugin,
      sourcePluginVersion: "0.1.0",
      ...(options.prior ? { priorShimExposure: options.prior } : {}),
    },
  });
};

test("grok shim region renders the sorted plugin union and stays byte-identical across compilers", async () => {
  const root = "/tmp/prism-shim-union-fixture";
  const regionKey = `grok.mcp.${shimServerKey("grok")}`;

  const fromAlpha = await planGrokFor({
    root,
    plugin: "alpha",
    toolName: "alpha_tool",
    prior: { plugins: ["beta"], enabledTools: [] },
  });
  const fromBeta = await planGrokFor({
    root,
    plugin: "beta",
    toolName: "beta_tool",
    prior: { plugins: ["alpha"], enabledTools: [] },
  });

  const alphaRegion = markerRegion(fromAlpha.regions, regionKey);
  const betaRegion = markerRegion(fromBeta.regions, regionKey);

  // Byte-identical regardless of which plugin triggered the compile.
  expect(alphaRegion.content).toBe(betaRegion.content);
  expect(alphaRegion.plugin).toBe(SHIM_REGION_OWNER);
  expect(alphaRegion.content).toContain('PRISM_SHIM_PLUGINS = "alpha,beta"');
  expect(alphaRegion.content).toContain('PRISM_SHIM_HARNESS = "grok"');
  // The union cannot name one plugin's exposure profile, and grok's server
  // table carries no tool allowlist (agent frontmatter gates exposure).
  expect(alphaRegion.content).not.toContain("PRISM_SHIM_EXPOSURE");
  expect(alphaRegion.content).not.toContain("enabled_tools");

  // Own contribution reported for the registry — own view only, not the union.
  expect(fromAlpha.shimContribution).toEqual({ plugins: ["alpha"], enabledTools: [] });
  expect(fromBeta.shimContribution).toEqual({ plugins: ["beta"], enabledTools: [] });
});

test("grok emits the shim region from prior exposure even with an empty own contribution", async () => {
  const lowered = await planGrokFor({
    root: "/tmp/prism-shim-union-fixture",
    plugin: "alpha",
    prior: { plugins: ["beta"], enabledTools: [] },
  });

  const region = markerRegion(lowered.regions, `grok.mcp.${shimServerKey("grok")}`);
  expect(region.content).toContain('PRISM_SHIM_PLUGINS = "beta"');
  // Empty own contribution → the pipeline deletes alpha's registry entry —
  // and the artifact-less compile plants no generated plugin bundle.
  expect(lowered.shimContribution).toEqual({ plugins: [], enabledTools: [] });
  expect(lowered.files).toHaveLength(0);
});

test("grok emits no shim region when both prior and own are empty", async () => {
  const lowered = await planGrokFor({
    root: "/tmp/prism-shim-union-fixture",
    plugin: "alpha",
    prior: { plugins: [], enabledTools: [] },
  });
  expect(
    lowered.regions.find((region) => region.regionKey === `grok.mcp.${shimServerKey("grok")}`),
  ).toBeUndefined();
  expect(lowered.shimContribution).toEqual({ plugins: [], enabledTools: [] });
});
