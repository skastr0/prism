/** Cursor lowerer. */

import { join } from "node:path";
import {
  generateMcpServerBundle,
  mcpServerArtifactRelativePath,
} from "../mcp-bundle.js";
import {
  generatedMcpServerName,
  mcpServerBundleRuntimeOptions,
  renderMcpBearerAuthorization,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  type ResolvedMcpRuntime,
} from "../mcp-runtime.js";
import { runtimeMcpServerPathForTarget } from "../mcp-runtime-path.js";
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
  planSharedMcpRuntimePrune,
  pushConfigPatchOperation as pushConfigPatch,
  pushWriteOperation as pushWrite,
} from "./shared.js";

const TARGET_ID = "cursor" as const;

export interface CursorLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly mcpRuntimeRoot?: string;
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
    }
  | {
      readonly url: string;
      readonly headers?: { readonly Authorization: string };
    };

const configPath = (target: CursorLowerTarget): string =>
  join(target.root, "mcp.json");

const localStdioServerPath = (
  target: CursorLowerTarget,
  serverName = generatedMcpServerName(target.sourcePluginName),
): string => join(target.root, ...mcpServerArtifactRelativePath(serverName).split("/"));

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
      };

const planStaleRuntimePruning = async (
  input: LowerInput,
  operations: LowerOperation[],
  options: {
    readonly bindingsLength: number;
    readonly transport: "stdio" | "streamable-http";
    readonly allowCleanupPrune: boolean;
  },
): Promise<void> => {
  if (!options.allowCleanupPrune) return;

  const localPath = localStdioServerPath(input.target);
  const sharedPath = runtimeMcpServerPathForTarget(input.target);

  if (
    (options.transport === "stdio" || options.bindingsLength === 0) &&
    await cursorCurrentTargetIsLedgerOwned(input.target, sharedPath, "file")
  ) {
    await planSharedMcpRuntimePrune(operations, sharedPath, {
      harness: TARGET_ID,
      scope: input.target.scope,
      root: input.target.root,
      sourcePluginName: input.target.sourcePluginName,
    });
  }

  if (
    (options.transport === "streamable-http" || options.bindingsLength === 0) &&
    await exists(localPath) &&
    await cursorCurrentTargetIsLedgerOwned(input.target, localPath, "file")
  ) {
    operations.push({
      kind: "prune-plugin-path",
      target: localPath,
      targetType: "file",
      reason: "stale",
    });
  }
};

const cursorConfigAllowsStaleRuntimePrune = async (
  target: CursorLowerTarget,
  serverName: string,
): Promise<boolean> => {
  const targetPath = configPath(target);
  if (!(await exists(targetPath))) return true;

  const current = await readFile(targetPath);
  if (!cursorMcpConfigHasServer(current, targetPath, serverName)) return true;
  return cursorCurrentTargetIsLedgerOwned(target, targetPath, "config");
};

const planMcpServer = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<{
  readonly serverName: string;
  readonly entry?: CursorMcpServerEntry;
}> => {
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
  const allowCleanupPrune = bindings.length > 0 ||
    await cursorConfigAllowsStaleRuntimePrune(input.target, serverName);

  await planStaleRuntimePruning(input, operations, {
    bindingsLength: bindings.length,
    transport: runtime.transport,
    allowCleanupPrune,
  });

  if (bindings.length === 0) return { serverName };

  const bundle = await generateMcpServerBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath,
    dependencyPluginRoots: input.registry ? Object.entries(input.registry.dependencyPaths) : undefined,
    serverName,
    version: input.target.sourcePluginVersion,
    bundleId: serverName,
    ...mcpServerBundleRuntimeOptions(runtime),
    bindings,
  });
  const serverPath = runtime.transport === "streamable-http"
    ? runtimeMcpServerPathForTarget(input.target)
    : localStdioServerPath(input.target, serverName);

  await pushWrite(operations, serverPath, bundle.content);

  return {
    serverName,
    entry: renderCursorMcpServerEntry({
      target: input.target,
      serverPath,
      runtime,
    }),
  };
};

const planMcpConfig = async (
  input: LowerInput,
  operations: LowerOperation[],
  server: Awaited<ReturnType<typeof planMcpServer>>,
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
  const server = await planMcpServer(input, operations);
  await planMcpConfig(input, operations, server);
  return operations;
};

export const executeLowering = executeStandardLowering;
