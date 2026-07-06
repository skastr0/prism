/** Hermes Agent lowerer. */

import { dirname, join } from "node:path";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { mcpToolNameForBinding } from "../mcp-bundle.js";
import { renderAllowlist, shimServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
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

export interface HermesLowerTarget {
  readonly scope: HarnessScope;
  readonly root: string;
  readonly mcpExposureProfile?: string;
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
    `      PRISM_SHIM_HARNESS: ${yamlScalar(TARGET_ID)}`,
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

type PlannedMcpServer =
  | {
      readonly kind: "stdio-shim";
      readonly serverName: string;
      readonly toolNames: ReadonlyArray<string>;
      readonly plugins: ReadonlyArray<string>;
    }
  | { readonly kind: "none" };

const planMcpServer = (input: LowerInput): PlannedMcpServer => {
  // Hermes never receives agents (filtered by capability validation), so
  // every binding here is self-owned — `bindingsByOwner` has at most one
  // key, `sourcePluginName`.
  const bindingsByOwner = allReferencedBindingsByOwner(
    input.target.sourcePluginName,
    input.tools,
    [],
  );
  if (bindingsByOwner.size === 0) return { kind: "none" };

  // One shim process fans out to every owner plugin's daemon, so there is
  // exactly one entry — no per-owner runtime/port resolution at compile time.
  const sourcePluginName = input.target.sourcePluginName;
  const allToolNames = uniqueSorted([
    ...bindingsFromCanonicalTools(sourcePluginName, input.tools),
    ...Array.from(bindingsByOwner.values()).flat(),
  ].map((binding) =>
    renderAllowlist("hermes", sourcePluginName, mcpToolNameForBinding(sourcePluginName, binding)),
  ));
  return {
    kind: "stdio-shim",
    serverName: shimServerKey("hermes"),
    toolNames: allToolNames,
    plugins: Array.from(bindingsByOwner.keys()),
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
  if (mcp.kind === "stdio-shim" && mcp.toolNames.length > 0) {
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
