/** Cursor lowerer. */

import { join } from "node:path";
import {
  MCP_EXPOSURE_HEADER,
  generatedMcpServerName,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  type ResolvedMcpRuntime,
} from "../mcp-runtime.js";
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
  readonly mcpRuntimePort?: number;
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
  readonly url: string;
  readonly headers?: {
    readonly [MCP_EXPOSURE_HEADER]?: string;
  };
};

const configPath = (target: CursorLowerTarget): string =>
  join(target.root, "mcp.json");

const renderCursorMcpServerEntry = (options: {
  readonly target: CursorLowerTarget;
  readonly runtime: ResolvedMcpRuntime;
}): CursorMcpServerEntry =>
  ({
    url: renderMcpHttpUrl(options.runtime),
    ...(options.target.mcpExposureProfile
      ? { headers: { [MCP_EXPOSURE_HEADER]: options.target.mcpExposureProfile } }
      : {}),
  });

const planMcpServer = (
  input: LowerInput,
): {
  readonly serverName: string;
  readonly entry?: CursorMcpServerEntry;
} => {
  const serverName = generatedMcpServerName(input.target.sourcePluginName);
  const ownedBindings = bindingsOwnedByPlugin(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, {
    requirePort: ownedBindings.length > 0,
    resolvedPort: input.target.mcpRuntimePort,
  });

  if (ownedBindings.length === 0) return { serverName };

  return {
    serverName,
    entry: renderCursorMcpServerEntry({
      target: input.target,
      runtime,
    }),
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
