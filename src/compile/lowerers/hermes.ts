/** Hermes Agent lowerer. */

import { dirname, join, resolve } from "node:path";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { generateMcpServerBundle } from "../mcp-bundle.js";
import { mcpTimeoutMsToClientSeconds } from "../mcp-policy.js";
import {
  generatedMcpServerName,
  mcpServerBundleRuntimeOptions,
  renderMcpBearerAuthorization,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  runtimeMcpServerDescriptor,
  type ResolvedMcpRuntime,
} from "../mcp-runtime.js";
import type { ComposedAgent } from "../compose.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { bindingsFromCanonicalTools } from "../tool-bindings.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import {
  exists,
  listDirRecursive,
  readFile,
} from "../../fs.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { LowerOperation } from "./opencode.js";
import {
  executeStandardLowering,
  planSharedMcpRuntimePrune,
  planCompileOwnedTargetedSkillPruning,
  prismOwnerMarker,
  pushConfigPatchOperation as pushConfigPatch,
  pushWriteOperation as pushWrite,
  renderGeneratedOrbitSkill,
  yamlScalar,
} from "./shared.js";

const TARGET_ID = "hermes" as const;

export interface HermesLowerTarget {
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
  readonly target: HermesLowerTarget;
}

const hermesSkillsRoot = (target: HermesLowerTarget): string =>
  join(target.root, "skills");

const generatedMcpServerFile = (
  target: HermesLowerTarget,
  runtime?: ResolvedMcpRuntime,
): string =>
  runtimeMcpServerDescriptor(
    runtime?.transport === "streamable-http" ? target.mcpRuntimeRoot ?? target.root : target.root,
    target.sourcePluginName,
  ).absolutePath;

const generatedMcpServerRoot = (
  target: HermesLowerTarget,
  runtime?: ResolvedMcpRuntime,
): string =>
  dirname(generatedMcpServerFile(target, runtime));

const usesSharedMcpRuntimeRoot = (
  target: HermesLowerTarget,
  runtime: ResolvedMcpRuntime,
): boolean =>
  runtime.transport === "streamable-http" &&
  resolve(target.mcpRuntimeRoot ?? target.root) !== resolve(target.root);

const configPath = (target: HermesLowerTarget): string =>
  join(target.root, "config.yaml");

const orbitSkillOwnerMarker = (sourcePluginName: string): string =>
  prismOwnerMarker("hermes-orbit-skill", sourcePluginName);

const targetIncludesHermes = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsHermes = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesHermes(registry?.targets[artifact]);

const renderHermesOrbitSkillMarkdown = (
  orbit: Orbit,
  sourcePluginName: string,
  registry: PluginRegistry | undefined,
): string =>
  renderGeneratedOrbitSkill({
    orbit,
    sourcePluginName,
    registry,
    ownerKind: "hermes-orbit-skill",
    trailingNewline: true,
  });

const copyTargetedSkillArtifacts = async (
  input: LowerInput,
  operations: LowerOperation[],
): Promise<ReadonlySet<string>> => {
  const desired = new Set<string>();
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsHermes(input.registry, "skills")) return desired;

  const files = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of files) {
    desired.add(file.relativePath);
    await pushWrite(
      operations,
      join(hermesSkillsRoot(input.target), file.relativePath),
      await readFile(file.sourcePath),
      file.relativePath.endsWith(".md") ? "write-md" : "write-plugin-file",
    );
  }
  return desired;
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

const isTopLevelKey = (line: string): boolean =>
  /^[A-Za-z0-9_.-]+:\s*(?:#.*)?$/.test(line) ||
  /^[A-Za-z0-9_.-]+:\s+\S/.test(line);

const topLevelKeyName = (line: string): string | undefined => {
  const match = /^([A-Za-z0-9_.-]+):\s*(?:.*)?$/u.exec(line);
  return match?.[1];
};

const findTopLevelBlock = (
  lines: string[],
  key: string,
): { start: number; end: number } | undefined => {
  const start = lines.findIndex((line) => topLevelKeyName(line) === key);
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

const childBlockKeyName = (line: string): string | undefined => {
  const match = /^  ([^\s#][^:]*):\s*(?:.*)?$/u.exec(line);
  return match?.[1];
};

const renderHermesMcpServerYaml = (options: {
  readonly serverName: string;
  readonly serverPath: string;
  readonly workingDirectory: string;
  readonly runtime: ResolvedMcpRuntime;
  readonly bearerToken?: string;
  readonly toolNames: ReadonlyArray<string>;
}): string[] => {
  if (options.runtime.transport === "streamable-http") {
    return [
      `  ${options.serverName}:`,
      `    url: ${yamlScalar(renderMcpHttpUrl(options.runtime))}`,
      `    connect_timeout: ${mcpTimeoutMsToClientSeconds(options.runtime.connectTimeoutMs)}`,
      `    timeout: ${mcpTimeoutMsToClientSeconds(options.runtime.toolTimeoutMs)}`,
      `    enabled: true`,
      `    sampling:`,
      `      enabled: false`,
    `    headers:`,
      `      Authorization: ${yamlScalar(renderMcpBearerAuthorization({
        tokenEnv: options.runtime.tokenEnv,
        token: options.bearerToken,
      }))}`,
      `    tools:`,
      `      include:`,
      ...options.toolNames.map((toolName) => `        - ${yamlScalar(toolName)}`),
    ];
  }

  const bunCommand = /(?:^|[/\\])bun(?:\.exe)?$/iu.test(process.execPath)
    ? process.execPath
    : "bun";

  return [
    `  ${options.serverName}:`,
    `    command: ${yamlScalar(bunCommand)}`,
    `    args:`,
    `      - ${yamlScalar(options.serverPath)}`,
    `    connect_timeout: ${mcpTimeoutMsToClientSeconds(options.runtime.connectTimeoutMs)}`,
    `    timeout: ${mcpTimeoutMsToClientSeconds(options.runtime.toolTimeoutMs)}`,
    `    enabled: true`,
    `    sampling:`,
    `      enabled: false`,
    `    env:`,
    `      PRISM_MCP_SERVER_NAME: ${yamlScalar(options.serverName)}`,
    `      PRISM_MCP_WORKING_DIRECTORY: ${yamlScalar(options.workingDirectory)}`,
    `      PRISM_MCP_REPO_ROOT: ${yamlScalar(options.workingDirectory)}`,
    `    tools:`,
    `      include:`,
    ...options.toolNames.map((toolName) => `        - ${yamlScalar(toolName)}`),
  ];
};

const replaceHermesMcpServerBlock = (
  currentConfig: string,
  options: {
    readonly serverName: string;
    readonly serverPath: string;
    readonly workingDirectory: string;
    readonly runtime: ResolvedMcpRuntime;
    readonly bearerToken?: string;
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
  const childStart = body.findIndex((line) => childBlockKeyName(line) === options.serverName);
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
  const serverName = generatedMcpServerName(input.target.sourcePluginName);
  const bindings = bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools);
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, {
    requirePort: bindings.length > 0,
    resolvedPort: input.target.mcpRuntimePort,
  });
  const serverFile = generatedMcpServerFile(input.target, runtime);

  if (bindings.length === 0) {
    if (usesSharedMcpRuntimeRoot(input.target, runtime)) {
      await planSharedMcpRuntimePrune(
        operations,
        serverFile,
        {
          harness: TARGET_ID,
          scope: input.target.scope,
          root: input.target.root,
          sourcePluginName: input.target.sourcePluginName,
        },
        { protectSameHarnessOtherRoots: true },
      );
    } else if (await exists(generatedMcpServerRoot(input.target, runtime))) {
      operations.push({
        kind: "prune-plugin-path",
        target: generatedMcpServerRoot(input.target, runtime),
        targetType: "dir",
        reason: "stale",
      });
    }
    return { serverName, toolNames: [] };
  }

  const bundle = await generateMcpServerBundle({
    sourcePluginName: input.target.sourcePluginName,
    sourcePluginRoot: input.target.sourcePluginPath ?? input.registry?.pluginPath,
    dependencyPluginRoots: input.registry ? Object.entries(input.registry.dependencyPaths) : undefined,
    serverName,
    version: input.target.sourcePluginVersion,
    bundleId: serverName,
    ...mcpServerBundleRuntimeOptions(runtime),
    bindings,
  });

  await pushWrite(operations, serverFile, bundle.content);
  return { serverName, toolNames: bundle.toolNames };
};

const assertHermesLoweringInput = (input: LowerInput): void => {
  if (input.agents.length > 0) {
    throw new Error(
      "Hermes lowerer received agents after target capability validation; this indicates a compiler planning bug.",
    );
  }
  if ((input.hooks?.length ?? 0) > 0) {
    throw new Error(
      "Hermes lowerer received hooks after target capability validation; this indicates a compiler planning bug.",
    );
  }
};

export const planLowering = async (input: LowerInput): Promise<LowerOperation[]> => {
  const operations: LowerOperation[] = [];
  const desiredGeneratedSkillFiles = new Set<string>();

  assertHermesLoweringInput(input);

  const desiredTargetedSkillFiles = await copyTargetedSkillArtifacts(input, operations);

  for (const orbit of input.orbits) {
    const relativeSkill = `${orbit.name}/SKILL.md`;
    desiredGeneratedSkillFiles.add(relativeSkill);
    await pushWrite(
      operations,
      join(hermesSkillsRoot(input.target), relativeSkill),
      renderHermesOrbitSkillMarkdown(orbit, input.target.sourcePluginName, input.registry),
      "write-md",
    );

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      const relativeReference = `${orbit.name}/references/${reference.filename}`;
      desiredGeneratedSkillFiles.add(relativeReference);
      await pushWrite(
        operations,
        join(hermesSkillsRoot(input.target), relativeReference),
        reference.content,
        "write-md",
      );
    }
  }

  operations.push(...await planGeneratedOrbitSkillPruning(input.target, desiredGeneratedSkillFiles));
  operations.push(...await planCompileOwnedTargetedSkillPruning({
    target: { ...input.target, harness: TARGET_ID },
    skillsRoot: hermesSkillsRoot(input.target),
    desiredRelativePaths: desiredTargetedSkillFiles,
  }));

  const mcp = await planMcpServer(input, operations);
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, {
    requirePort: mcp.toolNames.length > 0,
    resolvedPort: input.target.mcpRuntimePort,
  });
  const currentConfig = (await exists(configPath(input.target)))
    ? await readFile(configPath(input.target))
    : "";
  const nextConfig = replaceHermesMcpServerBlock(currentConfig, {
    serverName: mcp.serverName,
    serverPath: generatedMcpServerFile(input.target, runtime),
    workingDirectory: input.target.root,
    runtime,
    bearerToken: input.target.mcpBearerToken,
    toolNames: mcp.toolNames,
  });
  if (nextConfig !== currentConfig || input.target.mcpBearerToken) {
    await pushConfigPatch(operations, configPath(input.target), nextConfig, {
      mode: input.target.mcpBearerToken ? 0o600 : undefined,
    });
  }

  return operations;
};

export const executeLowering = executeStandardLowering;
