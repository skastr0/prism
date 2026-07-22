/**
 * Stateless CLI invoke path for Prism canonical tools.
 *
 * Loads the compiled runtime module from PRISM_HOME and calls handle once
 * in-process. No daemon, no UDS, no MCP protocol.
 */

import { pathToFileURL } from "node:url";
import { exists, readFile } from "../fs.js";
import { readToolCliCatalog, type ToolCliCatalog } from "./catalog.js";
import { prismToolRuntimePath } from "./paths.js";

export class ToolsCliInvokeError extends Error {
  readonly kind = "tools-cli-invoke-error" as const;

  constructor(
    message: string,
    readonly exitCode: number = 1,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ToolsCliInvokeError";
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const resolveToolName = (catalog: ToolCliCatalog, toolName: string): string => {
  const exact = catalog.tools.find((tool) => tool.name === toolName || tool.logicalName === toolName);
  if (exact) return exact.name;
  const lowered = toolName.toLowerCase();
  const fuzzy = catalog.tools.find(
    (tool) => tool.name.toLowerCase() === lowered || tool.logicalName.toLowerCase() === lowered,
  );
  if (fuzzy) return fuzzy.name;
  const available = catalog.tools.map((tool) => tool.name).join(", ");
  throw new ToolsCliInvokeError(
    `unknown tool '${toolName}' for plugin '${catalog.plugin}'` +
      (available.length > 0 ? `; available: ${available}` : " (catalog empty)"),
    1,
  );
};

export const parseToolsCliInput = async (raw: string | undefined): Promise<Record<string, unknown>> => {
  if (raw === undefined || raw.trim().length === 0) return {};
  const trimmed = raw.trim();
  let jsonText = trimmed;
  if (trimmed.startsWith("@")) {
    const path = trimmed.slice(1);
    jsonText = await readFile(path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new ToolsCliInvokeError(`--input is not valid JSON: ${errorMessage(error)}`, 1, error);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolsCliInvokeError("--input must be a JSON object", 1);
  }
  return parsed as Record<string, unknown>;
};

export interface ToolsCliInvokeOptions {
  readonly prismHome: string;
  readonly pluginName: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly timeoutMs?: number;
  readonly workingDirectory?: string;
  readonly repoRoot?: string;
}

interface ToolCliRuntimeModule {
  readonly invokeTool: (
    name: string,
    rawArgs?: Record<string, unknown>,
    callContext?: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly toolNames?: ReadonlyArray<string>;
}

const loadToolCliRuntime = async (
  prismHome: string,
  pluginName: string,
): Promise<ToolCliRuntimeModule> => {
  const runtimePath = prismToolRuntimePath(prismHome, pluginName);
  if (!(await exists(runtimePath))) {
    throw new ToolsCliInvokeError(
      `CLI tool runtime missing for plugin '${pluginName}' at ${runtimePath}; run prism refresh for that plugin`,
      2,
    );
  }
  const moduleUrl = `${pathToFileURL(runtimePath).href}?t=${Date.now()}`;
  try {
    const loaded = (await import(moduleUrl)) as ToolCliRuntimeModule;
    if (typeof loaded.invokeTool !== "function") {
      throw new ToolsCliInvokeError(
        `CLI tool runtime for '${pluginName}' does not export invokeTool`,
        2,
      );
    }
    return loaded;
  } catch (error) {
    if (error instanceof ToolsCliInvokeError) throw error;
    throw new ToolsCliInvokeError(
      `failed to load CLI tool runtime for '${pluginName}': ${errorMessage(error)}`,
      2,
      error,
    );
  }
};

const withTimeout = async <A>(operation: Promise<A>, timeoutMs: number, label: string): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<A>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ToolsCliInvokeError(`${label} timed out after ${timeoutMs}ms`, 2));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const invokeToolViaCli = async (options: ToolsCliInvokeOptions): Promise<unknown> => {
  const catalog = await readToolCliCatalog(options.prismHome, options.pluginName);
  const toolName = catalog
    ? resolveToolName(catalog, options.toolName)
    : options.toolName;

  const runtime = await loadToolCliRuntime(options.prismHome, options.pluginName);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const cwd = options.workingDirectory ?? process.cwd();

  try {
    return await withTimeout(
      runtime.invokeTool(toolName, options.input, {
        workingDirectory: cwd,
        repoRoot: options.repoRoot ?? cwd,
        agent: "prism-tools-cli",
        sessionID: "prism-tools-cli",
      }),
      timeoutMs,
      `tool '${options.pluginName}/${toolName}'`,
    );
  } catch (error) {
    if (error instanceof ToolsCliInvokeError) throw error;
    throw new ToolsCliInvokeError(errorMessage(error), 1, error);
  }
};
