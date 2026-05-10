/** Hermes Agent lowerer. */

import { basename, dirname, join } from "node:path";
import { renderDerivedOrbitSkillBody } from "../derived-orbit-skill.js";
import {
  generateMcpServerBundle,
  mcpServerArtifactRelativePath,
} from "../mcp-bundle.js";
import type { ComposedAgent } from "../compose.js";
import type { ResolvedContractBinding } from "../resolve.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import {
  backupFile,
  exists,
  listDirRecursive,
  readFile,
  removeDir,
  removeFile,
  writeFile,
} from "../../fs.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { LowerOperation } from "./opencode.js";

const TARGET_ID = "hermes" as const;
const GENERATED_SERVER_PREFIX = "prism-generated";

export interface HermesLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
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
  readonly target: HermesLowerTarget;
}

type Reason = "new" | "changed" | "unchanged";

const normalizeBundleSegment = (value: string, fallback = "plugin"): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

const generatedServerName = (pluginName: string): string =>
  `${GENERATED_SERVER_PREFIX}-${normalizeBundleSegment(pluginName)}`;

const hermesPrismRoot = (target: HermesLowerTarget): string =>
  join(target.root, "prism");

const hermesSkillsRoot = (target: HermesLowerTarget): string =>
  join(target.root, "skills");

const generatedMcpServerFile = (target: HermesLowerTarget): string =>
  join(
    hermesPrismRoot(target),
    ...mcpServerArtifactRelativePath(generatedServerName(target.sourcePluginName)).split("/"),
  );

const generatedMcpServerRoot = (target: HermesLowerTarget): string =>
  dirname(generatedMcpServerFile(target));

const configPath = (target: HermesLowerTarget): string =>
  join(target.root, "config.yaml");

const orbitSkillOwnerMarker = (sourcePluginName: string): string =>
  `<!-- prism:hermes-orbit-skill owner=${JSON.stringify(sourcePluginName)} -->`;

const yamlScalar = (value: string | number | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const serializeFrontmatter = (values: Record<string, unknown>): string => {
  const lines = ["---"];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(String(item))}`);
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
};

const writeReason = async (target: string, content: string): Promise<Reason> => {
  if (!(await exists(target))) return "new";
  return (await readFile(target)) === content ? "unchanged" : "changed";
};

const pushWrite = async (
  operations: LowerOperation[],
  target: string,
  content: string,
  kind: "write-md" | "write-plugin-file" = "write-plugin-file",
): Promise<void> => {
  operations.push({
    kind,
    target,
    content,
    reason: await writeReason(target, content),
  });
};

const targetIncludesHermes = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsHermes = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesHermes(registry?.targets[artifact]);

const bindingFromToolSource = (
  pluginName: string,
  sourcePath: string,
): ResolvedContractBinding => {
  const toolName = basename(sourcePath, ".tool.ts");
  return {
    kind: "permission",
    logicalName: toolName,
    toolPluginName: pluginName,
    toolName,
    toolSourcePath: sourcePath,
  };
};

const bindingsFromCanonicalTools = (
  pluginName: string,
  tools: ReadonlyArray<CanonicalTool>,
): ReadonlyArray<ResolvedContractBinding> =>
  tools
    .map((tool) => bindingFromToolSource(pluginName, tool.sourcePath))
    .sort((left, right) => left.toolName.localeCompare(right.toolName));

const renderHermesOrbitSkillMarkdown = (
  orbit: Orbit,
  sourcePluginName: string,
  registry: PluginRegistry | undefined,
): string => {
  const lines: string[] = [];
  lines.push(
    serializeFrontmatter({ name: orbit.name, description: orbit.description }),
    "",
    orbitSkillOwnerMarker(sourcePluginName),
    "",
  );
  if (registry) {
    lines.push(renderDerivedOrbitSkillBody(orbit, registry));
  } else {
    lines.push(`# ${orbit.name}`, "", orbit.description, "");
    if (orbit.body.trim().length > 0) lines.push(orbit.body.trim(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

const copyTargetedSkillArtifacts = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsHermes(input.registry, "skills")) return;

  const files = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of files) {
    await pushWrite(
      operations,
      join(hermesSkillsRoot(input.target), file.relativePath),
      await readFile(file.sourcePath),
      file.relativePath.endsWith(".md") ? "write-md" : "write-plugin-file",
    );
  }
};

const planGeneratedOrbitSkillPruning = async (
  target: HermesLowerTarget,
  desiredRelativeSkillFiles: ReadonlySet<string>,
): Promise<LowerOperation[]> => {
  const root = hermesSkillsRoot(target);
  if (!(await exists(root))) return [];

  const operations: LowerOperation[] = [];
  const marker = orbitSkillOwnerMarker(target.sourcePluginName);
  for (const relativeFile of await listDirRecursive(root)) {
    if (!relativeFile.endsWith("SKILL.md")) continue;
    if (desiredRelativeSkillFiles.has(relativeFile)) continue;

    const absoluteFile = join(root, relativeFile);
    const content = await readFile(absoluteFile);
    if (!content.includes(marker)) continue;
    operations.push({
      kind: "prune-plugin-path",
      target: dirname(absoluteFile),
      targetType: "dir",
      reason: "stale",
    });
  }
  return operations;
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isTopLevelKey = (line: string): boolean =>
  /^[A-Za-z0-9_.-]+:\s*(?:#.*)?$/.test(line) ||
  /^[A-Za-z0-9_.-]+:\s+\S/.test(line);

const findTopLevelBlock = (
  lines: string[],
  key: string,
): { start: number; end: number } | undefined => {
  const start = lines.findIndex((line) =>
    new RegExp(`^${escapeRegex(key)}:\\s*(?:.*)?$`).test(line),
  );
  if (start === -1) return undefined;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (isTopLevelKey(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return { start, end };
};

const renderHermesMcpServerYaml = (options: {
  readonly serverName: string;
  readonly serverPath: string;
  readonly toolNames: ReadonlyArray<string>;
}): string[] => [
  `  ${options.serverName}:`,
  `    command: "bun"`,
  `    args:`,
  `      - ${yamlScalar(options.serverPath)}`,
  `    enabled: true`,
  `    tools:`,
  `      include:`,
  ...options.toolNames.map((toolName) => `        - ${yamlScalar(toolName)}`),
];

const replaceHermesMcpServerBlock = (
  currentConfig: string,
  options: {
    readonly serverName: string;
    readonly serverPath: string;
    readonly toolNames: ReadonlyArray<string>;
  },
): string => {
  const normalizedCurrent = currentConfig.trimEnd();
  const lines = normalizedCurrent.length > 0 ? normalizedCurrent.split(/\r?\n/u) : [];
  const mcpBlock = findTopLevelBlock(lines, "mcp_servers");
  const serverBlock =
    options.toolNames.length > 0 ? renderHermesMcpServerYaml(options) : [];

  if (!mcpBlock) {
    if (serverBlock.length === 0) return currentConfig;
    const next = [
      ...lines,
      ...(lines.length > 0 ? [""] : []),
      "mcp_servers:",
      ...serverBlock,
    ];
    return `${next.join("\n").trimEnd()}\n`;
  }

  const before = lines.slice(0, mcpBlock.start);
  const body = lines.slice(mcpBlock.start + 1, mcpBlock.end);
  const after = lines.slice(mcpBlock.end);
  const childPattern = new RegExp(`^  ${escapeRegex(options.serverName)}:\\s*(?:#.*)?$`);
  const childStart = body.findIndex((line) => childPattern.test(line));
  const nextBody = [...body];

  if (childStart !== -1) {
    let childEnd = nextBody.length;
    for (let index = childStart + 1; index < nextBody.length; index++) {
      if (/^  [^\s#][^:]*:\s*(?:.*)?$/u.test(nextBody[index] ?? "")) {
        childEnd = index;
        break;
      }
    }
    nextBody.splice(childStart, childEnd - childStart, ...serverBlock);
  } else if (serverBlock.length > 0) {
    if (nextBody.length > 0 && nextBody[nextBody.length - 1]?.trim() !== "") {
      nextBody.push("");
    }
    nextBody.push(...serverBlock);
  }

  const next = [
    ...before,
    "mcp_servers:",
    ...nextBody,
    ...after,
  ];
  return `${next.join("\n").trimEnd()}\n`;
};

const planMcpServer = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<{ serverName: string; toolNames: ReadonlyArray<string> }> => {
  const serverName = generatedServerName(input.target.sourcePluginName);
  const bindings = bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools);
  const serverFile = generatedMcpServerFile(input.target);

  if (bindings.length === 0) {
    if (await exists(generatedMcpServerRoot(input.target))) {
      operations.push({
        kind: "prune-plugin-path",
        target: generatedMcpServerRoot(input.target),
        targetType: "dir",
        reason: "stale",
      });
    }
    return { serverName, toolNames: [] };
  }

  const bundle = await generateMcpServerBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath ?? input.registry?.pluginPath,
    serverName,
    version: input.target.sourcePluginVersion,
    bundleId: serverName,
    bindings,
  });

  await pushWrite(operations, serverFile, bundle.content);
  return { serverName, toolNames: bundle.toolNames };
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const desiredGeneratedSkillFiles = new Set<string>();

  if (input.agents.length > 0) {
    throw new Error(
      "Hermes lowering currently supports skills and generated MCP tools only; profile/SOUL agent lowering is intentionally out of scope.",
    );
  }
  if ((input.hooks?.length ?? 0) > 0) {
    throw new Error(
      "Hermes hook lowering is not implemented; use a native Hermes plugin when hook callbacks are required.",
    );
  }

  await copyTargetedSkillArtifacts(input, operations);

  for (const orbit of input.orbits) {
    const relativeSkill = `${orbit.name}/SKILL.md`;
    desiredGeneratedSkillFiles.add(relativeSkill);
    await pushWrite(
      operations,
      join(hermesSkillsRoot(input.target), relativeSkill),
      renderHermesOrbitSkillMarkdown(orbit, input.target.sourcePluginName, input.registry),
      "write-md",
    );
  }

  operations.push(...await planGeneratedOrbitSkillPruning(input.target, desiredGeneratedSkillFiles));

  const mcp = await planMcpServer(input, operations);
  const currentConfig = (await exists(configPath(input.target)))
    ? await readFile(configPath(input.target))
    : "";
  const nextConfig = replaceHermesMcpServerBlock(currentConfig, {
    serverName: mcp.serverName,
    serverPath: generatedMcpServerFile(input.target),
    toolNames: mcp.toolNames,
  });
  if (nextConfig !== currentConfig) {
    await pushWrite(operations, configPath(input.target), nextConfig);
  }

  return operations;
};

export const executeLowering = async (
  operations: LowerOperation[],
  options: { backup: boolean; dryRun: boolean },
): Promise<{ backups: string[] }> => {
  const backups: string[] = [];
  if (options.dryRun) return { backups };

  for (const operation of operations) {
    if (operation.reason === "unchanged") continue;
    if (operation.kind === "write-md" || operation.kind === "write-plugin-file") {
      if (options.backup && operation.kind === "write-md") {
        const backup = await backupFile(operation.target);
        if (backup) backups.push(backup);
      }
      await writeFile(operation.target, operation.content);
      continue;
    }
    if (operation.kind === "prune-plugin-path") {
      if (operation.targetType === "dir") await removeDir(operation.target);
      else await removeFile(operation.target);
    }
  }

  return { backups };
};
