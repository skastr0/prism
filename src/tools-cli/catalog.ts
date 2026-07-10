import { exists, listDir, readFile, writeFile } from "../fs.js";
import { mcpToolNamesForBindings } from "../compile/mcp-bundle.js";
import type { ResolvedContractBinding } from "../compile/resolve.js";
import { normalizeBundleSegment } from "../compile/lowerers/shared.js";
import {
  prismToolCatalogPath,
  prismToolPluginDir,
  prismToolSkillPath,
  prismToolsRuntimeDir,
} from "./paths.js";

export const TOOL_CLI_CATALOG_VERSION = 1 as const;

export interface ToolCliCatalogEntry {
  readonly name: string;
  /** Daemon/MCP wire tool name used for tools/call (may equal `name`). */
  readonly wireName: string;
  readonly logicalName: string;
  readonly description: string;
}

export interface ToolCliCatalog {
  readonly version: typeof TOOL_CLI_CATALOG_VERSION;
  readonly plugin: string;
  readonly pluginVersion?: string;
  readonly generatedAt: string;
  readonly tools: ReadonlyArray<ToolCliCatalogEntry>;
}

export interface WriteToolCliCatalogOptions {
  readonly prismHome: string;
  readonly pluginName: string;
  readonly pluginVersion?: string;
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
  readonly toolDescriptions?: ReadonlyMap<string, string>;
  readonly dryRun?: boolean;
}

export interface WriteToolCliCatalogResult {
  readonly catalogPath: string;
  readonly skillPath: string;
  readonly catalog: ToolCliCatalog;
  readonly written: boolean;
}

const descriptionFor = (
  binding: ResolvedContractBinding,
  descriptions: ReadonlyMap<string, string> | undefined,
): string => {
  const fromMap = descriptions?.get(binding.toolName) ?? descriptions?.get(binding.logicalName);
  if (fromMap && fromMap.trim().length > 0) return fromMap.trim();
  return `Invoke ${binding.toolPluginName}/${binding.toolName} via Prism managed CLI.`;
};

export const buildToolCliCatalog = (options: {
  readonly pluginName: string;
  readonly pluginVersion?: string;
  readonly bindings: ReadonlyArray<ResolvedContractBinding>;
  readonly toolDescriptions?: ReadonlyMap<string, string>;
  readonly generatedAt?: string;
}): ToolCliCatalog => {
  const wireNames = mcpToolNamesForBindings(options.pluginName, options.bindings);
  // Bindings fan out per exposure/agent surface; CLI catalog is one row per tool.
  const byLogical = new Map<string, ToolCliCatalogEntry>();
  for (let index = 0; index < options.bindings.length; index++) {
    const binding = options.bindings[index]!;
    const key = binding.logicalName;
    if (byLogical.has(key)) continue;
    const wireName = wireNames[index] ?? binding.logicalName;
    byLogical.set(key, {
      name: binding.logicalName,
      wireName,
      logicalName: binding.logicalName,
      description: descriptionFor(binding, options.toolDescriptions),
    });
  }
  const tools = [...byLogical.values()].sort((left, right) => left.name.localeCompare(right.name));
  return {
    version: TOOL_CLI_CATALOG_VERSION,
    plugin: options.pluginName,
    ...(options.pluginVersion !== undefined ? { pluginVersion: options.pluginVersion } : {}),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    tools,
  };
};

export const renderToolCliSkillMarkdown = (catalog: ToolCliCatalog): string => {
  const toolLines =
    catalog.tools.length === 0
      ? ["_(no tools compiled for this plugin)_"]
      : catalog.tools.map(
          (tool) =>
            `- \`${tool.name}\` — ${tool.description}\n  \`\`\`bash\n  prism tools invoke ${catalog.plugin} ${tool.name} --input '{}'\n  \`\`\``,
        );

  return `---
name: prism-tools-${normalizeBundleSegment(catalog.plugin)}
description: Invoke ${catalog.plugin} Prism tools via managed CLI (stateless). Use when you need ${catalog.plugin} capabilities without MCP.
---

# Prism tools: ${catalog.plugin}

These tools are **stateless CLI calls**. Prefer this surface over MCP stdio shims.

## Invoke

\`\`\`bash
prism tools invoke ${catalog.plugin} <tool-name> --input '<json-object>'
prism tools invoke ${catalog.plugin} <tool-name> --input @./payload.json
\`\`\`

- Exit \`0\` + JSON on stdout on success.
- Non-zero exit + JSON error on stderr/stdout on failure.
- Business logic runs in the existing Prism daemon for \`${catalog.plugin}\` (lazy spawn); no per-session MCP process.

## List

\`\`\`bash
prism tools list
prism tools list --plugin ${catalog.plugin}
prism tools show ${catalog.plugin}
\`\`\`

## Tools

${toolLines.join("\n\n")}

## Notes

- Install/refresh the owning plugin so the catalog and daemon bundle stay current.
- Do not spawn \`prism mcp shim\` for these tools; shell the CLI instead.
- State lives in the tool's own store (e.g. Tower SQLite), never in the agent process.
`;
};

export const writeToolCliCatalog = async (
  options: WriteToolCliCatalogOptions,
): Promise<WriteToolCliCatalogResult> => {
  const catalog = buildToolCliCatalog({
    pluginName: options.pluginName,
    pluginVersion: options.pluginVersion,
    bindings: options.bindings,
    toolDescriptions: options.toolDescriptions,
  });
  const catalogPath = prismToolCatalogPath(options.prismHome, options.pluginName);
  const skillPath = prismToolSkillPath(options.prismHome, options.pluginName);
  const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
  const skillMarkdown = renderToolCliSkillMarkdown(catalog);

  if (options.dryRun) {
    return { catalogPath, skillPath, catalog, written: false };
  }

  let written = true;
  if (await exists(catalogPath)) {
    const current = await readFile(catalogPath);
    if (current === catalogJson) {
      written = false;
    } else {
      await writeFile(catalogPath, catalogJson);
      written = true;
    }
  } else {
    await writeFile(catalogPath, catalogJson);
  }

  if (await exists(skillPath)) {
    const current = await readFile(skillPath);
    if (current !== skillMarkdown) {
      await writeFile(skillPath, skillMarkdown);
      written = true;
    }
  } else {
    await writeFile(skillPath, skillMarkdown);
    written = true;
  }

  return { catalogPath, skillPath, catalog, written };
};

export const readToolCliCatalog = async (
  prismHome: string,
  pluginName: string,
): Promise<ToolCliCatalog | undefined> => {
  const path = prismToolCatalogPath(prismHome, pluginName);
  if (!(await exists(path))) return undefined;
  const raw = await readFile(path);
  const parsed = JSON.parse(raw) as ToolCliCatalog;
  if (parsed.version !== TOOL_CLI_CATALOG_VERSION) return undefined;
  return parsed;
};

export const listToolCliCatalogPlugins = async (prismHome: string): Promise<ReadonlyArray<string>> => {
  const root = prismToolsRuntimeDir(prismHome);
  if (!(await exists(root))) return [];
  const entries = await listDir(root);
  const plugins: string[] = [];
  for (const name of entries) {
    const catalogPath = prismToolCatalogPath(prismHome, name);
    if (await exists(catalogPath)) plugins.push(name);
  }
  return plugins.sort((a, b) => a.localeCompare(b));
};

export const toolPluginDirExists = async (prismHome: string, pluginName: string): Promise<boolean> =>
  exists(prismToolPluginDir(prismHome, pluginName));
