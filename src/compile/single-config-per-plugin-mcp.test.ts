/**
 * Per-plugin MCP server rendering for the single-config-file harness family:
 * codex-cli / hermes / cursor hold ONE `mcp_servers`-shaped global config
 * file, but each MCP-owning plugin now gets its OWN server entry keyed by
 * `pluginServerKey` (never `prism-mcp-shim`, never a cross-plugin union) —
 * a per-plugin shim server can only ever front one daemon, so only the real
 * owner's own compile renders (and the sync engine prunes) that entry.
 * Consumer plugins — ones that only reference a foreign owner's tools via
 * agent bindings — render no server entry at all.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { pluginServerKey, renderPluginAllowlist } from "@skastr0/prism-sdk/mcp/wire-naming";
import { mcpToolNameForBinding } from "./mcp-bundle.js";
import { bindingFromToolSource } from "./tool-bindings.js";
import { CanonicalTool } from "./sources.js";
import { planLowering as planCodexLowering } from "./lowerers/codex-cli.js";
import { planLowering as planHermesLowering } from "./lowerers/hermes.js";
import { planLowering as planCursorLowering } from "./lowerers/cursor.js";
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

const bareWire = (
  harness: "codex-cli" | "hermes",
  plugin: string,
  pluginRoot: string,
  toolName: string,
): string =>
  renderPluginAllowlist(
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
    },
  });
};

test("codex renders a distinct server region per owner plugin, bare wire names, no union", async () => {
  const root = "/tmp/prism-per-plugin-mcp-fixture";
  const alphaWire = bareWire("codex-cli", "alpha", join(root, "alpha"), "alpha_tool");
  const betaWire = bareWire("codex-cli", "beta", join(root, "beta"), "beta_tool");
  expect(alphaWire).toBe("alpha_tool");
  expect(betaWire).toBe("beta_tool");

  const fromAlpha = await planCodexFor({ root, plugin: "alpha", toolName: "alpha_tool" });
  const fromBeta = await planCodexFor({ root, plugin: "beta", toolName: "beta_tool" });

  const alphaServerKey = pluginServerKey("alpha");
  const betaServerKey = pluginServerKey("beta");
  const alphaRegion = markerRegion(fromAlpha.regions, `codex.mcp.${alphaServerKey}`);
  const betaRegion = markerRegion(fromBeta.regions, `codex.mcp.${betaServerKey}`);

  // Distinct region keys, distinct region owners — never the reserved
  // shared-shim owner, never a byte-identical cross-plugin fence.
  expect(alphaRegion.plugin).toBe("alpha");
  expect(betaRegion.plugin).toBe("beta");
  expect(alphaRegion.content).not.toBe(betaRegion.content);

  expect(alphaRegion.content).toContain(`["mcp_servers"."${alphaServerKey}"]`);
  expect(alphaRegion.content).toContain(`enabled_tools = ["${alphaWire}"]`);
  expect(alphaRegion.content).toContain('PRISM_SHIM_PLUGINS = "alpha"');
  expect(alphaRegion.content).toContain('PRISM_SHIM_NAMING = "per-plugin"');
  // alpha's server never mentions beta, and vice versa — no aggregation.
  expect(alphaRegion.content).not.toContain("beta");
  expect(betaRegion.content).not.toContain("alpha");
});

test("codex emits no server region for a plugin that owns no tools", async () => {
  const lowered = await planCodexFor({ root: "/tmp/prism-per-plugin-mcp-fixture", plugin: "alpha" });
  expect(lowered.regions.some((region) => region.regionKey.startsWith("codex.mcp."))).toBe(false);
});

// ---------------------------------------------------------------------------
// hermes
// ---------------------------------------------------------------------------

const planHermesFor = async (options: {
  readonly root: string;
  readonly plugin: string;
  readonly toolName?: string;
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
    },
  });
};

test("hermes renders a distinct mapping per owner plugin, bare wire names, no union", async () => {
  const root = "/tmp/prism-per-plugin-mcp-fixture";
  const alphaWire = bareWire("hermes", "alpha", join(root, "alpha"), "alpha_tool");

  const fromAlpha = await planHermesFor({ root, plugin: "alpha", toolName: "alpha_tool" });
  const fromBeta = await planHermesFor({ root, plugin: "beta", toolName: "beta_tool" });

  const alphaServerKey = pluginServerKey("alpha");
  const betaServerKey = pluginServerKey("beta");
  const alphaRegion = markerRegion(fromAlpha.regions, `hermes.mcp.${alphaServerKey}`);
  const betaRegion = markerRegion(fromBeta.regions, `hermes.mcp.${betaServerKey}`);

  expect(alphaRegion.plugin).toBe("alpha");
  expect(betaRegion.plugin).toBe("beta");
  expect(alphaRegion.content).toContain(`  ${alphaServerKey}:`);
  expect(alphaRegion.content).toContain(`        - ${JSON.stringify(alphaWire)}`);
  expect(alphaRegion.content).toContain('PRISM_SHIM_PLUGINS: "alpha"');
  expect(alphaRegion.content).toContain('PRISM_SHIM_NAMING: "per-plugin"');
  expect(alphaRegion.content).not.toContain("beta");
});

test("hermes emits no mapping for a plugin that owns no tools", async () => {
  const lowered = await planHermesFor({ root: "/tmp/prism-per-plugin-mcp-fixture", plugin: "alpha" });
  expect(lowered.regions.some((region) => region.regionKey.startsWith("hermes.mcp."))).toBe(false);
});

// ---------------------------------------------------------------------------
// cursor
// ---------------------------------------------------------------------------

const planCursorFor = async (options: {
  readonly root: string;
  readonly plugin: string;
  readonly toolName?: string;
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
    },
  });
};

test("cursor renders a distinct mcpServers entry per owner plugin, no union", async () => {
  const root = "/tmp/prism-per-plugin-mcp-fixture";
  const fromAlpha = await planCursorFor({ root, plugin: "alpha", toolName: "alpha_tool" });
  const fromBeta = await planCursorFor({ root, plugin: "beta", toolName: "beta_tool" });

  const alphaServerKey = pluginServerKey("alpha");
  const betaServerKey = pluginServerKey("beta");

  const regionOf = (regions: ReadonlyArray<DesiredRegion>, serverKey: string) => {
    const region = regions.find((candidate) => candidate.regionKey === `mcpServers.${serverKey}`);
    if (!region || region.kind !== "json-key") throw new Error("expected json-key region");
    return region;
  };

  const alphaRegion = regionOf(fromAlpha.regions, alphaServerKey);
  const betaRegion = regionOf(fromBeta.regions, betaServerKey);

  expect(alphaRegion.plugin).toBe("alpha");
  expect(betaRegion.plugin).toBe("beta");
  expect(alphaRegion.value).toEqual({
    command: "prism",
    args: ["mcp", "shim"],
    env: {
      PRISM_SHIM_PLUGINS: "alpha",
      PRISM_SHIM_HARNESS: "cursor",
      PRISM_SHIM_NAMING: "per-plugin",
    },
  });
  expect(betaRegion.value).toEqual({
    command: "prism",
    args: ["mcp", "shim"],
    env: {
      PRISM_SHIM_PLUGINS: "beta",
      PRISM_SHIM_HARNESS: "cursor",
      PRISM_SHIM_NAMING: "per-plugin",
    },
  });
});

test("cursor emits no entry for a plugin that owns no tools", async () => {
  const lowered = await planCursorFor({ root: "/tmp/prism-per-plugin-mcp-fixture", plugin: "alpha" });
  expect(lowered.regions.some((region) => region.regionKey.startsWith("mcpServers."))).toBe(false);
});
