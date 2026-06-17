import { expect, test } from "bun:test";
import type { ComposedAgent } from "./compose.js";
import type { ResolvedContractBinding } from "./resolve.js";
import {
  bindingIsOwnedByPlugin,
  bindingsOwnedByPlugin,
  groupBindingsByOwner,
  ownerPluginForBinding,
} from "./tool-bindings.js";

const permissionBinding = (
  toolPluginName: string,
  toolName: string,
): ResolvedContractBinding => ({
  kind: "permission",
  logicalName: toolName,
  toolPluginName,
  toolName,
  toolSourcePath: `/tmp/${toolPluginName}/tools/${toolName}.tool.ts`,
});

const syntheticBinding = (compilingPluginName: string): ResolvedContractBinding => ({
  kind: "synthetic",
  logicalName: "submit_review",
  toolPluginName: "tower",
  toolName: "submit_review",
  toolSourcePath: `/tmp/${compilingPluginName}/traits/reviewable.trait.ts`,
  contract: {
    name: "forge_submit_review__details",
    pluginName: compilingPluginName,
    sourcePath: `/tmp/${compilingPluginName}/traits/reviewable.trait.ts`,
  },
});

const agentWithBindings = (
  name: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ComposedAgent => ({
  name,
  description: name,
  body: name,
  color: undefined,
  model: {},
  targetOverride: {},
  skills: [],
  allowedSkills: [],
  allowedTools: [],
  toolBindings: bindings,
});

test("ownerPluginForBinding maps permission and synthetic bindings", () => {
  expect(ownerPluginForBinding("atelier", permissionBinding("tower", "claim_glyph"))).toBe("tower");
  expect(ownerPluginForBinding("forge", syntheticBinding("forge"))).toBe("forge");
});

test("bindingIsOwnedByPlugin treats synthetics and local permissions as owned", () => {
  expect(bindingIsOwnedByPlugin("atelier", permissionBinding("tower", "claim_glyph"))).toBe(false);
  expect(bindingIsOwnedByPlugin("tower", permissionBinding("tower", "claim_glyph"))).toBe(true);
  expect(bindingIsOwnedByPlugin("forge", syntheticBinding("forge"))).toBe(true);
});

test("bindingsOwnedByPlugin keeps only owned canonical and synthetic bindings", () => {
  const agents = [
    agentWithBindings("orchestrator", [
      permissionBinding("tower", "claim_glyph"),
      permissionBinding("booth", "register_draft"),
    ]),
  ];

  expect(
    bindingsOwnedByPlugin("atelier", [], agents).map((binding) => binding.toolName),
  ).toEqual([]);
  expect(
    bindingsOwnedByPlugin(
      "tower",
      [],
      [agentWithBindings("worker", [permissionBinding("tower", "claim_glyph")])],
    ).map((binding) => binding.toolName),
  ).toEqual(["claim_glyph"]);
  expect(
    bindingsOwnedByPlugin("forge", [], [agentWithBindings("builder", [syntheticBinding("forge")])])
      .map((binding) => binding.kind),
  ).toEqual(["synthetic"]);
});

test("groupBindingsByOwner groups consumer agent bindings by executable owner", () => {
  const groups = groupBindingsByOwner("atelier", [
    permissionBinding("tower", "claim_glyph"),
    permissionBinding("tower", "submit_work"),
    permissionBinding("booth", "register_draft"),
    permissionBinding("quasar", "search"),
  ]);

  expect([...groups.keys()]).toEqual(["booth", "quasar", "tower"]);
  expect(groups.get("tower")?.map((binding) => binding.toolName)).toEqual([
    "claim_glyph",
    "submit_work",
  ]);
});