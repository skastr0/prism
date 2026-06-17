/** Hermes Agent lowerer. */

import { dirname, join } from "node:path";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { mcpToolNamesForBindings } from "../mcp-bundle.js";
import { mcpTimeoutMsToClientSeconds } from "../mcp-policy.js";
import {
  generatedMcpServerName,
  MCP_EXPOSURE_HEADER,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  type ResolvedMcpRuntime,
} from "../mcp-runtime.js";
import type { ComposedAgent } from "../compose.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { bindingsFromCanonicalTools } from "../tool-bindings.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import { readFile } from "../../fs.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { DesiredFile, DesiredRegion } from "../../sync/desired.js";
import {
  pushDesiredFile,
  renderGeneratedOrbitSkill,
  yamlScalar,
  type LowerOutput,
} from "./shared.js";

const TARGET_ID = "hermes" as const;

export interface HermesLowerTarget {
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
  readonly target: HermesLowerTarget;
}

const hermesSkillsRoot = (target: HermesLowerTarget): string =>
  join(target.root, "skills");

const configPath = (target: HermesLowerTarget): string =>
  join(target.root, "config.yaml");

const targetIncludesHermes = (targets: readonly PluginTargetId[] | undefined): boolean =>
  resolveManifestTargets(targets ?? []).includes(TARGET_ID);

const artifactTargetsHermes = (
  registry: PluginRegistry | undefined,
  artifact: AnyArtifactType,
): boolean => targetIncludesHermes(registry?.targets[artifact]);

const renderHermesOrbitSkillMarkdown = (
  orbit: Orbit,
  registry: PluginRegistry | undefined,
): string =>
  renderGeneratedOrbitSkill({
    orbit,
    registry,
    trailingNewline: true,
  });

const copyTargetedSkillArtifacts = async (
  input: LowerInput,
  files: DesiredFile[],
): Promise<void> => {
  const pluginPath = input.target.sourcePluginPath ?? input.registry?.pluginPath;
  if (!pluginPath || !artifactTargetsHermes(input.registry, "skills")) return;

  const sourceFiles = await collectArtifactSourceFiles(pluginPath, "skills", TARGET_ID);
  for (const file of sourceFiles) {
    pushDesiredFile(files, {
      targetPath: join(hermesSkillsRoot(input.target), file.relativePath),
      content: await readFile(file.sourcePath),
      plugin: input.target.sourcePluginName,
    });
  }
};

const renderHermesMcpServerYaml = (options: {
  readonly serverName: string;
  readonly runtime: ResolvedMcpRuntime;
  readonly exposureProfile?: string;
  readonly toolNames: ReadonlyArray<string>;
}): string[] => {
  return [
    `  ${options.serverName}:`,
    `    url: ${yamlScalar(renderMcpHttpUrl(options.runtime))}`,
    `    connect_timeout: ${mcpTimeoutMsToClientSeconds(options.runtime.connectTimeoutMs)}`,
    `    timeout: ${mcpTimeoutMsToClientSeconds(options.runtime.toolTimeoutMs)}`,
    `    enabled: true`,
    `    sampling:`,
    `      enabled: false`,
    ...(options.exposureProfile
      ? [
          `    headers:`,
          `      ${MCP_EXPOSURE_HEADER}: ${yamlScalar(options.exposureProfile)}`,
        ]
      : []),
    `    tools:`,
    `      include:`,
    ...options.toolNames.map((toolName) => `        - ${yamlScalar(toolName)}`),
  ];
};

const planMcpServer = (
  input: LowerInput,
): { serverName: string; toolNames: ReadonlyArray<string> } => {
  const serverName = generatedMcpServerName(input.target.sourcePluginName);
  const bindings = bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools);
  resolveMcpRuntime(input.registry, TARGET_ID, {
    requirePort: bindings.length > 0,
    resolvedPort: input.target.mcpRuntimePort,
  });

  if (bindings.length === 0) return { serverName, toolNames: [] };

  return {
    serverName,
    toolNames: mcpToolNamesForBindings(input.target.sourcePluginName, bindings),
  };
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

export const planLowering = async (input: LowerInput): Promise<LowerOutput> => {
  const files: DesiredFile[] = [];
  const regions: DesiredRegion[] = [];
  const plugin = input.target.sourcePluginName;

  assertHermesLoweringInput(input);

  await copyTargetedSkillArtifacts(input, files);

  for (const orbit of input.orbits) {
    pushDesiredFile(files, {
      targetPath: join(hermesSkillsRoot(input.target), `${orbit.name}/SKILL.md`),
      content: renderHermesOrbitSkillMarkdown(orbit, input.registry),
      plugin,
    });

    for (const reference of renderDerivedOrbitPhaseReferences(orbit)) {
      pushDesiredFile(files, {
        targetPath: join(
          hermesSkillsRoot(input.target),
          `${orbit.name}/references/${reference.filename}`,
        ),
        content: reference.content,
        plugin,
      });
    }
  }

  const mcp = planMcpServer(input);
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, {
    requirePort: mcp.toolNames.length > 0,
    resolvedPort: input.target.mcpRuntimePort,
  });

  // The hermes MCP wiring is one child mapping inside the user-shared
  // top-level `mcp_servers:` key of config.yaml. The fence is anchored to
  // that key so the region content lands inside the mapping (the anchor line
  // is created when absent); the rest of config.yaml is never rewritten.
  if (mcp.toolNames.length > 0) {
    regions.push({
      kind: "marker",
      targetPath: configPath(input.target),
      regionKey: `hermes.mcp.${mcp.serverName}`,
      commentPrefix: "#",
      anchor: "mcp_servers:",
      content: renderHermesMcpServerYaml({
        serverName: mcp.serverName,
        runtime,
        exposureProfile: input.target.mcpExposureProfile,
        toolNames: mcp.toolNames,
      }).join("\n"),
      plugin,
    });
  }

  return { files, regions };
};
