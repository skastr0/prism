/** Cursor lowerer. */

import { join } from "node:path";
import { pluginServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ComposedAgent } from "../compose.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { bindingsOwnedByPlugin } from "../tool-bindings.js";
import type { HarnessScope } from "../../types.js";
import type { DesiredRegion } from "../../sync/desired.js";
import { type LowerOutput } from "./shared.js";

const TARGET_ID = "cursor" as const;

export interface CursorLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly mcpExposureProfile?: string;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
  readonly sourcePluginPath?: string;
}

export interface LowerInput {
  readonly agents: ReadonlyArray<ComposedAgent>;
  readonly orbits: ReadonlyArray<Orbit>;
  readonly tools: ReadonlyArray<CanonicalTool>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly hooks?: ReadonlyArray<Hook>;
  readonly registry?: PluginRegistry;
  readonly target: CursorLowerTarget;
}

type CursorMcpServerEntry = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
};

const configPath = (target: CursorLowerTarget): string =>
  join(target.root, "mcp.json");

/**
 * A per-owner-plugin entry — exactly one plugin in `PRISM_SHIM_PLUGINS`,
 * `PRISM_SHIM_NAMING: per-plugin` so the shim advertises its own
 * `pluginServerKey` identity (no `PRISM_SHIM_EXPOSURE`: the shim derives
 * that owner's daemon profile itself from the single configured plugin —
 * see `@skastr0/prism-sdk/mcp/shim.ts`). Cursor carries no tool allowlist
 * at all (`toolAllowlist: "unsupported"` in the harness MCP contract), so
 * there is nothing beyond command/args/env to render.
 */
const renderCursorMcpServerEntry = (plugin: string): CursorMcpServerEntry => ({
  command: "prism",
  args: ["mcp", "shim"],
  env: {
    PRISM_SHIM_PLUGINS: plugin,
    PRISM_SHIM_HARNESS: TARGET_ID,
    PRISM_SHIM_NAMING: "per-plugin",
  },
});

const assertCursorLoweringInput = (input: LowerInput): void => {
  if (input.agents.length > 0) {
    throw new Error(
      "Cursor lowerer received agents after target capability validation; this indicates a compiler planning bug.",
    );
  }
  if (input.orbits.length > 0) {
    throw new Error(
      "Cursor lowerer received orbits after target capability validation; this indicates a compiler planning bug.",
    );
  }
  if ((input.hooks?.length ?? 0) > 0) {
    throw new Error(
      "Cursor lowerer received hooks after target capability validation; this indicates a compiler planning bug.",
    );
  }
  if ((input.skills?.length ?? 0) > 0) {
    throw new Error(
      "Cursor lowerer received skills after target capability validation; this indicates a compiler planning bug.",
    );
  }
};

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  assertCursorLoweringInput(input);
  const sourcePluginName = input.target.sourcePluginName;
  const ownedBindings = bindingsOwnedByPlugin(sourcePluginName, input.tools, input.agents);

  const regions: DesiredRegion[] = [];

  // A per-plugin server can only ever front ONE daemon, so this plugin's
  // compile renders `mcpServers.<pluginServerKey>` iff IT is a real MCP
  // owner — region-owned by this plugin (no cross-plugin union): the sync
  // engine prunes the entry the moment this plugin stops being an owner.
  if (ownedBindings.length > 0) {
    const serverName = pluginServerKey(sourcePluginName);
    regions.push({
      kind: "json-key",
      targetPath: configPath(input.target),
      regionKey: `mcpServers.${serverName}`,
      jsonPath: ["mcpServers", serverName],
      value: renderCursorMcpServerEntry(sourcePluginName),
      plugin: sourcePluginName,
    });
  }

  // Entries are per-plugin — no cross-plugin coordination needed.
  return { files: [], regions };
};
