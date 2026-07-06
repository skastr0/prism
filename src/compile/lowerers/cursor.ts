/** Cursor lowerer. */

import { join } from "node:path";
import { shimServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ComposedAgent } from "../compose.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { bindingsOwnedByPlugin } from "../tool-bindings.js";
import type { HarnessScope } from "../../types.js";
import type { DesiredRegion } from "../../sync/desired.js";
import type { LowerOutput } from "./shared.js";

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

const renderCursorMcpServerEntry = (target: CursorLowerTarget): CursorMcpServerEntry => {
  const env: Record<string, string> = {
    PRISM_SHIM_PLUGINS: target.sourcePluginName,
    PRISM_SHIM_HARNESS: TARGET_ID,
  };
  if (target.mcpExposureProfile) {
    env.PRISM_SHIM_EXPOSURE = target.mcpExposureProfile;
  }
  return { command: "prism", args: ["mcp", "shim"], env };
};

const planMcpServer = (
  input: LowerInput,
): {
  readonly serverName: string;
  readonly entry?: CursorMcpServerEntry;
} => {
  const serverName = shimServerKey("cursor");
  const ownedBindings = bindingsOwnedByPlugin(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );

  if (ownedBindings.length === 0) return { serverName };

  return {
    serverName,
    entry: renderCursorMcpServerEntry(input.target),
  };
};

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
  const server = planMcpServer(input);
  const regions: DesiredRegion[] = [];

  if (server.entry) {
    regions.push({
      kind: "json-key",
      targetPath: configPath(input.target),
      regionKey: `mcpServers.${server.serverName}`,
      jsonPath: ["mcpServers", server.serverName],
      value: server.entry,
      plugin: input.target.sourcePluginName,
    });
  }

  return { files: [], regions };
};
