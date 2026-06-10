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
import {
  exists,
  readFile,
} from "../../fs.js";
import { computeContentHash } from "../../content-hash.js";
import {
  managedEntryId,
  readHarnessLedger,
  type ManagedLedgerEntry,
} from "../../managed-ledger.js";
import type { HarnessScope } from "../../types.js";
import type { LowerOperation } from "./opencode.js";
import {
  executeStandardLowering,
  pushConfigPatchOperation as pushConfigPatch,
} from "./shared.js";

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

const json = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseCursorMcpConfig = (content: string, target: string): Record<string, unknown> => {
  if (content.trim().length === 0) return {};
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Cursor MCP config '${target}' must be a JSON object.`);
  }
  return parsed;
};

const cursorMcpServers = (
  config: Record<string, unknown>,
  target: string,
): Record<string, unknown> => {
  if (config.mcpServers === undefined) return {};
  if (!isRecord(config.mcpServers)) {
    throw new Error(`Cursor MCP config '${target}' mcpServers must be a JSON object.`);
  }
  return config.mcpServers;
};

const cursorMcpConfigHasServer = (
  currentConfig: string,
  target: string,
  serverName: string,
): boolean => {
  if (!currentConfig.includes(serverName)) return false;
  const config = parseCursorMcpConfig(currentConfig, target);
  return Object.prototype.hasOwnProperty.call(cursorMcpServers(config, target), serverName);
};

const cursorLedgerEntry = async (
  target: CursorLowerTarget,
  targetPath: string,
  kind: "file" | "config",
): Promise<ManagedLedgerEntry | undefined> => {
  const ledger = await readHarnessLedger(TARGET_ID);
  const entryId = managedEntryId({
    harness: TARGET_ID,
    scope: target.scope,
    root: target.root,
    pluginName: target.sourcePluginName,
    artifact: "compile",
    targetPath,
    kind,
  });
  return ledger.entries.find((entry) => entry.id === entryId);
};

const currentContentHash = async (targetPath: string): Promise<string | undefined> =>
  (await exists(targetPath)) ? computeContentHash(await readFile(targetPath)) : undefined;

const cursorCurrentTargetIsLedgerOwned = async (
  target: CursorLowerTarget,
  targetPath: string,
  kind: "file" | "config",
): Promise<boolean> => {
  const entry = await cursorLedgerEntry(target, targetPath, kind);
  if (!entry) return false;
  const currentHash = await currentContentHash(targetPath);
  return currentHash === undefined || currentHash === entry.contentHash;
};

export const applyCursorMcpServerUpdate = (
  currentConfig: string,
  target: string,
  serverName: string,
  entry: CursorMcpServerEntry | undefined,
): string => {
  const config = parseCursorMcpConfig(currentConfig, target);
  const hadServers = Object.prototype.hasOwnProperty.call(config, "mcpServers");
  const currentServers = cursorMcpServers(config, target);
  const nextServers: Record<string, unknown> = { ...currentServers };

  if (entry) nextServers[serverName] = entry;
  else delete nextServers[serverName];

  if (Object.keys(nextServers).length > 0 || hadServers) {
    config.mcpServers = nextServers;
  } else {
    delete config.mcpServers;
  }

  return json(config);
};

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

const planMcpConfig = async (
  input: LowerInput,
  operations: LowerOperation[],
  server: ReturnType<typeof planMcpServer>,
): Promise<void> => {
  const target = configPath(input.target);
  const hasConfig = await exists(target);
  if (!server.entry && !hasConfig) return;

  const current = hasConfig ? await readFile(target) : "";
  if (
    !server.entry &&
    (
      !cursorMcpConfigHasServer(current, target, server.serverName) ||
      !(await cursorCurrentTargetIsLedgerOwned(input.target, target, "config"))
    )
  ) {
    return;
  }
  const next = applyCursorMcpServerUpdate(current, target, server.serverName, server.entry);
  if (next === current && !input.target.mcpBearerToken) return;

  await pushConfigPatch(operations, target, next, {
    mode: input.target.mcpBearerToken ? 0o600 : undefined,
  });
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

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  assertCursorLoweringInput(input);
  const operations: LowerOperation[] = [];
  const server = planMcpServer(input);
  await planMcpConfig(input, operations, server);
  return operations;
};

export const executeLowering = executeStandardLowering;
