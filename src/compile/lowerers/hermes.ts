/** Hermes Agent lowerer. */

import { dirname, join } from "node:path";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { mcpToolNamesForBindings } from "../mcp-bundle.js";
import { mcpTimeoutMsToClientSeconds } from "../mcp-policy.js";
import {
  generatedMcpWireServerName,
  MCP_EXPOSURE_HEADER,
  renderMcpHttpUrl,
  resolveMcpRuntime,
  type McpHarnessTransportMode,
  type ResolvedMcpRuntime,
} from "../mcp-runtime.js";
import type { ComposedAgent } from "../compose.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { allReferencedBindingsByOwner, bindingsFromCanonicalTools } from "../tool-bindings.js";
import { collectArtifactSourceFiles, resolveManifestTargets } from "../../manifest.js";
import { readFile } from "../../fs.js";
import type { AnyArtifactType, HarnessScope, PluginTargetId } from "../../types.js";
import type { DesiredFile, DesiredRegion } from "../../sync/desired.js";
import {
  pushDesiredFile,
  renderGeneratedOrbitSkill,
  uniqueSorted,
  yamlScalar,
  type LowerOutput,
} from "./shared.js";

const TARGET_ID = "hermes" as const;

/**
 * `config.yaml` server key for the aggregated stdio shim entry (`mcpTransport
 * === "stdio-shim"`). Fixed and singular — unlike http mode's one key
 * per owner plugin, one shim process fronts every owner this harness
 * references, so there is exactly one key to choose.
 */
const STDIO_SHIM_WIRE_NAME = "prism-mcp-shim" as const;

export interface HermesLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly mcpExposureProfile?: string;
  readonly mcpRuntimePort?: number;
  /** Per-harness MCP transport rollout flag; defaults to `"http"` when absent. */
  readonly mcpTransport?: McpHarnessTransportMode;
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

const renderHermesStdioShimMcpServerYaml = (options: {
  readonly serverName: string;
  readonly exposureProfile?: string;
  readonly toolNames: ReadonlyArray<string>;
  readonly plugins: ReadonlyArray<string>;
}): string[] => {
  const lines = [
    `  ${options.serverName}:`,
    `    command: prism`,
    `    args:`,
    `      - mcp`,
    `      - shim`,
    `    enabled: true`,
    `    sampling:`,
    `      enabled: false`,
    `    env:`,
    `      PRISM_SHIM_PLUGINS: ${yamlScalar(options.plugins.join(","))}`,
  ];
  if (options.exposureProfile) {
    lines.push(`      PRISM_SHIM_EXPOSURE: ${yamlScalar(options.exposureProfile)}`);
  }
  lines.push(
    `    tools:`,
    `      include:`,
    ...options.toolNames.map((toolName) => `        - ${yamlScalar(toolName)}`),
  );
  return lines;
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

type PlannedMcpServer =
  | {
      readonly kind: "http";
      readonly serverName: string;
      readonly runtime: ResolvedMcpRuntime;
      readonly toolNames: ReadonlyArray<string>;
    }
  | {
      readonly kind: "stdio-shim";
      readonly serverName: string;
      readonly toolNames: ReadonlyArray<string>;
      readonly plugins: ReadonlyArray<string>;
    }
  | { readonly kind: "none" };

const planMcpServer = (input: LowerInput): PlannedMcpServer => {
  const bindingsByOwner = allReferencedBindingsByOwner(
    input.target.sourcePluginName,
    input.tools,
    [], // hermes never receives agents (filtered by capability validation)
  );
  if (bindingsByOwner.size === 0) return { kind: "none" };

  if (input.target.mcpTransport === "stdio-shim") {
    // One shim process fans out to every owner plugin's daemon, so there is
    // exactly one entry — no per-owner runtime/port resolution at compile time.
    const mcpServerName = STDIO_SHIM_WIRE_NAME;
    const allToolNames = uniqueSorted(
      mcpToolNamesForBindings(input.target.sourcePluginName, [
        ...bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools),
        ...Array.from(bindingsByOwner.values()).flat(),
      ]),
    );
    return {
      kind: "stdio-shim",
      serverName: mcpServerName,
      toolNames: allToolNames,
      plugins: Array.from(bindingsByOwner.keys()),
    };
  }

  // HTTP mode (default)
  const bindings = bindingsFromCanonicalTools(input.target.sourcePluginName, input.tools);
  const runtime = resolveMcpRuntime(input.registry, TARGET_ID, {
    requirePort: bindings.length > 0,
    resolvedPort: input.target.mcpRuntimePort,
  });

  if (bindings.length === 0) return { kind: "none" };

  return {
    kind: "http",
    serverName: generatedMcpWireServerName(input.target.sourcePluginName),
    runtime,
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

  // The hermes MCP wiring is one child mapping inside the user-shared
  // top-level `mcp_servers:` key of config.yaml. The fence is anchored to
  // that key so the region content lands inside the mapping (the anchor line
  // is created when absent); the rest of config.yaml is never rewritten.
  if (mcp.kind === "http" && mcp.toolNames.length > 0) {
    regions.push({
      kind: "marker",
      targetPath: configPath(input.target),
      regionKey: `hermes.mcp.${mcp.serverName}`,
      commentPrefix: "#",
      anchor: "mcp_servers:",
      content: renderHermesMcpServerYaml({
        serverName: mcp.serverName,
        runtime: mcp.runtime,
        exposureProfile: input.target.mcpExposureProfile,
        toolNames: mcp.toolNames,
      }).join("\n"),
      plugin,
    });
  } else if (mcp.kind === "stdio-shim" && mcp.toolNames.length > 0) {
    regions.push({
      kind: "marker",
      targetPath: configPath(input.target),
      regionKey: `hermes.mcp.${mcp.serverName}`,
      commentPrefix: "#",
      anchor: "mcp_servers:",
      content: renderHermesStdioShimMcpServerYaml({
        serverName: mcp.serverName,
        exposureProfile: input.target.mcpExposureProfile,
        toolNames: mcp.toolNames,
        plugins: mcp.plugins,
      }).join("\n"),
      plugin,
    });
  }

  return { files, regions };
};
