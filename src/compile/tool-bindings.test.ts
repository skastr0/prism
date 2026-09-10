import { expect, test } from "bun:test";
import type { ResolvedContractBinding } from "./resolve.js";
import {
  bindingsFromCanonicalTools,
  bindingsOwnedByPlugin,
  groupBindingsByOwner,
  ownerPluginForBinding,
} from "./tool-bindings.js";
import { makeTool } from "./test-support.js";

const binding = (
  toolPluginName: string,
  toolName: string,
): ResolvedContractBinding => ({
  logicalName: toolName,
  toolPluginName,
  toolName,
  toolSourcePath: `/tmp/${toolPluginName}/tools/${toolName}.tool.ts`,
});

test("ownerPluginForBinding is the binding's tool plugin", () => {
  expect(ownerPluginForBinding(binding("tower", "claim_glyph"))).toBe("tower");
});

test("bindingsOwnedByPlugin keeps only canonical tools owned by the plugin", () => {
  const tools = [
    makeTool({ name: "claim_glyph", sourcePath: "/tmp/tower/tools/claim_glyph.tool.ts" }),
    makeTool({ name: "register_draft", sourcePath: "/tmp/booth/tools/register_draft.tool.ts" }),
  ];

  expect(bindingsOwnedByPlugin("atelier", []).map((entry) => entry.toolName)).toEqual([]);
  expect(
    bindingsOwnedByPlugin("tower", [tools[0]!]).map((entry) => entry.toolName),
  ).toEqual(["claim_glyph"]);
});

test("bindingsFromCanonicalTools sorts by tool name", () => {
  const tools = [
    makeTool({ name: "zeta", sourcePath: "/tmp/tower/tools/zeta.tool.ts" }),
    makeTool({ name: "alpha", sourcePath: "/tmp/tower/tools/alpha.tool.ts" }),
  ];
  expect(
    bindingsFromCanonicalTools("tower", tools).map((entry) => entry.toolName),
  ).toEqual(["alpha", "zeta"]);
});

test("groupBindingsByOwner groups bindings by executable owner", () => {
  const groups = groupBindingsByOwner([
    binding("tower", "claim_glyph"),
    binding("tower", "submit_work"),
    binding("booth", "register_draft"),
    binding("quasar", "search"),
  ]);

  expect([...groups.keys()]).toEqual(["booth", "quasar", "tower"]);
  expect(groups.get("tower")?.map((entry) => entry.toolName)).toEqual([
    "claim_glyph",
    "submit_work",
  ]);
});
