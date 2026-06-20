import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generatedPluginIdForOwner } from "./compile/generated-plugin.js";
import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface GrokWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

export class WorkflowWorkerError extends Error {
  override readonly name = "WorkflowWorkerError";
}

interface GrokWorkflowRuntime {
  readonly agent: string;
  readonly env?: Record<string, string>;
  readonly isolated: boolean;
  readonly mcpServerCount: number;
  readonly cleanup: () => Promise<void>;
}

interface GrokMcpConfig {
  readonly mcpServers?: Record<string, {
    readonly url?: unknown;
    readonly headers?: unknown;
    readonly [key: string]: unknown;
  }>;
}

interface GrokGeneratedPluginBundle {
  readonly pluginId: string;
  readonly root: string;
  readonly mcpConfig?: GrokMcpConfig;
}

const GENERATED_PLUGIN_PREFIX = "prism-generated-";
const GROK_MCP_TOOL_PATTERN = /\b(p_[0-9a-f]{8})__/gu;
const GROK_AUTH_OUTPUT_PATTERN = /(^|\n)\s*(?:To sign in, open this URL in your browser:|Waiting for authorization\.{3}|You are not authenticated\.?|(?:error:\s*)?[^{}\n]*requires login[^{}\n]*)/iu;
const GROK_AUTH_PROMPT_PATTERNS = [
  {
    name: "xai-oauth-device-login",
    pattern: GROK_AUTH_OUTPUT_PATTERN,
  },
] as const;

export const isGrokAuthOutput = (output: string): boolean =>
  GROK_AUTH_OUTPUT_PATTERN.test(output);

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const grokHome = (): string =>
  process.env.PRISM_WORKFLOW_GROK_HOME
  ?? process.env.GROK_HOME
  ?? join(process.env.HOME ?? homedir(), ".grok");

const grokHomeIsExplicit = (): boolean =>
  process.env.PRISM_WORKFLOW_GROK_HOME !== undefined || process.env.GROK_HOME !== undefined;

const tomlString = (value: string): string =>
  JSON.stringify(value);

const tomlTableKey = (value: string): string =>
  /^[A-Za-z0-9_-]+$/u.test(value) ? value : tomlString(value);

const renderNativeMcpConfig = (mcpConfig: GrokMcpConfig): string => {
  const lines = [
    "[compat.cursor]",
    "mcps = false",
    "",
    "[compat.claude]",
    "mcps = false",
    "",
  ];

  for (const [name, server] of Object.entries(mcpConfig.mcpServers ?? {})) {
    if (typeof server.url !== "string") continue;
    lines.push(`[mcp_servers.${tomlTableKey(name)}]`);
    lines.push(`url = ${tomlString(server.url)}`);
    lines.push("enabled = true");

    const headers = typeof server.headers === "object" && server.headers !== null && !Array.isArray(server.headers)
      ? server.headers as Record<string, unknown>
      : {};
    const headerEntries = Object.entries(headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string");
    if (headerEntries.length > 0) {
      lines.push(`[mcp_servers.${tomlTableKey(name)}.headers]`);
      for (const [key, value] of headerEntries) {
        lines.push(`${tomlTableKey(key)} = ${tomlString(value)}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
};

const copyIfPresent = async (source: string, target: string): Promise<void> => {
  if (!(await pathExists(source))) return;
  await cp(source, target, { recursive: true });
};

const readMcpConfigIfPresent = async (
  configPath: string,
  options: { readonly strict: boolean },
): Promise<GrokMcpConfig | undefined> => {
  if (!(await pathExists(configPath))) return undefined;
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as GrokMcpConfig;
  } catch (cause) {
    if (!options.strict) return undefined;
    throw new WorkflowWorkerError(
      `generated Grok MCP config '${configPath}' is invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

const mcpServerNames = (mcpConfig: GrokMcpConfig | undefined): Set<string> =>
  new Set(Object.keys(mcpConfig?.mcpServers ?? {}));

const mcpServerNamesReferencedByAgent = (agentText: string): Set<string> => {
  const names = new Set<string>();
  for (const match of agentText.matchAll(GROK_MCP_TOOL_PATTERN)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
};

const discoverGeneratedGrokBundles = async (baseGrokHome: string): Promise<ReadonlyArray<GrokGeneratedPluginBundle>> => {
  const pluginsRoot = join(baseGrokHome, "plugins");
  if (!(await pathExists(pluginsRoot))) return [];

  const entries = await readdir(pluginsRoot, { withFileTypes: true });
  const bundles: GrokGeneratedPluginBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(GENERATED_PLUGIN_PREFIX)) continue;
    const root = join(pluginsRoot, entry.name);
    const mcpConfig = await readMcpConfigIfPresent(join(root, ".mcp.json"), { strict: false });
    bundles.push({
      pluginId: entry.name,
      root,
      ...(mcpConfig !== undefined ? { mcpConfig } : {}),
    });
  }
  return bundles;
};

const selectRequiredGrokBundles = async (input: {
  readonly baseGrokHome: string;
  readonly currentPluginId: string;
  readonly currentPluginRoot: string;
  readonly currentMcpConfigPath: string;
  readonly agentText: string;
}): Promise<ReadonlyArray<GrokGeneratedPluginBundle>> => {
  const requiredServerNames = mcpServerNamesReferencedByAgent(input.agentText);
  const currentConfig = await readMcpConfigIfPresent(input.currentMcpConfigPath, { strict: true });
  const selected = new Map<string, GrokGeneratedPluginBundle>();
  const providedServerNames = mcpServerNames(currentConfig);
  selected.set(input.currentPluginId, {
    pluginId: input.currentPluginId,
    root: input.currentPluginRoot,
    ...(currentConfig !== undefined ? { mcpConfig: currentConfig } : {}),
  });

  if ([...requiredServerNames].some((name) => !providedServerNames.has(name))) {
    for (const bundle of await discoverGeneratedGrokBundles(input.baseGrokHome)) {
      if (bundle.pluginId === input.currentPluginId) continue;
      const bundleServerNames = mcpServerNames(bundle.mcpConfig);
      if (![...bundleServerNames].some((name) => requiredServerNames.has(name))) continue;
      selected.set(bundle.pluginId, bundle);
      for (const name of bundleServerNames) providedServerNames.add(name);
    }
  }

  const missingServerNames = [...requiredServerNames]
    .filter((name) => !providedServerNames.has(name))
    .sort((left, right) => left.localeCompare(right));
  if (missingServerNames.length > 0) {
    throw new WorkflowWorkerError(
      `generated Grok agent references MCP server aliases without installed generated bundles: ${missingServerNames.join(", ")}`,
    );
  }

  return [...selected.values()];
};

const mergeGrokMcpConfigs = (bundles: ReadonlyArray<GrokGeneratedPluginBundle>): GrokMcpConfig => {
  const mcpServers: NonNullable<GrokMcpConfig["mcpServers"]> = {};
  for (const bundle of bundles) {
    for (const [name, server] of Object.entries(bundle.mcpConfig?.mcpServers ?? {})) {
      const existing = mcpServers[name];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(server)) {
        throw new WorkflowWorkerError(
          `generated Grok MCP server alias '${name}' is declared by multiple bundles with different config`,
        );
      }
      mcpServers[name] = server;
    }
  }
  return { mcpServers };
};

const prepareGrokWorkflowRuntime = async (task: AnyWorkflowTask): Promise<GrokWorkflowRuntime> => {
  const baseGrokHome = grokHome();
  const pluginId = generatedPluginIdForOwner(task.agent.plugin);
  const sourcePluginRoot = join(baseGrokHome, "plugins", pluginId);
  const sourceMcpConfigPath = join(sourcePluginRoot, ".mcp.json");
  const sourceAgentPath = join(sourcePluginRoot, "agents", `${task.agent.name}.md`);
  const hasGeneratedPlugin = await pathExists(sourcePluginRoot);
  const hasGeneratedAgent = await pathExists(sourceAgentPath);

  if (!hasGeneratedPlugin || !hasGeneratedAgent) {
    if (hasGeneratedPlugin || grokHomeIsExplicit()) {
      throw new WorkflowWorkerError(
        `generated Grok plugin '${pluginId}' for agent '${task.agent.plugin}:${task.agent.name}' is missing ` +
          `${hasGeneratedPlugin ? `agent '${sourceAgentPath}'` : `plugin root '${sourcePluginRoot}'`}`,
      );
    }
    return {
      agent: task.agent.name,
      isolated: false,
      mcpServerCount: 0,
      cleanup: async () => undefined,
    };
  }

  const agentText = await readFile(sourceAgentPath, "utf8");
  const pluginBundles = await selectRequiredGrokBundles({
    baseGrokHome,
    currentPluginId: pluginId,
    currentPluginRoot: sourcePluginRoot,
    currentMcpConfigPath: sourceMcpConfigPath,
    agentText,
  });
  const mcpConfig = mergeGrokMcpConfigs(pluginBundles);

  const osHome = await mkdtemp(join(tmpdir(), "prism-workflow-grok-home-"));
  const overlayGrokHome = await mkdtemp(join(tmpdir(), "prism-workflow-grok-config-"));
  const overlayPluginRoot = join(overlayGrokHome, "plugins", pluginId);
  await mkdir(join(overlayGrokHome, "plugins"), { recursive: true });
  await Promise.all([
    copyIfPresent(join(baseGrokHome, "auth.json"), join(overlayGrokHome, "auth.json")),
    copyIfPresent(join(baseGrokHome, "models_cache.json"), join(overlayGrokHome, "models_cache.json")),
    copyIfPresent(join(baseGrokHome, "version.json"), join(overlayGrokHome, "version.json")),
    ...pluginBundles.map((bundle) =>
      cp(bundle.root, join(overlayGrokHome, "plugins", bundle.pluginId), { recursive: true })
    ),
  ]);

  const mcpServerCount = Object.keys(mcpConfig.mcpServers ?? {}).length;
  await writeFile(join(overlayGrokHome, "config.toml"), renderNativeMcpConfig(mcpConfig));

  return {
    agent: join(overlayPluginRoot, "agents", `${task.agent.name}.md`),
    env: {
      HOME: osHome,
      GROK_HOME: overlayGrokHome,
      GROK_CURSOR_MCPS_ENABLED: "false",
      GROK_CLAUDE_MCPS_ENABLED: "false",
    },
    isolated: true,
    mcpServerCount,
    cleanup: async () => {
      await Promise.all([
        rm(osHome, { recursive: true, force: true }),
        rm(overlayGrokHome, { recursive: true, force: true }),
      ]);
    },
  };
};

export const buildGrokArgs = (input: {
  readonly cwd: string;
  readonly agent: string;
  readonly model?: string;
  readonly effort?: string;
  readonly prompt: string;
}): ReadonlyArray<string> => [
  "--model",
  input.model ?? "grok-build",
  "--agent",
  input.agent,
  "--cwd",
  input.cwd,
  "--no-alt-screen",
  "--allow",
  "MCPTool",
  "--output-format",
  "plain",
  ...(input.effort ? ["--effort", input.effort] : []),
  "--single",
  input.prompt,
];

export const runGrokWorkflowTask = async (
  task: AnyWorkflowTask,
  options: GrokWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const command = options.bin ?? process.env.PRISM_WORKFLOW_GROK_BIN ?? "grok";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_GROK_PROCESS_TIMEOUT_MS)
    ?? 120_000;
  const runtime = await prepareGrokWorkflowRuntime(task);
  const args = buildGrokArgs({
    cwd: options.cwd,
    agent: runtime.agent,
    model: options.model,
    effort: options.effort,
    prompt,
  });

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted, earlyExit } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
    env: runtime.env,
    earlyExitPatterns: GROK_AUTH_PROMPT_PATTERNS,
  }).finally(() => runtime.cleanup().catch(() => undefined));
  if (aborted) {
    throw new WorkflowWorkerError("grok was aborted by Prism workflow stop");
  }
  if (earlyExit === "xai-oauth-device-login") {
    throw new WorkflowWorkerError("grok requires xAI OAuth login before workflow run; run `grok login` or refresh Grok credentials, then retry");
  }
  if (timedOut) {
    throw new WorkflowWorkerError(`grok exceeded Prism process timeout after ${processTimeoutMs}ms`);
  }
  if (exitCode !== 0 && isGrokAuthOutput(`${stdout}\n${stderr}`)) {
    throw new WorkflowWorkerError("grok requires xAI OAuth login before workflow run; run `grok login` or refresh Grok credentials, then retry");
  }
  if (exitCode !== 0) {
    throw new WorkflowWorkerError(`grok exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return {
    output: parseWorkflowWorkerJsonOutput(stdout),
    metadata: {
      adapter: "grok-cli",
      nativeAgent: task.agent.name,
      model: options.model ?? "grok-build",
      grokHomeIsolated: runtime.isolated,
      grokMcpServerCount: runtime.mcpServerCount,
      durationMs,
      processTimeoutMs,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};

export { parseWorkflowWorkerJsonOutput, WorkflowOutputParseError } from "./workflow-worker-contract.js";
