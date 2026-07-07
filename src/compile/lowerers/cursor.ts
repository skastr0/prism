/** Cursor lowerer. */

import { join } from "node:path";
import { shimServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ComposedAgent } from "../compose.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { bindingsOwnedByPlugin } from "../tool-bindings.js";
import type { HarnessScope } from "../../types.js";
import type { DesiredRegion } from "../../sync/desired.js";
import {
  SHIM_REGION_OWNER,
  unionedShimExposure,
  type LowerOutput,
  type ShimExposureContribution,
} from "./shared.js";

const TARGET_ID = "cursor" as const;

export interface CursorLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly mcpExposureProfile?: string;
  readonly sourcePluginName: string;
  readonly sourcePluginVersion?: string;
  readonly sourcePluginPath?: string;
  /**
   * Union of every OTHER installed plugin's recorded shim contribution for
   * this harness root (from the shim-exposure registry). The shared
   * `mcp.json` shim entry is rendered from `prior ∪ own` so a single-plugin
   * compile can never narrow `PRISM_SHIM_PLUGINS` to its own view.
   */
  readonly priorShimExposure?: ShimExposureContribution;
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
 * The shared shim entry carries the UNION of every installed plugin's
 * exposure, so it cannot name a single plugin's `PRISM_SHIM_EXPOSURE`
 * profile — the shim derives the per-owner daemon profile itself (see
 * `@skastr0/prism-sdk/mcp/shim.ts`).
 */
const renderCursorMcpServerEntry = (
  plugins: ReadonlyArray<string>,
): CursorMcpServerEntry => ({
  command: "prism",
  args: ["mcp", "shim"],
  env: {
    PRISM_SHIM_PLUGINS: plugins.join(","),
    PRISM_SHIM_HARNESS: TARGET_ID,
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
  const serverName = shimServerKey(TARGET_ID);
  const ownedBindings = bindingsOwnedByPlugin(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  // Cursor's shim entry has no tool allowlist — only the plugin list unions.
  const shimContribution: ShimExposureContribution =
    ownedBindings.length > 0
      ? { plugins: [input.target.sourcePluginName], enabledTools: [] }
      : { plugins: [], enabledTools: [] };

  const regions: DesiredRegion[] = [];

  // The `mcpServers.prism-mcp-shim` key is shared by every installed plugin
  // (same jsonPath for all), so it is rendered from the union of the
  // recorded prior exposure and this compile's own contribution, and is
  // emitted whenever the UNION is non-empty — even when this plugin
  // contributes nothing (its removal shrinks the entry instead of
  // orphan-removing it while other plugins still need it).
  const shimUnion = unionedShimExposure(input.target.priorShimExposure, shimContribution);
  if (shimUnion.plugins.length > 0) {
    regions.push({
      kind: "json-key",
      targetPath: configPath(input.target),
      regionKey: `mcpServers.${serverName}`,
      jsonPath: ["mcpServers", serverName],
      value: renderCursorMcpServerEntry(shimUnion.plugins),
      plugin: SHIM_REGION_OWNER,
    });
  }

  return { files: [], regions, shimContribution };
};
