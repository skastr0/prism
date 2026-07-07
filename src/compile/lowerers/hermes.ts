/** Hermes Agent lowerer. */

import { dirname, join } from "node:path";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { mcpToolNameForBinding } from "../mcp-bundle.js";
import { pluginServerKey, renderPluginAllowlist } from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ComposedAgent } from "../compose.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import { bindingsOwnedByPlugin } from "../tool-bindings.js";
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

/**
 * A per-owner-plugin mapping — exactly one plugin in `PRISM_SHIM_PLUGINS`,
 * `PRISM_SHIM_NAMING: per-plugin` so the shim advertises bare wire names
 * under its own `pluginServerKey` identity (no `PRISM_SHIM_EXPOSURE`: the
 * shim derives that owner's daemon profile itself from the single
 * configured plugin — see `@skastr0/prism-sdk/mcp/shim.ts`).
 */
const renderHermesOwnerMcpServerYaml = (options: {
  readonly serverName: string;
  readonly plugin: string;
  readonly toolNames: ReadonlyArray<string>;
}): string[] => [
  `  ${options.serverName}:`,
  `    command: prism`,
  `    args:`,
  `      - mcp`,
  `      - shim`,
  `    enabled: true`,
  `    sampling:`,
  `      enabled: false`,
  `    env:`,
  `      PRISM_SHIM_PLUGINS: ${yamlScalar(options.plugin)}`,
  `      PRISM_SHIM_HARNESS: ${yamlScalar(TARGET_ID)}`,
  `      PRISM_SHIM_NAMING: ${yamlScalar("per-plugin")}`,
  `    tools:`,
  `      include:`,
  ...options.toolNames.map((toolName) => `        - ${yamlScalar(toolName)}`),
];

type PlannedMcpServer =
  | {
      readonly kind: "stdio-shim";
      readonly serverName: string;
      readonly plugin: string;
      readonly toolNames: ReadonlyArray<string>;
    }
  | { readonly kind: "none" };

/**
 * A per-plugin server can only ever front ONE daemon (the shim's
 * `per-plugin` naming mode requires exactly one configured plugin), so this
 * plugin's compile renders a server entry iff IT is a real MCP owner. Hermes
 * never receives agents (fail-closed by capability validation), so this is
 * always the plugin's own canonical-tool bindings.
 */
const planMcpServer = (input: LowerInput): PlannedMcpServer => {
  const sourcePluginName = input.target.sourcePluginName;
  const ownedBindings = bindingsOwnedByPlugin(sourcePluginName, input.tools, []);
  if (ownedBindings.length === 0) return { kind: "none" };

  const toolNames = uniqueSorted(
    ownedBindings.map((binding) =>
      renderPluginAllowlist("hermes", sourcePluginName, mcpToolNameForBinding(sourcePluginName, binding)),
    ),
  );
  return {
    kind: "stdio-shim",
    serverName: pluginServerKey(sourcePluginName),
    plugin: sourcePluginName,
    toolNames,
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
  //
  // Region-owned by THIS plugin (no cross-plugin union): a per-plugin server
  // can only ever front one daemon, so only a real MCP owner's own compile
  // renders (and the sync engine prunes) its mapping.
  if (mcp.kind === "stdio-shim") {
    regions.push({
      kind: "marker",
      targetPath: configPath(input.target),
      regionKey: `hermes.mcp.${mcp.serverName}`,
      commentPrefix: "#",
      anchor: "mcp_servers:",
      content: renderHermesOwnerMcpServerYaml({
        serverName: mcp.serverName,
        plugin: mcp.plugin,
        toolNames: mcp.toolNames,
      }).join("\n"),
      plugin,
    });
  }

  // Each region is per-plugin — no cross-plugin coordination needed.
  return { files, regions };
};
