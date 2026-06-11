/** Cursor lowerer. */

import { join } from "node:path";
import { mcpToolNamesForBindings } from "../mcp-bundle.js";
import {
  generatedMcpServerName,
  renderMcpBearerAuthorization,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  type ResolvedMcpRuntime,
} from "../mcp-runtime.js";
import type { ComposedAgent } from "../compose.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { mcpBindingsForAgentsAndTools } from "../tool-bindings.js";
import type { HarnessScope } from "../../types.js";
import type { DesiredRegion } from "../../sync/desired.js";
import type { LowerOutput } from "./shared.js";

const TARGET_ID = "cursor" as const;

export interface CursorLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  /** Absolute canonical `<PRISM_HOME>/runtime/mcp/<plugin>/server.mjs` path. */
  readonly mcpServerPath?: string;
  readonly mcpBearerToken?: string;
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

type CursorMcpServerEntry =
  | {
      readonly type: "stdio";
      readonly command: "bun";
      readonly args: readonly [string];
      readonly env: { readonly PRISM_MCP_ENABLED_TOOLS: string };
    }
  | {
      readonly url: string;
      readonly headers?: { readonly Authorization: string };
    };

const configPath = (target: CursorLowerTarget): string =>
  join(target.root, "mcp.json");

const renderCursorMcpServerEntry = (options: {
  readonly target: CursorLowerTarget;
  readonly serverPath: string;
  readonly runtime: ResolvedMcpRuntime;
  readonly toolNames: ReadonlyArray<string>;
}): CursorMcpServerEntry =>
  options.runtime.transport === "streamable-http"
    ? {
        url: renderMcpHttpUrl(options.runtime),
        headers: {
          Authorization: renderMcpBearerAuthorization({
            tokenEnv: options.runtime.tokenEnv,
            token: options.target.mcpBearerToken,
          }),
        },
      }
    : {
        type: "stdio",
        command: "bun",
        args: [options.serverPath],
        // Cursor mcp.json has no per-server tool allowlist, so the union
        // bundle is filtered deny-by-default via PRISM_MCP_ENABLED_TOOLS.
        env: { PRISM_MCP_ENABLED_TOOLS: options.toolNames.join(",") },
      };

const planMcpServer = (
  input: LowerInput,
): {
  readonly serverName: string;
  readonly entry?: CursorMcpServerEntry;
} => {
  const serverName = generatedMcpServerName(input.target.sourcePluginName);
  const bindings = mcpBindingsForAgentsAndTools(
    input.target.sourcePluginName,
    input.tools,
    input.agents,
  );
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, {
    requirePort: bindings.length > 0,
    resolvedPort: input.target.mcpRuntimePort,
  });

  if (bindings.length === 0) return { serverName };
  if (!input.target.mcpServerPath) {
    throw new Error("Cursor MCP lowering requires the canonical Prism MCP server bundle path.");
  }

  return {
    serverName,
    entry: renderCursorMcpServerEntry({
      target: input.target,
      serverPath: input.target.mcpServerPath,
      runtime,
      toolNames: mcpToolNamesForBindings(input.target.sourcePluginName, bindings),
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
