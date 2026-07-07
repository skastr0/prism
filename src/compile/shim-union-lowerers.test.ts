/**
 * Shared-shim union rendering: codex-cli / hermes / cursor hold ONE shim
 * config region per harness root; grok holds ONE region PER MCP-owning
 * plugin (`pluginServerKey(owner)`), rendered from the SAME recorded prior
 * exposure ∪ own contribution — so every lowerer must render byte-identical
 * output regardless of which plugin compiles, never narrowed to the
 * compiling plugin's own view, and still emit whatever the union still needs
 * when the compiling plugin itself contributes nothing.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { pluginServerKey, renderAllowlist, shimServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
import { mcpToolNameForBinding } from "./mcp-bundle.js";
import { bindingFromToolSource } from "./tool-bindings.js";
import { CanonicalTool } from "./sources.js";
import { planLowering as planCodexLowering } from "./lowerers/codex-cli.js";
import { planLowering as planHermesLowering } from "./lowerers/hermes.js";
import { planLowering as planCursorLowering } from "./lowerers/cursor.js";
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

const wireName = (
  harness: "codex-cli" | "hermes",
  plugin: string,
  pluginRoot: string,
  toolName: string,
): string =>
  renderAllowlist(
    harness,
    plugin,
    mcpToolNameForBinding(
      plugin,
      bindingFromToolSource(plugin, join(pluginRoot, "tools", `${toolName}.tool.ts`)),
    ),
  );

const markerRegion = (
  regions: ReadonlyArray<DesiredRegion>,
  regionKey: string,
): Extract<DesiredRegion, { kind: "marker" }> => {
  const region = regions.find((candidate) => candidate.regionKey === regionKey);
  if (!region || region.kind !== "marker") throw new Error(`expected marker region ${regionKey}`);
  return region;
};

// ---------------------------------------------------------------------------
// codex-cli
// ---------------------------------------------------------------------------

const planCodexFor = async (options: {
  readonly root: string;
  readonly plugin: string;
  readonly toolName?: string;
  readonly prior?: ShimExposureContribution;
}) => {
  const pluginRoot = join(options.root, options.plugin);
  return planCodexLowering({
    agents: [],
    orbits: [],
    tools: options.toolName ? [fixtureTool(pluginRoot, options.toolName)] : [],
    skills: [],
    hooks: [],
    target: {
      scope: "global",
      root: join(options.root, ".codex"),
      sourcePluginName: options.plugin,
      sourcePluginVersion: "0.1.0",
      ...(options.prior ? { priorShimExposure: options.prior } : {}),
    },
  });
};

test("codex shim region renders the sorted union of prior exposure and own contribution", async () => {
  const root = "/tmp/prism-shim-union-fixture";
  const alphaWire = wireName("codex-cli", "alpha", join(root, "alpha"), "alpha_tool");
  const betaWire = wireName("codex-cli", "beta", join(root, "beta"), "beta_tool");
  const regionKey = `codex.mcp.${shimServerKey("codex-cli")}`;

  const fromAlpha = await planCodexFor({
    root,
    plugin: "alpha",
    toolName: "alpha_tool",
    prior: { plugins: ["beta"], enabledTools: [betaWire] },
  });
  const fromBeta = await planCodexFor({
    root,
    plugin: "beta",
    toolName: "beta_tool",
    prior: { plugins: ["alpha"], enabledTools: [alphaWire] },
  });

  const alphaRegion = markerRegion(fromAlpha.regions, regionKey);
  const betaRegion = markerRegion(fromBeta.regions, regionKey);

  // Byte-identical regardless of which plugin triggered the compile.
  expect(alphaRegion.content).toBe(betaRegion.content);
  expect(alphaRegion.plugin).toBe(SHIM_REGION_OWNER);
  expect(alphaRegion.content).toContain('PRISM_SHIM_PLUGINS = "alpha,beta"');
  const sortedWires = [alphaWire, betaWire].sort((a, b) => a.localeCompare(b));
  expect(alphaRegion.content).toContain(
    `enabled_tools = [${sortedWires.map((wire) => JSON.stringify(wire)).join(", ")}]`,
  );
  expect(alphaRegion.content).not.toContain("PRISM_SHIM_EXPOSURE");

  // Own contribution reported for the registry — own view only, not the union.
  expect(fromAlpha.shimContribution).toEqual({ plugins: ["alpha"], enabledTools: [alphaWire] });
  expect(fromBeta.shimContribution).toEqual({ plugins: ["beta"], enabledTools: [betaWire] });
});

test("codex emits the shim region from prior exposure even with an empty own contribution", async () => {
  const root = "/tmp/prism-shim-union-fixture";
  const betaWire = wireName("codex-cli", "beta", join(root, "beta"), "beta_tool");

  const lowered = await planCodexFor({
    root,
    plugin: "alpha",
    prior: { plugins: ["beta"], enabledTools: [betaWire] },
  });

  const region = markerRegion(lowered.regions, `codex.mcp.${shimServerKey("codex-cli")}`);
  expect(region.content).toContain('PRISM_SHIM_PLUGINS = "beta"');
  expect(region.content).toContain(`enabled_tools = [${JSON.stringify(betaWire)}]`);
  // Empty own contribution → the pipeline deletes alpha's registry entry.
  expect(lowered.shimContribution).toEqual({ plugins: [], enabledTools: [] });
});

test("codex emits no shim region when both prior and own are empty", async () => {
  const lowered = await planCodexFor({
    root: "/tmp/prism-shim-union-fixture",
    plugin: "alpha",
    prior: { plugins: [], enabledTools: [] },
  });
  expect(
    lowered.regions.find((region) => region.regionKey === `codex.mcp.${shimServerKey("codex-cli")}`),
  ).toBeUndefined();
  expect(lowered.shimContribution).toEqual({ plugins: [], enabledTools: [] });
});

// ---------------------------------------------------------------------------
// hermes
// ---------------------------------------------------------------------------

const planHermesFor = async (options: {
  readonly root: string;
  readonly plugin: string;
  readonly toolName?: string;
  readonly prior?: ShimExposureContribution;
}) => {
  const pluginRoot = join(options.root, options.plugin);
  return planHermesLowering({
    agents: [],
    orbits: [],
    tools: options.toolName ? [fixtureTool(pluginRoot, options.toolName)] : [],
    skills: [],
    hooks: [],
    target: {
      scope: "global",
      root: join(options.root, ".hermes"),
      sourcePluginName: options.plugin,
      sourcePluginVersion: "0.1.0",
      ...(options.prior ? { priorShimExposure: options.prior } : {}),
    },
  });
};

test("hermes shim region renders the sorted union and stays byte-identical across compilers", async () => {
  const root = "/tmp/prism-shim-union-fixture";
  const alphaWire = wireName("hermes", "alpha", join(root, "alpha"), "alpha_tool");
  const betaWire = wireName("hermes", "beta", join(root, "beta"), "beta_tool");
  const regionKey = `hermes.mcp.${shimServerKey("hermes")}`;

  const fromAlpha = await planHermesFor({
    root,
    plugin: "alpha",
    toolName: "alpha_tool",
    prior: { plugins: ["beta"], enabledTools: [betaWire] },
  });
  const fromBeta = await planHermesFor({
    root,
    plugin: "beta",
    toolName: "beta_tool",
    prior: { plugins: ["alpha"], enabledTools: [alphaWire] },
  });

  const alphaRegion = markerRegion(fromAlpha.regions, regionKey);
  expect(alphaRegion.content).toBe(markerRegion(fromBeta.regions, regionKey).content);
  expect(alphaRegion.plugin).toBe(SHIM_REGION_OWNER);
  expect(alphaRegion.content).toContain('PRISM_SHIM_PLUGINS: "alpha,beta"');
  for (const wire of [alphaWire, betaWire]) {
    expect(alphaRegion.content).toContain(`        - ${JSON.stringify(wire)}`);
  }
  expect(alphaRegion.content).not.toContain("PRISM_SHIM_EXPOSURE");
  expect(fromAlpha.shimContribution).toEqual({ plugins: ["alpha"], enabledTools: [alphaWire] });
});

test("hermes emits the shim region from prior exposure even with an empty own contribution", async () => {
  const root = "/tmp/prism-shim-union-fixture";
  const betaWire = wireName("hermes", "beta", join(root, "beta"), "beta_tool");
  const lowered = await planHermesFor({
    root,
    plugin: "alpha",
    prior: { plugins: ["beta"], enabledTools: [betaWire] },
  });
  const region = markerRegion(lowered.regions, `hermes.mcp.${shimServerKey("hermes")}`);
  expect(region.content).toContain('PRISM_SHIM_PLUGINS: "beta"');
  expect(lowered.shimContribution).toEqual({ plugins: [], enabledTools: [] });
});

// ---------------------------------------------------------------------------
// cursor
// ---------------------------------------------------------------------------

const planCursorFor = async (options: {
  readonly root: string;
  readonly plugin: string;
  readonly toolName?: string;
  readonly prior?: ShimExposureContribution;
}) => {
  const pluginRoot = join(options.root, options.plugin);
  return planCursorLowering({
    agents: [],
    orbits: [],
    tools: options.toolName ? [fixtureTool(pluginRoot, options.toolName)] : [],
    target: {
      scope: "global",
      root: join(options.root, ".cursor"),
      sourcePluginName: options.plugin,
      sourcePluginVersion: "0.1.0",
      ...(options.prior ? { priorShimExposure: options.prior } : {}),
    },
  });
};

test("cursor shim entry unions PRISM_SHIM_PLUGINS instead of hardcoding the compiling plugin", async () => {
  const root = "/tmp/prism-shim-union-fixture";
  const fromAlpha = await planCursorFor({
    root,
    plugin: "alpha",
    toolName: "alpha_tool",
    prior: { plugins: ["beta"], enabledTools: [] },
  });
  const fromBeta = await planCursorFor({
    root,
    plugin: "beta",
    toolName: "beta_tool",
    prior: { plugins: ["alpha"], enabledTools: [] },
  });

  const regionOf = (regions: ReadonlyArray<DesiredRegion>) => {
    const region = regions.find(
      (candidate) => candidate.regionKey === `mcpServers.${shimServerKey("cursor")}`,
    );
    if (!region || region.kind !== "json-key") throw new Error("expected json-key region");
    return region;
  };

  const alphaRegion = regionOf(fromAlpha.regions);
  const betaRegion = regionOf(fromBeta.regions);
  expect(alphaRegion.value).toEqual(betaRegion.value);
  expect(alphaRegion.plugin).toBe(SHIM_REGION_OWNER);
  expect(alphaRegion.value).toEqual({
    command: "prism",
    args: ["mcp", "shim"],
    env: {
      PRISM_SHIM_PLUGINS: "alpha,beta",
      PRISM_SHIM_HARNESS: "cursor",
    },
  });
  expect(fromAlpha.shimContribution).toEqual({ plugins: ["alpha"], enabledTools: [] });
});

test("cursor emits the shim entry from prior exposure even with an empty own contribution", async () => {
  const lowered = await planCursorFor({
    root: "/tmp/prism-shim-union-fixture",
    plugin: "alpha",
    prior: { plugins: ["beta"], enabledTools: [] },
  });
  const region = lowered.regions.find(
    (candidate) => candidate.regionKey === `mcpServers.${shimServerKey("cursor")}`,
  );
  expect(region?.kind).toBe("json-key");
  if (region?.kind !== "json-key") throw new Error("unreachable");
  expect((region.value as { env: Record<string, string> }).env.PRISM_SHIM_PLUGINS).toBe("beta");
  expect(lowered.shimContribution).toEqual({ plugins: [], enabledTools: [] });
});

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

test("grok shim regions render one entry per owner, byte-identical across compilers", async () => {
  const root = "/tmp/prism-shim-union-fixture";
  const alphaRegionKey = `grok.mcp.${pluginServerKey("alpha")}`;
  const betaRegionKey = `grok.mcp.${pluginServerKey("beta")}`;

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

  // Every compile renders the FULL union as N per-owner regions, not just
  // its own — byte-identical per owner regardless of which plugin compiled.
  const alphaFromAlpha = markerRegion(fromAlpha.regions, alphaRegionKey);
  const alphaFromBeta = markerRegion(fromBeta.regions, alphaRegionKey);
  expect(alphaFromAlpha.content).toBe(alphaFromBeta.content);
  expect(alphaFromAlpha.plugin).toBe("alpha");
  expect(alphaFromAlpha.content).toContain('PRISM_SHIM_PLUGINS = "alpha"');
  expect(alphaFromAlpha.content).toContain('PRISM_SHIM_HARNESS = "grok"');
  expect(alphaFromAlpha.content).toContain('PRISM_SHIM_NAMING = "per-plugin"');

  const betaFromAlpha = markerRegion(fromAlpha.regions, betaRegionKey);
  const betaFromBeta = markerRegion(fromBeta.regions, betaRegionKey);
  expect(betaFromAlpha.content).toBe(betaFromBeta.content);
  expect(betaFromAlpha.plugin).toBe("beta");
  expect(betaFromAlpha.content).toContain('PRISM_SHIM_PLUGINS = "beta"');

  // No entry ever carries an exposure profile or a tool allowlist (agent
  // frontmatter gates exposure; absent PRISM_SHIM_EXPOSURE, the shim derives
  // the per-owner daemon profile itself).
  expect(alphaFromAlpha.content).not.toContain("PRISM_SHIM_EXPOSURE");
  expect(alphaFromAlpha.content).not.toContain("enabled_tools");

  // Own contribution reported for the registry — own view only, not the union.
  expect(fromAlpha.shimContribution).toEqual({ plugins: ["alpha"], enabledTools: [] });
  expect(fromBeta.shimContribution).toEqual({ plugins: ["beta"], enabledTools: [] });
});

test("grok emits only the prior-exposure owner's region when its own contribution is empty", async () => {
  const lowered = await planGrokFor({
    root: "/tmp/prism-shim-union-fixture",
    plugin: "alpha",
    prior: { plugins: ["beta"], enabledTools: [] },
  });

  const region = markerRegion(lowered.regions, `grok.mcp.${pluginServerKey("beta")}`);
  expect(region.content).toContain('PRISM_SHIM_PLUGINS = "beta"');
  expect(region.plugin).toBe("beta");
  // Alpha itself contributes nothing this compile and gets no region.
  expect(
    lowered.regions.find((r) => r.regionKey === `grok.mcp.${pluginServerKey("alpha")}`),
  ).toBeUndefined();
  // Empty own contribution → the pipeline deletes alpha's registry entry —
  // and the artifact-less compile plants no generated plugin bundle.
  expect(lowered.shimContribution).toEqual({ plugins: [], enabledTools: [] });
  expect(lowered.files).toHaveLength(0);
});

test("grok emits no shim regions when both prior and own are empty", async () => {
  const lowered = await planGrokFor({
    root: "/tmp/prism-shim-union-fixture",
    plugin: "alpha",
    prior: { plugins: [], enabledTools: [] },
  });
  expect(lowered.regions).toEqual([]);
  expect(lowered.shimContribution).toEqual({ plugins: [], enabledTools: [] });
});
