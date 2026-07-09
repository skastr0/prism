/** Hermes Agent lowerer. */

import { dirname, join } from "node:path";
import { renderDerivedOrbitPhaseReferences } from "../derived-orbit-skill.js";
import { mcpToolNameForBinding } from "../mcp-bundle.js";
import { pluginServerKey, renderPluginAllowlist } from "@skastr0/prism-sdk/mcp/wire-naming";
import { shimCommandForCompile } from "../shim-command.js";
import type { ComposedAgent } from "../compose.js";
import type { PluginRegistry } from "../registry.js";
import type { CanonicalTool, Hook, Orbit, Skill } from "../sources.js";
import {
  bindingsOwnedByPlugin,
  collectBindingNameMap,
  mcpBindingsForAgentsAndTools,
  ownerPluginForBinding,
} from "../tool-bindings.js";
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
  bundleGeneratedHookWrapper,
  matcherForResolvedToolHook,
  normalizeBundleSegment,
  regexEscape,
  renderPrePostSessionHookWrapperEntry,
} from "./shared.js";
import { Effect } from "effect";
import { resolveHookMatchForTarget, type ResolvedHookMatch } from "../hooks.js";
import type { ResolvedContractBinding } from "../resolve.js";

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
  `    command: ${shimCommandForCompile()}`,
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

const hermesGeneratedRoot = (target: HermesLowerTarget): string =>
  join(target.root, "plugins", `prism-generated-${normalizeBundleSegment(target.sourcePluginName)}`);

const hermesNativeHookEvent = (event: Hook["event"]): string => {
  switch (event) {
    case "tool.before":
      return "pre_tool_call";
    case "tool.after":
      return "post_tool_call";
    case "prompt.submit":
      return "pre_llm_call";
    case "session.start":
      return "on_session_start";
    case "session.end":
      return "on_session_end";
    case "subagent.stop":
      return "subagent_stop";
    default:
      throw new Error(`Unsupported event: ${event}`);
  }
};

const collectCanonicalToolNames = (
  sourcePluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyMap<string, string> =>
  collectBindingNameMap(bindings, (binding) => {
    const owner = ownerPluginForBinding(sourcePluginName, binding);
    return renderPluginAllowlist("hermes", owner, mcpToolNameForBinding(owner, binding));
  });

const hookMatcher = (
  nativeEvent: string,
  resolved: ResolvedHookMatch,
  canonicalToolNames: ReadonlyMap<string, string>,
): string | undefined => {
  if (nativeEvent !== "pre_tool_call" && nativeEvent !== "post_tool_call") {
    return undefined;
  }
  return matcherForResolvedToolHook(resolved, canonicalToolNames);
};

const renderHermesHookWrapperEntry = (
  hook: Hook,
  nativeEvent: string,
  hookRuntimePath: string,
  hookSourcePath: string,
): string => {
  return renderPrePostSessionHookWrapperEntry({
    hook,
    hookRuntimePath,
    hookSourcePath,
    harness: TARGET_ID,
    nativeEvent,
    cwdExpression: "input?.cwd",
    fallbackSessionId: TARGET_ID,
    nativeToolInputExpression: "input?.tool_input",
    resultHandlingSource: `const writeHookJson = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const output = {};
if (result.decision === "block") {
  output.decision = "block";
  output.reason = result.message || "";
} else if (${JSON.stringify(hook.event)} === "prompt.submit") {
  const ctx = result.additionalContext || result.systemMessage;
  if (ctx) {
    output.context = ctx;
  }
}
if (Object.keys(output).length > 0) writeHookJson(output);`,
  });
};

const bundleHermesHookWrapper = async (hook: Hook, nativeEvent: string): Promise<string> => {
  return bundleGeneratedHookWrapper({
    hook,
    tempPrefix: "prism-hermes-hook-",
    buildLabel: `Hermes '${hook.name}'`,
    renderEntry: (currentHook, hookRuntimePath, hookSourcePath) =>
      renderHermesHookWrapperEntry(currentHook, nativeEvent, hookRuntimePath, hookSourcePath),
  });
};

const renderHermesHookYaml = (options: {
  readonly nativeEvent: string;
  readonly command: string;
  readonly matcher?: string;
  readonly timeout?: number;
}): string[] => {
  const lines = [
    `  ${options.nativeEvent}:`,
    `    - command: ${yamlScalar(options.command)}`,
  ];
  if (options.matcher) {
    lines.push(`      matcher: ${yamlScalar(options.matcher)}`);
  }
  if (options.timeout !== undefined) {
    lines.push(`      timeout: ${options.timeout}`);
  }
  return lines;
};

const assertHermesLoweringInput = (input: LowerInput): void => {
  if (input.agents.length > 0) {
    throw new Error(
      "Hermes lowerer received agents after target capability validation; this indicates a compiler planning bug.",
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

  const hooks = [...(input.hooks ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  if (hooks.length > 0 && input.registry) {
    const bindings = mcpBindingsForAgentsAndTools(
      input.target.sourcePluginName,
      input.tools,
      input.agents,
    );
    const canonicalToolNames = collectCanonicalToolNames(
      input.target.sourcePluginName,
      bindings,
    );

    for (const hook of hooks) {
      const nativeEvent = hermesNativeHookEvent(hook.event);
      const resolved = await Effect.runPromise(
        resolveHookMatchForTarget(hook, input.registry, "hermes"),
      );

      const matcher = hookMatcher(nativeEvent, resolved, canonicalToolNames);
      const wrapperContent = await bundleHermesHookWrapper(hook, nativeEvent);

      const relativePath = join("hooks", `${normalizeBundleSegment(hook.name, "hook")}.mjs`);
      const wrapperAbsPath = join(hermesGeneratedRoot(input.target), relativePath);

      pushDesiredFile(files, {
        targetPath: wrapperAbsPath,
        content: wrapperContent,
        plugin,
        mode: 0o755,
      });

      regions.push({
        kind: "marker",
        targetPath: configPath(input.target),
        regionKey: `hermes.hooks.${hook.name}`,
        commentPrefix: "#",
        anchor: "hooks:",
        content: renderHermesHookYaml({
          nativeEvent,
          command: `node ${wrapperAbsPath}`,
          matcher,
          timeout: 60,
        }).join("\n"),
        plugin,
      });
    }
  }

  // Each region is per-plugin — no cross-plugin coordination needed.
  return { files, regions };
};
